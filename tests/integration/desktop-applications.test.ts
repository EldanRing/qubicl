import assert from 'node:assert/strict';
import { chmod, chown, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { buildComputerManifest, manifestSha256 } from '@qubicl/core';
import { DesktopApplicationManager } from '@qubicl/control/desktop-applications';
import { ToolExecutor } from '@qubicl/control/executor';
import { ProcessManager } from '@qubicl/control/processes';
import { NativeDesktopManager } from '@qubicl/control/desktop-native';

test('single-instance launch handoffs reuse the canonical app and retain delayed aliases', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-app-handoff-'));
  const script = join(root, 'editor.cjs');
  await writeFile(script, `const fs=require('fs');const marker=${JSON.stringify(join(root, 'started'))};if(fs.existsSync(marker)){setTimeout(()=>process.exit(0),process.argv.some(value=>value.endsWith('/late.txt'))?450:10)}else{fs.writeFileSync(marker,'ready');setInterval(()=>{},1000)}`);
  const closes: number[] = [];
  const manager = new DesktopApplicationManager('computer', { root, maxApplications: 1,
    definitions: { 'text-editor': { executable: process.execPath, fixedArguments: [script], allowedPathKind: 'file', reusesExistingProcess: true } },
    requestClose: async (pid) => { closes.push(pid); return { requested: true }; },
  });
  context.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const first = await manager.open('text-editor', []);
  // Wait for the fixture's explicit ready marker, not arbitrary GUI startup.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await readFile(join(root, 'started')).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const second = await manager.open('text-editor', []);
  assert.equal(second.applicationId, first.applicationId);
  assert.equal(second.disposition, 'reused');
  assert.equal(manager.list().length, 1);
  await manager.close(second.applicationId, false, 'request');
  assert.equal(closes[0], first.pid);
  await writeFile(join(root, 'late.txt'), '');
  const late = await manager.open('text-editor', ['late.txt']);
  assert.notEqual(late.applicationId, first.applicationId);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(manager.list().length, 1);
  assert.ok(manager.list()[0]!.aliases?.includes(late.applicationId));
  assert.equal((await manager.close(late.applicationId, false, 'request')).applicationId, first.applicationId);
});

test('successful launchers retain borrowed daemon identities without taking over process termination', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-external-app-'));
  const daemon = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const windows = [{ id: 42, pid: daemon.pid! }, { id: 99, pid: process.pid }];
  const closes: number[] = [];
  const manager = new DesktopApplicationManager('computer', { root,
    definitions: { 'file-manager': { executable: process.execPath, fixedArguments: ['-e', 'process.exit(0)'], allowedPathKind: 'directory', reusesExistingProcess: true } },
    observeWindows: async () => windows.filter((window) => window.id !== 99),
    requestCloseWindow: async (id) => { closes.push(id); return { windowId: id }; },
  });
  context.after(async () => { await manager.shutdown(); daemon.kill(); await rm(root, { recursive: true, force: true }); });
  const app = await manager.open('file-manager', []);
  assert.equal(app.disposition, 'reused');
  assert.equal(app.processOwnership, 'external');
  assert.equal(app.pid, daemon.pid);
  assert.deepEqual(app.windowIds, [42]);
  assert.equal(manager.list()[0]!.applicationId, app.applicationId);
  await assert.rejects(manager.close(app.applicationId, true, 'terminate'), /shared daemon/);
  assert.equal((await manager.close(app.applicationId)).state, 'close_requested');
  assert.deepEqual(closes, [42]);
  await manager.shutdown();
  assert.equal(daemon.exitCode, null);
  process.kill(daemon.pid!, 0);
});

