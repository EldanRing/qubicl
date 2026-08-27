import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { presetDefaults, type ComputerConfig, type TransactionCheckpoint } from '../../packages/core/dist/index.js';
import { auditState, initializeState, loadState, newSecret, readMetadata, saveMetadata, saveState, statePaths, withStateLock } from '../../packages/cli/dist/state.js';
import { createStateTransaction, executeStateTransaction, prepareStateTransaction, readPendingTransaction, recoverPendingTransaction, restoreReadyMarker, restoreStage, type TransactionRuntime } from '../../packages/cli/dist/transactions.js';

const checkpoints: TransactionCheckpoint[] = [
  'journal-written',
  'active-ready',
  'config-written',
  'state-written',
  'runtime-rendered',
  'trash-ready',
  'state-committed',
  'docker-validated',
  'images-ready',
  'gateway-ready',
  'routes-removed',
  'runtime-removed',
  'computers-started',
  'routes-verified',
  'runtime-committed',
];

test('every transaction boundary recovers to one coherent final state', async (context) => {
  for (const interruptedAt of checkpoints) {
    await context.test(interruptedAt, async () => {
      const fixture = await transactionFixture();
      let interrupted = false;
      await assert.rejects(executeStateTransaction(fixture.paths, fixture.transaction, {
        runtime: fakeRuntime,
        checkpoint: (checkpoint) => {
          if (!interrupted && checkpoint === interruptedAt) {
            interrupted = true;
            throw new Error(`interrupt:${checkpoint}`);
          }
        },
      }), new RegExp(`interrupt:${interruptedAt}`));

      assert.equal((await stat(fixture.paths.journal)).mode & 0o777, 0o600);
      await recoverPendingTransaction(fixture.paths, { runtime: fakeRuntime });
      await assert.rejects(lstat(fixture.paths.journal), { code: 'ENOENT' });

      const recovered = await loadState(fixture.paths);
      assert.deepEqual(recovered.config, fixture.transaction.config);
      assert.deepEqual(recovered.secrets, fixture.transaction.secrets);
      assert.deepEqual((await readdir(fixture.paths.computers)).sort(), fixture.activeIds.sort());
      assert.deepEqual(await readdir(fixture.paths.trash), [fixture.deleted.id]);

      for (const computer of recovered.config.computers) {
        assert.deepEqual(await readMetadata(join(fixture.paths.computers, computer.id, 'metadata.yaml')), computer);
        assert.equal((await lstat(join(fixture.paths.computers, computer.id, 'home'))).isDirectory(), true);
      }
      const deletedMetadata = await readMetadata(join(fixture.paths.trash, fixture.deleted.id, 'metadata.yaml'));
      assert.equal(deletedMetadata.id, fixture.deleted.id);
      assert.equal(typeof deletedMetadata.deletedAt, 'string');
      assert.equal((await lstat(join(fixture.paths.trash, fixture.deleted.id, 'home'))).isDirectory(), true);
      await rm(fixture.paths.root, { recursive: true, force: true });
    });
  }
});

test('durable-only recovery leaves a committed journal for later Docker replay', async () => {
  const fixture = await transactionFixture();
  let interrupted = false;
  await assert.rejects(executeStateTransaction(fixture.paths, fixture.transaction, {
    runtime: fakeRuntime,
    checkpoint: (checkpoint) => {
      if (!interrupted && checkpoint === 'config-written') {
        interrupted = true;
        throw new Error('interrupt');
      }
    },
  }));
  await recoverPendingTransaction(fixture.paths, { includeRuntime: false, runtime: fakeRuntime });
  const journal = YAML.parse(await readFile(fixture.paths.journal, 'utf8'));
  assert.equal(journal.phase, 'state-committed');
  const recovered = await loadState(fixture.paths);
  assert.deepEqual(recovered.config, fixture.transaction.config);
  const journalCheck = (await auditState(recovered)).find(({ check }) => check === 'state-transaction-journal');
  assert.equal(journalCheck?.ok, false);
  assert.match(journalCheck?.detail ?? '', /state-committed.*awaiting recovery/);
  await recoverPendingTransaction(fixture.paths, { runtime: fakeRuntime });
  await assert.rejects(lstat(fixture.paths.journal), { code: 'ENOENT' });
  await rm(fixture.paths.root, { recursive: true, force: true });
});

