import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  GATEWAY_EXPOSURE_PROTOCOL,
  GATEWAY_PROTOCOL_VERSION,
  IMAGE_CATALOG,
  VIEWER_AUTHENTICATION_HEADER_V1,
  defaultConfig,
  defaultSecrets,
  presetDefaults,
  type ComputerConfig,
  type ImageIdentity,
  type Preset,
} from '@qubicl/core';
import { assertConfiguredComputersSupportRemotePreviews, assertConfiguredGatewaySupportsExposure, assertGatewayHealthCompatibility, computerPreviewAccessFromLabels, computerViewerAuthentication, developmentImageMismatchError, ensureRuntimeImages, gatewayCompatibilityFromLabels, reconcileRuntimeImageContracts, retainedComputerStartAction, type RuntimeImageContractEvidenceAdapter, type RuntimeImageContractReplacementPlan, type RuntimeInspection } from '../../packages/cli/dist/docker.js';
import { buildGatewayExposureConfig } from '../../packages/cli/dist/gateway-access.js';
import { LEGACY_VIEWER_AUTHENTICATION, PREVIEW_ACCESS_CONTAINER_DIRECTORY, PREVIEW_ACCESS_CONTAINER_PATH, PREVIEW_ACCESS_RUNTIME_DIRECTORY, computerContainerName, gatewayContainerName, readRuntimeImageContracts, recordRuntimeImageContracts } from '../../packages/cli/dist/runtime.js';
import { initializeState, newSecret, statePaths } from '../../packages/cli/dist/state.js';

test('development preset manifest mismatch names the source image recovery command', () => {
  const requested = IMAGE_CATALOG.presets.workstation.image.requested;
  const mismatch = new Error(
    `Image ${requested} manifest digest ${'1'.repeat(64)} does not match expected ${'2'.repeat(64)}.`,
  );
  const result = developmentImageMismatchError(mismatch, requested, IMAGE_CATALOG);
  assert.notEqual(result, mismatch);
  assert.match(result.message, /local development image is stale/);
  assert.match(result.message, /npm run images:build/);
  assert.match(result.message, /rerun qubicl setup/);
  assert.equal(result.cause, mismatch);
});

test('development image recovery is not added to unrelated or release errors', () => {
  const requested = IMAGE_CATALOG.presets.workstation.image.requested;
  const unrelated = new Error(`Image ${requested} does not contain a valid Qubicl computer contract.`);
  assert.equal(developmentImageMismatchError(unrelated, requested, IMAGE_CATALOG), unrelated);

  const mismatch = new Error(
    `Image ${requested} manifest digest ${'1'.repeat(64)} does not match expected ${'2'.repeat(64)}.`,
  );
  const releaseCatalog = structuredClone(IMAGE_CATALOG);
  releaseCatalog.development = false;
  assert.equal(developmentImageMismatchError(mismatch, requested, releaseCatalog), mismatch);
});

test('ensuring images for one new computer ignores unrelated configured computer pins', async () => {
  const state = {
    paths: statePaths('/tmp/qubicl-image-selection-test'),
    config: defaultConfig(),
    secrets: defaultSecrets(),
  };
  const unrelated = computer('00000000-0000-4000-8000-000000000401', 'unrelated');
  unrelated.image = {
    ...unrelated.image,
    resolved: `qubicl/workstation@sha256:${'1'.repeat(64)}`,
  };
  const selected = computer('00000000-0000-4000-8000-000000000402', 'selected');
  state.config.computers.push(unrelated, selected);
  const ensured: Array<{ identity: ImageIdentity; kind: 'gateway' | 'computer'; compatibility?: Preset; offline: boolean }> = [];

  await ensureRuntimeImages(state, [selected], true, async (identity, kind, compatibility, offline) => {
    ensured.push({ identity, kind, ...(compatibility ? { compatibility } : {}), offline });
    return {};
  });

  assert.deepEqual(ensured.map(({ identity, kind }) => [kind, identity]), [
    ['gateway', state.config.gateway.image],
    ['computer', selected.image],
  ]);
  assert.equal(ensured.some(({ identity }) => identity === unrelated.image), false);
  assert.equal(ensured.every(({ offline }) => offline), true);
});

