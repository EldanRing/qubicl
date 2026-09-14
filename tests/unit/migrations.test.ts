import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  CONTROL_PROTOCOL_VERSION,
  LegacyConfigV3Schema,
  LegacyConfigV4Schema,
  LegacySecretsV3Schema,
  defaultConfig,
  defaultSecrets,
} from '@qubicl/core';
import {
  ensureCurrentState,
  inspectStateFormat,
  type StateMigrationCheckpoint,
} from '../../packages/cli/dist/migrations.js';
import { loadState, statePaths } from '../../packages/cli/dist/state.js';
import { createStateTransaction, readPendingTransaction } from '../../packages/cli/dist/transactions.js';

const checkpoints: StateMigrationCheckpoint[] = [
  'backup-written',
  'journal-written',
  'config-written',
  'state-written',
  'metadata-written',
  'runtime-rendered',
];

test('version-1 state migrates durably after every interruption boundary', async (context) => {
  for (const interruptedAt of checkpoints) {
    await context.test(interruptedAt, async () => {
      const root = await mkdtemp(join(tmpdir(), 'qubicl-migration-'));
      const paths = statePaths(root);
      const { configRaw, secretsRaw } = await writeLegacyState(root);
      let interrupted = false;
      await assert.rejects(ensureCurrentState(paths, {
        checkpoint(checkpoint) {
          if (!interrupted && checkpoint === interruptedAt) {
            interrupted = true;
            throw new Error(`interrupt ${checkpoint}`);
          }
        },
      }), new RegExp(`interrupt ${interruptedAt}`));

      await ensureCurrentState(paths);
      const state = await loadState(paths);
      assert.equal(state.config.version, 5);
      assert.match(state.config.installationId, /^[0-9a-f-]{36}$/);
      assert.equal(state.secrets.version, 5);
      assert.equal((await inspectStateFormat(paths)).status, 'current');
      await assert.rejects(stat(paths.migration), { code: 'ENOENT' });
      assert.equal((await stat(paths.runtimeNamespacePending)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(paths.runtimeNamespacePending, 'utf8')), {
        version: 1,
        installationId: state.config.installationId,
      });

      const backups = await readdir(paths.backups);
      assert.ok(backups.length >= 1);
      let exactBackupFound = false;
      for (const name of backups) {
        const directory = join(paths.backups, name);
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
        const backupConfig = await readFile(join(directory, 'config.yaml'), 'utf8');
        const backupSecrets = await readFile(join(directory, 'secrets.yaml'), 'utf8');
        assert.equal((await stat(join(directory, 'config.yaml'))).mode & 0o777, 0o600);
        assert.equal((await stat(join(directory, 'secrets.yaml'))).mode & 0o777, 0o600);
        assert.equal((await stat(join(directory, 'manifest.yaml'))).mode & 0o777, 0o600);
        if (backupConfig === configRaw && backupSecrets === secretsRaw) {
          const manifest = YAML.parse(await readFile(join(directory, 'manifest.yaml'), 'utf8'));
          assert.equal(manifest.reason, 'state-format');
          assert.equal(manifest.sourceVersion, 1);
          assert.equal(manifest.targetVersion, 5);
          assert.deepEqual(manifest.files['config.yaml'], fileDigest(configRaw));
          assert.deepEqual(manifest.files['secrets.yaml'], fileDigest(secretsRaw));
          exactBackupFound = true;
        }
      }
      assert.equal(exactBackupFound, true);
    });
  }
});

