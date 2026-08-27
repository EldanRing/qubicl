import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { defaultConfig, defaultSecrets } from '@qubicl/core';
import {
  ensureCurrentState,
  inspectStateFormat,
  type StateMigrationCheckpoint,
} from '../../packages/cli/dist/migrations.js';
import { loadState, statePaths } from '../../packages/cli/dist/state.js';

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
      assert.equal(state.config.version, 3);
      assert.match(state.config.installationId, /^[0-9a-f-]{36}$/);
      assert.equal(state.secrets.version, 3);
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
          assert.equal(manifest.targetVersion, 3);
          assert.deepEqual(manifest.files['config.yaml'], fileDigest(configRaw));
          assert.deepEqual(manifest.files['secrets.yaml'], fileDigest(secretsRaw));
          exactBackupFound = true;
        }
      }
      assert.equal(exactBackupFound, true);
    });
  }
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
  assert.equal(migrated.config.version, 3);
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
