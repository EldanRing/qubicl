import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolExecutor, type ControlAction } from '@qubicl/control/executor';
import { ProcessManager } from '@qubicl/control/processes';
import { invokeTool } from '../../packages/control/dist/contract.js';
import { errorPayload } from '../../packages/control/dist/errors.js';
import { creationTime } from '../../packages/control/dist/file-errors.js';
import { BoundedFileSystem, type BoundedFileHookEvent } from '@qubicl/control/bounded-files';

const owner = { id: 'test-lease', generation: 1, epoch: 'test-epoch' };

function processState(pid: number): string {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = value.lastIndexOf(')');
    return close >= 0 ? value.slice(close + 2).split(/\s+/u)[0] ?? 'unknown' : 'unknown';
  } catch {
    return 'missing';
  }
}

test('managed process safety bounds reject zero and fractional configuration', () => {
  assert.throws(() => new ProcessManager({ maxProcesses: 0 }), /maxProcesses/);
  assert.throws(() => new ProcessManager({ maxCompletedProcesses: 0 }), /maxCompletedProcesses/);
  assert.throws(() => new ProcessManager({ maxRetainedOutputBytes: 0 }), /maxRetainedOutputBytes/);
  assert.throws(() => new ProcessManager({ completedTtlMs: 0 }), /completedTtlMs/);
  assert.throws(() => new ProcessManager({ maxFullOutputBytes: 0 }), /maxFullOutputBytes/);
  assert.throws(() => new ProcessManager({ maxAggregateOutputBytes: 0 }), /maxAggregateOutputBytes/);
  assert.throws(() => new ProcessManager({ maxJournalRecords: 0 }), /maxJournalRecords/);
  assert.throws(() => new ProcessManager({ maxAggregateJournalRecords: 0 }), /maxAggregateJournalRecords/);
  assert.throws(() => new ProcessManager({ maxLifetimeMs: 0 }), /maxLifetimeMs/);
  assert.throws(() => new ProcessManager({ stdinWriteTimeoutMs: 0 }), /stdinWriteTimeoutMs/);
  assert.throws(() => new ProcessManager({ outputTtlMs: 0 }), /outputTtlMs/);
  assert.throws(() => new ProcessManager({ maxProcesses: 1.5 }), /maxProcesses/);
});