test('version-3 state migrates durably without changing its installation identity', async (context) => {
  for (const interruptedAt of checkpoints) {
    await context.test(interruptedAt, async () => {
      const root = await mkdtemp(join(tmpdir(), 'qubicl-v3-migration-'));
      const paths = statePaths(root);
      const { configRaw, secretsRaw, installationId } = await writeVersion3State(root);
      assert.deepEqual(await inspectStateFormat(paths), {
        status: 'legacy',
        detail: 'state format 3 requires explicit setup migration to 5',
      });

      let interrupted = false;
      await assert.rejects(ensureCurrentState(paths, {
        checkpoint(checkpoint) {
          if (!interrupted && checkpoint === interruptedAt) {
            interrupted = true;
            throw new Error(`interrupt ${checkpoint}`);
          }
        },
      }), new RegExp(`interrupt ${interruptedAt}`));

      await ensureCurrentState(paths);
      const state = await loadState(paths);
      assert.equal(state.config.version, 5);
      assert.equal(state.config.installationId, installationId);
      assert.equal(state.secrets.version, 5);
      assert.equal((await inspectStateFormat(paths)).status, 'current');
      await assert.rejects(stat(paths.migration), { code: 'ENOENT' });

      const backups = await readdir(paths.backups);
      let exactBackupFound = false;
      for (const name of backups) {
        const directory = join(paths.backups, name);
        if (await readFile(join(directory, 'config.yaml'), 'utf8') !== configRaw) continue;
        if (await readFile(join(directory, 'secrets.yaml'), 'utf8') !== secretsRaw) continue;
        const manifest = YAML.parse(await readFile(join(directory, 'manifest.yaml'), 'utf8'));
        assert.equal(manifest.sourceVersion, 3);
        assert.equal(manifest.targetVersion, 5);
        assert.equal(manifest.installationId, installationId);
        assert.deepEqual(manifest.files['config.yaml'], fileDigest(configRaw));
        assert.deepEqual(manifest.files['secrets.yaml'], fileDigest(secretsRaw));
        exactBackupFound = true;
      }
      assert.equal(exactBackupFound, true);
    });
  }
});

test('version-3 schemas are strict and explicit bootstrap identity is retained', async () => {
  const installationId = '00000000-0000-4000-8000-000000000400';
  const currentConfig = defaultConfig(installationId);
  assert.equal(currentConfig.installationId, installationId);
  const version3Config = { ...currentConfig, version: 3 as const };
  const version3Secrets = { ...defaultSecrets(), version: 3 as const };
  assert.equal(LegacyConfigV3Schema.parse(version3Config).installationId, installationId);
  assert.deepEqual(LegacySecretsV3Schema.parse(version3Secrets).computers, {});
  assert.throws(() => LegacyConfigV3Schema.parse({ ...version3Config, unexpected: true }));
  assert.throws(() => LegacySecretsV3Schema.parse({ ...version3Secrets, unexpected: true }));
});

