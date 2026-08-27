import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { ComputerConfigSchema, assertValidName, type ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, numberOption, stringOption } from './args.js';
import { addConfiguredComputer } from './computers.js';
import { containerStatus, docker, ensureRuntimeImages, validateDocker } from './docker.js';
import { computerRuntimeContainerNames } from './runtime.js';
import { createStateTransaction, defaultTransactionRuntime, prepareStateTransaction, recoverPendingTransaction, restoreReadyMarker, restoreStage } from './transactions.js';
import { atomicWrite, durableRemove, durableRemoveDirectory, loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { synchronizeStartedSkillPolicies } from './policy-commands.js';

interface BackupManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  source: ComputerConfig;
  archive: string;
  sha256: string;
  encrypted: boolean;
  consistency: 'live' | 'quiesced' | 'stopped';
}

const MAGIC = Buffer.from('QUBICL1\0');
const HEADER_BYTES = MAGIC.length + 16 + 12;

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}.`);
  return value;
}

function findComputer(state: LoadedState, name: string): ComputerConfig {
  const computer = state.config.computers.find((entry) => entry.name === name || entry.id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return computer;
}

function backupDirectory(state: LoadedState, id: string): string { return join(state.paths.backups, id); }

async function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${code ?? 'signal'}): ${stderr.trim()}`)));
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function passphrase(args: ParsedArgs, requiredForEncrypted: boolean): Promise<string | undefined> {
  const path = stringOption(args, 'passphrase-file');
  if (!path) {
    if (requiredForEncrypted) throw new Error('This encrypted backup requires --passphrase-file. Passphrases are never accepted on the command line.');
    return undefined;
  }
  const value = (await readFile(path, 'utf8')).replace(/[\r\n]+$/u, '');
  if (value.length < 12) throw new Error('Backup passphrase must be at least 12 characters.');
  return value;
}

export async function encryptBackupFile(source: string, destination: string, password: string): Promise<void> {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32, { maxmem: 64 * 1024 * 1024 }), iv);
  await writeFile(destination, Buffer.concat([MAGIC, salt, iv]), { mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: 'a', mode: 0o600 }));
  await appendFile(destination, cipher.getAuthTag());
  await chmod(destination, 0o600);
}

export async function decryptBackupFile(source: string, destination: string, password: string): Promise<void> {
  const info = await stat(source);
  if (info.size < HEADER_BYTES + 16) throw new Error('Encrypted backup is truncated.');
  const header = Buffer.alloc(HEADER_BYTES);
  const handle = await import('node:fs/promises').then(({ open }) => open(source, 'r'));
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Encrypted backup header is invalid.');
  const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = header.subarray(MAGIC.length + 16, HEADER_BYTES);
  const tag = Buffer.alloc(16);
  const tagHandle = await import('node:fs/promises').then(({ open }) => open(source, 'r'));
  try { await tagHandle.read(tag, 0, 16, info.size - 16); } finally { await tagHandle.close(); }
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32, { maxmem: 64 * 1024 * 1024 }), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(source, { start: HEADER_BYTES, end: info.size - 17 }), decipher, createWriteStream(destination, { mode: 0o600 }));
  } catch {
    throw new Error('Backup decryption failed; the passphrase is wrong or the archive was modified.');
  }
}

async function readManifest(state: LoadedState, id: string): Promise<{ directory: string; manifest: BackupManifest }> {
  if (!/^[a-zA-Z0-9._-]+$/u.test(id)) throw new Error('Invalid backup ID.');
  const directory = backupDirectory(state, id);
  const parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
  if (parsed.version !== 1 || parsed.id !== id || !parsed.archive || !/^[a-f0-9]{64}$/u.test(parsed.sha256)) throw new Error(`Backup ${id} has an invalid manifest.`);
  parsed.source = ComputerConfigSchema.parse(parsed.source);
  return { directory, manifest: parsed };
}

async function verifyBackup(state: LoadedState, id: string): Promise<{ directory: string; manifest: BackupManifest; archive: string }> {
  const { directory, manifest } = await readManifest(state, id);
  const archive = join(directory, basename(manifest.archive));
  const actual = await sha256(archive);
  if (actual !== manifest.sha256) throw new Error(`Backup ${id} checksum mismatch: expected ${manifest.sha256}, got ${actual}.`);
  return { directory, manifest, archive };
}

