import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeContainerBindingSchema, type ComputerConfig, type RuntimeContainerBinding } from '@qubicl/core';
import {
  docker,
  ensureRuntimeImages,
  managedComputerRuntimeObservation,
  startComputerAfterGateway,
  startGateway,
  validateDocker,
  verifyGatewayCompatibility,
  waitForGatewayComputer,
  waitForHealthy,
  type ManagedRuntimeGroupObservation,
  type RunOptions,
} from './docker.js';
import { synchronizeStartedSkillPolicies } from './policy-commands.js';
import {
  controlNetwork,
  gatewayContainerName,
  renderRuntime,
} from './runtime.js';
import type { LoadedState } from './state.js';
import { atomicWrite, durableRemove } from './state.js';

export interface ComputerLifecycleRuntime {
  validateDocker(): Promise<unknown>;
  observe(state: LoadedState, computer: ComputerConfig): Promise<ManagedRuntimeGroupObservation>;
  ensureImages(state: LoadedState, computers: readonly ComputerConfig[]): Promise<void>;
  render(state: LoadedState): Promise<void>;
  startGateway(state: LoadedState): Promise<void>;
  verifyGateway(state: LoadedState): Promise<void>;
  startAbsent(state: LoadedState, computer: ComputerConfig): Promise<void>;
  docker(args: string[], options?: RunOptions): Promise<string>;
  waitHealthy(state: LoadedState, id: string): Promise<void>;
  waitGateway(state: LoadedState, id: string): Promise<void>;
  synchronizePolicies(state: LoadedState, computers: readonly ComputerConfig[]): Promise<void>;
  releaseHumanControl(state: LoadedState, computer: ComputerConfig): Promise<void>;
}

const defaultComputerLifecycleRuntime: ComputerLifecycleRuntime = {
  validateDocker,
  observe: managedComputerRuntimeObservation,
  ensureImages: (state, computers) => ensureRuntimeImages(state, computers),
  render: renderRuntime,
  startGateway,
  verifyGateway: verifyGatewayCompatibility,
  startAbsent: startComputerAfterGateway,
  docker,
  waitHealthy: waitForHealthy,
  waitGateway: waitForGatewayComputer,
  synchronizePolicies: synchronizeStartedSkillPolicies,
  releaseHumanControl: releaseComputerHumanControl,
};

