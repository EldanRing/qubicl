import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presetDefaults } from '../../packages/core/dist/index.js';
import { ManagementApplication, managementInterruptionRequired, managementPreviewUrl, validateManagementRequest, type ManagementBackend, type ManagementTimer, type ManagementTiming } from '../../packages/cli/dist/dashboard/application.js';
import { initializeState, newSecret, saveState, statePaths } from '../../packages/cli/dist/state.js';

async function fixture(backend: Partial<ManagementBackend> = {}, timing?: ManagementTiming) {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-dashboard-operation-'));
  const app = new ManagementApplication(root, {
    fingerprint: async () => 'revision-one', query: async () => ({}),
    preview: async () => ({ effects: ['Example operation'], warnings: [], requiresInterruption: false }),
    run: async () => undefined, ...backend,
  }, timing);
  await app.initialize();
  return { app, root, close: () => rm(root, { recursive: true, force: true }) };
}

function manualTiming(start = Date.parse('2026-09-08T00:00:00.000Z')): ManagementTiming & { advance(milliseconds: number): void; unrefCount(): number } {
  interface Scheduled extends ManagementTimer { at: number; action: () => void; cancelled: boolean; unreferenced: boolean }
  let now = start;
  const scheduled: Scheduled[] = [];
  return {
    now: () => now,
    setTimeout: (action, delay) => {
      const timer: Scheduled = { at: now + delay, action, cancelled: false, unreferenced: false, unref: () => { timer.unreferenced = true; } };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { (timer as Scheduled).cancelled = true; },
    advance: (milliseconds) => {
      now += milliseconds;
      for (;;) {
        const due = scheduled.filter(({ at, cancelled }) => !cancelled && at <= now).sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        due.cancelled = true;
        due.action();
      }
    },
    unrefCount: () => scheduled.filter(({ unreferenced }) => unreferenced).length,
  };
}
async function finished(app: ManagementApplication, id: string) {
  for (let attempts = 0; attempts < 100; attempts++) {
    const job = await app.operation(id);
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Operation failed to finish.');
}

test('management rejects arbitrary commands, host paths, and unpinned skill imports', () => {
  assert.throws(() => validateManagementRequest({ operation: 'shell', input: { command: 'id' } }));
  assert.throws(() => validateManagementRequest({ operation: 'backup.restore', target: '../../outside' }));
  assert.throws(() => validateManagementRequest({ operation: 'skill.import', input: { url: 'file:///home/user', commit: 'main' } }));
  assert.throws(() => validateManagementRequest({ operation: 'computer.create', input: { name: 'safe', mount: '/host' } }));
});

test('plans are session-bound, detect drift, and never run rejected work', async () => {
  let revision = 'one'; let runs = 0;
  const { app, close } = await fixture({ fingerprint: async () => revision, run: async () => { runs++; } });
  try {
    const plan = await app.plan({ operation: 'computer.start', target: 'example' }, 'owner');
    await assert.rejects(app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'other', true), /fresh plan/);
    revision = 'two';
    await assert.rejects(app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true), /changed/);
    assert.equal(runs, 0);
  } finally { await close(); }
});

test('sensitive plans expire on an unreferenced timer and scrub retained input without another plan', async () => {
  const timing = manualTiming();
  let retained: Parameters<ManagementBackend['preview']>[0] | undefined;
  const { app, close } = await fixture({
    preview: async (request) => {
      retained = request;
      return { effects: [], warnings: [], requiresInterruption: false };
    },
  }, timing);
  try {
    const plan = await app.plan({ operation: 'credential.add', target: 'example', input: { id: 'test', value: 'timer-secret', baseUrl: 'https://example.com' } }, 'owner');
    assert.equal(retained?.input?.value, 'timer-secret');
    assert.equal(timing.unrefCount(), 1);
    timing.advance(300000);
    assert.deepEqual(retained?.input, {});
    await assert.rejects(app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true), /fresh plan/);
  } finally { await close(); }
});