test('version-4 migration upgrades active and trashed durable metadata with the config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-v4-metadata-migration-'));
  const paths = statePaths(root);
  const installationId = '00000000-0000-4000-8000-000000000430';
  const computerId = '00000000-0000-4000-8000-000000000431';
  const trashId = '00000000-0000-4000-8000-000000000432';
  const createdAt = '2026-09-10T12:00:00.000Z';
  const current = defaultConfig(installationId);
  const legacyComputer = {
    ...current.defaults,
    id: computerId,
    name: 'active-v4',
    runtimeName: 'qubicl-active-v4',
    createdAt,
    controlProtocolVersion: 10,
  };
  const legacyTrash = {
    ...legacyComputer,
    id: trashId,
    name: 'trash-v4',
    runtimeName: 'qubicl-trash-v4',
    deletedAt: '2026-09-10T13:00:00.000Z',
  };
  const config = LegacyConfigV4Schema.parse({
    ...current,
    version: 4,
    computers: [legacyComputer],
  });
  const secrets = {
    ...defaultSecrets(),
    version: 4,
    computers: {
      [computerId]: {
        token: `qubicl_${'t'.repeat(32)}`,
        internalKey: 'k'.repeat(32),
      },
    },
  };
  const configRaw = YAML.stringify(config);
  const secretsRaw = YAML.stringify(secrets);
  await mkdir(join(paths.computers, computerId, 'home', 'qubicl'), { recursive: true });
  await mkdir(join(paths.trash, trashId, 'home', 'qubicl'), { recursive: true });
  await writeFile(paths.config, configRaw, { mode: 0o600 });
  await writeFile(paths.secrets, secretsRaw, { mode: 0o600 });
  await writeFile(join(paths.computers, computerId, 'metadata.yaml'), YAML.stringify(legacyComputer), { mode: 0o600 });
  await writeFile(join(paths.trash, trashId, 'metadata.yaml'), YAML.stringify(legacyTrash), { mode: 0o600 });

  await ensureCurrentState(paths);
  const migrated = await loadState(paths);
  const active = migrated.config.computers[0]!;
  assert.equal(active.controlProtocolVersion, CONTROL_PROTOCOL_VERSION);
  assert.equal(active.runtimeName, undefined);
  assert.deepEqual(active.browser, { maxTabs: 24 });
  assert.deepEqual(active.network, {
    profile: 'developer',
    allowDomains: [],
    denyDomains: [],
    allowCidrs: [],
    allowTcpPorts: [],
    temporaryApprovals: [],
  });
  assert.deepEqual(YAML.parse(await readFile(join(paths.computers, computerId, 'metadata.yaml'), 'utf8')), active);
  const migratedTrash = YAML.parse(await readFile(join(paths.trash, trashId, 'metadata.yaml'), 'utf8'));
  assert.equal(migratedTrash.deletedAt, legacyTrash.deletedAt);
  assert.equal(migratedTrash.runtimeName, undefined);
  assert.equal(migratedTrash.controlProtocolVersion, CONTROL_PROTOCOL_VERSION);
  assert.deepEqual(migratedTrash.browser, { maxTabs: 24 });
  assert.deepEqual(migratedTrash.network, active.network);

  const backups = await readdir(paths.backups);
  assert.equal(backups.length, 1);
  const backup = join(paths.backups, backups[0]!);
  assert.equal(await readFile(join(backup, 'config.yaml'), 'utf8'), configRaw);
  assert.equal(await readFile(join(backup, 'secrets.yaml'), 'utf8'), secretsRaw);
  assert.equal(
    await readFile(join(backup, `active-${computerId}-metadata.yaml`), 'utf8'),
    YAML.stringify(legacyComputer),
  );
  assert.equal(
    await readFile(join(backup, `trash-${trashId}-metadata.yaml`), 'utf8'),
    YAML.stringify(legacyTrash),
  );
});

test('pending version-3 state migration resumes with its journal and backup identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-pending-v3-state-migration-'));
  const paths = statePaths(root);
  const installationId = '00000000-0000-4000-8000-000000000410';
  const migrationId = '00000000-0000-4000-8000-000000000411';
  const backupName = 'preserved-v2-to-v3-backup';
  const config = { ...defaultConfig(installationId), version: 3 as const };
  const secrets = { ...defaultSecrets(), version: 3 as const };
  await mkdir(join(paths.backups, backupName), { recursive: true, mode: 0o700 });
  await writeFile(join(paths.backups, backupName, 'marker'), 'preserve me\n', { mode: 0o600 });
  await writeFile(paths.migration, YAML.stringify({
    version: 2,
    id: migrationId,
    createdAt: '2026-09-07T12:00:00.000Z',
    sourceVersion: 2,
    targetVersion: 3,
    backupName,
    config,
    secrets,
  }), { mode: 0o600 });

  assert.deepEqual(await inspectStateFormat(paths), {
    status: 'migration-pending',
    detail: `state migration ${migrationId} from format 2 to 5 awaits recovery`,
  });
  let recoveredIdentity: { id: string; backupName: string; sourceVersion: number; targetVersion: number } | undefined;
  await ensureCurrentState(paths, {
    checkpoint(checkpoint, migration) {
      if (checkpoint === 'config-written') {
        recoveredIdentity = {
          id: migration.id,
          backupName: migration.backupName,
          sourceVersion: migration.sourceVersion,
          targetVersion: migration.targetVersion,
        };
      }
    },
  });

  assert.deepEqual(recoveredIdentity, { id: migrationId, backupName, sourceVersion: 2, targetVersion: 5 });
  assert.equal((await loadState(paths)).config.installationId, installationId);
  assert.equal(await readFile(join(paths.backups, backupName, 'marker'), 'utf8'), 'preserve me\n');
  await assert.rejects(stat(paths.migration), { code: 'ENOENT' });
});

