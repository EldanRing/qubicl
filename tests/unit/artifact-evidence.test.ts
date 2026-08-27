import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const moduleUrl = pathToFileURL(join(root, 'scripts', 'artifact-evidence.mjs')).href;

test('npm publication manifest is exactly the reviewed source manifest', async () => {
  const { assertNpmPublicationManifest } = await import(moduleUrl);
  const expected = JSON.parse(await readFile(join(root, 'packages', 'cli', 'package.json'), 'utf8'));
  assert.doesNotThrow(() => assertNpmPublicationManifest(structuredClone(expected), expected, { version: expected.version }));

  for (const mutation of [
    (manifest: Record<string, unknown>) => { manifest.dependencies = { surprise: '1.0.0' }; },
    (manifest: Record<string, any>) => { manifest.optionalDependencies = { surprise: '1.0.0' }; },
    (manifest: Record<string, any>) => { manifest.scripts.preinstall = 'node malicious.mjs'; },
    (manifest: Record<string, unknown>) => { manifest.config = { unsafe: true }; },
    (manifest: Record<string, any>) => { manifest.bin.extra = 'dist/extra.mjs'; },
    (manifest: Record<string, unknown>) => { manifest.publishConfig = { access: 'restricted' }; },
  ]) {
    const changed = structuredClone(expected);
    mutation(changed);
    assert.throws(
      () => assertNpmPublicationManifest(changed, expected, { version: expected.version }),
      /may not|differs|bin must map/,
    );
  }
});

test('compiled candidate evidence permits only explicit legacy development image identifiers', async () => {
  const { assertCompiledCandidateRefs } = await import(moduleUrl);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-artifact-evidence-'));
  const artifact = join(temporary, 'qubicl');
  const catalog = catalogFixture();
  const required = [
    '0.1.0',
    'a'.repeat(40),
    catalog.gateway.requested,
    catalog.gateway.indexDigest,
    ...Object.values(catalog.gateway.platforms).flatMap((variant) => [variant.resolved, variant.digest]),
    ...Object.values(catalog.presets).flatMap((preset) => [
      preset.manifestSha256,
      preset.image.requested,
      preset.image.indexDigest,
      ...Object.values(preset.image.platforms).flatMap((variant) => [variant.resolved, variant.digest]),
    ]),
  ];
  try {
    await writeFile(artifact, [...required, 'qubicl/computer:dev', 'qubicl/workstation:dev'].join('\n'));
    await assert.doesNotReject(() => assertCompiledCandidateRefs(artifact, catalog, {
      version: '0.1.0',
      revision: 'a'.repeat(40),
      artifact: 'fixture',
    }));

    await writeFile(artifact, [...required, 'qubicl/gateway:dev'].join('\n'));
    await assert.rejects(() => assertCompiledCandidateRefs(artifact, catalog, {
      version: '0.1.0',
      revision: 'a'.repeat(40),
      artifact: 'fixture',
    }), /development system-image reference for gateway/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function catalogFixture() {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  let next = 1;
  const image = (name: string) => {
    const character = String(next++);
    return {
      requested: `ghcr.io/eldanring/qubicl-${name}:0.1.0`,
      indexDigest: digest(character),
      platforms: {
        'linux/amd64': {
          resolved: `ghcr.io/eldanring/qubicl-${name}@${digest(character)}`,
          digest: digest(character),
        },
      },
    };
  };
  return {
    gateway: image('gateway'),
    presets: Object.fromEntries(['file-system', 'browser', 'computer', 'workstation'].map((name) => [name, {
      manifestSha256: 'f'.repeat(64),
      image: image(name),
    }])),
  };
}