test('preserved remote access rejects a replacement gateway without the exact exposure contract', async () => {
  const state = {
    paths: statePaths('/tmp/qubicl-exposed-gateway-image-test'),
    config: defaultConfig(),
    secrets: defaultSecrets(),
  };
  const contentId = testContentId('8');
  state.config.gateway.image.contentId = contentId;
  state.config.gateway.exposure = buildGatewayExposureConfig({
    bindAddress: '192.0.2.10',
    port: 8443,
    hostname: 'gateway.example.test',
    allowedNetworks: ['192.0.2.0/24'],
    tls: {
      id: '1'.repeat(64),
      certificateSha256: `sha256:${'2'.repeat(64)}`,
      privateKeySha256: `sha256:${'3'.repeat(64)}`,
      certificateFingerprint256: `sha256:${'4'.repeat(64)}`,
      certificateNotBefore: '2026-01-01T00:00:00.000Z',
      certificateNotAfter: '2027-01-01T00:00:00.000Z',
    },
  });

  await assert.rejects(
    ensureRuntimeImages(state, [], true, async () => ({
      contentId,
      viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
      gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    })),
    /does not declare direct-tls-v1 support required by the preserved remote-access configuration/i,
  );
});

test('preserved remote preview domain rejects a computer image without dynamic preview access', async () => {
  const state = {
    paths: statePaths('/tmp/qubicl-exposed-preview-image-test'),
    config: defaultConfig(),
    secrets: defaultSecrets(),
  };
  const gatewayContentId = testContentId('7');
  const computerContentId = testContentId('6');
  state.config.gateway.image.contentId = gatewayContentId;
  state.config.gateway.exposure = buildGatewayExposureConfig({
    bindAddress: '192.0.2.10',
    port: 8443,
    hostname: 'gateway.example.test',
    previewDomain: 'preview.example.test',
    allowedNetworks: ['192.0.2.0/24'],
    tls: {
      id: '1'.repeat(64),
      certificateSha256: `sha256:${'2'.repeat(64)}`,
      privateKeySha256: `sha256:${'3'.repeat(64)}`,
      certificateFingerprint256: `sha256:${'4'.repeat(64)}`,
      certificateNotBefore: '2026-01-01T00:00:00.000Z',
      certificateNotAfter: '2027-01-01T00:00:00.000Z',
    },
  });
  const selected: ComputerConfig = {
    id: '00000000-0000-4000-8000-000000000405',
    name: 'preview-image',
    createdAt: '2026-08-20T12:00:00.000Z',
    ...presetDefaults('file-system'),
  };
  selected.image.contentId = computerContentId;
  state.config.computers.push(selected);
  state.secrets.computers[selected.id] = newSecret();

  await assert.rejects(ensureRuntimeImages(state, [selected], true, async (_identity, kind) => kind === 'gateway'
    ? {
        contentId: gatewayContentId,
        viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
        gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
        gatewayExposureProtocol: GATEWAY_EXPOSURE_PROTOCOL,
      }
    : { contentId: computerContentId }), /does not declare dynamic-v1 preview access required by the preserved remote preview domain/i);
});

test('retained stopped computers start without requiring image recreation', () => {
  assert.equal(retainedComputerStartAction('absent'), 'create');
  assert.equal(retainedComputerStartAction('exited'), 'start');
  assert.equal(retainedComputerStartAction('created'), 'start');
  assert.equal(retainedComputerStartAction('paused'), 'unpause');
  assert.equal(retainedComputerStartAction('running'), 'none');
  assert.equal(retainedComputerStartAction('restarting'), 'none');
});

