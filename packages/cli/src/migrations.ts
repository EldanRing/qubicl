import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import {
  ConfigSchema,
  LegacyConfigV1Schema,
  LegacyConfigV2Schema,
  LegacyStateMigrationV2Schema,
  LegacySecretsV1Schema,
  LegacySecretsV2Schema,
  SecretsSchema,
  STATE_FORMAT_VERSION,
  StateMigrationSchema,
  assertStateComputerIdsMatch,
  migrateConfigV1,
  migrateConfigV2,
  migrateSecretsV1,
  migrateSecretsV2,
  type StateMigration,
} from '@qubicl/core';
import {
  atomicWrite,
  durableRemove,
  prepareStateDirectories,
  readMetadata,
  saveMetadataInDirectory,
  saveState,
  syncDirectory,
  type StatePaths,
} from './state.js';
import { renderRuntime } from './runtime.js';

export type StateMigrationCheckpoint = 'backup-written' | 'journal-written' | 'config-written' | 'state-written' | 'metadata-written' | 'runtime-rendered';

export interface StateMigrationOptions {
  checkpoint?: (checkpoint: StateMigrationCheckpoint, migration: StateMigration) => Promise<void> | void;
}

export interface StateFormatInspection {
  status: 'uninitialized' | 'current' | 'legacy' | 'migration-pending' | 'invalid';
  detail: string;
}

interface StateSourceFiles {
  config: string;
  secrets: string;
}

interface UpgradeBackupOptions {
  reason: 'state-format' | 'lifecycle-journal';
  sourceVersion: number;
  targetVersion: number;
  installationId: string;
  files: Readonly<Record<string, string>>;
}

export async function inspectStateFormat(paths: StatePaths): Promise<StateFormatInspection> {
  try {
    const migration = await readMigration(paths);
    if (migration) {
      return {
        status: 'migration-pending',
        detail: `state migration ${migration.id} from format ${migration.sourceVersion} to ${migration.targetVersion} awaits recovery`,
      };
    }
    const source = await readStateSource(paths);
    if (!source) return { status: 'uninitialized', detail: `no state files at ${paths.root}` };
    const configValue = YAML.parse(source.config) as unknown;
    const secretsValue = YAML.parse(source.secrets) as unknown;
    const configVersion = documentVersion(configValue, 'config');
    const secretsVersion = documentVersion(secretsValue, 'secrets');
    if (configVersion !== secretsVersion) {
      return { status: 'invalid', detail: `config format ${configVersion} does not match secrets format ${secretsVersion}` };
    }
    if (configVersion === STATE_FORMAT_VERSION) {
      const config = ConfigSchema.parse(configValue);
      const secrets = SecretsSchema.parse(secretsValue);
      assertStateComputerIdsMatch(config, secrets);
      return { status: 'current', detail: `state format ${STATE_FORMAT_VERSION}` };
    }
    if (configVersion === 1 || configVersion === 2) {
      if (configVersion === 1) {
        const config = LegacyConfigV1Schema.parse(configValue);
        const secrets = LegacySecretsV1Schema.parse(secretsValue);
        assertStateComputerIdsMatch(config, secrets);
      } else {
        const config = LegacyConfigV2Schema.parse(configValue);
        const secrets = LegacySecretsV2Schema.parse(secretsValue);
        assertStateComputerIdsMatch(config, secrets);
      }
      return { status: 'legacy', detail: `state format ${configVersion} will migrate to ${STATE_FORMAT_VERSION} before the next state command` };
    }
    const relation = configVersion > STATE_FORMAT_VERSION ? 'newer than' : 'unsupported by';
    return { status: 'invalid', detail: `state format ${configVersion} is ${relation} this Qubicl build (current format ${STATE_FORMAT_VERSION})` };
  } catch (error) {
    return { status: 'invalid', detail: errorMessage(error) };
  }
}