test('pending version-3 lifecycle journal is backed up before normalization to version 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-pending-v3-lifecycle-'));
  const paths = statePaths(root);
  await mkdir(root, { recursive: true });
  const current = { paths, config: defaultConfig('00000000-0000-4000-8000-000000000420'), secrets: defaultSecrets() };
  const transaction = createStateTransaction('config', current);
  const legacy = {
    ...transaction,
    version: 3 as const,
    config: { ...transaction.config, version: 3 as const },
    secrets: { ...transaction.secrets, version: 3 as const },
  };
  const original = YAML.stringify(legacy);
  await writeFile(paths.journal, original, { mode: 0o600 });

  const normalized = await readPendingTransaction(paths);
  assert.equal(normalized?.version, 5);
  assert.equal(normalized?.config.version, 5);
  assert.equal(normalized?.secrets.version, 5);
  assert.equal(YAML.parse(await readFile(paths.journal, 'utf8')).version, 5);

  const backups = await readdir(paths.backups);
  assert.equal(backups.length, 1);
  const backup = join(paths.backups, backups[0]!);
  assert.equal(await readFile(join(backup, 'transaction.yaml'), 'utf8'), original);
  const manifest = YAML.parse(await readFile(join(backup, 'manifest.yaml'), 'utf8'));
  assert.equal(manifest.reason, 'lifecycle-journal');
  assert.equal(manifest.sourceVersion, 3);
  assert.equal(manifest.targetVersion, 5);
  assert.deepEqual(manifest.files['transaction.yaml'], fileDigest(original));
});

test('current state is not backed up again and newer state is never overwritten', async () => {
  const currentRoot = await mkdtemp(join(tmpdir(), 'qubicl-current-state-'));
  const currentPaths = statePaths(currentRoot);
  await mkdir(currentRoot, { recursive: true });
  await writeFile(currentPaths.config, YAML.stringify(defaultConfig()));
  await writeFile(currentPaths.secrets, YAML.stringify(defaultSecrets()), { mode: 0o600 });
  assert.equal(await ensureCurrentState(currentPaths), false);
  await assert.rejects(readdir(currentPaths.backups), { code: 'ENOENT' });

  const newerRoot = await mkdtemp(join(tmpdir(), 'qubicl-newer-state-'));
  const newerPaths = statePaths(newerRoot);
  await writeFile(newerPaths.config, YAML.stringify({ version: 99 }));
  await writeFile(newerPaths.secrets, YAML.stringify({ version: 99 }), { mode: 0o600 });
  await assert.rejects(ensureCurrentState(newerPaths), /newer than this Qubicl build/);
  assert.equal(YAML.parse(await readFile(newerPaths.config, 'utf8')).version, 99);
  assert.equal((await inspectStateFormat(newerPaths)).status, 'invalid');
});

