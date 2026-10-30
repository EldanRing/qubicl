import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
