import { operationOutput } from './operation-context.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { ComputerConfigSchema, RuntimeContainerBindingSchema, assertValidName, type ComputerConfig, type RuntimeContainerBinding } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, numberOption, stringOption } from './args.js';
import { addConfiguredComputer } from './computers.js';
import { docker, ensureRuntimeImages, managedComputerRuntimeObservation, validateDocker, type ManagedRuntimeGroupObservation, type RunOptions } from './docker.js';
import { createStateTransaction, defaultTransactionRuntime, prepareStateTransaction, recoverPendingTransaction, restoreReadyMarker, restoreStage } from './transactions.js';
import { atomicWrite, durableRemove, durableRemoveDirectory, durableRename, loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { synchronizeStartedSkillPolicies } from './policy-commands.js';
import { copyVerifiedBackupArchive, extractInspectedBackupArchive, inspectBackupArchive } from './safe-backup-archive.js';
import { printBrowserProfileDisclosure, type BrowserProfileDisclosureOperation } from './browser-profile-disclosures.js';

interface BackupManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  source: ComputerConfig;
  archive: string;
  sha256: string;
  encrypted: boolean;
  consistency: 'live' | 'quiesced' | 'stopped';
}

export interface BackupCreationJournal {
  version: 1;
  operationId: string;
  installationId: string;
  computerId: string;
  backupId: string;
  stagingName: string;
  createdAt: string;
  phase: 'prepared' | 'paused' | 'archive-ready' | 'resumed';
  pauseTargets: RuntimeContainerBinding[];
}

export interface BackupCreationRuntime {
  observe(state: LoadedState, computer: ComputerConfig): Promise<ManagedRuntimeGroupObservation>;
  docker(args: string[], options?: RunOptions): Promise<string>;
  archive(command: string, args: string[]): Promise<string>;
}

const defaultBackupCreationRuntime: BackupCreationRuntime = {
  observe: managedComputerRuntimeObservation,
  docker,
  archive: run,
};

const MAGIC = Buffer.from('QUBICL1\0');
const HEADER_BYTES = MAGIC.length + 16 + 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRANSIENT_BROWSER_PROFILE_ARCHIVE_PATHS = [
  './qubicl/.local/share/qubicl/browser-profile/SingletonCookie',
  './qubicl/.local/share/qubicl/browser-profile/SingletonLock',
  './qubicl/.local/share/qubicl/browser-profile/SingletonSocket',
] as const;

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}.`);
  return value;
}

function findComputer(state: LoadedState, name: string): ComputerConfig {
  const computer = state.config.computers.find((entry) => entry.name === name || entry.id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return computer;
}

function backupDirectory(state: LoadedState, id: string): string { return join(state.paths.backups, id); }

async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${code ?? 'signal'}): ${stderr.trim()}`)));
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function passphrase(args: ParsedArgs, requiredForEncrypted: boolean): Promise<string | undefined> {
  const path = stringOption(args, 'passphrase-file');
  if (!path) {
    if (requiredForEncrypted) throw new Error('This encrypted backup requires --passphrase-file. Passphrases are never accepted on the command line.');
    return undefined;
  }
  const value = (await readFile(path, 'utf8')).replace(/[\r\n]+$/u, '');
  if (value.length < 12) throw new Error('Backup passphrase must be at least 12 characters.');
  return value;
}

export async function encryptBackupFile(source: string, destination: string, password: string): Promise<void> {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32, { maxmem: 64 * 1024 * 1024 }), iv);
  await writeFile(destination, Buffer.concat([MAGIC, salt, iv]), { mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: 'a', mode: 0o600 }));
  await appendFile(destination, cipher.getAuthTag());
  await chmod(destination, 0o600);
  await syncFile(destination);
}

