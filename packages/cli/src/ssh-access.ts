import { chmod, lstat, mkdir, open, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { SshAccessSchema, assertValidName, managedSshForCompatibility, type ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { numberOption } from './args.js';
import { ensureRuntimeImages, managedComputerRuntimeObservation, managedGatewayRuntimeObservation, portAvailable, validateDocker } from './docker.js';
import { requirePreservedRuntimeState } from './lifecycle-update.js';
import { durableRename, loadState, statePaths, syncDirectory, withStateLock, type LoadedState } from './state.js';
import { createStateTransaction, executeStateTransaction, inspectPendingTransaction, type TransactionPlan } from './transactions.js';

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

interface SshKeyPaths { privateKey: string; publicKey: string; knownHosts: string }

function keyMaterial(publicKey: string): string { return publicKey.trim().split(/\s+/u).slice(0, 2).join(' '); }

function generationDirectory(state: LoadedState, computer: ComputerConfig, publicKey: string): string {
  const generation = createHash('sha256').update(keyMaterial(publicKey)).digest('hex');
  return join(state.paths.computers, computer.id, 'ssh', 'keys', generation);
}

async function keyPaths(state: LoadedState, computer: ComputerConfig, verifyConfiguredKey: boolean): Promise<SshKeyPaths> {
  const directory = join(state.paths.computers, computer.id, 'ssh');
  let selected = directory; // Existing releases stored a fixed pair here.
  if (computer.ssh) {
    const generation = generationDirectory(state, computer, computer.ssh.publicKey);
    try {
      if (!(await lstat(generation)).isDirectory()) throw new Error('Managed SSH key generation is not a directory.');
      selected = generation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (verifyConfiguredKey) {
      const publicKey = await readFile(join(selected, 'id_ed25519.pub'), 'utf8');
      if (keyMaterial(publicKey) !== keyMaterial(computer.ssh.publicKey)) {
        throw new Error('Managed SSH key files do not match the configured public key; refusing to select a different generation.');
      }
    }
  }
  return { privateKey: join(selected, 'id_ed25519'), publicKey: join(selected, 'id_ed25519.pub'), knownHosts: join(directory, 'known_hosts') };
}

export async function sshKeyPaths(state: LoadedState, computer: ComputerConfig): Promise<SshKeyPaths> {
  return keyPaths(state, computer, true);
}

/** OpenSSH parses -o values using its config grammar, even without a shell. */
export function quoteSshPath(path: string): string {
  if (/[\r\n\0]/u.test(path)) throw new Error('SSH paths cannot contain newlines or NUL.');
  return `"${path.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/%/gu, '%%')}"`;
}

export async function sshConfig(state: LoadedState, computer: ComputerConfig): Promise<string> {
  if (!computer.ssh?.enabled) throw new Error(`SSH access is not enabled for ${computer.name}.`);
  const paths = await sshKeyPaths(state, computer);
  try { await refreshKnownHost(state, computer); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return `Host qubicl-${computer.name}\n  HostName 127.0.0.1\n  Port ${computer.ssh.port}\n  User qubicl\n  IdentityFile ${quoteSshPath(paths.privateKey)}\n  IdentitiesOnly yes\n  HostKeyAlias ${hostKeyAlias(computer)}\n  UserKnownHostsFile ${quoteSshPath(paths.knownHosts)}\n  StrictHostKeyChecking yes`;
}

function hostPublicKeyPath(state: LoadedState, computer: ComputerConfig): string {
  return join(state.paths.computers, computer.id, 'home', 'qubicl', '.local', 'share', 'qubicl', 'ssh-host-keys', 'ssh_host_ed25519_key.pub');
}

function hostKeyAlias(computer: ComputerConfig): string { return `qubicl-${computer.id}`; }

async function refreshKnownHost(state: LoadedState, computer: ComputerConfig): Promise<void> {
  const publicKey = (await readFile(hostPublicKeyPath(state, computer), 'utf8')).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?:\s.*)?$/u.test(publicKey)) throw new Error('Computer SSH server returned an invalid Ed25519 host key.');
  const material = publicKey.split(/\s+/u).slice(0, 2).join(' ');
  const paths = await sshKeyPaths(state, computer);
  await writeFile(paths.knownHosts, `${hostKeyAlias(computer)} ${material}\n`, { mode: 0o600 });
  await chmod(paths.knownHosts, 0o600);
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

interface KeyPublicationAdapter {
  run(command: string, args: string[]): Promise<string>;
  publish(source: string, destination: string): Promise<void>;
}

/** Publish both files with one directory rename; never overwrite an active pair. */
export async function generateSshKey(
  state: LoadedState,
  computer: ComputerConfig,
  adapter: KeyPublicationAdapter = { run, publish: durableRename },
): Promise<{ publicKey: string; fingerprint: string }> {
  const directory = join(state.paths.computers, computer.id, 'ssh');
  const staged = join(directory, `.stage-${randomUUID()}`);
  await mkdir(join(directory, 'keys'), { recursive: true, mode: 0o700 });
  await mkdir(staged, { mode: 0o700 });
  try {
    const next = join(staged, 'id_ed25519');
    await adapter.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `qubicl:${computer.name}`, '-f', next]);
    const publicKey = (await readFile(`${next}.pub`, 'utf8')).trim();
    const fingerprint = (await adapter.run('ssh-keygen', ['-lf', `${next}.pub`])).split(/\s+/u)[1]!;
    for (const path of [next, `${next}.pub`]) {
      await chmod(path, 0o600);
      const file = await open(path, 'r');
      try { await file.sync(); } finally { await file.close(); }
    }
    await syncDirectory(staged);
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
    await adapter.publish(staged, generationDirectory(state, computer, publicKey));
    return { publicKey, fingerprint };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
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

async function waitForSshReady(state: LoadedState, computer: ComputerConfig): Promise<void> {
  if (!computer.ssh?.enabled) return;
  const paths = await sshKeyPaths(state, computer);
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await refreshKnownHost(state, computer);
      await run('ssh', [
        '-i', paths.privateKey,
        '-p', `${computer.ssh.port}`,
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=2',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${quoteSshPath(paths.knownHosts)}`,
        '-o', `HostKeyAlias=${hostKeyAlias(computer)}`,
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

async function printConfig(state: LoadedState, computer: ComputerConfig): Promise<void> {
  console.log(await sshConfig(state, computer));
  console.log(`\nAfter adding this Host block to your SSH config, connect with: ssh qubicl-${computer.name}`);
  try { await readFile((await sshKeyPaths(state, computer)).knownHosts); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    console.log(`Start the computer with qubicl start ${computer.name}, then run qubicl ssh config ${computer.name} to pin its host key before connecting.`);
  }
  console.log('This loopback-only SSH endpoint works with VS Code/Cursor Remote SSH, JetBrains Gateway, Zed, ssh, and scp.');
}

export interface SshChangeAdapter {
  validate(): Promise<void>;
  observeComputer: typeof managedComputerRuntimeObservation;
  observeGateway: typeof managedGatewayRuntimeObservation;
  ensureImages: typeof ensureRuntimeImages;
  generate: typeof generateSshKey;
  execute: typeof executeStateTransaction;
  waitReady(state: LoadedState, computer: ComputerConfig): Promise<void>;
  choosePort(requested?: number): Promise<number>;
}

const defaultSshChangeAdapter: SshChangeAdapter = {
  validate: async () => { await validateDocker(); }, observeComputer: managedComputerRuntimeObservation,
  observeGateway: managedGatewayRuntimeObservation, ensureImages: ensureRuntimeImages,
  generate: generateSshKey, execute: executeStateTransaction, waitReady: waitForSshReady,
  choosePort: nextPort,
};

async function removeKeyPair(paths: SshKeyPaths, generation: boolean): Promise<void> {
  // Delete only files managed by this operation; never recursively prune a
  // generation directory that may contain additional user files.
  await rm(paths.privateKey, { force: true });
  await rm(paths.publicKey, { force: true });
  if (generation) {
    await rmdir(dirname(paths.privateKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    });
  }
}

export async function changeSshAccess(
  state: LoadedState,
  computer: ComputerConfig,
  action: 'enable' | 'rotate' | 'disable',
  requestedPort?: number,
  adapter: SshChangeAdapter = defaultSshChangeAdapter,
): Promise<void> {
  if (await inspectPendingTransaction(state.paths)) throw new Error('A Qubicl transaction is pending recovery; recover it before changing SSH access.');
  if (action === 'enable') {
    if (!managedSshForCompatibility(computer.compatibility)) throw new Error('SSH access requires a computer- or workstation-compatible computer.');
    if (computer.ssh?.enabled) throw new Error(`SSH access is already enabled for ${computer.name}.`);
  } else if (!computer.ssh?.enabled) throw new Error(`SSH access is not enabled for ${computer.name}.`);
  await adapter.validate();
  const [observed, gateway] = await Promise.all([adapter.observeComputer(state, computer), adapter.observeGateway(state)]);
  const prior = requirePreservedRuntimeState(observed, `Computer ${computer.name}`);
  const gatewayPrior = requirePreservedRuntimeState(gateway, 'Gateway');
  // A running replacement requires its existing gateway. Do not wake or create
  // an unrelated gateway merely because SSH settings were changed.
  if (prior === 'running' && gatewayPrior !== 'running') {
    throw new Error('Changing SSH on a running computer requires its managed gateway to be running; no keys or state were changed.');
  }
  const previous = computer.ssh ? await keyPaths(state, computer, false) : undefined;
  const previousGeneration = Boolean(previous && dirname(previous.privateKey) !== join(state.paths.computers, computer.id, 'ssh'));
  const port = action === 'enable' ? await adapter.choosePort(requestedPort) : computer.ssh!.port;
  if (prior !== 'absent') await adapter.ensureImages(state, [computer], true);
  if (action === 'disable') delete computer.ssh;
  else {
    const key = await adapter.generate(state, computer);
    computer.ssh = SshAccessSchema.parse({ enabled: true, port, ...key });
  }
  const plan: TransactionPlan = { runtime: {
    replaceIds: prior === 'running' ? [computer.id] : [],
    replaceStoppedIds: prior === 'stopped' ? [computer.id] : [],
    ...(prior === 'absent' ? {} : { computerRuntimeBindings: { [computer.id]: observed.containers } }),
    startGateway: prior === 'running',
    gatewayRuntimeBinding: prior === 'running' ? gateway.containers : [],
  } };
  // On failure, retain BOTH generations. A durable journal may still commit
  // the new public key, while the old runtime may still require the old key.
  await adapter.execute(state.paths, createStateTransaction('config', state, plan));
  if (prior === 'running' && computer.ssh?.enabled) await adapter.waitReady(state, computer);
  if (previous) await removeKeyPair(previous, previousGeneration);
  if (action === 'disable') {
    await rm(join(state.paths.computers, computer.id, 'ssh', 'known_hosts'), { force: true });
  }
}

export async function sshCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'ssh action (enable, disable, rotate, config, or status)');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    if (action === 'config') { await printConfig(state, computer); return; }
    if (action === 'status') {
      console.log(computer.ssh?.enabled ? `enabled on 127.0.0.1:${computer.ssh.port}; ${computer.ssh.fingerprint}` : 'disabled');
      return;
    }
    if (action !== 'enable' && action !== 'rotate' && action !== 'disable') throw new Error('SSH action must be enable, disable, rotate, config, or status.');
    await changeSshAccess(state, computer, action, numberOption(args, 'port'));
    if (action === 'disable') console.log(`Disabled SSH access for ${computer.name} and removed its independent SSH key pair.`);
    else await printConfig(state, computer);
  });
}
