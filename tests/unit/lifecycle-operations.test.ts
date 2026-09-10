import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ComputerConfigSchema, defaultConfig, defaultSecrets, type ComputerConfig, type RuntimeContainerBinding } from '@qubicl/core';
import {
  restartManagedComputer,
  inspectPendingComputerLifecycle,
  recoverPendingComputerLifecycle,
  startManagedComputer,
  stopManagedComputer,
  type ComputerLifecycleRuntime,
} from '../../packages/cli/dist/lifecycle-operations.js';
import { statePaths, type LoadedState } from '../../packages/cli/dist/state.js';
import type { ManagedRuntimeGroupObservation } from '../../packages/cli/dist/docker.js';

test('retained start uses immutable IDs and revalidates before mutation', async () => {
  const fixture = await lifecycleFixture();
  const events: string[] = [];
  const runtime = fakeRuntime([
    complete('exited', fixture.binding),
    complete('exited', fixture.binding),
    complete('running', fixture.binding),
  ], events);

  await startManagedComputer(fixture.state, fixture.computer, runtime);

  assert.deepEqual(events, [
    'validate',
    'observe:exited',
    'ensure:',
    'render',
    'gateway:start',
    'gateway:verify',
    'observe:exited',
    `docker:start,${fixture.binding.id}`,
    'docker:network,connect',
    'healthy',
    'route',
    'observe:running',
    'policies',
  ]);
  assert.ok(!events.some((event) => event.includes(fixture.binding.name)));
});

test('absent start is the only lifecycle path allowed to create a runtime', async () => {
  const fixture = await lifecycleFixture();
  fixture.computer.image.contentId = fixture.binding.imageId;
  const events: string[] = [];
  const runtime = fakeRuntime([
    { group: 'absent', status: 'absent', containers: [] },
    { group: 'absent', status: 'absent', containers: [] },
    complete('running', fixture.binding),
  ], events);

  await startManagedComputer(fixture.state, fixture.computer, runtime);

  assert.deepEqual(events, [
    'validate',
    'observe:absent',
    `ensure:${fixture.computer.id}`,
    'render',
    'gateway:start',
    'gateway:verify',
    'observe:absent',
    'start:absent',
    'observe:running',
    'policies',
  ]);
});

test('stop and restart target only revalidated immutable container IDs', async () => {
  const stopFixture = await lifecycleFixture();
  const stopEvents: string[] = [];
  await stopManagedComputer(stopFixture.state, stopFixture.computer, fakeRuntime([
    complete('running', stopFixture.binding),
    complete('exited', { ...stopFixture.binding, status: 'exited' }),
  ], stopEvents));
  assert.ok(stopEvents.includes(`docker:stop,${stopFixture.binding.id}`));
  assert.ok(!stopEvents.some((event) => event.includes(stopFixture.binding.name)));

  const restartFixture = await lifecycleFixture();
  const restartEvents: string[] = [];
  await restartManagedComputer(restartFixture.state, restartFixture.computer, fakeRuntime([
    complete('running', restartFixture.binding),
    complete('running', restartFixture.binding),
    complete('running', restartFixture.binding),
  ], restartEvents));
  assert.ok(restartEvents.includes(`docker:restart,${restartFixture.binding.id}`));
  assert.ok(restartEvents.includes('control:release'));
  assert.ok(!restartEvents.some((event) => event.includes(restartFixture.binding.name)));
});

