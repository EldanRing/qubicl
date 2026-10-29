import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { ProcessManager } from '../../packages/control/dist/processes.js';

const owner = { id: 'runtime-regression', generation: 1, epoch: 'runtime-regression' };
const helperPath = resolve('images/computer/pty-helper.py');
const thirtyDays = 30 * 24 * 60 * 60 * 1000;

test('managed PTYs retain configured variables and workload proxies without inheriting controller secrets', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-pty-env-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const proxy = 'http://fixture-user:fixture-key@proxy.test:3128';
  const manager = new ProcessManager({ home, outputDirectory: home, pty: { helperPath }, environment: {
    QUBICL_WORKLOAD_ENV_JSON: JSON.stringify({ APP_MODE: 'configured value', NODE_OPTIONS: '--bad-option', LD_PRELOAD: '/bad-library', QUBICL_INTERNAL_KEY: 'configured-control-value' }),
    QUBICL_PROXY_URL: proxy, QUBICL_INTERNAL_KEY: 'private-control-value', AWS_SECRET_ACCESS_KEY: 'inherited-host-value',
  } });
  const opened = await manager.terminalOpen('printf "%s|%s|%s|%s|%s|%s" "$APP_MODE" "$HTTPS_PROXY" "${QUBICL_INTERNAL_KEY-unset}" "${AWS_SECRET_ACCESS_KEY-unset}" "${NODE_OPTIONS-unset}" "${LD_PRELOAD-unset}"', home, 24, 80, owner, 'task', 'environment');
  context.after(() => manager.terminalClose(opened.terminalId, owner, true));
  let page = await manager.terminalRead(opened.terminalId, owner, 0, 4096, 2000, 'utf8');
  if (page.running) await manager.terminalRead(opened.terminalId, owner, page.nextOffset, 4096, 2000, 'utf8');
  page = await manager.terminalRead(opened.terminalId, owner, 0, 4096, 0, 'utf8');
  assert.equal(page.data, `configured value|${proxy}|unset|unset|unset|unset`);
});

test('one admission budget includes pending PTYs, retained tasks and restarting services', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-shared-admission-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const manager = new ProcessManager({ maxProcesses: 1, home, outputDirectory: home, persistTaskRecords: true, pty: { helperPath } });
  const pending = manager.terminalOpen('read value', home, 24, 80, owner, 'task', 'terminal');
  await assert.rejects(manager.terminalOpen('printf forbidden', home, 24, 80, owner, 'task', 'second'), { code: 'process_limit' });
  await assert.rejects(manager.exec('printf forbidden', home, 0, 100, owner), { code: 'process_limit' });
  const terminal = await pending;
  await manager.terminateOwner(owner);
  assert.equal(manager.count(), 1, 'retained terminal keeps its slot after lease termination');
  await manager.terminalClose(terminal.terminalId, owner, true);
  const task = await manager.exec('sleep 30', home, 0, 100, owner, undefined, 'combined', 'task');
  try {
    await assert.rejects(manager.terminalOpen('printf forbidden', home, 24, 80, owner, 'session', 'terminal'), { code: 'process_limit' });
  } finally { await manager.stop(task.processId, owner); }
  const service = await manager.exec('exit 1', home, 30, 1024, owner, undefined, 'combined', 'service', 'restarting', { restart: { maxAttempts: 2, backoffMs: 1000 } });
  try {
    assert.equal(service.running, true);
    await assert.rejects(manager.terminalOpen('printf forbidden', home, 24, 80, owner, 'task', 'terminal'), { code: 'process_limit' });
  } finally { await manager.stopForManagement(service.processId); }
  assert.equal(manager.count(), 0);
});

