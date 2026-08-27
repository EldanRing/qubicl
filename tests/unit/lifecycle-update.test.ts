import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ComputerConfigSchema,
  ConfigSchema,
  createDevelopmentCatalog,
  presetDefaults,
  toolsForCapabilities,
  type ComputerConfig,
  type ImageCatalog,
  type ImageIdentity,
  type QubiclConfig,
  type RuntimeContainerBinding,
} from '../../packages/core/dist/index.js';
import {
  UpgradeAllPartialFailure,
  assessUpgradeSpace,
  buildLifecycleUpdateStatus,
  buildUpgradeAllPlan,
  computerUpgradeRuntimePlan,
  executeUpgradeAll,
  gatewayUpgradeRuntimePlan,
  requirePreservedRuntimeState,
  type AcquiredUpgradeTarget,
  type ExactUpgradeTarget,
  type ManagedRuntimeObservation,
  type UpgradeAllPlanningInput,
} from '../../packages/cli/dist/lifecycle-update.js';
import { lifecycleUpdateStatus, printUpgradeAllPreview, validateUpgradeInvocation } from '../../packages/cli/dist/lifecycle-command.js';
import { statePaths, type LoadedState } from '../../packages/cli/dist/state.js';

test('upgrade-all preview is deterministic, deduplicated, honest about unknown sizes, and read-only', () => {
  const fixture = upgradeFixture();
  const originalConfig = structuredClone(fixture.config);
  const originalRuntime = structuredClone(fixture.runtime);
  const fileTarget = presetDefaults('file-system', 'linux/amd64', fixture.catalog).image.resolved;
  const input = planningInput(fixture, new Set([fileTarget]));

  const plan = buildUpgradeAllPlan(input);

  assert.deepEqual(fixture.config, originalConfig);
  assert.deepEqual(fixture.runtime, originalRuntime);
  assert.deepEqual(plan.rows.map(({ key }) => key), [
    'gateway',
    'default',
    `computer:${IDS.alpha}`,
    `computer:${IDS.custom}`,
    `computer:${IDS.zeta}`,
  ]);
  assert.deepEqual(plan.rows.map(({ runtimeState }) => runtimeState), [
    'running', 'not-applicable', 'absent', 'running', 'stopped',
  ]);
  assert.equal(plan.rows.find(({ key }) => key === `computer:${IDS.zeta}`)?.observedRuntimeStatus, 'created');

  const custom = plan.rows.find(({ key }) => key === `computer:${IDS.custom}`)!;
  assert.equal(custom.automatic, false);
  assert.equal(custom.action, 'manual-custom-image');
  assert.equal(custom.targetImage, null);
  assert.equal(custom.acquisition, null);

  const browserTarget = presetDefaults('browser', 'linux/amd64', fixture.catalog).image.resolved;
  const shared = plan.exactTargets.find(({ exactTarget }) => exactTarget === browserTarget)!;
  assert.deepEqual(shared.consumers.map(({ id }) => id), ['default', `computer:${IDS.zeta}`]);
  assert.equal(shared.downloadBytes, null);
  assert.equal(shared.expandedBytes, null);
  assert.equal(plan.exactTargets.length, 3, 'gateway plus two unique curated computer targets');

  const present = plan.exactTargets.find(({ exactTarget }) => exactTarget === fileTarget)!;
  assert.equal(present.present, true);
  assert.equal(present.downloadBytes, 0);
  assert.equal(present.expandedBytes, 0);
  assert.equal(plan.acquisition.downloadBytes, null);
  assert.equal(plan.acquisition.expandedBytes, null);
  assert.equal(plan.space.requiredBytes, null);
  assert.equal(plan.space.hardFailure, false);
  assert.equal(plan.space.uncertain, true);
  assert.match(plan.space.statement, /unknown/);
  assert.equal(plan.reviewDigest, buildUpgradeAllPlan(input).reviewDigest);
});

