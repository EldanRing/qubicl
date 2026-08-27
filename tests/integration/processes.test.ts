import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolExecutor, type ControlAction } from '@qubicl/control/executor';
import { ProcessManager } from '@qubicl/control/processes';
import { invokeTool } from '../../packages/control/dist/contract.js';
import { errorPayload } from '../../packages/control/dist/errors.js';
import { creationTime } from '../../packages/control/dist/file-errors.js';

const owner = { id: 'test-lease', generation: 1, epoch: 'test-epoch' };

test('managed process safety bounds reject zero and fractional configuration', () => {
  assert.throws(() => new ProcessManager({ maxProcesses: 0 }), /maxProcesses/);
  assert.throws(() => new ProcessManager({ maxRetainedOutputBytes: 0 }), /maxRetainedOutputBytes/);
  assert.throws(() => new ProcessManager({ completedTtlMs: 0 }), /completedTtlMs/);
  assert.throws(() => new ProcessManager({ maxFullOutputBytes: 0 }), /maxFullOutputBytes/);
  assert.throws(() => new ProcessManager({ outputTtlMs: 0 }), /outputTtlMs/);
  assert.throws(() => new ProcessManager({ maxProcesses: 1.5 }), /maxProcesses/);
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
  } finally {
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
