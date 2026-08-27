import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import {
  ConfigSchema,
  SecretsSchema,
  assertStateComputerIdsMatch,
  defaultConfig,
  defaultSecrets,
  parseComputerMetadataDocument,
  parseStateTransactionDocument,
  type ComputerMetadata,
  type QubiclConfig,
  type QubiclSecrets,
} from '@qubicl/core';

export interface StatePaths {
  root: string;
  config: string;
  secrets: string;
  computers: string;
  audits: string;
  trash: string;
  runtime: string;
  compose: string;
  routes: string;
  lock: string;
  journal: string;
  migration: string;
  runtimeMigration: string;
  runtimeNamespacePending: string;
  preferences: string;
  backups: string;
}

export interface LoadedState {
  paths: StatePaths;
  config: QubiclConfig;
  secrets: QubiclSecrets;
}

export interface StateAuditCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export function statePaths(root = process.env.QUBICL_HOME ?? join(homedir(), '.qubicl')): StatePaths {
  return {
    root,
    config: join(root, 'config.yaml'),
    secrets: join(root, 'secrets.yaml'),
    computers: join(root, 'computers'),
    audits: join(root, 'audits'),
    trash: join(root, 'trash'),
    runtime: join(root, 'runtime'),
    compose: join(root, 'runtime', 'compose.yaml'),
    routes: join(root, 'runtime', 'routes.json'),
    lock: join(root, 'runtime', 'cli.lock'),
    journal: join(root, 'transaction.yaml'),
    migration: join(root, 'state-migration.yaml'),
    runtimeMigration: join(root, 'runtime', 'legacy-runtime-migration.json'),
    runtimeNamespacePending: join(root, 'runtime', 'legacy-runtime-namespace.pending'),
    preferences: join(root, 'runtime', 'preferences.json'),
    backups: join(root, 'backups'),
  };
}

export async function initializeState(paths = statePaths()): Promise<LoadedState> {
  await prepareStateDirectories(paths);
  const config = await readYamlIfExists(paths.config, ConfigSchema, defaultConfig());
  const secrets = await readYamlIfExists(paths.secrets, SecretsSchema, defaultSecrets());
  await saveState({ paths, config, secrets });
  return { paths, config, secrets };
}

export async function prepareStateDirectories(paths = statePaths()): Promise<void> {
  await ensureSecureDirectory(paths.root);
  await Promise.all([
    ensureSecureDirectory(paths.computers),
    ensureSecureDirectory(paths.audits),
    ensureSecureDirectory(paths.trash),
    ensureSecureDirectory(paths.runtime),
    ensureSecureDirectory(paths.backups),
  ]);
}

export async function loadState(paths = statePaths()): Promise<LoadedState> {
  const config = ConfigSchema.parse(YAML.parse(await readFile(paths.config, 'utf8')));
  const secrets = SecretsSchema.parse(YAML.parse(await readFile(paths.secrets, 'utf8')));
  assertStateComputerIdsMatch(config, secrets);
  return { paths, config, secrets };
}

export async function saveState(state: LoadedState, afterConfig?: () => Promise<void>): Promise<void> {
  assertStateComputerIdsMatch(state.config, state.secrets);
  await atomicWrite(state.paths.config, YAML.stringify(state.config), 0o600);
  await afterConfig?.();
  await atomicWrite(state.paths.secrets, YAML.stringify(state.secrets), 0o600);
  await chmod(state.paths.secrets, 0o600);
}

export async function saveMetadata(paths: StatePaths, metadata: ComputerMetadata): Promise<void> {
  await saveMetadataInDirectory(join(paths.computers, metadata.id), metadata);
}

export async function saveMetadataInDirectory(directory: string, metadata: ComputerMetadata): Promise<void> {
  await ensureSecureDirectory(directory);
  await ensureSecureDirectory(join(directory, 'home'));
  await ensureSecureDirectory(join(directory, 'home', 'qubicl'));
  await atomicWrite(join(directory, 'metadata.yaml'), YAML.stringify(metadata), 0o600);
}