test('a configured 30-day task lifetime expires at its deadline rather than after one millisecond', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-long-lifetime-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const manager = new ProcessManager({ home, outputDirectory: home, maxLifetimeMs: thirtyDays });
  const starting = manager.exec('sleep 30', home, 1, 100, owner, undefined, 'combined', 'task');
  context.mock.timers.tick(1);
  const task = await starting;
  try {
    context.mock.timers.tick(2_147_483_647);
    assert.equal(manager.count(), 1);
    context.mock.timers.tick(thirtyDays - 2_147_483_647 - 2);
    assert.equal(manager.count(), 1);
    context.mock.timers.tick(1);
    const finished = await manager.stop(task.processId, owner);
    assert.equal(finished.running, false);
    assert.equal(finished.termination?.reason, 'lifetime');
  } finally {
    context.mock.timers.reset();
    if (manager.count()) await manager.stopForManagement(task.processId);
  }
});

test('30-day process and PTY retention survive the native timer boundary', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-long-retention-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const manager = new ProcessManager({ home, outputDirectory: home, persistTaskRecords: true, maxLifetimeMs: thirtyDays, completedTtlMs: thirtyDays, outputTtlMs: thirtyDays, pty: { helperPath } });
  const task = await manager.exec('printf retained', home, 1000, 100, owner, undefined, 'combined', 'task');
  const terminal = await manager.terminalOpen('printf terminal', home, 24, 80, owner, 'task', 'retained terminal');
  let page = await manager.terminalRead(terminal.terminalId, owner, 0, 100, 1000, 'utf8');
  if (page.running) page = await manager.terminalRead(terminal.terminalId, owner, page.nextOffset, 100, 1000, 'utf8');
  assert.equal(manager.terminalList()[0]!.running, false);
  context.mock.timers.tick(2_147_483_647);
  assert.equal(manager.readOutput(task.processId, 0, 100, undefined, 'utf8').data, 'retained');
  assert.equal((await manager.terminalRead(terminal.terminalId, owner, 0, 100, 0, 'utf8')).data, 'terminal');
  context.mock.timers.tick(thirtyDays - 2_147_483_647);
  assert.throws(() => manager.readOutput(task.processId, 0, 100, undefined, 'utf8'), { code: 'process_output_unavailable' });
  await assert.rejects(manager.terminalRead(terminal.terminalId, owner, 0, 100, 0, 'utf8'), { code: 'terminal_not_found' });
});

