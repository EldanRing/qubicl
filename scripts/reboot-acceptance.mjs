import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { arch, homedir, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { computerContainerName, computerExecutorContainerName, computerRuntimeContainerNames, gatewayContainerName, usesUnifiedComputerRuntime } from '../packages/cli/dist/runtime.js';

const execFile = promisify(execFileCallback);
const action = process.argv[2];
const root = resolve(process.env.QUBICL_REBOOT_HOME ?? join(homedir(), '.qubicl-reboot-acceptance'));
const checkpointPath = join(root, 'reboot-acceptance.json');
const sourceCli = fileURLToPath(new URL('../packages/cli/dist/qubicl.mjs', import.meta.url));
const cliProgram = process.env.QUBICL_REBOOT_CLI ?? process.execPath;
const cliPrefix = process.env.QUBICL_REBOOT_CLI ? [] : [sourceCli];
const dockerProgram = process.env.QUBICL_REBOOT_DOCKER ?? 'docker';
const computerImage = process.env.QUBICL_REBOOT_COMPUTER_IMAGE;
const commandEnv = {
  ...process.env,
  QUBICL_HOME: root,
};

assert(root !== '/' && root !== homedir(), `Unsafe reboot acceptance root: ${root}`);

async function run(program, args, options = {}) {
  return execFile(program, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function runCli(args) {
  return run(cliProgram, [...cliPrefix, ...args], { env: commandEnv });
}

function runDocker(args) {
  return run(dockerProgram, args, { env: commandEnv });
}

export function resolveRebootRuntimeNames(config, computer, stateRoot = root) {
  const state = { paths: { root: stateRoot }, config };
  const control = computerContainerName(state, computer);
  return {
    gateway: gatewayContainerName(config.installationId, stateRoot),
    control,
    executor: usesUnifiedComputerRuntime(computer) ? control : computerExecutorContainerName(state, computer),
    all: computerRuntimeContainerNames(state, computer),
  };
}

async function exists(path) {
  return stat(path).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function bootIdentity() {
  if (platform() === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (platform() === 'darwin') {
    const value = (await run('sysctl', ['-n', 'kern.boottime'])).stdout.trim();
    const seconds = /sec = (\d+)/.exec(value)?.[1];
    assert(seconds, `Could not parse macOS boot identity: ${value}`);
    return `darwin-${seconds}`;
  }
  throw new Error(`Unsupported reboot acceptance host: ${platform()}`);
}

async function loadState() {
  const config = YAML.parse(await readFile(join(root, 'config.yaml'), 'utf8'));
  const secrets = YAML.parse(await readFile(join(root, 'secrets.yaml'), 'utf8'));
  return { config, secrets };
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`${description} did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function rawCall(base, token, name, body) {
  const response = await fetch(`${base}/v1/tools/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  return { response, value };
}

async function call(base, token, name, body) {
  const result = await rawCall(base, token, name, body);
  assert.equal(result.response.ok, true, `${name}: ${JSON.stringify(result.value)}`);
  return result.value;
}

async function inspect(name, format) {
  return (await runDocker(['inspect', '--format', format, name])).stdout.trim();
}

async function assertNoExistingRuntime() {
  const names = (await runDocker([
    'ps', '-a', '--filter', 'label=dev.qubicl.role', '--format', '{{.Names}}',
  ])).stdout.trim();
  assert.equal(names, '', `Reboot acceptance requires no existing Qubicl containers; found: ${names}`);
}

async function prepare() {
  assert.equal(await exists(root), false, `Reboot acceptance state already exists at ${root}.`);
  await runDocker(['info']);
  await assertNoExistingRuntime();

  const port = await freePort();
  const version = (await runCli(['version'])).stdout.trim();
  await runCli(['setup', ...(computerImage ? ['--image', computerImage] : ['--preset', 'workstation']), '--gateway-port', `${port}`, '--create', 'reboot-running', '--yes']);
  await runCli(['create', 'reboot-stopped', '--no-start']);

  const { config, secrets } = await loadState();
  const running = config.computers.find(({ name }) => name === 'reboot-running');
  const stopped = config.computers.find(({ name }) => name === 'reboot-stopped');
  assert(running && stopped);
  const token = secrets.computers[running.id]?.token;
  assert.equal(typeof token, 'string');
  const base = `http://127.0.0.1:${config.gateway.port}/computers/${running.id}`;
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 60_000, 'running computer');

  const lease = await call(base, token, 'acquire_lease', { durationSeconds: 600 });
  await call(base, token, 'exec_command', {
    lease,
    command: "printf 'qubicl-reboot-home-v1' > /home/qubicl/reboot-marker",
    yieldTimeMs: 10_000,
  });
  const process = await call(base, token, 'exec_command', { lease, command: 'sleep 600', yieldTimeMs: 25 });
  assert.equal(process.running, true);

  const runningNames = resolveRebootRuntimeNames(config, running);
  const stoppedNames = resolveRebootRuntimeNames(config, stopped);
  for (const name of [runningNames.gateway, ...runningNames.all]) {
    assert.equal(await inspect(name, '{{.HostConfig.RestartPolicy.Name}}'), 'unless-stopped');
  }
  assert.equal(await inspect(runningNames.control, '{{.State.Status}}'), 'running');
  assert.equal(await containerExists(stoppedNames.control), false, 'A --no-start computer must remain absent.');
  await runDocker(['exec', '--user', 'root', runningNames.executor, 'sh', '-c', "printf 'qubicl-reboot-root-v1' > /root/reboot-marker"]);
  assert.equal((await runDocker(['exec', '--user', 'root', runningNames.executor, 'cat', '/root/reboot-marker'])).stdout, 'qubicl-reboot-root-v1');

  const candidate = await candidateIdentity();
  const docker = await dockerIdentity();

  const checkpoint = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    bootIdentity: await bootIdentity(),
    version,
    port: config.gateway.port,
    environment: { os: platform(), osRelease: release(), architecture: arch(), ...docker },
    candidate,
    cliSha256: await sha256(process.env.QUBICL_REBOOT_CLI ? resolve(process.env.QUBICL_REBOOT_CLI) : sourceCli),
    running: { id: running.id, name: running.name, runtimeNames: runningNames, containerId: await inspect(runningNames.control, '{{.Id}}') },
    stopped: { id: stopped.id, name: stopped.name, runtimeNames: stoppedNames, containerId: null },
    gatewayContainerId: await inspect(runningNames.gateway, '{{.Id}}'),
    token,
    lease,
    processId: process.processId,
  };
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  await chmod(checkpointPath, 0o600);

  console.log(JSON.stringify({
    prepared: true,
    root,
    version,
    port: checkpoint.port,
    runningId: checkpoint.running.id,
    stoppedId: checkpoint.stopped.id,
    bootIdentity: checkpoint.bootIdentity,
  }, null, 2));
}

async function verify() {
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.equal(checkpoint.schemaVersion, 1);
  const currentBoot = await bootIdentity();
  assert.notEqual(currentBoot, checkpoint.bootIdentity, 'The host has not rebooted since prepare.');
  await runDocker(['info']);

  const { config, secrets } = await loadState();
  const running = config.computers.find(({ id }) => id === checkpoint.running.id);
  const stopped = config.computers.find(({ id }) => id === checkpoint.stopped.id);
  assert.equal(running?.name, checkpoint.running.name);
  assert.equal(stopped?.name, checkpoint.stopped.name);
  assert.equal(secrets.computers[running.id]?.token, checkpoint.token);

  const runningNames = resolveRebootRuntimeNames(config, running);
  const stoppedNames = resolveRebootRuntimeNames(config, stopped);
  const base = `http://127.0.0.1:${config.gateway.port}/computers/${running.id}`;
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 90_000, 'restarted computer');
  assert.equal(await inspect(runningNames.control, '{{.State.Status}}'), 'running');
  assert.equal(await containerExists(stoppedNames.control), false);
  assert.equal(await inspect(runningNames.control, '{{.Id}}'), checkpoint.running.containerId);
  assert.equal(await inspect(runningNames.gateway, '{{.Id}}'), checkpoint.gatewayContainerId);
  assert.equal((await runDocker(['exec', '--user', 'root', runningNames.executor, 'cat', '/root/reboot-marker'])).stdout, 'qubicl-reboot-root-v1');

  const stale = await rawCall(base, checkpoint.token, 'renew_lease', {
    lease: checkpoint.lease,
    durationSeconds: 60,
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.value.error?.code, 'stale_lease');

  const lease = await call(base, checkpoint.token, 'acquire_lease', { durationSeconds: 120 });
  assert.notEqual(lease.epoch, checkpoint.lease.epoch);
  const persistence = await call(base, checkpoint.token, 'exec_command', {
    lease,
    command: "printf 'home='; cat /home/qubicl/reboot-marker; if pgrep -x sleep >/dev/null; then printf ' sleep=present'; else printf ' sleep=absent'; fi",
    yieldTimeMs: 10_000,
  });
  assert.equal(persistence.exitCode, 0);
  assert.equal(persistence.stdout, 'home=qubicl-reboot-home-v1 sleep=absent');
  await call(base, checkpoint.token, 'release_lease', { lease });

  const diagnosis = JSON.parse((await runCli(['doctor', '--json'])).stdout);
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.checks.filter(({ ok }) => !ok)));

  await runDocker(['rm', '--force', ...runningNames.all]);
  await runCli(['start', running.name]);
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 90_000, 'recreated computer');
  const recreatedLease = await call(base, checkpoint.token, 'acquire_lease', { durationSeconds: 120 });
  const recreated = await call(base, checkpoint.token, 'exec_command', {
    lease: recreatedLease,
    command: "printf 'home='; cat /home/qubicl/reboot-marker",
    yieldTimeMs: 10_000,
  });
  assert.equal(recreated.exitCode, 0);
  assert.equal(recreated.stdout, 'home=qubicl-reboot-home-v1');
  const rootMarker = await runDocker(['exec', '--user', 'root', runningNames.executor, 'test', '-e', '/root/reboot-marker']).then(() => true, () => false);
  assert.equal(rootMarker, false, 'Disposable executor root marker survived recreation.');
  await call(base, checkpoint.token, 'release_lease', { lease: recreatedLease });
  const recreatedContainerId = await inspect(runningNames.control, '{{.Id}}');
  assert.notEqual(recreatedContainerId, checkpoint.running.containerId);

  const report = {
    verified: true,
    verifiedAt: new Date().toISOString(),
    version: checkpoint.version,
    hostPlatform: platform(),
    bootBefore: checkpoint.bootIdentity,
    bootAfter: currentBoot,
    runningComputerRestored: true,
    stoppedComputerStayedStopped: true,
    staleLeaseRejected: true,
    priorManagedProcessAbsent: true,
    homeSurvivedReboot: true,
    rootAfterReboot: 'present',
    homeSurvivedRecreation: true,
    rootDiscardedOnRecreation: true,
    doctorOk: true,
  };
  const reportPath = resolve(process.env.QUBICL_REBOOT_REPORT ?? join(root, 'reboot-acceptance-report.json'));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(reportPath, 0o600);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
}