export async function decryptBackupFile(source: string, destination: string, password: string): Promise<void> {
  const info = await stat(source);
  if (info.size < HEADER_BYTES + 16) throw new Error('Encrypted backup is truncated.');
  const header = Buffer.alloc(HEADER_BYTES);
  const handle = await import('node:fs/promises').then(({ open }) => open(source, 'r'));
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Encrypted backup header is invalid.');
  const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = header.subarray(MAGIC.length + 16, HEADER_BYTES);
  const tag = Buffer.alloc(16);
  const tagHandle = await import('node:fs/promises').then(({ open }) => open(source, 'r'));
  try { await tagHandle.read(tag, 0, 16, info.size - 16); } finally { await tagHandle.close(); }
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32, { maxmem: 64 * 1024 * 1024 }), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(source, { start: HEADER_BYTES, end: info.size - 17 }), decipher, createWriteStream(destination, { mode: 0o600 }));
  } catch {
    throw new Error('Backup decryption failed; the passphrase is wrong or the archive was modified.');
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readManifest(state: LoadedState, id: string): Promise<{ directory: string; manifest: BackupManifest }> {
  if (!/^[a-zA-Z0-9._-]+$/u.test(id)) throw new Error('Invalid backup ID.');
  const directory = backupDirectory(state, id);
  const parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
  parsed.source = ComputerConfigSchema.parse(parsed.source);
  if (
    parsed.version !== 1
    || parsed.id !== id
    || parsed.name !== parsed.source.name
    || typeof parsed.createdAt !== 'string'
    || Number.isNaN(Date.parse(parsed.createdAt))
    || !/^[a-zA-Z0-9._-]+$/u.test(parsed.archive)
    || basename(parsed.archive) !== parsed.archive
    || !/^[a-f0-9]{64}$/u.test(parsed.sha256)
    || typeof parsed.encrypted !== 'boolean'
    || !['live', 'quiesced', 'stopped'].includes(parsed.consistency)
  ) throw new Error(`Backup ${id} has an invalid manifest.`);
  return { directory, manifest: parsed };
}

async function verifyBackup(
  state: LoadedState,
  id: string,
  args: ParsedArgs,
): Promise<{ directory: string; manifest: BackupManifest; archive: string }> {
  const located = await locateBackup(state, id);
  const work = join(state.paths.runtime, `.backup-verify-${randomUUID()}`);
  await mkdir(work, { recursive: false, mode: 0o700 });
  try {
    const copied = join(work, located.manifest.encrypted ? 'archive.tar.gz.enc' : 'archive.tar.gz');
    await copyVerifiedBackupArchive(located.archive, copied, located.manifest.sha256);
    let archive = copied;
    if (located.manifest.encrypted) {
      archive = join(work, 'decrypted.tar.gz');
      await decryptBackupFile(copied, archive, (await passphrase(args, true))!);
    }
    await inspectBackupArchive(archive);
    return located;
  } finally {
    await durableRemoveDirectory(work);
  }
}

async function locateBackup(state: LoadedState, id: string): Promise<{ directory: string; manifest: BackupManifest; archive: string }> {
  const { directory, manifest } = await readManifest(state, id);
  const archive = join(directory, basename(manifest.archive));
  return { directory, manifest, archive };
}

function backupCreationJournalPath(state: LoadedState): string {
  return join(state.paths.runtime, 'backup-create.json');
}

async function writeBackupCreationJournal(state: LoadedState, journal: BackupCreationJournal): Promise<void> {
  await atomicWrite(backupCreationJournalPath(state), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

async function readBackupCreationJournal(state: LoadedState): Promise<BackupCreationJournal | undefined> {
  const path = backupCreationJournalPath(state);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Backup creation journal ${path} must be a regular file.`);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (info.uid !== expectedUid || (info.mode & 0o777) !== 0o600) {
    throw new Error(`Backup creation journal ${path} must be owned by the current operator with mode 0600.`);
  }
  return parseBackupCreationJournal(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

/** Read-only, strict inspection for status and explicit host recovery flows. */
export async function inspectPendingBackupCreation(state: LoadedState): Promise<BackupCreationJournal | undefined> {
  const journal = await readBackupCreationJournal(state);
  return journal ? structuredClone(journal) : undefined;
}

function parseBackupCreationJournal(value: unknown): BackupCreationJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Backup creation journal must be an object.');
  const record = value as Record<string, unknown>;
  const keys = new Set(['backupId', 'computerId', 'createdAt', 'installationId', 'operationId', 'pauseTargets', 'phase', 'stagingName', 'version']);
  const unexpected = Object.keys(record).filter((key) => !keys.has(key));
  if (unexpected.length) throw new Error(`Backup creation journal contains unexpected fields: ${unexpected.join(', ')}.`);
  const operationId = requiredJournalString(record.operationId, 'operationId');
  const backupId = requiredJournalString(record.backupId, 'backupId');
  const stagingName = requiredJournalString(record.stagingName, 'stagingName');
  const createdAt = requiredJournalString(record.createdAt, 'createdAt');
  if (record.version !== 1) throw new Error('Backup creation journal has an unsupported version.');
  if (!UUID_PATTERN.test(operationId)) {
    throw new Error('Backup creation journal has an invalid operation ID.');
  }
  const installationId = requiredJournalString(record.installationId, 'installationId');
  const computerId = requiredJournalString(record.computerId, 'computerId');
  if (!UUID_PATTERN.test(installationId)) throw new Error('Backup creation journal has an invalid installation ID.');
  if (!UUID_PATTERN.test(computerId)) throw new Error('Backup creation journal has an invalid computer ID.');
  if (!/^[a-zA-Z0-9._-]+$/u.test(backupId)) throw new Error('Backup creation journal has an invalid backup ID.');
  if (stagingName !== `.creating-${operationId}`) throw new Error('Backup creation journal has an invalid staging directory binding.');
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Backup creation journal has an invalid creation timestamp.');
  if (!['prepared', 'paused', 'archive-ready', 'resumed'].includes(String(record.phase))) {
    throw new Error('Backup creation journal has an invalid phase.');
  }
  if (!Array.isArray(record.pauseTargets)) throw new Error('Backup creation journal has invalid pause targets.');
  const pauseTargets = record.pauseTargets.map((target) => RuntimeContainerBindingSchema.parse(target));
  if (pauseTargets.some(({ status }) => status !== 'running')) {
    throw new Error('Backup creation journal pause targets must record a previously running container.');
  }
  if (new Set(pauseTargets.map(({ id }) => id)).size !== pauseTargets.length
    || new Set(pauseTargets.map(({ name }) => name)).size !== pauseTargets.length) {
    throw new Error('Backup creation journal pause targets must have unique immutable IDs and names.');
  }
  return {
    version: 1,
    operationId,
    installationId,
    computerId,
    backupId,
    stagingName,
    createdAt,
    phase: record.phase as BackupCreationJournal['phase'],
    pauseTargets,
  };
}

function requiredJournalString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Backup creation journal has an invalid ${field}.`);
  return value;
}

function assertStableBackupObservation(computer: ComputerConfig, observation: ManagedRuntimeGroupObservation): void {
  if (observation.group === 'partial' || observation.group === 'inconsistent') {
    throw new Error(`Computer ${computer.name} runtime group is ${observation.group}; refusing a backup from ambiguous runtime state.`);
  }
  if (observation.group === 'absent' && observation.status !== 'absent') {
    throw new Error(`Computer ${computer.name} runtime group is absent but reports status ${observation.status}.`);
  }
}

function sameBackupPauseTarget(expected: RuntimeContainerBinding, actual: RuntimeContainerBinding): boolean {
  return expected.id === actual.id
    && expected.name === actual.name
    && expected.imageId === actual.imageId
    && expected.role === actual.role
    && expected.topologyVersion === actual.topologyVersion;
}

function assertCoherentBackupPauseOutcome(
  computer: ComputerConfig,
  observation: ManagedRuntimeGroupObservation,
): void {
  if (observation.group !== 'complete'
    || !['running', 'exited', 'created'].includes(observation.status)) {
    throw new Error(
      `Backup recovery could not verify a coherent running or stopped runtime for ${computer.name}; `
      + `found ${observation.group}/${observation.status} and preserved the journal.`,
    );
  }
}

async function resumeBackupPauseTargets(
  state: LoadedState,
  journal: BackupCreationJournal,
  runtime: BackupCreationRuntime,
): Promise<void> {
  if (!journal.pauseTargets.length) return;
  const computer = state.config.computers.find(({ id }) => id === journal.computerId);
  if (!computer) throw new Error(`Backup recovery cannot verify removed computer ${journal.computerId}; the journal was preserved.`);
  const observation = await runtime.observe(state, computer);
  if (observation.group === 'absent' || observation.group === 'partial' || observation.containers.length !== journal.pauseTargets.length) {
    throw new Error(`Backup recovery found ${computer.name} runtime group ${observation.group}; exact paused containers were not changed.`);
  }
  const current = new Map(observation.containers.map((binding) => [binding.id, binding]));
  for (const target of journal.pauseTargets) {
    const actual = current.get(target.id);
    if (!actual || !sameBackupPauseTarget(target, actual)) {
      throw new Error(`Backup recovery could not prove immutable container ${target.id} still belongs to ${computer.name}; it was not changed.`);
    }
  }
  const pausedIds = journal.pauseTargets
    .filter(({ id }) => current.get(id)?.status === 'paused')
    .map(({ id }) => id);
  if (pausedIds.length) {
    await runtime.docker(['unpause', ...pausedIds]);
    const resumed = await runtime.observe(state, computer);
    assertCoherentBackupPauseOutcome(computer, resumed);
    if (resumed.containers.length !== journal.pauseTargets.length) {
      throw new Error(`Backup recovery could not verify that ${computer.name} resumed; the journal was preserved.`);
    }
    const resumedById = new Map(resumed.containers.map((binding) => [binding.id, binding]));
    for (const target of journal.pauseTargets) {
      const actual = resumedById.get(target.id);
      if (!actual || !sameBackupPauseTarget(target, actual)) {
        throw new Error(`Backup recovery observed changed runtime identity for ${computer.name}; the journal was preserved.`);
      }
    }
    return;
  }
  assertCoherentBackupPauseOutcome(computer, observation);
}

async function ownedBackupDirectory(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o777) !== 0o700) {
    throw new Error(`Backup path ${path} must be a real operator-owned directory with mode 0700.`);
  }
  return true;
}

