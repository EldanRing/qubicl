import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ToolExecutor } from '@qubicl/control/executor';
import { BoundedFileSystem } from '@qubicl/control/bounded-files';
import { ProcessManager } from '@qubicl/control/processes';
import { PtyManager } from '@qubicl/control/pty';
import { SkillManager } from '@qubicl/control/skills';
import { utf8Page } from '../../packages/control/dist/utf8-page.js';
const owner = { id: 'audit', generation: 1, epoch: 'audit' };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('whole-file saves check read hashes and create-only never replaces a racing writer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-save-audit-'));
  const executor = new ToolExecutor(undefined, { durableRoot: home });
  const lease = executor.leases.acquire(30);
  try {
    const path = join(home, 'shared.txt');
    await writeFile(path, 'initial');
    const read = await executor.call('read_file', { path }) as { sha256: string };
    assert.equal(read.sha256, createHash('sha256').update('initial').digest('hex'));
    await writeFile(path, 'human edit');
    await assert.rejects(executor.call('write_file', { lease, path, content: 'stale', expectedSha256: read.sha256 }), (e: { code?: string; details?: { currentSha256?: string } }) => e.code === 'file_conflict' && !!e.details?.currentSha256);
    assert.equal(await readFile(path, 'utf8'), 'human edit');
    const current = await executor.call('read_file', { path }) as { sha256: string };
    await executor.call('write_file', { lease, path, content: 'merged', expectedSha256: current.sha256 });
    assert.equal(await readFile(path, 'utf8'), 'merged');
    const huge = join(home, 'large-sparse.txt');
    const handle = await open(huge, 'w');
    await handle.truncate(100_000_000); await handle.close();
    await assert.rejects(executor.call('write_file', { lease, path: huge, content: 'replacement', expectedSha256: '0'.repeat(64) }), (error: { code?: string }) => error.code === 'file_too_large');
    const fresh = join(home, 'fresh.txt');
    const files = new BoundedFileSystem(home, { beforeUse: async (event) => {
      if (event.stage === 'destination-checked' && event.path === fresh) await writeFile(fresh, 'racer');
    } });
    await assert.rejects(files.writeFile(fresh, Buffer.from('agent'), { createParents: true, createOnly: true }));
    assert.equal(await readFile(fresh, 'utf8'), 'racer');
  } finally { await executor.shutdown(); await rm(home, { recursive: true, force: true }); }
});

test('edit diffs replay full lines, multiple matches, BOM and absent final newline', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-diff-audit-'));
  const executor = new ToolExecutor(undefined, { durableRoot: home });
  const lease = executor.leases.acquire(30);
  try {
    for (const original of ['hello cat world', '\ufeffhello cat world\r\nlast dog\r\n', 'first\nhello cat world\nlast dog']) {
      const path = join(home, 'edit.txt');
      await writeFile(path, original);
      const edits = [{ oldText: 'cat', newText: 'cats\nnext' }, ...(original.includes('dog') ? [{ oldText: 'dog', newText: 'hound' }] : [])];
      const result = await executor.call('edit_file', { lease, path, edits }) as { diff: string };
      const expected = await readFile(path);
      await writeFile(path, original);
      const patched = spawnSync('patch', ['--batch', '--binary', path], { input: result.diff, encoding: 'utf8' });
      assert.equal(patched.status, 0, patched.stderr + patched.stdout);
      assert.deepEqual(await readFile(path), expected);
    }
  } finally { await executor.shutdown(); await rm(home, { recursive: true, force: true }); }
});

test('UTF-8 pages preserve all multibyte boundaries and withhold incomplete live characters', () => {
  const text = 'A🙂Bé中Z';
  const data = Buffer.from(text);
  for (let max = 1; max <= 6; max += 1) {
    let offset = 0, actual = '';
    while (offset < data.length) {
      const page = utf8Page(data, offset, max, true);
      assert.ok(page.nextOffset > offset);
      actual += page.data.toString('utf8'); offset = page.nextOffset;
    }
    assert.equal(actual, text);
  }
  for (let length = 2; length <= 4; length += 1) {
    const page = utf8Page(Buffer.from('A🙂B').subarray(0, length), 0, 20, false);
    assert.equal(page.data.toString(), 'A'); assert.equal(page.nextOffset, 1);
  }
});

test('retained output and PTY pages preserve Unicode and persisted unsuccessful exits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-output-audit-'));
  const manager = new ProcessManager({ outputDirectory: home, home, persistTaskRecords: true });
  const terminals = new PtyManager({ helperPath: resolve('images/computer/pty-helper.py'), home });
  try {
    const task = await manager.exec("printf 'A🙂Bé中Z'; exit 7", home, 1000, 1024, owner, undefined, 'combined', 'task');
    let offset = 0, actual = '';
    while (offset < Buffer.byteLength('A🙂Bé中Z')) {
      const page = manager.readOutput(task.processId, offset, 2, undefined, 'utf8');
      actual += page.data; assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    }
    assert.equal(actual, 'A🙂Bé中Z');
    const restored = new ProcessManager({ outputDirectory: home, home, persistTaskRecords: true });
    assert.equal(restored.listForAgent().find((p) => p.id === task.processId)?.exitCode, 7);
    assert.equal(restored.readOutput(task.processId, 0, 2, undefined, 'base64').data, Buffer.from('A🙂Bé中Z').subarray(0, 2).toString('base64'));
    const terminal = await terminals.open("printf 'A🙂Bé中Z'", home, 24, 80, owner, 'task', 'unicode');
    await wait(150);
    offset = 0; actual = '';
    while (offset < Buffer.byteLength('A🙂Bé中Z')) {
      const page = await terminals.read(terminal.terminalId, owner, offset, 2, 0, 'utf8');
      actual += page.data; assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    }
    assert.equal(actual, 'A🙂Bé中Z');
  } finally { await manager.terminateOwner(undefined); await terminals.shutdown(); await rm(home, { recursive: true, force: true }); }
});

