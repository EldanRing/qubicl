import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const moduleUrl = pathToFileURL(join(root, 'scripts', 'oci-platform-view.mjs')).href;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip';

test('platform views independently retain only the selected manifest, config, and layers', async () => {
  const { createOciPlatformView } = await import(moduleUrl);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-platform-view-'));
  try {
    const source = join(temporary, 'source');
    const fixture = await createLayout(source);
    const amd64View = join(temporary, 'amd64');
    const arm64View = join(temporary, 'arm64');
    const amd64Expected = fixture.identities['linux/amd64']!;
    const arm64Expected = fixture.identities['linux/arm64']!;
    const amd64 = await createOciPlatformView(source, amd64View, 'linux/amd64', amd64Expected);
    const arm64 = await createOciPlatformView(source, arm64View, 'linux/arm64', arm64Expected);

    assert.deepEqual(amd64, withoutIndex(amd64Expected));
    assert.deepEqual(arm64, withoutIndex(arm64Expected));
    assert.notEqual(amd64.manifestDigest, arm64.manifestDigest);
    assert.deepEqual(await viewDigests(amd64View), [
      amd64.manifestDigest,
      amd64.configDigest,
      ...amd64.layerDigests,
    ].map(stripDigest).sort());
    assert.deepEqual(await viewDigests(arm64View), [
      arm64.manifestDigest,
      arm64.configDigest,
      ...arm64.layerDigests,
    ].map(stripDigest).sort());
    assert(!await viewDigests(amd64View).then((digests) => digests.includes(stripDigest(arm64.configDigest))));
    assert(!await viewDigests(arm64View).then((digests) => digests.includes(stripDigest(amd64.configDigest))));

    const amd64Index = JSON.parse(await readFile(join(amd64View, 'index.json'), 'utf8'));
    const arm64Index = JSON.parse(await readFile(join(arm64View, 'index.json'), 'utf8'));
    assert.equal(amd64Index.manifests.length, 1);
    assert.equal(amd64Index.manifests[0].digest, amd64.manifestDigest);
    assert.deepEqual(amd64Index.manifests[0].platform, { os: 'linux', architecture: 'amd64' });
    assert.equal(arm64Index.manifests.length, 1);
    assert.equal(arm64Index.manifests[0].digest, arm64.manifestDigest);
    assert.deepEqual(arm64Index.manifests[0].platform, { os: 'linux', architecture: 'arm64' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('platform view construction rejects every selected OCI identity mismatch', async () => {
  const { createOciPlatformView } = await import(moduleUrl);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-platform-view-mismatch-'));
  try {
    const source = join(temporary, 'source');
    const fixture = await createLayout(source);
    const expected = fixture.identities['linux/amd64'];
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['index', { ...expected, indexDigest: digest('wrong-index') }, /expected image index/],
      ['manifest', { ...expected, manifestDigest: digest('wrong-manifest') }, /manifest or configuration/],
      ['config', { ...expected, configDigest: digest('wrong-config') }, /manifest or configuration/],
      ['layers', { ...expected, layerDigests: [digest('wrong-layer')] }, /compressed layer digests/],
      ['diffids', { ...expected, diffIds: [digest('wrong-diff')] }, /rootfs diff IDs/],
    ];
    for (const [name, identity, message] of cases) {
      await assert.rejects(
        createOciPlatformView(source, join(temporary, name), 'linux/amd64', identity),
        message,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function createLayout(directory: string): Promise<{
  identities: Record<string, {
    indexDigest: string;
    manifestDigest: string;
    configDigest: string;
    layerDigests: string[];
    diffIds: string[];
  }>;
}> {
  await mkdir(join(directory, 'blobs', 'sha256'), { recursive: true });
  const manifests: Array<Record<string, unknown>> = [];
  const identities: Record<string, any> = {};
  for (const architecture of ['amd64', 'arm64']) {
    const platform = `linux/${architecture}`;
    const layer = await blob(directory, Buffer.from(`compressed-${architecture}-layer`), OCI_LAYER);
    const diffIds = [digest(`expanded-${architecture}-layer`)];
    const config = await jsonBlob(directory, {
      architecture,
      os: 'linux',
      rootfs: { type: 'layers', diff_ids: diffIds },
      config: {},
    }, OCI_CONFIG);
    const manifest = await jsonBlob(directory, {
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config,
      layers: [layer],
    }, OCI_MANIFEST);
    const descriptor = { ...manifest, platform: { os: 'linux', architecture } };
    manifests.push(descriptor);
    identities[platform] = {
      manifestDigest: manifest.digest,
      configDigest: config.digest,
      layerDigests: [layer.digest],
      diffIds,
    };
  }
  const index = await jsonBlob(directory, { schemaVersion: 2, mediaType: OCI_INDEX, manifests }, OCI_INDEX);
  await writeFile(join(directory, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
  await writeFile(join(directory, 'index.json'), `${JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [index],
  })}\n`);
  for (const identity of Object.values(identities)) identity.indexDigest = index.digest;
  return { identities };
}

async function jsonBlob(directory: string, value: unknown, mediaType: string) {
  return blob(directory, Buffer.from(JSON.stringify(value)), mediaType);
}

async function blob(directory: string, bytes: Buffer, mediaType: string) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'blobs', 'sha256', hash), bytes);
  return { mediaType, digest: `sha256:${hash}`, size: bytes.length };
}

async function viewDigests(directory: string): Promise<string[]> {
  return (await readdir(join(directory, 'blobs', 'sha256'))).sort();
}

function withoutIndex(identity: Record<string, any>) {
  const { indexDigest: _indexDigest, ...selected } = identity;
  return selected;
}

function stripDigest(value: string): string {
  return value.slice('sha256:'.length);
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