export async function readMetadata(path: string): Promise<ComputerMetadata> {
  return parseComputerMetadataDocument(YAML.parse(await readFile(path, 'utf8'))).metadata;
}

export async function findTrash(paths: StatePaths, name: string): Promise<{ directory: string; metadata: ComputerMetadata }> {
  const entries = await readdir(paths.trash, { withFileTypes: true });
  const found: Array<{ directory: string; metadata: ComputerMetadata }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(paths.trash, entry.name);
    try {
      const metadata = await readMetadata(join(directory, 'metadata.yaml'));
      if (metadata.name === name || metadata.id === name) found.push({ directory, metadata });
    } catch { /* ignore malformed unrelated trash entries */ }
  }
  if (!found.length) throw new Error(`No trashed computer named ${name}.`);
  if (found.length > 1) throw new Error(`Multiple trashed computers are named ${name}; use an immutable ID.`);
  return found[0]!;
}

export async function auditState(state: LoadedState): Promise<StateAuditCheck[]> {
  const checks: StateAuditCheck[] = [];
  checks.push(await secureDirectoryCheck('state-root-directory', state.paths.root, 0o700));
  checks.push(await regularFileCheck('state-config-file', state.paths.config, 0o600));
  checks.push(await regularFileCheck('state-secrets-file', state.paths.secrets, 0o600));
  checks.push(await secureDirectoryCheck('state-computers-directory', state.paths.computers, 0o700));
  checks.push(await secureDirectoryCheck('state-audits-directory', state.paths.audits, 0o700));
  checks.push(await secureDirectoryCheck('state-trash-directory', state.paths.trash, 0o700));
  checks.push(await secureDirectoryCheck('state-backup-directory', state.paths.backups, 0o700));
  checks.push(await secureDirectoryCheck('state-runtime-directory', state.paths.runtime, 0o700));
  checks.push(await regularFileCheck('state-runtime-compose', state.paths.compose, 0o600));
  checks.push(await regularFileCheck('state-runtime-routes', state.paths.routes, 0o600));
  checks.push(await journalCheck(state.paths.journal));
  checks.push(await absentFileCheck('state-migration-journal', state.paths.migration, 'no pending state migration'));
  checks.push(await absentFileCheck('runtime-namespace-migration-journal', state.paths.runtimeMigration, 'no pending legacy runtime migration'));
  checks.push(await absentFileCheck('runtime-namespace-migration-marker', state.paths.runtimeNamespacePending, 'no pending legacy runtime namespace migration'));

  const activeIds = new Set(state.config.computers.map(({ id }) => id));
  const secretIds = new Set(Object.keys(state.secrets.computers));
  const missingSecrets = [...activeIds].filter((id) => !secretIds.has(id)).sort();
  const orphanSecrets = [...secretIds].filter((id) => !activeIds.has(id)).sort();
  checks.push({
    check: 'state-secret-index',
    ok: missingSecrets.length === 0 && orphanSecrets.length === 0,
    detail: missingSecrets.length || orphanSecrets.length
      ? `missing for IDs: ${missingSecrets.join(', ') || 'none'}; orphan IDs: ${orphanSecrets.join(', ') || 'none'}`
      : `${activeIds.size} computer secret entr${activeIds.size === 1 ? 'y' : 'ies'} matched`,
  });

  const activeEntries = await directoryEntries(state.paths.computers);
  if (activeEntries instanceof Error) {
    checks.push({ check: 'state-computer-index', ok: false, detail: activeEntries.message });
  } else {
    const unexpected = activeEntries.map(({ name }) => name).filter((name) => !activeIds.has(name)).sort();
    checks.push({
      check: 'state-computer-index',
      ok: unexpected.length === 0,
      detail: unexpected.length ? `untracked entries: ${unexpected.join(', ')}` : `${activeIds.size} active computer director${activeIds.size === 1 ? 'y' : 'ies'} tracked`,
    });
  }

  for (const computer of [...state.config.computers].sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = join(state.paths.computers, computer.id);
    const directoryResult = await secureDirectoryCheck(`computer-${computer.name}-directory`, directory, 0o700);
    checks.push(directoryResult);
    if (!directoryResult.ok) continue;
    checks.push(await activeMetadataCheck(`computer-${computer.name}-metadata`, join(directory, 'metadata.yaml'), computer));
    checks.push(await secureDirectoryCheck(`computer-${computer.name}-home`, join(directory, 'home'), 0o700));
    checks.push(await secureDirectoryCheck(`computer-${computer.name}-user-home`, join(directory, 'home', 'qubicl'), 0o700));
    checks.push(await absentFileCheck(`computer-${computer.name}-ownership-repair`, join(directory, 'ownership-repair.json'), 'no pending ownership repair'));
  }

  const trashEntries = await directoryEntries(state.paths.trash);
  if (trashEntries instanceof Error) {
    checks.push({ check: 'state-trash-index', ok: false, detail: trashEntries.message });
  } else {
    checks.push({ check: 'state-trash-index', ok: true, detail: `${trashEntries.length} trashed computer entr${trashEntries.length === 1 ? 'y' : 'ies'}` });
    for (const entry of trashEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      const directory = join(state.paths.trash, entry.name);
      const directoryResult = await secureDirectoryCheck(`trash-${entry.name}-directory`, directory, 0o700);
      checks.push(directoryResult);
      if (!directoryResult.ok) continue;
      checks.push(await trashMetadataCheck(`trash-${entry.name}-metadata`, join(directory, 'metadata.yaml'), entry.name, activeIds));
      checks.push(await secureDirectoryCheck(`trash-${entry.name}-home`, join(directory, 'home'), 0o700));
      checks.push(await secureDirectoryCheck(`trash-${entry.name}-user-home`, join(directory, 'home', 'qubicl'), 0o700));
    }
  }

  return checks;
}

