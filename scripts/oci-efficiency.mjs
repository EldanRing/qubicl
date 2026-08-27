import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectOciArchive } from './oci-evidence.mjs';

export const OCI_EFFICIENCY_REPORT_NAME = 'oci-efficiency.json';
export const OCI_EFFICIENCY_MAX_REPORT_BYTES = 64 * 1024 * 1024;
export const OCI_EFFICIENCY_IMAGE_NAMES = [
  'gateway',
  'file-system',
  'browser',
  'computer',
  'workstation',
];

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export async function inspectOciEfficiencyArchives(archives) {
  assertExactImages(archives, 'OCI efficiency archive inputs');
  const inspections = {};
  for (const name of OCI_EFFICIENCY_IMAGE_NAMES) {
    const archive = archives[name];
    assert(typeof archive === 'string' && archive.length > 0, `OCI efficiency archive ${name} must be a non-empty path.`);
    inspections[name] = await inspectOciArchive(archive, {
      includeLayerMeasurements: true,
      includePackageInventory: true,
      requireAttestations: true,
    });
  }
  return buildOciEfficiencyReport(inspections);
}

export function buildOciEfficiencyReport(inspections) {
  assertExactImages(inspections, 'OCI efficiency inspections');
  const platforms = commonPlatforms(inspections);
  return {
    schemaVersion: 2,
    images: Object.fromEntries(OCI_EFFICIENCY_IMAGE_NAMES.map((name) => {
      const indexDigest = inspections[name]?.indexDigest;
      assert(DIGEST.test(indexDigest ?? ''), `OCI efficiency inspection ${name} has no valid index digest.`);
      return [name, { indexDigest }];
    })),
    platforms: Object.fromEntries(platforms.map((platform) => [
      platform,
      platformReport(inspections, platform),
    ])),
  };
}

export function serializeOciEfficiencyReport(report, { maximumBytes = OCI_EFFICIENCY_MAX_REPORT_BYTES } = {}) {
  assert(Number.isSafeInteger(maximumBytes) && maximumBytes > 0,
    'OCI efficiency report byte limit must be a positive safe integer.');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assert(Buffer.byteLength(serialized) <= maximumBytes,
    `OCI efficiency report exceeds the ${maximumBytes}-byte serialized budget.`);
  return serialized;
}

export function parseOciEfficiencyArgs(args) {
  const archives = {};
  const allowed = new Set(OCI_EFFICIENCY_IMAGE_NAMES);
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    assert(option?.startsWith('--') && value, `Every OCI efficiency option requires a value; found ${option ?? 'nothing'}.`);
    const name = option.slice(2);
    assert(allowed.has(name), `Unknown OCI efficiency option ${option}.`);
    assert(archives[name] === undefined, `OCI efficiency option ${option} was provided more than once.`);
    archives[name] = resolve(value);
  }
  assertExactImages(archives, 'OCI efficiency options');
  return archives;
}