test('interrupted retained start recovers only its recorded immutable IDs', async () => {
  const fixture = await lifecycleFixture();
  const sidecar: RuntimeContainerBinding = {
    name: `${fixture.binding.name}-executor`,
    id: 'd'.repeat(64),
    status: 'exited',
    imageId: fixture.binding.imageId,
    role: 'computer-executor',
  };
  const retained = complete('exited', fixture.binding, sidecar);
  const interrupted = fakeRuntime([retained, retained], []);
  interrupted.docker = async (args) => {
    if (args[0] === 'start') throw new Error('simulated partial Docker start');
    return '';
  };

  await assert.rejects(
    startManagedComputer(fixture.state, fixture.computer, interrupted),
    /simulated partial Docker start/,
  );
  const journal = await inspectPendingComputerLifecycle(fixture.state);
  assert.equal(journal?.operation, 'start');
  assert.deepEqual(journal?.runtimeContainers.map(({ id }) => id), [fixture.binding.id, sidecar.id]);
  assert.equal((await stat(join(fixture.state.paths.runtime, 'computer-lifecycle.json'))).isFile(), true);

  let changedRuntimeMutated = false;
  const changed = complete('running', { ...fixture.binding, id: 'e'.repeat(64) }, sidecar);
  const rejectedRecovery = fakeRuntime([changed], []);
  rejectedRecovery.docker = async () => { changedRuntimeMutated = true; return ''; };
  await assert.rejects(
    recoverPendingComputerLifecycle(fixture.state, rejectedRecovery),
    /changed or missing immutable runtime IDs/,
  );
  assert.equal(changedRuntimeMutated, false);

  const mixed: ManagedRuntimeGroupObservation = {
    group: 'inconsistent',
    status: 'running',
    containers: [
      { ...fixture.binding, status: 'running' },
      { ...sidecar, status: 'exited' },
    ],
  };
  const recovered = complete('running', fixture.binding, sidecar);
  const recoveryEvents: string[] = [];
  assert.equal(await recoverPendingComputerLifecycle(
    fixture.state,
    fakeRuntime([mixed, recovered], recoveryEvents),
  ), true);
  assert.ok(recoveryEvents.includes(`docker:start,${sidecar.id}`));
  await assert.rejects(stat(join(fixture.state.paths.runtime, 'computer-lifecycle.json')), { code: 'ENOENT' });
});

test('interrupted stop retains its journal on failure and recovers the exact group', async () => {
  const fixture = await lifecycleFixture();
  const sidecar = lifecycleSidecar(fixture.binding, 'd');
  const running = complete('running', fixture.binding, sidecar);
  const interrupted = fakeRuntime([running], []);
  interrupted.docker = async () => { throw new Error('simulated partial Docker stop'); };
  await assert.rejects(
    stopManagedComputer(fixture.state, fixture.computer, interrupted),
    /simulated partial Docker stop/,
  );

  const mixed: ManagedRuntimeGroupObservation = {
    group: 'inconsistent',
    status: 'running',
    containers: [{ ...fixture.binding, status: 'running' }, { ...sidecar, status: 'exited' }],
  };
  const failedRecovery = fakeRuntime([mixed], []);
  failedRecovery.docker = async () => { throw new Error('daemon unavailable during recovery'); };
  await assert.rejects(
    recoverPendingComputerLifecycle(fixture.state, failedRecovery),
    /daemon unavailable during recovery/,
  );
  assert.equal((await inspectPendingComputerLifecycle(fixture.state))?.operation, 'stop');

  const recoveryEvents: string[] = [];
  assert.equal(await recoverPendingComputerLifecycle(
    fixture.state,
    fakeRuntime([mixed, complete('exited', fixture.binding, sidecar)], recoveryEvents),
  ), true);
  assert.ok(recoveryEvents.includes(`docker:stop,${fixture.binding.id},${sidecar.id}`));
  await assert.rejects(stat(lifecycleJournalPath(fixture.state)), { code: 'ENOENT' });
});

test('interrupted restart replays only the recorded IDs and completes control release', async () => {
  const fixture = await lifecycleFixture();
  const sidecar = lifecycleSidecar(fixture.binding, 'd');
  const running = complete('running', fixture.binding, sidecar);
  const interrupted = fakeRuntime([running, running], []);
  interrupted.docker = async (args) => {
    if (args[0] === 'restart') throw new Error('simulated partial Docker restart');
    return '';
  };
  await assert.rejects(
    restartManagedComputer(fixture.state, fixture.computer, interrupted),
    /simulated partial Docker restart/,
  );

  const mixed: ManagedRuntimeGroupObservation = {
    group: 'inconsistent',
    status: 'running',
    containers: [{ ...fixture.binding, status: 'running' }, { ...sidecar, status: 'exited' }],
  };
  const recoveryEvents: string[] = [];
  assert.equal(await recoverPendingComputerLifecycle(
    fixture.state,
    fakeRuntime([mixed, running], recoveryEvents),
  ), true);
  assert.ok(recoveryEvents.includes(`docker:restart,${fixture.binding.id},${sidecar.id}`));
  assert.ok(recoveryEvents.includes('control:release'));
  await assert.rejects(stat(lifecycleJournalPath(fixture.state)), { code: 'ENOENT' });
});

