import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { imageInputIdentities, imageInputsForPath, IMAGE_INPUTS_NAME, RELEASE_IMAGES, selectImageActions, verifyImageInputs } from '../../scripts/release-inputs.mjs';
import { createReleasePlan } from '../../scripts/release-plan.mjs';
import { writeReleasePresetManifests } from '../../scripts/release-preset-manifests.mjs';
import { assertTrivyScannerIdentity } from '../../scripts/candidate-evidence.mjs';
import { PRESET_DEFINITIONS, buildComputerManifest, manifestSha256 } from '../../packages/core/dist/index.js';

const exec = promisify(execFile);
const toolchain = { node: process.version, npm: (await exec('npm', ['--version'])).stdout.trim(), docker: '28.4.0', buildx: '0.28.0' };
const source = 'https://github.com/example/qubicl';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-release-workflow-'));
  const root = join(directory, 'source');
  await mkdir(root);
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  const write = async (name, text) => { await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), text); };
  const commit = async () => { await git('add', '.'); await git('-c', 'user.name=Qubicl Test', '-c', 'user.email=test@qubicl.invalid', 'commit', '--quiet', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  try {
    await git('init', '--quiet');
    await write('package.json', JSON.stringify({ name: 'fixture', version: '0.6.0', repository: source }));
    for (const name of ['packages/gateway/src/main.ts', 'packages/control/src/main.ts', 'packages/cli/src/migrations.ts', 'scripts/build.mjs', 'package-lock.json']) await write(name, 'original\n');
    const base = await commit();
    await run({ directory, root, git, write, commit, base });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function inputs(revision, identities) {
  return { schemaVersion: 1, version: '0.6.0', revision, images: Object.fromEntries(RELEASE_IMAGES.map((name) => [name, { version: '0.6.0', revision, inputSha256: identities[name], ...toolchain }])) };
}

test('image input map separates CLI/docs/release orchestration from runtime dependencies', () => {
  for (const path of ['packages/cli/src/migrations.ts', 'docs/clients.md', 'RELEASING.md', 'scripts/build-local-candidates.mjs', 'scripts/acceptance-evidence.mjs']) assert.deepEqual(imageInputsForPath(path), []);
  assert.deepEqual(imageInputsForPath('packages/gateway/src/server.ts'), ['gateway']);
  assert.deepEqual(imageInputsForPath('images/dashboard/Dockerfile'), ['dashboard']);
  assert.deepEqual(imageInputsForPath('images/computer/entrypoint.sh'), RELEASE_IMAGES.slice(2));
  assert.deepEqual(imageInputsForPath('package.json'), []);
  for (const path of ['package-lock.json', 'scripts/build.mjs', 'packages/core/src/tools.ts', 'unexpected/new-input.bin']) assert.deepEqual(imageInputsForPath(path), RELEASE_IMAGES);
});

test('CLI fix reuses all image origins; changed, removed, or unknown runtime inputs invalidate only safe boundaries', async () => fixture(async ({ root, git, write, commit, base }) => {
  const baseline = await imageInputIdentities(root, base);
  const previous = inputs(base, baseline);
  await write('packages/cli/src/migrations.ts', 'fixed\n');
  let revision = await commit();
  let current = await imageInputIdentities(root, revision);
  let actions = selectImageActions({ current, previous, version: '0.6.0', revision, tools: toolchain, scansFresh: true });
  assert(Object.values(actions).every(({ action, scan, origin }) => action === 'reuse' && scan === 'reuse' && origin.revision === base));
  await verifyImageInputs({ ...previous, revision }, { version: '0.6.0', revision }, root);
  await write('packages/gateway/src/main.ts', 'fixed gateway\n');
  revision = await commit();
  current = await imageInputIdentities(root, revision);
  actions = selectImageActions({ current, previous, version: '0.6.0', revision, tools: toolchain, scansFresh: true });
  assert.deepEqual(RELEASE_IMAGES.filter((name) => actions[name].action === 'build'), ['gateway']);
  await assert.rejects(verifyImageInputs({ ...previous, revision }, { version: '0.6.0', revision }, root), /build inputs changed/);
  await git('rm', 'packages/control/src/main.ts');
  revision = await commit();
  current = await imageInputIdentities(root, revision);
  assert(RELEASE_IMAGES.slice(2).every((name) => current[name] !== baseline[name]));
  await write('unexpected-input.bin', 'new build input\n');
  revision = await commit();
  current = await imageInputIdentities(root, revision);
  assert(RELEASE_IMAGES.every((name) => current[name] !== baseline[name]));
}));

test('stale scans and a changed current toolchain do not invalidate immutable images; a version change does', () => {
  const current = Object.fromEntries(RELEASE_IMAGES.map((name) => [name, 'a'.repeat(64)]));
  const previous = inputs('b'.repeat(40), current);
  const options = { current, previous, version: '0.6.0', revision: 'c'.repeat(40), tools: toolchain, scansFresh: false };
  assert(Object.values(selectImageActions(options)).every(({ action, scan }) => action === 'reuse' && scan === 'scan'));
  assert(Object.values(selectImageActions({ ...options, version: '0.6.1' })).every(({ action }) => action === 'build'));
  const otherToolchain = selectImageActions({ ...options, tools: { ...toolchain, node: 'v24.0.0' }, scansFresh: true });
  assert(Object.values(otherToolchain).every(({ action, origin }) => action === 'reuse' && origin.node === toolchain.node));
});

test('root release scripts are excluded from semantic image inputs while dependency metadata remains included', async () => fixture(async ({ root, write, commit, base }) => {
  const original = await imageInputIdentities(root, base);
  await write('package.json', JSON.stringify({ name: 'fixture', version: '0.6.0', repository: source, scripts: { 'release:plan': 'node scripts/release-plan.mjs' } }));
  let revision = await commit();
  assert.deepEqual(await imageInputIdentities(root, revision), original);
  await write('package.json', JSON.stringify({ name: 'fixture', version: '0.6.0', repository: source, dependencies: { zod: '4.1.5' } }));
  revision = await commit();
  const changed = await imageInputIdentities(root, revision);
  assert(RELEASE_IMAGES.every((name) => changed[name] !== original[name]));
}));

test('rebuild planning is read-only and works from metadata without Docker or OCI archives', async () => fixture(async ({ directory, root, write, commit, base }) => {
  const candidate = join(directory, 'candidate');
  await mkdir(candidate);
  const names = [
    'image-catalog.json', 'trivy-bindings.json', 'oci-efficiency.json',
    ...RELEASE_IMAGES.map((image) => `qubicl-${image}.oci.tar`),
    ...RELEASE_IMAGES.flatMap((image) => ['linux-amd64', 'linux-arm64'].map((platform) => `trivy-${image}-${platform}.json`)),
  ];
  await writeFile(join(candidate, 'candidate.json'), JSON.stringify({
    revision: base,
    version: '0.6.0',
    source,
    modes: { images: true, scans: true },
    tools: toolchain,
    artifacts: names.map((name) => ({ name, bytes: 1, sha256: 'a'.repeat(64) })),
  }));
  await write('packages/cli/src/migrations.ts', 'fix\n');
  await commit();
  const plan = await createReleasePlan(root, { reuse: candidate });
  assert.deepEqual(plan.buildImages, []);
  assert.deepEqual(plan.reuseImages, RELEASE_IMAGES);
  assert.deepEqual(plan.scanImages, RELEASE_IMAGES, 'missing scan evidence must trigger scanning');
  assert.equal(plan.baselineRevision, base);
  assert.equal(plan.clean, true);
  assert.equal((await readFile(join(candidate, 'candidate.json'), 'utf8')).includes('0.6.0'), true);
}));

test('image provenance rejects forged input hashes, different versions and missing toolchain evidence', async () => fixture(async ({ root, base }) => {
  const original = inputs(base, await imageInputIdentities(root, base));
  const candidate = { version: '0.6.0', revision: base };
  for (const field of ['inputSha256', 'version', 'node']) {
    const forged = structuredClone(original);
    forged.images.gateway[field] = field === 'inputSha256' ? '0'.repeat(64) : field === 'version' ? '0.5.1' : undefined;
    await assert.rejects(verifyImageInputs(forged, candidate, root));
  }
}));

test('scanner reuse rejects an implausible future scan', () => {
  const bindings = { schemaVersion: 2, createdAt: '2026-09-15T12:00:00.000Z', scanner: {
    name: 'trivy', version: '0.74.0', versionOutputSha256: 'a'.repeat(64),
    vulnerabilityDatabase: { Version: 2, UpdatedAt: '2026-09-15T11:00:00.000Z', DownloadedAt: '2026-09-15T11:05:00.000Z', NextUpdate: '2026-09-15T17:00:00.000Z', sha256: 'b'.repeat(64) },
    checkBundle: { Digest: `sha256:${'c'.repeat(64)}`, DownloadedAt: '2026-09-15T11:00:00.000Z' },
  } };
  assert.throws(() => assertTrivyScannerIdentity(bindings, '2026-09-14T12:00:00.000Z'), /future/);
  const expired = structuredClone(bindings);
  expired.createdAt = '2026-09-15T12:00:00.000Z';
  expired.scanner.vulnerabilityDatabase.NextUpdate = '2026-09-15T12:30:00.000Z';
  assert.throws(() => assertTrivyScannerIdentity(expired, '2026-09-15T13:00:00.000Z'), /stale/);
});

test('catalog generation carries forward exact unchanged image entries without opening OCI archives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-reuse-catalog-'));
  try {
    const scriptNames = [
      'generate-image-catalog.mjs', 'candidate-evidence.mjs', 'artifact-evidence.mjs',
      'bundle-evidence.mjs', 'release-impact.mjs', 'client-conformance.mjs',
      'oci-efficiency.mjs', 'oci-evidence.mjs', 'release-inputs.mjs',
    ];
    await mkdir(join(directory, 'scripts'));
    for (const name of scriptNames) await copyFile(join(process.cwd(), 'scripts', name), join(directory, 'scripts', name));
    const version = '0.6.0';
    const origin = 'a'.repeat(40);
    const revision = 'b'.repeat(40);
    const source = 'https://github.com/example/qubicl';
    const dashboardSha256 = 'f'.repeat(64);
    const imageEntry = (name, index) => {
      const indexDigest = `sha256:${(index + 1).toString(16).repeat(64)}`;
      const repository = `ghcr.io/example/qubicl-${name}`;
      return {
        requested: `${repository}:${version}`,
        indexDigest,
        platforms: Object.fromEntries(['linux/amd64', 'linux/arm64'].map((platform, platformIndex) => [platform, {
          resolved: `${repository}@${indexDigest}`,
          digest: `sha256:${(index + platformIndex + 7).toString(16).repeat(64)}`,
          downloadBytes: 100 + index + platformIndex,
          expandedBytes: 200 + index + platformIndex,
        }])),
      };
    };
    const entries = Object.fromEntries(RELEASE_IMAGES.map((name, index) => [name, imageEntry(name, index)]));
    const catalog = {
      schemaVersion: 2,
      releaseVersion: version,
      development: false,
      source,
      revision: origin,
      supportedPlatforms: ['linux/amd64', 'linux/arm64'],
      gateway: entries.gateway,
      dashboard: { protocolVersion: 1, assetManifestSha256: dashboardSha256, image: entries.dashboard },
      presets: Object.fromEntries(RELEASE_IMAGES.slice(2).map((name) => {
        const definition = PRESET_DEFINITIONS[name];
        return [name, {
          id: name,
          purpose: definition.purpose,
          description: definition.description,
          capabilities: definition.capabilities,
          viewer: definition.viewer,
          ...(definition.viewerAuthentication ? { viewerAuthentication: definition.viewerAuthentication } : {}),
          manifestSha256: manifestSha256(buildComputerManifest(name, version, origin)),
          image: entries[name],
          recommendedCpus: definition.cpus,
          recommendedMemory: definition.memory,
          pidsLimit: definition.pidsLimit,
          ...(definition.shmSize ? { shmSize: definition.shmSize } : {}),
          startupBudgetSeconds: definition.startupBudgetSeconds,
        }];
      })),
    };
    const inputPath = join(directory, IMAGE_INPUTS_NAME);
    await writeFile(inputPath, JSON.stringify({
      schemaVersion: 1,
      version,
      revision,
      images: Object.fromEntries(RELEASE_IMAGES.map((name) => [name, {
        version,
        revision: origin,
        inputSha256: 'c'.repeat(64),
        node: 'v22.23.2',
        npm: '10.9.3',
        docker: '28.4.0',
        buildx: '0.28.0',
      }])),
    }));
    const reusePath = join(directory, 'reuse.json');
    const outputPath = join(directory, 'output.json');
    await writeFile(reusePath, JSON.stringify(catalog));
    await exec(process.execPath, [
      join(directory, 'scripts/generate-image-catalog.mjs'),
      '--directory', directory,
      '--output', outputPath,
      '--version', version,
      '--revision', revision,
      '--source', source,
      '--owner', 'example',
      '--dashboard-manifest-sha256', dashboardSha256,
      '--image-inputs', inputPath,
      '--reuse-catalog', reusePath,
    ], { cwd: directory });
    const generated = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(generated.revision, revision);
    assert.equal(generated.gateway.indexDigest, catalog.gateway.indexDigest);
    assert.equal(generated.presets.workstation.manifestSha256, catalog.presets.workstation.manifestSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release packaging writes preset manifests for each image origin without changing the general build', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-release-manifests-'));
  try {
    await mkdir(join(directory, 'packages/cli/dist/assets/computer/manifests'), { recursive: true });
    const version = '0.6.0';
    const origin = 'd'.repeat(40);
    await writeReleasePresetManifests(directory, {
      schemaVersion: 1,
      version,
      images: Object.fromEntries(RELEASE_IMAGES.slice(2).map((name) => [name, { version, revision: origin }])),
    });
    const browser = JSON.parse(await readFile(join(directory, 'packages/cli/dist/assets/computer/manifests/browser.json'), 'utf8'));
    assert.equal(browser.revision, origin);
    assert.equal(browser.qubiclVersion, version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