function platformReport(inspections, platform) {
  const compressed = new Map();
  const expanded = new Map();
  const imageLayers = {};
  const packageGroups = new Map();
  const imagePackages = {};
  let aggregatePackageMetadataBytes = 0;

  for (const name of OCI_EFFICIENCY_IMAGE_NAMES) {
    const variant = inspections[name].platforms[platform];
    assert(variant && typeof variant === 'object', `OCI efficiency inspection ${name} has no ${platform} variant.`);
    assert(DIGEST.test(variant.digest ?? ''), `OCI efficiency inspection ${name} ${platform} has no valid manifest digest.`);
    assert(DIGEST.test(variant.configDigest ?? ''), `OCI efficiency inspection ${name} ${platform} has no valid config digest.`);
    assert(Array.isArray(variant.layers) && variant.layers.length > 0 && variant.layers.length <= 4096,
      `OCI efficiency inspection ${name} ${platform} must contain between 1 and 4096 measured layers.`);
    const layers = variant.layers.map((layer, position) => validatedLayer(layer, name, platform, position));
    assert(JSON.stringify(variant.layerDigests) === JSON.stringify(layers.map(({ digest }) => digest)),
      `OCI efficiency inspection ${name} ${platform} compressed layer digests do not match its measurements.`);
    assert(JSON.stringify(variant.diffIds) === JSON.stringify(layers.map(({ diffId }) => diffId)),
      `OCI efficiency inspection ${name} ${platform} diff IDs do not match its measurements.`);
    const compressedLayerBytes = sum(layers.map(({ compressedBytes }) => compressedBytes));
    const expandedLayerBytes = sum(layers.map(({ expandedBytes }) => expandedBytes));
    assert(validBytes(variant.downloadBytes) && variant.downloadBytes >= compressedLayerBytes,
      `OCI efficiency inspection ${name} ${platform} has an invalid download size.`);
    assert(validBytes(variant.expandedBytes) && variant.expandedBytes === expandedLayerBytes,
      `OCI efficiency inspection ${name} ${platform} expanded size does not match its layers.`);
    imageLayers[name] = { variant, layers, compressedLayerBytes, expandedLayerBytes };

    assert(Array.isArray(variant.packages), `OCI efficiency inspection ${name} ${platform} has no SPDX package inventory.`);
    const packageInventory = variant.packages.map((entry, position) => validatedPackage(entry, name, platform, position));
    const packageKeys = new Set();
    for (const entry of packageInventory) {
      const key = canonicalJson(entry);
      assert(!packageKeys.has(key), `OCI efficiency inspection ${name} ${platform} contains a duplicate package identity.`);
      packageKeys.add(key);
      const existing = packageGroups.get(key);
      if (existing) existing.images.add(name);
      else {
        assert(packageGroups.size < 50_000, `OCI efficiency ${platform} package inventory exceeds 50000 distinct identities.`);
        aggregatePackageMetadataBytes += Buffer.byteLength(key);
        assert(aggregatePackageMetadataBytes <= 12 * 1024 * 1024,
          `OCI efficiency ${platform} package inventory exceeds the 12 MiB aggregate metadata budget.`);
        packageGroups.set(key, { ...entry, images: new Set([name]) });
      }
    }
    imagePackages[name] = packageKeys;

    for (const layer of layers) {
      addCompressedLayer(compressed, layer, name);
      addExpandedLayer(expanded, layer, name);
    }
  }

  const compressedLayers = [...compressed.values()]
    .sort((left, right) => compareText(left.digest, right.digest))
    .map((layer) => ({ ...layer, images: orderedImages(layer.images) }));
  const expandedLayers = [...expanded.values()]
    .sort((left, right) => compareText(left.diffId, right.diffId))
    .map((layer) => ({
      ...layer,
      digests: [...layer.digests].sort(),
      images: orderedImages(layer.images),
    }));
  const compressedOwners = new Map(compressedLayers.map((layer) => [layer.digest, layer.images.length]));
  const expandedOwners = new Map(expandedLayers.map((layer) => [layer.diffId, layer.images.length]));
  const packages = [...packageGroups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, entry]) => ({ ...entry, images: orderedImages(entry.images) }));
  const sharedPackageKeys = new Set([...packageGroups.entries()]
    .filter(([, entry]) => entry.images.size > 1)
    .map(([key]) => key));

  return {
    images: Object.fromEntries(OCI_EFFICIENCY_IMAGE_NAMES.map((name) => {
      const { variant, layers, compressedLayerBytes, expandedLayerBytes } = imageLayers[name];
      const sharedCompressedBytes = sum(layers
        .filter(({ digest }) => compressedOwners.get(digest) > 1)
        .map(({ compressedBytes }) => compressedBytes));
      const sharedExpandedBytes = sum(layers
        .filter(({ diffId }) => expandedOwners.get(diffId) > 1)
        .map(({ expandedBytes }) => expandedBytes));
      const packageKeys = imagePackages[name];
      const sharedPackages = [...packageKeys].filter((key) => sharedPackageKeys.has(key)).length;
      return [name, {
        manifestDigest: variant.digest,
        configDigest: variant.configDigest,
        downloadBytes: variant.downloadBytes,
        expandedBytes: variant.expandedBytes,
        layers,
        compressedLayerBytes: {
          total: compressedLayerBytes,
          shared: sharedCompressedBytes,
          unique: compressedLayerBytes - sharedCompressedBytes,
        },
        expandedLayerBytes: {
          total: expandedLayerBytes,
          shared: sharedExpandedBytes,
          unique: expandedLayerBytes - sharedExpandedBytes,
        },
        packageCounts: {
          total: packageKeys.size,
          shared: sharedPackages,
          unique: packageKeys.size - sharedPackages,
        },
      }];
    })),
    compressedLayers,
    expandedLayers,
    packages,
    packageCounts: aggregatePackageCounts(packages),
    compressedLayerBytes: aggregateLayerBytes(compressedLayers, 'compressedBytes'),
    expandedLayerBytes: aggregateLayerBytes(expandedLayers, 'expandedBytes'),
  };
}

function addCompressedLayer(groups, layer, image) {
  const existing = groups.get(layer.digest);
  if (!existing) {
    groups.set(layer.digest, {
      digest: layer.digest,
      diffId: layer.diffId,
      compressedBytes: layer.compressedBytes,
      expandedBytes: layer.expandedBytes,
      occurrences: 1,
      images: new Set([image]),
    });
    return;
  }
  assert(existing.diffId === layer.diffId
    && existing.compressedBytes === layer.compressedBytes
    && existing.expandedBytes === layer.expandedBytes,
  `Compressed OCI layer ${layer.digest} has conflicting measurements.`);
  existing.occurrences += 1;
  existing.images.add(image);
}