test('viewer authentication is accepted only from an exact baked label and environment contract', () => {
  assert.equal(computerViewerAuthentication('legacy', {}, [], true), undefined);
  assert.equal(computerViewerAuthentication(
    'hardened',
    { 'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1 },
    [`QUBICL_IMAGE_VIEWER_AUTHENTICATION=${VIEWER_AUTHENTICATION_HEADER_V1}`],
    true,
    VIEWER_AUTHENTICATION_HEADER_V1,
  ), VIEWER_AUTHENTICATION_HEADER_V1);
  assert.throws(
    () => computerViewerAuthentication('spoofed-manifest', {}, [], true, VIEWER_AUTHENTICATION_HEADER_V1),
    /missing its authenticated-viewer image contract/,
  );
  assert.throws(
    () => computerViewerAuthentication('label-only', { 'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1 }, [], true),
    /mismatched authenticated-viewer image contract/,
  );
  assert.throws(
    () => computerViewerAuthentication('headless', { 'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1 }, [`QUBICL_IMAGE_VIEWER_AUTHENTICATION=${VIEWER_AUTHENTICATION_HEADER_V1}`], false),
    /mismatched authenticated-viewer image contract/,
  );
});

test('gateway image capability labels distinguish legacy and authenticated-viewer generations', () => {
  assert.deepEqual(gatewayCompatibilityFromLabels('legacy', {}), {});
  assert.deepEqual(gatewayCompatibilityFromLabels('current', {
    'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
    'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
  }, VIEWER_AUTHENTICATION_HEADER_V1), {
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
  });
  assert.deepEqual(gatewayCompatibilityFromLabels('remote-capable', {
    'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
    'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
    'dev.qubicl.gateway-exposure': GATEWAY_EXPOSURE_PROTOCOL,
  }, VIEWER_AUTHENTICATION_HEADER_V1), {
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    gatewayExposureProtocol: GATEWAY_EXPOSURE_PROTOCOL,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
  });
  assert.throws(() => gatewayCompatibilityFromLabels('old', {}, VIEWER_AUTHENTICATION_HEADER_V1), /missing/);
  assert.throws(() => gatewayCompatibilityFromLabels('partial', {
    'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
  }), /invalid/);
  assert.throws(() => gatewayCompatibilityFromLabels('unknown-exposure', {
    'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
    'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
    'dev.qubicl.gateway-exposure': 'direct-tls-v2',
  }), /invalid remote-exposure contract/);
  assert.doesNotThrow(() => assertGatewayHealthCompatibility({
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
  }));
  assert.throws(() => assertGatewayHealthCompatibility({ status: 'ok' }), /does not support authenticated viewer routing/);
  assert.throws(() => assertGatewayHealthCompatibility({
    protocolVersion: GATEWAY_PROTOCOL_VERSION - 1,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
  }), /does not support/);
});

test('gateway exposure support requires exact content-bound direct TLS evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-gateway-exposure-contract-'));
  try {
    const state = await initializeState(statePaths(root));
    await assert.rejects(
      assertConfiguredGatewaySupportsExposure(state, {
        inspectContainer: async () => undefined,
        inspectImage: async () => undefined,
      }),
      /not bound to immutable content evidence/i,
    );

    const contentId = `sha256:${'9'.repeat(64)}` as const;
    state.config.gateway.image.contentId = contentId;
    await recordRuntimeImageContracts(state, [{
      kind: 'gateway',
      contentId,
      viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
      gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    }]);
    const localOnlyEvidence: RuntimeImageContractEvidenceAdapter = {
      inspectContainer: async () => undefined,
      inspectImage: async () => ({
        id: contentId,
        labels: {
          'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
          'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
        },
        env: [],
      }),
    };
    await assert.rejects(
      assertConfiguredGatewaySupportsExposure(state, localOnlyEvidence),
      /does not declare direct-tls-v1 support/i,
    );

    await recordRuntimeImageContracts(state, [{
      kind: 'gateway',
      contentId,
      viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
      gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      gatewayExposureProtocol: GATEWAY_EXPOSURE_PROTOCOL,
    }]);
    await assert.doesNotReject(assertConfiguredGatewaySupportsExposure(state, {
      inspectContainer: async () => { throw new Error('cached exact contract should avoid container inspection'); },
      inspectImage: async () => { throw new Error('cached exact contract should avoid image inspection'); },
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote preview support requires exact image capability and retained mount evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-remote-preview-contract-'));
  try {
    const state = await initializeState(statePaths(root));
    const configured = computer('00000000-0000-4000-8000-000000000404', 'preview-capable');
    const contentId = testContentId('4');
    configured.image.contentId = contentId;
    state.config.computers.push(configured);
    state.secrets.computers[configured.id] = newSecret();
    const homeMount = { Type: 'bind', Source: join(state.paths.computers, configured.id, 'home'), Destination: '/home', RW: true };
    const baseInspection: RuntimeInspection = {
      Image: contentId,
      State: { Status: 'running' },
      Config: {
        Labels: {
          'dev.qubicl.role': 'computer',
          'dev.qubicl.installation': state.config.installationId,
          'dev.qubicl.id': configured.id,
        },
        Env: [],
      },
      Mounts: [homeMount],
    };
    await assert.rejects(assertConfiguredComputersSupportRemotePreviews(state, {
      inspectContainer: async () => structuredClone(baseInspection),
      inspectImage: async () => undefined,
    }), /does not declare dynamic-v1 preview access/i);

    const capable = structuredClone(baseInspection);
    capable.Config!.Labels!['dev.qubicl.preview-access'] = COMPUTER_PREVIEW_ACCESS_PROTOCOL;
    capable.Config!.Env = [
      `QUBICL_IMAGE_PREVIEW_ACCESS=${COMPUTER_PREVIEW_ACCESS_PROTOCOL}`,
      `QUBICL_PREVIEW_ACCESS_PATH=${PREVIEW_ACCESS_CONTAINER_PATH}`,
    ];
    await assert.rejects(assertConfiguredComputersSupportRemotePreviews(state, {
      inspectContainer: async () => structuredClone(capable),
      inspectImage: async () => undefined,
    }), /does not have the managed read-only dynamic preview-access mount/i);

    capable.Mounts!.push({
      Type: 'bind',
      Source: join(state.paths.runtime, PREVIEW_ACCESS_RUNTIME_DIRECTORY, configured.id),
      Destination: PREVIEW_ACCESS_CONTAINER_DIRECTORY,
      RW: false,
    });
    await assert.doesNotReject(assertConfiguredComputersSupportRemotePreviews(state, {
      inspectContainer: async () => structuredClone(capable),
      inspectImage: async () => undefined,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dynamic preview image contract rejects partial labels and environment', () => {
  assert.equal(computerPreviewAccessFromLabels('legacy', {}, []), undefined);
  assert.equal(computerPreviewAccessFromLabels('current', {
    'dev.qubicl.preview-access': COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  }, [`QUBICL_IMAGE_PREVIEW_ACCESS=${COMPUTER_PREVIEW_ACCESS_PROTOCOL}`]), COMPUTER_PREVIEW_ACCESS_PROTOCOL);
  assert.throws(() => computerPreviewAccessFromLabels('partial', {
    'dev.qubicl.preview-access': COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  }, []), /mismatched dynamic preview-access contract/i);
});

test('viewer contract reconciliation repairs missing, empty, and wrong-kind caches from a retained exact container', async (context) => {
  for (const scenario of ['missing', 'empty', 'wrong-kind'] as const) {
    await context.test(scenario, async () => {
      const root = await mkdtemp(join(tmpdir(), `qubicl-viewer-reconcile-${scenario}-`));
      try {
        const state = await initializeState(statePaths(root));
        const configured = computer('00000000-0000-4000-8000-000000000404', `retained-${scenario}`);
        const contentId = testContentId('4');
        const gatewayContentId = testContentId('d');
        configured.image.contentId = contentId;
        state.config.gateway.image.contentId = gatewayContentId;
        state.config.computers.push(configured);
        state.secrets.computers[configured.id] = newSecret();
        if (scenario === 'empty') {
          await writeFile(join(state.paths.runtime, 'image-contracts.json'), `${JSON.stringify({ version: 1, images: {} })}\n`, { mode: 0o600 });
        } else if (scenario === 'wrong-kind') {
          await recordRuntimeImageContracts(state, [{
            kind: 'gateway',
            contentId,
            viewerAuthentication: LEGACY_VIEWER_AUTHENTICATION,
          }]);
        }
        let imageInspections = 0;
        const inspection = retainedViewerInspection(state, configured, contentId);
        const gatewayInspection = retainedGatewayInspection(state, gatewayContentId);
        const adapter: RuntimeImageContractEvidenceAdapter = {
          inspectContainer: async (name) => {
            if (name === computerContainerName(state, configured)) return inspection;
            if (name === gatewayContainerName(state.config.installationId, state.paths.root)) return gatewayInspection;
            return undefined;
          },
          inspectImage: async () => { imageInspections += 1; return undefined; },
        };

        await reconcileRuntimeImageContracts(state, adapter);

        assert.deepEqual((await readRuntimeImageContracts(state)).images[contentId], {
          kind: 'computer',
          contentId,
          viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
        });
        assert.equal((await readRuntimeImageContracts(state)).images[gatewayContentId]?.gatewayProtocolVersion, GATEWAY_PROTOCOL_VERSION);
        assert.equal(imageInspections, 0, 'retained evidence is preferred over the local image store');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('viewer contract reconciliation uses exact immutable image metadata when no retained container exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-viewer-image-evidence-'));
  try {
    const state = await initializeState(statePaths(root));
    const configured = computer('00000000-0000-4000-8000-000000000405', 'exact-image');
    const contentId = testContentId('5');
    const gatewayContentId = testContentId('e');
    configured.image.contentId = contentId;
    state.config.gateway.image.contentId = gatewayContentId;
    state.config.computers.push(configured);
    state.secrets.computers[configured.id] = newSecret();
    const adapter: RuntimeImageContractEvidenceAdapter = {
      inspectContainer: async () => undefined,
      inspectImage: async (requested) => requested === gatewayContentId
        ? {
            id: requested,
            labels: {
              'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
              'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
            },
            env: [],
          }
        : {
            id: requested,
            labels: { 'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1 },
            env: [`QUBICL_IMAGE_VIEWER_AUTHENTICATION=${VIEWER_AUTHENTICATION_HEADER_V1}`],
          },
    };

    await reconcileRuntimeImageContracts(state, adapter);

    assert.equal((await readRuntimeImageContracts(state)).images[contentId]?.viewerAuthentication, VIEWER_AUTHENTICATION_HEADER_V1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planned lifecycle replacement derives target viewer contracts without trusting the retained old image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-viewer-planned-replacement-'));
  try {
    const state = await initializeState(statePaths(root));
    const configured = computer('00000000-0000-4000-8000-000000000415', 'planned-replacement');
    const computerTarget = testContentId('2');
    const gatewayTarget = testContentId('3');
    const computerSource = testContentId('4');
    const gatewaySource = testContentId('5');
    configured.image.contentId = computerTarget;
    state.config.gateway.image.contentId = gatewayTarget;
    state.config.computers.push(configured);
    state.secrets.computers[configured.id] = newSecret();

    const computerName = computerContainerName(state, configured);
    const gatewayName = gatewayContainerName(state.config.installationId, state.paths.root);
    const retainedComputer = retainedViewerInspection(state, configured, computerSource);
    retainedComputer.Id = 'a'.repeat(64);
    retainedComputer.Name = `/${computerName}`;
    const retainedGateway = retainedGatewayInspection(state, gatewaySource);
    retainedGateway.Id = 'b'.repeat(64);
    retainedGateway.Name = `/${gatewayName}`;
    const adapter: RuntimeImageContractEvidenceAdapter = {
      inspectContainer: async (name) => {
        if (name === computerName) return structuredClone(retainedComputer);
        if (name === gatewayName) return structuredClone(retainedGateway);
        return undefined;
      },
      inspectImage: async (contentId) => contentId === gatewayTarget
        ? {
            id: contentId,
            labels: {
              'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
              'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
            },
            env: [],
          }
        : {
            id: contentId,
            labels: { 'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1 },
            env: [`QUBICL_IMAGE_VIEWER_AUTHENTICATION=${VIEWER_AUTHENTICATION_HEADER_V1}`],
          },
    };
    const replacements: RuntimeImageContractReplacementPlan = {
      gatewaySource: [{
        name: gatewayName,
        id: retainedGateway.Id!,
        status: 'running',
        imageId: gatewaySource,
        role: 'gateway',
      }],
      computerSources: {
        [configured.id]: [{
          name: computerName,
          id: retainedComputer.Id!,
          status: 'exited',
          imageId: computerSource,
          role: 'computer',
        }],
      },
    };

    const reviewedComputerSource = replacements.computerSources![configured.id]![0]!;
    const wrongSource: RuntimeImageContractReplacementPlan = {
      ...replacements,
      computerSources: {
        ...replacements.computerSources,
        [configured.id]: [{ ...reviewedComputerSource, id: 'c'.repeat(64) }],
      },
    };
    await assert.rejects(
      reconcileRuntimeImageContracts(state, adapter, wrongSource),
      /changed immutable identity or status/i,
    );

    await reconcileRuntimeImageContracts(state, adapter, replacements);
    const contracts = await readRuntimeImageContracts(state);
    assert.equal(contracts.images[computerTarget]?.viewerAuthentication, VIEWER_AUTHENTICATION_HEADER_V1);
    assert.equal(contracts.images[gatewayTarget]?.gatewayProtocolVersion, GATEWAY_PROTOCOL_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('policy and SSH reconciliation rejects an explicit old gateway before runtime documents can be rendered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-viewer-policy-gate-'));
  try {
    const state = await initializeState(statePaths(root));
    const configured = computer('00000000-0000-4000-8000-000000000409', 'policy-gated-viewer');
    const contentId = testContentId('f');
    const gatewayContentId = testContentId('1');
    configured.image.contentId = contentId;
    state.config.gateway.image.contentId = gatewayContentId;
    state.config.computers.push(configured);
    state.secrets.computers[configured.id] = newSecret();
    await recordRuntimeImageContracts(state, [
      { kind: 'computer', contentId, viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1 },
      { kind: 'gateway', contentId: gatewayContentId, viewerAuthentication: LEGACY_VIEWER_AUTHENTICATION },
    ]);
    const adapter: RuntimeImageContractEvidenceAdapter = {
      inspectContainer: async () => { throw new Error('trusted explicit contracts should not inspect Docker'); },
      inspectImage: async () => { throw new Error('trusted explicit contracts should not inspect Docker'); },
    };

    await assert.rejects(reconcileRuntimeImageContracts(state, adapter), /Upgrade the gateway before changing any computer runtime/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('viewer contract reconciliation fails closed on retained drift, absent evidence, and corrupt cache contents', async (context) => {
  for (const scenario of ['retained-drift', 'no-evidence', 'corrupt-cache'] as const) {
    await context.test(scenario, async () => {
      const root = await mkdtemp(join(tmpdir(), `qubicl-viewer-reconcile-failure-${scenario}-`));
      try {
        const state = await initializeState(statePaths(root));
        const configured = computer('00000000-0000-4000-8000-000000000406', `failure-${scenario}`);
        const contentId = testContentId('6');
        configured.image.contentId = contentId;
        state.config.computers.push(configured);
        state.secrets.computers[configured.id] = newSecret();
        if (scenario === 'corrupt-cache') {
          await writeFile(join(state.paths.runtime, 'image-contracts.json'), '', { mode: 0o600 });
        }
        let evidenceCalls = 0;
        const retained = retainedViewerInspection(state, configured, scenario === 'retained-drift' ? testContentId('7') : contentId);
        const adapter: RuntimeImageContractEvidenceAdapter = {
          inspectContainer: async () => {
            evidenceCalls += 1;
            return scenario === 'retained-drift' ? retained : undefined;
          },
          inspectImage: async () => { evidenceCalls += 1; return undefined; },
        };

        if (scenario === 'retained-drift') {
          await assert.rejects(reconcileRuntimeImageContracts(state, adapter), /was created from/);
        } else {
          await assert.rejects(reconcileRuntimeImageContracts(state, adapter));
        }
        if (scenario === 'corrupt-cache') assert.equal(evidenceCalls, 0, 'invalid cache syntax stops before Docker evidence is consulted');
        else await assert.rejects(readFile(join(state.paths.runtime, 'image-contracts.json'), 'utf8'), { code: 'ENOENT' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('gateway-only up, retained start, and restart paths restore a hardened retained viewer contract', async (context) => {
  for (const lifecycle of ['up', 'retained-start', 'restart'] as const) {
    await context.test(lifecycle, async () => {
      const root = await mkdtemp(join(tmpdir(), `qubicl-viewer-${lifecycle}-`));
      try {
        const state = await initializeState(statePaths(root));
        const configured = computer('00000000-0000-4000-8000-000000000407', `${lifecycle}-viewer`);
        const contentId = testContentId('8');
        const gatewayContentId = testContentId('9');
        configured.image.contentId = contentId;
        state.config.gateway.image.contentId = gatewayContentId;
        state.config.computers.push(configured);
        state.secrets.computers[configured.id] = newSecret();
        const inspection = retainedViewerInspection(state, configured, contentId);
        const adapter: RuntimeImageContractEvidenceAdapter = {
          inspectContainer: async () => inspection,
          inspectImage: async () => undefined,
        };

        await ensureRuntimeImages(state, [], true, async () => ({
          contentId: gatewayContentId,
          gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
          viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
        }), adapter);

        const contracts = await readRuntimeImageContracts(state);
        assert.equal(contracts.images[contentId]?.viewerAuthentication, VIEWER_AUTHENTICATION_HEADER_V1);
        assert.equal(contracts.images[gatewayContentId]?.kind, 'gateway');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('an old gateway is rejected for an unselected hardened retained computer before cache mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-retained-viewer-gate-'));
  try {
    const state = await initializeState(statePaths(root));
    const configured = computer('00000000-0000-4000-8000-000000000408', 'retained-hardened');
    const contentId = testContentId('a');
    configured.image.contentId = contentId;
    state.config.computers.push(configured);
    state.secrets.computers[configured.id] = newSecret();
    const inspection = retainedViewerInspection(state, configured, contentId);
    const adapter: RuntimeImageContractEvidenceAdapter = {
      inspectContainer: async () => inspection,
      inspectImage: async () => undefined,
    };

    await assert.rejects(ensureRuntimeImages(
      state,
      [],
      true,
      async () => ({ contentId: testContentId('b') }),
      adapter,
    ), /Upgrade the gateway before changing any computer runtime/);
    await assert.rejects(readFile(join(state.paths.runtime, 'image-contracts.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('old gateway plus hardened computer is rejected before recording a runtime contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-viewer-gate-'));
  try {
    const state = await initializeState(statePaths(root));
    const selected = computer('00000000-0000-4000-8000-000000000403', 'hardened');
    selected.image.contentId = testContentId('2');
    state.config.computers.push(selected);
    state.secrets.computers[selected.id] = newSecret();
    await assert.rejects(ensureRuntimeImages(state, [selected], true, async (_identity, kind) => kind === 'gateway'
      ? { contentId: testContentId('1') }
      : { contentId: testContentId('2'), viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1 }), /Upgrade the gateway before changing any computer runtime/);
    await assert.rejects(readFile(join(state.paths.runtime, 'image-contracts.json'), 'utf8'), { code: 'ENOENT' });

    state.config.gateway.image.contentId = testContentId('3');
    delete selected.image.contentId;
    await assert.rejects(ensureRuntimeImages(state, [selected], true, async (_identity, kind) => kind === 'gateway'
      ? { contentId: testContentId('3'), gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION, viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1 }
      : { contentId: testContentId('2'), viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1 }), /not bound to its stored content ID/);
    await assert.rejects(readFile(join(state.paths.runtime, 'image-contracts.json'), 'utf8'), { code: 'ENOENT' });

    selected.image.contentId = testContentId('2');
    await ensureRuntimeImages(state, [selected], true, async (_identity, kind) => kind === 'gateway'
      ? { contentId: testContentId('3'), gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION, viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1 }
      : { contentId: testContentId('2'), viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1 });
    const cache = JSON.parse(await readFile(join(state.paths.runtime, 'image-contracts.json'), 'utf8')) as { images: Record<string, unknown> };
    assert.equal(Object.keys(cache.images).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function computer(id: string, name: string): ComputerConfig {
  return { id, name, createdAt: '2026-08-20T12:00:00.000Z', ...presetDefaults('workstation') };
}

function testContentId(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function retainedViewerInspection(
  state: Awaited<ReturnType<typeof initializeState>>,
  configured: ComputerConfig,
  image: `sha256:${string}`,
): RuntimeInspection {
  return {
    Image: image,
    State: { Status: 'exited' },
    Config: {
      Labels: {
        'dev.qubicl.role': 'computer',
        'dev.qubicl.installation': state.config.installationId,
        'dev.qubicl.id': configured.id,
        'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
      },
      Env: [`QUBICL_IMAGE_VIEWER_AUTHENTICATION=${VIEWER_AUTHENTICATION_HEADER_V1}`],
    },
    Mounts: [{ Source: join(state.paths.computers, configured.id, 'home'), Destination: '/home' }],
  };
}

function retainedGatewayInspection(
  state: Awaited<ReturnType<typeof initializeState>>,
  image: `sha256:${string}`,
): RuntimeInspection {
  return {
    Image: image,
    State: { Status: 'running' },
    Config: {
      Labels: {
        'dev.qubicl.role': 'gateway',
        'dev.qubicl.installation': state.config.installationId,
        'dev.qubicl.gateway-protocol-version': `${GATEWAY_PROTOCOL_VERSION}`,
        'dev.qubicl.viewer-authentication': VIEWER_AUTHENTICATION_HEADER_V1,
      },
    },
    Mounts: [{ Source: state.paths.runtime, Destination: '/runtime' }],
  };
}
