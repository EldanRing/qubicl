import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  TRANSACTION_FORMAT_VERSION,
  StateTransactionSchema,
  parseStateTransactionDocument,
  type ComputerConfig,
  type ComputerMetadata,
  type RuntimeContainerBinding,
  type StateTransaction,
  type TransactionCheckpoint,
  type TransactionOperation,
} from '@qubicl/core';
import {
  assertGatewayRuntimeBinding,
  ensureSystemImages,
  reconnectComputerAfterGateway,
  removeComputerRuntime,
  removeComputerRuntimeForLifecycleReplacement,
  removeGatewayRuntimeForLifecycleReplacement,
  replaceStoppedComputerRuntime,
  replaceStoppedGatewayRuntime,
  reconcileRuntimeImageContracts,
  startComputerAfterGateway,
  startGateway,
  verifyGatewayCompatibility,
  validateDocker,
  waitForGatewayComputerIfRunning,
  waitForGatewayRemoval,
} from './docker.js';
import { renderRuntime } from './runtime.js';
import { writeUpgradeBackup } from './migrations.js';
import {
  atomicWrite,
  durableRemove,
  durableRemoveDirectory,
  durableRename,
  saveMetadataInDirectory,
  saveState,
  type LoadedState,
  type StatePaths,
} from './state.js';

export type ActiveTransactionSource = 'active' | 'create' | 'trash' | 'staged';

export interface TransactionPlan {
  activeSources?: Readonly<Record<string, ActiveTransactionSource>>;
  trash?: ComputerMetadata[];
  runtime?: Partial<StateTransaction['runtime']>;
}

export interface TransactionRuntime {
  reconcileContracts(state: LoadedState): Promise<void>;
  validate(): Promise<void>;
  ensureImages(state: LoadedState): Promise<void>;
  startGateway(state: LoadedState, binding?: readonly RuntimeContainerBinding[], replace?: boolean): Promise<void>;
  replaceStoppedGateway(state: LoadedState, binding?: readonly RuntimeContainerBinding[]): Promise<void>;
  verifyGateway(state: LoadedState, skipComputerIds?: readonly string[]): Promise<void>;
  reconnect(state: LoadedState, computer: ComputerConfig): Promise<void>;
  waitForRemoval(state: LoadedState, id: string): Promise<void>;
  remove(state: LoadedState, id: string): Promise<void>;
  removeReplacement(state: LoadedState, computer: ComputerConfig, binding: readonly RuntimeContainerBinding[]): Promise<void>;
  replaceStopped(state: LoadedState, computer: ComputerConfig, binding: readonly RuntimeContainerBinding[]): Promise<void>;
  start(state: LoadedState, computer: ComputerConfig): Promise<void>;
  verifyToken(state: LoadedState, id: string, token: string): Promise<void>;
}

export interface TransactionOptions {
  includeRuntime?: boolean;
  checkpoint?: (checkpoint: TransactionCheckpoint, transaction: StateTransaction) => Promise<void> | void;
  runtime?: TransactionRuntime;
}

export const defaultTransactionRuntime: TransactionRuntime = {
  reconcileContracts: reconcileRuntimeImageContracts,
  validate: async () => { await validateDocker(); },
  ensureImages: (state) => ensureSystemImages(state, true),
  startGateway: async (state, binding, replace) => {
    if (replace) await removeGatewayRuntimeForLifecycleReplacement(state, binding ?? [], false);
    else if (binding?.length) await assertGatewayRuntimeBinding(state, binding);
    await startGateway(state);
  },
  replaceStoppedGateway: replaceStoppedGatewayRuntime,
  // A malformed or expired external TLS snapshot is fail-closed by the
  // gateway. Let the durable transaction finish only when the v0.2 gateway
  // explicitly reports that known-unavailable state, so `gateway revoke` or
  // renewal cannot be blocked behind an unrecoverable journal. Direct
  // lifecycle commands still treat external unavailability as an error.
  verifyGateway: (state, skipComputerIds) => verifyGatewayCompatibility(
    state,
    skipComputerIds,
    { allowUnavailableExposure: true },
  ),
  reconnect: reconnectComputerAfterGateway,
  waitForRemoval: waitForGatewayRemoval,
  remove: removeComputerRuntime,
  removeReplacement: (state, computer, binding) => removeComputerRuntimeForLifecycleReplacement(state, computer, binding, false),
  replaceStopped: replaceStoppedComputerRuntime,
  start: startComputerAfterGateway,
  verifyToken: waitForGatewayComputerIfRunning,
};

