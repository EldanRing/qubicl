import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SshAccessSchema, assertValidName, managedSshForCompatibility, type ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { numberOption } from './args.js';
import { compose, docker, ensureRuntimeImages, portAvailable, startComputerAfterGateway, startGateway, validateDocker } from './docker.js';
import { computerSshContainerName, computerSshServiceName, renderRuntime, usesUnifiedComputerRuntime } from './runtime.js';
import { loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { createStateTransaction, executeStateTransaction } from './transactions.js';

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}.`);
  return value;
}

function findComputer(state: LoadedState, name: string): ComputerConfig {
  assertValidName(name);
  const computer = state.config.computers.find((entry) => entry.name === name);
  if (!computer) throw new Error(`No computer named ${name}.`);
  return computer;
}

function keyPaths(state: LoadedState, computer: ComputerConfig): { privateKey: string; publicKey: string } {
  const directory = join(state.paths.computers, computer.id, 'ssh');
  return { privateKey: join(directory, 'id_ed25519'), publicKey: join(directory, 'id_ed25519.pub') };
}

async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} failed (${code ?? 'signal'}): ${stderr.trim()}`)));
  });
}

async function generateKey(state: LoadedState, computer: ComputerConfig): Promise<{ publicKey: string; fingerprint: string }> {
  const paths = keyPaths(state, computer);
  const directory = join(state.paths.computers, computer.id, 'ssh');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const next = join(directory, `id_ed25519.${randomUUID()}.next`);
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `qubicl:${computer.name}`, '-f', next]);
  const publicKey = (await readFile(`${next}.pub`, 'utf8')).trim();
  const fingerprint = (await run('ssh-keygen', ['-lf', `${next}.pub`])).split(/\s+/u)[1]!;
  await rename(next, paths.privateKey);
  await rename(`${next}.pub`, paths.publicKey);
  await chmod(paths.privateKey, 0o600);
  await chmod(paths.publicKey, 0o600);
  return { publicKey, fingerprint };
}

async function nextPort(requested?: number): Promise<number> {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1024 || requested > 65_535) throw new Error('--port must be an integer from 1024 through 65535.');
    if (!await portAvailable(requested)) throw new Error(`127.0.0.1:${requested} is already in use.`);
    return requested;
  }
  for (let port = 22_220; port <= 22_999; port += 1) if (await portAvailable(port)) return port;
  throw new Error('No available loopback SSH port was found in 22220-22999; provide --port.');
}

async function refreshSsh(state: LoadedState, computer: ComputerConfig): Promise<void> {
  await renderRuntime(state);
  if (usesUnifiedComputerRuntime(computer)) {
    await startGateway(state);
    await startComputerAfterGateway(state, computer);
    if (computer.ssh?.enabled) await waitForSshReady(state, computer);
    return;
  }
  if (computer.ssh?.enabled) {
    await compose(state, ['up', '--detach', '--force-recreate', '--no-deps', computerSshServiceName(state, computer)]);
    await waitForSshReady(state, computer);
  } else {
    const name = computerSshContainerName(state, computer);
    if (await docker(['inspect', '--format', '{{.Id}}', name], { allowFailure: true })) await docker(['rm', '--force', name]);
  }
}

async function waitForSshReady(state: LoadedState, computer: ComputerConfig): Promise<void> {
  if (!computer.ssh?.enabled) return;
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await run('ssh', [
        '-i', keyPaths(state, computer).privateKey,
        '-p', `${computer.ssh.port}`,
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=2',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        'qubicl@127.0.0.1',
        'true',
      ]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  const detail = lastError instanceof Error ? ` Last probe: ${lastError.message}` : '';
  throw new Error(`SSH endpoint for ${computer.name} did not accept its managed key within 30 seconds.${detail}`);
}

function printConfig(state: LoadedState, computer: ComputerConfig): void {
  if (!computer.ssh?.enabled) throw new Error(`SSH access is not enabled for ${computer.name}.`);
  const privateKey = keyPaths(state, computer).privateKey;
  console.log(`Host qubicl-${computer.name}\n  HostName 127.0.0.1\n  Port ${computer.ssh.port}\n  User qubicl\n  IdentityFile ${privateKey}\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new`);
  console.log(`\nConnect: ssh -i ${JSON.stringify(privateKey)} -p ${computer.ssh.port} qubicl@127.0.0.1`);
  console.log('This loopback-only SSH endpoint works with VS Code/Cursor Remote SSH, JetBrains Gateway, Zed, ssh, and scp.');
}

export async function sshCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'ssh action (enable, disable, rotate, config, or status)');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    if (action === 'config') { printConfig(state, computer); return; }
    if (action === 'status') {
      console.log(computer.ssh?.enabled ? `enabled on 127.0.0.1:${computer.ssh.port}; ${computer.ssh.fingerprint}` : 'disabled');
      return;
    }
    await validateDocker();
    if (action === 'enable') {
      if (!managedSshForCompatibility(computer.compatibility)) throw new Error('SSH access requires a computer- or workstation-compatible computer.');
      if (computer.ssh?.enabled) throw new Error(`SSH access is already enabled for ${computer.name}.`);
      const port = await nextPort(numberOption(args, 'port'));
      await ensureRuntimeImages(state, [computer], true);
      const key = await generateKey(state, computer);
      computer.ssh = SshAccessSchema.parse({ enabled: true, port, ...key });
      await executeStateTransaction(state.paths, createStateTransaction('config', state), { includeRuntime: false });
      await refreshSsh(state, computer);
      printConfig(state, computer);
      return;
    }
    if (action === 'rotate') {
      if (!computer.ssh?.enabled) throw new Error(`SSH access is not enabled for ${computer.name}.`);
      await ensureRuntimeImages(state, [computer], true);
      const { publicKey, fingerprint } = await generateKey(state, computer);
      computer.ssh = SshAccessSchema.parse({ ...computer.ssh, publicKey, fingerprint });
      await executeStateTransaction(state.paths, createStateTransaction('config', state), { includeRuntime: false });
      await refreshSsh(state, computer);
      printConfig(state, computer);
      return;
    }
    if (action === 'disable') {
      if (!computer.ssh?.enabled) throw new Error(`SSH access is not enabled for ${computer.name}.`);
      delete computer.ssh;
      await executeStateTransaction(state.paths, createStateTransaction('config', state), { includeRuntime: false });
      await refreshSsh(state, computer);
      const keys = keyPaths(state, computer);
      await Promise.all([rm(keys.privateKey, { force: true }), rm(keys.publicKey, { force: true })]);
      console.log(`Disabled SSH access for ${computer.name} and removed its independent SSH key pair.`);
      return;
    }
    throw new Error('SSH action must be enable, disable, rotate, config, or status.');
  });
}