test('configured large retained logs support bounded pages and keep private-file checks', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-sparse-output-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const manager = new ProcessManager({ home, outputDirectory: home, persistTaskRecords: true, maxFullOutputBytes: 500_000_000 });
  const task = await manager.exec('printf initial', home, 1000, 100, owner, undefined, 'combined', 'task');
  const records = (await readFile(join(home, 'task-records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { id: string; outputPath: string });
  const path = records.find(record => record.id === task.processId)!.outputPath;
  const file = await open(path, 'r+');
  try { await file.truncate(150_000_000); await file.write(Buffer.from('tail'), 0, 4, 149_999_996); }
  finally { await file.close(); }
  const page = manager.readOutput(task.processId, 149_999_996, 4, undefined, 'utf8');
  assert.equal(page.data, 'tail'); assert.equal(page.size, 150_000_000); assert.equal(page.nextOffset, 150_000_000);
  assert.throws(() => manager.readOutput(task.processId, 0, 1_000_001, undefined, 'base64'), { code: 'invalid_arguments' });
  await chmod(path, 0o644);
  assert.throws(() => manager.readOutput(task.processId, 0, 4, undefined, 'base64'), { code: 'process_output_unavailable' });
});

test('the actual lifecycle hook receives configured workload environment without controller variables', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-hook-env-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const bundle = join(home, 'workload-environment.mjs');
  await build({ entryPoints: [resolve('packages/control/src/workload-environment.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const imported = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(bundle).href)})`]);
  assert.equal(imported.stdout, '');
  const entrypoint = await readFile('images/computer/entrypoint.sh', 'utf8');
  const start = entrypoint.indexOf('run_guest_hook() {');
  const end = entrypoint.indexOf('\nguest_marker_root=', start);
  const hook = entrypoint.slice(start, end).replace('/opt/qubicl/workload-environment.mjs', bundle);
  const script = `set -euo pipefail\nrunuser() { shift 3; "$@"; }\n${hook}\nrun_guest_hook postStartCommand ""`;
  const result = await promisify(execFile)('/bin/bash', ['-c', script], { env: {
    PATH: process.env.PATH,
    QUBICL_WORKLOAD_ENV_JSON: JSON.stringify({ APP_MODE: 'configured value', QUOTED_VALUE: 'line one\nline two "$HOME"', NODE_OPTIONS: '--bad-option' }),
    QUBICL_PROXY_URL: 'http://fixture-user:fixture-key@proxy.test:3128',
    QUBICL_INTERNAL_KEY: 'private-control-value', AWS_SECRET_ACCESS_KEY: 'inherited-host-value',
    QUBICL_DEVCONTAINER_GUEST_JSON: JSON.stringify({ workspaceFolder: home, hooks: { postStartCommand: 'printf "%s|%s|%s|%s|%s|%s" "$APP_MODE" "$HTTPS_PROXY" "${QUBICL_INTERNAL_KEY-unset}" "${AWS_SECRET_ACCESS_KEY-unset}" "${QUBICL_WORKLOAD_ENV_JSON-unset}" "$QUOTED_VALUE"' } }),
  } });
  assert.equal(result.stdout, 'configured value|http://fixture-user:fixture-key@proxy.test:3128|unset|unset|unset|line one\nline two "$HOME"');
});

test('the actual internal executor startup forwards only the four task policy settings into its sanitized subprocess', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-executor-policy-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const fixture = join(home, 'inspect-environment.mjs');
  await writeFile(fixture, `process.stdout.write(JSON.stringify({
    taskPolicy: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('QUBICL_TASK_'))),
    role: process.env.QUBICL_RUNTIME_ROLE, key: process.env.QUBICL_RUNNER_KEY,
    leaked: ['QUBICL_INTERNAL_KEY', 'QUBICL_SESSION_KEY', 'AWS_SECRET_ACCESS_KEY'].filter(key => key in process.env)
  }));`);
  const entrypoint = await readFile('images/computer/entrypoint.sh', 'utf8');
  const start = entrypoint.indexOf('start_internal_executor() {');
  const end = entrypoint.indexOf('\nstart_internal_session() {', start);
  assert(start >= 0 && end > start);
  const startup = entrypoint.slice(start, end).replace('node /opt/qubicl/control.mjs', '"$fixture_node" "$fixture_path"');
  const script = `set -euo pipefail\nfixture_node="$1"\nfixture_path="$2"\ntarget_uid=1000\ntarget_gid=1000\npids=()\n${startup}\nstart_internal_executor\nwait "\${pids[0]}"`;
  const taskPolicy = {
    QUBICL_TASK_MAX_CONCURRENT: '1',
    QUBICL_TASK_MAX_LIFETIME_SECONDS: '2592000',
    QUBICL_TASK_MAX_OUTPUT_BYTES: '500000000',
    QUBICL_TASK_COMPLETED_RETENTION_SECONDS: '2592000',
  };
  const run = async (policy: Record<string, string>) => {
    const result = await promisify(execFile)('/bin/bash', ['-c', script, 'executor-policy-fixture', process.execPath, fixture], { env: {
      PATH: process.env.PATH, QUBICL_EXECUTOR_KEY: 'fixture-executor-key',
      QUBICL_INTERNAL_KEY: 'not-for-executor', QUBICL_SESSION_KEY: 'not-for-executor', AWS_SECRET_ACCESS_KEY: 'not-for-executor',
      QUBICL_TASK_PRIVATE: 'not-a-policy-setting', ...policy,
    } });
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(await run(taskPolicy), { taskPolicy, role: 'executor', key: 'fixture-executor-key', leaked: [] });
  assert.deepEqual(await run({}), { taskPolicy: {}, role: 'executor', key: 'fixture-executor-key', leaked: [] });
});
