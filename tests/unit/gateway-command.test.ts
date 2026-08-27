import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import {
  defaultConfig,
  defaultSecrets,
  gatewayExposureRuntime,
  gatewayExposureRuntimeId,
  presetDefaults,
  type RuntimeContainerBinding,
} from '@qubicl/core';
import { parseArgs } from '../../packages/cli/dist/args.js';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { buildGatewayExposureConfig, validateGatewayTlsInput } from '../../packages/cli/dist/gateway-access.js';
import {
  gatewayCommand,
  gatewayExposureRuntimePlan,
  inspectGatewayExposureRuntime,
  sameGatewayExposureRuntimeReview,
  type GatewayCommandDependencies,
  type GatewayExposureRuntimePlan,
  type GatewayExposureRuntimeReview,
} from '../../packages/cli/dist/gateway-command.js';
import { statePaths, type LoadedState } from '../../packages/cli/dist/state.js';
import type { GatewayExternalPublication, ManagedRuntimeGroupObservation } from '../../packages/cli/dist/docker.js';
import { writeGatewayTlsFixture, type GatewayTlsFixture } from './gateway-test-fixtures.js';

const gatewayBinding: RuntimeContainerBinding = {
  name: 'gateway',
  id: '1'.repeat(64),
  status: 'running',
  imageId: `sha256:${'2'.repeat(64)}`,
  role: 'gateway',
};

function observation(
  status: string,
  group: ManagedRuntimeGroupObservation['group'],
  containers: RuntimeContainerBinding[] = [],
): ManagedRuntimeGroupObservation {
  return { status, group, containers: structuredClone(containers) };
}

function loadedState(root: string, withComputer = false): LoadedState {
  const state: LoadedState = { paths: statePaths(root), config: defaultConfig(), secrets: defaultSecrets() };
  if (withComputer) addConfiguredComputer(state, 'remote-computer', presetDefaults('workstation'));
  return state;
}

function exposeArguments(fixture: GatewayTlsFixture, extra: string[] = []) {
  return parseArgs([
    'expose',
    '--bind', '0.0.0.0',
    '--port', '443',
    '--hostname', 'gateway.example.test',
    '--cert', fixture.certificate,
    '--key', fixture.privateKey,
    '--allow-networks', '192.0.2.0/24',
    '--all-interfaces',
    ...extra,
  ]);
}

interface FakeDependencyControls {
  gateway?: ManagedRuntimeGroupObservation[];
  computer?: ManagedRuntimeGroupObservation[];
  externalPublications?: Array<GatewayExternalPublication | undefined>;
  runtimeSnapshots?: boolean[];
  runtimeSnapshotError?: Error;
  supportError?: Error;
  previewSupportError?: Error;
  interactive?: boolean;
  answer?: string;
  portAvailable?: boolean;
  health?: unknown;
  pendingRecovery?: boolean;
  pendingRecoveryError?: Error;
}

