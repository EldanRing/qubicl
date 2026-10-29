import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessManager, type ManagementProcessSummary } from '../../packages/control/dist/processes.js';
import { RemoteProcessManager } from '../../packages/control/dist/remote-runners.js';

const owner = { id: 'service-lifecycle', generation: 1, epoch: 'service-lifecycle' };

test('saved services beyond concurrency queue visibly, reserve available slots, and can be stopped before launch', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-service-queue-'));
  let restored: ProcessManager | undefined;
  context.after(async () => {
    if (restored) await restored.stopAllForManagement();
    await rm(home, { recursive: true, force: true });
  });
  const options = { home, outputDirectory: home, persistTaskRecords: true, maxProcesses: 1 };
  const original = new ProcessManager(options);
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const service = await original.exec(`if [ -f marker-${index} ]; then read value; else : > marker-${index}; fi`, home, 1000, 1024, owner, undefined, 'combined', 'service', `saved-${index}`);
    assert.equal(service.running, false);
    ids.push(service.processId);
  }
  assert.equal(original.count(), 0);
  assert.equal((await readdir(join(home, 'services'))).length, 3);

  restored = new ProcessManager(options);
  const manager = restored;
  ids.sort();
  assert.equal(restored.count(), 1);
  assert.equal(restored.listForAgent().find(({ id }) => id === ids[0])?.status, 'running');
  assert.equal(restored.listForAgent().filter(({ status }) => status === 'queued').length, 2);
  const queued = await restored.write(ids[1]!, '', false, 0, owner);
  assert.equal(queued.running, false);
  assert.equal(queued.terminalState, 'queued');
  assert.equal(queued.service?.state, 'queued');
  await assert.rejects(manager.write(ids[1]!, 'premature input', false, 0, owner), { code: 'process_not_running' });
  assert.throws(() => manager.readOutput(ids[1]!, 0, 100, undefined, 'utf8'), { code: 'process_output_unavailable' });
  await restored.stopForManagement(ids[2]!);
  await assert.rejects(stat(join(home, 'services', `${ids[2]}.json`)), { code: 'ENOENT' });
  assert.equal(restored.listForManagement().some(({ id }) => id === ids[2]), false);

  await restored.stopForManagement(ids[0]!);
  assert.equal(restored.count(), 1, 'the waiting service claims the released slot before new work');
  assert.equal(restored.listForManagement().find(({ id }) => id === ids[1])?.status, 'running');
  await assert.rejects(restored.exec('printf must-not-start', home, 0, 1024, owner), { code: 'process_limit' });
  await restored.stop(ids[1]!, { ...owner, generation: 2 });
  assert.equal(restored.count(), 0);
  assert.deepEqual(await readdir(join(home, 'services')), []);
  assert.deepEqual(new ProcessManager(options).listForManagement(), []);
});

