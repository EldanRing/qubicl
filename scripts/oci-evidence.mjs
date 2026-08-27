import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

const exec = promisify(execFile);
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const ATTESTATION = 'attestation-manifest';
const IN_TOTO = 'application/vnd.in-toto+json';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const SPDX_DOCUMENT = 'https://spdx.dev/Document';
const MAX_PROVENANCE_ATTESTATION_BYTES = 32 * 1024 * 1024;
const MAX_SPDX_ATTESTATION_BYTES = 256 * 1024 * 1024;
const MAX_AGGREGATE_ATTESTATION_BYTES = 576 * 1024 * 1024;
const MAX_JSON_DESCRIPTOR_BYTES = 256 * 1024 * 1024;
const STATEMENT_TYPES = new Set([
  'https://in-toto.io/Statement/v0.1',
  'https://in-toto.io/Statement/v1',
]);
export const OCI_PLATFORMS = ['linux/amd64', 'linux/arm64'];

export async function inspectOciArchive(archive, {
  expectedVersion,
  expectedRevision,
  expectedSource,
  expectedPreset,
  expectedManifestPath,
  expectedManifest,
  requireAttestations = false,
  expectedPlatforms = OCI_PLATFORMS,
  includeLayerMeasurements = false,
  includePackageInventory = false,
} = {}) {
  assert(!(expectedManifest && expectedManifestPath), 'OCI inspection accepts expectedManifest or expectedManifestPath, not both.');
  const details = await lstat(archive);
  assert(details.isFile(), `${archive} must be a regular file.`);
  const extracted = await mkdtemp(join(tmpdir(), 'qubicl-oci-inspect-'));
  try {
    await extractOciArchive(archive, extracted);
    const actualBlobs = await validateAllBlobs(extracted, archive);

    const layout = await jsonFile(join(extracted, 'oci-layout'), `${archive} oci-layout`);
    assert(layout.imageLayoutVersion === '1.0.0', `${archive} does not use OCI layout 1.0.0.`);
    const root = await jsonFile(join(extracted, 'index.json'), `${archive} index.json`);
    assert(root.schemaVersion === 2 && root.mediaType === OCI_INDEX, `${archive} has an invalid root index.`);
    assert(root.manifests?.length === 1, `${archive} must contain exactly one nested image index.`);
    const indexDescriptor = root.manifests[0];
    assert(indexDescriptor.mediaType === OCI_INDEX, `${archive} root does not reference an OCI image index.`);
    const referencedBlobs = await collectReferencedBlobs(extracted, root.manifests, archive);
    assert(equalArrays([...actualBlobs].sort(), [...referencedBlobs].sort()), `${archive} contains missing or unreachable OCI blobs.`);
    const index = await descriptorJson(extracted, indexDescriptor, archive);
    assert(index.schemaVersion === 2 && index.mediaType === OCI_INDEX, `${archive} has an invalid image index.`);

    const platformDescriptors = (index.manifests ?? []).filter((descriptor) => descriptor.platform?.os === 'linux'
      && expectedPlatforms.includes(`${descriptor.platform.os}/${descriptor.platform.architecture}`));
    const platforms = platformDescriptors.map(platformName).sort();
    assert(equalArrays(platforms, [...expectedPlatforms].sort()), `${archive} platforms are ${platforms.join(', ')}.`);
    assert(new Set(platforms).size === platforms.length, `${archive} contains duplicate platform manifests.`);

    const expectedManifestDocument = expectedManifest ?? (expectedManifestPath
      ? await jsonFile(expectedManifestPath, `expected computer manifest ${expectedManifestPath}`)
      : undefined);
    const measurements = {};
    const platformContent = new Map();
    const platformNamesByDigest = new Map();
    for (const descriptor of platformDescriptors) {
      assert(descriptor.mediaType === OCI_MANIFEST, `${archive} platform descriptor has an invalid media type.`);
      const manifestBytes = await descriptorBytes(extracted, descriptor, archive);
      const manifest = parseJson(manifestBytes, `${archive} platform manifest ${descriptor.digest}`);
      assert(manifest.schemaVersion === 2 && manifest.mediaType === OCI_MANIFEST, `${archive} has an invalid platform manifest.`);
      assert(Array.isArray(manifest.layers) && manifest.layers.length > 0 && manifest.layers.length <= 4096,
        `${archive} platform manifest must contain between 1 and 4096 layers.`);
      const configBytes = await descriptorBytes(extracted, manifest.config, archive);
      const config = parseJson(configBytes, `${archive} config ${manifest.config?.digest}`);
      const platform = platformName(descriptor);
      assert(config.os === descriptor.platform.os, `${archive} ${platform} config has the wrong OS.`);
      assert(config.architecture === descriptor.platform.architecture, `${archive} ${platform} config has the wrong architecture.`);

      let downloadBytes = manifestBytes.length + configBytes.length;
      let expandedBytes = 0;
      const layerMeasurements = [];
      const contentDigests = new Set([descriptor.digest, manifest.config.digest]);
      for (const [index, layer] of manifest.layers.entries()) {
        const layerPath = await descriptorPath(extracted, layer, archive);
        const layerBytes = (await stat(layerPath)).size;
        const layerExpandedBytes = await uncompressedBytes(layerPath, layer.mediaType);
        downloadBytes += layerBytes;
        expandedBytes += layerExpandedBytes;
        contentDigests.add(layer.digest);
        if (includeLayerMeasurements) {
          const diffId = config.rootfs?.diff_ids?.[index];
          assert(/^sha256:[a-f0-9]{64}$/u.test(diffId ?? ''), `${archive} ${platform} layer ${index} has no valid rootfs diff ID.`);
          layerMeasurements.push({
            digest: layer.digest,
            diffId,
            compressedBytes: layerBytes,
            expandedBytes: layerExpandedBytes,
          });
        }
      }
      if (includeLayerMeasurements) {
        assert(config.rootfs?.type === 'layers'
          && Array.isArray(config.rootfs.diff_ids)
          && config.rootfs.diff_ids.length === manifest.layers.length,
        `${archive} ${platform} rootfs diff IDs do not match its layers.`);
      }

      if (expectedVersion !== undefined) {
        const labels = config.config?.Labels ?? {};
        assert(labels['org.opencontainers.image.version'] === expectedVersion, `${archive} ${platform} has the wrong version label.`);
        assert(labels['org.opencontainers.image.revision'] === expectedRevision, `${archive} ${platform} has the wrong revision label.`);
        assert(labels['org.opencontainers.image.source'] === expectedSource, `${archive} ${platform} has the wrong source label.`);
        assert(nonemptyString(labels['org.opencontainers.image.created']), `${archive} ${platform} has no created label.`);
        assert(labels['org.opencontainers.image.licenses'] === 'Apache-2.0', `${archive} ${platform} has the wrong license label.`);
        if (expectedManifestDocument) {
          assert(labels['dev.qubicl.contract-version'] === '1', `${archive} ${platform} has the wrong capability contract version.`);
          assert(labels['dev.qubicl.preset'] === expectedPreset, `${archive} ${platform} has the wrong preset label.`);
          assert(labels['dev.qubicl.compatibility'] === expectedPreset, `${archive} ${platform} has the wrong compatibility label.`);
          assert(labels['dev.qubicl.capabilities'] === expectedManifestDocument.capabilities.join(','), `${archive} ${platform} has the wrong capability label.`);
          assert(labels['dev.qubicl.manifest-sha256'] === digestCanonical(expectedManifestDocument), `${archive} ${platform} has the wrong manifest digest label.`);
          assert(labels['dev.qubicl.preview-access'] === 'dynamic-v1', `${archive} ${platform} has the wrong dynamic preview-access label.`);
          assert(environmentValue(config.config?.Env ?? [], 'QUBICL_IMAGE_PREVIEW_ACCESS') === 'dynamic-v1', `${archive} ${platform} has the wrong baked dynamic preview-access mode.`);
          const viewerAuthentication = labels['dev.qubicl.viewer-authentication'];
          const bakedViewerAuthentication = environmentValue(config.config?.Env ?? [], 'QUBICL_IMAGE_VIEWER_AUTHENTICATION');
          if (expectedManifestDocument.viewer) {
            assert(viewerAuthentication === 'header-v1', `${archive} ${platform} has the wrong viewer authentication label.`);
            assert(bakedViewerAuthentication === 'header-v1', `${archive} ${platform} has the wrong baked viewer authentication mode.`);
          } else {
            assert(viewerAuthentication === undefined && bakedViewerAuthentication === undefined, `${archive} ${platform} unexpectedly enables viewer authentication.`);
          }
          const embedded = await embeddedComputerManifest(extracted, manifest.layers, archive);
          assert(canonicalJson(embedded) === canonicalJson(expectedManifestDocument), `${archive} ${platform} embeds a different computer manifest.`);
        } else {
          const qubiclLabels = Object.fromEntries(Object.entries(labels).filter(([name]) => name.startsWith('dev.qubicl.')));
          assert(canonicalJson(qubiclLabels) === canonicalJson({
            'dev.qubicl.gateway-protocol-version': '2',
            'dev.qubicl.gateway-exposure': 'direct-tls-v1',
            'dev.qubicl.viewer-authentication': 'header-v1',
          }), `${archive} ${platform} gateway has the wrong authenticated-viewer contract labels.`);
        }
      }

      measurements[platform] = {
        digest: descriptor.digest,
        configDigest: manifest.config.digest,
        layerDigests: manifest.layers.map(({ digest }) => digest),
        diffIds: [...(config.rootfs?.diff_ids ?? [])],
        downloadBytes,
        expandedBytes,
        ...(includeLayerMeasurements ? { layers: layerMeasurements } : {}),
      };
      platformContent.set(descriptor.digest, contentDigests);
      platformNamesByDigest.set(descriptor.digest, platform);
    }

    const attestationDescriptors = (index.manifests ?? []).filter(
      (descriptor) => descriptor.annotations?.['vnd.docker.reference.type'] === ATTESTATION,
    );
    const knownDescriptors = new Set([...platformDescriptors, ...attestationDescriptors]);
    assert((index.manifests ?? []).every((descriptor) => knownDescriptors.has(descriptor)), `${archive} contains an unexpected index descriptor.`);
    if (requireAttestations || includePackageInventory) {
      const packageInventoriesBySubject = await validateAttestations(extracted, archive, attestationDescriptors, platformContent, {
        expectedVersion,
        expectedRevision,
        expectedSource,
        includePackageInventory,
      });
      if (includePackageInventory) {
        for (const [subjectDigest, packages] of packageInventoriesBySubject) {
          const platform = platformNamesByDigest.get(subjectDigest);
          assert(platform, `${archive} package inventory targets an unknown platform manifest ${subjectDigest}.`);
          measurements[platform].packages = packages;
        }
      }
    }

    return { archive: basename(archive), indexDigest: indexDescriptor.digest, platforms: measurements };
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}

function environmentValue(environment, name) {
  const prefix = `${name}=`;
  return environment.toReversed().find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

async function extractOciArchive(archive, destination) {
  const listing = archiveLines((await exec('tar', ['-tf', archive], { maxBuffer: 50_000_000 })).stdout);
  assert(listing.length > 0, `${archive} is empty.`);
  const normalized = listing.map(canonicalOciPath);
  assert(new Set(normalized).size === normalized.length, `${archive} contains duplicate member paths.`);
  assert(normalized.includes('oci-layout') && normalized.includes('index.json'), `${archive} is missing OCI layout roots.`);
  const verbose = archiveLines((await exec('tar', ['-tvf', archive], { maxBuffer: 50_000_000 })).stdout);
  assert(verbose.length === listing.length, `${archive} has ambiguous archive metadata.`);
  assert(verbose.every((line) => line[0] === '-' || line[0] === 'd'), `${archive} contains a link or special entry.`);
  for (let index = 0; index < normalized.length; index += 1) {
    const directory = normalized[index] === 'blobs' || normalized[index] === 'blobs/sha256';
    assert((verbose[index][0] === 'd') === directory, `${archive} has the wrong member type for ${normalized[index]}.`);
  }
  await exec('tar', ['-xf', archive, '-C', destination], { maxBuffer: 50_000_000 });
}

async function validateAllBlobs(directory, archive) {
  const blobDirectory = join(directory, 'blobs', 'sha256');
  const entries = await readdir(blobDirectory, { withFileTypes: true });
  assert(entries.length > 0, `${archive} contains no SHA-256 blobs.`);
  for (const entry of entries) {
    assert(entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name), `${archive} contains an invalid blob entry ${entry.name}.`);
    const actual = await sha256File(join(blobDirectory, entry.name));
    assert(actual === entry.name, `${archive} blob ${entry.name} hashes to ${actual}.`);
  }
  return new Set(entries.map((entry) => entry.name));
}

async function collectReferencedBlobs(directory, descriptors, archive, found = new Set()) {
  for (const descriptor of descriptors ?? []) {
    const digest = descriptor?.digest?.slice('sha256:'.length);
    await descriptorPath(directory, descriptor, archive);
    if (found.has(digest)) continue;
    found.add(digest);
    if (descriptor.mediaType === OCI_INDEX) {
      const index = await descriptorJson(directory, descriptor, archive);
      await collectReferencedBlobs(directory, index.manifests, archive, found);
    } else if (descriptor.mediaType === OCI_MANIFEST) {
      const manifest = await descriptorJson(directory, descriptor, archive);
      assert(Array.isArray(manifest.layers) && manifest.layers.length > 0 && manifest.layers.length <= 4096,
        `${archive} OCI manifest must contain between 1 and 4096 layers.`);
      await collectReferencedBlobs(directory, [manifest.config, ...(manifest.layers ?? [])], archive, found);
    }
  }
  return found;
}

async function validateAttestations(
  directory,
  archive,
  descriptors,
  platformContent,
  { expectedVersion, expectedRevision, expectedSource, includePackageInventory },
) {
  assert(descriptors.length === platformContent.size, `${archive} must contain one attestation manifest per platform.`);
  const bySubject = new Map();
  const packageInventoriesBySubject = new Map();
  let aggregateAttestationBytes = 0;
  for (const descriptor of descriptors) {
    assert(descriptor.mediaType === OCI_MANIFEST, `${archive} attestation descriptor has an invalid media type.`);
    const subjectDigest = descriptor.annotations?.['vnd.docker.reference.digest'];
    assert(platformContent.has(subjectDigest), `${archive} contains an attestation for an unknown platform manifest.`);
    assert(!bySubject.has(subjectDigest), `${archive} contains duplicate attestations for ${subjectDigest}.`);
    bySubject.set(subjectDigest, descriptor);
  }
  assert([...platformContent.keys()].every((digest) => bySubject.has(digest)), `${archive} attestation coverage is incomplete.`);

  for (const [subjectDigest, descriptor] of bySubject) {
    const manifest = await descriptorJson(directory, descriptor, archive);
    assert(manifest.schemaVersion === 2 && manifest.mediaType === OCI_MANIFEST, `${archive} has an invalid attestation manifest.`);
    await descriptorBytes(directory, manifest.config, archive);
    const statementTypes = new Set();
    let packageInventory;
    for (const layer of manifest.layers ?? []) {
      assert(layer.mediaType === IN_TOTO, `${archive} attestation layer has media type ${layer.mediaType}.`);
      const annotatedType = layer.annotations?.['in-toto.io/predicate-type'];
      assert([SLSA_PROVENANCE, SPDX_DOCUMENT].includes(annotatedType), `${archive} has an unexpected attestation predicate ${annotatedType}.`);
      const maximumBytes = annotatedType === SPDX_DOCUMENT
        ? MAX_SPDX_ATTESTATION_BYTES
        : MAX_PROVENANCE_ATTESTATION_BYTES;
      const statementBytes = await descriptorBytes(directory, layer, archive, { maximumBytes });
      aggregateAttestationBytes += statementBytes.length;
      assert(aggregateAttestationBytes <= MAX_AGGREGATE_ATTESTATION_BYTES,
        `${archive} attestation JSON exceeds the 576 MiB aggregate budget.`);
      const statement = parseJson(statementBytes, `${archive} attestation ${layer.digest}`);
      assert(STATEMENT_TYPES.has(statement._type), `${archive} attestation has an invalid in-toto statement type.`);
      assert(statement.predicateType === annotatedType, `${archive} attestation predicate type does not match its descriptor.`);
      assert(!statementTypes.has(statement.predicateType), `${archive} has duplicate ${statement.predicateType} statements for ${subjectDigest}.`);
      const expectedHash = subjectDigest.slice('sha256:'.length);
      assert(Array.isArray(statement.subject), `${archive} ${statement.predicateType} has no in-toto subject array.`);
      assert(statement.subject.length === 0
        || statement.subject.some((subject) => subject?.digest?.sha256 === expectedHash), `${archive} ${statement.predicateType} subject conflicts with platform manifest ${subjectDigest}.`);
      if (statement.predicateType === SLSA_PROVENANCE) {
        const build = statement.predicate?.buildDefinition;
        const run = statement.predicate?.runDetails;
        assert(nonemptyString(build?.buildType) && isUri(build.buildType), `${archive} SLSA v1 buildType is missing or invalid.`);
        const external = build?.externalParameters;
        assert(nonemptyString(external?.configSource?.path), `${archive} SLSA v1 config source is missing.`);
        assert(external?.request?.frontend === 'dockerfile.v0'
          && external.request.args && typeof external.request.args === 'object'
          && Array.isArray(external.request.locals)
          && external.request.locals.some((entry) => entry?.name === 'context')
          && external.request.locals.some((entry) => entry?.name === 'dockerfile'), `${archive} SLSA v1 BuildKit request is missing or invalid.`);
        if (expectedVersion !== undefined) {
          assert(external.request.args['build-arg:QUBICL_VERSION'] === expectedVersion, `${archive} provenance version build argument does not match.`);
          assert(external.request.args['build-arg:QUBICL_REVISION'] === expectedRevision, `${archive} provenance revision build argument does not match.`);
          assert(external.request.args['build-arg:QUBICL_SOURCE'] === expectedSource, `${archive} provenance source build argument does not match.`);
        }
        assert(Array.isArray(build?.resolvedDependencies) && build.resolvedDependencies.length > 0
          && build.resolvedDependencies.every(validMaterial), `${archive} SLSA v1 resolved source/materials are missing or invalid.`);
        assert(run?.builder && typeof run.builder.id === 'string'
          && (run.builder.id === '' || isUri(run.builder.id)), `${archive} SLSA v1 builder identity is invalid.`);
      } else {
        assert(statement.predicate?.spdxVersion === 'SPDX-2.3'
          && statement.predicate?.dataLicense === 'CC0-1.0'
          && statement.predicate?.SPDXID === 'SPDXRef-DOCUMENT'
          && nonemptyString(statement.predicate?.name)
          && nonemptyString(statement.predicate?.documentNamespace) && isUri(statement.predicate.documentNamespace)
          && nonemptyString(statement.predicate?.creationInfo?.created)
          && Array.isArray(statement.predicate?.creationInfo?.creators)
          && statement.predicate.creationInfo.creators.length > 0
          && Array.isArray(statement.predicate?.packages)
          && statement.predicate.packages.length > 0
          && statement.predicate.packages.every((entry) => nonemptyString(entry?.name) && nonemptyString(entry?.SPDXID)), `${archive} SPDX attestation predicate is invalid or empty.`);
        if (includePackageInventory) {
          packageInventory = normalizeSpdxPackageInventory(statement.predicate, `${archive} ${subjectDigest}`);
        }
      }
      statementTypes.add(statement.predicateType);
    }
    assert(statementTypes.has(SLSA_PROVENANCE), `${archive} attestation has no parsed SLSA v1 provenance.`);
    assert(statementTypes.has(SPDX_DOCUMENT), `${archive} attestation has no parsed SPDX SBOM.`);
    if (includePackageInventory) {
      assert(packageInventory, `${archive} ${subjectDigest} has no SPDX package inventory.`);
      packageInventoriesBySubject.set(subjectDigest, packageInventory);
    }
  }
  return packageInventoriesBySubject;
}

function normalizeSpdxPackageInventory(document, label) {
  assert(Array.isArray(document.packages) && document.packages.length <= 50_000,
    `${label} SPDX package inventory is missing or exceeds 50000 entries.`);
  const describedEntries = document.documentDescribes ?? [];
  assert(Array.isArray(describedEntries) && describedEntries.length <= 1024,
    `${label} SPDX documentDescribes is invalid or exceeds 1024 entries.`);
  const described = new Set(describedEntries.map((value, index) => boundedText(value, `${label} documentDescribes ${index}`, 512)));
  const relationships = document.relationships ?? [];
  assert(Array.isArray(relationships) && relationships.length <= 1_000_000,
    `${label} SPDX relationships are invalid or exceed 1000000 entries.`);
  for (const [index, relationship] of relationships.entries()) {
    assert(relationship && typeof relationship === 'object' && !Array.isArray(relationship),
      `${label} SPDX relationship ${index} must be an object.`);
    const relationshipType = boundedText(relationship.relationshipType, `${label} SPDX relationship ${index} type`, 128);
    const source = boundedText(relationship.spdxElementId, `${label} SPDX relationship ${index} source`, 512);
    const target = boundedText(relationship.relatedSpdxElement, `${label} SPDX relationship ${index} target`, 512);
    if (relationshipType === 'DESCRIBES' && source === 'SPDXRef-DOCUMENT') described.add(target);
    if (relationshipType === 'DESCRIBED_BY' && target === 'SPDXRef-DOCUMENT') described.add(source);
    assert(described.size <= 1024, `${label} SPDX described package set exceeds 1024 entries.`);
  }
  const packages = new Map();
  let textBytes = 0;
  for (const [index, entry] of document.packages.entries()) {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), `${label} SPDX package ${index} must be an object.`);
    const spdxId = boundedText(entry.SPDXID, `${label} SPDX package ${index} id`, 512);
    if (described.has(spdxId)) continue;
    const name = boundedText(entry.name, `${label} SPDX package ${spdxId} name`, 512);
    const version = optionalBoundedText(entry.versionInfo, `${label} SPDX package ${spdxId} version`, 1024);
    const references = entry.externalRefs ?? [];
    assert(Array.isArray(references) && references.length <= 64, `${label} SPDX package ${spdxId} has too many external references.`);
    const purls = [...new Set(references.flatMap((reference, referenceIndex) => {
      assert(reference && typeof reference === 'object' && !Array.isArray(reference),
        `${label} SPDX package ${spdxId} external reference ${referenceIndex} must be an object.`);
      const type = `${reference.referenceType ?? ''}`.toLowerCase();
      const locator = reference.referenceLocator;
      if (type !== 'purl' && !(typeof locator === 'string' && locator.startsWith('pkg:'))) return [];
      const purl = boundedText(locator, `${label} SPDX package ${spdxId} purl`, 2048);
      assert(purl.startsWith('pkg:') && !/\s/u.test(purl) && !hasControlCharacters(purl), `${label} SPDX package ${spdxId} has an invalid purl.`);
      return [purl];
    }))].sort();
    const normalized = { name, version, purls };
    const key = canonicalJson(normalized);
    textBytes += Buffer.byteLength(key);
    assert(textBytes <= 8 * 1024 * 1024, `${label} SPDX package inventory exceeds the 8 MiB normalized metadata budget.`);
    packages.set(key, normalized);
  }
  return [...packages.entries()].sort(([left], [right]) => compareText(left, right)).map(([, entry]) => entry);
}