function fakeDependencies(state: LoadedState, controls: FakeDependencyControls = {}) {
  const output: string[] = [];
  const transactions: Array<{ state: LoadedState; runtime: GatewayExposureRuntimePlan }> = [];
  const gatewayObservations = controls.gateway ?? [observation('absent', 'absent')];
  const computerObservations = controls.computer ?? [observation('absent', 'absent')];
  const externalPublications = controls.externalPublications ?? [undefined];
  const runtimeSnapshots = controls.runtimeSnapshots ?? [false];
  let gatewayIndex = 0;
  let computerIndex = 0;
  let publicationIndex = 0;
  let runtimeSnapshotIndex = 0;
  let questions = 0;
  let dockerValidations = 0;
  let supportChecks = 0;
  let previewSupportChecks = 0;
  let portChecks = 0;
  const dependencies: GatewayCommandDependencies = {
    paths: () => state.paths,
    withStateLock: async (_paths, operation) => operation(),
    loadState: async () => state,
    validateDocker: async () => { dockerValidations += 1; },
    assertGatewayExposureSupport: async () => {
      supportChecks += 1;
      if (controls.supportError) throw controls.supportError;
    },
    assertRemotePreviewSupport: async () => {
      previewSupportChecks += 1;
      if (controls.previewSupportError) throw controls.previewSupportError;
    },
    externalPublication: async () => {
      const publication = externalPublications[Math.min(publicationIndex++, externalPublications.length - 1)];
      return publication ? structuredClone(publication) : undefined;
    },
    runtimeSnapshotPresent: async () => runtimeSnapshots[Math.min(runtimeSnapshotIndex++, runtimeSnapshots.length - 1)]!,
    validateRuntimeSnapshot: async () => {
      if (controls.runtimeSnapshotError) throw controls.runtimeSnapshotError;
    },
    observeGateway: async () => structuredClone(gatewayObservations[Math.min(gatewayIndex++, gatewayObservations.length - 1)]!),
    observeComputer: async () => structuredClone(computerObservations[Math.min(computerIndex++, computerObservations.length - 1)]!),
    portAvailable: async () => { portChecks += 1; return controls.portAvailable ?? true; },
    executeTransaction: async (_paths, target, runtime) => {
      transactions.push({ state: structuredClone(target), runtime: structuredClone(runtime) });
    },
    localHealth: async () => {
      const health = structuredClone(controls.health);
      const external = (health as { external?: Record<string, unknown> } | null)?.external;
      if (external?.configured === true && external.ready === true
        && external.protocol === 'direct-tls-v1' && external.configurationId === undefined
        && state.config.gateway.exposure) {
        external.configurationId = gatewayExposureRuntimeId(gatewayExposureRuntime(state.config.gateway.exposure));
      }
      return health;
    },
    pendingRecovery: async () => {
      if (controls.pendingRecoveryError) throw controls.pendingRecoveryError;
      return controls.pendingRecovery ?? false;
    },
    question: async () => { questions += 1; return controls.answer ?? ''; },
    interactive: controls.interactive ?? false,
    write: (message) => output.push(message),
  };
  return {
    dependencies,
    output,
    transactions,
    counts: {
      get questions() { return questions; },
      get dockerValidations() { return dockerValidations; },
      get supportChecks() { return supportChecks; },
      get previewSupportChecks() { return previewSupportChecks; },
      get gatewayObservations() { return gatewayIndex; },
      get computerObservations() { return computerIndex; },
      get externalPublicationInspections() { return publicationIndex; },
      get runtimeSnapshotInspections() { return runtimeSnapshotIndex; },
      get portChecks() { return portChecks; },
    },
  };
}