test('custom skill rename failure restores the original content and resources', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-skill-audit-'));
  let fail = false;
  const manager = new SkillManager({ durableRoot: home, catalogRoot: resolve('skills'), renameDirectory: async (source, target) => {
    if (fail && String(source).includes('/.tmp-')) { fail = false; throw new Error('Injected replacement failure'); }
    return rename(source, target);
  } });
  try {
    await manager.manage({ action: 'create', name: 'safe', description: 'Safe original', instructions: 'Keep the original.', files: { 'notes.txt': 'original resource' }, enabled: true });
    fail = true;
    await assert.rejects(manager.manage({ action: 'update', name: 'safe', instructions: 'Replacement.', files: { 'notes.txt': 'replacement resource' } }), /Injected replacement failure/);
    const view = await manager.view('custom/safe', 'SKILL.md', 0, 1000) as { content: string; resourceRoot: string };
    assert.match(view.content, /Keep the original/);
    assert.equal(await readFile(join(view.resourceRoot, 'notes.txt'), 'utf8'), 'original resource');
    assert.equal((await readdir(join(view.resourceRoot, '..'))).some((name) => name.startsWith('.backup-')), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('service readiness tracks starting, ready and unhealthy without restarting by default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-service-health-'));
  const manager = new ProcessManager({ outputDirectory: home, home, persistTaskRecords: true });
  const server = createServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const started = await manager.exec('sleep 30', home, 2000, 1024, owner, undefined, 'combined', 'service', 'web', { readiness: { type: 'http', port, expectedStatus: 204, intervalMs: 100, timeoutMs: 150 } });
    assert.equal(started.service?.state, 'ready');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await wait(250);
    const state = manager.listForAgent().find((p) => p.id === started.processId)?.service;
    assert.equal(state?.state, 'unhealthy'); assert.equal(state?.restartAttempts, 0);
    await manager.stop(started.processId, owner);
  } finally { server.close(); await manager.terminateOwner(undefined); await rm(home, { recursive: true, force: true }); }
});

test('service retries have a finite budget and stop cancels pending restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-service-restart-'));
  const manager = new ProcessManager({ outputDirectory: home, home, persistTaskRecords: true });
  try {
    const result = await manager.exec('printf attempt; exit 1', home, 1200, 1024, owner, undefined, 'combined', 'service', 'retry', { restart: { maxAttempts: 2, backoffMs: 100 } });
    assert.equal(result.running, false); assert.equal(result.service?.state, 'exited');
    assert.equal(result.service?.restartAttempts, 2); assert.equal(result.exitCode, 1);
    assert.equal(result.output, 'attemptattemptattempt');
    await manager.stop(result.processId, owner);
    const pending = await manager.exec('printf one; exit 1', home, 50, 1024, owner, undefined, 'combined', 'service', 'cancel', { restart: { maxAttempts: 2, backoffMs: 1000 } });
    assert.equal(pending.service?.state, 'starting');
    await manager.stop(pending.processId, owner);
    assert.equal(manager.listForAgent().some((p) => p.id === pending.processId), false);
  } finally { await manager.terminateOwner(undefined); await rm(home, { recursive: true, force: true }); }
});

test('a second rename failure preserves the original skill in a recoverable backup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-skill-recovery-'));
  let fail = false;
  const manager = new SkillManager({ durableRoot: home, catalogRoot: resolve('skills'), renameDirectory: async (source, target) => {
    if (fail && (String(source).includes('/.tmp-') || String(source).includes('/.backup-'))) throw new Error('Injected rename failure');
    return rename(source, target);
  } });
  try {
    await manager.manage({ action: 'create', name: 'safe', description: 'Safe original', instructions: 'Original instructions.', files: { 'notes.txt': 'original resource' }, enabled: true });
    const original = await manager.view('custom/safe', 'SKILL.md', 0, 1000) as { resourceRoot: string };
    fail = true;
    await assert.rejects(manager.manage({ action: 'update', name: 'safe', instructions: 'Replacement.' }), (error: { code?: string }) => error.code === 'skill_recovery_required');
    const parent = join(original.resourceRoot, '..');
    const backup = (await readdir(parent)).find((name) => name.startsWith('.backup-safe-'));
    assert.ok(backup);
    assert.equal(await readFile(join(parent, backup, 'notes.txt'), 'utf8'), 'original resource');
    assert.match(await readFile(join(parent, backup, 'SKILL.md'), 'utf8'), /Original instructions/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