function boundedText(value, label, maximumBytes) {
  assert(typeof value === 'string' && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value) <= maximumBytes && !hasControlCharacters(value), `${label} is missing or invalid.`);
  return value;
}

function optionalBoundedText(value, label, maximumBytes) {
  return value === undefined ? null : boundedText(value, label, maximumBytes);
}

function hasControlCharacters(value) {
  return [...value].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

async function descriptorJson(directory, descriptor, archive) {
  return parseJson(await descriptorBytes(directory, descriptor, archive), `${archive} descriptor ${descriptor?.digest}`);
}

async function descriptorBytes(directory, descriptor, archive, { maximumBytes = MAX_JSON_DESCRIPTOR_BYTES } = {}) {
  const path = await descriptorPath(directory, descriptor, archive);
  assert(descriptor.size <= maximumBytes,
    `${archive} descriptor ${descriptor.digest} exceeds the ${maximumBytes}-byte JSON budget.`);
  return readFile(path);
}

async function descriptorPath(directory, descriptor, archive) {
  assert(descriptor && /^sha256:[a-f0-9]{64}$/.test(descriptor.digest ?? ''), `${archive} contains invalid OCI digest ${JSON.stringify(descriptor?.digest)}.`);
  assert(Number.isInteger(descriptor.size) && descriptor.size >= 0, `${archive} descriptor ${descriptor.digest} has an invalid size.`);
  const path = join(directory, 'blobs', 'sha256', descriptor.digest.slice('sha256:'.length));
  const details = await stat(path);
  assert(details.isFile() && details.size === descriptor.size, `${archive} descriptor ${descriptor.digest} size does not match its blob.`);
  return path;
}

async function embeddedComputerManifest(directory, layers, archive) {
  for (const layer of layers.toReversed()) {
    const layerPath = await descriptorPath(directory, layer, archive);
    for (const path of ['opt/qubicl/computer-manifest.json', './opt/qubicl/computer-manifest.json']) {
      try {
        const output = await exec('tar', ['-xOf', layerPath, path], { encoding: 'utf8', maxBuffer: 2_000_000 });
        return JSON.parse(output.stdout);
      } catch { /* inspect the previous layer */ }
    }
  }
  throw new Error(`${archive} does not embed /opt/qubicl/computer-manifest.json.`);
}

async function uncompressedBytes(path, mediaType) {
  assert(typeof mediaType === 'string', `${path} has no OCI layer media type.`);
  assert(!mediaType.endsWith('+zstd'), `Unsupported zstd OCI layer ${path}; candidates must use gzip compression.`);
  const source = createReadStream(path);
  const stream = mediaType.endsWith('+gzip') ? source.pipe(createGunzip()) : source;
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function archiveLines(output) {
  return output.trimEnd().split('\n').filter(Boolean);
}

function canonicalOciPath(raw) {
  assert(typeof raw === 'string' && raw.length > 0, 'OCI archive contains an empty member name.');
  assert([...raw].every((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127), `OCI member contains a control character: ${JSON.stringify(raw)}.`);
  assert(!raw.includes('\\') && !raw.startsWith('./') && !raw.includes('//'), `OCI member is not canonical POSIX syntax: ${raw}.`);
  const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  assert(normalized && !isAbsolute(normalized) && !win32.isAbsolute(normalized), `OCI member is absolute: ${raw}.`);
  assert(normalized.split('/').every((part) => part && part !== '.' && part !== '..'), `OCI member has an unsafe component: ${raw}.`);
  assert(normalized === 'oci-layout' || normalized === 'index.json' || normalized === 'blobs' || normalized === 'blobs/sha256'
    || /^blobs\/sha256\/[a-f0-9]{64}$/.test(normalized), `OCI member is outside the strict layout: ${raw}.`);
  return normalized;
}

function platformName(descriptor) {
  return `${descriptor.platform.os}/${descriptor.platform.architecture}`;
}

function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error.message}`);
  }
}

async function jsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
}

function digestCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function equalArrays(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validMaterial(material) {
  return nonemptyString(material?.uri) && material.digest && typeof material.digest === 'object'
    && Object.entries(material.digest).some(([algorithm, value]) => /^[A-Za-z0-9_+.-]+$/.test(algorithm)
      && typeof value === 'string' && /^[a-fA-F0-9]{32,}$/.test(value));
}

function isUri(value) {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