/**
 * Recover only the exact effects recorded by an interrupted backup creation.
 * A staged archive is discarded rather than promoted; replay requires a fresh
 * backup so changed home bytes can never be mistaken for the reviewed capture.
 */
export async function recoverPendingBackupCreation(
  state: LoadedState,
  runtime: BackupCreationRuntime = defaultBackupCreationRuntime,
): Promise<boolean> {
  const journal = await readBackupCreationJournal(state);
  if (!journal) return false;
  if (journal.installationId !== state.config.installationId) {
    throw new Error('Backup creation journal belongs to another Qubicl installation and was preserved.');
  }
  await resumeBackupPauseTargets(state, journal, runtime);
  const staging = join(state.paths.backups, journal.stagingName);
  const target = backupDirectory(state, journal.backupId);
  const [stagingExists, targetExists] = await Promise.all([
    ownedBackupDirectory(staging),
    ownedBackupDirectory(target),
  ]);
  if (stagingExists && targetExists) {
    throw new Error('Backup recovery found both staged and published directories; both were preserved for manual review.');
  }
  if (targetExists) {
    const published = await locateBackup(state, journal.backupId);
    const archiveInfo = await lstat(published.archive);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : archiveInfo.uid;
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.uid !== expectedUid || (archiveInfo.mode & 0o077) !== 0) {
      throw new Error('Backup recovery found an unsafe published archive; it was preserved for manual review.');
    }
    if (published.manifest.source.id !== journal.computerId
      || await sha256(published.archive) !== published.manifest.sha256) {
      throw new Error('Backup recovery found a published archive that does not match its manifest; it was preserved for manual review.');
    }
  }
  if (stagingExists) await durableRemoveDirectory(staging);
  await durableRemove(backupCreationJournalPath(state));
  return true;
}

