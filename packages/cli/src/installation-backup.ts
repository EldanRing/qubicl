import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { ParsedArgs } from './args.js';
import { stringOption } from './args.js';
import { backupPassphraseFromArgs, decryptBackupFile, encryptBackupFile } from './backups.js';
import { managedComputerRuntimeObservation, managedGatewayRuntimeObservation, validateDocker } from './docker.js';
import { operationOutput } from './operation-context.js';
import { extractInspectedBackupArchive, inspectBackupArchive } from './safe-backup-archive.js';
import { loadState, prepareStateDirectories, saveState, statePaths } from './state.js';
import { readDashboardConfiguration, saveDashboardConfiguration } from './dashboard/runtime.js';

const MANIFEST_NAME = 'installation-manifest.json';
const VOLATILE_ROOT_ENTRIES = new Set(['runtime', 'transaction.yaml', 'state-migration.yaml', MANIFEST_NAME]);

interface InstallationManifest {
  schemaVersion: 1;
  createdAt: string;
  sourceVersion: string;
  sourceInstallationId: string;
  computers: Array<{ id: string; name: string }>;
  includes: string[];
  excludes: string[];
}

export async function installationCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'installation action');
  if (action === 'export') return exportInstallation(args);
  const bundle = resolve(required(args.positionals[1], 'installation bundle path'));
  if (action === 'inspect') {
    const result = await inspectInstallationBundle(bundle, args);
    operationOutput('log', JSON.stringify(importPlan(result.manifest, result.state.config, stringOption(args, 'target-root')), null, 2));
    return;
  }
  if (action === 'import') return importInstallation(bundle, args);
  throw new Error(`Unknown installation action ${action}; use export, inspect, or import.`);
}