export async function withStateLock<T>(paths: StatePaths, action: () => Promise<T>): Promise<T> {
  await ensureSecureDirectory(paths.root);
  await ensureSecureDirectory(dirname(paths.lock));
  const owner = await acquireStateLock(paths.lock);
  try {
    return await action();
  } finally {
    await releaseOwnedStateLock(paths.lock, owner);
  }
}

export function newSecret(): { token: string; internalKey: string } {
  return {
    token: `qubicl_${randomBytes(32).toString('base64url')}`,
    internalKey: randomBytes(32).toString('base64url'),
  };
}

export async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, mode);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

export async function durableRemove(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

export async function durableRemoveDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await syncDirectory(dirname(path));
}

export async function durableRename(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  await syncDirectory(dirname(source));
  if (dirname(destination) !== dirname(source)) await syncDirectory(dirname(destination));
}

// Docker Desktop can cache the inode of a bind-mounted file. Runtime readers
// validate a complete snapshot before swapping state, so preserving the inode
// is both portable and atomic at the application-state boundary.
export async function writeMountedRuntimeFile(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, contents, { mode });
    await chmod(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await atomicWrite(path, contents, mode);
  }
}

async function readYamlIfExists<T>(path: string, schema: { parse(value: unknown): T }, fallback: T): Promise<T> {
  try { return schema.parse(YAML.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

interface StateLockOwner {
  handle: FileHandle;
  nonce: string;
  dev: number;
  ino: number;
}

interface StateLockSnapshot {
  dev: number;
  ino: number;
  nonce?: string;
}

async function acquireStateLock(path: string): Promise<StateLockOwner> {
  try {
    return await createOwnedStateLock(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const observed = await staleStateLock(path);
  if (!observed) return createOwnedStateLock(path);

  const reclaimerPath = `${path}.reclaim`;
  let reclaimer: StateLockOwner;
  try {
    reclaimer = await createOwnedStateLock(reclaimerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another Qubicl command is reclaiming a stale state lock; retry shortly.');
    }
    throw error;
  }

  try {
    const current = await staleStateLock(path);
    if (current && !(await removeStateLockIfMatches(path, current))) {
      throw new Error('The Qubicl state lock changed while it was being reclaimed; retry shortly.');
    }
    try {
      return await createOwnedStateLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Another Qubicl command acquired the state lock; retry shortly.');
      }
      throw error;
    }
  } finally {
    await releaseOwnedStateLock(reclaimerPath, reclaimer);
  }
}

async function createOwnedStateLock(path: string): Promise<StateLockOwner> {
  const nonce = randomBytes(24).toString('base64url');
  const handle = await open(path, 'wx', 0o600);
  let identity: StateLockSnapshot | undefined;
  try {
    const info = await handle.stat();
    identity = { dev: info.dev, ino: info.ino };
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), nonce }));
    await handle.sync();
    return { handle, nonce, dev: info.dev, ino: info.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (identity) await removeStateLockIfMatches(path, identity).catch(() => false);
    throw error;
  }
}

async function releaseOwnedStateLock(path: string, owner: StateLockOwner): Promise<void> {
  await owner.handle.close();
  await removeStateLockIfMatches(path, owner);
}

async function staleStateLock(path: string): Promise<StateLockSnapshot | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error(`${path} exists but is not a regular lock file.`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (info.uid !== uid) throw new Error(`${path} is owned by UID ${info.uid}, not current UID ${uid}.`);

  let record: { pid?: unknown; nonce?: unknown };
  try {
    record = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown; nonce?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (Date.now() - info.mtimeMs < 30_000) {
      throw new Error('Another Qubicl command may be starting; retry shortly.');
    }
    return { dev: info.dev, ino: info.ino };
  }

  if (typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0) {
    if (processAlive(record.pid)) throw new Error(`Another Qubicl command is running (PID ${record.pid}).`);
    return {
      dev: info.dev,
      ino: info.ino,
      ...(typeof record.nonce === 'string' ? { nonce: record.nonce } : {}),
    };
  }
  if (Date.now() - info.mtimeMs < 30_000) {
    throw new Error('Another Qubicl command may be starting; retry shortly.');
  }
  return {
    dev: info.dev,
    ino: info.ino,
    ...(typeof record.nonce === 'string' ? { nonce: record.nonce } : {}),
  };
}

async function removeStateLockIfMatches(path: string, expected: StateLockSnapshot): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) return false;
  if (expected.nonce !== undefined) {
    try {
      const record = JSON.parse(await readFile(path, 'utf8')) as { nonce?: unknown };
      if (record.nonce !== expected.nonce) return false;
    } catch {
      return false;
    }
  }
  await rm(path, { force: true });
  return true;
}

