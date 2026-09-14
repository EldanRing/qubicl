import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { create as createTar } from 'tar';
import { ComputerConfigSchema, defaultConfig, defaultSecrets, type ComputerConfig, type RuntimeContainerBinding } from '@qubicl/core';
import {
  createBackup,
  pruneBackupsBySelector,
  pruneComputerBackups,
  recoverPendingBackupCreation,
  type BackupCreationJournal,
  type BackupCreationRuntime,
} from '../../packages/cli/dist/backups.js';
import { statePaths, type LoadedState } from '../../packages/cli/dist/state.js';

test('backup creation publishes a complete staged directory atomically', async () => {
  const fixture = await backupFixture();
  let stagedArchive = '';
  const runtime: BackupCreationRuntime = {
    observe: async () => ({ group: 'absent', status: 'absent', containers: [] }),
    docker: async () => { throw new Error('Docker mutation was not expected.'); },
    archive: async (_command, args) => {
      stagedArchive = args[1]!;
      assert.match(basename(dirname(stagedArchive)), /^\.creating-[0-9a-f-]+$/u);
      await createTar({ gzip: true, file: stagedArchive, cwd: args.at(-2)! }, ['.']);
      return '';
    },
  };

  const manifest = await createBackup(
    fixture.state,
    fixture.computer,
    { positionals: [], options: new Map([['stopped', true]]) },
    false,
    runtime,
  );

  const entries = await readdir(fixture.state.paths.backups);
  assert.deepEqual(entries, [manifest.id]);
  const finalDirectory = join(fixture.state.paths.backups, manifest.id);
  assert.equal((await stat(finalDirectory)).mode & 0o777, 0o700);
  assert.deepEqual([...await readFile(join(finalDirectory, manifest.archive)).then((bytes) => bytes.subarray(0, 2))], [0x1f, 0x8b]);
  assert.deepEqual(JSON.parse(await readFile(join(finalDirectory, 'manifest.json'), 'utf8')), manifest);
  await assert.rejects(stat(join(fixture.state.paths.runtime, 'backup-create.json')), { code: 'ENOENT' });
});

test('backup recovery unpauses only exact paused IDs and discards staging without promotion', async () => {
  const fixture = await backupFixture();
  const targets = pauseTargets();
  const journal = backupJournal(fixture.state, fixture.computer, targets);
  const staging = join(fixture.state.paths.backups, journal.stagingName);
  await mkdir(staging, { mode: 0o700 });
  await writeFile(join(staging, 'home.tar.gz'), 'incomplete capture', { mode: 0o600 });
  await writeJournal(fixture.state, journal);
  const calls: string[][] = [];
  const observations = [
    {
      group: 'inconsistent' as const,
      status: 'paused',
      containers: [{ ...targets[0]!, status: 'paused' }, { ...targets[1]!, status: 'running' }],
    },
    {
      group: 'complete' as const,
      status: 'running',
      containers: targets.map((target) => ({ ...target, status: 'running' })),
    },
  ];
  const runtime: BackupCreationRuntime = {
    observe: async () => observations.shift()!,
    docker: async (args) => { calls.push(args); return ''; },
    archive: async () => { throw new Error('Archive replay was not expected.'); },
  };

  assert.equal(await recoverPendingBackupCreation(fixture.state, runtime), true);
  assert.deepEqual(calls, [['unpause', targets[0]!.id]]);
  await assert.rejects(stat(staging), { code: 'ENOENT' });
  await assert.rejects(stat(join(fixture.state.paths.backups, journal.backupId)), { code: 'ENOENT' });
  await assert.rejects(stat(join(fixture.state.paths.runtime, 'backup-create.json')), { code: 'ENOENT' });
});

test('backup recovery preserves its journal unless the unpaused group becomes coherent', async () => {
  const fixture = await backupFixture();
  const targets = pauseTargets();
  const journal = backupJournal(fixture.state, fixture.computer, targets);
  const staging = join(fixture.state.paths.backups, journal.stagingName);
  await mkdir(staging, { mode: 0o700 });
  await writeJournal(fixture.state, journal);
  const calls: string[][] = [];
  const runtime: BackupCreationRuntime = {
    observe: async () => observations.shift()!,
    docker: async (args) => { calls.push(args); return ''; },
    archive: async () => { throw new Error('Archive replay was not expected.'); },
  };
  const observations = [
    {
      group: 'inconsistent' as const,
      status: 'paused',
      containers: [{ ...targets[0]!, status: 'paused' }, { ...targets[1]!, status: 'running' }],
    },
    {
      group: 'inconsistent' as const,
      status: 'running',
      containers: [{ ...targets[0]!, status: 'running' }, { ...targets[1]!, status: 'dead' }],
    },
  ];

  await assert.rejects(recoverPendingBackupCreation(fixture.state, runtime), /coherent running or stopped runtime/);
  assert.deepEqual(calls, [['unpause', targets[0]!.id]]);
  assert.equal((await stat(staging)).isDirectory(), true);
  assert.equal((await stat(join(fixture.state.paths.runtime, 'backup-create.json'))).isFile(), true);
});