export async function ensureCurrentState(paths: StatePaths, options: StateMigrationOptions = {}): Promise<boolean> {
  if (await recoverStateMigration(paths, options)) return true;
  const source = await readStateSource(paths);
  if (!source) return false;
  const configValue = YAML.parse(source.config) as unknown;
  const secretsValue = YAML.parse(source.secrets) as unknown;
  const configVersion = documentVersion(configValue, 'config');
  const secretsVersion = documentVersion(secretsValue, 'secrets');
  if (configVersion !== secretsVersion) {
    throw new Error(`Cannot migrate state: config format ${configVersion} does not match secrets format ${secretsVersion}.`);
  }
  if (configVersion === STATE_FORMAT_VERSION) {
    const config = ConfigSchema.parse(configValue);
    const secrets = SecretsSchema.parse(secretsValue);
    assertStateComputerIdsMatch(config, secrets);
    return false;
  }
  if (configVersion > STATE_FORMAT_VERSION) {
    throw new Error(`State format ${configVersion} is newer than this Qubicl build supports (${STATE_FORMAT_VERSION}); use a matching or newer Qubicl version.`);
  }
  if (configVersion !== 1 && configVersion !== 2) throw new Error(`State format ${configVersion} cannot be migrated by this Qubicl build.`);

  const id = configVersion === 2 ? LegacyConfigV2Schema.parse(configValue).installationId : randomUUID();
  const migratedConfig = configVersion === 1
    ? migrateConfigV1(LegacyConfigV1Schema.parse(configValue), id)
    : migrateConfigV2(LegacyConfigV2Schema.parse(configValue));
  const migratedSecrets = configVersion === 1
    ? migrateSecretsV1(LegacySecretsV1Schema.parse(secretsValue))
    : migrateSecretsV2(LegacySecretsV2Schema.parse(secretsValue));
  assertStateComputerIdsMatch(migratedConfig, migratedSecrets);
  await validateMigrationDurableState(paths, migratedConfig);
  const metadataFiles = await metadataBackupFiles(paths, migratedConfig.computers.map(({ id }) => id));
  const migration = StateMigrationSchema.parse({
    version: 2,
    id,
    createdAt: new Date().toISOString(),
    sourceVersion: configVersion,
    targetVersion: STATE_FORMAT_VERSION,
    backupName: await writeUpgradeBackup(paths, {
      reason: 'state-format',
      sourceVersion: configVersion,
      targetVersion: STATE_FORMAT_VERSION,
      installationId: id,
      files: { 'config.yaml': source.config, 'secrets.yaml': source.secrets, ...metadataFiles },
    }),
    config: migratedConfig,
    secrets: migratedSecrets,
  });
  await checkpoint('backup-written', migration, options);
  await atomicWrite(paths.migration, YAML.stringify(migration), 0o600);
  await checkpoint('journal-written', migration, options);
  await recoverStateMigration(paths, options);
  return true;
}

export async function recoverStateMigration(paths: StatePaths, options: StateMigrationOptions = {}): Promise<boolean> {
  const migration = await readMigration(paths);
  if (!migration) return false;
  assertStateComputerIdsMatch(migration.config, migration.secrets);
  await validateMigrationDurableState(paths, migration.config);
  await saveState({ paths, config: migration.config, secrets: migration.secrets }, async () => {
    await checkpoint('config-written', migration, options);
  });
  await checkpoint('state-written', migration, options);
  await migrateStoredMetadata(paths, migration);
  await checkpoint('metadata-written', migration, options);
  await prepareStateDirectories(paths);
  await atomicWrite(paths.runtimeNamespacePending, `${JSON.stringify({ version: 1, installationId: migration.config.installationId })}\n`, 0o600);
  await renderRuntime({ paths, config: migration.config, secrets: migration.secrets });
  await checkpoint('runtime-rendered', migration, options);
  await durableRemove(paths.migration);
  return true;
}