export async function syncDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function journalCheck(path: string): Promise<StateAuditCheck> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { check: 'state-transaction-journal', ok: false, detail: `${path} is not a regular file` };
    if ((info.mode & 0o777) !== 0o600) return { check: 'state-transaction-journal', ok: false, detail: `${path} has mode 0${(info.mode & 0o777).toString(8)}; expected 0600` };
    const { transaction } = parseStateTransactionDocument(YAML.parse(await readFile(path, 'utf8')));
    return { check: 'state-transaction-journal', ok: false, detail: `${transaction.operation} transaction ${transaction.id} is ${transaction.phase} and awaiting recovery` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { check: 'state-transaction-journal', ok: true, detail: 'no pending transaction' };
    return { check: 'state-transaction-journal', ok: false, detail: `${path}: ${errorMessage(error)}` };
  }
}

async function ensureSecureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`${path} exists but is not a real directory.`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (info.uid !== uid) throw new Error(`${path} is owned by UID ${info.uid}, not current UID ${uid}.`);
  await chmod(path, 0o700);
}

async function regularFileCheck(check: string, path: string, exactMode?: number): Promise<StateAuditCheck> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { check, ok: false, detail: `${path} is not a regular file` };
    if (exactMode !== undefined && (info.mode & 0o777) !== exactMode) {
      return { check, ok: false, detail: `${path} has mode 0${(info.mode & 0o777).toString(8)}; expected 0${exactMode.toString(8)}` };
    }
    return { check, ok: true, detail: exactMode === undefined ? path : `${path} mode 0${exactMode.toString(8)}` };
  } catch (error) {
    return { check, ok: false, detail: `${path}: ${errorMessage(error)}` };
  }
}