test('version-2 state preserves identities and maps legacy full/custom images conservatively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-v2-migration-'));
  const paths = statePaths(root);
  await mkdir(root, { recursive: true });
  const createdAt = '2026-08-19T12:00:00.000Z';
  const config = {
    version: 2,
    installationId: '00000000-0000-4000-8000-000000000200',
    gatewayPort: 4321,
    nextName: 3,
    defaults: { image: 'qubicl/computer:dev', cpus: 2, memory: '4g' },
    computers: [
      { id: '00000000-0000-4000-8000-000000000201', name: 'official', image: 'qubicl/computer:dev', cpus: 2, memory: '4g', createdAt },
      { id: '00000000-0000-4000-8000-000000000202', name: 'custom', image: 'example/custom:old', cpus: 3, memory: '5g', createdAt },
    ],
  };
  const secrets = {
    version: 2,
    computers: Object.fromEntries(config.computers.map(({ id }) => [id, { token: `qubicl_${'t'.repeat(32)}`, internalKey: 'k'.repeat(32) }])),
  };
  const configRaw = YAML.stringify(config);
  const secretsRaw = YAML.stringify(secrets);
  await writeFile(paths.config, configRaw);
  await writeFile(paths.secrets, secretsRaw, { mode: 0o600 });
  const legacyMetadata = new Map<string, string>();
  for (const computer of config.computers) {
    const directory = join(paths.computers, computer.id);
    await mkdir(join(directory, 'home', 'qubicl'), { recursive: true, mode: 0o755 });
    const raw = YAML.stringify(computer);
    legacyMetadata.set(`active-${computer.id}-metadata.yaml`, raw);
    await writeFile(join(directory, 'metadata.yaml'), raw, { mode: 0o644 });
  }
  const trashed = {
    id: '00000000-0000-4000-8000-000000000299',
    name: 'deleted',
    image: 'example/custom:old',
    cpus: 2,
    memory: '4g',
    createdAt,
    deletedAt: '2026-08-19T13:00:00.000Z',
  };
  const trashDirectory = join(paths.trash, trashed.id);
  await mkdir(join(trashDirectory, 'home', 'qubicl'), { recursive: true, mode: 0o755 });
  const trashRaw = YAML.stringify(trashed);
  legacyMetadata.set(`trash-${trashed.id}-metadata.yaml`, trashRaw);
  await writeFile(join(trashDirectory, 'metadata.yaml'), trashRaw, { mode: 0o644 });

  await ensureCurrentState(paths);
  const migrated = await loadState(paths);
  assert.equal(migrated.config.version, 5);
  assert.equal(migrated.config.installationId, config.installationId);
  assert.equal(migrated.config.gateway.port, 4321);
  assert.equal(migrated.config.computers[0]?.preset, 'workstation');
  assert.equal(migrated.config.computers[0]?.image.requested, 'qubicl/computer:dev');
  assert.equal(migrated.config.computers[1]?.preset, 'custom');
  assert.equal(migrated.config.computers[1]?.compatibility, 'workstation');
  assert.equal(migrated.config.computers[1]?.image.resolved, 'example/custom:old');
  assert.equal(migrated.config.computers[1]?.cpus, 3);
  assert.equal(migrated.config.computers[1]?.memory, '5g');
  assert.deepEqual(migrated.secrets.computers, secrets.computers);
  for (const computer of migrated.config.computers) {
    const directory = join(paths.computers, computer.id);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'home'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'home', 'qubicl'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'metadata.yaml'))).mode & 0o777, 0o600);
    assert.deepEqual(YAML.parse(await readFile(join(directory, 'metadata.yaml'), 'utf8')), computer);
  }
  assert.equal((await stat(trashDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(trashDirectory, 'home'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(trashDirectory, 'metadata.yaml'))).mode & 0o777, 0o600);
  assert.equal(YAML.parse(await readFile(join(trashDirectory, 'metadata.yaml'), 'utf8')).preset, 'custom');
  const backups = await readdir(paths.backups);
  assert.equal(backups.length, 1);
  const backup = join(paths.backups, backups[0]!);
  assert.equal(await readFile(join(backup, 'config.yaml'), 'utf8'), configRaw);
  assert.equal(await readFile(join(backup, 'secrets.yaml'), 'utf8'), secretsRaw);
  for (const [name, raw] of legacyMetadata) assert.equal(await readFile(join(backup, name), 'utf8'), raw);
});

test('migration refuses a symlinked backup directory before changing state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-symlink-backup-'));
  const backupTarget = await mkdtemp(join(tmpdir(), 'qubicl-backup-target-'));
  const paths = statePaths(root);
  const { configRaw, secretsRaw } = await writeLegacyState(root);
  await symlink(backupTarget, paths.backups);

  await assert.rejects(ensureCurrentState(paths), /not a real directory/);
  assert.equal(await readFile(paths.config, 'utf8'), configRaw);
  assert.equal(await readFile(paths.secrets, 'utf8'), secretsRaw);
  assert.deepEqual(await readdir(backupTarget), []);
});

