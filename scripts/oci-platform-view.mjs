import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PLATFORMS = new Set(['linux/amd64', 'linux/arm64']);

export async function createOciPlatformView(source, destination, platform, expected) {
  assert(PLATFORMS.has(platform), `Unsupported OCI scan platform ${platform}.`);
  await assertAbsent(destination);

  const layoutBytes = await readFile(join(source, 'oci-layout'));
  const layout = parseJson(layoutBytes, `${source} oci-layout`);
  assert(layout.imageLayoutVersion === '1.0.0', `${source} does not use OCI layout 1.0.0.`);

  const root = parseJson(await readFile(join(source, 'index.json')), `${source} index.json`);
  assert(root.schemaVersion === 2 && root.mediaType === OCI_INDEX && root.manifests?.length === 1,
    `${source} must have one nested OCI image index.`);
  const indexDescriptor = root.manifests[0];
  assert(indexDescriptor.mediaType === OCI_INDEX, `${source} root descriptor is not an OCI image index.`);
  const index = parseJson(await descriptorBytes(source, indexDescriptor), `${source} nested image index`);
  assert(index.schemaVersion === 2 && index.mediaType === OCI_INDEX && Array.isArray(index.manifests),
    `${source} has an invalid nested OCI image index.`);

  const [os, architecture] = platform.split('/');
  const selected = index.manifests.filter((descriptor) => descriptor.platform?.os === os
    && descriptor.platform?.architecture === architecture);
  assert(selected.length === 1, `${source} must contain exactly one ${platform} image manifest.`);
  const manifestDescriptor = selected[0];
  assert(manifestDescriptor.mediaType === OCI_MANIFEST, `${source} ${platform} descriptor is not an OCI image manifest.`);
  const manifestBytes = await descriptorBytes(source, manifestDescriptor);
  const manifest = parseJson(manifestBytes, `${source} ${platform} manifest`);
  assert(manifest.schemaVersion === 2 && manifest.mediaType === OCI_MANIFEST,
    `${source} ${platform} has an invalid OCI image manifest.`);
  assert(manifest.config?.mediaType === OCI_CONFIG, `${source} ${platform} has an invalid OCI image config descriptor.`);
  assert(Array.isArray(manifest.layers) && manifest.layers.length > 0, `${source} ${platform} has no image layers.`);

  const configBytes = await descriptorBytes(source, manifest.config);
  const config = parseJson(configBytes, `${source} ${platform} image config`);
  assert(config.os === os && config.architecture === architecture, `${source} ${platform} image config targets another platform.`);
  assert(config.rootfs?.type === 'layers' && Array.isArray(config.rootfs.diff_ids),
    `${source} ${platform} image config has no rootfs diff IDs.`);
  assert(config.rootfs.diff_ids.length === manifest.layers.length
    && config.rootfs.diff_ids.every((digest) => DIGEST.test(digest)),
  `${source} ${platform} rootfs diff IDs do not match its layer count.`);

  const blobs = new Map([
    [manifestDescriptor.digest, manifestBytes],
    [manifest.config.digest, configBytes],
  ]);
  for (const layer of manifest.layers) {
    assert(typeof layer.mediaType === 'string' && layer.mediaType.startsWith('application/vnd.oci.image.layer.'),
      `${source} ${platform} has an invalid OCI layer descriptor.`);
    blobs.set(layer.digest, await descriptorBytes(source, layer));
  }

  const identity = {
    manifestDigest: manifestDescriptor.digest,
    configDigest: manifest.config.digest,
    layerDigests: manifest.layers.map(({ digest }) => digest),
    diffIds: [...config.rootfs.diff_ids],
  };
  assertExpectedIdentity(identity, indexDescriptor.digest, expected, platform);

  await mkdir(join(destination, 'blobs', 'sha256'), { recursive: true });
  for (const [digest, bytes] of blobs) {
    await writeFile(join(destination, 'blobs', 'sha256', digest.slice('sha256:'.length)), bytes, { flag: 'wx', mode: 0o644 });
  }
  await writeFile(join(destination, 'oci-layout'), layoutBytes, { flag: 'wx', mode: 0o644 });
  await writeFile(join(destination, 'index.json'), `${JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [manifestDescriptor],
  }, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return identity;
}

function assertExpectedIdentity(actual, indexDigest, expected, platform) {
  assert(expected && indexDigest === expected.indexDigest, `OCI ${platform} view does not come from the expected image index.`);
  assert(actual.manifestDigest === expected.manifestDigest
    && actual.configDigest === expected.configDigest,
  `OCI ${platform} view has the wrong manifest or configuration digest.`);
  assert(JSON.stringify(actual.layerDigests) === JSON.stringify(expected.layerDigests),
    `OCI ${platform} view has the wrong compressed layer digests.`);
  assert(JSON.stringify(actual.diffIds) === JSON.stringify(expected.diffIds),
    `OCI ${platform} view has the wrong rootfs diff IDs.`);
}

async function descriptorBytes(directory, descriptor) {
  assert(descriptor && DIGEST.test(descriptor.digest ?? '') && Number.isInteger(descriptor.size) && descriptor.size >= 0,
    `${directory} contains an invalid OCI descriptor.`);
  const bytes = await readFile(join(directory, 'blobs', 'sha256', descriptor.digest.slice('sha256:'.length)));
  assert(bytes.length === descriptor.size, `${directory} descriptor ${descriptor.digest} has the wrong size.`);
  assert(`sha256:${createHash('sha256').update(bytes).digest('hex')}` === descriptor.digest,
    `${directory} descriptor ${descriptor.digest} has the wrong digest.`);
  return bytes;
}

async function assertAbsent(path) {
  try {
    await lstat(path);
    throw new Error(`OCI platform view already exists at ${path}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