async function directoryCheck(check: string, path: string): Promise<StateAuditCheck> {
  try {
    const info = await lstat(path);
    return info.isDirectory()
      ? { check, ok: true, detail: path }
      : { check, ok: false, detail: `${path} is not a real directory` };
  } catch (error) {
    return { check, ok: false, detail: `${path}: ${errorMessage(error)}` };
  }
}

async function secureDirectoryCheck(check: string, path: string, exactMode: number): Promise<StateAuditCheck> {
  const result = await directoryCheck(check, path);
  if (!result.ok) return result;
  try {
    const info = await lstat(path);
    return (info.mode & 0o777) === exactMode
      ? { check, ok: true, detail: `${path} mode 0${exactMode.toString(8)}` }
      : { check, ok: false, detail: `${path} has mode 0${(info.mode & 0o777).toString(8)}; expected 0${exactMode.toString(8)}` };
  } catch (error) {
    return { check, ok: false, detail: `${path}: ${errorMessage(error)}` };
  }
}

async function absentFileCheck(check: string, path: string, absentDetail: string): Promise<StateAuditCheck> {
  try {
    const info = await lstat(path);
    const kind = info.isFile() ? 'file' : 'non-file entry';
    return { check, ok: false, detail: `${path} is a pending ${kind}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { check, ok: true, detail: absentDetail };
    return { check, ok: false, detail: `${path}: ${errorMessage(error)}` };
  }
}

async function directoryEntries(path: string): Promise<Array<{ name: string }> | Error> {
  try {
    return (await readdir(path, { withFileTypes: true })).map(({ name }) => ({ name }));
  } catch (error) {
    return new Error(`${path}: ${errorMessage(error)}`);
  }
}

async function activeMetadataCheck(check: string, path: string, expected: ComputerMetadata): Promise<StateAuditCheck> {
  const file = await regularFileCheck(check, path, 0o600);
  if (!file.ok) return file;
  try {
    const actual = await readMetadata(path);
    const mismatched = JSON.stringify(actual) !== JSON.stringify(expected) || actual.deletedAt !== undefined;
    return mismatched
      ? { check, ok: false, detail: `${path} differs from config` }
      : { check, ok: true, detail: `${path} matches config` };
  } catch (error) {
    return { check, ok: false, detail: `${path}: ${errorMessage(error)}` };
  }
}

async function trashMetadataCheck(check: string, path: string, directoryId: string, activeIds: Set<string>): Promise<StateAuditCheck> {
  const file = await regularFileCheck(check, path, 0o600);
  if (!file.ok) return file;
  try {
    const metadata = await readMetadata(path);
    const problems: string[] = [];
    if (metadata.id !== directoryId) problems.push(`metadata ID ${metadata.id} does not match directory ${directoryId}`);
    if (!metadata.deletedAt) problems.push('deletedAt is missing');
    if (activeIds.has(metadata.id)) problems.push('ID is also active');
    return problems.length
      ? { check, ok: false, detail: `${path}: ${problems.join('; ')}` }
      : { check, ok: true, detail: `${metadata.name} (${metadata.id}) deleted ${metadata.deletedAt}` };
  } catch (error) {
    return { check, ok: false, detail: `${path}: ${errorMessage(error)}` };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