test('status fields keep updates, content drift, recovery, and unstable runtime blockers distinct', () => {
  const fixture = upgradeFixture();
  fixture.config.gateway.image = { ...targetGateway(fixture.catalog), contentId: sha('1') };
  const alphaTarget = presetDefaults('file-system', 'linux/amd64', fixture.catalog);
  fixture.config.computers = fixture.config.computers.map((computer) => computer.id === IDS.alpha
    ? ComputerConfigSchema.parse({ ...computer, ...alphaTarget, image: { ...alphaTarget.image, contentId: sha('2') } })
    : computer);
  fixture.runtime.gateway.contentDrift = true;
  fixture.runtime.computers[IDS.alpha] = { status: 'paused', group: 'complete', contentDrift: true };

  const plan = buildUpgradeAllPlan({
    ...planningInput(fixture),
    recovery: { required: true, detail: 'transaction journal is pending' },
  });
  const gateway = plan.rows.find(({ key }) => key === 'gateway')!;
  const alpha = plan.rows.find(({ key }) => key === `computer:${IDS.alpha}`)!;

  assert.equal(gateway.updateAvailable, false);
  assert.equal(gateway.contentDrift, true);
  assert.equal(gateway.action, 'repair-content-drift');
  assert.equal(alpha.updateAvailable, false);
  assert.equal(alpha.contentDrift, true);
  assert.equal(alpha.action, 'blocked-runtime');
  assert.deepEqual(plan.blockers.map(({ code }) => code), ['recovery-required', 'runtime-unstable']);
  assert.equal(plan.recoveryRequired, true);
  assert.equal(gateway.acquisition?.present, false, 'drifted exact content is not credited as present');
});

test('read-only availability and single-upgrade runtime planning preserve stopped, running, and absent states', () => {
  const fixture = upgradeFixture(false);
  const status = buildLifecycleUpdateStatus(
    fixture.config,
    fixture.catalog,
    'linux/amd64',
    { required: true, detail: 'pending transaction' },
  );
  assert.equal(status.recoveryRequired, true);
  assert.equal(status.rows.find(({ key }) => key === 'gateway')?.updateAvailable, true);
  assert.equal(status.rows.find(({ key }) => key === `computer:${IDS.custom}`)?.updateAvailable, null);

  assert.equal(requirePreservedRuntimeState({ status: 'created', group: 'complete' }, 'computer'), 'stopped');
  assert.equal(requirePreservedRuntimeState({ status: 'exited', group: 'complete' }, 'computer'), 'stopped');
  assert.equal(requirePreservedRuntimeState({ status: 'running', group: 'complete' }, 'computer'), 'running');
  assert.equal(requirePreservedRuntimeState({ status: 'absent', group: 'absent' }, 'computer'), 'absent');
  assert.throws(() => requirePreservedRuntimeState({ status: 'paused', group: 'complete' }, 'computer'), /cannot be preserved safely/);
  assert.throws(() => requirePreservedRuntimeState({ status: 'exited', group: 'partial' }, 'computer'), /partial/);
  assert.deepEqual(computerUpgradeRuntimePlan('running', IDS.alpha), {
    replaceIds: [IDS.alpha],
    verifyTokenIds: [IDS.alpha],
  });
  assert.deepEqual(computerUpgradeRuntimePlan('stopped', IDS.alpha), { replaceStoppedIds: [IDS.alpha] });
  assert.deepEqual(computerUpgradeRuntimePlan('absent', IDS.alpha), {});
});