test('interrupted absent start adopts only expected partial runtime evidence', async (context) => {
  const fixture = await lifecycleFixture();
  fixture.computer.image.contentId = fixture.binding.imageId;
  const interrupted = fakeRuntime([
    { group: 'absent', status: 'absent', containers: [] },
    { group: 'absent', status: 'absent', containers: [] },
  ], []);
  interrupted.startAbsent = async () => { throw new Error('simulated partial Compose start'); };
  await assert.rejects(
    startManagedComputer(fixture.state, fixture.computer, interrupted),
    /simulated partial Compose start/,
  );
  assert.equal((await inspectPendingComputerLifecycle(fixture.state))?.source, 'absent');

  const refusals: Array<{ name: string; observation: ManagedRuntimeGroupObservation; error: RegExp }> = [
    {
      name: 'unprovable ownership',
      observation: { group: 'inconsistent', status: 'running', containers: [] },
      error: /cannot prove partial runtime ownership/,
    },
    {
      name: 'unexpected image',
      observation: {
        group: 'partial',
        status: 'running',
        containers: [{ ...fixture.binding, imageId: `sha256:${'e'.repeat(64)}` }],
      },
      error: /unexpected image or status/,
    },
    {
      name: 'complete running group with an unexpected image',
      observation: complete('running', { ...fixture.binding, imageId: `sha256:${'e'.repeat(64)}` }),
      error: /unexpected image or status/,
    },
    {
      name: 'unsafe status',
      observation: {
        group: 'partial',
        status: 'removing',
        containers: [{ ...fixture.binding, status: 'removing' }],
      },
      error: /unexpected image or status/,
    },
  ];
  for (const refusal of refusals) {
    await context.test(refusal.name, async () => {
      let computerMutation = false;
      const runtime = fakeRuntime([refusal.observation], []);
      runtime.startAbsent = async () => { computerMutation = true; };
      runtime.docker = async () => { computerMutation = true; return ''; };
      await assert.rejects(recoverPendingComputerLifecycle(fixture.state, runtime), refusal.error);
      assert.equal(computerMutation, false);
      assert.equal((await inspectPendingComputerLifecycle(fixture.state))?.operation, 'start');
    });
  }

  const partial: ManagedRuntimeGroupObservation = {
    group: 'partial',
    status: 'running',
    containers: [{ ...fixture.binding, status: 'running' }],
  };
  const retainedFailure = fakeRuntime([partial], []);
  retainedFailure.startAbsent = async () => { throw new Error('Compose still unavailable'); };
  await assert.rejects(
    recoverPendingComputerLifecycle(fixture.state, retainedFailure),
    /Compose still unavailable/,
  );
  assert.equal((await inspectPendingComputerLifecycle(fixture.state))?.operation, 'start');

  const finalImageDriftEvents: string[] = [];
  const finalImageDrift = complete('running', {
    ...fixture.binding,
    imageId: `sha256:${'e'.repeat(64)}`,
  });
  await assert.rejects(
    recoverPendingComputerLifecycle(
      fixture.state,
      fakeRuntime([partial, finalImageDrift], finalImageDriftEvents),
    ),
    /unexpected image or status/,
  );
  assert.ok(finalImageDriftEvents.includes('start:absent'));
  assert.equal((await inspectPendingComputerLifecycle(fixture.state))?.operation, 'start');

  const sidecar = lifecycleSidecar(fixture.binding, 'd');
  const recoveryEvents: string[] = [];
  assert.equal(await recoverPendingComputerLifecycle(
    fixture.state,
    fakeRuntime([partial, complete('running', fixture.binding, sidecar)], recoveryEvents),
  ), true);
  assert.ok(recoveryEvents.includes('start:absent'));
  await assert.rejects(stat(lifecycleJournalPath(fixture.state)), { code: 'ENOENT' });
});

test('lifecycle journal rejects unsafe permissions and malformed fields without removal', async (context) => {
  await context.test('permissions', async () => {
    const fixture = await lifecycleFixture();
    await createInterruptedStartJournal(fixture);
    const path = lifecycleJournalPath(fixture.state);
    await chmod(path, 0o644);
    await assert.rejects(inspectPendingComputerLifecycle(fixture.state), /mode 0600/);
    assert.equal((await stat(path)).isFile(), true);
  });

  await context.test('unexpected field', async () => {
    const fixture = await lifecycleFixture();
    await createInterruptedStartJournal(fixture);
    const path = lifecycleJournalPath(fixture.state);
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    document.unexpected = true;
    await writeFile(path, `${JSON.stringify(document)}\n`);
    await assert.rejects(inspectPendingComputerLifecycle(fixture.state), /fields are invalid.*unexpected/);
    assert.equal((await stat(path)).isFile(), true);
  });
});