export async function createBackup(
  state: LoadedState,
  computer: ComputerConfig,
  args: ParsedArgs,
  checkpoint = false,
  runtime: BackupCreationRuntime = defaultBackupCreationRuntime,
): Promise<BackupManifest> {
  if (flag(args, 'quiesce') && flag(args, 'stopped')) throw new Error('--quiesce and --stopped are mutually exclusive.');
  await recoverPendingBackupCreation(state, runtime);
  const observation = await runtime.observe(state, computer);
  assertStableBackupObservation(computer, observation);
  if (flag(args, 'stopped') && !(
    observation.group === 'absent'
    || observation.group === 'complete' && ['exited', 'created'].includes(observation.status)
  )) throw new Error('--stopped requires the complete computer runtime to already be stopped or absent.');
  const consistency: BackupManifest['consistency'] = checkpoint || flag(args, 'quiesce') ? 'quiesced' : flag(args, 'stopped') ? 'stopped' : 'live';
  const pauseTargets = observation.group === 'complete' && observation.status === 'running' && consistency === 'quiesced'
    ? observation.containers.map((binding) => structuredClone(binding))
    : [];
  if (consistency === 'quiesced'
    && observation.group === 'complete'
    && !['running', 'paused', 'exited', 'created'].includes(observation.status)) {
    throw new Error(`Computer ${computer.name} runtime status ${observation.status} cannot be quiesced safely.`);
  }
  const encrypted = flag(args, 'encrypt');
  const password = encrypted ? await passphrase(args, true) : undefined;
  const operationId = randomUUID();
  const id = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${computer.name}-${randomUUID().slice(0, 8)}`;
  const directory = backupDirectory(state, id);
  const stagingName = `.creating-${operationId}`;
  const staging = join(state.paths.backups, stagingName);
  const plain = join(staging, 'home.tar.gz');
  const journal: BackupCreationJournal = {
    version: 1,
    operationId,
    installationId: state.config.installationId,
    computerId: computer.id,
    backupId: id,
    stagingName,
    createdAt: new Date().toISOString(),
    phase: 'prepared',
    pauseTargets,
  };
  await writeBackupCreationJournal(state, journal);
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    if (pauseTargets.length) {
      await runtime.docker(['pause', ...pauseTargets.map(({ id: containerId }) => containerId)]);
      journal.phase = 'paused';
      await writeBackupCreationJournal(state, journal);
    }
    await runtime.archive('tar', [
      '-czf',
      plain,
      '--numeric-owner',
      ...TRANSIENT_BROWSER_PROFILE_ARCHIVE_PATHS.map((path) => `--exclude=${path}`),
      '-C',
      join(state.paths.computers, computer.id, 'home'),
      '.',
    ]);
    await chmod(plain, 0o600);
    await syncFile(plain);
    let archive = plain;
    if (encrypted) {
      archive = `${plain}.enc`;
      await encryptBackupFile(plain, archive, password!);
      await durableRemove(plain);
    }
    const manifest: BackupManifest = {
      version: 1, id, name: computer.name, createdAt: new Date().toISOString(), source: structuredClone(computer),
      archive: basename(archive), sha256: await sha256(archive), encrypted, consistency,
    };
    await atomicWrite(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    journal.phase = 'archive-ready';
    await writeBackupCreationJournal(state, journal);
    await resumeBackupPauseTargets(state, journal, runtime);
    journal.phase = 'resumed';
    await writeBackupCreationJournal(state, journal);
    await durableRename(staging, directory);
    await durableRemove(backupCreationJournalPath(state));
    return manifest;
  } catch (error) {
    try {
      await recoverPendingBackupCreation(state, runtime);
    } catch (recoveryError) {
      throw new Error(
        `Backup creation failed and exact recovery remains pending: ${errorMessage(error)} Recovery error: ${errorMessage(recoveryError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Prune only backups bound to one immutable source computer identity. */
export async function pruneComputerBackups(
  state: LoadedState,
  computerId: string,
  keep: number,
): Promise<BackupManifest[]> {
  if (!UUID_PATTERN.test(computerId)) throw new Error('Backup pruning requires an immutable computer ID.');
  if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep must be a non-negative integer.');
  return pruneVerifiedBackups(state, ({ source }) => source.id === computerId, keep);
}

export async function pruneBackupsBySelector(
  state: LoadedState,
  selector: string | undefined,
  keep: number,
): Promise<BackupManifest[]> {
  if (!selector) return pruneVerifiedBackups(state, () => true, keep);
  const configured = state.config.computers.find(({ id, name }) => id === selector || name === selector);
  if (configured) return pruneComputerBackups(state, configured.id, keep);
  if (UUID_PATTERN.test(selector)) return pruneComputerBackups(state, selector, keep);

  const sourceIds = new Set<string>();
  for (const entry of await readdir(state.paths.backups, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const { manifest } = await readManifest(state, entry.name);
      if (manifest.name === selector) sourceIds.add(manifest.source.id);
    } catch { /* preserve malformed entries */ }
  }
  if (sourceIds.size > 1) {
    throw new Error(`Backup name ${selector} belongs to multiple historical computer IDs; use an immutable source ID.`);
  }
  const sourceId = [...sourceIds][0];
  return sourceId ? pruneComputerBackups(state, sourceId, keep) : [];
}

async function pruneVerifiedBackups(
  state: LoadedState,
  include: (manifest: BackupManifest) => boolean,
  keep: number,
): Promise<BackupManifest[]> {
  const manifests: BackupManifest[] = [];
  for (const entry of await readdir(state.paths.backups, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const { manifest } = await readManifest(state, entry.name);
      if (include(manifest)) manifests.push(manifest);
    } catch { /* preserve malformed entries */ }
  }
  const doomed = manifests
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    .slice(keep);
  for (const backup of doomed) await durableRemoveDirectory(backupDirectory(state, backup.id));
  return doomed;
}

async function restoreBackup(state: LoadedState, id: string, name: string, args: ParsedArgs, start = false): Promise<ComputerConfig> {
  assertValidName(name);
  const verified = await locateBackup(state, id);
  const defaults = {
    preset: verified.manifest.source.preset,
    compatibility: verified.manifest.source.compatibility,
    image: verified.manifest.source.image,
    capabilityContractVersion: verified.manifest.source.capabilityContractVersion,
    capabilities: verified.manifest.source.capabilities,
    cpus: verified.manifest.source.cpus,
    memory: verified.manifest.source.memory,
  };
  const computer = addConfiguredComputer(state, name, defaults);
  if (verified.manifest.source.controlProtocolVersion === undefined) delete computer.controlProtocolVersion;
  else computer.controlProtocolVersion = verified.manifest.source.controlProtocolVersion;
  computer.network = structuredClone(verified.manifest.source.network);
  computer.environment = structuredClone(verified.manifest.source.environment);
  computer.ssh = structuredClone(verified.manifest.source.ssh);
  computer.toolPolicy = structuredClone(verified.manifest.source.toolPolicy);
  computer.skillPolicy = structuredClone(verified.manifest.source.skillPolicy);
  const staged = restoreStage(state.paths, computer.id);
  const home = join(staged, 'home');
  const transaction = createStateTransaction('backup-restore', state, {
    activeSources: { [computer.id]: 'staged' },
    runtime: { ensureImages: true, startIds: start ? [computer.id] : [] },
  });
  await prepareStateTransaction(state.paths, transaction);
  const work = join(staged, `.restore-${randomUUID()}`);
  const extracted = join(work, 'home');
  const copied = join(work, verified.manifest.encrypted ? 'archive.tar.gz.enc' : 'archive.tar.gz');
  const decrypted = join(work, 'decrypted.tar.gz');
  let stagedCreated = false;
  let stagingComplete = false;
  try {
    const restoreRoot = dirname(staged);
    await mkdir(restoreRoot, { recursive: true, mode: 0o700 });
    const restoreRootInfo = await lstat(restoreRoot);
    if (!restoreRootInfo.isDirectory() || restoreRootInfo.isSymbolicLink()) {
      throw new Error(`Backup restore staging root ${restoreRoot} must be a real directory.`);
    }
    await mkdir(staged, { recursive: false, mode: 0o700 });
    stagedCreated = true;
    await mkdir(work, { recursive: false, mode: 0o700 });
    await mkdir(extracted, { recursive: false, mode: 0o700 });
    await copyVerifiedBackupArchive(verified.archive, copied, verified.manifest.sha256);
    let archive = copied;
    if (verified.manifest.encrypted) {
      await decryptBackupFile(copied, decrypted, (await passphrase(args, true))!);
      archive = decrypted;
    }
    const plan = await inspectBackupArchive(archive);
    await extractInspectedBackupArchive(archive, extracted, plan);
    await durableRename(extracted, home);
    await durableRemoveDirectory(work);
    await atomicWrite(restoreReadyMarker(state.paths, computer.id), 'ready\n', 0o600);
    stagingComplete = true;
    await recoverPendingTransaction(state.paths, {
      runtime: {
        ...defaultTransactionRuntime,
        ensureImages: (loaded) => ensureRuntimeImages(loaded, start ? [computer] : [], true),
      },
    });
  } catch (error) {
    if (!stagingComplete) {
      if (stagedCreated) await durableRemoveDirectory(staged);
      await durableRemove(state.paths.journal);
    }
    throw error;
  }
  return computer;
}

export async function backupCommand(
  args: ParsedArgs,
  createDisclosure: Extract<BrowserProfileDisclosureOperation, 'backup' | 'checkpoint'> = 'backup',
): Promise<void> {
  const action = required(args.positionals[0], 'backup action');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    if (action === 'create') {
      const computer = findComputer(state, required(args.positionals[1], 'computer name'));
      printBrowserProfileDisclosure(createDisclosure);
      const result = await createBackup(state, computer, args);
      operationOutput('log', `Created ${result.consistency} backup ${result.id}; sha256:${result.sha256}${result.encrypted ? '; encrypted' : ''}.`);
      return;
    }
    if (action === 'list') {
      const filter = args.positionals[1];
      const rows: BackupManifest[] = [];
      for (const entry of await readdir(state.paths.backups, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try { const { manifest } = await readManifest(state, entry.name); if (!filter || manifest.name === filter) rows.push(manifest); } catch { /* doctor reports malformed entries */ }
      }
      operationOutput('log', JSON.stringify(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), null, 2));
      return;
    }
    if (action === 'verify') {
      const result = await verifyBackup(state, required(args.positionals[1], 'backup ID'), args);
      operationOutput('log', `Verified backup ${result.manifest.id}; sha256:${result.manifest.sha256}.`);
      return;
    }
    if (action === 'restore') {
      const backupId = required(args.positionals[1], 'backup ID');
      const restoredName = required(args.positionals[2], 'new computer name');
      await recoverPendingBackupCreation(state);
      await validateDocker();
      printBrowserProfileDisclosure('backup-restore');
      const computer = await restoreBackup(state, backupId, restoredName, args);
      operationOutput('log', `Restored ${computer.name} from verified backup ${args.positionals[1]}. It is stopped; run qubicl start ${computer.name}.`);
      return;
    }
    if (action === 'prune') {
      if (!flag(args, 'yes')) throw new Error('Backup pruning is destructive and requires --yes.');
      const keep = numberOption(args, 'keep');
      if (!Number.isInteger(keep) || keep! < 0) throw new Error('--keep must be a non-negative integer.');
      await recoverPendingBackupCreation(state);
      const filter = args.positionals[1];
      const doomed = await pruneBackupsBySelector(state, filter, keep!);
      operationOutput('log', `Pruned ${doomed.length} verified backup${doomed.length === 1 ? '' : 's'}; malformed entries were preserved.`);
      return;
    }
    throw new Error('Backup action must be create, list, verify, restore, or prune.');
  });
}

export async function checkpointCommand(args: ParsedArgs): Promise<void> {
  if (!flag(args, 'stopped')) args.options.set('quiesce', true);
  args.positionals = ['create', args.positionals[0]!];
  await backupCommand(args, 'checkpoint');
}

export async function cloneCommand(args: ParsedArgs): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    await validateDocker();
    const source = findComputer(state, required(args.positionals[0], 'source computer'));
    printBrowserProfileDisclosure('clone');
    const backup = await createBackup(state, source, { positionals: [], options: new Map([['quiesce', true]]) });
    const target = await restoreBackup(state, backup.id, required(args.positionals[1], 'new computer name'), args, !flag(args, 'no-start'));
    if (!flag(args, 'no-start')) await synchronizeStartedSkillPolicies(state, [target]);
    operationOutput('log', `Cloned ${source.name} to ${target.name} through verified checkpoint ${backup.id}${flag(args, 'no-start') ? ' (stopped)' : ''}.`);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