test('backup recovery rejects a mixed running and exited group without changing it', async () => {
  const fixture = await backupFixture();
  const targets = pauseTargets();
  const journal = backupJournal(fixture.state, fixture.computer, targets);
  const staging = join(fixture.state.paths.backups, journal.stagingName);
  await mkdir(staging, { mode: 0o700 });
  await writeJournal(fixture.state, journal);
  let mutated = false;
  const runtime: BackupCreationRuntime = {
    observe: async () => ({
      group: 'inconsistent',
      status: 'running',
      containers: [{ ...targets[0]!, status: 'running' }, { ...targets[1]!, status: 'exited' }],
    }),
    docker: async () => { mutated = true; return ''; },
    archive: async () => { throw new Error('Archive replay was not expected.'); },
  };

  await assert.rejects(recoverPendingBackupCreation(fixture.state, runtime), /coherent running or stopped runtime/);
  assert.equal(mutated, false);
  assert.equal((await stat(staging)).isDirectory(), true);
  assert.equal((await stat(join(fixture.state.paths.runtime, 'backup-create.json'))).isFile(), true);
});

test('backup recovery accepts an exact group that was externally stopped coherently', async () => {
  const fixture = await backupFixture();
  const targets = pauseTargets();
  const journal = backupJournal(fixture.state, fixture.computer, targets);
  const staging = join(fixture.state.paths.backups, journal.stagingName);
  await mkdir(staging, { mode: 0o700 });
  await writeJournal(fixture.state, journal);
  let mutated = false;
  const runtime: BackupCreationRuntime = {
    observe: async () => ({
      group: 'complete',
      status: 'exited',
      containers: targets.map((target) => ({ ...target, status: 'exited' })),
    }),
    docker: async () => { mutated = true; return ''; },
    archive: async () => { throw new Error('Archive replay was not expected.'); },
  };

  assert.equal(await recoverPendingBackupCreation(fixture.state, runtime), true);
  assert.equal(mutated, false);
  await assert.rejects(stat(staging), { code: 'ENOENT' });
  await assert.rejects(stat(join(fixture.state.paths.runtime, 'backup-create.json')), { code: 'ENOENT' });
});

test('backup recovery preserves its journal and staging when immutable identity changed', async () => {
  const fixture = await backupFixture();
  const targets = pauseTargets().slice(0, 1);
  const journal = backupJournal(fixture.state, fixture.computer, targets);
  const staging = join(fixture.state.paths.backups, journal.stagingName);
  await mkdir(staging, { mode: 0o700 });
  await writeJournal(fixture.state, journal);
  let mutated = false;
  const runtime: BackupCreationRuntime = {
    observe: async () => ({
      group: 'complete',
      status: 'paused',
      containers: [{ ...targets[0]!, imageId: `sha256:${'f'.repeat(64)}`, status: 'paused' }],
    }),
    docker: async () => { mutated = true; return ''; },
    archive: async () => '',
  };

  await assert.rejects(recoverPendingBackupCreation(fixture.state, runtime), /could not prove immutable container/);
  assert.equal(mutated, false);
  assert.equal((await stat(staging)).isDirectory(), true);
  assert.equal((await stat(join(fixture.state.paths.runtime, 'backup-create.json'))).isFile(), true);
});

test('backup recovery verifies an already-published archive before clearing its journal', async () => {
  const fixture = await backupFixture();
  const runtime: BackupCreationRuntime = {
    observe: async () => ({ group: 'absent', status: 'absent', containers: [] }),
    docker: async () => '',
    archive: async (_command, args) => {
      await createTar({ gzip: true, file: args[1]!, cwd: args.at(-2)! }, ['.']);
      return '';
    },
  };
  const manifest = await createBackup(
    fixture.state,
    fixture.computer,
    { positionals: [], options: new Map([['stopped', true]]) },
    false,
    runtime,
  );
  const published = join(fixture.state.paths.backups, manifest.id);
  const operationId = '00000000-0000-4000-8000-000000000603';
  await writeJournal(fixture.state, {
    ...backupJournal(fixture.state, fixture.computer, []),
    operationId,
    backupId: manifest.id,
    stagingName: `.creating-${operationId}`,
    phase: 'resumed',
  });
  await writeFile(join(published, manifest.archive), 'changed archive', { mode: 0o600 });

  await assert.rejects(recoverPendingBackupCreation(fixture.state, runtime), /does not match its manifest/);
  assert.equal((await stat(join(fixture.state.paths.runtime, 'backup-create.json'))).isFile(), true);
  assert.equal((await stat(published)).isDirectory(), true);
});