test('ordinary MCP commands and stdin preserve the existing payload range above compatibility limits', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-standard-process-payloads-'));
  try {
    const processes = new ProcessManager({ outputDirectory });
    const longCommand = `printf command-ok # ${'x'.repeat(70 * 1024)}`;
    const command = await processes.exec(longCommand, '/tmp', 2_000, 1_000, owner);
    assert.equal(command.running, false);
    assert.equal(command.output, 'command-ok');

    const started = await processes.exec('wc -c', '/tmp', 10, 1_000, owner);
    assert.equal(started.running, true);
    const completed = await processes.write(started.processId, 'i'.repeat(70 * 1024), true, 2_000, owner);
    assert.equal(completed.running, false);
    assert.match(completed.output!, /71680/u);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('model commands receive a least-privilege environment without control credentials', async () => {
  const processes = new ProcessManager({
    environment: {
      QUBICL_INTERNAL_KEY: 'must-not-leak',
      QUBICL_EXECUTOR_KEY: 'must-not-leak-either',
      NODE_OPTIONS: '--require=/host/injection.cjs',
      HTTPS_PROXY: 'http://credential:secret@proxy.invalid',
      DISPLAY: ':7',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
    },
  });
  const result = await processes.exec('env | sort', '/tmp', 1_000, 20_000, owner);
  assert.equal(result.running, false);
  assert.match(result.output!, /^DISPLAY=:7$/m);
  assert.match(result.output!, /^HOME=\/home\/qubicl$/m);
  assert.match(result.output!, /^TERM=xterm-256color$/m);
  assert.doesNotMatch(result.output!, /QUBICL_|NODE_OPTIONS|HTTPS_PROXY|must-not-leak|credential:secret/);
});

test('lease expiry terminates its managed process groups', async () => {
  const executor = new ToolExecutor();
  const lease = executor.leases.acquire(0.05);
  const process = await executor.processes.exec('sleep 300', '/tmp', 10, 10_000, lease);
  assert.equal(process.running, true);
  const deadline = Date.now() + 3_000;
  while (executor.processes.count() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(executor.processes.count(), 0);
  assert.throws(() => executor.leases.verify(lease), /stale/i);
});

test('spawn failures return a completed process result', async () => {
  const executor = new ToolExecutor();
  const lease = executor.leases.acquire(60);
  const result = await executor.processes.exec('true', '/path/that/does/not/exist', 1_000, 10_000, lease, undefined, 'split');
  assert.equal(result.running, false);
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr!, /ENOENT/);
  assert.equal(executor.processes.count(), 0);
});

test('managed output is bounded across both streams and reports truncation', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-process-output-'));
  try {
    const processes = new ProcessManager({ maxRetainedOutputBytes: 1_000, outputDirectory });
    const result = await processes.exec(
      "printf '%0200d' 0; printf '%0200d' 0 >&2",
      '/tmp',
      1_000,
      128,
      owner,
      undefined,
      'split',
    );
    assert.equal(result.running, false);
    assert.ok(Buffer.byteLength(result.stdout!) + Buffer.byteLength(result.stderr!) <= 128);
    assert.ok(result.truncation?.inline?.streams.length);
    assert.equal(result.truncation?.inline?.limitBytes, 128);
    assert.equal('output' in result, false);
    assert.equal((await readFile(result.truncation!.continuation!.path)).length, 400);
    assert.equal(result.truncation?.continuation?.retainedLogTruncated, false);
    assert.equal(result.truncation?.retainedLog, undefined);
    assert.equal(processes.retainedOutputBytes(), 0);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('full command output files have an independent safety cap', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-process-cap-'));
  try {
    const processes = new ProcessManager({ outputDirectory, maxFullOutputBytes: 64 });
    const result = await processes.exec("printf '%0200d' 0", '/tmp', 1_000, 32, owner);
    assert.equal((await readFile(result.truncation!.continuation!.path)).length, 64);
    assert.deepEqual(result.truncation?.retainedLog, { limitBytes: 64 });
    assert.equal(result.truncation?.continuation?.retainedLogTruncated, true);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('standard MCP continuation logs preserve raw output bytes exactly', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-process-raw-output-'));
  try {
    const bytes = Buffer.from([0xff, 0x00, 0xf0, 0x9f, 0x98, 0x80, 0x80]);
    const script = `process.stdout.write(Buffer.from('${bytes.toString('base64')}','base64'))`;
    const processes = new ProcessManager({ outputDirectory });
    const result = await processes.exec(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, '/tmp', 1_000, 1, owner);
    assert.equal(result.running, false);
    assert.deepEqual(await readFile(result.truncation!.continuation!.path), bytes);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('native command timeout reports an explicit terminal state and termination reason', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-process-timeout-'));
  try {
    const processes = new ProcessManager({ outputDirectory });
    const startedAt = Date.now();
    const result = await processes.exec('sleep 30', '/tmp', 3_000, 1_000, owner, 50);
    assert.equal(result.running, false);
    assert.equal(result.terminalState, 'timed_out');
    assert.equal(result.timeoutMs, 50);
    assert.equal(result.termination?.reason, 'timeout');
    assert.equal(result.termination?.requestedSignal, 'SIGTERM');
    assert.equal(result.signal, 'SIGTERM');
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(processes.count(), 0);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('stop_process supports a bounded signal allowlist and reports requested termination', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-process-signal-'));
  try {
    const processes = new ProcessManager({ outputDirectory });
    const started = await processes.exec(
      `${JSON.stringify(process.execPath)} -e "process.on('SIGINT',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)"`,
      '/tmp',
      25,
      1_000,
      owner,
      undefined,
      'split',
    );
    assert.equal(started.running, true);
    let readinessOutput = started.stdout!;
    const readinessDeadline = Date.now() + 2_000;
    while (!readinessOutput.includes('ready') && Date.now() < readinessDeadline) {
      const update = await processes.write(started.processId, '', false, 50, owner);
      readinessOutput += update.stdout!;
    }
    assert.match(readinessOutput, /ready/);
    assert.equal(started.terminalState, 'running');
    const stopped = await processes.stop(started.processId, owner, 'SIGINT');
    assert.equal(stopped.running, false);
    assert.equal(stopped.terminalState, 'exited');
    assert.equal(stopped.exitCode, 0);
    assert.deepEqual(stopped.termination, {
      reason: 'stop',
      requestedSignal: 'SIGINT',
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('lease-required calls refresh activity without repeating lease metadata in results', async () => {
  const executor = new ToolExecutor(undefined, { durableRoot: '/tmp' });
  const lease = executor.leases.acquire(0.2);
  const originalExpiry = Date.parse(lease.expiresAt);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const result = await executor.call('get_file_info', { lease, path: '/tmp' }) as Record<string, unknown>;
  const refreshedExpiry = executor.leases.snapshot().expiresAt!;
  assert.ok(Date.parse(refreshedExpiry) > originalExpiry);
  assert.equal('leaseActivity' in result, false);
});

test('desktop-control success is explicitly dispatch-only rather than state verification', async () => {
  const executor = new ToolExecutor();
  const lease = executor.leases.acquire(60);
  const result = await executor.call('control_computer', {
    lease,
    action: { type: 'wait', durationMs: 0 },
  }) as { action: string; dispatch: string; verified: boolean; verification: string; note: string };
  assert.equal(result.action, 'wait');
  assert.equal(result.dispatch, 'completed');
  assert.equal(result.verified, false);
  assert.equal(result.verification, 'dispatch_only');
  assert.match(result.note, /does not prove/);
});

test('successful desktop point actions publish persistent viewer pointer events', async () => {
  const desktop = {
    screenshot: async () => ({}),
    control: async (action: ControlAction) => ({ action: action.type, dispatch: 'completed' }),
    readClipboard: async () => ({ text: '' }),
    writeClipboard: async () => ({ written: true as const }),
  };
  const executor = new ToolExecutor(undefined, { desktop });
  const lease = executor.leases.acquire(60);
  await executor.call('control_computer', { lease, action: { type: 'click', x: 125, y: 250, button: 1 } });
  await executor.call('control_computer', { lease, action: { type: 'type', text: 'not retained' } });
  const snapshot = executor.viewerPointers.since(0);
  assert.equal(snapshot.latestSequence, 1);
  assert.deepEqual(snapshot.events.flatMap((event) => event.type === 'show' ? [{ kind: event.kind, x: event.x, y: event.y }] : []), [{ kind: 'click', x: 125, y: 250 }]);
  assert.deepEqual(snapshot.current && { kind: snapshot.current.kind, x: snapshot.current.x, y: snapshot.current.y }, { kind: 'click', x: 125, y: 250 });
});

test('desktop pointer intent is visible before dispatch completes and failed dispatch restores prior state', async () => {
  let finishDispatch: ((value: Record<string, unknown>) => void) | undefined;
  let failDispatch: ((error: Error) => void) | undefined;
  const desktop = {
    screenshot: async () => ({}),
    control: () => new Promise<Record<string, unknown>>((resolve, reject) => {
      finishDispatch = resolve;
      failDispatch = reject;
    }),
    readClipboard: async () => ({ text: '' }),
    writeClipboard: async () => ({ written: true as const }),
  };
  const executor = new ToolExecutor(undefined, { desktop });
  const lease = executor.leases.acquire(60);
  executor.viewerPointers.record({ type: 'click', x: 10, y: 20 });

  const successful = executor.call('control_computer', { lease, action: { type: 'click', x: 300, y: 400, button: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.viewerPointers.since(0).current?.x, 300);
  finishDispatch?.({ dispatch: 'completed' });
  await successful;

  const failed = executor.call('control_computer', { lease, action: { type: 'click', x: 500, y: 600, button: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.viewerPointers.since(0).current?.x, 500);
  failDispatch?.(new Error('dispatch failed'));
  await assert.rejects(failed, /dispatch failed/);
  assert.equal(executor.viewerPointers.since(0).current?.x, 300);
});

test('viewer pointer updates are generation-bound and cleared when agent control ends', async () => {
  const executor = new ToolExecutor(undefined, { durableRoot: '/tmp' });
  const lease = executor.leases.acquire(60);
  assert.equal(executor.applyViewerPointerUpdate({
    phase: 'intent', actionId: 'session_pointer_1234', generation: lease.generation,
    action: { type: 'click', x: 100, y: 200 },
  }), true);
  assert.equal(executor.applyViewerPointerUpdate({
    phase: 'confirm', actionId: 'session_pointer_1234', generation: lease.generation + 1,
  }), false);
  assert.equal(executor.viewerPointers.since(0).current?.x, 100);
  await executor.leases.release(lease);
  const snapshot = executor.viewerPointers.since(0);
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.events.at(-1)?.type, 'hide');
  assert.equal(executor.applyViewerPointerUpdate({
    phase: 'confirm', actionId: 'session_pointer_1234', generation: lease.generation,
  }), false);
});

test('successful browser point actions publish transformed viewer events without leaking internal receipts', async () => {
  const browser = {
    clickWithViewerPointer: async () => ({
      result: { url: 'https://example.test/', title: 'Example' },
      pointerActions: [{ type: 'right_click', x: 310, y: 220, button: 3 }],
    }),
    computerWithViewerPointers: async (actions: Array<{ type: string }>) => ({
      result: { mimeType: 'image/png', data: '', viewport: { width: 1_440, height: 900, deviceScaleFactor: 1 }, actionCount: actions.length },
      pointerActions: actions[0]?.type === 'move'
        ? [{ type: 'move', x: 410, y: 320, button: 1 }]
        : [{ type: 'click', x: 510, y: 420, button: 1 }],
    }),
  };
  const executor = new ToolExecutor(undefined, { browser: browser as never });
  const lease = executor.leases.acquire(60);
  const semantic = await executor.call('browser_click', { lease, ref: 'g1e1', button: 'right' }) as Record<string, unknown>;
  const coordinate = await executor.call('browser_click_at', { lease, x: 10, y: 20 }) as Record<string, unknown>;
  await executor.call('browser_hover_at', { lease, x: 30, y: 40 });

  assert.equal('pointerActions' in semantic, false);
  assert.equal('pointerActions' in coordinate, false);
  assert.deepEqual(executor.viewerPointers.since(0).events.flatMap((event) => event.type === 'show' ? [{ kind: event.kind, x: event.x, y: event.y, button: event.button }] : []), [
    { kind: 'right_click', x: 310, y: 220, button: 3 },
    { kind: 'click', x: 510, y: 420, button: 1 },
    { kind: 'move', x: 410, y: 320, button: 1 },
  ]);
});

test('managed process count is capped', async () => {
  const processes = new ProcessManager({ maxProcesses: 1 });
  const first = await processes.exec('sleep 30', '/tmp', 1, 1_000, owner);
  assert.equal(first.running, true);
  await assert.rejects(processes.exec('sleep 30', '/tmp', 1, 1_000, owner), /already has 1 managed process/);
  await processes.stop(first.processId, owner);
});

test('unclaimed completed results expire', async () => {
  const processes = new ProcessManager({ completedTtlMs: 30 });
  const result = await processes.exec('sleep 0.03; printf done', '/tmp', 1, 1_000, owner);
  assert.equal(result.running, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(processes.count(), 0);
  assert.equal(processes.retainedOutputBytes(), 0);
});

test('Open Terminal compatibility sessions retain completed output without changing standard process ID lifetime', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-processes-'));
  try {
    const processes = new ProcessManager({ outputDirectory });
    const standard = await processes.exec('printf standard', '/tmp', 1_000, 1_000, owner);
    assert.equal(standard.running, false);
    await assert.rejects(processes.write(standard.processId, '', false, 0, owner), /not found/i);

    const retained = await processes.executeCompatibility('printf retained', '/tmp', owner, { waitMs: 1_000, tail: 100 }, 'session-one');
    assert.equal(retained.status, 'done');
    assert.equal(retained.log_path, null);
    assert.equal(retained.session_id, 'session-one');
    assert.equal(retained.output.map(({ data }) => data).join(''), 'retained');
    const repeated = await processes.statusCompatibility(retained.id, owner, { offset: 0 });
    assert.deepEqual(repeated.output, retained.output);
    assert.equal(processes.listCompatibility(owner).some(({ id }) => id === retained.id), true);
    assert.deepEqual(await processes.deleteCompatibility(retained.id, owner, true), { status: 'killed' });
    await assert.rejects(processes.statusCompatibility(retained.id, owner), /not found/i);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('compatibility output pagination is independent, line-bounded, and preserves UTF-8 across pipe and record boundaries', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-pages-'));
  try {
    const processes = new ProcessManager({ outputDirectory });
    const script = [
      "const prefix = Buffer.from('a'.repeat(65535));",
      "const emoji = Buffer.from('😀');",
      'process.stdout.write(Buffer.concat([prefix, emoji.subarray(0, 1)]));',
      'setTimeout(() => {',
      "  process.stdout.write(Buffer.concat([emoji.subarray(1), Buffer.from('\\n')]));",
      "  process.stdout.write(Array.from({ length: 1001 }, (_, index) => `line-${index}\\n`).join(''));",
      '}, 10);',
    ].join(' ');
    const encodedScript = Buffer.from(script).toString('base64');
    const started = await processes.executeCompatibility(`${JSON.stringify(process.execPath)} -e "eval(Buffer.from('${encodedScript}','base64').toString())"`, '/tmp', owner, { waitMs: 2_000 });
    assert.equal(started.status, 'done');
    const first = await processes.statusCompatibility(started.id, owner, { offset: 0 });
    const repeated = await processes.statusCompatibility(started.id, owner, { offset: 0 });
    assert.deepEqual(repeated.output, first.output);
    assert.equal(first.output.length, 1_000);
    assert.equal(first.truncated, true);
    const second = await processes.statusCompatibility(started.id, owner, { offset: first.next_offset });
    const combined = [...first.output, ...second.output].map(({ data }) => data).join('');
    assert.equal(combined.includes('\ufffd'), false);
    assert.match(combined, new RegExp(`^${'a'.repeat(100)}.*😀\\nline-0\\n`, 'su'));
    assert.match(combined, /line-1000\n$/u);
    await processes.deleteCompatibility(started.id, owner, true);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('compatibility journal pages reject symlink and same-path identity substitutions', async () => {
  const outputParent = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-journal-identity-'));
  try {
    const processes = new ProcessManager({ outputDirectory: outputParent });
    const result = await processes.executeCompatibility('printf original-journal', '/tmp', owner, { waitMs: 1_000 });
    assert.equal(result.status, 'done');
    const privateRoots = (await readdir(outputParent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('.qubicl-command-output-'));
    assert.equal(privateRoots.length, 1);
    const privateRoot = join(outputParent, privateRoots[0]!.name);
    const journalNames = await readdir(privateRoot);
    assert.equal(journalNames.length, 1);
    const journal = join(privateRoot, journalNames[0]!);
    const displaced = `${journal}.displaced`;
    await rename(journal, displaced);
    await symlink(displaced, journal);
    const unavailableJournal = (error: unknown): boolean => (
      error instanceof Error && (error as Error & { code?: string }).code === 'process_journal_unavailable'
    );
    await assert.rejects(processes.statusCompatibility(result.id, owner), unavailableJournal);

    await rm(journal, { force: true });
    await writeFile(journal, 'replacement-journal');
    await assert.rejects(processes.statusCompatibility(result.id, owner), unavailableJournal);
    await processes.deleteCompatibility(result.id, owner, true);
    assert.equal(await readFile(journal, 'utf8'), 'replacement-journal', 'cleanup must not unlink a substituted path');
  } finally {
    await rm(outputParent, { recursive: true, force: true });
  }
});

test('an initial compatibility-page failure fences and removes the otherwise hidden process', async (context) => {
  const outputParent = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-initial-page-'));
  const pidPath = join(outputParent, 'leader.pid');
  let leaderPid: number | undefined;
  context.after(async () => {
    if (leaderPid !== undefined) try { process.kill(leaderPid, 'SIGKILL'); } catch { /* already fenced */ }
    await rm(outputParent, { recursive: true, force: true });
  });
  const processes = new ProcessManager({ outputDirectory: outputParent });
  const pending = processes.executeCompatibility(
    `echo $$ > ${JSON.stringify(pidPath)}; sleep 30`,
    '/tmp',
    owner,
    { waitMs: 500 },
  );
  const readinessDeadline = Date.now() + 2_000;
  let journal = '';
  while ((!journal || leaderPid === undefined) && Date.now() < readinessDeadline) {
    try { leaderPid = Number((await readFile(pidPath, 'utf8')).trim()); } catch { /* command has not written it yet */ }
    const privateRoot = (await readdir(outputParent, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name.startsWith('.qubicl-command-output-'));
    if (privateRoot) {
      const names = await readdir(join(outputParent, privateRoot.name));
      if (names[0]) journal = join(outputParent, privateRoot.name, names[0]);
    }
    if (!journal || leaderPid === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(journal);
  assert.ok(leaderPid !== undefined && Number.isSafeInteger(leaderPid));
  await rename(journal, `${journal}.displaced`);
  await writeFile(journal, 'substituted initial page');
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'process_journal_unavailable',
  );
  assert.equal(processes.count(), 0);
  assert.deepEqual(processes.listCompatibility(owner), []);
  assert.ok(['missing', 'Z'].includes(processState(leaderPid)));
  assert.equal(await readFile(journal, 'utf8'), 'substituted initial page');
});

test('managed output setup rejects a preplaced symlink parent without writing through it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-process-output-parent-'));
  const outside = await mkdtemp(join(tmpdir(), 'qubicl-process-output-outside-'));
  try {
    const linkedParent = join(directory, 'linked-output');
    await symlink(outside, linkedParent);
    const processes = new ProcessManager({ outputDirectory: linkedParent });
    await assert.rejects(
      processes.executeCompatibility('printf should-not-run', '/tmp', owner, { waitMs: 1_000 }),
      /must be a real directory, not a symbolic link/u,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('compatibility process limits cover UTF-8 command/input bytes, completion retention, and lifetime', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-limits-'));
  try {
    const processes = new ProcessManager({ outputDirectory, maxCompletedProcesses: 2, maxLifetimeMs: 40 });
    await assert.rejects(
      processes.executeCompatibility('😀'.repeat(16_385), '/tmp', owner),
      (error: unknown) => error instanceof Error && /65536-byte UTF-8 limit/.test(error.message),
    );
    const interactive = await processes.executeCompatibility('cat >/dev/null', '/tmp', owner, { waitMs: 0 });
    await assert.rejects(
      processes.inputCompatibility(interactive.id, '😀'.repeat(16_385), owner),
      (error: unknown) => error instanceof Error && /65536-byte/.test(error.message),
    );
    await assert.rejects(
      processes.statusCompatibility(interactive.id, { ...owner, generation: 2 }),
      /different lease generation/i,
    );
    await assert.rejects(processes.statusCompatibility(interactive.id, owner, { waitMs: 30_001 }), /wait must be an integer/u);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const expired = await processes.statusCompatibility(interactive.id, owner);
    assert.equal(expired.status, 'killed');

    const completed = [];
    for (const value of ['one', 'two', 'three']) {
      completed.push(await processes.executeCompatibility(`printf ${value}`, '/tmp', owner, { waitMs: 1_000 }));
    }
    await assert.rejects(processes.statusCompatibility(completed[0]!.id, owner), /not found/i);
    assert.equal(processes.listCompatibility(owner).filter(({ status }) => status !== 'running').length, 2);
    await processes.terminateOwner(owner);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('compatibility journals enforce per-process, aggregate, page-byte, and stdin-queue ceilings', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-resource-limits-'));
  try {
    const capped = new ProcessManager({ outputDirectory, maxFullOutputBytes: 32, maxAggregateOutputBytes: 48 });
    const first = await capped.executeCompatibility("printf '%040d' 0", '/tmp', owner, { waitMs: 1_000 });
    const second = await capped.executeCompatibility("printf '%040d' 0", '/tmp', owner, { waitMs: 1_000 });
    assert.equal(Buffer.byteLength(first.output.map(({ data }) => data).join('')), 32);
    assert.equal(Buffer.byteLength(second.output.map(({ data }) => data).join('')), 16);
    assert.equal(first.truncated, true);
    assert.equal(second.truncated, true);
    assert.equal(capped.journalOutputBytes(), 48);
    await capped.deleteCompatibility(first.id, owner, true);
    assert.equal(capped.journalOutputBytes(), 16);
    await capped.deleteCompatibility(second.id, owner, true);

    const paged = new ProcessManager({ outputDirectory, stdinWriteTimeoutMs: 100 });
    const encoded = Buffer.from("process.stdout.write(('x'.repeat(65530)+'\\n').repeat(5))").toString('base64');
    const output = await paged.executeCompatibility(`${JSON.stringify(process.execPath)} -e "eval(Buffer.from('${encoded}','base64').toString())"`, '/tmp', owner, { waitMs: 2_000 });
    const pageBytes = output.output.reduce((total, entry) => total + Buffer.byteLength(entry.data), 0);
    assert.ok(pageBytes <= 256 * 1024);
    assert.ok(output.output.length <= 1_000);
    assert.equal(output.truncated, true);
    const remainder = await paged.statusCompatibility(output.id, owner, { offset: output.next_offset });
    assert.ok(remainder.output.length > 0);
    await paged.deleteCompatibility(output.id, owner, true);

    const queued = await paged.executeCompatibility('sleep 30', '/tmp', owner, { waitMs: 0 });
    const writes = await Promise.allSettled(Array.from({ length: 5 }, () => paged.inputCompatibility(queued.id, 'i'.repeat(64 * 1024), owner)));
    assert.equal(writes.some((result) => result.status === 'rejected' && /queued input bytes/u.test(String(result.reason))), true);
    await paged.deleteCompatibility(queued.id, owner, true);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('compatibility journal metadata stays bounded for dense newline output', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-record-limits-'));
  try {
    const processes = new ProcessManager({
      outputDirectory,
      maxJournalRecords: 8,
      maxAggregateJournalRecords: 12,
    });
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('\\n'.repeat(100000))")}`;
    const first = await processes.executeCompatibility(command, '/tmp', owner, { waitMs: 2_000 });
    assert.equal(first.output.length, 8);
    assert.equal(first.next_offset, 8);
    assert.equal(first.truncated, true);
    assert.equal(processes.journalRecordCount(), 8);

    const second = await processes.executeCompatibility(command, '/tmp', owner, { waitMs: 2_000 });
    assert.equal(second.output.length, 4);
    assert.equal(second.truncated, true);
    assert.equal(processes.journalRecordCount(), 12);

    await processes.deleteCompatibility(first.id, owner, true);
    assert.equal(processes.journalRecordCount(), 4);
    await processes.deleteCompatibility(second.id, owner, true);
    assert.equal(processes.journalRecordCount(), 0);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('lease revocation force-kills authenticated descendants of a completed retained process group', async (context) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-descendants-'));
  const pidPath = join(outputDirectory, 'background.pid');
  const processes = new ProcessManager({ outputDirectory });
  let backgroundPid: number | undefined;
  context.after(async () => {
    if (backgroundPid !== undefined) try { process.kill(backgroundPid, 'SIGKILL'); } catch { /* already fenced */ }
    await rm(outputDirectory, { recursive: true, force: true });
  });
  const result = await processes.executeCompatibility(`sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidPath)}`, '/tmp', owner, { waitMs: 2_000 });
  assert.equal(result.status, 'done');
  backgroundPid = Number((await readFile(pidPath, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 1);
  assert.equal(processState(backgroundPid), 'S');
  await processes.terminateOwner(owner);
  const deadline = Date.now() + 2_000;
  while (!['missing', 'Z'].includes(processState(backgroundPid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(['missing', 'Z'].includes(processState(backgroundPid)));
});

test('explicit deletion, expiry, and standard completion do not orphan redirected background group members', async (context) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'qubicl-compatibility-discard-'));
  const processes = new ProcessManager({ outputDirectory, completedTtlMs: 40 });
  const pids: number[] = [];
  context.after(async () => {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* already fenced */ }
    await rm(outputDirectory, { recursive: true, force: true });
  });
  const startBackground = async (label: string): Promise<{ id: string; pid: number }> => {
    const pidPath = join(outputDirectory, `${label}.pid`);
    const result = await processes.executeCompatibility(`sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidPath)}`, '/tmp', owner, { waitMs: 2_000 });
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    pids.push(pid);
    assert.equal(result.status, 'done');
    assert.equal(processState(pid), 'S');
    return { id: result.id, pid };
  };

  const explicit = await startBackground('explicit');
  await processes.deleteCompatibility(explicit.id, owner, true);
  assert.ok(['missing', 'Z'].includes(processState(explicit.pid)));

  const expiring = await startBackground('expiry');
  const expiryDeadline = Date.now() + 2_000;
  while (!['missing', 'Z'].includes(processState(expiring.pid)) && Date.now() < expiryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(['missing', 'Z'].includes(processState(expiring.pid)));
  await assert.rejects(processes.statusCompatibility(expiring.id, owner), /not found/i);

  const standardPidPath = join(outputDirectory, 'standard.pid');
  const standard = await processes.exec(`sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(standardPidPath)}`, '/tmp', 2_000, 1_000, owner);
  assert.equal(standard.running, false);
  const standardPid = Number((await readFile(standardPidPath, 'utf8')).trim());
  pids.push(standardPid);
  assert.ok(['missing', 'Z'].includes(processState(standardPid)));
});

test('file metadata reports symbolic links without following them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-symlink-'));
  try {
    const link = join(directory, 'link');
    await symlink('/target/does/not/need/to/exist', link);
    const executor = new ToolExecutor(undefined, { durableRoot: directory });
    const lease = executor.leases.acquire(60);
    const result = await executor.call('get_file_info', { lease, path: link }) as { type: string };
    assert.equal(result.type, 'symlink');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generic file tools are confined to the durable workspace and reject symlink escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-file-boundary-'));
  const root = join(directory, 'home');
  const outside = join(directory, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(outside, 'secret.txt'), 'outside secret');
  await symlink(outside, join(root, 'escape'));
  try {
    const executor = new ToolExecutor(undefined, { durableRoot: root });
    const lease = executor.leases.acquire(60);
    await assert.rejects(
      executor.call('read_file', { lease, path: join(outside, 'secret.txt') }),
      (error: unknown) => error instanceof Error && /durable workspace/.test(error.message),
    );
    await assert.rejects(
      executor.call('read_file', { lease, path: join(root, 'escape', 'secret.txt') }),
      (error: unknown) => error instanceof Error && /resolves outside/.test(error.message),
    );
    await assert.rejects(
      executor.call('write_file', { lease, path: join(root, 'escape', 'created.txt'), content: 'blocked' }),
      (error: unknown) => error instanceof Error && /resolves outside/.test(error.message),
    );
    await assert.rejects(
      executor.call('get_file_info', { lease, path: join(root, 'escape', 'secret.txt') }),
      (error: unknown) => error instanceof Error && /resolves outside/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded file tools preserve compatible symlink semantics without following mutation targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-bounded-symlinks-'));
  const root = join(directory, 'home');
  const outside = join(directory, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await mkdir(join(root, 'target'));
  await writeFile(join(root, 'target', 'file.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink('target', join(root, 'directory-link'));
  await symlink('target/file.txt', join(root, 'file-link'));
  await symlink('target/file.txt', join(root, 'edit-link'));
  await symlink('.', join(root, 'root-link'));
  await symlink(outside, join(root, 'outside-link'));
  try {
    const executor = new ToolExecutor(undefined, { durableRoot: root });
    const lease = executor.leases.acquire(60);

    const listing = await executor.call('list_files', { lease, path: join(root, 'directory-link') }) as { entries: Array<{ name: string }> };
    assert.deepEqual(listing.entries.map(({ name }) => name), ['file.txt']);
    const read = await executor.call('read_file', { lease, path: join(root, 'file-link') }) as { content: string };
    assert.equal(read.content, 'inside');
    const info = await executor.call('get_file_info', { lease, path: join(root, 'file-link') }) as { type: string };
    assert.equal(info.type, 'symlink');
    const rootListing = await executor.call('list_files', { lease, path: join(root, 'root-link') }) as { entries: Array<{ name: string }> };
    assert.equal(rootListing.entries.some(({ name }) => name === 'target'), true);

    await executor.call('copy_path', { lease, source: join(root, 'file-link'), destination: join(root, 'copied-link') });
    assert.equal((await lstat(join(root, 'copied-link'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(root, 'copied-link')), join(root, 'target', 'file.txt'));

    const referentCopy = await invokeTool(executor, 'copy_path', {
      lease,
      source: join(root, 'file-link'),
      destination: join(root, 'target', 'file.txt'),
      overwrite: true,
    });
    assert.equal(referentCopy.ok, false);
    if (referentCopy.ok) assert.fail('copy unexpectedly replaced the referent of its final source symlink');
    assert.equal(referentCopy.status, 400);
    assert.equal(referentCopy.value.error.code, 'destination_invalid');
    assert.equal((await lstat(join(root, 'file-link'))).isSymbolicLink(), true);
    assert.equal(await readFile(join(root, 'target', 'file.txt'), 'utf8'), 'inside');

    await symlink('target/file.txt', join(root, 'move-referent-link'));
    const referentMove = await invokeTool(executor, 'move_path', {
      lease,
      source: join(root, 'move-referent-link'),
      destination: join(root, 'target', 'file.txt'),
      overwrite: true,
    });
    assert.equal(referentMove.ok, false);
    if (referentMove.ok) assert.fail('move unexpectedly replaced the referent of its final source symlink');
    assert.equal(referentMove.status, 400);
    assert.equal(referentMove.value.error.code, 'destination_invalid');
    assert.equal((await lstat(join(root, 'move-referent-link'))).isSymbolicLink(), true);
    assert.equal(await readFile(join(root, 'target', 'file.txt'), 'utf8'), 'inside');

    const copyChainTarget = join(root, 'copy-chain-target.txt');
    const copyChainMiddle = join(root, 'copy-chain-middle');
    const copyChainSource = join(root, 'copy-chain-source');
    await writeFile(copyChainTarget, 'copy chain target');
    await symlink('copy-chain-target.txt', copyChainMiddle);
    await symlink('copy-chain-middle', copyChainSource);
    const chainCopy = await invokeTool(executor, 'copy_path', {
      lease,
      source: copyChainSource,
      destination: copyChainMiddle,
      overwrite: true,
    });
    assert.equal(chainCopy.ok, false);
    if (chainCopy.ok) assert.fail('copy unexpectedly replaced an intermediate symlink in its final-source referent chain');
    assert.equal(chainCopy.status, 400);
    assert.equal(chainCopy.value.error.code, 'destination_invalid');
    assert.equal(await readlink(copyChainMiddle), 'copy-chain-target.txt');
    assert.equal(await readlink(copyChainSource), 'copy-chain-middle');
    assert.equal(await readFile(copyChainTarget, 'utf8'), 'copy chain target');

    const moveChainTarget = join(root, 'move-chain-target.txt');
    const moveChainMiddle = join(root, 'move-chain-middle');
    const moveChainSource = join(root, 'move-chain-source');
    await writeFile(moveChainTarget, 'move chain target');
    await symlink('move-chain-target.txt', moveChainMiddle);
    await symlink('move-chain-middle', moveChainSource);
    const chainMove = await invokeTool(executor, 'move_path', {
      lease,
      source: moveChainSource,
      destination: moveChainMiddle,
      overwrite: true,
    });
    assert.equal(chainMove.ok, false);
    if (chainMove.ok) assert.fail('move unexpectedly replaced an intermediate symlink in its final-source referent chain');
    assert.equal(chainMove.status, 400);
    assert.equal(chainMove.value.error.code, 'destination_invalid');
    assert.equal(await readlink(moveChainMiddle), 'move-chain-target.txt');
    assert.equal(await readlink(moveChainSource), 'move-chain-middle');
    assert.equal(await readFile(moveChainTarget, 'utf8'), 'move chain target');

    await mkdir(join(root, 'copy-source'));
    await mkdir(join(root, 'copy-destination'));
    await writeFile(join(root, 'copy-source', 'new.txt'), 'new');
    await writeFile(join(root, 'copy-destination', 'preserved.txt'), 'preserved');
    await executor.call('copy_path', {
      lease,
      source: join(root, 'copy-source'),
      destination: join(root, 'copy-destination'),
      overwrite: true,
    });
    assert.equal(await readFile(join(root, 'copy-destination', 'new.txt'), 'utf8'), 'new');
    assert.equal(await readFile(join(root, 'copy-destination', 'preserved.txt'), 'utf8'), 'preserved');

    await executor.call('write_file', { lease, path: join(root, 'file-link'), content: 'replacement' });
    assert.equal((await lstat(join(root, 'file-link'))).isFile(), true);
    assert.equal(await readFile(join(root, 'file-link'), 'utf8'), 'replacement');
    assert.equal(await readFile(join(root, 'target', 'file.txt'), 'utf8'), 'inside');

    await executor.call('edit_file', {
      lease,
      path: join(root, 'edit-link'),
      edits: [{ oldText: 'inside', newText: 'edited replacement' }],
    });
    assert.equal((await lstat(join(root, 'edit-link'))).isFile(), true);
    assert.equal(await readFile(join(root, 'edit-link'), 'utf8'), 'edited replacement');
    assert.equal(await readFile(join(root, 'target', 'file.txt'), 'utf8'), 'inside');

    const aliasedMoveSource = join(root, 'target', 'aliased-move.txt');
    await writeFile(aliasedMoveSource, 'preserved');
    const aliasedMove = await invokeTool(executor, 'move_path', {
      lease,
      source: aliasedMoveSource,
      destination: join(root, 'directory-link', 'aliased-move.txt'),
      overwrite: true,
    });
    assert.equal(aliasedMove.ok, false);
    if (aliasedMove.ok) assert.fail('move unexpectedly treated two aliases of one named entry as distinct');
    assert.equal(aliasedMove.status, 400);
    assert.equal(aliasedMove.value.error.code, 'destination_invalid');
    assert.equal(await readFile(aliasedMoveSource, 'utf8'), 'preserved');

    await executor.call('delete_path', { lease, path: join(root, 'outside-link'), recursive: false });
    await assert.rejects(lstat(join(root, 'outside-link')), { code: 'ENOENT' });
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('descriptor-anchored tools resist deterministic parent and destination replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-bounded-races-'));
  const root = join(directory, 'home');
  const outside = join(directory, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(outside, 'sentinel.txt'), 'outside');
  try {
    const run = async (
      match: (event: BoundedFileHookEvent) => boolean,
      action: (event: BoundedFileHookEvent) => Promise<void>,
      invoke: (executor: ToolExecutor, lease: ReturnType<ToolExecutor['leases']['acquire']>) => Promise<void>,
    ): Promise<void> => {
      let used = false;
      const files = new BoundedFileSystem(root, {
        beforeUse: async (event) => {
          if (used || !match(event)) return;
          used = true;
          await action(event);
        },
      });
    const executor = new ToolExecutor(undefined, { durableRoot: root, files });
      const lease = executor.leases.acquire(60);
      await invoke(executor, lease);
      assert.equal(used, true, 'the deterministic race hook must run');
    };

    const metadataParent = join(root, 'metadata-parent');
    const displacedMetadataParent = join(root, 'metadata-parent-pinned');
    await mkdir(metadataParent);
    await writeFile(join(metadataParent, 'value.txt'), 'inside');
    await writeFile(join(outside, 'value.txt'), 'outside metadata');
    await run(
      (event) => event.operation === 'inspect' && event.stage === 'parent-resolved'
        && event.path === join(metadataParent, 'value.txt'),
      async () => { await rename(metadataParent, displacedMetadataParent); await symlink(outside, metadataParent); },
      async (executor, lease) => {
        const result = await executor.call('get_file_info', { lease, path: join(metadataParent, 'value.txt') }) as { size: number; type: string };
        assert.deepEqual({ size: result.size, type: result.type }, { size: 6, type: 'file' });
      },
    );

    const readParent = join(root, 'read-parent');
    const displacedReadParent = join(root, 'read-parent-pinned');
    await mkdir(readParent);
    await writeFile(join(readParent, 'value.txt'), 'inside');
    await run(
      (event) => event.operation === 'read' && event.stage === 'parent-resolved',
      async () => { await rename(readParent, displacedReadParent); await symlink(outside, readParent); },
      async (executor, lease) => {
        const result = await executor.call('read_file', { lease, path: join(readParent, 'value.txt') }) as { content: string };
        assert.equal(result.content, 'inside');
      },
    );

    const writeParent = join(root, 'write-parent');
    const displacedWriteParent = join(root, 'write-parent-pinned');
    await mkdir(writeParent);
    await writeFile(join(writeParent, 'value.txt'), 'before');
    await run(
      (event) => event.operation === 'write' && event.stage === 'parent-resolved',
      async () => { await rename(writeParent, displacedWriteParent); await symlink(outside, writeParent); },
      async (executor, lease) => { await executor.call('write_file', { lease, path: join(writeParent, 'value.txt'), content: 'after' }); },
    );
    assert.equal(await readFile(join(displacedWriteParent, 'value.txt'), 'utf8'), 'after');
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside');

    const copySource = join(root, 'copy-source.txt');
    const copyDestination = join(root, 'copy-destination.txt');
    await writeFile(copySource, 'copied');
    await run(
      (event) => event.operation === 'copy' && event.stage === 'destination-checked',
      async () => { await symlink(join(outside, 'sentinel.txt'), copyDestination); },
      async (executor, lease) => { await executor.call('copy_path', { lease, source: copySource, destination: copyDestination, overwrite: true }); },
    );
    assert.equal(await readFile(copyDestination, 'utf8'), 'copied');
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside');

    const guardedCopySource = join(root, 'guarded-copy-source.txt');
    const guardedCopyDestination = join(root, 'guarded-copy-destination.txt');
    await writeFile(guardedCopySource, 'must not overwrite');
    await run(
      (event) => event.operation === 'copy' && event.stage === 'destination-checked'
        && event.destination === guardedCopyDestination,
      async () => { await symlink(join(outside, 'sentinel.txt'), guardedCopyDestination); },
      async (executor, lease) => {
        const result = await invokeTool(executor, 'copy_path', {
          lease,
          source: guardedCopySource,
          destination: guardedCopyDestination,
          overwrite: false,
        });
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('copy unexpectedly replaced a destination introduced during the operation');
        assert.equal(result.status, 409);
        assert.equal(result.value.error.code, 'destination_exists');
      },
    );
    assert.equal((await lstat(guardedCopyDestination)).isSymbolicLink(), true);
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside');

    const chainRaceCopyTarget = join(root, 'chain-race-copy-target.txt');
    const chainRaceCopyDestination = join(root, 'chain-race-copy-destination.txt');
    const chainRaceCopyMiddle = join(root, 'chain-race-copy-middle');
    const displacedChainRaceCopyMiddle = join(root, 'chain-race-copy-middle-original');
    const chainRaceCopySource = join(root, 'chain-race-copy-source');
    await writeFile(chainRaceCopyTarget, 'original copy referent');
    await writeFile(chainRaceCopyDestination, 'protected copy destination');
    await symlink('chain-race-copy-target.txt', chainRaceCopyMiddle);
    await symlink('chain-race-copy-middle', chainRaceCopySource);
    await run(
      (event) => event.operation === 'copy' && event.stage === 'destination-checked'
        && event.source === chainRaceCopySource,
      async () => {
        await rename(chainRaceCopyMiddle, displacedChainRaceCopyMiddle);
        await symlink('chain-race-copy-destination.txt', chainRaceCopyMiddle);
      },
      async (executor, lease) => {
        const result = await invokeTool(executor, 'copy_path', {
          lease,
          source: chainRaceCopySource,
          destination: chainRaceCopyDestination,
          overwrite: true,
        });
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('copy unexpectedly committed after its final-source symlink chain changed');
        assert.equal(result.status, 409);
        assert.equal(result.value.error.code, 'path_changed');
      },
    );
    assert.equal(await readFile(chainRaceCopyDestination, 'utf8'), 'protected copy destination');
    assert.equal(await readlink(chainRaceCopySource), 'chain-race-copy-middle');
    assert.equal(await readlink(chainRaceCopyMiddle), 'chain-race-copy-destination.txt');
    assert.equal(await readlink(displacedChainRaceCopyMiddle), 'chain-race-copy-target.txt');

    const chainRaceMoveTarget = join(root, 'chain-race-move-target.txt');
    const chainRaceMoveDestination = join(root, 'chain-race-move-destination.txt');
    const chainRaceMoveMiddle = join(root, 'chain-race-move-middle');
    const displacedChainRaceMoveMiddle = join(root, 'chain-race-move-middle-original');
    const chainRaceMoveSource = join(root, 'chain-race-move-source');
    await writeFile(chainRaceMoveTarget, 'original move referent');
    await writeFile(chainRaceMoveDestination, 'protected move destination');
    await symlink('chain-race-move-target.txt', chainRaceMoveMiddle);
    await symlink('chain-race-move-middle', chainRaceMoveSource);
    await run(
      (event) => event.operation === 'move' && event.stage === 'destination-checked'
        && event.source === chainRaceMoveSource,
      async () => {
        await rename(chainRaceMoveMiddle, displacedChainRaceMoveMiddle);
        await symlink('chain-race-move-destination.txt', chainRaceMoveMiddle);
      },
      async (executor, lease) => {
        const result = await invokeTool(executor, 'move_path', {
          lease,
          source: chainRaceMoveSource,
          destination: chainRaceMoveDestination,
          overwrite: true,
        });
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('move unexpectedly committed after its final-source symlink chain changed');
        assert.equal(result.status, 409);
        assert.equal(result.value.error.code, 'path_changed');
      },
    );
    assert.equal(await readFile(chainRaceMoveDestination, 'utf8'), 'protected move destination');
    assert.equal(await readlink(chainRaceMoveSource), 'chain-race-move-middle');
    assert.equal(await readlink(chainRaceMoveMiddle), 'chain-race-move-destination.txt');
    assert.equal(await readlink(displacedChainRaceMoveMiddle), 'chain-race-move-target.txt');

    const editPath = join(root, 'edit-race.txt');
    const displacedEditPath = join(root, 'edit-race-original.txt');
    await writeFile(editPath, 'before edit');
    await run(
      (event) => event.operation === 'edit' && event.stage === 'destination-checked'
        && event.path === editPath,
      async () => { await rename(editPath, displacedEditPath); await symlink(join(outside, 'sentinel.txt'), editPath); },
      async (executor, lease) => {
        const result = await invokeTool(executor, 'edit_file', {
          lease,
          path: editPath,
          edits: [{ oldText: 'before', newText: 'after' }],
        });
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('edit unexpectedly replaced a changed destination');
        assert.equal(result.status, 409);
        assert.equal(result.value.error.code, 'path_changed');
      },
    );
    assert.equal(await readFile(displacedEditPath, 'utf8'), 'before edit');
    assert.equal((await lstat(editPath)).isSymbolicLink(), true);
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside');

    const moveSource = join(root, 'move-source.txt');
    const moveDestination = join(root, 'move-destination.txt');
    await writeFile(moveSource, 'moved');
    await run(
      (event) => event.operation === 'move' && event.stage === 'destination-checked',
      async () => { await symlink(join(outside, 'sentinel.txt'), moveDestination); },
      async (executor, lease) => { await executor.call('move_path', { lease, source: moveSource, destination: moveDestination, overwrite: true }); },
    );
    assert.equal(await readFile(moveDestination, 'utf8'), 'moved');
    await assert.rejects(lstat(moveSource), { code: 'ENOENT' });
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside');

    const replacedMoveSource = join(root, 'replaced-move-source.txt');
    const displacedMoveSource = join(root, 'replaced-move-original.txt');
    const replacedMoveDestination = join(root, 'replaced-move-destination.txt');
    await writeFile(replacedMoveSource, 'original move source');
    await run(
      (event) => event.operation === 'move' && event.stage === 'destination-checked'
        && event.source === replacedMoveSource,
      async () => {
        await rename(replacedMoveSource, displacedMoveSource);
        await writeFile(replacedMoveSource, 'replacement move source');
      },
      async (executor, lease) => {
        const result = await invokeTool(executor, 'move_path', {
          lease,
          source: replacedMoveSource,
          destination: replacedMoveDestination,
          overwrite: true,
        });
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('move unexpectedly committed a replaced final source');
        assert.equal(result.status, 409);
        assert.equal(result.value.error.code, 'path_changed');
      },
    );
    assert.equal(await readFile(replacedMoveSource, 'utf8'), 'replacement move source');
    assert.equal(await readFile(displacedMoveSource, 'utf8'), 'original move source');
    await assert.rejects(lstat(replacedMoveDestination), { code: 'ENOENT' });

    const replacedDeleteSource = join(root, 'replaced-delete-source.txt');
    const displacedDeleteSource = join(root, 'replaced-delete-original.txt');
    await writeFile(replacedDeleteSource, 'original delete source');
    await run(
      (event) => event.operation === 'delete' && event.stage === 'parent-resolved'
        && event.path === replacedDeleteSource,
      async () => {
        await rename(replacedDeleteSource, displacedDeleteSource);
        await writeFile(replacedDeleteSource, 'replacement delete source');
      },
      async (executor, lease) => {
        const result = await invokeTool(executor, 'delete_path', { lease, path: replacedDeleteSource });
        assert.equal(result.ok, false);
        if (result.ok) assert.fail('delete unexpectedly removed a replaced final source');
        assert.equal(result.status, 409);
        assert.equal(result.value.error.code, 'path_changed');
      },
    );
    assert.equal(await readFile(replacedDeleteSource, 'utf8'), 'replacement delete source');
    assert.equal(await readFile(displacedDeleteSource, 'utf8'), 'original delete source');

    const deleteParent = join(root, 'delete-parent');
    const displacedDeleteParent = join(root, 'delete-parent-pinned');
    await mkdir(join(deleteParent, 'tree'), { recursive: true });
    await writeFile(join(deleteParent, 'tree', 'inside.txt'), 'inside');
    await mkdir(join(outside, 'tree'));
    await writeFile(join(outside, 'tree', 'sentinel.txt'), 'outside-tree');
    await run(
      (event) => event.operation === 'delete' && event.stage === 'parent-resolved',
      async () => { await rename(deleteParent, displacedDeleteParent); await symlink(outside, deleteParent); },
      async (executor, lease) => { await executor.call('delete_path', { lease, path: join(deleteParent, 'tree'), recursive: true }); },
    );
    await assert.rejects(lstat(join(displacedDeleteParent, 'tree')), { code: 'ENOENT' });
    assert.equal(await readFile(join(outside, 'tree', 'sentinel.txt'), 'utf8'), 'outside-tree');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recursive copy removes partial staging after a deterministic special-file failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-copy-staging-'));
  const root = join(directory, 'home');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const socketPath = join(source, 'z-special.sock');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'a-copied-first.txt'), 'staged before failure');
  const socket = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(socketPath, resolve);
    });
    const executor = new ToolExecutor(undefined, { durableRoot: root });
    const lease = executor.leases.acquire(60);
    const result = await invokeTool(executor, 'copy_path', { lease, source, destination });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('recursive copy unexpectedly accepted a Unix socket');
    assert.equal(result.status, 400);
    assert.equal(result.value.error.code, 'path_invalid');
    assert.match(result.value.error.message, new RegExp(escapeRegExp(source)));
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.startsWith('.qubicl-copy-') || name.startsWith('.qubicl-quarantine-')),
      [],
    );
    assert.equal(await readFile(join(source, 'a-copied-first.txt'), 'utf8'), 'staged before failure');
  } finally {
    if (socket.listening) await new Promise<void>((resolve) => socket.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded mutations report post-commit cleanup, durability, and capability outcomes precisely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-bounded-outcomes-'));
  const root = join(directory, 'home');
  await mkdir(root);
  try {
    const cleanupSource = join(root, 'cleanup-source.txt');
    const cleanupDestination = join(root, 'cleanup-destination.txt');
    await writeFile(cleanupSource, 'new destination');
    await writeFile(cleanupDestination, 'old destination');
    const cleanupFiles = new BoundedFileSystem(root, {
      beforeUse: (event) => {
        if (event.operation === 'copy' && event.stage === 'before-quarantine-cleanup' && event.path === cleanupDestination) {
          throw new Error('deterministic cleanup failure');
        }
      },
    });
    const cleanupExecutor = new ToolExecutor(undefined, { durableRoot: root, files: cleanupFiles });
    const cleanupLease = cleanupExecutor.leases.acquire(60);
    const cleanup = await invokeTool(cleanupExecutor, 'copy_path', {
      lease: cleanupLease,
      source: cleanupSource,
      destination: cleanupDestination,
      overwrite: true,
    });
    assert.equal(cleanup.ok, false);
    if (cleanup.ok) assert.fail('copy unexpectedly hid its post-commit cleanup failure');
    assert.equal(cleanup.status, 500);
    assert.equal(cleanup.value.error.code, 'mutation_committed_cleanup_incomplete');
    assert.equal(await readFile(cleanupDestination, 'utf8'), 'new destination');
    assert.equal((await readdir(root)).some((name) => name.startsWith('.qubicl-quarantine-')), true);

    const durabilityPath = join(root, 'durability.txt');
    const durabilityFiles = new BoundedFileSystem(root, {
      beforeUse: (event) => {
        if (event.operation === 'write' && event.stage === 'before-parent-sync' && event.path === durabilityPath) {
          throw new Error('deterministic parent fsync failure');
        }
      },
    });
    const durabilityExecutor = new ToolExecutor(undefined, { durableRoot: root, files: durabilityFiles });
    const durabilityLease = durabilityExecutor.leases.acquire(60);
    const durability = await invokeTool(durabilityExecutor, 'write_file', {
      lease: durabilityLease,
      path: durabilityPath,
      content: 'committed before fsync',
    });
    assert.equal(durability.ok, false);
    if (durability.ok) assert.fail('write unexpectedly hid its post-commit durability uncertainty');
    assert.equal(durability.status, 500);
    assert.equal(durability.value.error.code, 'mutation_durability_uncertain');
    assert.equal(await readFile(durabilityPath, 'utf8'), 'committed before fsync');

    const capabilityPath = join(root, 'capability.txt');
    await writeFile(capabilityPath, 'unread by an unprobed runtime');
    const unavailableFiles = new BoundedFileSystem(root, {
      capabilityProbe: () => { throw new Error('deterministic missing capability'); },
    });
    const unavailableExecutor = new ToolExecutor(undefined, { durableRoot: root, files: unavailableFiles });
    const unavailableLease = unavailableExecutor.leases.acquire(60);
    const unavailable = await invokeTool(unavailableExecutor, 'read_file', { lease: unavailableLease, path: capabilityPath });
    assert.equal(unavailable.ok, false);
    if (unavailable.ok) assert.fail('file access unexpectedly continued after its capability probe failed');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.value.error.code, 'filesystem_hardening_unavailable');
    assert.match(unavailable.value.error.message, /bounded filesystem runtime probe failed/);

    const locusSource = join(root, 'locus-source.txt');
    const locusDestination = join(root, 'locus-destination.txt');
    await writeFile(locusSource, 'source remains available');
    const locusFiles = new BoundedFileSystem(root, {
      beforeUse: (event) => {
        if (event.operation === 'copy' && event.stage === 'destination-checked' && event.destination === locusDestination) {
          const error = new Error('deterministic destination denial') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
      },
    });
    const locusExecutor = new ToolExecutor(undefined, { durableRoot: root, files: locusFiles });
    const locusLease = locusExecutor.leases.acquire(60);
    const locus = await invokeTool(locusExecutor, 'copy_path', {
      lease: locusLease,
      source: locusSource,
      destination: locusDestination,
    });
    assert.equal(locus.ok, false);
    if (locus.ok) assert.fail('copy unexpectedly ignored a destination permission failure');
    assert.equal(locus.status, 403);
    assert.equal(locus.value.error.code, 'permission_denied');
    assert.match(locus.value.error.message, new RegExp(escapeRegExp(locusDestination)));
    await assert.rejects(lstat(locusDestination), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded filesystem uses execute-only traversal, compatible mkdir symlinks, sparse copies, and root-wide mutation serialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-bounded-platform-'));
  const root = join(directory, 'home');
  const outside = join(directory, 'outside');
  const executeOnly = join(root, 'execute-only');
  await Promise.all([mkdir(root), mkdir(outside)]);
  await mkdir(executeOnly);
  try {
    const files = new BoundedFileSystem(root);
    await writeFile(join(executeOnly, 'readable.txt'), 'through O_PATH');
    await chmod(executeOnly, 0o111);
    const traversed = await files.readFile(join(executeOnly, 'readable.txt'));
    assert.equal(traversed.data.toString('utf8'), 'through O_PATH');
    await chmod(executeOnly, 0o755);

    const mkdirTarget = join(root, 'mkdir-target');
    const mkdirLink = join(root, 'mkdir-link');
    await mkdir(mkdirTarget);
    await symlink('mkdir-target', mkdirLink);
    await files.mkdir(mkdirLink);
    assert.equal((await lstat(mkdirLink)).isSymbolicLink(), true);

    const outsideLink = join(root, 'outside-mkdir-link');
    await symlink(outside, outsideLink);
    await assert.rejects(files.mkdir(outsideLink), /resolves outside the bounded root/);
    assert.equal((await lstat(outsideLink)).isSymbolicLink(), true);

    const sparseSource = join(root, 'sparse-source.bin');
    const sparseDestination = join(root, 'sparse-destination.bin');
    const sparseSize = 4 * 1024 * 1024;
    const sparseHandle = await open(sparseSource, 'w', 0o644);
    try {
      await sparseHandle.truncate(sparseSize);
      await sparseHandle.write(Buffer.from('tail'), 0, 4, sparseSize - 4);
      await sparseHandle.sync();
    } finally {
      await sparseHandle.close();
    }
    await files.copy(sparseSource, sparseDestination, false);
    const [sourceInfo, destinationInfo] = await Promise.all([lstat(sparseSource), lstat(sparseDestination)]);
    assert.equal(destinationInfo.size, sparseSize);
    assert.ok(destinationInfo.blocks <= sourceInfo.blocks + 32, 'descriptor-safe copy should preserve sparse/reflink-friendly allocation');

    const realParent = join(root, 'serialized-parent');
    const aliasParent = join(root, 'serialized-alias');
    await mkdir(realParent);
    await symlink('serialized-parent', aliasParent);
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondEntered = false;
    const firstFiles = new BoundedFileSystem(root, {
      beforeUse: async (event) => {
        if (event.operation === 'write' && event.stage === 'parent-resolved' && event.path.endsWith('/first.txt')) {
          markFirstEntered();
          await firstRelease;
        }
      },
    });
    const secondFiles = new BoundedFileSystem(root, {
      beforeUse: (event) => {
        if (event.operation === 'write' && event.stage === 'parent-resolved' && event.path.endsWith('/second.txt')) {
          secondEntered = true;
        }
      },
    });
    const firstWrite = firstFiles.writeFile(join(realParent, 'first.txt'), Buffer.from('first'), { createParents: false });
    await firstEntered;
    const secondWrite = secondFiles.writeFile(join(aliasParent, 'second.txt'), Buffer.from('second'), { createParents: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondEntered, false, 'a mutation through an alias must wait for the root mutation queue');
    releaseFirst();
    await Promise.all([firstWrite, secondWrite]);
    assert.equal(secondEntered, true);
    assert.equal(await readFile(join(realParent, 'first.txt'), 'utf8'), 'first');
    assert.equal(await readFile(join(realParent, 'second.txt'), 'utf8'), 'second');
  } finally {
    await chmod(executeOnly, 0o755).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('file metadata represents unavailable creation time as null instead of the Unix epoch', () => {
  assert.equal(creationTime({ birthtimeMs: 0 }), null);
  assert.equal(creationTime({ birthtimeMs: Date.parse('2026-08-20T12:34:56.789Z') }), '2026-08-20T12:34:56.789Z');
});

test('file tools return stable actionable errors for ordinary path failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-file-errors-'));
  try {
    const executor = new ToolExecutor(undefined, { durableRoot: directory });
    const lease = executor.leases.acquire(60);
    const missing = join(directory, 'missing');
    const source = join(directory, 'source.txt');
    const existing = join(directory, 'existing.txt');
    const destinationDirectory = join(directory, 'destination-directory');
    await writeFile(source, 'source');
    await writeFile(existing, 'existing');
    await executor.call('write_file', { lease, path: join(destinationDirectory, 'child.txt'), content: 'child' });

    const missingInfo = await invokeTool(executor, 'get_file_info', { lease, path: missing });
    assert.equal(missingInfo.ok, false);
    if (missingInfo.ok) assert.fail('missing metadata unexpectedly succeeded');
    assert.equal(missingInfo.status, 404);
    assert.deepEqual(missingInfo.value, {
      error: { code: 'path_not_found', message: `Path ${missing} was not found. Check the path and retry.` },
    });

    const missingCopy = await invokeTool(executor, 'copy_path', { lease, source: missing, destination: join(directory, 'copy') });
    assert.equal(missingCopy.ok, false);
    if (missingCopy.ok) assert.fail('missing copy source unexpectedly succeeded');
    assert.equal(missingCopy.status, 404);
    assert.equal(missingCopy.value.error.code, 'path_not_found');
    assert.match(missingCopy.value.error.message, new RegExp(escapeRegExp(missing)));

    const preservedDestination = join(directory, 'preserved.txt');
    await writeFile(preservedDestination, 'preserve me');
    const missingMove = await invokeTool(executor, 'move_path', {
      lease,
      source: missing,
      destination: preservedDestination,
      overwrite: true,
    });
    assert.equal(missingMove.ok, false);
    if (missingMove.ok) assert.fail('missing move source unexpectedly succeeded');
    assert.equal(missingMove.status, 404);
    assert.equal(missingMove.value.error.code, 'path_not_found');
    assert.equal(await readFile(preservedDestination, 'utf8'), 'preserve me');

    const existingCopy = await invokeTool(executor, 'copy_path', { lease, source, destination: existing });
    assert.equal(existingCopy.ok, false);
    if (existingCopy.ok) assert.fail('copy to an existing destination unexpectedly succeeded');
    assert.equal(existingCopy.status, 409);
    assert.deepEqual(existingCopy.value, {
      error: {
        code: 'destination_exists',
        message: `Destination ${existing} already exists. Choose another destination or retry with overwrite enabled.`,
      },
    });

    const invalidCopy = await invokeTool(executor, 'copy_path', {
      lease,
      source,
      destination: destinationDirectory,
      overwrite: true,
    });
    assert.equal(invalidCopy.ok, false);
    if (invalidCopy.ok) assert.fail('copy to an incompatible destination unexpectedly succeeded');
    assert.equal(invalidCopy.status, 400);
    assert.equal(invalidCopy.value.error.code, 'destination_invalid');
    assert.match(invalidCopy.value.error.message, new RegExp(escapeRegExp(destinationDirectory)));
    assert.equal(await readFile(join(destinationDirectory, 'child.txt'), 'utf8'), 'child');

    const nonRecursiveDelete = await invokeTool(executor, 'delete_path', { lease, path: destinationDirectory });
    assert.equal(nonRecursiveDelete.ok, false);
    if (nonRecursiveDelete.ok) assert.fail('non-recursive directory deletion unexpectedly succeeded');
    assert.equal(nonRecursiveDelete.status, 400);
    assert.deepEqual(nonRecursiveDelete.value, {
      error: {
        code: 'recursive_required',
        message: `Path ${destinationDirectory} is a directory. Retry with recursive deletion enabled.`,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('read_file paginates text and returns supported images as image payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-read-'));
  try {
    const executor = new ToolExecutor(undefined, { durableRoot: directory });
    const lease = executor.leases.acquire(60);
    const textPath = join(directory, 'lines.txt');
    await writeFile(textPath, 'one\ntwo\nthree\nfour');
    const section = await executor.call('read_file', { lease, path: textPath, offset: 2, limit: 2 }) as {
      content: string; startLine: number; endLine: number; totalLines: number; truncated: boolean; nextOffset: number;
    };
    assert.deepEqual(section, {
      path: textPath,
      size: 18,
      encoding: 'utf8',
      content: 'two\nthree',
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      truncated: true,
      nextOffset: 4,
      continuation: 'Read the next section with offset 4.',
    });

    const imagePath = join(directory, 'pixel.png');
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(3, 16);
    png.writeUInt32BE(2, 20);
    await writeFile(imagePath, png);
    const image = await executor.call('read_file', { lease, path: imagePath }) as { mimeType: string; width: number; height: number; data: string };
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.width, 3);
    assert.equal(image.height, 2);
    assert.equal(Buffer.from(image.data, 'base64').equals(png), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('list_files returns deterministic root-relative pages instead of failing at the limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-list-'));
  try {
    await Promise.all(['charlie', 'alpha', 'bravo'].map((name) => writeFile(join(directory, name), name)));
    const executor = new ToolExecutor(undefined, { durableRoot: directory });
    const lease = executor.leases.acquire(60);
    const first = await executor.call('list_files', {
      lease,
      path: directory,
      maxEntries: 2,
    }) as { entries: Array<{ name: string; type: string }>; truncated: boolean; nextCursor: number };
    assert.deepEqual(first.entries, [
      { name: 'alpha', type: 'file' },
      { name: 'bravo', type: 'file' },
    ]);
    assert.equal(first.truncated, true);
    assert.equal(first.nextCursor, 2);
    const second = await executor.call('list_files', {
      lease,
      path: directory,
      cursor: first.nextCursor,
      maxEntries: 2,
    }) as { entries: Array<{ name: string; type: string }>; truncated: boolean };
    assert.deepEqual(second.entries, [{ name: 'charlie', type: 'file' }]);
    assert.equal(second.truncated, false);

    await Promise.all(Array.from({ length: 160 }, (_, index) => writeFile(
      join(directory, `long-${index.toString().padStart(3, '0')}-${'x'.repeat(180)}`),
      'x',
    )));
    const bounded = await executor.call('list_files', {
      lease,
      path: directory,
      maxEntries: 1000,
    }) as { truncated: boolean; nextCursor: number };
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 24_000);
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.nextCursor > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('read_file bounds long lines and rejects model-visible base64 for unknown binary data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-read-bounds-'));
  try {
    const executor = new ToolExecutor(undefined, { durableRoot: directory });
    const lease = executor.leases.acquire(60);
    const longPath = join(directory, 'long.txt');
    await writeFile(longPath, `${'x'.repeat(60_000)}\nnext`);
    const bounded = await executor.call('read_file', { lease, path: longPath }) as {
      content: string; truncated: boolean; nextOffset: number; note: string;
    };
    assert.equal(Buffer.byteLength(bounded.content), 24_000);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.nextOffset, 2);
    assert.match(bounded.note, /response limit/);

    const binaryPath = join(directory, 'unknown.bin');
    await writeFile(binaryPath, Buffer.from([0xff, 0x00, 0xfe]));
    await assert.rejects(executor.call('read_file', { lease, path: binaryPath }), /client-native file download/);
    await assert.rejects(executor.call('read_file', { lease, path: binaryPath, encoding: 'base64' }), /Invalid option/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('edit_file preserves UTF-8 BOM and CRLF while enforcing safe exact matches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-edit-'));
  try {
    const executor = new ToolExecutor(undefined, { durableRoot: directory });
    const lease = executor.leases.acquire(60);
    const path = join(directory, 'source.txt');
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\r\nbeta\r\n', 'utf8')]));
    const result = await executor.call('edit_file', {
      lease,
      path,
      edits: [
        { oldText: 'alpha', newText: 'first\nsecond' },
        { oldText: 'beta', newText: 'third' },
      ],
    }) as { replacements: number; diff: string };
    assert.equal(result.replacements, 2);
    assert.match(result.diff, /-alpha/);
    assert.match(result.diff, /\+first/);
    assert.equal((await readFile(path)).equals(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('first\r\nsecond\r\nthird\r\n', 'utf8'),
    ])), true);

    await writeFile(path, 'same same');
    await assert.rejects(executor.call('edit_file', { lease, path, edits: [{ oldText: 'same', newText: 'changed' }] }), /more than once/);
    await writeFile(path, 'abcdef');
    await assert.rejects(executor.call('edit_file', {
      lease,
      path,
      edits: [{ oldText: 'abc', newText: 'one' }, { oldText: 'bc', newText: 'two' }],
    }), /overlap/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent writes to one file are serialized without partial content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-write-queue-'));
  try {
    const executor = new ToolExecutor(undefined, { durableRoot: directory });
    const lease = executor.leases.acquire(60);
    const path = join(directory, 'queued.txt');
    await Promise.all([
      executor.call('write_file', { lease, path, content: 'first' }),
      executor.call('write_file', { lease, path, content: 'second' }),
    ]);
    assert.equal(await readFile(path, 'utf8'), 'second');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unexpected errors do not expose internal messages', () => {
  assert.deepEqual(errorPayload(new Error('secret implementation detail')), {
    error: { code: 'internal_error', message: 'The computer encountered an internal error.' },
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