test('migration validates configured durable computer state before writing a backup or journal', async (context) => {
  const scenarios: Array<{
    name: string;
    prepare: (paths: ReturnType<typeof statePaths>, id: string) => Promise<void>;
    error: RegExp;
  }> = [
    {
      name: 'missing computer directory',
      prepare: async () => undefined,
      error: /Durable computer directories do not match config: missing:/,
    },
    {
      name: 'symlinked computer directory',
      prepare: async (paths, id) => {
        const target = await mkdtemp(join(tmpdir(), 'qubicl-migration-computer-target-'));
        await mkdir(paths.computers, { recursive: true });
        await symlink(target, join(paths.computers, id));
      },
      error: /not a real directory/,
    },
    {
      name: 'missing metadata file',
      prepare: async (paths, id) => {
        await mkdir(join(paths.computers, id, 'home', 'qubicl'), { recursive: true });
      },
      error: /Required durable file .*metadata\.yaml is missing/,
    },
  ];

  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'qubicl-migration-preflight-'));
      const fixture = await writeLegacyComputerState(root);
      await scenario.prepare(fixture.paths, fixture.id);

      await assert.rejects(ensureCurrentState(fixture.paths), scenario.error);
      assert.equal(await readFile(fixture.paths.config, 'utf8'), fixture.configRaw);
      assert.equal(await readFile(fixture.paths.secrets, 'utf8'), fixture.secretsRaw);
      await assert.rejects(stat(fixture.paths.migration), { code: 'ENOENT' });
      await assert.rejects(stat(fixture.paths.backups), { code: 'ENOENT' });
    });
  }
});

async function writeLegacyState(root: string): Promise<{ configRaw: string; secretsRaw: string }> {
  const paths = statePaths(root);
  await mkdir(root, { recursive: true });
  const currentConfig = defaultConfig();
  const configRaw = YAML.stringify({
    version: 1,
    gatewayPort: currentConfig.gateway.port,
    nextName: currentConfig.nextName,
    defaults: {
      image: 'qubicl/computer:dev',
      cpus: currentConfig.defaults.cpus,
      memory: currentConfig.defaults.memory,
    },
    computers: [],
  });
  const secretsRaw = YAML.stringify({ version: 1, computers: {} });
  await writeFile(paths.config, configRaw);
  await writeFile(paths.secrets, secretsRaw, { mode: 0o600 });
  return { configRaw, secretsRaw };
}

async function writeVersion3State(root: string): Promise<{
  configRaw: string;
  secretsRaw: string;
  installationId: string;
}> {
  const paths = statePaths(root);
  await mkdir(root, { recursive: true });
  const installationId = '00000000-0000-4000-8000-000000000403';
  const configRaw = YAML.stringify({ ...defaultConfig(installationId), version: 3 });
  const secretsRaw = YAML.stringify({ ...defaultSecrets(), version: 3 });
  await writeFile(paths.config, configRaw, { mode: 0o600 });
  await writeFile(paths.secrets, secretsRaw, { mode: 0o600 });
  return { configRaw, secretsRaw, installationId };
}

async function writeLegacyComputerState(root: string): Promise<{
  paths: ReturnType<typeof statePaths>;
  id: string;
  configRaw: string;
  secretsRaw: string;
}> {
  const paths = statePaths(root);
  const id = '00000000-0000-4000-8000-000000000301';
  const createdAt = '2026-08-19T12:00:00.000Z';
  const current = defaultConfig();
  const configRaw = YAML.stringify({
    version: 2,
    installationId: '00000000-0000-4000-8000-000000000300',
    gatewayPort: current.gateway.port,
    nextName: 2,
    defaults: { image: 'qubicl/computer:dev', cpus: 2, memory: '4g' },
    computers: [{ id, name: 'durable', image: 'qubicl/computer:dev', cpus: 2, memory: '4g', createdAt }],
  });
  const secretsRaw = YAML.stringify({
    version: 2,
    computers: { [id]: { token: `qubicl_${'t'.repeat(32)}`, internalKey: 'k'.repeat(32) } },
  });
  await mkdir(root, { recursive: true });
  await writeFile(paths.config, configRaw);
  await writeFile(paths.secrets, secretsRaw, { mode: 0o600 });
  return { paths, id, configRaw, secretsRaw };
}

function fileDigest(contents: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash('sha256').update(contents).digest('hex'),
    bytes: Buffer.byteLength(contents),
  };
}