test('exact resolved curated identities without content IDs are acquired and rebound for every row while preserving runtime state', async () => {
  const fixture = upgradeFixture(false);
  fixture.config.gateway.image = targetGateway(fixture.catalog);
  const defaultTarget = presetDefaults('browser', 'linux/amd64', fixture.catalog);
  fixture.config.defaults = { ...defaultTarget, cpus: 4, memory: '7g' };
  fixture.config.computers = fixture.config.computers.map((computer) => {
    if (computer.preset === 'custom') return computer;
    const target = presetDefaults(computer.preset, 'linux/amd64', fixture.catalog);
    return ComputerConfigSchema.parse({ ...computer, ...target, image: target.image });
  });
  fixture.runtime.gateway = { status: 'running', group: 'complete' };
  fixture.runtime.computers[IDS.alpha] = { status: 'absent', group: 'absent' };
  fixture.runtime.computers[IDS.zeta] = { status: 'created', group: 'complete' };

  const plan = buildUpgradeAllPlan(planningInput(fixture));
  const status = buildLifecycleUpdateStatus(fixture.config, fixture.catalog, 'linux/amd64');
  const actions = Object.fromEntries(plan.rows.map(({ key, action }) => [key, action]));
  assert.deepEqual(actions, {
    gateway: 'upgrade',
    default: 'update-default',
    [`computer:${IDS.alpha}`]: 'upgrade',
    [`computer:${IDS.custom}`]: 'manual-custom-image',
    [`computer:${IDS.zeta}`]: 'upgrade',
  });
  assert.equal(status.rows.filter(({ automatic }) => automatic).every(({ updateAvailable }) => updateAvailable === true), true);

  const mutations: Array<{ key: string; runtime: string; contentId: string | undefined }> = [];
  let acquiredCount = 0;
  await executeUpgradeAll(plan, fixture.config, {
    confirm: async () => true,
    replan: async () => plan,
    acquireAndInspect: async (target) => { acquiredCount += 1; return acquired(target); },
    applyGatewayAndDefaults: async (mutation) => {
      assert.equal(acquiredCount, plan.exactTargets.length);
      mutations.push({ key: 'gateway', runtime: mutation.gatewayRuntimeState, contentId: mutation.nextGateway.image.contentId });
      mutations.push({ key: 'default', runtime: 'not-applicable', contentId: mutation.nextDefaults.image.contentId });
    },
    applyComputer: async (mutation) => {
      assert.equal(acquiredCount, plan.exactTargets.length);
      mutations.push({ key: mutation.next.id, runtime: mutation.runtimeState, contentId: mutation.next.image.contentId });
    },
  });
  assert.deepEqual(mutations, [
    { key: 'gateway', runtime: 'running', contentId: sha('f') },
    { key: 'default', runtime: 'not-applicable', contentId: sha('f') },
    { key: IDS.alpha, runtime: 'absent', contentId: sha('f') },
    { key: IDS.zeta, runtime: 'stopped', contentId: sha('f') },
  ]);
});