export async function writeUpgradeBackup(paths: StatePaths, options: UpgradeBackupOptions): Promise<string> {
  try {
    const info = await lstat(paths.backups);
    if (!info.isDirectory()) throw new Error(`${paths.backups} exists but is not a real directory.`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
    if (info.uid !== uid) throw new Error(`${paths.backups} is owned by UID ${info.uid}, not current UID ${uid}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(paths.backups, { mode: 0o700 });
    const info = await lstat(paths.backups);
    if (!info.isDirectory()) throw new Error(`${paths.backups} was not created as a real directory.`);
    await syncDirectory(paths.root);
  }
  await chmod(paths.backups, 0o700);
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replaceAll(':', '').replaceAll('.', '-');
  const name = `${timestamp}-v${options.sourceVersion}-to-v${options.targetVersion}-${randomUUID()}`;
  const directory = join(paths.backups, name);
  await mkdir(directory, { mode: 0o700 });
  await syncDirectory(paths.backups);

  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const [filename, contents] of Object.entries(options.files)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error(`Unsafe backup filename ${filename}.`);
    await atomicWrite(join(directory, filename), contents, 0o600);
    files[filename] = {
      sha256: createHash('sha256').update(contents).digest('hex'),
      bytes: Buffer.byteLength(contents),
    };
  }
  await atomicWrite(join(directory, 'manifest.yaml'), YAML.stringify({
    version: 1,
    reason: options.reason,
    createdAt,
    sourceVersion: options.sourceVersion,
    targetVersion: options.targetVersion,
    installationId: options.installationId,
    files,
  }), 0o600);
  return name;
}

async function readMigration(paths: StatePaths): Promise<StateMigration | undefined> {
  let info;
  try {
    info = await lstat(paths.migration);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error(`State migration journal ${paths.migration} is not a regular file.`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`State migration journal ${paths.migration} must have mode 0600.`);
  const value = YAML.parse(await readFile(paths.migration, 'utf8')) as unknown;
  const current = StateMigrationSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = LegacyStateMigrationV2Schema.safeParse(value);
  if (!legacy.success) throw current.error;
  const upgraded = StateMigrationSchema.parse({
    version: 2,
    id: legacy.data.id,
    createdAt: legacy.data.createdAt,
    sourceVersion: legacy.data.sourceVersion,
    targetVersion: STATE_FORMAT_VERSION,
    backupName: legacy.data.backupName,
    config: migrateConfigV2(legacy.data.config),
    secrets: migrateSecretsV2(legacy.data.secrets),
  });
  return upgraded;
}

async function readStateSource(paths: StatePaths): Promise<StateSourceFiles | undefined> {
  const [config, secrets] = await Promise.all([
    readFileIfExists(paths.config),
    readFileIfExists(paths.secrets),
  ]);
  if (config === undefined && secrets === undefined) return undefined;
  if (config === undefined || secrets === undefined) {
    throw new Error(`Qubicl state is incomplete: ${config === undefined ? paths.config : paths.secrets} is missing.`);
  }
  return { config, secrets };
}

async function metadataBackupFiles(paths: StatePaths, activeIds: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const id of activeIds) {
    const contents = await readFileIfExists(join(paths.computers, id, 'metadata.yaml'));
    if (contents !== undefined) files[`active-${id}-metadata.yaml`] = contents;
  }
  for (const entry of await realDirectoryEntries(paths.trash)) {
    const contents = await readFileIfExists(join(paths.trash, entry, 'metadata.yaml'));
    if (contents !== undefined) files[`trash-${entry}-metadata.yaml`] = contents;
  }
  return files;
}

async function validateMigrationDurableState(paths: StatePaths, config: StateMigration['config']): Promise<void> {
  const activeIds = new Set(config.computers.map(({ id }) => id));
  const activeEntries = await ownedRealDirectoryEntries(paths.computers);
  const missing = [...activeIds].filter((id) => !activeEntries.includes(id)).sort();
  const untracked = activeEntries.filter((id) => !activeIds.has(id)).sort();
  if (missing.length || untracked.length) {
    throw new Error(
      `Durable computer directories do not match config: missing: ${missing.join(', ') || 'none'}; untracked: ${untracked.join(', ') || 'none'}.`,
    );
  }

  for (const computer of config.computers) {
    const directory = join(paths.computers, computer.id);
    await assertOwnedRealDirectory(directory);
    await assertOwnedRealDirectory(join(directory, 'home'));
    await assertOwnedRealDirectory(join(directory, 'home', 'qubicl'));
    const metadataPath = join(directory, 'metadata.yaml');
    await assertOwnedRegularFile(metadataPath);
    const metadata = await readMetadata(metadataPath);
    if (metadata.deletedAt || !isDeepStrictEqual(metadata, computer)) {
      throw new Error(`Active metadata ${metadataPath} does not match migrated computer ${computer.name} (${computer.id}).`);
    }
  }

  for (const entry of await ownedRealDirectoryEntries(paths.trash)) {
    const directory = join(paths.trash, entry);
    await assertOwnedRealDirectory(join(directory, 'home'));
    await assertOwnedRealDirectory(join(directory, 'home', 'qubicl'));
    const metadataPath = join(directory, 'metadata.yaml');
    await assertOwnedRegularFile(metadataPath);
    const metadata = await readMetadata(metadataPath);
    if (metadata.id !== entry || !metadata.deletedAt || activeIds.has(metadata.id)) {
      throw new Error(`Trash metadata in ${directory} does not match its directory, lacks deletedAt, or duplicates an active computer.`);
    }
  }
}

async function ownedRealDirectoryEntries(path: string): Promise<string[]> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  assertRealDirectoryInfo(path, info);
  const entries = (await readdir(path)).sort();
  for (const entry of entries) {
    const entryPath = join(path, entry);
    assertRealDirectoryInfo(entryPath, await lstat(entryPath));
  }
  return entries;
}

async function assertOwnedRealDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Required durable directory ${path} is missing.`);
    throw error;
  }
  assertRealDirectoryInfo(path, info);
}

async function assertOwnedRegularFile(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Required durable file ${path} is missing.`);
    throw error;
  }
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
  assertCurrentOwner(path, info);
}

function assertRealDirectoryInfo(path: string, info: Stats): void {
  if (!info.isDirectory()) throw new Error(`${path} exists but is not a real directory.`);
  assertCurrentOwner(path, info);
}

function assertCurrentOwner(path: string, info: Pick<Stats, 'uid'>): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (info.uid !== uid) throw new Error(`${path} is owned by UID ${info.uid}, not current UID ${uid}.`);
}

async function migrateStoredMetadata(paths: StatePaths, migration: StateMigration): Promise<void> {
  for (const computer of migration.config.computers) {
    const directory = join(paths.computers, computer.id);
    await assertOwnedRealDirectory(directory);
    const metadataPath = join(directory, 'metadata.yaml');
    const existing = await readMetadata(metadataPath);
    if (existing.deletedAt || !isDeepStrictEqual(existing, computer)) {
      throw new Error(`Active metadata ${metadataPath} does not match migrated computer ${computer.name} (${computer.id}).`);
    }
    await saveMetadataInDirectory(directory, computer);
  }
  for (const entry of await realDirectoryEntries(paths.trash)) {
    const directory = join(paths.trash, entry);
    const metadata = await readMetadata(join(directory, 'metadata.yaml'));
    if (metadata.id !== entry || !metadata.deletedAt) {
      throw new Error(`Trash metadata in ${directory} does not match its directory or lacks deletedAt.`);
    }
    await saveMetadataInDirectory(directory, metadata);
  }
}

async function realDirectoryEntries(path: string): Promise<string[]> {
  return ownedRealDirectoryEntries(path);
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function documentVersion(value: unknown, name: string): number {
  if (!value || typeof value !== 'object' || !('version' in value) || !Number.isInteger(value.version)) {
    throw new Error(`${name} state does not contain an integer format version.`);
  }
  return value.version as number;
}

async function checkpoint(
  name: StateMigrationCheckpoint,
  migration: StateMigration,
  options: StateMigrationOptions,
): Promise<void> {
  await options.checkpoint?.(name, migration);
  if (process.env.NODE_ENV === 'test' && process.env.QUBICL_TEST_FAIL_MIGRATION_AFTER === name) {
    throw new Error(`Simulated state migration interruption after ${name}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