for (const operation of ['stop-all', 'shutdown'] as const) {
  test(`${operation} freezes queued work before stopping live services`, async (context) => {
    const home = await mkdtemp(join(tmpdir(), 'qubicl-service-bulk-'));
    const managers: ProcessManager[] = [];
    context.after(async () => {
      for (const manager of managers) await manager.shutdown();
      await rm(home, { recursive: true, force: true });
    });
    const options = { home, outputDirectory: home, persistTaskRecords: true, maxProcesses: 1 };
    assert.deepEqual(new ProcessManager(options).listForManagement(), []);
    const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd'];
    for (const [index, id] of ids.entries()) {
      const command = index === 0 ? 'exit 7' : `: > started-${id}; read value`;
      await writeFile(join(home, 'services', `${id}.json`), JSON.stringify({ version: 1, id, label: id, command, cwd: home, maxOutputBytes: 1024, outputMode: 'combined', ownerGeneration: 1 }), { mode: 0o600 });
    }
    const manager = new ProcessManager(options);
    managers.push(manager);
    assert.equal((await manager.write(ids[0]!, '', false, 1000, owner)).exitCode, 7);
    const waiting = manager.listForManagement().filter(({ status }) => status === 'queued');
    assert.equal(waiting.length, 2);
    const stopping = operation === 'stop-all' ? manager.stopAllForManagement() : manager.shutdown();
    await assert.rejects(manager.exec('printf must-not-start', home, 0, 1024, owner), { code: 'process_admission_paused' });
    const result = await stopping;
    assert.equal(manager.count(), 0);
    for (const { id } of waiting) await assert.rejects(stat(join(home, `started-${id}`)), { code: 'ENOENT' });
    if (operation === 'stop-all') {
      assert.deepEqual(result, { stopped: 4 });
      assert.deepEqual(await readdir(join(home, 'services')), []);
      assert.deepEqual(manager.listForManagement(), []);
      assert.equal((await manager.exec('printf resumed', home, 1000, 1024, owner)).output, 'resumed');
    } else {
      assert.equal((await readdir(join(home, 'services'))).length, 4, 'shutdown must keep restart definitions');
      await assert.rejects(manager.exec('printf still-must-not-start', home, 0, 1024, owner), { code: 'process_admission_paused' });
      const restarted = new ProcessManager(options);
      managers.push(restarted);
      assert.equal(restarted.count(), 1, 'a new runtime can restore the preserved service set');
      assert.equal((await restarted.stopAllForManagement()).stopped, 4);
    }
  });
}

test('polling completed services retains their visible record and definition until explicitly stopped', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-service-poll-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const options = { home, outputDirectory: home, persistTaskRecords: true, maxProcesses: 1 };
  const manager = new ProcessManager(options);
  const service = await manager.exec('printf retained-output; exit 7', home, 1000, 1024, owner, undefined, 'combined', 'service', 'finished');
  assert.equal(service.running, false);
  for (let index = 0; index < 2; index += 1) {
    const polled = await manager.write(service.processId, '', false, 0, { ...owner, generation: 2 });
    assert.equal(polled.running, false);
    assert.equal(polled.exitCode, 7);
    assert.equal(polled.service?.state, 'exited');
    assert.equal(manager.listForManagement().find(({ id }) => id === service.processId)?.exitCode, 7);
    assert.ok((await stat(join(home, 'services', `${service.processId}.json`))).isFile());
  }
  assert.equal(manager.readOutput(service.processId, 0, 1024, undefined, 'utf8').data, 'retained-output');
  await manager.stopForManagement(service.processId);
  assert.deepEqual(manager.listForManagement(), []);
  assert.deepEqual(new ProcessManager(options).listForManagement(), []);
});

test('bulk stop suppresses due service retries and preserves completed ordinary task records', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-service-retry-stop-'));
  const manager = new ProcessManager({ home, outputDirectory: home, persistTaskRecords: true, maxProcesses: 3 });
  context.after(async () => { await manager.shutdown(); await rm(home, { recursive: true, force: true }); });
  const completed = await manager.exec('sleep 0.03; printf archived-output', home, 0, 1024, owner, undefined, 'combined', 'task', 'archived');
  const deadline = Date.now() + 1000;
  while (!manager.readOutput(completed.processId, 0, 1024, undefined, 'utf8').complete && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(manager.listForManagement().find(({ id }) => id === completed.processId)?.status, 'exited');
  const first = await manager.exec('read value', home, 0, 1024, owner, undefined, 'combined', 'service', 'slow-stop');
  const retry = await manager.exec('printf attempt >> attempts; exit 1', home, 30, 1024, owner, undefined, 'combined', 'service', 'retrying', { restart: { maxAttempts: 1, backoffMs: 200 } });
  assert.ok(retry.service?.nextRestartAt);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const originalStop = manager.stopForManagement.bind(manager);
  context.mock.method(manager, 'stopForManagement', async (id: string) => {
    if (id === first.processId) await blocked;
    return originalStop(id);
  });
  const stopping = manager.stopAllForManagement();
  try {
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await readFile(join(home, 'attempts'), 'utf8'), 'attempt', 'retry must not spawn during bulk stop');
  } finally { release(); }
  assert.deepEqual(await stopping, { stopped: 2 });
  assert.equal(manager.listForManagement().find(({ id }) => id === completed.processId)?.status, 'exited');
  assert.equal(manager.readOutput(completed.processId, 0, 1024, undefined, 'utf8').data, 'archived-output');
});