export function createStateTransaction(
  operation: TransactionOperation,
  state: LoadedState,
  plan: TransactionPlan = {},
): StateTransaction {
  const targetIds = new Set(state.config.computers.map(({ id }) => id));
  for (const id of Object.keys(plan.activeSources ?? {})) {
    if (!targetIds.has(id)) throw new Error(`Transaction source override references unknown computer ${id}.`);
  }
  const transaction = {
    version: TRANSACTION_FORMAT_VERSION,
    id: randomUUID(),
    operation,
    createdAt: new Date().toISOString(),
    phase: 'prepared' as const,
    config: structuredClone(state.config),
    secrets: structuredClone(state.secrets),
    active: state.config.computers.map((metadata) => ({
      source: plan.activeSources?.[metadata.id] ?? 'active' as const,
      metadata: structuredClone(metadata),
    })),
    trash: (plan.trash ?? []).map((metadata) => ({ metadata: structuredClone(metadata) })),
    runtime: {
      ensureImages: plan.runtime?.ensureImages ?? false,
      startGateway: plan.runtime?.startGateway ?? false,
      replaceGatewayRunning: plan.runtime?.replaceGatewayRunning ?? false,
      replaceGatewayStopped: plan.runtime?.replaceGatewayStopped ?? false,
      gatewayRuntimeBinding: structuredClone(plan.runtime?.gatewayRuntimeBinding ?? []),
      reconnectIds: [...(plan.runtime?.reconnectIds ?? [])],
      replaceIds: [...(plan.runtime?.replaceIds ?? [])],
      replaceStoppedIds: [...(plan.runtime?.replaceStoppedIds ?? [])],
      computerRuntimeBindings: structuredClone(plan.runtime?.computerRuntimeBindings ?? {}),
      startIds: [...(plan.runtime?.startIds ?? [])],
      removeIds: [...(plan.runtime?.removeIds ?? [])],
      verifyTokenIds: [...(plan.runtime?.verifyTokenIds ?? [])],
    },
  };
  return StateTransactionSchema.parse(transaction);
}

export async function executeStateTransaction(
  paths: StatePaths,
  transaction: StateTransaction,
  options: TransactionOptions = {},
): Promise<void> {
  await prepareStateTransaction(paths, transaction, options);
  await recoverPendingTransaction(paths, { ...options, includeRuntime: options.includeRuntime ?? true });
}

/** Durably reserve a transaction before callers perform recoverable staging work. */
export async function prepareStateTransaction(
  paths: StatePaths,
  transaction: StateTransaction,
  options: TransactionOptions = {},
): Promise<void> {
  if (await readPendingTransaction(paths)) throw new Error('A Qubicl transaction is already pending recovery.');
  await writeTransaction(paths, transaction);
  await checkpoint('journal-written', transaction, options);
}