export interface ComputerLifecycleJournal {
  version: 1;
  operationId: string;
  installationId: string;
  computerId: string;
  createdAt: string;
  operation: 'start' | 'stop' | 'restart';
  source: 'absent' | 'retained';
  runtimeContainers: RuntimeContainerBinding[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function computerLifecycleJournalPath(state: LoadedState): string {
  return join(state.paths.runtime, 'computer-lifecycle.json');
}

export async function inspectPendingComputerLifecycle(
  state: LoadedState,
): Promise<ComputerLifecycleJournal | undefined> {
  const journal = await readComputerLifecycleJournal(state);
  return journal ? structuredClone(journal) : undefined;
}

export async function recoverPendingComputerLifecycle(
  state: LoadedState,
  runtime: ComputerLifecycleRuntime = defaultComputerLifecycleRuntime,
): Promise<boolean> {
  const journal = await readComputerLifecycleJournal(state);
  if (!journal) return false;
  if (journal.installationId !== state.config.installationId) {
    throw new Error('Computer lifecycle journal belongs to another Qubicl installation and was preserved.');
  }
  const computer = state.config.computers.find(({ id }) => id === journal.computerId);
  if (!computer) {
    throw new Error(`Computer lifecycle recovery cannot find configured computer ${journal.computerId}; the journal was preserved.`);
  }

  await runtime.validateDocker();
  if (journal.operation === 'start' || journal.operation === 'restart') {
    await runtime.ensureImages(state, journal.source === 'absent' ? [computer] : []);
    await runtime.render(state);
    await runtime.startGateway(state);
    await runtime.verifyGateway(state);
  }
  const observed = await runtime.observe(state, computer);
  if (journal.source === 'retained') {
    assertRecoverableRetainedRuntime(computer, journal.runtimeContainers, observed);
  } else {
    assertRecoverableAbsentStart(computer, observed);
  }

  if (journal.operation === 'stop') {
    await runtime.docker(['stop', ...journal.runtimeContainers.map(({ id }) => id)]);
    await assertRecoveredRuntimeState(state, computer, journal, 'stopped', runtime);
  } else if (journal.operation === 'restart') {
    await runtime.docker(['restart', ...journal.runtimeContainers.map(({ id }) => id)]);
    await connectGatewayToComputer(state, computer, runtime);
    await runtime.waitHealthy(state, computer.id);
    await runtime.waitGateway(state, computer.id);
    await runtime.releaseHumanControl(state, computer);
    await assertRecoveredRuntimeState(state, computer, journal, 'running', runtime);
  } else if (journal.source === 'absent') {
    if (observed.group !== 'complete' || observed.status !== 'running') {
      await runtime.startAbsent(state, computer);
    }
    await assertRecoveredRuntimeState(state, computer, journal, 'running', runtime);
    await runtime.synchronizePolicies(state, [computer]);
  } else {
    await startRetainedRuntime(state, computer, journal.runtimeContainers, observed, runtime);
    await assertRecoveredRuntimeState(state, computer, journal, 'running', runtime);
    await runtime.synchronizePolicies(state, [computer]);
  }
  await clearComputerLifecycleJournal(state, journal.operationId);
  return true;
}

export async function startManagedComputer(
  state: LoadedState,
  computer: ComputerConfig,
  runtime: ComputerLifecycleRuntime = defaultComputerLifecycleRuntime,
): Promise<void> {
  await assertNoPendingComputerLifecycle(state);
  await runtime.validateDocker();
  const observed = await runtime.observe(state, computer);
  assertLifecycleGroup(computer, observed, true, 'start');
  const absent = observed.group === 'absent';
  await runtime.ensureImages(state, absent ? [computer] : []);
  await runtime.render(state);
  await runtime.startGateway(state);
  await runtime.verifyGateway(state);
  if (absent) {
    const current = await runtime.observe(state, computer);
    if (current.group !== 'absent' || current.status !== 'absent') {
      throw new Error(`Computer ${computer.name} runtime appeared while preparing to start; no computer container was changed.`);
    }
    const journal = await beginComputerLifecycle(state, computer, 'start', 'absent', []);
    await runtime.startAbsent(state, computer);
    await assertRecoveredRuntimeState(state, computer, journal, 'running', runtime);
    await runtime.synchronizePolicies(state, [computer]);
    await clearComputerLifecycleJournal(state, journal.operationId);
    return;
  } else {
    const retained = await requireUnchangedRuntime(state, computer, observed.containers, runtime, 'start');
    if (retained.status === 'paused' || retained.status === 'exited' || retained.status === 'created') {
      const journal = await beginComputerLifecycle(state, computer, 'start', 'retained', retained.containers);
      await startRetainedRuntime(state, computer, journal.runtimeContainers, retained, runtime);
      await assertRecoveredRuntimeState(state, computer, journal, 'running', runtime);
      await runtime.synchronizePolicies(state, [computer]);
      await clearComputerLifecycleJournal(state, journal.operationId);
      return;
    }
    await connectGatewayToComputer(state, computer, runtime);
    await runtime.waitHealthy(state, computer.id);
    await runtime.waitGateway(state, computer.id);
  }
  await runtime.synchronizePolicies(state, [computer]);
}

export async function stopManagedComputer(
  state: LoadedState,
  computer: ComputerConfig,
  runtime: ComputerLifecycleRuntime = defaultComputerLifecycleRuntime,
): Promise<void> {
  await assertNoPendingComputerLifecycle(state);
  await runtime.validateDocker();
  const observed = await runtime.observe(state, computer);
  assertLifecycleGroup(computer, observed, false, 'stop');
  if (observed.status === 'exited' || observed.status === 'created') return;
  const journal = await beginComputerLifecycle(state, computer, 'stop', 'retained', observed.containers);
  await runtime.docker(['stop', ...observed.containers.map(({ id }) => id)]);
  const stopped = await runtime.observe(state, computer);
  assertLifecycleGroup(computer, stopped, false, 'verify stop');
  if (!sameRuntimeBindings(journal.runtimeContainers, stopped.containers)
    || (stopped.status !== 'exited' && stopped.status !== 'created')) {
    throw new Error(`Computer ${computer.name} remained ${stopped.status} after Docker reported a successful stop.`);
  }
  await clearComputerLifecycleJournal(state, journal.operationId);
}

export async function restartManagedComputer(
  state: LoadedState,
  computer: ComputerConfig,
  runtime: ComputerLifecycleRuntime = defaultComputerLifecycleRuntime,
): Promise<void> {
  await assertNoPendingComputerLifecycle(state);
  await runtime.validateDocker();
  const observed = await runtime.observe(state, computer);
  if (observed.group === 'absent' && observed.status === 'absent') {
    throw new Error(`Computer ${computer.name} has no retained runtime to restart. Use qubicl start ${computer.name}; recreating it requires its exact pinned image ${computer.image.resolved}.`);
  }
  assertLifecycleGroup(computer, observed, false, 'restart');
  await runtime.ensureImages(state, []);
  await runtime.render(state);
  await runtime.startGateway(state);
  await runtime.verifyGateway(state);
  const retained = await requireUnchangedRuntime(state, computer, observed.containers, runtime, 'restart');
  const journal = await beginComputerLifecycle(state, computer, 'restart', 'retained', retained.containers);
  await runtime.docker(['restart', ...retained.containers.map(({ id }) => id)]);
  await connectGatewayToComputer(state, computer, runtime);
  await runtime.waitHealthy(state, computer.id);
  await runtime.waitGateway(state, computer.id);
  await runtime.releaseHumanControl(state, computer);
  await assertRecoveredRuntimeState(state, computer, journal, 'running', runtime);
  await clearComputerLifecycleJournal(state, journal.operationId);
}

function assertLifecycleGroup(
  computer: ComputerConfig,
  observation: ManagedRuntimeGroupObservation,
  allowAbsent: boolean,
  operation: string,
): void {
  if (observation.group === 'partial' || observation.group === 'inconsistent') {
    throw new Error(`Computer ${computer.name} runtime group is ${observation.group}; refusing to ${operation} an ambiguous runtime.`);
  }
  if (observation.group === 'absent') {
    if (allowAbsent && observation.status === 'absent') return;
    if (observation.status !== 'absent') {
      throw new Error(`Computer ${computer.name} runtime group is absent but reports status ${observation.status}.`);
    }
    throw new Error(`Computer ${computer.name} has no retained runtime to ${operation}.`);
  }
  if (!['running', 'restarting', 'paused', 'exited', 'created'].includes(observation.status)) {
    throw new Error(`Computer ${computer.name} runtime status ${observation.status} cannot be changed safely.`);
  }
}

async function requireUnchangedRuntime(
  state: LoadedState,
  computer: ComputerConfig,
  expected: readonly RuntimeContainerBinding[],
  runtime: ComputerLifecycleRuntime,
  operation: string,
): Promise<ManagedRuntimeGroupObservation & { group: 'complete' }> {
  const current = await runtime.observe(state, computer);
  assertLifecycleGroup(computer, current, false, operation);
  if (current.group !== 'complete' || !sameRuntimeBindings(expected, current.containers)) {
    throw new Error(`Computer ${computer.name} runtime identity changed while preparing to ${operation}; no computer container was changed.`);
  }
  return current as ManagedRuntimeGroupObservation & { group: 'complete' };
}

function sameRuntimeBindings(left: readonly RuntimeContainerBinding[], right: readonly RuntimeContainerBinding[]): boolean {
  if (left.length !== right.length) return false;
  const actual = new Map(right.map((binding) => [binding.id, binding]));
  return left.every((expected) => {
    const current = actual.get(expected.id);
    return current?.name === expected.name
      && current.imageId === expected.imageId
      && current.role === expected.role
      && current.topologyVersion === expected.topologyVersion;
  });
}

async function beginComputerLifecycle(
  state: LoadedState,
  computer: ComputerConfig,
  operation: ComputerLifecycleJournal['operation'],
  source: ComputerLifecycleJournal['source'],
  runtimeContainers: readonly RuntimeContainerBinding[],
): Promise<ComputerLifecycleJournal> {
  const pending = await readComputerLifecycleJournal(state);
  if (pending) {
    throw new Error(`Computer lifecycle ${pending.operationId} requires explicit recovery before another lifecycle mutation.`);
  }
  const journal: ComputerLifecycleJournal = {
    version: 1,
    operationId: randomUUID(),
    installationId: state.config.installationId,
    computerId: computer.id,
    createdAt: new Date().toISOString(),
    operation,
    source,
    runtimeContainers: structuredClone([...runtimeContainers]),
  };
  await writeComputerLifecycleJournal(state, journal);
  return journal;
}

async function assertNoPendingComputerLifecycle(state: LoadedState): Promise<void> {
  const pending = await readComputerLifecycleJournal(state);
  if (pending) {
    throw new Error(`Computer lifecycle ${pending.operationId} requires explicit recovery before another lifecycle mutation.`);
  }
}

async function writeComputerLifecycleJournal(
  state: LoadedState,
  journal: ComputerLifecycleJournal,
): Promise<void> {
  await atomicWrite(computerLifecycleJournalPath(state), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

async function readComputerLifecycleJournal(state: LoadedState): Promise<ComputerLifecycleJournal | undefined> {
  const path = computerLifecycleJournalPath(state);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o777) !== 0o600) {
    throw new Error(`Computer lifecycle journal ${path} must be a regular operator-owned file with mode 0600.`);
  }
  return parseComputerLifecycleJournal(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function parseComputerLifecycleJournal(value: unknown): ComputerLifecycleJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Computer lifecycle journal must be an object.');
  }
  const record = value as Record<string, unknown>;
  const expected = new Set([
    'computerId', 'createdAt', 'installationId', 'operation', 'operationId', 'runtimeContainers', 'source', 'version',
  ]);
  const unexpected = Object.keys(record).filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !(key in record));
  if (unexpected.length || missing.length) {
    throw new Error(`Computer lifecycle journal fields are invalid${unexpected.length ? `; unexpected: ${unexpected.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`);
  }
  if (record.version !== 1) throw new Error('Computer lifecycle journal has an unsupported version.');
  const operationId = lifecycleUuid(record.operationId, 'operation ID');
  const installationId = lifecycleUuid(record.installationId, 'installation ID');
  const computerId = lifecycleUuid(record.computerId, 'computer ID');
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error('Computer lifecycle journal has an invalid creation timestamp.');
  }
  if (!['start', 'stop', 'restart'].includes(String(record.operation))) {
    throw new Error('Computer lifecycle journal has an invalid operation.');
  }
  if (!['absent', 'retained'].includes(String(record.source))) {
    throw new Error('Computer lifecycle journal has an invalid source state.');
  }
  if (!Array.isArray(record.runtimeContainers)) {
    throw new Error('Computer lifecycle journal has invalid runtime containers.');
  }
  const runtimeContainers = record.runtimeContainers.map((entry) => RuntimeContainerBindingSchema.parse(entry));
  const source = record.source as ComputerLifecycleJournal['source'];
  const operation = record.operation as ComputerLifecycleJournal['operation'];
  if ((source === 'absent' && (operation !== 'start' || runtimeContainers.length !== 0))
    || (source === 'retained' && runtimeContainers.length === 0)) {
    throw new Error('Computer lifecycle journal source state does not match its operation or immutable bindings.');
  }
  if (new Set(runtimeContainers.map(({ id }) => id)).size !== runtimeContainers.length
    || new Set(runtimeContainers.map(({ name }) => name)).size !== runtimeContainers.length) {
    throw new Error('Computer lifecycle journal runtime bindings must have unique IDs and names.');
  }
  return {
    version: 1,
    operationId,
    installationId,
    computerId,
    createdAt: record.createdAt,
    operation,
    source,
    runtimeContainers,
  };
}

function lifecycleUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`Computer lifecycle journal has an invalid ${label}.`);
  }
  return value;
}

async function clearComputerLifecycleJournal(state: LoadedState, operationId: string): Promise<void> {
  const pending = await readComputerLifecycleJournal(state);
  if (!pending || pending.operationId !== operationId) {
    throw new Error('Computer lifecycle journal changed while the operation was running.');
  }
  await durableRemove(computerLifecycleJournalPath(state));
}

function assertRecoverableRetainedRuntime(
  computer: ComputerConfig,
  expected: readonly RuntimeContainerBinding[],
  observation: ManagedRuntimeGroupObservation,
): void {
  if (!sameRuntimeBindings(expected, observation.containers)) {
    throw new Error(`Computer lifecycle recovery found changed or missing immutable runtime IDs for ${computer.name}; no container was changed.`);
  }
  const unsafe = observation.containers.find(({ status }) => !['running', 'restarting', 'paused', 'exited', 'created'].includes(status));
  if (unsafe) {
    throw new Error(`Computer lifecycle recovery found ${unsafe.name} in unsafe status ${unsafe.status}; no container was changed.`);
  }
}

function assertRecoverableAbsentStart(
  computer: ComputerConfig,
  observation: ManagedRuntimeGroupObservation,
): void {
  if (observation.group === 'absent' && observation.status === 'absent') return;
  if (observation.containers.length === 0 || !computer.image.contentId) {
    throw new Error(`Computer lifecycle recovery cannot prove partial runtime ownership for absent-start ${computer.name}; no container was changed.`);
  }
  const unsafe = observation.containers.find(({ imageId, status }) => imageId !== computer.image.contentId
    || !['running', 'restarting', 'paused', 'exited', 'created'].includes(status));
  if (unsafe) {
    throw new Error(`Computer lifecycle recovery found an unexpected image or status for ${unsafe.name}; no container was changed.`);
  }
}

async function startRetainedRuntime(
  state: LoadedState,
  computer: ComputerConfig,
  expected: readonly RuntimeContainerBinding[],
  observation: ManagedRuntimeGroupObservation,
  runtime: ComputerLifecycleRuntime,
): Promise<void> {
  assertRecoverableRetainedRuntime(computer, expected, observation);
  const current = new Map(observation.containers.map((binding) => [binding.id, binding]));
  const paused = expected.filter(({ id }) => current.get(id)?.status === 'paused').map(({ id }) => id);
  if (paused.length) await runtime.docker(['unpause', ...paused]);
  const stopped = expected.toReversed()
    .filter(({ id }) => ['exited', 'created'].includes(current.get(id)?.status ?? ''))
    .map(({ id }) => id);
  if (stopped.length) await runtime.docker(['start', ...stopped]);
  await connectGatewayToComputer(state, computer, runtime);
  await runtime.waitHealthy(state, computer.id);
  await runtime.waitGateway(state, computer.id);
}

async function assertRecoveredRuntimeState(
  state: LoadedState,
  computer: ComputerConfig,
  journal: ComputerLifecycleJournal,
  expected: 'running' | 'stopped',
  runtime: ComputerLifecycleRuntime,
): Promise<void> {
  const observation = await runtime.observe(state, computer);
  if (observation.group !== 'complete'
    || (expected === 'running'
      ? observation.status !== 'running'
      : observation.status !== 'exited' && observation.status !== 'created')) {
    throw new Error(`Computer lifecycle recovery expected ${computer.name} ${expected}, but found ${observation.group}/${observation.status}; the journal was preserved.`);
  }
  if (journal.source === 'retained' && !sameRuntimeBindings(journal.runtimeContainers, observation.containers)) {
    throw new Error(`Computer lifecycle recovery found changed immutable runtime IDs for ${computer.name}; the journal was preserved.`);
  }
  if (journal.source === 'absent') assertRecoverableAbsentStart(computer, observation);
}

async function connectGatewayToComputer(
  state: LoadedState,
  computer: ComputerConfig,
  runtime: ComputerLifecycleRuntime,
): Promise<void> {
  try {
    await runtime.docker([
      'network',
      'connect',
      controlNetwork(state.config.installationId, computer.id, state.paths.root),
      gatewayContainerName(state.config.installationId, state.paths.root),
    ]);
  } catch (error) {
    if (!errorMessage(error).includes('already exists in network')) throw error;
  }
}

export async function releaseComputerHumanControl(state: LoadedState, computer: ComputerConfig): Promise<void> {
  const secret = state.secrets.computers[computer.id];
  if (!secret) throw new Error(`Missing secret material for ${computer.name}.`);
  const response = await fetch(
    `http://127.0.0.1:${state.config.gateway.port}/computers/${computer.id}/operator/human-control/release`,
    { method: 'POST', headers: { 'x-qubicl-operator-key': secret.internalKey }, signal: AbortSignal.timeout(5000), redirect: 'error' },
  ).catch((error: unknown) => {
    throw new Error(`Could not reach the Qubicl gateway to release human control: ${errorMessage(error)}`);
  });
  if (response.ok) return;
  const detail = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  throw new Error(detail?.error?.message ?? `Gateway returned HTTP ${response.status} while releasing human control.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
