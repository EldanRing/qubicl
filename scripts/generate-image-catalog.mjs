import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertCatalogIdentity } from './candidate-evidence.mjs';
import { inspectOciArchive } from './oci-evidence.mjs';

const options = parseArgs(process.argv.slice(2));
const platforms = ['linux/amd64', 'linux/arm64'];
const CURATED_PRESETS = ['file-system', 'browser', 'computer', 'workstation'];
const imageNames = ['gateway', 'dashboard', ...CURATED_PRESETS];
const measurements = {};
const core = options['reuse-catalog'] ? undefined : await import('../packages/core/dist/index.js');
const imageInputs = options['image-inputs'] ? JSON.parse(await readFile(options['image-inputs'], 'utf8')) : undefined;
const reuseCatalog = options['reuse-catalog']
  ? JSON.parse(await readFile(options['reuse-catalog'], 'utf8'))
  : undefined;
if (imageInputs) {
  assert(imageInputs.schemaVersion === 1 && imageInputs.version === options.version && imageInputs.revision === options.revision,
    'Image input evidence does not bind this catalog.');
  assert(JSON.stringify(Object.keys(imageInputs.images ?? {}).sort()) === JSON.stringify([...imageNames].sort()),
    'Image input evidence must contain exactly the catalog images.');
}
const imageRevision = (name) => imageInputs?.images?.[name]?.revision ?? options.revision;
const dashboardAssetManifestSha256 = options.dashboardManifestSha256 ?? createHash('sha256')
  .update(await readFile(options.dashboardManifest))
  .digest('hex');

if (reuseCatalog) {
  assert(imageInputs, 'A reused catalog requires per-image input provenance.');
  assert(/^[a-f0-9]{40}$/u.test(reuseCatalog.revision ?? ''), 'Reusable catalog has no exact source revision.');
  assertCatalogIdentity(reuseCatalog, { version: options.version, revision: reuseCatalog.revision, source: options.source });
  assert(reuseCatalog.dashboard.assetManifestSha256 === dashboardAssetManifestSha256,
    'Reusable dashboard image inputs do not match the current asset manifest.');
}

for (const name of imageNames) {
  if (reuseCatalog) {
    const entry = catalogImage(reuseCatalog, name);
    const repository = `ghcr.io/${options.owner}/qubicl-${name}`;
    assert(entry.requested === `${repository}:${options.version}`,
      `Reusable ${name} image has another versioned repository reference.`);
    measurements[name] = {
      indexDigest: entry.indexDigest,
      platforms: Object.fromEntries(platforms.map((platform) => [platform, {
        digest: entry.platforms[platform].digest,
        downloadBytes: entry.platforms[platform].downloadBytes,
        expandedBytes: entry.platforms[platform].expandedBytes,
      }])),
    };
  } else {
    const preset = CURATED_PRESETS.includes(name) ? name : undefined;
    measurements[name] = await inspectOciArchive(join(options.directory, `qubicl-${name}.oci.tar`), {
      expectedVersion: options.version,
      expectedRevision: imageRevision(name),
      expectedSource: options.source,
      expectedPreset: preset,
      expectedManifest: preset ? core.buildComputerManifest(preset, options.version, imageRevision(preset)) : undefined,
      expectedDashboardAssetManifestSha256: name === 'dashboard' ? dashboardAssetManifestSha256 : undefined,
      requireAttestations: true,
    });
  }
}

const imageEntry = (name) => {
  const measured = measurements[name];
  const repository = `ghcr.io/${options.owner}/qubicl-${name}`;
  return {
    requested: `${repository}:${options.version}`,
    indexDigest: measured.indexDigest,
    platforms: Object.fromEntries(platforms.map((platform) => {
      const variant = measured.platforms[platform];
      return [platform, {
        // Pin execution to the immutable multi-platform index. Docker then
        // selects the measured child manifest for the host architecture. This
        // also keeps an OCI archive loaded with --platform addressable by the
        // same exact reference used by the release catalog.
        resolved: `${repository}@${measured.indexDigest}`,
        digest: variant.digest,
        downloadBytes: variant.downloadBytes,
        expandedBytes: variant.expandedBytes,
      }];
    })),
  };
};

const catalog = reuseCatalog ? { ...reuseCatalog, revision: options.revision } : core.ImageCatalogSchema.parse({
  schemaVersion: 2,
  releaseVersion: options.version,
  development: false,
  source: options.source,
  revision: options.revision,
  supportedPlatforms: platforms,
  gateway: imageEntry('gateway'),
  dashboard: {
    protocolVersion: 1,
    assetManifestSha256: dashboardAssetManifestSha256,
    image: imageEntry('dashboard'),
  },
  presets: Object.fromEntries(CURATED_PRESETS.map((preset) => {
    const definition = core.PRESET_DEFINITIONS[preset];
    return [preset, {
      id: preset,
      purpose: definition.purpose,
      description: definition.description,
      capabilities: definition.capabilities,
      viewer: definition.viewer,
      ...(definition.viewerAuthentication ? { viewerAuthentication: definition.viewerAuthentication } : {}),
      manifestSha256: core.manifestSha256(core.buildComputerManifest(preset, options.version, imageRevision(preset))),
      image: imageEntry(preset),
      recommendedCpus: definition.cpus,
      recommendedMemory: definition.memory,
      pidsLimit: definition.pidsLimit,
      ...(definition.shmSize ? { shmSize: definition.shmSize } : {}),
      startupBudgetSeconds: definition.startupBudgetSeconds,
    }];
  })),
});

await writeFile(options.output, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ ok: true, output: options.output, catalog }, null, 2));

function parseArgs(args) {
  const result = {};
  const allowed = new Set(['directory', 'output', 'version', 'revision', 'source', 'owner', 'dashboard-manifest', 'dashboard-manifest-sha256', 'image-inputs', 'reuse-catalog']);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    assert(option?.startsWith('--') && value, `Every catalog option requires a value; found ${option ?? 'nothing'}.`);
    const key = option.slice(2);
    assert(allowed.has(key), `Unknown catalog option ${option}.`);
    assert(result[key] === undefined, `Catalog option ${option} was provided more than once.`);
    result[key] = value;
  }
  for (const key of ['directory', 'output', 'version', 'revision', 'source', 'owner']) assert(result[key], `Missing required --${key}.`);
  assert(Boolean(result['dashboard-manifest']) !== Boolean(result['dashboard-manifest-sha256']),
    'Provide exactly one of --dashboard-manifest or --dashboard-manifest-sha256.');
  if (result['dashboard-manifest-sha256']) assert(/^[a-f0-9]{64}$/u.test(result['dashboard-manifest-sha256']),
    '--dashboard-manifest-sha256 must be an exact SHA-256.');
  result.directory = resolve(result.directory);
  result.output = resolve(result.output);
  if (result['dashboard-manifest']) result.dashboardManifest = resolve(result['dashboard-manifest']);
  result.dashboardManifestSha256 = result['dashboard-manifest-sha256'];
  if (result['image-inputs']) result['image-inputs'] = resolve(result['image-inputs']);
  if (result['reuse-catalog']) result['reuse-catalog'] = resolve(result['reuse-catalog']);
  delete result['dashboard-manifest'];
  delete result['dashboard-manifest-sha256'];
  result.owner = result.owner.toLowerCase();
  assert(/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(result.owner), `Invalid registry owner ${result.owner}.`);
  return result;
}

function catalogImage(catalog, name) {
  if (name === 'gateway') return catalog.gateway;
  if (name === 'dashboard') return catalog.dashboard.image;
  return catalog.presets[name].image;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