async function containerExists(name) {
  return runDocker(['inspect', name]).then(() => true, () => false);
}

async function dockerIdentity() {
  return {
    dockerEngine: (await runDocker(['version', '--format', '{{.Server.Version}}'])).stdout.trim(),
    dockerCompose: (await runDocker(['compose', 'version', '--short'])).stdout.trim(),
  };
}

async function candidateIdentity() {
  const directory = process.env.QUBICL_REBOOT_CANDIDATE;
  if (!directory) return null;
  const candidatePath = join(resolve(directory), 'candidate.json');
  const checksumsPath = join(resolve(directory), 'SHA256SUMS');
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
  return {
    version: candidate.version,
    revision: candidate.revision,
    catalogSha256: candidate.imageCatalog?.sha256,
    candidateJsonSha256: await sha256(candidatePath),
    checksumsSha256: await sha256(checksumsPath),
  };
}

async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }

async function cleanup() {
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.equal(checkpoint.schemaVersion, 1, 'Refusing cleanup without a valid reboot acceptance checkpoint.');
  const composePath = join(root, 'runtime', 'compose.yaml');
  if (await exists(composePath)) await runDocker(['compose', '-f', composePath, 'down', '--remove-orphans']);
  await rm(root, { recursive: true, force: false });
  await assertNoExistingRuntime();
  console.log(JSON.stringify({ cleaned: true, root }, null, 2));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (!['prepare', 'verify', 'cleanup'].includes(action)) throw new Error('Usage: reboot-acceptance.mjs prepare|verify|cleanup');
  if (action === 'prepare') await prepare();
  if (action === 'verify') await verify();
  if (action === 'cleanup') await cleanup();
}
