import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'publish-candidate.mjs')).href;

test('candidate publication plan uses exact versioned artifacts before latest aliases', async () => {
  const { buildPublishPlan } = await import(moduleUrl);
  const image = (name: string) => ({
    requested: `ghcr.io/example/qubicl-${name}:0.1.0`,
    indexDigest: `sha256:${name[0]!.repeat(64)}`,
  });
  const plan = buildPublishPlan({
    version: '0.1.0',
    revision: 'a'.repeat(40),
    releaseTier: 'initial',
    host: { target: 'linux-x64' },
    modes: { images: true, scans: true, exactArtifactAcceptance: true, binaryOnly: false },
  }, {
    gateway: image('gateway'),
    presets: Object.fromEntries(['file-system', 'browser', 'computer', 'workstation'].map((name) => [name, { image: image(name) }])),
  }, '/candidate');
  assert.equal(plan.tag, 'v0.1.0');
  assert.equal(plan.npmArchive, '/candidate/qubicl-cli-0.1.0.tgz');
  assert.equal(plan.images.length, 5);
  assert.equal(plan.images[0]?.versionReference, 'ghcr.io/example/qubicl-gateway:0.1.0');
  assert.equal(plan.images[0]?.latestReference, 'ghcr.io/example/qubicl-gateway:latest');
  assert.deepEqual(plan.images[0]?.registry, { owner: 'example', packageName: 'qubicl-gateway' });
  assert(plan.releaseAssets.every((path: string) => !path.endsWith('.oci.tar')));
});

test('publication rejects preview and incomplete candidates', async () => {
  const { buildPublishPlan } = await import(moduleUrl);
  const catalog = { gateway: {}, presets: {} };
  assert.throws(() => buildPublishPlan({ releaseTier: 'preview' }, catalog, '/candidate'), /Only initial or supported/);
  assert.throws(() => buildPublishPlan({ releaseTier: 'initial', modes: {} }, catalog, '/candidate'), /complete scanned/);
});

test('GHCR reference parsing is strict and retains nested package names', async () => {
  const { parseGhcrReference } = await import(moduleUrl);
  assert.deepEqual(parseGhcrReference('ghcr.io/example/team/qubicl-gateway:0.1.0'), {
    owner: 'example',
    packageName: 'team/qubicl-gateway',
  });
  assert.throws(() => parseGhcrReference('docker.io/example/qubicl:0.1.0'), /must use a version-tagged ghcr.io reference/);
  assert.throws(() => parseGhcrReference('ghcr.io/example/qubicl@sha256:abc'), /must use a version-tagged ghcr.io reference/);
});

test('publisher always requires a trusted candidate signature', async () => {
  const { parseOptions } = await import(moduleUrl);
  assert.throws(() => parseOptions(['--candidate', '/candidate']), /--public-key is required/);
  assert.throws(() => parseOptions(['--candidate', '/candidate', '--public-key', '/key']), /--signature is required/);
  assert.deepEqual(parseOptions([
    '--candidate', '/candidate',
    '--public-key', '/key',
    '--signature', '/signature.json',
  ]), {
    candidate: '/candidate',
    publicKey: '/key',
    signature: '/signature.json',
    releaseSet: undefined,
    releaseSetSignature: undefined,
    acceptance: undefined,
    acceptanceSignature: undefined,
    publish: false,
    yes: false,
  });
});

test('supported publication cannot bypass release-set acceptance evidence', async () => {
  const { buildPublishPlan } = await import(moduleUrl);
  assert.throws(() => buildPublishPlan({
    releaseTier: 'supported',
    modes: { images: true, scans: true, exactArtifactAcceptance: true, binaryOnly: false },
  }, {}, '/candidate'), /signed release set/);
});

test('existing GitHub release metadata rejects stale or surplus assets', async () => {
  const { assertReleaseMetadata } = await import(moduleUrl);
  const expected = {
    name: 'Qubicl 0.1.0',
    body: 'Reviewed notes\n',
    targetCommitish: 'a'.repeat(40),
    assetNames: ['candidate.json', 'SHA256SUMS'],
  };
  const release = {
    name: expected.name,
    body: expected.body,
    targetCommitish: expected.targetCommitish,
    isDraft: false,
    isPrerelease: false,
    assets: expected.assetNames.map((name) => ({ name })),
  };
  assert.doesNotThrow(() => assertReleaseMetadata(release, expected));
  assert.throws(() => assertReleaseMetadata({ ...release, targetCommitish: 'b'.repeat(40) }, expected), /target commit/);
  assert.throws(() => assertReleaseMetadata({ ...release, body: 'stale' }, expected), /notes/);
  assert.throws(() => assertReleaseMetadata({ ...release, assets: [...release.assets, { name: 'surprise.bin' }] }, expected), /extra assets/);
});

test('publisher rejects ancestry connected to the private development history', async () => {
  const { assertPublicHistoryFacts } = await import(moduleUrl);
  const revision = 'a'.repeat(40);
  const candidate = { revision, source: 'https://github.com/example/qubicl' };
  const policy = { branch: 'main', maximumReachableCommits: 1 };
  assert.doesNotThrow(() => assertPublicHistoryFacts({
    branch: 'main', commitCount: 1, roots: [revision], origin: 'https://github.com/example/qubicl.git',
  }, candidate, policy));
  assert.throws(() => assertPublicHistoryFacts({
    branch: 'main', commitCount: 31, roots: ['b'.repeat(40)], origin: 'https://github.com/example/qubicl.git',
  }, candidate, policy), /private development (?:history|repository)/);
});