test('permanently stale sensitive plans scrub input while retryable reauthentication keeps the plan', async () => {
  let revision = 'one';
  let retained: Parameters<ManagementBackend['preview']>[0] | undefined;
  const { app, close } = await fixture({
    fingerprint: async () => revision,
    preview: async (request) => {
      retained = request;
      return { effects: [], warnings: [], requiresInterruption: false };
    },
  });
  try {
    const plan = await app.plan({ operation: 'credential.add', target: 'example', input: { id: 'test', value: 'stale-secret', baseUrl: 'https://example.com' } }, 'owner');
    await assert.rejects(app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', false), /administrator password/);
    assert.equal(retained?.input?.value, 'stale-secret');
    revision = 'two';
    await assert.rejects(app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true), /changed/);
    assert.deepEqual(retained?.input, {});
  } finally { await close(); }
});

test('a plan that expires during final fingerprint validation is scrubbed before durable acceptance', async () => {
  const timing = manualTiming();
  let fingerprintCalls = 0;
  let releaseFingerprint!: () => void;
  let validationStarted!: () => void;
  let retained: Parameters<ManagementBackend['preview']>[0] | undefined;
  const barrier = new Promise<void>((resolve) => { releaseFingerprint = resolve; });
  const started = new Promise<void>((resolve) => { validationStarted = resolve; });
  let runs = 0;
  const { app, close } = await fixture({
    fingerprint: async () => {
      fingerprintCalls += 1;
      if (fingerprintCalls > 1) { validationStarted(); await barrier; }
      return 'one';
    },
    preview: async (request) => {
      retained = request;
      return { effects: [], warnings: [], requiresInterruption: false };
    },
    run: async () => { runs += 1; },
  }, timing);
  try {
    const plan = await app.plan({ operation: 'credential.add', target: 'example', input: { id: 'test', value: 'deadline-secret', baseUrl: 'https://example.com' } }, 'owner');
    const execution = app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true);
    await started;
    timing.advance(300000);
    releaseFingerprint();
    await assert.rejects(execution, /fresh plan/);
    assert.deepEqual(retained?.input, {});
    assert.equal(runs, 0);
  } finally { releaseFingerprint(); await close(); }
});

test('cloning a running source requires explicit interruption confirmation before execution', async () => {
  let runs = 0;
  const { app, close } = await fixture({
    preview: async ({ operation }) => ({ effects: [], warnings: [], requiresInterruption: managementInterruptionRequired(operation, 'running') }),
    run: async () => { runs += 1; },
  });
  try {
    const plan = await app.plan({ operation: 'computer.clone', target: 'example', input: { name: 'copy' } }, 'owner');
    assert.equal(plan.requiresInterruption, true);
    await assert.rejects(app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true), /Confirm interruption/);
    assert.equal(runs, 0);
    const accepted = await app.execute(plan.id, { idempotencyKey: 'test-key-00000001', confirmInterruption: true }, 'owner', true);
    await finished(app, accepted.operationId);
    assert.equal(runs, 1);
    assert.equal(managementInterruptionRequired('computer.clone', 'exited'), false);
  } finally { await new Promise((resolve) => setTimeout(resolve, 20)); await close(); }
});

test('accepted work survives browser request completion and retries execute once', async () => {
  let finish!: () => void; let runs = 0;
  const barrier = new Promise<void>((resolve) => { finish = resolve; });
  const { app, close } = await fixture({ run: async () => { runs++; await barrier; } });
  try {
    const plan = await app.plan({ operation: 'computer.start', target: 'example' }, 'owner');
    const first = await app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true);
    const again = await app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true);
    assert.deepEqual(again, first); assert.equal(runs, 1);
    const competing = await app.plan({ operation: 'computer.stop', target: 'example' }, 'owner');
    await assert.rejects(app.execute(competing.id, { idempotencyKey: 'test-key-00000002' }, 'owner', true), /running/);
    finish(); assert.equal((await finished(app, first.operationId)).status, 'succeeded');
  } finally { finish(); await new Promise((resolve) => setTimeout(resolve, 20)); await close(); }
});

