import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CURATED_PRESETS,
  ImageCatalogSchema,
  PRESET_DEFINITIONS,
  buildComputerManifest,
  manifestSha256,
} from '../packages/core/dist/index.js';
import { inspectOciArchive } from './oci-evidence.mjs';

const options = parseArgs(process.argv.slice(2));
const platforms = ['linux/amd64', 'linux/arm64'];
const imageNames = ['gateway', ...CURATED_PRESETS];
const measurements = {};

for (const name of imageNames) {
  const preset = name === 'gateway' ? undefined : name;
  measurements[name] = await inspectOciArchive(join(options.directory, `qubicl-${name}.oci.tar`), {
    expectedVersion: options.version,
    expectedRevision: options.revision,
    expectedSource: options.source,
    expectedPreset: preset,
    expectedManifest: preset ? buildComputerManifest(preset, options.version, options.revision) : undefined,
    requireAttestations: true,
  });
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

const catalog = ImageCatalogSchema.parse({
  schemaVersion: 1,
  releaseVersion: options.version,
  development: false,
  source: options.source,
  revision: options.revision,
  supportedPlatforms: platforms,
  gateway: imageEntry('gateway'),
  presets: Object.fromEntries(CURATED_PRESETS.map((preset) => {
    const definition = PRESET_DEFINITIONS[preset];
    return [preset, {
      id: preset,
      purpose: definition.purpose,
      description: definition.description,
      capabilities: definition.capabilities,
      viewer: definition.viewer,
      ...(definition.viewerAuthentication ? { viewerAuthentication: definition.viewerAuthentication } : {}),
      manifestSha256: manifestSha256(buildComputerManifest(preset, options.version, options.revision)),
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
  const allowed = new Set(['directory', 'output', 'version', 'revision', 'source', 'owner']);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    assert(option?.startsWith('--') && value, `Every catalog option requires a value; found ${option ?? 'nothing'}.`);
    const key = option.slice(2);
    assert(allowed.has(key), `Unknown catalog option ${option}.`);
    assert(result[key] === undefined, `Catalog option ${option} was provided more than once.`);
    result[key] = value;
  }
  for (const key of allowed) assert(result[key], `Missing required --${key}.`);
  result.directory = resolve(result.directory);
  result.output = resolve(result.output);
  result.owner = result.owner.toLowerCase();
  assert(/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(result.owner), `Invalid registry owner ${result.owner}.`);
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