test('partial, inconsistent, absent, and identity-drift observations fail closed', async (context) => {
  const fixture = await lifecycleFixture();
  for (const group of ['partial', 'inconsistent'] as const) {
    await context.test(group, async () => {
      const events: string[] = [];
      const runtime = fakeRuntime([{ group, status: 'running', containers: [fixture.binding] }], events);
      await assert.rejects(startManagedComputer(fixture.state, fixture.computer, runtime), new RegExp(group));
      assert.ok(!events.some((event) => event.startsWith('docker:')));
    });
  }

  for (const operation of [stopManagedComputer, restartManagedComputer]) {
    const events: string[] = [];
    const runtime = fakeRuntime([{ group: 'absent', status: 'absent', containers: [] }], events);
    await assert.rejects(operation(fixture.state, fixture.computer, runtime), /no retained runtime/);
    assert.ok(!events.some((event) => event.startsWith('docker:')));
  }

  const driftEvents: string[] = [];
  const replacement = { ...fixture.binding, id: 'b'.repeat(64) };
  await assert.rejects(startManagedComputer(fixture.state, fixture.computer, fakeRuntime([
    complete('exited', fixture.binding),
    complete('exited', replacement),
  ], driftEvents)), /identity changed/);
  assert.ok(!driftEvents.some((event) => event.startsWith('docker:')));
});

function complete(status: string, ...bindings: RuntimeContainerBinding[]): ManagedRuntimeGroupObservation {
  return { group: 'complete', status, containers: bindings.map((binding) => ({ ...binding, status })) };
}

function lifecycleSidecar(primary: RuntimeContainerBinding, idCharacter: string): RuntimeContainerBinding {
  return {
    name: `${primary.name}-executor`,
    id: idCharacter.repeat(64),
    status: primary.status,
    imageId: primary.imageId,
    role: 'computer-executor',
  };
}

function lifecycleJournalPath(state: LoadedState): string {
  return join(state.paths.runtime, 'computer-lifecycle.json');
}

async function createInterruptedStartJournal(
  fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
): Promise<void> {
  const stopped = complete('exited', fixture.binding);
  const runtime = fakeRuntime([stopped, stopped], []);
  runtime.docker = async () => { throw new Error('create retained journal'); };
  await assert.rejects(startManagedComputer(fixture.state, fixture.computer, runtime), /create retained journal/);
}

function fakeRuntime(observations: ManagedRuntimeGroupObservation[], events: string[]): ComputerLifecycleRuntime {
  return {
    validateDocker: async () => { events.push('validate'); },
    observe: async () => {
      const observation = observations.shift();
      if (!observation) throw new Error('Unexpected observation.');
      events.push(`observe:${observation.status}`);
      return structuredClone(observation);
    },
    ensureImages: async (_state, computers) => { events.push(`ensure:${computers.map(({ id }) => id).join(',')}`); },
    render: async () => { events.push('render'); },
    startGateway: async () => { events.push('gateway:start'); },
    verifyGateway: async () => { events.push('gateway:verify'); },
    startAbsent: async () => { events.push('start:absent'); },
    docker: async (args) => { events.push(`docker:${(args[0] === 'network' ? args.slice(0, 2) : args).join(',')}`); return ''; },
    waitHealthy: async () => { events.push('healthy'); },
    waitGateway: async () => { events.push('route'); },
    synchronizePolicies: async () => { events.push('policies'); },
    releaseHumanControl: async () => { events.push('control:release'); },
  };
}

async function lifecycleFixture(): Promise<{
  state: LoadedState;
  computer: ComputerConfig;
  binding: RuntimeContainerBinding;
}> {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-lifecycle-operation-'));
  const config = defaultConfig('00000000-0000-4000-8000-000000000500');
  const computer = ComputerConfigSchema.parse({
    id: '00000000-0000-4000-8000-000000000501',
    name: 'strict-runtime',
    createdAt: '2026-09-07T12:00:00.000Z',
    ...config.defaults,
  });
  config.computers.push(computer);
  const secrets = defaultSecrets();
  secrets.computers[computer.id] = { token: `qubicl_${'t'.repeat(32)}`, internalKey: 'k'.repeat(32) };
  return {
    state: { paths: statePaths(root), config, secrets },
    computer,
    binding: {
      name: 'strict-runtime-container',
      id: 'a'.repeat(64),
      status: 'running',
      imageId: `sha256:${'c'.repeat(64)}`,
      role: 'computer',
      topologyVersion: '6',
    },
  };
}