test('sensitive plans require reauthentication and never persist input credentials', async () => {
  let acceptedRequest: Parameters<ManagementBackend['run']>[0] | undefined;
  const { app, root, close } = await fixture({ run: async (request) => { acceptedRequest = request; } });
  try {
    const value = 'private-test-value-never-record';
    const plan = await app.plan({ operation: 'credential.add', target: 'example', input: { id: 'test', value, baseUrl: 'https://example.com' } }, 'owner');
    assert.equal(JSON.stringify(plan).includes(value), false);
    await assert.rejects(app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', false), /administrator password/);
    const accepted = await app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true);
    await finished(app, accepted.operationId);
    assert.deepEqual(acceptedRequest?.input, {});
    assert.deepEqual(await app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true), accepted);
    for (const file of await readdir(join(root, 'dashboard', 'operations'))) {
      assert.equal((await readFile(join(root, 'dashboard', 'operations', file), 'utf8')).includes(value), false);
    }
  } finally { await new Promise((resolve) => setTimeout(resolve, 20)); await close(); }
});

test('isolated preview handoff uses its local or remote preview origin and rejects hostile runtime paths', () => {
  const computerId = '123e4567-e89b-42d3-a456-426614174000';
  const previewId = 'abcdefghijklmnop';
  const ticket = 't'.repeat(43);
  const path = `/computers/${computerId}/previews/${previewId}/?ticket=${ticket}`;
  assert.equal(
    managementPreviewUrl({ previewBase: `http://preview-${computerId}.localhost:3211/computers/${computerId}/previews` }, computerId, previewId, path),
    `http://preview-${computerId}.localhost:3211${path}`,
  );
  assert.equal(
    managementPreviewUrl({ previewBase: `https://preview-${computerId}.preview.example.test/computers/${computerId}/previews` }, computerId, previewId, path),
    `https://preview-${computerId}.preview.example.test${path}`,
  );
  assert.throws(() => managementPreviewUrl({}, computerId, previewId, path), /isolated remote preview domain/);
  for (const hostile of [
    `https://attacker.example/${computerId}/previews/${previewId}/?ticket=${ticket}`,
    `//attacker.example/computers/${computerId}/previews/${previewId}/?ticket=${ticket}`,
    `/computers/${computerId}/previews/${previewId}/../../view?ticket=${ticket}`,
    `/computers/${computerId}/previews/${previewId}/?ticket=${ticket}&redirect=https://attacker.example`,
    `/computers/${computerId}/previews/${previewId}/?ticket=${ticket}#attacker`,
  ]) assert.throws(() => managementPreviewUrl({ previewBase: `https://preview-${computerId}.preview.example.test/computers/${computerId}/previews` }, computerId, previewId, hostile), /invalid/);
});