export async function recoverPendingTransaction(paths: StatePaths, options: TransactionOptions = {}): Promise<boolean> {
  const transaction = await readPendingTransaction(paths);
  if (!transaction) return false;
  if (transaction.phase === 'prepared' && await rollbackIncompleteStaging(paths, transaction)) return true;
  const state: LoadedState = {
    paths,
    config: structuredClone(transaction.config),
    secrets: structuredClone(transaction.secrets),
  };
  const runtime = options.runtime ?? defaultTransactionRuntime;

  // Rendering is the first point at which a missing cache used to become an
  // implicit legacy viewer. Reconcile from immutable image/container evidence
  // before any durable state or runtime document is changed during recovery.
  await runtime.reconcileContracts(state);

  if (transaction.phase === 'prepared') {
    if (!(await realDirectoryExists(paths.computers)) || !(await realDirectoryExists(paths.trash))) {
      throw new Error('Qubicl active or trash state directories are missing.');
    }
    for (const entry of transaction.active) await ensureActiveDirectory(paths, entry.source, entry.metadata);
    await checkpoint('active-ready', transaction, options);
    await saveState(state, async () => checkpoint('config-written', transaction, options));
    await checkpoint('state-written', transaction, options);
    await renderRuntime(state);
    await checkpoint('runtime-rendered', transaction, options);
    for (const entry of transaction.trash) await ensureTrashDirectory(paths, entry.metadata);
    await checkpoint('trash-ready', transaction, options);
    transaction.phase = 'state-committed';
    await writeTransaction(paths, transaction);
    await checkpoint('state-committed', transaction, options);
  }

  if (!(options.includeRuntime ?? true) && transactionHasRuntimeWork(transaction)) return true;
  await completeRuntime(state, transaction, runtime, options);
  await checkpoint('runtime-committed', transaction, options);
  await durableRemove(paths.journal);
  return true;
}

function transactionHasRuntimeWork(transaction: StateTransaction): boolean {
  return transaction.runtime.ensureImages
    || transaction.runtime.startGateway
    || transaction.runtime.replaceGatewayStopped
    || transaction.runtime.reconnectIds.length > 0
    || transaction.runtime.replaceIds.length > 0
    || transaction.runtime.replaceStoppedIds.length > 0
    || transaction.runtime.startIds.length > 0
    || transaction.runtime.removeIds.length > 0
    || transaction.runtime.verifyTokenIds.length > 0;
}

export async function readPendingTransaction(paths: StatePaths): Promise<StateTransaction | undefined> {
  const pending = await readPendingTransactionDocument(paths);
  if (!pending) return undefined;
  const { contents, transaction, migrated, sourceVersion } = pending;
  if (migrated) {
    await writeUpgradeBackup(paths, {
      reason: 'lifecycle-journal',
      sourceVersion: sourceVersion ?? 2,
      targetVersion: TRANSACTION_FORMAT_VERSION,
      installationId: transaction.config.installationId,
      files: { 'transaction.yaml': contents },
    });
    await writeTransaction(paths, transaction);
  }
  return transaction;
}

/** Parse pending recovery state in memory without migrating or writing it. */
export async function inspectPendingTransaction(paths: StatePaths): Promise<StateTransaction | undefined> {
  return (await readPendingTransactionDocument(paths))?.transaction;
}