test('an interrupted active-runtime replacement rolls forward without changing durable identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-upgrade-'));
  const paths = statePaths(root);
  const state = await initializeState(paths);
  const existing = computer('00000000-0000-4000-8000-000000000109', 'upgrade-test');
  state.config.computers.push(existing);
  state.secrets.computers[existing.id] = newSecret();
  const originalSecret = structuredClone(state.secrets.computers[existing.id]);
  await saveMetadata(paths, existing);
  await saveState(state);

  existing.image = { ...existing.image, requested: 'qubicl/workstation:new', resolved: 'qubicl/workstation:new' };
  const transaction = createStateTransaction('upgrade', state, {
    runtime: { startGateway: true, replaceIds: [existing.id], verifyTokenIds: [existing.id] },
  });
  let removals = 0;
  let starts = 0;
  let interrupted = false;
  const runtime: TransactionRuntime = {
    ...fakeRuntime,
    remove: async (_state, id) => { assert.equal(id, existing.id); removals += 1; },
    start: async (_state, computer) => { assert.equal(computer.id, existing.id); starts += 1; },
  };

  await assert.rejects(executeStateTransaction(paths, transaction, {
    runtime,
    checkpoint: (checkpoint) => {
      if (!interrupted && checkpoint === 'runtime-removed') {
        interrupted = true;
        throw new Error('interrupt:runtime-removed');
      }
    },
  }), /interrupt:runtime-removed/);
  await recoverPendingTransaction(paths, { runtime });

  const recovered = await loadState(paths);
  assert.equal(recovered.config.computers[0]?.id, existing.id);
  assert.equal(recovered.config.computers[0]?.image.resolved, 'qubicl/workstation:new');
  assert.deepEqual(recovered.secrets.computers[existing.id], originalSecret);
  assert.equal(removals, 2, 'recovery repeats the idempotent removal after the interruption');
  assert.equal(starts, 1);
  await assert.rejects(lstat(paths.journal), { code: 'ENOENT' });
  await rm(root, { recursive: true, force: true });
});

test('an interrupted backup extraction rolls back its journal and staged home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-backup-stage-'));
  const paths = statePaths(root);
  const persisted = await initializeState(paths);
  const restored = computer('00000000-0000-4000-8000-000000000119', 'restored-backup');
  const target = structuredClone(persisted);
  target.config.computers.push(restored);
  target.secrets.computers[restored.id] = newSecret();
  const transaction = createStateTransaction('backup-restore', target, {
    activeSources: { [restored.id]: 'staged' },
  });
  await prepareStateTransaction(paths, transaction);
  const stagedHome = join(restoreStage(paths, restored.id), 'home');
  await mkdir(stagedHome, { recursive: true, mode: 0o700 });
  await writeFile(join(stagedHome, 'partial.txt'), 'partial');

  assert.equal(await recoverPendingTransaction(paths, { includeRuntime: false }), true);
  await assert.rejects(lstat(paths.journal), { code: 'ENOENT' });
  await assert.rejects(lstat(restoreStage(paths, restored.id)), { code: 'ENOENT' });
  assert.deepEqual((await loadState(paths)).config.computers, []);
  await rm(root, { recursive: true, force: true });
});

test('a completed backup stage rolls forward atomically after interruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-backup-ready-'));
  const paths = statePaths(root);
  const target = await initializeState(paths);
  const restored = computer('00000000-0000-4000-8000-000000000120', 'restored-backup');
  target.config.computers.push(restored);
  target.secrets.computers[restored.id] = newSecret();
  const transaction = createStateTransaction('backup-restore', target, {
    activeSources: { [restored.id]: 'staged' },
  });
  await prepareStateTransaction(paths, transaction);
  const stagedHome = join(restoreStage(paths, restored.id), 'home');
  await mkdir(stagedHome, { recursive: true, mode: 0o700 });
  await writeFile(join(stagedHome, 'durable.txt'), 'restored');
  await writeFile(restoreReadyMarker(paths, restored.id), 'ready\n', { mode: 0o600 });

  await recoverPendingTransaction(paths, { includeRuntime: false });
  const active = join(paths.computers, restored.id);
  assert.equal(await readFile(join(active, 'home', 'durable.txt'), 'utf8'), 'restored');
  await assert.rejects(lstat(join(active, '.qubicl-restore-ready')), { code: 'ENOENT' });
  assert.deepEqual((await loadState(paths)).config.computers.map(({ id }) => id), [restored.id]);
  await assert.rejects(lstat(paths.journal), { code: 'ENOENT' });
  await rm(root, { recursive: true, force: true });
});