test('management preview action hands a loopback operator ticket to the isolated local preview host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-dashboard-preview-action-'));
  const state = await initializeState(statePaths(root));
  const computer = { ...presetDefaults('workstation'), id: randomUUID(), name: 'preview-action', createdAt: new Date().toISOString() };
  state.config.computers.push(computer);
  state.secrets.computers[computer.id] = newSecret();
  await saveState(state);
  const previewId = 'abcdefghijklmnop';
  const ticket = 't'.repeat(43);
  const path = `/computers/${computer.id}/previews/${previewId}/?ticket=${ticket}`;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input, init) => {
      assert.equal(String(input), `http://127.0.0.1:${state.config.gateway.port}/computers/${computer.id}/operator/management/previews/open`);
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { previewId, access: 'local' });
      return new Response(JSON.stringify({ path }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const result = await new ManagementApplication(root).action(`/computers/${computer.id}/previews/${previewId}/open`, { access: 'local' }, 'owner') as { url: string };
    assert.equal(result.url, `http://preview-${computer.id}.localhost:${state.config.gateway.port}${path}`);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('acceptance receipts survive helper restart without replaying completed or interrupted work', async () => {
  let runs = 0;
  const backend: ManagementBackend = { fingerprint: async () => 'one', query: async () => ({}), preview: async () => ({ effects: [], warnings: [], requiresInterruption: false }), run: async () => { runs++; } };
  const { app, root, close } = await fixture(backend);
  try {
    const plan = await app.plan({ operation: 'computer.start', target: 'example' }, 'owner');
    const accepted = await app.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true);
    await finished(app, accepted.operationId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const interrupted = randomUUID(); const interruptedPlan = randomUUID(); const now = new Date().toISOString();
    await writeFile(join(root, 'dashboard', 'operations', `${interrupted}.json`), JSON.stringify({ schemaVersion: 1, job: { id: interrupted, operation: 'computer.stop', target: 'example', status: 'running', createdAt: now, updatedAt: now, message: 'Operation accepted.' }, acceptance: { keyHash: createHash('sha256').update('owner:test-key-00000002').digest('hex'), planId: interruptedPlan } }), { mode: 0o600 });
    const resumed = new ManagementApplication(root, backend); await resumed.initialize();
    assert.deepEqual(await resumed.execute(plan.id, { idempotencyKey: 'test-key-00000001' }, 'owner', true), accepted);
    assert.equal((await resumed.operation(interrupted)).status, 'failed');
    assert.equal(runs, 1);
  } finally { await close(); }
});

test('invalid management values fail before any operation preview or execution', () => {
  for (const input of [
    { operation: 'computer.resources', target: 'example', input: { cpus: '4' } },
    { operation: 'computer.create', input: { name: 'bad name', preset: 'computer' } },
    { operation: 'network.approve', target: 'example', input: { domain: 'example.com', duration: 86401 } },
    { operation: 'backup.prune', target: 'example', input: { keep: 0 } },
    { operation: 'credential.add', target: 'example', input: { id: 'test', baseUrl: 'https://secret@example.com', value: 'private-value' } },
  ]) assert.throws(() => validateManagementRequest(input));
});

test('restored activity, snapshot and event history use creation time rather than UUID order', async () => {
  const { root, close } = await fixture();
  try {
    const records = [
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-09-02T00:00:00.000Z' },
    ];
    for (const record of records) {
      await writeFile(join(root, 'dashboard', 'operations', `${record.id}.json`), JSON.stringify({
        schemaVersion: 1,
        job: { ...record, updatedAt: record.createdAt, operation: 'computer.start', status: 'succeeded', message: 'Operation completed.' },
        acceptance: { keyHash: createHash('sha256').update(record.id).digest('hex'), planId: record.id },
      }), { mode: 0o600 });
    }
    const restored = new ManagementApplication(root, { fingerprint: async () => 'one', query: async () => ({}), preview: async () => ({ effects: [], warnings: [], requiresInterruption: false }), run: async () => undefined });
    await restored.initialize();
    const expected = records.toReversed().map(({ id }) => id);
    const activity = await restored.query('activity') as { items: Array<{ id: string }> };
    const snapshot = await restored.query('snapshot') as { operations: Array<{ id: string }> };
    assert.deepEqual(activity.items.map(({ id }) => id), expected);
    assert.deepEqual(snapshot.operations.map(({ id }) => id), expected);
    const controller = new AbortController();
    const events = restored.events(controller.signal)[Symbol.asyncIterator]();
    const event = await events.next();
    assert.deepEqual((event.value!.data as { operations: Array<{ id: string }> }).operations.map(({ id }) => id), expected);
    controller.abort(); await events.return?.();
  } finally { await close(); }
});