test('gateway expose requires separate all-interface and allow-all acknowledgements', async () => {
  const fixture = await writeGatewayTlsFixture();
  const state = loadedState(fixture.root);
  const { dependencies } = fakeDependencies(state);
  try {
    const withoutAllInterfaces = exposeArguments(fixture);
    withoutAllInterfaces.options.delete('all-interfaces');
    await assert.rejects(gatewayCommand(withoutAllInterfaces, dependencies), /requires --all-interfaces/i);

    const specificWithAllInterfaces = exposeArguments(fixture);
    specificWithAllInterfaces.options.set('bind', '127.0.0.1');
    await assert.rejects(gatewayCommand(specificWithAllInterfaces, dependencies), /accepted only with --bind 0\.0\.0\.0 or --bind ::/i);

    const allowEveryClient = exposeArguments(fixture);
    allowEveryClient.options.set('allow-networks', '0.0.0.0/0');
    await assert.rejects(gatewayCommand(allowEveryClient, dependencies), /requires --allow-all-clients/i);

    const allowEveryIpv6Client = exposeArguments(fixture);
    allowEveryIpv6Client.options.set('bind', '::');
    allowEveryIpv6Client.options.set('allow-networks', '2001:db8::/32,::/0');
    await assert.rejects(gatewayCommand(allowEveryIpv6Client, dependencies), /requires --allow-all-clients/i);

    for (const nonCanonicalAllowAll of ['0.0.0.0/00', '::/000']) {
      const argumentsWithZeroPadding = exposeArguments(fixture);
      argumentsWithZeroPadding.options.set('allow-networks', nonCanonicalAllowAll);
      await assert.rejects(gatewayCommand(argumentsWithZeroPadding, dependencies), /valid prefix length/i);
    }

    const unnecessaryAllowEveryClient = exposeArguments(fixture, ['--allow-all-clients']);
    await assert.rejects(gatewayCommand(unnecessaryAllowEveryClient, dependencies), /accepted only when.*0\.0\.0\.0\/0 or ::\/0/i);

    const fullyExplicit = exposeArguments(fixture, ['--allow-all-clients', '--yes']);
    fullyExplicit.options.set('allow-networks', '0.0.0.0/0');
    const explicit = fakeDependencies(loadedState(fixture.root), { health: { external: { configured: false, ready: false } } });
    await gatewayCommand(fullyExplicit, explicit.dependencies);
    assert.equal(explicit.transactions.length, 1);
    assert.deepEqual(explicit.transactions[0]?.state.config.gateway.exposure?.allowedNetworks, ['0.0.0.0/0']);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('gateway expose verifies image support before runtime review and leaves state unchanged on failure', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const state = loadedState(fixture.root);
    const fake = fakeDependencies(state, { supportError: new Error('configured gateway image lacks direct-tls-v1 support') });
    await assert.rejects(
      gatewayCommand(exposeArguments(fixture, ['--yes']), fake.dependencies),
      /lacks direct-tls-v1 support/i,
    );
    assert.equal(fake.counts.dockerValidations, 1);
    assert.equal(fake.counts.supportChecks, 1);
    assert.equal(fake.counts.gatewayObservations, 0);
    assert.equal(fake.counts.computerObservations, 0);
    assert.equal(fake.counts.portChecks, 0);
    assert.equal(fake.counts.questions, 0);
    assert.equal(state.config.gateway.exposure, undefined);
    assert.equal(state.secrets.gateway, undefined);
    assert.equal(fake.transactions.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('remote preview domains require compatible computer image and retained-mount evidence', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const state = loadedState(fixture.root, true);
    const fake = fakeDependencies(state, {
      previewSupportError: new Error('retained topology-6 computer lacks dynamic preview access'),
    });
    await assert.rejects(
      gatewayCommand(exposeArguments(fixture, ['--yes', '--preview-domain', 'preview.example.test']), fake.dependencies),
      /lacks dynamic preview access/i,
    );
    assert.equal(fake.counts.supportChecks, 1);
    assert.equal(fake.counts.previewSupportChecks, 1);
    assert.equal(fake.counts.gatewayObservations, 0);
    assert.equal(fake.transactions.length, 0);
    assert.equal(state.config.gateway.exposure, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('re-expose probes the proposed bind when reusing the external port', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const state = loadedState(fixture.root);
    const validated = await validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      hostname: 'gateway.example.test',
      now: fixture.validAt,
    });
    state.config.gateway.exposure = buildGatewayExposureConfig({
      bindAddress: '127.0.0.1',
      port: 443,
      hostname: 'gateway.example.test',
      allowedNetworks: ['192.0.2.0/24'],
      tls: validated.metadata,
    });
    state.secrets.gateway = { tls: validated.secret };
    const runningGateway = observation('running', 'complete', [gatewayBinding]);
    const fake = fakeDependencies(state, {
      gateway: [runningGateway],
      portAvailable: false,
    });

    await assert.rejects(
      gatewayCommand(exposeArguments(fixture, ['--yes']), fake.dependencies),
      /0\.0\.0\.0:443 is already in use/i,
    );

    assert.equal(fake.counts.portChecks, 1);
    assert.equal(fake.transactions.length, 0);
    assert.equal(state.config.gateway.exposure.bindAddress, '127.0.0.1');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('gateway exposure changes require typed confirmation and cancellation does not mutate state', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    for (const scenario of [
      { interactive: false, answer: '', pattern: /Non-interactive.*require --yes/i },
      { interactive: true, answer: 'yes', pattern: /cancelled.*did not match/i },
    ]) {
      const state = loadedState(fixture.root);
      const fake = fakeDependencies(state, { interactive: scenario.interactive, answer: scenario.answer });
      await assert.rejects(gatewayCommand(exposeArguments(fixture), fake.dependencies), scenario.pattern);
      assert.equal(state.config.gateway.exposure, undefined);
      assert.equal(state.secrets.gateway, undefined);
      assert.equal(fake.transactions.length, 0);
      assert.match(fake.output.join('\n'), /Gateway exposure preview/);
      assert.doesNotMatch(fake.output.join('\n'), /BEGIN (?:CERTIFICATE|PRIVATE KEY)|MIIEvQ/u);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('gateway runtime planning preserves running, stopped, and absent state exactly', () => {
  const running: GatewayExposureRuntimeReview = {
    state: 'running',
    gateway: observation('running', 'complete', [gatewayBinding]),
    computers: {
      '00000000-0000-4000-8000-000000000902': observation('running', 'complete'),
    },
    runningComputerIds: ['00000000-0000-4000-8000-000000000902'],
  };
  assert.deepEqual(gatewayExposureRuntimePlan(running), {
    startGateway: true,
    replaceGatewayRunning: true,
    gatewayRuntimeBinding: [gatewayBinding],
    reconnectIds: ['00000000-0000-4000-8000-000000000902'],
  });

  const stopped: GatewayExposureRuntimeReview = {
    state: 'stopped',
    gateway: observation('exited', 'complete', [{ ...gatewayBinding, status: 'exited' }]),
    computers: {},
    runningComputerIds: [],
  };
  assert.deepEqual(gatewayExposureRuntimePlan(stopped), {
    replaceGatewayStopped: true,
    gatewayRuntimeBinding: [{ ...gatewayBinding, status: 'exited' }],
  });

  const absent: GatewayExposureRuntimeReview = {
    state: 'absent',
    gateway: observation('absent', 'absent'),
    computers: {},
    runningComputerIds: [],
  };
  assert.deepEqual(gatewayExposureRuntimePlan(absent), {});
  assert.equal(sameGatewayExposureRuntimeReview(running, structuredClone(running)), true);
  assert.equal(sameGatewayExposureRuntimeReview(running, { ...running, runningComputerIds: [] }), false);
});

test('gateway runtime review fails closed on inconsistent ownership and impossible lifecycle state', async () => {
  const state = loadedState('/tmp/qubicl-gateway-review', true);
  await assert.rejects(inspectGatewayExposureRuntime(state, {
    observeGateway: async () => observation('running', 'inconsistent'),
    observeComputer: async () => observation('absent', 'absent'),
  }), /runtime group is inconsistent/i);
  await assert.rejects(inspectGatewayExposureRuntime(state, {
    observeGateway: async () => observation('exited', 'complete', [{ ...gatewayBinding, status: 'exited' }]),
    observeComputer: async () => observation('running', 'complete'),
  }), /Gateway is stopped while 1 computer runtime.*running/i);
});

test('expose revalidates immutable runtime observations before changing protected state', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const state = loadedState(fixture.root);
    const fake = fakeDependencies(state, {
      gateway: [
        observation('running', 'complete', [gatewayBinding]),
        observation('exited', 'complete', [{ ...gatewayBinding, status: 'exited' }]),
      ],
    });
    await assert.rejects(gatewayCommand(exposeArguments(fixture, ['--yes']), fake.dependencies), /runtime state changed.*No Qubicl state was changed/i);
    assert.equal(state.config.gateway.exposure, undefined);
    assert.equal(state.secrets.gateway, undefined);
    assert.equal(fake.transactions.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('successful exposure uses one recovery plan, reconnects running computers, and never prints TLS secrets', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const state = loadedState(fixture.root, true);
    const computer = state.config.computers[0]!;
    const runningGateway = observation('running', 'complete', [gatewayBinding]);
    const runningComputer = observation('running', 'complete');
    const fake = fakeDependencies(state, {
      gateway: [runningGateway, runningGateway],
      computer: [runningComputer, runningComputer],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      health: { external: { configured: true, ready: true, protocol: 'direct-tls-v1' } },
    });
    await gatewayCommand(exposeArguments(fixture, ['--yes', '--preview-domain', 'preview.example.test']), fake.dependencies);

    assert.equal(fake.transactions.length, 1);
    assert.deepEqual(fake.transactions[0]?.runtime, {
      startGateway: true,
      replaceGatewayRunning: true,
      gatewayRuntimeBinding: [gatewayBinding],
      reconnectIds: [computer.id],
    });
    assert.equal(fake.transactions[0]?.state.config.gateway.exposure?.hostname, 'gateway.example.test');
    assert.equal(fake.transactions[0]?.state.config.gateway.exposure?.previewDomain, 'preview.example.test');
    assert.ok(fake.transactions[0]?.state.secrets.gateway?.tls.privateKeyPem.includes('BEGIN PRIVATE KEY'));
    const written = fake.output.join('\n');
    assert.match(written, /Remote gateway access is configured at https:\/\/gateway\.example\.test/);
    assert.match(written, /durable homes.*unchanged/i);
    assert.doesNotMatch(written, /BEGIN (?:CERTIFICATE|PRIVATE KEY)|MIIEvQ/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('gateway status is read-only and reports no protected TLS or bearer material', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const state = loadedState(fixture.root, true);
    const validated = await validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      hostname: 'gateway.example.test',
      now: fixture.validAt,
    });
    state.config.gateway.exposure = buildGatewayExposureConfig({
      bindAddress: '0.0.0.0',
      port: 443,
      hostname: 'gateway.example.test',
      allowedNetworks: ['192.0.2.0/24'],
      tls: validated.metadata,
    });
    state.secrets.gateway = { tls: validated.secret };
    state.secrets.computers[state.config.computers[0]!.id]!.token = 'secret-bearer-token-that-must-never-appear';
    const fake = fakeDependencies(state, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      runtimeSnapshots: [true],
      health: { external: { configured: true, ready: true, protocol: 'direct-tls-v1' } },
    });
    await gatewayCommand(parseArgs(['status', '--json']), fake.dependencies);

    assert.equal(fake.transactions.length, 0);
    assert.equal(fake.counts.questions, 0);
    assert.equal(fake.counts.portChecks, 0);
    const status = JSON.parse(fake.output.join('\n')) as {
      enabled: boolean;
      active: boolean;
      local: { origin: string; preserved: boolean };
      external: { origin: string; certificate: { fingerprint256: string } };
      computers: Array<{ endpoints: { mcp: string } }>;
    };
    assert.equal(status.enabled, true);
    assert.equal(status.active, true);
    assert.deepEqual(status.local, { origin: 'http://127.0.0.1:3211', preserved: true });
    assert.equal(status.external.origin, 'https://gateway.example.test');
    assert.equal(status.external.certificate.fingerprint256, validated.metadata.certificateFingerprint256);
    assert.match(status.computers[0]!.endpoints.mcp, /^https:\/\/gateway\.example\.test\/computers\//u);
    const written = fake.output.join('\n');
    assert.doesNotMatch(written, /BEGIN (?:CERTIFICATE|PRIVATE KEY)|MIIEvQ|secret-bearer-token/u);

    const interruptedReexpose = fakeDependencies(state, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      runtimeSnapshots: [true],
      pendingRecovery: true,
      health: { external: { configured: true, ready: true, protocol: 'direct-tls-v1' } },
    });
    await gatewayCommand(parseArgs(['status', '--json']), interruptedReexpose.dependencies);
    const interruptedStatus = JSON.parse(interruptedReexpose.output.join('\n')) as {
      active: boolean;
      drift: boolean;
      recovery: { required: boolean };
    };
    assert.equal(interruptedStatus.active, false);
    assert.equal(interruptedStatus.drift, true);
    assert.equal(interruptedStatus.recovery.required, true);

    const staleLiveConfiguration = fakeDependencies(state, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      runtimeSnapshots: [true],
      health: {
        external: {
          configured: true,
          ready: true,
          protocol: 'direct-tls-v1',
          configurationId: `sha256:${'0'.repeat(64)}`,
        },
      },
    });
    await gatewayCommand(parseArgs(['status', '--json']), staleLiveConfiguration.dependencies);
    assert.equal((JSON.parse(staleLiveConfiguration.output.join('\n')) as { active: boolean }).active, false);

    const wrongProtocol = fakeDependencies(state, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      runtimeSnapshots: [true],
      health: { external: { configured: true, ready: true, protocol: 'direct-tls-v2' } },
    });
    await gatewayCommand(parseArgs(['status', '--json']), wrongProtocol.dependencies);
    assert.equal((JSON.parse(wrongProtocol.output.join('\n')) as { active: boolean }).active, false);

    const tamperedRuntimeSnapshot = fakeDependencies(state, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      runtimeSnapshots: [true],
      runtimeSnapshotError: new Error('managed TLS digest mismatch'),
      health: { external: { configured: true, ready: true, protocol: 'direct-tls-v1' } },
    });
    await gatewayCommand(parseArgs(['status', '--json']), tamperedRuntimeSnapshot.dependencies);
    const tamperedStatus = JSON.parse(tamperedRuntimeSnapshot.output.join('\n')) as {
      active: boolean;
      observed: { errors: string[] };
    };
    assert.equal(tamperedStatus.active, false);
    assert.deepEqual(tamperedStatus.observed.errors, ['managed TLS digest mismatch']);

    state.config.gateway.exposure.tls.certificateNotAfter = '2020-01-01T00:00:00.000Z';
    const invalidCertificate = fakeDependencies(state, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      runtimeSnapshots: [true],
      health: { external: { configured: true, ready: true, protocol: 'direct-tls-v1' } },
    });
    await gatewayCommand(parseArgs(['status', '--json']), invalidCertificate.dependencies);
    const invalidCertificateStatus = JSON.parse(invalidCertificate.output.join('\n')) as {
      active: boolean;
      external: { certificate: { error: string } };
    };
    assert.equal(invalidCertificateStatus.active, false);
    assert.match(invalidCertificateStatus.external.certificate.error, /metadata does not match/i);
    state.config.gateway.exposure.tls.certificateNotAfter = validated.metadata.certificateNotAfter;

    const localState = loadedState(fixture.root);
    const drift = fakeDependencies(localState, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{ hostIp: '0.0.0.0', hostPort: 443 }],
      runtimeSnapshots: [true],
    });
    await gatewayCommand(parseArgs(['status', '--json']), drift.dependencies);
    const driftStatus = JSON.parse(drift.output.join('\n')) as {
      enabled: boolean;
      active: boolean;
      drift: boolean;
      observed: { publication: GatewayExternalPublication; runtimeSnapshot: boolean };
    };
    assert.equal(driftStatus.enabled, false);
    assert.equal(driftStatus.active, false);
    assert.equal(driftStatus.drift, true);
    assert.deepEqual(driftStatus.observed.publication, { hostIp: '0.0.0.0', hostPort: 443 });
    assert.equal(driftStatus.observed.runtimeSnapshot, true);

    const broadLocal = fakeDependencies(loadedState(fixture.root), {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [{
        hostIp: '0.0.0.0',
        hostPort: 3211,
        target: 'local-http',
        verificationIssue: 'unsafe-local-publication',
      }],
      runtimeSnapshots: [false],
    });
    await gatewayCommand(parseArgs(['status', '--json']), broadLocal.dependencies);
    const broadLocalStatus = JSON.parse(broadLocal.output.join('\n')) as { enabled: boolean; drift: boolean };
    assert.equal(broadLocalStatus.enabled, false);
    assert.equal(broadLocalStatus.drift, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('revoke reconciles config-off broad local publication and TLS snapshot drift through a confirmed runtime transaction', async () => {
  const state = loadedState('/tmp/qubicl-gateway-drift');
  const runningGateway = observation('running', 'complete', [gatewayBinding]);
  const publication = {
    hostIp: '0.0.0.0',
    hostPort: 3211,
    target: 'local-http' as const,
    verificationIssue: 'unsafe-local-publication' as const,
  };
  const fake = fakeDependencies(state, {
    gateway: [runningGateway, runningGateway, runningGateway],
    externalPublications: [publication, publication, undefined],
    runtimeSnapshots: [true, true, false],
  });

  await gatewayCommand(parseArgs(['revoke', '--yes']), fake.dependencies);

  assert.equal(state.config.gateway.exposure, undefined);
  assert.equal(state.secrets.gateway, undefined);
  assert.equal(fake.transactions.length, 1);
  assert.deepEqual(fake.transactions[0]?.runtime, {
    startGateway: true,
    replaceGatewayRunning: true,
    gatewayRuntimeBinding: [gatewayBinding],
  });
  assert.equal(fake.counts.externalPublicationInspections, 3);
  assert.equal(fake.counts.runtimeSnapshotInspections, 3);
  assert.match(fake.output.join('\n'), /drift cleanup preview.*Remote gateway drift was revoked/is);
});

test('revoke reconciles ambiguous, publish-all, and unexpected config-off publications', async () => {
  const unsafePublications: GatewayExternalPublication[] = [
    {
      target: 'external-tls',
      verificationIssue: 'ambiguous-publication',
      detail: 'Gateway has ambiguous configured port publications.',
    },
    {
      target: 'unexpected',
      verificationIssue: 'publish-all-ports',
      detail: 'Docker PublishAllPorts is enabled without an identifiable publication.',
    },
    {
      target: 'unexpected',
      verificationIssue: 'unexpected-publication',
      detail: 'Unexpected gateway target publication(s): 3128/tcp.',
    },
  ];
  for (const publication of unsafePublications) {
    const statusState = loadedState('/tmp/qubicl-gateway-unsafe-publication-status');
    const status = fakeDependencies(statusState, {
      gateway: [observation('running', 'complete', [gatewayBinding])],
      externalPublications: [publication],
      runtimeSnapshots: [false],
    });
    await gatewayCommand(parseArgs(['status', '--json']), status.dependencies);
    const statusValue = JSON.parse(status.output.join('\n')) as { enabled: boolean; active: boolean; drift: boolean };
    assert.equal(statusValue.enabled, false);
    assert.equal(statusValue.active, false);
    assert.equal(statusValue.drift, true);

    const state = loadedState('/tmp/qubicl-gateway-unsafe-publication');
    const runningGateway = observation('running', 'complete', [gatewayBinding]);
    const fake = fakeDependencies(state, {
      gateway: [runningGateway, runningGateway, runningGateway],
      externalPublications: [publication, publication, undefined],
      runtimeSnapshots: [false, false, false],
    });

    await gatewayCommand(parseArgs(['revoke', '--yes']), fake.dependencies);

    assert.equal(fake.transactions.length, 1);
    assert.deepEqual(fake.transactions[0]?.runtime, {
      startGateway: true,
      replaceGatewayRunning: true,
      gatewayRuntimeBinding: [gatewayBinding],
    });
    assert.match(fake.output.join('\n'), new RegExp(publication.verificationIssue!, 'u'));
  }
});

test('revoke removes exposure through the same immutable running-gateway plan', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const state = loadedState(fixture.root);
    const validated = await validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      hostname: 'gateway.example.test',
      now: fixture.validAt,
    });
    state.config.gateway.exposure = buildGatewayExposureConfig({
      bindAddress: '0.0.0.0',
      port: 443,
      hostname: 'gateway.example.test',
      allowedNetworks: ['192.0.2.0/24'],
      tls: validated.metadata,
    });
    state.secrets.gateway = { tls: validated.secret };
    const runningGateway = observation('running', 'complete', [gatewayBinding]);
    const fake = fakeDependencies(state, {
      gateway: [runningGateway, runningGateway],
      health: { external: { configured: false, ready: false } },
    });
    await gatewayCommand(parseArgs(['revoke', '--yes']), fake.dependencies);
    assert.equal(state.config.gateway.exposure, undefined);
    assert.equal(state.secrets.gateway, undefined);
    assert.deepEqual(fake.transactions[0]?.runtime, {
      startGateway: true,
      replaceGatewayRunning: true,
      gatewayRuntimeBinding: [gatewayBinding],
    });
    assert.match(fake.output.join('\n'), /loopback gateway and all computer data were preserved/i);
    assert.doesNotMatch(fake.output.join('\n'), /BEGIN (?:CERTIFICATE|PRIVATE KEY)|MIIEvQ/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