test('shutdown fences redirected descendants even when the service leader exits first', { skip: process.platform !== 'linux' }, async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-service-descendant-'));
  const manager = new ProcessManager({ home, outputDirectory: home, persistTaskRecords: true });
  let childPid: number | undefined;
  context.after(async () => {
    if (childPid) try { process.kill(childPid, 'SIGKILL'); } catch { /* already fenced */ }
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  const service = await manager.exec("(trap '' TERM; echo ready > child-ready; sleep 30) >/dev/null 2>&1 & echo $! > child.pid; while [ ! -f child-ready ]; do sleep 0.01; done; read value", home, 1000, 1024, owner, undefined, 'combined', 'service', 'descendant');
  assert.equal(service.running, true);
  childPid = Number((await readFile(join(home, 'child.pid'), 'utf8')).trim());
  assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
  await manager.shutdown();
  const status = await readFile(`/proc/${childPid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.ok(!status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z'), 'redirected child must be stopped');
  assert.ok((await stat(join(home, 'services', `${service.processId}.json`))).isFile());
});

test('service restore validates all definitions before launching any saved command', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-service-validation-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const options = { home, outputDirectory: home, persistTaskRecords: true, maxProcesses: 1 };
  assert.deepEqual(new ProcessManager(options).listForManagement(), []);
  const definition = { version: 1, id: 'aaaaaaaaaaaaaaaa', label: 'must not launch', command: ': > unexpected-start', cwd: home, maxOutputBytes: 1024, outputMode: 'combined', ownerGeneration: 1 };
  await writeFile(join(home, 'services', `${definition.id}.json`), JSON.stringify(definition), { mode: 0o600 });
  await writeFile(join(home, 'services', 'zzzzzzzzzzzzzzzz.json'), '{}', { mode: 0o600 });
  assert.throws(() => new ProcessManager(options), /durable service/iu);
  await assert.rejects(stat(join(home, 'unexpected-start')), { code: 'ENOENT' });
  assert.equal((await readdir(join(home, 'services'))).length, 2, 'invalid state is preserved for repair');
});

test('isolated runner lists retain service state and exit details while rejecting unknown metadata', async (context) => {
  const base = { label: 'saved', lifecycle: 'service', startedAt: new Date().toISOString(), owner: 'computer', ownerGeneration: 1 } as const;
  const summaries: ManagementProcessSummary[] = [
    { ...base, id: 'queued', status: 'queued', service: { state: 'queued', restartAttempts: 0 } },
    { ...base, id: 'ready', status: 'running', service: { state: 'ready', restartAttempts: 1, lastCheckedAt: new Date().toISOString(), lastExitCode: 1 } },
    { ...base, id: 'exited', status: 'exited', exitCode: 7, service: { state: 'exited', restartAttempts: 0 } },
    { ...base, id: 'signaled', status: 'signaled', signal: 'SIGTERM', service: { state: 'exited', restartAttempts: 0 } },
  ];
  let responseBody: unknown = summaries;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const remote = new RemoteProcessManager(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'fixture-key');
  assert.deepEqual(await remote.listForManagement(), summaries);
  assert.deepEqual(await remote.listForAgent(), summaries);
  responseBody = [{ ...summaries[0], command: 'must not expose commands' }];
  await assert.rejects(remote.listForManagement(), { code: 'internal_runner_invalid_response' });
  responseBody = [{ ...summaries[0], service: { state: 'queued', restartAttempts: 0, internalSecret: 'must not expose internals' } }];
  await assert.rejects(remote.listForAgent(), { code: 'internal_runner_invalid_response' });
});