test('a pending setup journal reconnects an existing running computer without starting it through Compose', async () => {
  const fixture = await transactionFixture();
  const existingId = fixture.activeIds[0]!;
  const transaction = structuredClone(fixture.transaction);
  transaction.operation = 'setup';
  transaction.phase = 'state-committed';
  transaction.runtime = {
    ensureImages: false,
    startGateway: true,
    reconnectIds: [],
    replaceIds: [],
    // Journals written before reconnectIds existed stored this in startIds.
    startIds: [existingId],
    removeIds: [],
    verifyTokenIds: [],
  };
  const legacyDocument = structuredClone(transaction) as unknown as { runtime: { reconnectIds?: string[] } };
  delete legacyDocument.runtime.reconnectIds;
  await writeFile(fixture.paths.journal, YAML.stringify(legacyDocument), { mode: 0o600 });
  const reconnected: string[] = [];
  const started: string[] = [];
  await recoverPendingTransaction(fixture.paths, {
    runtime: {
      ...fakeRuntime,
      reconnect: async (_state, computer) => { reconnected.push(computer.id); },
      start: async (_state, computer) => { started.push(computer.id); },
    },
  });
  assert.deepEqual(reconnected, [existingId]);
  assert.deepEqual(started, []);
  assert.deepEqual(await readdir(fixture.paths.backups), [], 'a schema-compatible v3 default is not treated as a version migration');
  await assert.rejects(lstat(fixture.paths.journal), { code: 'ENOENT' });
  await rm(fixture.paths.root, { recursive: true, force: true });
});

test('a fresh lock owned by a dead PID is reclaimed immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-dead-lock-'));
  const paths = statePaths(root);
  await initializeState(paths);
  await writeFile(paths.lock, JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() }), { mode: 0o600 });
  let ran = false;
  await withStateLock(paths, async () => { ran = true; });
  assert.equal(ran, true);
  await assert.rejects(lstat(paths.lock), { code: 'ENOENT' });
  await assert.rejects(lstat(`${paths.lock}.reclaim`), { code: 'ENOENT' });
  await rm(root, { recursive: true, force: true });
});

test('state lock release preserves a replacement lock it does not own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-lock-ownership-'));
  const paths = statePaths(root);
  await initializeState(paths);
  const replacement = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: 'replacement-owner',
  });

  await withStateLock(paths, async () => {
    const owner = JSON.parse(await readFile(paths.lock, 'utf8')) as { pid?: unknown; nonce?: unknown };
    assert.equal(owner.pid, process.pid);
    assert.match(String(owner.nonce), /^[A-Za-z0-9_-]{32}$/);
    await rename(paths.lock, `${paths.lock}.original`);
    await writeFile(paths.lock, replacement, { mode: 0o600 });
  });

  assert.equal(await readFile(paths.lock, 'utf8'), replacement);
  await rm(root, { recursive: true, force: true });
});