function addExpandedLayer(groups, layer, image) {
  const existing = groups.get(layer.diffId);
  if (!existing) {
    groups.set(layer.diffId, {
      diffId: layer.diffId,
      expandedBytes: layer.expandedBytes,
      occurrences: 1,
      digests: new Set([layer.digest]),
      images: new Set([image]),
    });
    return;
  }
  assert(existing.expandedBytes === layer.expandedBytes,
    `Expanded OCI layer ${layer.diffId} has conflicting measurements.`);
  existing.occurrences += 1;
  existing.digests.add(layer.digest);
  existing.images.add(image);
}

function aggregateLayerBytes(layers, sizeKey) {
  const shared = sum(layers.filter(({ images }) => images.length > 1).map((layer) => layer[sizeKey]));
  const unique = sum(layers.filter(({ images }) => images.length === 1).map((layer) => layer[sizeKey]));
  const logical = sum(layers.map((layer) => layer[sizeKey] * layer.occurrences));
  const deduplicated = shared + unique;
  return {
    logical,
    deduplicated,
    shared,
    unique,
    duplicate: logical - deduplicated,
  };
}

function aggregatePackageCounts(packages) {
  const logical = sum(packages.map(({ images }) => images.length));
  const deduplicated = packages.length;
  const shared = packages.filter(({ images }) => images.length > 1).length;
  const unique = deduplicated - shared;
  return { logical, deduplicated, shared, unique, duplicate: logical - deduplicated };
}

function validatedLayer(layer, image, platform, position) {
  assert(layer && DIGEST.test(layer.digest ?? ''),
    `OCI efficiency inspection ${image} ${platform} layer ${position} has no valid compressed digest.`);
  assert(DIGEST.test(layer.diffId ?? ''),
    `OCI efficiency inspection ${image} ${platform} layer ${position} has no valid diff ID.`);
  assert(validBytes(layer.compressedBytes) && validBytes(layer.expandedBytes),
    `OCI efficiency inspection ${image} ${platform} layer ${position} has invalid byte measurements.`);
  return {
    position,
    digest: layer.digest,
    diffId: layer.diffId,
    compressedBytes: layer.compressedBytes,
    expandedBytes: layer.expandedBytes,
  };
}

function validatedPackage(entry, image, platform, position) {
  assert(entry && typeof entry === 'object' && !Array.isArray(entry),
    `OCI efficiency inspection ${image} ${platform} package ${position} must be an object.`);
  const expectedKeys = ['name', 'purls', 'version'];
  assert(JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(expectedKeys),
    `OCI efficiency inspection ${image} ${platform} package ${position} has an invalid shape.`);
  assert(validText(entry.name, 512), `OCI efficiency inspection ${image} ${platform} package ${position} has an invalid name.`);
  assert(entry.version === null || validText(entry.version, 1024),
    `OCI efficiency inspection ${image} ${platform} package ${position} has an invalid version.`);
  assert(Array.isArray(entry.purls) && entry.purls.length <= 64
    && JSON.stringify(entry.purls) === JSON.stringify([...new Set(entry.purls)].sort())
    && entry.purls.every((purl) => validText(purl, 2048) && purl.startsWith('pkg:') && !/\s/u.test(purl)),
  `OCI efficiency inspection ${image} ${platform} package ${position} has invalid purls.`);
  return {
    name: entry.name,
    version: entry.version,
    purls: [...entry.purls],
  };
}

function commonPlatforms(inspections) {
  const expected = Object.keys(inspections[OCI_EFFICIENCY_IMAGE_NAMES[0]]?.platforms ?? {}).sort();
  assert(expected.length > 0, 'OCI efficiency inspections contain no platforms.');
  for (const name of OCI_EFFICIENCY_IMAGE_NAMES.slice(1)) {
    const actual = Object.keys(inspections[name]?.platforms ?? {}).sort();
    assert(JSON.stringify(actual) === JSON.stringify(expected),
      `OCI efficiency inspection ${name} platforms do not match ${OCI_EFFICIENCY_IMAGE_NAMES[0]}.`);
  }
  return expected;
}

function assertExactImages(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...OCI_EFFICIENCY_IMAGE_NAMES].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected),
    `${label} must contain exactly ${expected.join(', ')}.`);
}

function orderedImages(images) {
  return OCI_EFFICIENCY_IMAGE_NAMES.filter((name) => images.has(name));
}

function validBytes(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validText(value, maximumBytes) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value) <= maximumBytes && !hasControlCharacters(value);
}

function hasControlCharacters(value) {
  return [...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

function sum(values) {
  return values.reduce((total, value) => {
    const next = total + value;
    assert(validBytes(next), 'OCI efficiency byte total exceeds JavaScript safe-integer precision.');
    return next;
  }, 0);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => compareText(left, right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const archives = parseOciEfficiencyArgs(process.argv.slice(2));
  process.stdout.write(serializeOciEfficiencyReport(await inspectOciEfficiencyArchives(archives)));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  await main().catch((error) => {
    console.error(`oci-efficiency: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