test('real Mousepad reopens another file with a canonical closable application identity', {
  skip: process.env.QUBICL_TEST_NATIVE_DESKTOP !== '1' && 'Run in a disposable X11/AT-SPI guest.', timeout: 15_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-mousepad-reuse-'));
  await writeFile(join(root, 'first.txt'), 'First');
  await writeFile(join(root, 'second.txt'), 'Second');
  const desktop = new NativeDesktopManager({ script: join(process.cwd(), 'packages/control/src/desktop-helper.py') });
  const manager = new DesktopApplicationManager('computer', { root, requestClose: (pid) => desktop.closeProcessWindows(pid) });
  context.after(async () => { await manager.shutdown(); desktop.shutdown(); await rm(root, { recursive: true, force: true }); });
  const first = await manager.open('text-editor', ['first.txt']);
  const waitForWindow = async (present: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const windows = (await desktop.windows()).windows as Array<{ pid: number }>;
      if (windows.some((window) => window.pid === first.pid) === present) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Expected managed Mousepad window present=${present}`);
  };
  await waitForWindow(true);
  const second = await manager.open('text-editor', ['second.txt']);
  assert.equal(second.applicationId, first.applicationId);
  assert.equal(second.disposition, 'reused');
  assert.equal(manager.list().length, 1);
  assert.equal((await manager.close(second.applicationId)).state, 'close_requested');
  await waitForWindow(false);
});

test('real Thunar handoff to a pre-existing daemon retains a window-close identity', {
  skip: process.env.QUBICL_TEST_NATIVE_DESKTOP !== '1' && 'Run in a disposable X11/AT-SPI guest.', timeout: 20_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-thunar-daemon-'));
  const identity = process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : {};
  if ('uid' in identity) await chown(root, identity.uid!, identity.gid!);
  const desktop = new NativeDesktopManager({ script: join(process.cwd(), 'packages/control/src/desktop-helper.py'), ...identity });
  const daemon = spawn('/usr/bin/thunar', ['--daemon'], { detached: true, stdio: 'ignore', ...identity, env: { ...process.env, HOME: root } });
  const windows = async () => (await desktop.windows()).windows as Array<{ id: number; pid: number | null }>;
  const manager = new DesktopApplicationManager('computer', { root,
    ...('uid' in identity ? { spawnUid: identity.uid, spawnGid: identity.gid } : {}),
    observeWindows: windows, requestCloseWindow: (id) => desktop.windowAction(id, 'close'),
  });
  context.after(async () => { await manager.shutdown(); desktop.shutdown(); daemon.kill(); await rm(root, { recursive: true, force: true }); });
  // Wait for D-Bus daemon registration, not a document window.
  await new Promise((done) => setTimeout(done, 300));
  const app = await manager.open('file-manager', [root]);
  assert.equal(app.disposition, 'reused');
  assert.equal(app.processOwnership, 'external');
  assert.equal(app.pid, daemon.pid);
  assert.ok(app.windowIds?.length);
  assert.equal(manager.list()[0]!.applicationId, app.applicationId);
  assert.equal((await manager.close(app.applicationId)).state, 'close_requested');
  await waitFor(async () => !(await windows()).some((window) => app.windowIds!.includes(window.id)));
  process.kill(daemon.pid!, 0);
});

test('native desktop actions return observations, strip lease secrets and fence queued input at takeover', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-native-contract-'));
  const manifest = buildComputerManifest('workstation', 'test', 'revision');
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let releaseSnapshot: (() => void) | undefined;
  let startedSnapshot: (() => void) | undefined;
  let blockSnapshot = false;
  const started = new Promise<void>((resolve) => { startedSnapshot = resolve; });
  const executor = new ToolExecutor({ manifest, sha256: manifestSha256(manifest) }, {
    processes: new ProcessManager({ outputDirectory: join(root, 'output') }),
    desktop: {
      native: async (method, input) => {
        calls.push({ method, input });
        if (method === 'snapshot' && blockSnapshot) {
          startedSnapshot?.();
          await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
        }
        if (method === 'windows') return { windows: [{ id: 42, active: true }] };
        if (method === 'snapshot') return { window: { id: 42 }, elements: [{ name: 'Saved' }] };
        return { windowId: 42, dispatch: 'completed', verified: false };
      },
      screenshot: async () => ({ mimeType: 'image/png', data: 'AA==', width: 1, height: 1 }),
      control: async () => ({ dispatch: 'completed', verified: false }),
      readClipboard: async () => ({ text: '' }), writeClipboard: async () => ({ written: true }),
    },
  });
  context.after(async () => { await executor.shutdown(); await rm(root, { recursive: true, force: true }); });
  const lease = executor.leases.acquire(60);
  const result = await executor.call('desktop_window_action', { lease, windowId: 42, action: 'focus', observe: 'snapshot' }) as Record<string, unknown>;
  assert.equal(result.verified, false);
  assert.deepEqual(result.observation, { window: { id: 42 }, elements: [{ name: 'Saved' }] });
  assert.equal((result.contentTrust as { source: string }).source, 'desktop');
  assert.ok(calls.every(({ input }) => !('lease' in input)));
  blockSnapshot = true;
  const observation = executor.call('desktop_snapshot', { windowId: 42 });
  await started;
  const queued = executor.call('desktop_window_action', { lease, windowId: 42, action: 'close' });
  const rejected = assert.rejects(queued, /human|stale|lease/i);
  await executor.takeHumanControl();
  releaseSnapshot?.();
  await observation;
  await rejected;
  assert.equal(calls.filter(({ method }) => method === 'windowAction').length, 1, 'queued close must never reach the session');
});

test('desktop focused observations and expected-state waits preserve one dispatch and explicit timeout receipts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-native-observe-'));
  const manifest = buildComputerManifest('workstation', 'test', 'revision');
  const ref = 'a'.repeat(24) + 'e0';
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let probes = 0;
  let match = false;
  const executor = new ToolExecutor({ manifest, sha256: manifestSha256(manifest) }, {
    processes: new ProcessManager({ outputDirectory: join(root, 'output') }),
    desktop: {
      native: async (method, input) => {
        calls.push({ method, input });
        if (method === 'act') return { ref, windowId: 42, dispatch: 'completed', verified: false, acceptedByAccessibilityApi: null };
        if (method === 'observe' && input.waitFor) {
          probes++;
          return { conditionMatched: match && probes > 1, windows: match && probes > 1 ? [] : [{ id: 42 }] };
        }
        if (method === 'observe') return { element: { ref, text: 'Two\nlines', states: ['focused'] } };
        return { window: { id: 42 }, elements: [{ ref }] };
      },
      screenshot: async () => ({}), control: async () => ({}),
      readClipboard: async () => ({ text: '' }), writeClipboard: async () => ({ written: true }),
    },
  });
  context.after(async () => { await executor.shutdown(); await rm(root, { recursive: true, force: true }); });
  const lease = executor.leases.acquire(60);
  const focused = await executor.call('desktop_element_action', { lease, ref, action: 'set_text', text: 'Two\nlines', observe: 'target', observationOptions: { maxBytes: 2048 } }) as Record<string, unknown>;
  assert.deepEqual(focused.observation, { element: { ref, text: 'Two\nlines', states: ['focused'] } });
  assert.equal(focused.verified, false);
  assert.deepEqual(calls.map(call => call.method), ['act', 'observe']);
  assert.equal(calls[1]!.input.detail, 'compact');
  assert.equal(calls[1]!.input.maxBytes, 2048);
  assert.equal(calls[1]!.input.ref, ref);
  await executor.call('desktop_element_action', { lease, ref, action: 'focus', observe: 'snapshot', observationOptions: { ref, limit: 2, maxBytes: 2048, detail: 'compact' } });
  assert.deepEqual(calls.at(-1), { method: 'snapshot', input: { ref, windowId: 42, limit: 2, maxBytes: 2048, detail: 'compact' } });
  assert.ok(!calls.some(call => call.method === 'windows'), 'targeted snapshots need no redundant window inventory');
  const waitFor = { state: 'window_closed', windowId: 42, timeoutMs: 20 };
  const timeout = await executor.call('desktop_element_action', { lease, ref, action: 'invoke', observe: 'windows', waitFor }) as Record<string, unknown>;
  assert.equal((timeout.wait as Record<string, unknown>).status, 'not_observed_yet');
  assert.equal(timeout.dispatch, 'completed');
  assert.equal(timeout.verified, false);
  assert.equal(timeout.acceptedByAccessibilityApi, null);
  assert.equal(calls.filter(call => call.method === 'act').length, 3);
  match = true; probes = 0;
  const done = await executor.call('desktop_element_action', { lease, ref, action: 'invoke', observe: 'windows', waitFor: { ...waitFor, timeoutMs: 2000 } }) as Record<string, unknown>;
  assert.equal((done.wait as Record<string, unknown>).status, 'observed');
  assert.deepEqual(done.observation, { windows: [] });
  assert.equal(done.verified, false);
  assert.equal(calls.filter(call => call.method === 'act').length, 4, 'wait must never repeat input');
  assert.ok(calls.every(call => !('lease' in call.input) && !('observationOptions' in call.input)));
  assert.ok(calls.filter(call => call.method === 'act').every(call => !('waitFor' in call.input)));
  await assert.rejects(executor.call('desktop_element_action', { lease, ref, action: 'invoke', waitFor: { ...waitFor, timeoutMs: 10001 } }), /10000|too_big|invalid/i);
  assert.equal(calls.filter(call => call.method === 'act').length, 4, 'invalid wait cannot dispatch');
});

test('a timed-out native observation cannot hide queued input from takeover fencing', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-native-wait-fence-'));
  const manifest = buildComputerManifest('workstation', 'test', 'revision');
  let completeRead: ((value: Record<string, unknown>) => void) | undefined;
  let dispatches = 0;
  const executor = new ToolExecutor({ manifest, sha256: manifestSha256(manifest) }, {
    processes: new ProcessManager({ outputDirectory: join(root, 'output') }),
    desktop: {
      native: async (method) => {
        if (method === 'observe') return new Promise((resolve) => { completeRead = resolve; });
        dispatches++;
        return { windowId: 42, dispatch: 'completed', verified: false };
      },
      screenshot: async () => ({}), control: async () => ({}),
      readClipboard: async () => ({ text: '' }), writeClipboard: async () => ({ written: true }),
    },
  });
  context.after(async () => { completeRead?.({ conditionMatched: false }); await executor.shutdown(); await rm(root, { recursive: true, force: true }); });
  const lease = executor.leases.acquire(60);
  const first = await executor.call('desktop_window_action', { lease, windowId: 42, action: 'close', waitFor: { state: 'window_closed', windowId: 42, timeoutMs: 20 } }) as Record<string, unknown>;
  assert.equal((first.wait as Record<string, unknown>).status, 'not_observed_yet');
  const queued = executor.call('desktop_window_action', { lease, windowId: 43, action: 'focus' });
  const rejected = assert.rejects(queued, /human|stale|lease/i);
  await executor.takeHumanControl();
  completeRead!({ conditionMatched: true, windows: [] });
  await rejected;
  assert.equal(dispatches, 1, 'no input may be queued in a busy helper before ownership is rechecked');
});

test('allowlisted desktop-session applications survive takeover while generic commands are fenced', async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qubicl-desktop-applications-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'qubicl-desktop-outside-')));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const document = join(root, 'document.txt');
  const environmentPath = join(root, 'application-environment.json');
  const outsideDocument = join(outside, 'outside.txt');
  const disallowedDocument = join(root, 'not-allowlisted.bin');
  await writeFile(document, 'desktop session');
  await writeFile(outsideDocument, 'outside');
  await writeFile(disallowedDocument, 'binary-shaped input');
  await symlink(outsideDocument, join(root, 'escaped.txt'));
  await mkdir(join(root, '.local', 'bin'), { recursive: true });
  await mkdir(join(root, '.local', 'share', 'applications'), { recursive: true });
  const userGui = join(root, '.local', 'bin', 'user-gui');
  await writeFile(userGui, '#!/bin/sh\nexit 0\n');
  await chmod(userGui, 0o755);
  await writeFile(join(root, '.local', 'share', 'applications', 'user-gui.desktop'), [
    '[Desktop Entry]',
    'Name=User GUI',
    `Exec=${join(root, '.local', 'bin', 'user-gui')} %F`,
    'Type=Application',
  ].join('\n'));
  await writeFile(join(root, '.local', 'share', 'applications', 'hidden.desktop'), [
    '[Desktop Entry]',
    'Name=Hidden GUI',
    `Exec=${join(root, '.local', 'bin', 'user-gui')}`,
    'NoDisplay=true',
  ].join('\n'));

  const fakeApplication = [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[1], JSON.stringify({ env: process.env, pid: process.pid, paths: process.argv.slice(2) }));",
    'setInterval(() => undefined, 1000);',
  ].join('');
  const desktopApplications = new DesktopApplicationManager('workstation', {
    root,
    runtimeRoot: join(root, '.runtime'),
    maxApplications: 1,
    requestClose: async () => ({ requestedWindowIds: [42], dispatch: 'completed', verified: false }),
    environment: {
      DISPLAY: ':9',
      QUBICL_INTERNAL_KEY: 'must-not-reach-child',
      QUBICL_GATEWAY_CREDENTIAL: 'must-not-reach-child',
      PATH: '/credential-bearing/path',
    },
    definitions: {
      writer: {
        executable: process.execPath,
        fixedArguments: ['-e', fakeApplication, environmentPath],
        allowedPathKind: 'file',
        allowedExtensions: ['.txt'],
      },
    },
  });
  const manifest = buildComputerManifest('workstation', 'test', 'revision');
  const executor = new ToolExecutor(
    { manifest, sha256: manifestSha256(manifest) },
    {
      desktopApplications,
      processes: new ProcessManager({ outputDirectory: join(root, 'command-output') }),
    },
  );
  context.after(() => executor.shutdown());

  await assert.rejects(desktopApplications.open('writer', ['file:///etc/passwd']), /URLs or URI schemes/);
  await assert.rejects(desktopApplications.open('writer', [outsideDocument]), /must stay under/);
  await assert.rejects(desktopApplications.open('writer', [join(root, 'escaped.txt')]), /must resolve under/);
  await assert.rejects(desktopApplications.open('writer', [disallowedDocument]), /allowlisted/);

  const lease = await executor.call('acquire_lease', { durationSeconds: 60 }) as Lease;
  const opening = executor.call('open_desktop_application', {
    lease,
    application: 'writer',
    paths: [document],
  }) as Promise<OpenedApplication>;
  await assert.rejects(executor.call('open_desktop_application', {
    lease,
    application: 'writer',
    paths: [document],
  }), /tracked applications/);
  const opened = await opening;
  assert.equal(opened.application, 'writer');
  assert.equal(opened.lifecycle, 'desktop_session');
  assert.equal(opened.survivesHumanTakeover, true);
  await waitForFile(environmentPath);
  const child = JSON.parse(await readFile(environmentPath, 'utf8')) as {
    env: Record<string, string>;
    pid: number;
    paths: string[];
  };
  assert.equal(child.env.DISPLAY, ':9');
  assert.equal(child.env.HOME, root);
  assert.equal(child.env.PATH, `${join(root, '.local/bin')}:${join(root, '.local/share/qubicl/python/current/bin')}:/opt/qubicl/skills-venv/bin:/usr/local/bin:/usr/bin:/bin`);
  assert.equal(child.env.QUBICL_INTERNAL_KEY, undefined);
  assert.equal(child.env.QUBICL_GATEWAY_CREDENTIAL, undefined);
  assert.deepEqual(child.paths, [await realpath(document)]);
  assert.equal(isAlive(child.pid), true);

  for (const extra of [
    { executable: '/bin/sh' },
    { command: 'touch /tmp/escaped' },
    { args: ['--unsafe'] },
    { env: { QUBICL_INTERNAL_KEY: 'escaped' } },
    { cwd: '/' },
    { url: 'file:///etc/passwd' },
  ]) {
    await assert.rejects(executor.call('open_desktop_application', {
      lease,
      application: 'writer',
      paths: [document],
      ...extra,
    }), /Unrecognized key/);
  }
  await assert.rejects(executor.call('open_desktop_application', {
    lease,
    application: 'unknown',
    paths: [document],
  }), /not found|tracked applications/);
  await assert.rejects(desktopApplications.open('writer', [document]), /tracked applications/);

  const generic = await executor.call('exec_command', {
    lease,
    command: 'sleep 300',
    label: 'retained build',
    cwd: root,
    yieldTimeMs: 25,
  }) as { processId: string; running: boolean; lifecycle: string; survivesHumanTakeover: boolean };
  assert.equal(generic.running, true);
  assert.equal(generic.lifecycle, 'task');
  assert.equal(generic.survivesHumanTakeover, true);
  const takeover = await executor.takeHumanControl() as {
    controller: string;
    terminatedManagedProcesses: number;
    preservedDesktopApplications: number;
  };
  assert.equal(takeover.controller, 'human');
  assert.equal(takeover.terminatedManagedProcesses, 0);
  assert.equal(takeover.preservedDesktopApplications, 1);
  assert.equal(isAlive(child.pid), true);
  const observed = await executor.call('list_desktop_applications', { lease }) as {
    applications: unknown[];
    availableApplications: Array<{ application: string; label: string; source: string }>;
  };
  assert.equal(observed.applications.length, 1);
  assert.deepEqual(observed.availableApplications.find(({ application }) => application === 'desktop:user-gui.desktop'), {
    application: 'desktop:user-gui.desktop', label: 'User GUI', source: 'user', desktopEntryId: 'user-gui.desktop', executable: await realpath(userGui),
  });
  assert.equal(observed.availableApplications.some(({ label }) => label === 'Hidden GUI'), false);
  const backgroundLease = executor.leases.acquire(60);
  await assert.rejects(executor.call('open_desktop_application', { lease: backgroundLease, application: 'writer', paths: [] }), /human.*interactive/i);
  await executor.leases.release(backgroundLease);

  executor.releaseHumanControl();
  assert.throws(() => executor.leases.verify(lease), /stale/);
  const freshLease = await executor.call('acquire_lease', { durationSeconds: 60 }) as Lease;
  const retained = await executor.call('list_managed_processes', { lease: freshLease }) as {
    processes: Array<{ id: string; label: string; lifecycle: string; status: string }>;
  };
  assert.deepEqual(retained.processes.map(({ id, label, lifecycle, status }) => ({ id, label, lifecycle, status })), [{
    id: generic.processId,
    label: 'retained build',
    lifecycle: 'task',
    status: 'running',
  }]);
  await executor.call('stop_process', { lease: freshLease, processId: generic.processId });
  const listed = await executor.call('list_desktop_applications', { lease: freshLease }) as {
    applications: Array<{ applicationId: string; application: string; state: string }>;
  };
  assert.deepEqual(listed.applications.map(({ applicationId, application, state }) => ({ applicationId, application, state })), [{
    applicationId: opened.applicationId,
    application: 'writer',
    state: 'running',
  }]);
  await assert.rejects(executor.call('close_desktop_application', {
    lease: freshLease,
    applicationId: 'x'.repeat(16),
  }), /not found/);
  const requested = await executor.call('close_desktop_application', { lease: freshLease, applicationId: opened.applicationId }) as { state: string };
  assert.equal(requested.state, 'close_requested');
  assert.equal(isAlive(child.pid), true, 'normal close must not terminate the process');
  await assert.rejects(executor.call('close_desktop_application', { lease: freshLease, applicationId: opened.applicationId, mode: 'terminate' }), /unsaved changes/);
  const closed = await executor.call('close_desktop_application', {
    lease: freshLease,
    applicationId: opened.applicationId,
    discardUnsavedChanges: true,
  }) as { state: string };
  assert.equal(closed.state, 'closed');
  await waitFor(() => !isAlive(child.pid));
  await executor.call('release_lease', { lease: freshLease });
});

interface Lease {
  id: string;
  generation: number;
  epoch: string;
  expiresAt: string;
}

interface OpenedApplication {
  applicationId: string;
  application: string;
  lifecycle: string;
  survivesHumanTakeover: boolean;
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(async () => readFile(path).then(() => true, () => false));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition did not become true before timeout.');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


test('installed desktop applications may resolve outside bin directories and launch by absolute path', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-app-location-'));
  const appDirectory = join(root, 'Applications', 'An App');
  const app = join(appDirectory, 'launch');
  await mkdir(appDirectory, { recursive: true });
  await mkdir(join(root, '.local/bin'), { recursive: true });
  await mkdir(join(root, '.local/share/applications'), { recursive: true });
  await writeFile(app, '#!/bin/sh\ntouch "$HOME/launched"\nsleep 10\n', { mode: 0o755 });
  await symlink(app, join(root, '.local/bin/linked-app'));
  await writeFile(join(root, '.local/share/applications/app.desktop'), `[Desktop Entry]\nName=An App\nType=Application\nExec="${app}" %F\n`);
  const manager = new DesktopApplicationManager('computer', { root });
  context.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const linked = await manager.open('linked-app', []);
  await waitForFile(join(root, 'launched'));
  assert.equal(linked.executable, app);
  const absolute = await manager.open(app, []);
  assert.equal(absolute.executable, app);
  assert.equal((await manager.available()).some(({ application, executable }) => application === 'desktop:app.desktop' && executable === app), true);
});