async function createBackup(state: LoadedState, computer: ComputerConfig, args: ParsedArgs, checkpoint = false): Promise<BackupManifest> {
  if (flag(args, 'quiesce') && flag(args, 'stopped')) throw new Error('--quiesce and --stopped are mutually exclusive.');
  const runtime = await containerStatus(state, computer.id);
  if (flag(args, 'stopped') && !['absent', 'exited', 'created'].includes(runtime.status)) throw new Error('--stopped requires the computer to already be stopped.');
  const consistency: BackupManifest['consistency'] = checkpoint || flag(args, 'quiesce') ? 'quiesced' : flag(args, 'stopped') ? 'stopped' : 'live';
  const containers: string[] = [];
  if (runtime.status === 'running' && consistency === 'quiesced') {
    for (const name of computerRuntimeContainerNames(state, computer)) {
      if (await docker(['inspect', '--format', '{{.Id}}', name], { allowFailure: true })) containers.push(name);
    }
  }
  if (containers.length) await docker(['pause', ...containers]);
  const id = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${computer.name}-${randomUUID().slice(0, 8)}`;
  const directory = backupDirectory(state, id);
  const plain = join(directory, 'home.tar.gz');
  await mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    await run('tar', ['-czf', plain, '--numeric-owner', '-C', join(state.paths.computers, computer.id, 'home'), '.']);
    await chmod(plain, 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (containers.length) await docker(['unpause', ...containers], { allowFailure: true });
  }
  const encrypted = flag(args, 'encrypt');
  let archive = plain;
  if (encrypted) {
    const password = await passphrase(args, true);
    archive = `${plain}.enc`;
    await encryptBackupFile(plain, archive, password!);
    await rm(plain, { force: false });
  }
  const manifest: BackupManifest = {
    version: 1, id, name: computer.name, createdAt: new Date().toISOString(), source: structuredClone(computer),
    archive: basename(archive), sha256: await sha256(archive), encrypted, consistency,
  };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function restoreBackup(state: LoadedState, id: string, name: string, args: ParsedArgs, start = false): Promise<ComputerConfig> {
  assertValidName(name);
  const verified = await verifyBackup(state, id);
  const defaults = {
    preset: verified.manifest.source.preset,
    compatibility: verified.manifest.source.compatibility,
    image: verified.manifest.source.image,
    capabilityContractVersion: verified.manifest.source.capabilityContractVersion,
    capabilities: verified.manifest.source.capabilities,
    cpus: verified.manifest.source.cpus,
    memory: verified.manifest.source.memory,
  };
  const computer = addConfiguredComputer(state, name, defaults);
  if (verified.manifest.source.controlProtocolVersion === undefined) delete computer.controlProtocolVersion;
  else computer.controlProtocolVersion = verified.manifest.source.controlProtocolVersion;
  computer.network = structuredClone(verified.manifest.source.network);
  computer.environment = structuredClone(verified.manifest.source.environment);
  computer.ssh = structuredClone(verified.manifest.source.ssh);
  computer.toolPolicy = structuredClone(verified.manifest.source.toolPolicy);
  computer.skillPolicy = structuredClone(verified.manifest.source.skillPolicy);
  const staged = restoreStage(state.paths, computer.id);
  const home = join(staged, 'home');
  const transaction = createStateTransaction('backup-restore', state, {
    activeSources: { [computer.id]: 'staged' },
    runtime: { ensureImages: true, startIds: start ? [computer.id] : [] },
  });
  await prepareStateTransaction(state.paths, transaction);
  await mkdir(home, { recursive: true, mode: 0o700 });
  let archive = verified.archive;
  const temporary = join(staged, `restore-${randomUUID()}.tar.gz`);
  let stagingComplete = false;
  try {
    if (verified.manifest.encrypted) {
      await decryptBackupFile(archive, temporary, (await passphrase(args, true))!);
      archive = temporary;
    }
    const entries = await run('tar', ['-tzf', archive]);
    for (const entry of entries.split('\n').filter(Boolean)) {
      const normalized = entry.replace(/^\.\//u, '');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`Backup contains unsafe path ${JSON.stringify(entry)}.`);
    }
    await run('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', home]);
    if (archive === temporary) await rm(temporary, { force: false });
    await atomicWrite(restoreReadyMarker(state.paths, computer.id), 'ready\n', 0o600);
    stagingComplete = true;
    await recoverPendingTransaction(state.paths, {
      runtime: {
        ...defaultTransactionRuntime,
        ensureImages: (loaded) => ensureRuntimeImages(loaded, start ? [computer] : [], true),
      },
    });
  } catch (error) {
    if (!stagingComplete) {
      await durableRemoveDirectory(staged);
      await durableRemove(state.paths.journal);
    }
    throw error;
  } finally {
    if (archive === temporary) await rm(temporary, { force: true });
  }
  return computer;
}

export async function backupCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'backup action');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    if (action === 'create') {
      const computer = findComputer(state, required(args.positionals[1], 'computer name'));
      const result = await createBackup(state, computer, args);
      console.log(`Created ${result.consistency} backup ${result.id}; sha256:${result.sha256}${result.encrypted ? '; encrypted' : ''}.`);
      return;
    }
    if (action === 'list') {
      const filter = args.positionals[1];
      const rows: BackupManifest[] = [];
      for (const entry of await readdir(state.paths.backups, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try { const { manifest } = await readManifest(state, entry.name); if (!filter || manifest.name === filter) rows.push(manifest); } catch { /* doctor reports malformed entries */ }
      }
      console.log(JSON.stringify(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), null, 2));
      return;
    }
    if (action === 'verify') {
      const result = await verifyBackup(state, required(args.positionals[1], 'backup ID'));
      if (result.manifest.encrypted) {
        const temporary = join(state.paths.runtime, `verify-${randomUUID()}.tar.gz`);
        try { await decryptBackupFile(result.archive, temporary, (await passphrase(args, true))!); await run('tar', ['-tzf', temporary]); }
        finally { await rm(temporary, { force: true }); }
      } else await run('tar', ['-tzf', result.archive]);
      console.log(`Verified backup ${result.manifest.id}; sha256:${result.manifest.sha256}.`);
      return;
    }
    if (action === 'restore') {
      await validateDocker();
      const computer = await restoreBackup(state, required(args.positionals[1], 'backup ID'), required(args.positionals[2], 'new computer name'), args);
      console.log(`Restored ${computer.name} from verified backup ${args.positionals[1]}. It is stopped; run qubicl start ${computer.name}.`);
      return;
    }
    if (action === 'prune') {
      if (!flag(args, 'yes')) throw new Error('Backup pruning is destructive and requires --yes.');
      const keep = numberOption(args, 'keep');
      if (!Number.isInteger(keep) || keep! < 0) throw new Error('--keep must be a non-negative integer.');
      const filter = args.positionals[1];
      const manifests: BackupManifest[] = [];
      for (const entry of await readdir(state.paths.backups, { withFileTypes: true })) if (entry.isDirectory()) {
        try { const { manifest } = await readManifest(state, entry.name); if (!filter || manifest.name === filter) manifests.push(manifest); } catch { /* preserve malformed entries */ }
      }
      const doomed = manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(keep);
      for (const backup of doomed) await rm(backupDirectory(state, backup.id), { recursive: true, force: false });
      console.log(`Pruned ${doomed.length} verified backup${doomed.length === 1 ? '' : 's'}; malformed entries were preserved.`);
      return;
    }
    throw new Error('Backup action must be create, list, verify, restore, or prune.');
  });
}

export async function checkpointCommand(args: ParsedArgs): Promise<void> {
  args.options.set('quiesce', true);
  args.positionals = ['create', args.positionals[0]!];
  await backupCommand(args);
}

export async function cloneCommand(args: ParsedArgs): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    await validateDocker();
    const source = findComputer(state, required(args.positionals[0], 'source computer'));
    const backup = await createBackup(state, source, { positionals: [], options: new Map([['quiesce', true]]) });
    const target = await restoreBackup(state, backup.id, required(args.positionals[1], 'new computer name'), args, !flag(args, 'no-start'));
    if (!flag(args, 'no-start')) await synchronizeStartedSkillPolicies(state, [target]);
    console.log(`Cloned ${source.name} to ${target.name} through verified checkpoint ${backup.id}${flag(args, 'no-start') ? ' (stopped)' : ''}.`);
  });
}