test('backup pruning binds to immutable source identity and sorts ties deterministically', async () => {
  const fixture = await backupFixture();
  const other = ComputerConfigSchema.parse({
    ...fixture.computer,
    id: '00000000-0000-4000-8000-000000000604',
  });
  await Promise.all([
    writeManifest(fixture.state, fixture.computer, 'a-backup', '2026-09-07T12:00:00.000Z'),
    writeManifest(fixture.state, fixture.computer, 'b-backup', '2026-09-07T12:00:00.000Z'),
    writeManifest(fixture.state, other, 'other-source', '2026-09-08T12:00:00.000Z'),
  ]);

  const removed = await pruneComputerBackups(fixture.state, fixture.computer.id, 1);

  assert.deepEqual(removed.map(({ id }) => id), ['b-backup']);
  assert.equal((await stat(join(fixture.state.paths.backups, 'a-backup'))).isDirectory(), true);
  assert.equal((await stat(join(fixture.state.paths.backups, 'other-source'))).isDirectory(), true);
  await assert.rejects(stat(join(fixture.state.paths.backups, 'b-backup')), { code: 'ENOENT' });
});

test('backup pruning refuses an ambiguous reused historical name', async () => {
  const fixture = await backupFixture();
  const other = ComputerConfigSchema.parse({
    ...fixture.computer,
    id: '00000000-0000-4000-8000-000000000605',
  });
  await Promise.all([
    writeManifest(fixture.state, fixture.computer, 'first-identity', '2026-09-07T12:00:00.000Z'),
    writeManifest(fixture.state, other, 'second-identity', '2026-09-08T12:00:00.000Z'),
  ]);
  fixture.state.config.computers = [];

  await assert.rejects(
    pruneBackupsBySelector(fixture.state, fixture.computer.name, 1),
    /multiple historical computer IDs.*immutable source ID/,
  );
  assert.equal((await stat(join(fixture.state.paths.backups, 'first-identity'))).isDirectory(), true);
  assert.equal((await stat(join(fixture.state.paths.backups, 'second-identity'))).isDirectory(), true);

  const removed = await pruneBackupsBySelector(fixture.state, fixture.computer.id, 0);
  assert.deepEqual(removed.map(({ id }) => id), ['first-identity']);
  assert.equal((await stat(join(fixture.state.paths.backups, 'second-identity'))).isDirectory(), true);
});

test('backup pruning preserves a manifest with an invalid creation timestamp', async () => {
  const fixture = await backupFixture();
  await Promise.all([
    writeManifest(fixture.state, fixture.computer, 'valid-backup', '2026-09-07T12:00:00.000Z'),
    writeManifest(fixture.state, fixture.computer, 'invalid-backup', 'not-a-timestamp'),
  ]);

  const removed = await pruneComputerBackups(fixture.state, fixture.computer.id, 0);
  assert.deepEqual(removed.map(({ id }) => id), ['valid-backup']);
  assert.equal((await stat(join(fixture.state.paths.backups, 'invalid-backup'))).isDirectory(), true);
});

function pauseTargets(): RuntimeContainerBinding[] {
  return [
    {
      name: 'backup-source',
      id: 'a'.repeat(64),
      status: 'running',
      imageId: `sha256:${'c'.repeat(64)}`,
      role: 'computer',
      topologyVersion: '5',
    },
    {
      name: 'backup-source-executor',
      id: 'b'.repeat(64),
      status: 'running',
      imageId: `sha256:${'d'.repeat(64)}`,
      role: 'computer-executor',
    },
  ];
}

function backupJournal(
  state: LoadedState,
  computer: ComputerConfig,
  pauseTargets: RuntimeContainerBinding[],
): BackupCreationJournal {
  const operationId = '00000000-0000-4000-8000-000000000602';
  return {
    version: 1,
    operationId,
    installationId: state.config.installationId,
    computerId: computer.id,
    backupId: '2026-09-07T12-00-00-000Z-backup-source-deadbeef',
    stagingName: `.creating-${operationId}`,
    createdAt: '2026-09-07T12:00:00.000Z',
    phase: 'paused',
    pauseTargets,
  };
}

async function writeJournal(state: LoadedState, journal: BackupCreationJournal): Promise<void> {
  await writeFile(join(state.paths.runtime, 'backup-create.json'), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
}

async function writeManifest(
  state: LoadedState,
  source: ComputerConfig,
  id: string,
  createdAt: string,
): Promise<void> {
  const directory = join(state.paths.backups, id);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    version: 1,
    id,
    name: source.name,
    createdAt,
    source,
    archive: 'home.tar.gz',
    sha256: 'a'.repeat(64),
    encrypted: false,
    consistency: 'stopped',
  }), { mode: 0o600 });
}

async function backupFixture(): Promise<{ state: LoadedState; computer: ComputerConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-backup-creation-'));
  const paths = statePaths(root);
  const config = defaultConfig('00000000-0000-4000-8000-000000000600');
  const computer = ComputerConfigSchema.parse({
    id: '00000000-0000-4000-8000-000000000601',
    name: 'backup-source',
    createdAt: '2026-09-07T12:00:00.000Z',
    ...config.defaults,
  });
  config.computers.push(computer);
  const secrets = defaultSecrets();
  secrets.computers[computer.id] = { token: `qubicl_${'t'.repeat(32)}`, internalKey: 'k'.repeat(32) };
  await mkdir(join(paths.computers, computer.id, 'home'), { recursive: true, mode: 0o700 });
  await mkdir(paths.backups, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  return { state: { paths, config, secrets }, computer };
}
