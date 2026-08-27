import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITY_IDS,
  CONTROL_PROTOCOL_VERSION,
  ComputerManifestSchema,
  CURATED_PRESETS,
  IMAGE_CATALOG,
  ImageCatalogSchema,
  PRESET_DEFINITIONS,
  buildComputerManifest,
  browserForCompatibility,
  createDevelopmentCatalog,
  buildOpenApi,
  enabledToolNames,
  formatBytes,
  manifestSha256,
  managedSshForCompatibility,
  memoryBytes,
  normalizeDockerPlatform,
  normalizeMemory,
  toolNames,
  validateCpu,
  validateMemory,
} from '@qubicl/core';
import { ToolExecutor } from '@qubicl/control/executor';

test('all curated presets have exact cumulative capability and tool contracts', () => {
  assert.deepEqual(Object.keys(IMAGE_CATALOG.presets).sort(), [...CURATED_PRESETS].sort());
  for (const preset of CURATED_PRESETS) {
    const definition = PRESET_DEFINITIONS[preset];
    const manifest = buildComputerManifest(preset, 'test', 'revision');
    assert.deepEqual(manifest.capabilities, definition.capabilities);
    assert.deepEqual(manifest.tools, enabledToolNames(definition.capabilities));
    assert.equal(manifest.controlProtocolVersion, CONTROL_PROTOCOL_VERSION);
    assert.equal(manifest.viewer, definition.viewer);
    assert.match(manifestSha256(manifest), /^[a-f0-9]{64}$/);
    const openApi = buildOpenApi('computer', enabledToolNames(definition.capabilities)) as { paths: Record<string, unknown> };
    assert.deepEqual(Object.keys(openApi.paths).sort(), manifest.tools.map((name) => `/v1/tools/${name}`).sort());
  }
  assert.deepEqual(PRESET_DEFINITIONS['file-system'].capabilities, CAPABILITY_IDS.slice(0, 3));
  assert.equal(CONTROL_PROTOCOL_VERSION, 10);
  const fileSystemTools = enabledToolNames(PRESET_DEFINITIONS['file-system'].capabilities);
  const browserTools = enabledToolNames(PRESET_DEFINITIONS.browser.capabilities);
  const computerTools = enabledToolNames(PRESET_DEFINITIONS.computer.capabilities);
  assert.equal(fileSystemTools.includes('take_screenshot'), false);
  assert.equal(fileSystemTools.length, 25);
  assert.equal(browserTools.length, 52);
  assert.equal(browserTools.includes('open_desktop_application'), false);
  assert.equal(computerTools.length, 55);
  assert.equal(computerTools.includes('open_desktop_application'), true);
  assert.equal(computerTools.includes('list_desktop_applications'), true);
  assert.equal(computerTools.includes('close_desktop_application'), true);
  assert.deepEqual(enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities), toolNames);
  assert.equal(managedSshForCompatibility('file-system'), false);
  assert.equal(managedSshForCompatibility('browser'), false);
  assert.equal(managedSshForCompatibility('computer'), true);
  assert.equal(managedSshForCompatibility('workstation'), true);
  assert.equal(browserForCompatibility('file-system'), false);
  for (const preset of ['browser', 'computer', 'workstation'] as const) assert.equal(browserForCompatibility(preset), true);
});

test('computer manifests reject a startup profile outside their compatibility contract', () => {
  const manifest = buildComputerManifest('file-system', 'test', 'revision');
  assert.throws(
    () => ComputerManifestSchema.parse({ ...manifest, startupProfile: 'browser' }),
    /startup profile does not match file-system compatibility/,
  );
});

test('release catalogs require exact immutable platform identities and measured sizes', () => {
  const release = structuredClone(createDevelopmentCatalog('1.2.3', 'revision'));
  release.development = false;
  const images = [release.gateway, ...CURATED_PRESETS.map((preset) => release.presets[preset].image)];
  for (const [imageIndex, image] of images.entries()) {
    image.requested = `ghcr.io/eldanring/qubicl-${imageIndex}:1.2.3`;
    image.indexDigest = `sha256:${String(imageIndex + 1).padStart(64, '0')}`;
    for (const [platformIndex, platform] of release.supportedPlatforms.entries()) {
      const digest = `sha256:${String((imageIndex + 1) * 10 + platformIndex).padStart(64, '0')}`;
      image.platforms[platform] = {
        resolved: `${image.requested.split(':1.2.3')[0]}@${image.indexDigest}`,
        digest,
        downloadBytes: 100 + imageIndex,
        expandedBytes: 200 + imageIndex,
      };
    }
  }
  assert.doesNotThrow(() => ImageCatalogSchema.parse(release));

  const withoutDigest = structuredClone(release);
  delete withoutDigest.presets.browser.image.platforms['linux/amd64'].digest;
  assert.throws(() => ImageCatalogSchema.parse(withoutDigest), /platform digest/);

  const mutableResolved = structuredClone(release);
  mutableResolved.presets.computer.image.platforms['linux/arm64'].resolved = mutableResolved.presets.computer.image.requested;
  assert.throws(() => ImageCatalogSchema.parse(mutableResolved), /resolved reference must use its multi-platform index digest/);

  const unknownSize = structuredClone(release);
  unknownSize.gateway.platforms['linux/amd64'].downloadBytes = null;
  assert.throws(() => ImageCatalogSchema.parse(unknownSize), /measured sizes/);

  const policyDrift = structuredClone(release);
  policyDrift.presets.workstation.recommendedMemory = '3g';
  assert.throws(() => ImageCatalogSchema.parse(policyDrift), /catalog policy/);
});

test('control invocation fails closed for a tool outside the image contract', async () => {
  const manifest = buildComputerManifest('file-system', 'test', 'revision');
  const executor = new ToolExecutor({ manifest, sha256: manifestSha256(manifest) });
  await assert.rejects(executor.call('take_screenshot', {}), /not supported/);
});

test('resource and platform normalization enforce setup boundaries', () => {
  assert.equal(validateCpu(0.25), 0.25);
  assert.equal(validateCpu(2, 4), 2);
  assert.throws(() => validateCpu(0.1), /quarter-CPU/);
  assert.throws(() => validateCpu(4.25, 4), /capacity/);
  assert.equal(normalizeMemory('0.5g'), '512m');
  assert.equal(validateMemory('512M', 1024 ** 3), '512m');
  assert.equal(memoryBytes('2g'), 2 * 1024 ** 3);
  assert.throws(() => validateMemory('128m'), /at least 256m/);
  assert.throws(() => validateMemory('2g', 1024 ** 3), /capacity/);
  assert.equal(normalizeDockerPlatform('linux', 'x86_64'), 'linux/amd64');
  assert.equal(normalizeDockerPlatform('linux', 'aarch64'), 'linux/arm64');
  assert.throws(() => normalizeDockerPlatform('windows', 'amd64'), /Linux Docker daemon/);
  assert.equal(formatBytes(null), 'unknown');
  assert.equal(formatBytes(1024 ** 2), '1.0 MiB');
});