async function readPendingTransactionDocument(paths: StatePaths): Promise<{
  contents: string;
  transaction: StateTransaction;
  migrated: boolean;
  sourceVersion?: number;
} | undefined> {
  let info;
  try {
    info = await lstat(paths.journal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error(`Transaction journal ${paths.journal} is not a regular file.`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`Transaction journal ${paths.journal} must have mode 0600.`);
  let contents: string;
  try {
    contents = await readFile(paths.journal, 'utf8');
  } catch (error) {
    // A read-only observer may race locked recovery removing the completed
    // journal. Absence is the only safe conclusion; never recreate it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = parseStateTransactionDocument(YAML.parse(contents));
  return { contents, ...parsed };
}

async function writeTransaction(paths: StatePaths, transaction: StateTransaction): Promise<void> {
  await atomicWrite(paths.journal, YAML.stringify(StateTransactionSchema.parse(transaction)), 0o600);
}

async function ensureActiveDirectory(
  paths: StatePaths,
  source: ActiveTransactionSource,
  metadata: ComputerConfig,
): Promise<void> {
  const active = join(paths.computers, metadata.id);
  const trash = join(paths.trash, metadata.id);
  const [activeExists, trashExists] = await Promise.all([realDirectoryExists(active), realDirectoryExists(trash)]);
  if (activeExists && trashExists) throw new Error(`Computer ${metadata.id} exists in both active state and trash.`);

  if (source === 'create') {
    if (trashExists) throw new Error(`Cannot create computer ${metadata.id}; its ID already exists in trash.`);
    await saveMetadataInDirectory(active, metadata);
    return;
  }
  if (source === 'active') {
    if (!activeExists || trashExists) throw new Error(`Active computer directory ${active} is missing or conflicted.`);
    await saveMetadataInDirectory(active, metadata);
    return;
  }
  if (source === 'staged') {
    const staged = restoreStage(paths, metadata.id);
    if (trashExists) throw new Error(`Cannot restore backup ${metadata.id}; its ID already exists in trash.`);
    if (!activeExists) {
      if (!(await realDirectoryExists(staged)) || !(await realFileExists(restoreReadyMarker(paths, metadata.id)))) {
        throw new Error(`Backup restore staging for ${metadata.id} is incomplete.`);
      }
      await durableRename(staged, active);
    }
    await saveMetadataInDirectory(active, metadata);
    await durableRemove(join(active, '.qubicl-restore-ready'));
    return;
  }
  if (!activeExists && trashExists) await durableRename(trash, active);
  else if (!activeExists || trashExists) throw new Error(`Trashed computer ${metadata.id} cannot be restored safely.`);
  await saveMetadataInDirectory(active, metadata);
}

export function restoreStage(paths: StatePaths, id: string): string {
  return join(paths.runtime, 'restore-staging', id);
}

export function restoreReadyMarker(paths: StatePaths, id: string): string {
  return join(restoreStage(paths, id), '.qubicl-restore-ready');
}

async function rollbackIncompleteStaging(paths: StatePaths, transaction: StateTransaction): Promise<boolean> {
  for (const entry of transaction.active) {
    if (entry.source !== 'staged') continue;
    const active = join(paths.computers, entry.metadata.id);
    if (await realDirectoryExists(active)) continue;
    const marker = restoreReadyMarker(paths, entry.metadata.id);
    if (await realFileExists(marker)) continue;
    await durableRemoveDirectory(restoreStage(paths, entry.metadata.id));
    await durableRemove(paths.journal);
    return true;
  }
  return false;
}

async function ensureTrashDirectory(paths: StatePaths, metadata: ComputerMetadata & { deletedAt: string }): Promise<void> {
  const active = join(paths.computers, metadata.id);
  const trash = join(paths.trash, metadata.id);
  const [activeExists, trashExists] = await Promise.all([realDirectoryExists(active), realDirectoryExists(trash)]);
  if (activeExists && trashExists) throw new Error(`Computer ${metadata.id} exists in both active state and trash.`);
  if (!activeExists && !trashExists) throw new Error(`Computer directory ${metadata.id} disappeared before it could be trashed.`);
  if (activeExists) {
    await saveMetadataInDirectory(active, metadata);
    await durableRename(active, trash);
  } else {
    await saveMetadataInDirectory(trash, metadata);
  }
}

async function realDirectoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error(`${path} exists but is not a real directory.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function realFileExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`${path} exists but is not a regular file.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function completeRuntime(
  state: LoadedState,
  transaction: StateTransaction,
  runtime: TransactionRuntime,
  options: TransactionOptions,
): Promise<void> {
  const needsDocker = transaction.runtime.ensureImages
    || transaction.runtime.startGateway
    || transaction.runtime.replaceGatewayStopped
    || effectiveReconnectIds(transaction).length > 0
    || transaction.runtime.replaceIds.length > 0
    || transaction.runtime.replaceStoppedIds.length > 0
    || transaction.runtime.startIds.length > 0
    || transaction.runtime.removeIds.length > 0;
  if (needsDocker) {
    await runtime.validate();
    await checkpoint('docker-validated', transaction, options);
  }
  if (transaction.runtime.ensureImages) {
    await runtime.ensureImages(state);
    // Image inspection records the content-ID-bound viewer contract. Render
    // again before any runtime mutation so recovery cannot start a hardened
    // computer from the legacy route produced before image acquisition.
    await renderRuntime(state);
    await checkpoint('images-ready', transaction, options);
  }
  if (transaction.runtime.startGateway || effectiveReconnectIds(transaction).length > 0 || transaction.runtime.replaceIds.length > 0 || transaction.runtime.startIds.length > 0) {
    await runtime.startGateway(
      state,
      transaction.runtime.gatewayRuntimeBinding,
      transaction.runtime.replaceGatewayRunning,
    );
    await runtime.verifyGateway(state, transaction.runtime.replaceIds);
    await checkpoint('gateway-ready', transaction, options);
  }
  if (transaction.runtime.replaceGatewayStopped) {
    await runtime.replaceStoppedGateway(state, transaction.runtime.gatewayRuntimeBinding);
    await checkpoint('gateway-ready', transaction, options);
  }
  for (const id of transaction.runtime.removeIds) {
    await runtime.waitForRemoval(state, id);
    await checkpoint('routes-removed', transaction, options);
    await runtime.remove(state, id);
    await checkpoint('runtime-removed', transaction, options);
  }
  for (const id of effectiveReconnectIds(transaction)) {
    const computer = state.config.computers.find((candidate) => candidate.id === id)!;
    await runtime.reconnect(state, computer);
    await checkpoint('computers-started', transaction, options);
  }
  for (const id of transaction.runtime.replaceIds) {
    const computer = state.config.computers.find((candidate) => candidate.id === id)!;
    const binding = transaction.runtime.computerRuntimeBindings[id] ?? [];
    await runtime.removeReplacement(state, computer, binding);
    await checkpoint('runtime-removed', transaction, options);
    await runtime.start(state, computer);
    await checkpoint('computers-started', transaction, options);
  }
  for (const id of transaction.runtime.replaceStoppedIds) {
    const computer = state.config.computers.find((candidate) => candidate.id === id)!;
    await runtime.replaceStopped(state, computer, transaction.runtime.computerRuntimeBindings[id] ?? []);
    await checkpoint('runtime-removed', transaction, options);
    await checkpoint('computers-started', transaction, options);
  }
  for (const id of transaction.runtime.startIds) {
    if (legacyReconnectIds(transaction).includes(id)) continue;
    const computer = state.config.computers.find((candidate) => candidate.id === id)!;
    await runtime.start(state, computer);
    await checkpoint('computers-started', transaction, options);
  }
  for (const id of transaction.runtime.verifyTokenIds) {
    await runtime.verifyToken(state, id, state.secrets.computers[id]!.token);
    await checkpoint('routes-verified', transaction, options);
  }
}

function effectiveReconnectIds(transaction: StateTransaction): string[] {
  return [...new Set([...transaction.runtime.reconnectIds, ...legacyReconnectIds(transaction)])];
}

/**
 * Transactions written before reconnectIds existed represented gateway-only
 * reconnections as starts. Interpret those journals safely during recovery.
 * A setup-created computer remains a real start, identified by source=create.
 */
function legacyReconnectIds(transaction: StateTransaction): string[] {
  if (transaction.runtime.reconnectIds.length > 0) return [];
  if (transaction.operation === 'config') return transaction.runtime.startIds;
  if (transaction.operation !== 'setup') return [];
  const created = new Set(transaction.active.filter(({ source }) => source === 'create').map(({ metadata }) => metadata.id));
  return transaction.runtime.startIds.filter((id) => !created.has(id));
}

async function checkpoint(
  name: TransactionCheckpoint,
  transaction: StateTransaction,
  options: TransactionOptions,
): Promise<void> {
  await options.checkpoint?.(name, transaction);
  if (process.env.NODE_ENV === 'test' && process.env.QUBICL_TEST_FAIL_AFTER === name) {
    throw new Error(`Simulated transaction interruption after ${name}.`);
  }
}