test('status exact targets use the inspected Docker daemon platform instead of the CLI process architecture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-status-daemon-platform-'));
  try {
    const fixture = upgradeFixture(false);
    const armGateway = `registry.example/qubicl/gateway@${sha('9')}`;
    fixture.catalog.gateway.platforms['linux/arm64'] = {
      resolved: armGateway,
      digest: sha('9'),
      downloadBytes: 90,
      expandedBytes: 180,
    };
    const state = {
      paths: statePaths(root),
      config: fixture.config,
      secrets: { version: 3, computers: {} },
    } as LoadedState;

    const status = await lifecycleUpdateStatus(state, 'linux/arm64', fixture.catalog);

    assert.equal(status.platform, 'linux/arm64');
    assert.equal(status.rows.find(({ key }) => key === 'gateway')?.exactTarget?.resolved, armGateway);
    assert.notEqual(
      status.rows.find(({ key }) => key === 'gateway')?.exactTarget?.resolved,
      fixture.catalog.gateway.platforms['linux/amd64']!.resolved,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('human preview prints preserved per-computer resources and below-recommendation warnings', () => {
  const fixture = upgradeFixture(false);
  const alpha = fixture.config.computers.find(({ id }) => id === IDS.alpha)!;
  alpha.cpus = 0.5;
  alpha.memory = '256m';
  const lines: string[] = [];
  printUpgradeAllPreview(buildUpgradeAllPlan(planningInput(fixture)), (line) => lines.push(line));
  assert.match(lines.join('\n'), /alpha retains 0\.5 CPU \/ 256m, below the catalog recommendation 1 CPU \/ 512m/);
});

test('upgrade invocation reserves --yes for all-upgrade and rejects ambiguous target combinations before state work', () => {
  assert.doesNotThrow(() => validateUpgradeInvocation({ positionals: [], options: new Map([['all', true], ['yes', true]]) }));
  assert.doesNotThrow(() => validateUpgradeInvocation({ positionals: ['alpha'], options: new Map() }));
  assert.throws(() => validateUpgradeInvocation({ positionals: ['alpha'], options: new Map([['yes', true]]) }), /only with.*--all/);
  assert.throws(() => validateUpgradeInvocation({ positionals: ['alpha'], options: new Map([['all', true]]) }), /does not accept a computer name/);
  assert.throws(() => validateUpgradeInvocation({
    positionals: [],
    options: new Map<string, string | boolean>([['all', true], ['image', 'custom']]),
  }), /does not accept --preset or --image/);
  assert.throws(() => validateUpgradeInvocation({ positionals: [], options: new Map() }), /requires one computer name or --all/);
});

test('capacity blocks only a known requirement against directly measured capacity', () => {
  const known = {
    basis: 'deduplicated-conservative-full-acquisition-upper-bound' as const,
    targets: [],
    downloadBytes: 40,
    expandedBytes: 60,
  };
  const insufficient = assessUpgradeSpace(known, {
    availableBytes: 99,
    directlyMeasured: true,
    detail: 'Docker data-root filesystem',
  });
  assert.equal(insufficient.requiredBytes, 100);
  assert.equal(insufficient.hardFailure, true);

  assert.equal(assessUpgradeSpace(known, {
    availableBytes: 1,
    directlyMeasured: false,
    detail: 'host filesystem does not measure Docker Desktop VM storage',
  }).hardFailure, false);
  assert.equal(assessUpgradeSpace({ ...known, downloadBytes: null }, {
    availableBytes: 0,
    directlyMeasured: true,
    detail: 'Docker data-root filesystem',
  }).hardFailure, false);
  assert.throws(() => assessUpgradeSpace(known, {
    availableBytes: null,
    directlyMeasured: true,
    detail: 'invalid observation',
  }), /must include available bytes/);
});

test('unstable, partial, and inconsistent runtime groups block the whole operation before confirmation', async () => {
  const fixture = upgradeFixture();
  fixture.runtime.gateway = { status: 'restarting', group: 'complete' };
  fixture.runtime.computers[IDS.alpha] = { status: 'absent', group: 'partial' };
  fixture.runtime.computers[IDS.zeta] = { status: 'running', group: 'inconsistent' };
  const plan = buildUpgradeAllPlan(planningInput(fixture));
  const events: string[] = [];

  assert.equal(plan.blockers.filter(({ code }) => code === 'runtime-unstable').length, 4);
  await assert.rejects(executeUpgradeAll(plan, fixture.config, {
    confirm: async () => { events.push('confirm'); return true; },
    replan: async () => plan,
    acquireAndInspect: async (target) => acquired(target),
    applyGatewayAndDefaults: async () => { events.push('mutate'); },
    applyComputer: async () => { events.push('mutate'); },
  }), /Upgrade is blocked/);
  assert.deepEqual(events, [], 'blockers are enforced before confirmation or any acquisition/mutation');
});

test('declining confirmation does not revalidate, acquire, or mutate', async () => {
  const fixture = upgradeFixture();
  const plan = buildUpgradeAllPlan(planningInput(fixture));
  const events: string[] = [];
  const result = await executeUpgradeAll(plan, fixture.config, {
    confirm: async () => { events.push('confirm'); return false; },
    replan: async () => { throw new Error('must not replan'); },
    acquireAndInspect: async () => { throw new Error('must not acquire'); },
    applyGatewayAndDefaults: async () => { throw new Error('must not mutate'); },
    applyComputer: async () => { throw new Error('must not mutate'); },
  });
  assert.deepEqual(result, { outcome: 'cancelled', acquiredExactTargets: [], completed: [] });
  assert.deepEqual(events, ['confirm']);
});

test('execution acquires and inspects every deduplicated exact target before gateway-first mutations', async () => {
  const fixture = upgradeFixture(false);
  const plan = buildUpgradeAllPlan(planningInput(fixture));
  const events: string[] = [];
  const computerMutations: ComputerConfig[] = [];
  let gatewayMutation;
  const result = await executeUpgradeAll(plan, fixture.config, {
    confirm: async () => { events.push('confirm'); return true; },
    replan: async () => { events.push('replan'); return buildUpgradeAllPlan(planningInput(fixture)); },
    acquireAndInspect: async (target) => {
      events.push(`acquire:${target.exactTarget}`);
      return acquired(target);
    },
    applyGatewayAndDefaults: async (mutation) => {
      events.push('mutate:gateway');
      gatewayMutation = mutation;
    },
    applyComputer: async (mutation) => {
      events.push(`mutate:${mutation.next.name}`);
      computerMutations.push(mutation.next);
    },
  });

  const firstMutation = events.findIndex((event) => event.startsWith('mutate:'));
  const acquisitions = events.filter((event) => event.startsWith('acquire:'));
  assert.equal(acquisitions.length, plan.exactTargets.length);
  assert.equal(events.slice(0, firstMutation).filter((event) => event.startsWith('acquire:')).length, plan.exactTargets.length);
  assert.deepEqual(events.slice(firstMutation), ['mutate:gateway', 'mutate:alpha', 'mutate:zeta']);
  assert.deepEqual(result.completed, ['gateway-and-defaults', `computer:${IDS.alpha}`, `computer:${IDS.zeta}`]);
  assert.equal(gatewayMutation!.gatewayRuntimeState, 'running');
  assert.equal(gatewayMutation!.nextDefaults.cpus, fixture.config.defaults.cpus);
  assert.equal(gatewayMutation!.nextDefaults.memory, fixture.config.defaults.memory);

  const alphaBefore = fixture.config.computers.find(({ id }) => id === IDS.alpha)!;
  const alphaAfter = computerMutations.find(({ id }) => id === IDS.alpha)!;
  assert.equal(alphaAfter.id, alphaBefore.id);
  assert.equal(alphaAfter.name, alphaBefore.name);
  assert.equal(alphaAfter.createdAt, alphaBefore.createdAt);
  assert.deepEqual(alphaAfter.network, alphaBefore.network);
  assert.deepEqual(alphaAfter.ssh, alphaBefore.ssh);
  assert.deepEqual(alphaAfter.environment, alphaBefore.environment);
  assert.deepEqual(alphaAfter.skillPolicy, alphaBefore.skillPolicy);
  assert.equal(alphaAfter.cpus, alphaBefore.cpus);
  assert.equal(alphaAfter.memory, alphaBefore.memory);
  assert.equal(alphaAfter.image.resolved, presetDefaults('file-system', 'linux/amd64', fixture.catalog).image.resolved);
});

test('gateway-first execution refreshes the immutable gateway binding before running-computer replacement', async () => {
  const fixture = upgradeFixture(false);
  const oldGateway = runtimeBinding('gateway', '1', 'gateway', 'running');
  const newGateway = runtimeBinding('gateway', '2', 'gateway', 'running');
  fixture.runtime.gateway.containers = [oldGateway];
  fixture.runtime.computers[IDS.alpha] = {
    status: 'running',
    group: 'complete',
    containers: [runtimeBinding('alpha', '3', 'computer', 'running')],
  };
  const plan = buildUpgradeAllPlan(planningInput(fixture));
  const seen: RuntimeContainerBinding[][] = [];
  await executeUpgradeAll(plan, fixture.config, {
    confirm: async () => true,
    replan: async () => plan,
    acquireAndInspect: async (target) => acquired(target),
    applyGatewayAndDefaults: async () => [newGateway],
    applyComputer: async (mutation) => { seen.push(mutation.gatewayRuntimeBinding); },
  });
  assert.equal(seen.length > 0, true);
  assert.equal(seen.every((binding) => JSON.stringify(binding) === JSON.stringify([newGateway])), true);
});

test('defaults-only mutation carries no gateway replacement binding or flags', () => {
  const binding = runtimeBinding('gateway', '1', 'gateway', 'running');
  assert.deepEqual(gatewayUpgradeRuntimePlan(false, 'running', [binding]), {});
  assert.deepEqual(gatewayUpgradeRuntimePlan(true, 'running', [binding]), {
    startGateway: true,
    replaceGatewayRunning: true,
    gatewayRuntimeBinding: [binding],
  });
});

test('acquisition failure or changed preview causes no mutation', async () => {
  const fixture = upgradeFixture(false);
  const plan = buildUpgradeAllPlan(planningInput(fixture));
  let mutations = 0;
  let acquisitions = 0;
  await assert.rejects(executeUpgradeAll(plan, fixture.config, {
    confirm: async () => true,
    replan: async () => plan,
    acquireAndInspect: async (target) => {
      acquisitions += 1;
      if (acquisitions === 2) throw new Error('pull failed');
      return acquired(target);
    },
    applyGatewayAndDefaults: async () => { mutations += 1; },
    applyComputer: async () => { mutations += 1; },
  }), /pull failed/);
  assert.equal(mutations, 0);

  const changed = structuredClone(fixture.config);
  changed.gateway.port += 1;
  await assert.rejects(executeUpgradeAll(plan, fixture.config, {
    confirm: async () => true,
    replan: async () => buildUpgradeAllPlan({ ...planningInput(fixture), config: changed }),
    acquireAndInspect: async () => { throw new Error('must not acquire'); },
    applyGatewayAndDefaults: async () => { mutations += 1; },
    applyComputer: async () => { mutations += 1; },
  }), /inputs changed after preview/);
  assert.equal(mutations, 0);
});

test('duplicate consumer or invalid immutable-content evidence blocks every mutation', async () => {
  const fixture = upgradeFixture(false);
  const plan = buildUpgradeAllPlan(planningInput(fixture));
  let mutations = 0;
  await assert.rejects(executeUpgradeAll(plan, fixture.config, {
    confirm: async () => true,
    replan: async () => plan,
    acquireAndInspect: async (target) => ({
      ...acquired(target),
      inspectedConsumers: [
        ...target.consumers.map(({ id }) => id),
        target.consumers[0]!.id,
      ],
    }),
    applyGatewayAndDefaults: async () => { mutations += 1; },
    applyComputer: async () => { mutations += 1; },
  }), /duplicate consumer inspections/);
  assert.equal(mutations, 0);

  await assert.rejects(executeUpgradeAll(plan, fixture.config, {
    confirm: async () => true,
    replan: async () => plan,
    acquireAndInspect: async (target) => ({
      ...acquired(target),
      contentId: 'sha256:short' as `sha256:${string}`,
    }),
    applyGatewayAndDefaults: async () => { mutations += 1; },
    applyComputer: async () => { mutations += 1; },
  }), /invalid content ID/);
  assert.equal(mutations, 0);
});

test('partial failure reports roll-forward progress and a retry mutates only remaining computers', async () => {
  const fixture = upgradeFixture(false);
  let currentConfig = structuredClone(fixture.config);
  const planForCurrent = () => buildUpgradeAllPlan({ ...planningInput(fixture), config: currentConfig });
  const firstPlan = planForCurrent();
  const firstEvents: string[] = [];

  await assert.rejects(executeUpgradeAll(firstPlan, currentConfig, {
    confirm: async () => true,
    replan: async () => planForCurrent(),
    acquireAndInspect: async (target) => acquired(target),
    applyGatewayAndDefaults: async (mutation) => {
      firstEvents.push('gateway');
      currentConfig.gateway = structuredClone(mutation.nextGateway);
      currentConfig.defaults = structuredClone(mutation.nextDefaults);
    },
    applyComputer: async (mutation) => {
      firstEvents.push(mutation.next.name);
      if (mutation.next.id === IDS.zeta) throw new Error('simulated transaction failure');
      replaceComputer(currentConfig, mutation.next);
    },
  }), (error) => {
    assert.ok(error instanceof UpgradeAllPartialFailure);
    assert.deepEqual(error.completed, ['gateway-and-defaults', `computer:${IDS.alpha}`]);
    assert.deepEqual(error.pending, [`computer:${IDS.zeta}`]);
    assert.match(error.message, /retry rolls forward/);
    return true;
  });
  assert.deepEqual(firstEvents, ['gateway', 'alpha', 'zeta']);

  const retryPlan = planForCurrent();
  const retryEvents: string[] = [];
  const retryResult = await executeUpgradeAll(retryPlan, currentConfig, {
    confirm: async () => true,
    replan: async () => planForCurrent(),
    acquireAndInspect: async (target) => {
      retryEvents.push(`acquire:${target.exactTarget}`);
      return acquired(target);
    },
    applyGatewayAndDefaults: async () => { retryEvents.push('unexpected-gateway'); },
    applyComputer: async (mutation) => {
      retryEvents.push(`mutate:${mutation.next.name}`);
      replaceComputer(currentConfig, mutation.next);
    },
  });
  assert.deepEqual(retryResult.completed, [`computer:${IDS.zeta}`]);
  assert.equal(retryEvents.includes('unexpected-gateway'), false);
  assert.deepEqual(retryEvents.filter((event) => event.startsWith('mutate:')), ['mutate:zeta']);
});

const IDS = {
  alpha: '10000000-0000-4000-8000-000000000001',
  custom: '20000000-0000-4000-8000-000000000002',
  zeta: '30000000-0000-4000-8000-000000000003',
};

function upgradeFixture(unknownBrowser = true): {
  catalog: ImageCatalog;
  config: QubiclConfig;
  runtime: {
    gateway: ManagedRuntimeObservation;
    computers: Record<string, ManagedRuntimeObservation | undefined>;
  };
} {
  const catalog = releaseLikeCatalog(unknownBrowser);
  const defaultTarget = presetDefaults('browser', 'linux/amd64', catalog);
  const fileTarget = presetDefaults('file-system', 'linux/amd64', catalog);
  const browserTarget = presetDefaults('browser', 'linux/amd64', catalog);
  const customBase = presetDefaults('workstation', 'linux/amd64', catalog);
  const alpha = computer(IDS.alpha, 'alpha', {
    ...fileTarget,
    image: oldImage(fileTarget.image, 'alpha'),
    cpus: 3,
    memory: '5g',
  });
  const custom = computer(IDS.custom, 'customized', {
    ...customBase,
    preset: 'custom',
    image: {
      requested: 'example.invalid/custom:retained',
      resolved: `example.invalid/custom@${sha('c')}`,
      manifestSha256: customBase.image.manifestSha256,
      contentId: sha('d'),
    },
  });
  const zeta = computer(IDS.zeta, 'zeta', {
    ...browserTarget,
    image: oldImage(browserTarget.image, 'zeta'),
    cpus: 5,
    memory: '6g',
  });
  const config = ConfigSchema.parse({
    version: 3,
    installationId: '00000000-0000-4000-8000-000000000000',
    gateway: { port: 3211, image: oldImage(targetGateway(catalog), 'gateway') },
    defaults: { ...defaultTarget, image: oldImage(defaultTarget.image, 'default'), cpus: 4, memory: '7g' },
    nextName: 4,
    computers: [zeta, custom, alpha],
  });
  return {
    catalog,
    config,
    runtime: {
      gateway: { status: 'running', group: 'complete' },
      computers: {
        [IDS.alpha]: { status: 'absent', group: 'absent' },
        [IDS.custom]: { status: 'running', group: 'complete' },
        [IDS.zeta]: { status: 'created', group: 'complete' },
      },
    },
  };
}

function planningInput(
  fixture: ReturnType<typeof upgradeFixture>,
  presentExactTargets: ReadonlySet<string> = new Set(),
): UpgradeAllPlanningInput {
  return {
    config: fixture.config,
    catalog: fixture.catalog,
    platform: 'linux/amd64',
    runtime: fixture.runtime,
    presentExactTargets,
    capacity: {
      availableBytes: 1_000_000,
      directlyMeasured: true,
      detail: 'test Docker data root',
    },
    recovery: { required: false },
  };
}

function releaseLikeCatalog(unknownBrowser: boolean): ImageCatalog {
  const catalog = createDevelopmentCatalog('0.2.0', 'reviewed-revision');
  let index = 1;
  const configure = (image: ImageCatalog['gateway'], unknown = false) => {
    image.requested = `registry.example/qubicl/image-${index}:0.2.0`;
    image.platforms['linux/amd64'] = {
      resolved: `${image.requested}@${sha(index.toString(16))}`,
      digest: sha(index.toString(16)),
      downloadBytes: unknown ? null : index * 10,
      expandedBytes: unknown ? null : index * 20,
    };
    index += 1;
  };
  configure(catalog.gateway);
  configure(catalog.presets['file-system'].image);
  configure(catalog.presets.browser.image, unknownBrowser);
  configure(catalog.presets.computer.image);
  configure(catalog.presets.workstation.image);
  return catalog;
}

function computer(
  id: string,
  name: string,
  defaults: ReturnType<typeof presetDefaults> & { preset: 'custom' | ReturnType<typeof presetDefaults>['preset'] },
): ComputerConfig {
  return ComputerConfigSchema.parse({
    ...defaults,
    id,
    name,
    runtimeName: `runtime-${name}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    network: { profile: 'custom', allowDomains: ['example.com'], denyDomains: [], temporaryApprovals: [] },
    ssh: {
      enabled: true,
      port: 2222,
      publicKey: `ssh-ed25519 ${'A'.repeat(48)}`,
      fingerprint: 'SHA256:fixture-fingerprint',
    },
    environment: { PROJECT_NAME: name },
    toolPolicy: toolsForCapabilities(defaults.capabilities),
    skillPolicy: { enabledCatalogSkills: ['qubicl-core/safe-filesystem-navigation'] },
  });
}

function oldImage(target: ImageIdentity, label: string): ImageIdentity {
  return {
    ...structuredClone(target),
    resolved: `${target.requested}@${sha(label[0] ?? 'a')}`,
    contentId: sha('e'),
  };
}

function targetGateway(catalog: ImageCatalog): ImageIdentity {
  return {
    requested: catalog.gateway.requested,
    resolved: catalog.gateway.platforms['linux/amd64']!.resolved,
  };
}

function acquired(target: ExactUpgradeTarget): AcquiredUpgradeTarget {
  return {
    exactTarget: target.exactTarget,
    contentId: sha('f'),
    inspectedConsumers: target.consumers.map(({ id }) => id),
  };
}

function replaceComputer(config: QubiclConfig, replacement: ComputerConfig): void {
  config.computers = config.computers.map((computer) => computer.id === replacement.id
    ? structuredClone(replacement)
    : computer);
}

function sha(character: string): `sha256:${string}` {
  const nibble = /^[0-9a-f]$/i.test(character) ? character.toLowerCase() : 'a';
  return `sha256:${nibble.repeat(64)}`;
}

function runtimeBinding(
  name: string,
  character: string,
  role: RuntimeContainerBinding['role'],
  status: string,
): RuntimeContainerBinding {
  return {
    name,
    id: character.repeat(64),
    status,
    imageId: sha(character),
    role,
    ...(role === 'computer' ? { topologyVersion: '6' } : {}),
  };
}