test('a pending version-1 lifecycle journal is backed up, upgraded, and recovered', async () => {
  const fixture = await transactionFixture();
  const legacy = {
    version: 1,
    id: fixture.transaction.id,
    operation: fixture.transaction.operation,
    createdAt: fixture.transaction.createdAt,
    phase: fixture.transaction.phase,
    config: {
      version: 1,
      gatewayPort: fixture.transaction.config.gateway.port,
      nextName: fixture.transaction.config.nextName,
      defaults: {
        image: fixture.transaction.config.defaults.image.requested,
        cpus: fixture.transaction.config.defaults.cpus,
        memory: fixture.transaction.config.defaults.memory,
      },
      computers: fixture.transaction.config.computers.map(legacyComputer),
    },
    secrets: { version: 1, computers: fixture.transaction.secrets.computers },
    active: fixture.transaction.active.map((entry) => ({ source: entry.source, metadata: legacyComputer(entry.metadata) })),
    trash: fixture.transaction.trash.map((entry) => ({ metadata: { ...legacyComputer(entry.metadata), deletedAt: entry.metadata.deletedAt } })),
    runtime: fixture.transaction.runtime,
  };
  const contents = YAML.stringify(legacy);
  await writeFile(fixture.paths.journal, contents, { mode: 0o600 });

  const pending = await readPendingTransaction(fixture.paths);
  assert.equal(pending?.version, 3);
  assert.equal(pending?.config.installationId, fixture.transaction.id);
  assert.equal(YAML.parse(await readFile(fixture.paths.journal, 'utf8')).version, 3);
  const backups = await readdir(fixture.paths.backups);
  const transactionBackups = await Promise.all(backups.map(async (name) => {
    try { return await readFile(join(fixture.paths.backups, name, 'transaction.yaml'), 'utf8'); }
    catch { return undefined; }
  }));
  assert.ok(transactionBackups.includes(contents));

  await recoverPendingTransaction(fixture.paths, { runtime: fakeRuntime });
  const recovered = await loadState(fixture.paths);
  assert.equal(recovered.config.version, 3);
  assert.equal(recovered.config.installationId, fixture.transaction.id);
  await assert.rejects(lstat(fixture.paths.journal), { code: 'ENOENT' });
  await rm(fixture.paths.root, { recursive: true, force: true });
});

async function transactionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-transaction-'));
  const paths = statePaths(root);
  const state = await initializeState(paths);
  const existing = computer('00000000-0000-4000-8000-000000000101', 'existing');
  const deleted = computer('00000000-0000-4000-8000-000000000102', 'deleted');
  const restored = computer('00000000-0000-4000-8000-000000000103', 'restored');
  state.config.computers.push(existing, deleted);
  state.secrets.computers[existing.id] = newSecret();
  state.secrets.computers[deleted.id] = newSecret();
  await saveMetadata(paths, existing);
  await saveMetadata(paths, deleted);
  await saveMetadata(paths, { ...restored, deletedAt: new Date().toISOString() });
  await rename(join(paths.computers, restored.id), join(paths.trash, restored.id));
  await saveState(state);

  existing.name = 'updated';
  existing.cpus = 3;
  const created = computer('00000000-0000-4000-8000-000000000104', 'created');
  state.config.computers = [existing, restored, created];
  delete state.secrets.computers[deleted.id];
  state.secrets.computers[restored.id] = newSecret();
  state.secrets.computers[created.id] = newSecret();
  const deletedMetadata = { ...deleted, deletedAt: new Date().toISOString() };
  const transaction = createStateTransaction('apply', state, {
    activeSources: { [restored.id]: 'trash', [created.id]: 'create' },
    trash: [deletedMetadata],
    runtime: {
      ensureImages: true,
      startGateway: true,
      startIds: [existing.id, restored.id, created.id],
      removeIds: [deleted.id],
      verifyTokenIds: [existing.id],
    },
  });
  return { paths, transaction, deleted, activeIds: [existing.id, restored.id, created.id] };
}

function computer(id: string, name: string): ComputerConfig {
  return { id, name, createdAt: '2026-08-19T12:00:00.000Z', ...presetDefaults('workstation') };
}

function legacyComputer(computer: ComputerConfig): { id: string; name: string; image: string; cpus: number; memory: string; createdAt: string } {
  return {
    id: computer.id,
    name: computer.name,
    image: computer.image.requested,
    cpus: computer.cpus,
    memory: computer.memory,
    createdAt: computer.createdAt,
  };
}

const fakeRuntime: TransactionRuntime = {
  validate: async () => undefined,
  ensureImages: async () => undefined,
  startGateway: async () => undefined,
  reconnect: async () => undefined,
  waitForRemoval: async () => undefined,
  remove: async () => undefined,
  start: async () => undefined,
  verifyToken: async () => undefined,
};