async function exportInstallation(args: ParsedArgs): Promise<void> {
  const output = resolve(required(stringOption(args, 'output'), '--output'));
  const password = (await backupPassphraseFromArgs(args, true))!;
  const paths = statePaths();
  if (inside(paths.root, output)) throw new Error('Installation export must be written outside the state root it protects.');
  await assertAbsent(output, 'Installation export destination already exists.');
  const state = await loadState(paths);
  await validateDocker();
  const runtime = await Promise.all([
    managedGatewayRuntimeObservation(state),
    ...state.config.computers.map((computer) => managedComputerRuntimeObservation(state, computer)),
  ]);
  const active = runtime.filter(({ status }) => !['absent', 'exited', 'created'].includes(status));
  if (active.length) throw new Error('A full installation export requires the gateway and every computer to be stopped. Run qubicl down, then retry; no runtime was changed.');
  const dashboard = await readDashboardConfiguration(paths.root);
  if (dashboard?.desiredRunning) throw new Error('Stop the dashboard before a full installation export so its protected operation ledger cannot change during capture.');
  const rootEntries = (await readdir(paths.root)).filter((name) => !VOLATILE_ROOT_ENTRIES.has(name) && !name.startsWith('-')).sort();
  if (!rootEntries.includes('config.yaml') || !rootEntries.includes('secrets.yaml') || !rootEntries.includes('computers')) throw new Error('Installation state is incomplete and was not exported.');
  const staging = await mkdtemp(join(dirname(output), '.qubicl-installation-export-'));
  const archive = join(staging, 'installation.tar.gz');
  const encrypted = join(staging, 'installation.qbi');
  const manifest: InstallationManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceVersion: state.config.version === 5 ? '0.6-state-v5' : `state-v${state.config.version}`,
    sourceInstallationId: state.config.installationId,
    computers: state.config.computers.map(({ id, name }) => ({ id, name })),
    includes: ['configuration and scoped client credentials', 'computer homes and browser profiles', 'SSH client/server identities', 'dashboard authentication state', 'trash, audit, and home-backup records'],
    excludes: ['running containers and generated runtime files', 'container root-filesystem changes', 'nested filesystems mounted inside the state root', 'host service-manager registrations', 'external DNS and certificate trust installation'],
  };
  try {
    await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await runTar(paths.root, staging, rootEntries.map((name) => `./${name}`), archive);
    await inspectBackupArchive(archive);
    await encryptBackupFile(archive, encrypted, password);
    await rename(encrypted, output);
    operationOutput('log', JSON.stringify({
      created: output,
      encrypted: true,
      computers: manifest.computers,
      includes: manifest.includes,
      excludes: manifest.excludes,
      verify: `qubicl installation inspect ${JSON.stringify(output)} --passphrase-file FILE`,
    }, null, 2));
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function importInstallation(bundle: string, args: ParsedArgs): Promise<void> {
  const targetRoot = resolve(required(stringOption(args, 'target-root'), '--target-root'));
  const current = statePaths().root;
  if (targetRoot === resolve(current) || inside(current, targetRoot)) throw new Error('Choose a separate target root; installation import never overwrites or nests inside the source installation.');
  await assertAbsent(targetRoot, 'Target state root already exists; import requires a new path.');
  await mkdir(dirname(targetRoot), { recursive: true, mode: 0o700 });
  const stagingParent = await mkdtemp(join(dirname(targetRoot), '.qubicl-installation-import-'));
  const extracted = join(stagingParent, 'state');
  await mkdir(extracted, { mode: 0o700 });
  try {
    const inspected = await extractAndValidate(bundle, args, extracted, stagingParent);
    const priorInstallationId = inspected.state.config.installationId;
    const newInstallationId = randomUUID();
    const dashboard = await readDashboardConfiguration(extracted).catch(() => undefined);
    inspected.state.config.installationId = newInstallationId;
    await prepareStateDirectories(inspected.state.paths);
    await saveState(inspected.state);
    if (dashboard) {
      dashboard.installationId = newInstallationId;
      dashboard.enabled = false;
      dashboard.desiredRunning = false;
      delete dashboard.remote;
      await saveDashboardConfiguration(extracted, dashboard);
    }
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    for (const computer of inspected.state.config.computers) {
      await replaceImportedOwnerMarker(extracted, computer.id, uid, gid);
    }
    await rm(join(extracted, MANIFEST_NAME), { force: false });
    await writeFile(join(extracted, 'import-report.json'), `${JSON.stringify({
      schemaVersion: 1,
      importedAt: new Date().toISOString(),
      sourceInstallationId: priorInstallationId,
      installationId: newInstallationId,
      sourceVersion: inspected.manifest.sourceVersion,
      dashboard: dashboard ? 'disabled until explicitly enabled on this host; remote exposure removed' : 'not configured',
      gatewayExposure: inspected.state.config.gateway.exposure ? 'configuration and sealed TLS material retained; verify host address, DNS, certificate validity, and port before use' : 'disabled',
      next: [`QUBICL_HOME=${targetRoot} qubicl doctor --json`, `QUBICL_HOME=${targetRoot} qubicl storage show ${inspected.state.config.computers[0]?.name ?? 'COMPUTER'}`],
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(extracted, targetRoot);
    operationOutput('log', JSON.stringify({
      imported: targetRoot,
      sourceInstallationId: priorInstallationId,
      installationId: newInstallationId,
      computers: inspected.manifest.computers,
      started: false,
      next: `QUBICL_HOME=${targetRoot} qubicl doctor --json`,
      sourcePreserved: true,
    }, null, 2));
  } finally { await rm(stagingParent, { recursive: true, force: true }); }
}

async function replaceImportedOwnerMarker(root: string, computerId: string, uid: number, gid: number): Promise<void> {
  const home = join(root, 'computers', computerId, 'home', 'qubicl');
  const info = await lstat(home);
  const canonicalRoot = await realpath(root);
  const canonicalHome = await realpath(home);
  if (!info.isDirectory() || info.isSymbolicLink() || !inside(canonicalRoot, canonicalHome)) {
    throw new Error(`Imported computer ${computerId} has an unsafe durable home.`);
  }
  const marker = join(home, '.qubicl-owner');
  try {
    const markerInfo = await lstat(marker);
    if (markerInfo.isDirectory()) throw new Error(`Imported computer ${computerId} has an invalid ownership marker.`);
    await rm(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(marker, `${uid}:${gid}\n`, { mode: 0o600, flag: 'wx' });
}

async function inspectInstallationBundle(bundle: string, args: ParsedArgs): Promise<{ manifest: InstallationManifest; state: Awaited<ReturnType<typeof loadState>> }> {
  const staging = await mkdtemp(join(tmpdir(), 'qubicl-installation-inspect-'));
  const extracted = join(staging, 'state');
  await mkdir(extracted, { mode: 0o700 });
  try { return await extractAndValidate(bundle, args, extracted, staging); }
  finally { await rm(staging, { recursive: true, force: true }); }
}

async function extractAndValidate(bundle: string, args: ParsedArgs, extracted: string, staging: string): Promise<{ manifest: InstallationManifest; state: Awaited<ReturnType<typeof loadState>> }> {
  const password = (await backupPassphraseFromArgs(args, true))!;
  const archive = join(staging, 'decrypted.tar.gz');
  await decryptBackupFile(bundle, archive, password);
  const plan = await inspectBackupArchive(archive);
  if (!plan.entries.has(MANIFEST_NAME) || !plan.entries.has('config.yaml') || !plan.entries.has('secrets.yaml') || !plan.entries.has('computers')) throw new Error('Installation bundle is missing required state records.');
  if ([...plan.entries.keys()].some((name) => name === 'runtime' || name.startsWith(`runtime/`) || name === 'dashboard/runtime' || name.startsWith('dashboard/runtime/'))) throw new Error('Installation bundle contains generated runtime state and cannot be imported.');
  await extractInspectedBackupArchive(archive, extracted, plan);
  const manifest = parseManifest(JSON.parse(await readFile(join(extracted, MANIFEST_NAME), 'utf8')) as unknown);
  const state = await loadState(statePaths(extracted));
  if (manifest.sourceInstallationId !== state.config.installationId) throw new Error('Installation manifest does not match the protected state identity.');
  const configured = state.config.computers.map(({ id, name }) => ({ id, name }));
  if (JSON.stringify(configured) !== JSON.stringify(manifest.computers)) throw new Error('Installation manifest computer inventory does not match protected state.');
  return { manifest, state };
}

function importPlan(manifest: InstallationManifest, config: Awaited<ReturnType<typeof loadState>>['config'], targetRoot: string | undefined): Record<string, unknown> {
  return {
    valid: true,
    createdAt: manifest.createdAt,
    sourceVersion: manifest.sourceVersion,
    sourceInstallationId: manifest.sourceInstallationId,
    computers: manifest.computers,
    includes: manifest.includes,
    excludes: manifest.excludes,
    targetRoot: targetRoot ? resolve(targetRoot) : null,
    reconciliation: {
      installationIdentity: 'a new installation ID will be assigned; computer IDs and client credentials remain unchanged',
      ownership: 'extracted files and home ownership markers will use the importing operator UID/GID',
      runtimes: 'nothing starts automatically; exact images must be locally available or acquired by a later explicit command',
      gateway: { port: config.gateway.port, exposure: config.gateway.exposure ? 'retained but must be revalidated for this host' : 'disabled' },
      ssh: config.computers.filter(({ ssh }) => ssh?.enabled).map(({ name, ssh }) => ({ computer: name, port: ssh!.port, action: 'verify port availability before start; identity is retained' })),
      dashboard: 'disabled on import; local service registration and remote TLS setup must be enabled explicitly',
    },
    command: targetRoot ? `qubicl installation import BUNDLE --target-root ${JSON.stringify(resolve(targetRoot))} --passphrase-file FILE` : 'Choose a new --target-root to import without overwriting the source.',
  };
}

async function runTar(root: string, staging: string, entries: string[], output: string): Promise<void> {
  const args = ['--create', '--gzip', '--file', output, '--format=pax', '--numeric-owner', '--one-file-system', '--exclude=./runtime', '--exclude=./dashboard/runtime', '-C', root, ...entries, '-C', staging, `./${MANIFEST_NAME}`];
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { if (error.length < 8192) error += chunk; });
    child.once('error', rejectRun);
    child.once('close', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`Installation capture failed (${code ?? 'signal'}): ${error.trim()}`)));
  });
}

function parseManifest(value: unknown): InstallationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Installation manifest is invalid.');
  const record = value as Partial<InstallationManifest>;
  if (record.schemaVersion !== 1 || typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))
    || typeof record.sourceVersion !== 'string' || typeof record.sourceInstallationId !== 'string'
    || !Array.isArray(record.computers) || record.computers.some((computer) => !computer || typeof computer.id !== 'string' || typeof computer.name !== 'string')
    || !Array.isArray(record.includes) || record.includes.some((entry) => typeof entry !== 'string')
    || !Array.isArray(record.excludes) || record.excludes.some((entry) => typeof entry !== 'string')) throw new Error('Installation manifest fields are invalid.');
  return record as InstallationManifest;
}

async function assertAbsent(path: string, message: string): Promise<void> {
  try { await lstat(path); throw new Error(message); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
}

function required(value: string | undefined, label: string): string { if (!value) throw new Error(`Missing ${label}.`); return value; }
