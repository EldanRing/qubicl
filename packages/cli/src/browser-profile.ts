import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, join, posix, resolve } from 'node:path';
import { lstat, open, opendir, realpath, rmdir, unlink } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { execFile } from 'node:child_process';
import type { ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag } from './args.js';
import { docker, validateDocker, waitForHealthy, type RunOptions } from './docker.js';
import {
  computerContainerName,
  computerEgressContainerName,
  computerExecutorContainerName,
  computerRuntimeContainerNames,
  computerSessionContainerName,
  computerSshContainerName,
  computerWebContainerName,
} from './runtime.js';
import {
  loadState,
  statePaths,
  syncDirectory,
  withStateLock,
  type LoadedState,
  type StatePaths,
} from './state.js';

export const BROWSER_PROFILE_CONTAINER_PATH = '/home/qubicl/.local/share/qubicl/browser-profile';
export const BROWSER_DOWNLOADS_CONTAINER_PATH = '/home/qubicl/Downloads';
export const MAX_BROWSER_PROFILE_DOMAINS = 500;

const MAX_CHROMIUM_PROFILES = 32;
const MAX_PROFILE_ROOT_ENTRIES = 4096;
const MAX_SQLITE_BYTES = 256 * 1024 * 1024;
const MAX_INVENTORY_WARNINGS = 16;
const MAX_MOUNT_TABLE_BYTES = 16 * 1024 * 1024;
const MAX_MOUNT_TABLE_RECORDS = 32_768;
const MAX_MOUNT_TABLE_LINE_BYTES = 64 * 1024;
const MOUNT_COMMAND_TIMEOUT_MS = 10_000;
const PROFILE_COMPONENTS = ['.local', 'share', 'qubicl', 'browser-profile'] as const;
const CHROMIUM_PROFILE_NAME = /^(?:Default|Guest Profile|System Profile|Profile [1-9][0-9]*)$/u;

export const PROFILE_METADATA_QUERIES = Object.freeze({
  cookies: 'SELECT DISTINCT host_key AS domain FROM cookies WHERE host_key IS NOT NULL AND host_key <> \'\' ORDER BY domain LIMIT ?',
  quotaBucketsStorageKey: 'SELECT DISTINCT storage_key AS domain FROM buckets WHERE storage_key IS NOT NULL AND storage_key <> \'\' ORDER BY domain LIMIT ?',
  quotaBucketsHost: 'SELECT DISTINCT host AS domain FROM buckets WHERE host IS NOT NULL AND host <> \'\' ORDER BY domain LIMIT ?',
  quotaOriginInfo: 'SELECT DISTINCT origin AS domain FROM origin_info WHERE origin IS NOT NULL AND origin <> \'\' ORDER BY domain LIMIT ?',
});

export interface BrowserProfileInventory {
  domains: string[];
  complete: boolean;
  truncated: boolean;
  warnings: string[];
}

export interface ManagedRuntimeSnapshot {
  kind: 'absent' | 'stopped' | 'running';
  containerNames: string[];
  identities: ManagedRuntimeIdentity[];
}

export interface ManagedRuntimeIdentity {
  id: string;
  name: string;
  role: string;
}

export interface ManagedRuntimeRecord {
  name: string;
  status: string | undefined;
}

export interface BrowserProfileCommandDependencies {
  paths(): StatePaths;
  withStateLock<T>(paths: StatePaths, operation: () => Promise<T>): Promise<T>;
  loadState(paths: StatePaths): Promise<LoadedState>;
  validateDocker(): Promise<unknown>;
  inspectRuntime(state: LoadedState, computer: ComputerConfig): Promise<ManagedRuntimeSnapshot>;
  stopRuntime(state: LoadedState, computer: ComputerConfig, snapshot: ManagedRuntimeSnapshot): Promise<void>;
  restartRuntime(state: LoadedState, computer: ComputerConfig, snapshot: ManagedRuntimeSnapshot): Promise<void>;
  inspectProfile(userHome: string, profilePath: string): Promise<'absent' | 'present'>;
  inventoryProfile(profilePath: string): Promise<BrowserProfileInventory>;
  validateMountBoundaries(profilePath: string): Promise<void>;
  removeProfile(profilePath: string): Promise<void>;
  question(computerName: string): Promise<string>;
  interactive: boolean;
  write(message: string): void;
}

export type BrowserProfileDockerRunner = (args: string[], options?: RunOptions) => Promise<string>;

export interface BrowserProfileMountTableSource {
  platform: NodeJS.Platform;
  linuxMountInfo(): Promise<string>;
  macOsMountTable(): Promise<string>;
}

export interface MacOsMountCommandOptions {
  encoding: 'buffer';
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}

export type MacOsMountCommandRunner = (
  executable: string,
  args: readonly string[],
  options: MacOsMountCommandOptions,
) => Promise<{ stdout: Buffer; stderr: Buffer }>;

interface DockerRuntimeInspection {
  Id?: string;
  Name?: string;
  State?: { Status?: string };
  Config?: { Labels?: Record<string, string> | null };
}

interface ExpectedRuntimeBinding {
  name: string;
  role: string;
  computerLabel: 'dev.qubicl.id' | 'dev.qubicl.computer-id';
}

interface RuntimeInventory {
  primaryIds: string[];
  sidecarIds: string[];
  expectedNameIds: Array<{ name: string; id: string }>;
}

let sqliteModulePromise: Promise<typeof import('node:sqlite')> | undefined;

export async function browserProfileCommand(
  args: ParsedArgs,
  injected?: BrowserProfileCommandDependencies,
): Promise<void> {
  assertBrowserProfileInvocation(args);
  const assumeYes = flag(args, 'yes');
  const dependencies = injected ?? defaultDependencies();
  if (!assumeYes && !dependencies.interactive) {
    throw new Error('Non-interactive browser profile wipe requires --yes.');
  }
  const computerName = args.positionals[2]!;
  const paths = dependencies.paths();
  await dependencies.withStateLock(paths, async () => {
    const state = await dependencies.loadState(paths);
    const computer = findComputer(state, computerName);
    if (!computer.capabilities.includes('browser')) {
      throw new Error(`Computer ${computer.name} does not provide the browser capability; nothing was removed.`);
    }
    await dependencies.validateDocker();
    await wipeBrowserProfile(state, computer, assumeYes, dependencies);
  });
}

export function classifyManagedRuntime(
  expectedNames: readonly string[],
  records: readonly ManagedRuntimeRecord[],
): ManagedRuntimeSnapshot {
  if (!expectedNames.length || new Set(expectedNames).size !== expectedNames.length) {
    throw new Error('Qubicl computed an invalid managed runtime group.');
  }
  const byName = new Map<string, string | undefined>();
  for (const record of records) {
    if (!expectedNames.includes(record.name) || byName.has(record.name)) {
      throw new Error('Docker returned an inconsistent managed runtime group.');
    }
    byName.set(record.name, record.status);
  }
  const statuses = expectedNames.map((name) => byName.get(name));
  const forbidden = statuses.find((status) => status !== undefined
    && !['running', 'created', 'exited'].includes(status));
  if (forbidden) {
    throw new Error(`Browser profile wipe requires a stable running or stopped computer; runtime state ${forbidden} is not supported.`);
  }
  if (statuses.every((status) => status === undefined)) return { kind: 'absent', containerNames: [], identities: [] };
  if (statuses.every((status) => status === 'running')) {
    return { kind: 'running', containerNames: [...expectedNames], identities: [] };
  }
  if (statuses.every((status) => status === 'created' || status === 'exited')) {
    return { kind: 'stopped', containerNames: [...expectedNames], identities: [] };
  }
  throw new Error('Browser profile wipe refuses a partial or inconsistent managed runtime group.');
}

export function normalizeStoredDomain(value: string): string | undefined {
  let candidate = value.trim();
  if (!candidate || candidate.length > 8192 || /[\s\\@]/u.test(candidate)) return undefined;
  try {
    if (/^https?:\/\//iu.test(candidate)) {
      const origin = new URL(candidate);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) return undefined;
      return normalizedHostname(origin.hostname);
    }
    candidate = candidate.replace(/^\.+/u, '');
    if (!candidate || /[/?#%]/u.test(candidate)) return undefined;
    const origin = new URL(`http://${candidate}/`);
    if (origin.username || origin.password || origin.port) return undefined;
    return normalizedHostname(origin.hostname);
  } catch {
    return undefined;
  }
}

export async function inspectFixedBrowserProfilePath(
  userHome: string,
  profilePath: string,
): Promise<'absent' | 'present'> {
  const resolvedHome = resolve(userHome);
  const expectedProfile = resolve(resolvedHome, ...PROFILE_COMPONENTS);
  if (resolve(profilePath) !== expectedProfile) throw new Error('Browser profile path does not match Qubicl\'s fixed managed profile.');
  await requireRealDirectory(resolvedHome, 'computer home');
  let current = resolvedHome;
  for (const [index, component] of PROFILE_COMPONENTS.entries()) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      const label = index === PROFILE_COMPONENTS.length - 1 ? 'managed browser profile' : 'managed browser profile parent';
      throw new Error(`The ${label} is not a real directory; refusing to follow or remove it.`);
    }
  }
  if (await realpath(expectedProfile) !== expectedProfile) {
    throw new Error('The managed browser profile path traverses a symbolic link; refusing to follow or remove it.');
  }
  return 'present';
}

export async function inventoryBrowserProfile(profilePath: string): Promise<BrowserProfileInventory> {
  const collector = new DomainCollector();
  const profileCandidates: Dirent[] = [];
  let directory;
  try {
    const profile = await lstat(profilePath);
    if (profile.isSymbolicLink() || !profile.isDirectory()) {
      collector.warn('The managed Chromium profile was not a real directory; metadata was not inspected.');
      return collector.result();
    }
    directory = await opendir(profilePath);
    let scanned = 0;
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      scanned += 1;
      if (scanned > MAX_PROFILE_ROOT_ENTRIES) {
        collector.warn('The managed profile entry count exceeded the inventory bound; some domains may not be listed.');
        break;
      }
      if (!CHROMIUM_PROFILE_NAME.test(entry.name)) continue;
      profileCandidates.push(entry);
    }
  } catch {
    collector.warn('Chromium profile metadata could not be enumerated; some domains may not be listed.');
    return collector.result();
  } finally {
    await directory?.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  profileCandidates.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const namedProfiles = profileCandidates.slice(0, MAX_CHROMIUM_PROFILES);
  if (profileCandidates.length > namedProfiles.length) {
    collector.warn('The Chromium profile count exceeded the inventory bound; some domains may not be listed.');
  }
  const profileDirectories = [profilePath];
  for (const entry of namedProfiles) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      collector.warn('A Chromium profile entry was not a real directory and was skipped.');
      continue;
    }
    profileDirectories.push(join(profilePath, entry.name));
  }
  for (const directory of profileDirectories) {
    await inventoryCookieDatabase(join(directory, 'Network', 'Cookies'), collector);
    await inventoryCookieDatabase(join(directory, 'Cookies'), collector);
    await inventoryQuotaDatabase(join(directory, 'QuotaManager'), collector);
    await noteUnsupportedLocalStorage(join(directory, 'Local Storage', 'leveldb'), collector);
    if (collector.isTruncated()) break;
  }
  return collector.result();
}

export function parseLinuxMountInfo(contents: string): string[] {
  assertMountTableText(contents, 'Linux mountinfo');
  const mountPoints: string[] = [];
  const lines = mountTableLines(contents, 'Linux mountinfo');
  for (const line of lines) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length - separator < 4
      || fields.some((field) => !field)
      || !/^\d+$/u.test(fields[0] ?? '')
      || !/^\d+$/u.test(fields[1] ?? '')
      || !/^\d+:\d+$/u.test(fields[2] ?? '')
      || fields.slice(6, separator).some((field) => !/^[^\s-][^\s]*$/u.test(field))) {
      throw new Error('Linux mountinfo contained a malformed record.');
    }
    decodeLinuxMountPath(fields[3]!);
    mountPoints.push(normalizedAbsoluteMountPath(decodeLinuxMountPath(fields[4]!), 'Linux mountinfo'));
  }
  if (!mountPoints.includes('/')) throw new Error('Linux mountinfo did not contain the root mount record.');
  return uniqueSorted(mountPoints);
}

export function parseMacOsMountTable(contents: string): string[] {
  assertMountTableText(contents, 'macOS mount table');
  const mountPoints: string[] = [];
  for (const line of mountTableLines(contents, 'macOS mount table')) {
    if (line.split(' on ').length !== 2 || line.split(' (').length !== 2 || !line.endsWith(')')) {
      throw new Error('macOS mount output contained an ambiguous or malformed record.');
    }
    const on = line.indexOf(' on ');
    const options = line.indexOf(' (', on + 4);
    const source = line.slice(0, on);
    const mountPoint = line.slice(on + 4, options);
    const optionText = line.slice(options + 2, -1);
    if (!source || !mountPoint || !optionText || containsControlCharacter(source + mountPoint + optionText)) {
      throw new Error('macOS mount output contained an ambiguous or malformed record.');
    }
    // Darwin mount(8) renders path bytes directly. Linux octal decoding here
    // would reinterpret valid literal backslashes and is deliberately avoided.
    mountPoints.push(normalizedAbsoluteMountPath(mountPoint, 'macOS mount table'));
  }
  if (!mountPoints.includes('/')) throw new Error('macOS mount output did not contain the root mount record.');
  return uniqueSorted(mountPoints);
}

export async function readMacOsMountTable(
  command: MacOsMountCommandRunner = executeMacOsMountCommand,
): Promise<string> {
  const result = await command('/sbin/mount', [], {
    encoding: 'buffer',
    env: { LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_MOUNT_TABLE_BYTES,
    timeout: MOUNT_COMMAND_TIMEOUT_MS,
  });
  if (result.stderr.length) throw new Error('macOS mount command wrote unexpected diagnostic output.');
  if (result.stdout.length > MAX_MOUNT_TABLE_BYTES) throw new Error('macOS mount output exceeded the byte bound.');
  return decodeUtf8Strict(result.stdout, 'macOS mount output');
}

export async function assertNoBrowserProfileMountBoundaries(
  profilePath: string,
  source: BrowserProfileMountTableSource = defaultMountTableSource(),
): Promise<void> {
  const normalizedProfile = normalizedAbsoluteMountPath(profilePath, 'Browser profile');
  let mountPoints: string[];
  if (source.platform === 'linux') mountPoints = parseLinuxMountInfo(await source.linuxMountInfo());
  else if (source.platform === 'darwin') mountPoints = parseMacOsMountTable(await source.macOsMountTable());
  else throw new Error(`Browser profile wipe cannot establish mount boundaries on ${source.platform}.`);
  if (!mountPoints.some((mountPoint) => pathAtOrBelow(mountPoint, normalizedProfile))) {
    throw new Error('The host mount table does not contain a filesystem covering the managed browser profile.');
  }
  if (mountPoints.some((mountPoint) => pathAtOrBelow(normalizedProfile, mountPoint))) {
    throw new Error('The managed browser profile root or a descendant is a host mount point; refusing recursive removal.');
  }
}

export async function removeBrowserProfileNoFollow(
  profilePath: string,
  mountSource: BrowserProfileMountTableSource = defaultMountTableSource(),
): Promise<void> {
  let userHome = resolve(profilePath);
  for (let index = 0; index < PROFILE_COMPONENTS.length; index += 1) userHome = dirname(userHome);
  if (await inspectFixedBrowserProfilePath(userHome, profilePath) !== 'present') {
    throw new Error('The fixed managed browser profile is absent.');
  }
  const info = await lstat(profilePath, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('The managed browser profile is not a real directory; refusing to follow or remove it.');
  }
  await assertNoBrowserProfileMountBoundaries(profilePath, mountSource);
  await removeDirectoryContentsNoFollow(profilePath, info.dev, info.ino);
  await assertSameRealDirectory(profilePath, info.dev, info.ino);
  await assertNoBrowserProfileMountBoundaries(profilePath, mountSource);
  await rmdir(profilePath);
  await syncDirectory(dirname(profilePath));
}

async function wipeBrowserProfile(
  state: LoadedState,
  computer: ComputerConfig,
  assumeYes: boolean,
  dependencies: BrowserProfileCommandDependencies,
): Promise<void> {
  const initial = await dependencies.inspectRuntime(state, computer);
  const wasRunning = initial.kind === 'running';
  let restoreNeeded = false;
  if (wasRunning) {
    dependencies.write(`Preparing an exact browser-profile preview temporarily stops ${computer.name}; no profile data has been removed.`);
    restoreNeeded = true;
    try {
      await dependencies.stopRuntime(state, computer, initial);
      assertExpectedRuntime(await dependencies.inspectRuntime(state, computer), initial, 'stopped');
    } catch (error) {
      const recovery = await restoreRuntime(state, computer, initial, dependencies);
      restoreNeeded = false;
      throw new Error(`Could not stop ${computer.name} safely. No browser profile data was removed.${recovery}${technicalCause(error)}`);
    }
  }

  const userHome = join(state.paths.computers, computer.id, 'home', 'qubicl');
  const profilePath = join(userHome, ...PROFILE_COMPONENTS);
  let presence: 'absent' | 'present';
  let inventory: BrowserProfileInventory;
  try {
    presence = await dependencies.inspectProfile(userHome, profilePath);
    inventory = presence === 'present'
      ? await dependencies.inventoryProfile(profilePath)
      : { domains: [], complete: true, truncated: false, warnings: [] };
  } catch (error) {
    const recovery = restoreNeeded ? await restoreRuntime(state, computer, initial, dependencies) : '';
    restoreNeeded = false;
    throw new Error(`Could not validate the fixed managed browser profile. No browser profile data was removed.${recovery}${technicalCause(error)}`);
  }

  let answer: string | undefined;
  try {
    dependencies.write(formatBrowserProfilePreview(computer.name, presence, inventory));
    if (!assumeYes) answer = await dependencies.question(computer.name);
  } catch (error) {
    const recovery = restoreNeeded ? await restoreRuntime(state, computer, initial, dependencies) : '';
    restoreNeeded = false;
    throw new Error(`Browser profile confirmation for ${computer.name} could not be completed. No browser profile data was removed.${recovery}${technicalCause(error)}`);
  }
  if (!assumeYes && answer !== computer.name) {
    const recovery = restoreNeeded ? await restoreRuntime(state, computer, initial, dependencies) : '';
    restoreNeeded = false;
    throw new Error(`Confirmation did not match ${computer.name}; no browser profile data was removed.${recovery}`);
  }

  let deletionStarted = false;
  let removed = false;
  try {
    const current = await dependencies.inspectProfile(userHome, profilePath);
    const expectedKind = wasRunning ? 'stopped' : initial.kind;
    assertExpectedRuntime(await dependencies.inspectRuntime(state, computer), initial, expectedKind);
    if (current === 'present') {
      await dependencies.validateMountBoundaries(profilePath);
      deletionStarted = true;
      await dependencies.removeProfile(profilePath);
      if (await dependencies.inspectProfile(userHome, profilePath) !== 'absent') {
        throw new Error('the fixed managed browser profile still exists after removal');
      }
      removed = true;
    }
  } catch (error) {
    if (deletionStarted) {
      restoreNeeded = false;
      const runtimeOutcome = initial.kind === 'absent'
        ? 'No managed runtime was present and it remains inactive'
        : 'The computer was left stopped';
      throw new Error(`Browser profile removal for ${computer.name} failed after deletion began and may be partial. ${runtimeOutcome}; rerun the same wipe command to finish safely.${technicalCause(error)}`);
    }
    const recovery = restoreNeeded ? await restoreRuntime(state, computer, initial, dependencies) : '';
    restoreNeeded = false;
    throw new Error(`Browser profile validation changed before deletion. Nothing was removed.${recovery}${technicalCause(error)}`);
  }

  if (restoreNeeded) {
    try {
      await restoreRunningRuntime(state, computer, initial, dependencies);
      restoreNeeded = false;
    } catch (error) {
      restoreNeeded = false;
      const outcome = removed
        ? 'The browser profile was wiped successfully'
        : 'No managed browser profile was present';
      throw new Error(`${outcome}, but Qubicl could not restore ${computer.name} to its prior running state. Its runtime may now be stopped or partial; inspect it, then run qubicl start ${computer.name}.${technicalCause(error)}`);
    }
  }

  if (removed) {
    dependencies.write(`Wiped the durable Chromium profile for ${computer.name}. ${BROWSER_DOWNLOADS_CONTAINER_PATH} and every other file outside ${BROWSER_PROFILE_CONTAINER_PATH} remain.`);
  } else {
    dependencies.write(`No managed Chromium profile was present for ${computer.name}; nothing was removed.`);
  }
  if (wasRunning) dependencies.write(`Restored ${computer.name} to its prior running state.`);
}

function assertBrowserProfileInvocation(args: ParsedArgs): void {
  if (args.positionals.length !== 3 || args.positionals[0] !== 'profile' || args.positionals[1] !== 'wipe' || !args.positionals[2]) {
    throw new Error('Browser command must be: qubicl browser profile wipe COMPUTER.');
  }
  for (const option of args.options.keys()) {
    if (option !== 'yes') throw new Error(`Browser profile wipe does not accept --${option}.`);
  }
}

function findComputer(state: LoadedState, name: string): ComputerConfig {
  const computer = state.config.computers.find(({ name: candidate, id }) => candidate === name || id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return computer;
}

function defaultDependencies(): BrowserProfileCommandDependencies {
  return {
    paths: statePaths,
    withStateLock,
    loadState,
    validateDocker,
    inspectRuntime: inspectManagedRuntime,
    stopRuntime: async (_state, _computer, snapshot) => {
      await docker(['stop', ...runtimeIdentityIds(snapshot)]);
    },
    restartRuntime: async (state, computer, snapshot) => {
      await docker(['start', ...runtimeIdentityIds(snapshot).toReversed()]);
      await waitForHealthy(state, computer.id);
    },
    inspectProfile: inspectFixedBrowserProfilePath,
    inventoryProfile: inventoryBrowserProfile,
    validateMountBoundaries: assertNoBrowserProfileMountBoundaries,
    removeProfile: removeBrowserProfileNoFollow,
    question: typedBrowserProfileConfirmation,
    interactive: Boolean(stdin.isTTY),
    write: (message) => console.log(message),
  };
}

export async function inspectManagedRuntime(
  state: LoadedState,
  computer: ComputerConfig,
  runDocker: BrowserProfileDockerRunner = docker,
): Promise<ManagedRuntimeSnapshot> {
  const expected = expectedRuntimeBindings(state, computer);
  const expectedNames = expected.map(({ name }) => name);
  const expectedByName = new Map(expected.map((binding) => [binding.name, binding]));
  const inventoryBefore = await collectRuntimeInventory(state, computer, expectedNames, runDocker);
  const ownedIds = [...inventoryBefore.primaryIds, ...inventoryBefore.sidecarIds];
  if (new Set(ownedIds).size !== ownedIds.length) {
    throw new Error('A managed runtime container matched both primary and sidecar ownership labels.');
  }
  const ownedIdSet = new Set(ownedIds);
  for (const { name, id } of inventoryBefore.expectedNameIds) {
    if (!ownedIdSet.has(id)) {
      throw new Error(`Runtime name ${name} is not owned by Qubicl computer ${computer.name}; refusing browser profile removal.`);
    }
  }
  const records: ManagedRuntimeRecord[] = [];
  const identitiesByName = new Map<string, ManagedRuntimeIdentity>();
  for (const inventoryId of ownedIds) {
    const serialized = await runDocker(['inspect', '--format', '{{json .}}', inventoryId], { maxOutputBytes: 1024 * 1024 });
    let inspected: DockerRuntimeInspection;
    try {
      inspected = JSON.parse(serialized) as DockerRuntimeInspection;
    } catch {
      throw new Error(`Docker returned invalid runtime metadata for managed container ID ${inventoryId}.`);
    }
    if (!isFullContainerId(inspected.Id) || inspected.Id !== inventoryId
      || typeof inspected.Name !== 'string' || !/^\/[^/]+$/u.test(inspected.Name)) {
      throw new Error('Docker returned incomplete or changed immutable runtime identity metadata.');
    }
    const name = inspected.Name.slice(1);
    const binding = expectedByName.get(name);
    if (!binding || identitiesByName.has(name)) {
      throw new Error('The owned runtime contains an extra, duplicate, or unknown managed container.');
    }
    const labels = inspected.Config?.Labels ?? {};
    const otherComputerLabel = binding.computerLabel === 'dev.qubicl.id' ? 'dev.qubicl.computer-id' : 'dev.qubicl.id';
    if (labels['dev.qubicl.installation'] !== state.config.installationId
      || labels[binding.computerLabel] !== computer.id
      || labels[otherComputerLabel] !== undefined
      || labels['dev.qubicl.role'] !== binding.role) {
      throw new Error(`Managed runtime container ${name} has an unexpected ownership or role binding.`);
    }
    if (inventoryBefore.expectedNameIds.find(({ name: candidate }) => candidate === name)?.id !== inventoryId) {
      throw new Error(`Managed runtime name ${name} changed immutable container identity during inspection.`);
    }
    const status = inspected.State?.Status;
    if (typeof status !== 'string' || !status) {
      throw new Error(`Docker returned incomplete runtime metadata for managed container ${name}.`);
    }
    records.push({ name, status });
    identitiesByName.set(name, { id: inventoryId, name, role: binding.role });
  }
  if (ownedIds.length && identitiesByName.size !== expected.length) {
    throw new Error('Browser profile wipe refuses a partial managed runtime identity set.');
  }
  const inventoryAfter = await collectRuntimeInventory(state, computer, expectedNames, runDocker);
  if (runtimeInventoryFingerprint(inventoryAfter) !== runtimeInventoryFingerprint(inventoryBefore)) {
    throw new Error('The managed runtime identity changed during inspection; refusing to wipe browser data.');
  }
  const classified = classifyManagedRuntime(expectedNames, records);
  return {
    ...classified,
    identities: classified.kind === 'absent'
      ? []
      : expected.map(({ name }) => identitiesByName.get(name)!),
  };
}

async function collectRuntimeInventory(
  state: LoadedState,
  computer: ComputerConfig,
  expectedNames: readonly string[],
  runDocker: BrowserProfileDockerRunner,
): Promise<RuntimeInventory> {
  const ownershipFilters = ['--filter', `label=dev.qubicl.installation=${state.config.installationId}`];
  const primaryIds = parseContainerIdList(await runDocker([
    'container', 'ls', '--all', '--no-trunc', ...ownershipFilters,
    '--filter', `label=dev.qubicl.id=${computer.id}`, '--format', '{{.ID}}',
  ], { maxOutputBytes: 4 * 1024 * 1024 }));
  const sidecarIds = parseContainerIdList(await runDocker([
    'container', 'ls', '--all', '--no-trunc', ...ownershipFilters,
    '--filter', `label=dev.qubicl.computer-id=${computer.id}`, '--format', '{{.ID}}',
  ], { maxOutputBytes: 4 * 1024 * 1024 }));
  const allContainers = await runDocker([
    'container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}',
  ], { maxOutputBytes: 8 * 1024 * 1024 });
  const expectedSet = new Set(expectedNames);
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const expectedNameIds: Array<{ name: string; id: string }> = [];
  for (const line of allContainers ? allContainers.split('\n').filter(Boolean) : []) {
    let record: { ID?: unknown; Names?: unknown };
    try {
      record = JSON.parse(line) as { ID?: unknown; Names?: unknown };
    } catch {
      throw new Error('Docker returned malformed container-name inventory metadata.');
    }
    if (!isFullContainerId(record.ID) || typeof record.Names !== 'string' || !record.Names
      || seenIds.has(record.ID) || seenNames.has(record.Names)) {
      throw new Error('Docker returned incomplete or duplicate container-name inventory metadata.');
    }
    seenIds.add(record.ID);
    seenNames.add(record.Names);
    if (expectedSet.has(record.Names)) expectedNameIds.push({ name: record.Names, id: record.ID });
  }
  expectedNameIds.sort((left, right) => expectedNames.indexOf(left.name) - expectedNames.indexOf(right.name));
  return { primaryIds, sidecarIds, expectedNameIds };
}

function parseContainerIdList(output: string): string[] {
  const ids = output ? output.split('\n').map((id) => id.trim()).filter(Boolean) : [];
  if (ids.some((id) => !isFullContainerId(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Docker returned incomplete or duplicate owned-container identity metadata.');
  }
  return ids.sort();
}

function isFullContainerId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function runtimeInventoryFingerprint(inventory: RuntimeInventory): string {
  return JSON.stringify(inventory);
}

function expectedRuntimeBindings(state: LoadedState, computer: ComputerConfig): ExpectedRuntimeBinding[] {
  const primaryName = computerContainerName(state, computer);
  const roles = new Map<string, string>([
    [primaryName, 'computer'],
    [computerExecutorContainerName(state, computer), 'computer-executor'],
    [computerEgressContainerName(state, computer), 'computer-egress'],
    [computerWebContainerName(state, computer), 'computer-web'],
    [computerSessionContainerName(state, computer), 'computer-session'],
    [computerSshContainerName(state, computer), 'computer-ssh'],
  ]);
  return computerRuntimeContainerNames(state, computer).map((name) => {
    const role = roles.get(name);
    if (!role) throw new Error(`Qubicl computed an unknown managed runtime role for ${name}.`);
    return { name, role, computerLabel: name === primaryName ? 'dev.qubicl.id' : 'dev.qubicl.computer-id' };
  });
}

function assertExpectedRuntime(
  actual: ManagedRuntimeSnapshot,
  expected: ManagedRuntimeSnapshot,
  expectedKind: ManagedRuntimeSnapshot['kind'],
): void {
  if (actual.kind !== expectedKind
    || JSON.stringify(actual.containerNames) !== JSON.stringify(expected.containerNames)
    || JSON.stringify(actual.identities) !== JSON.stringify(expected.identities)) {
    throw new Error(`Managed runtime did not reach the expected ${expectedKind} state.`);
  }
}

function runtimeIdentityIds(snapshot: ManagedRuntimeSnapshot): string[] {
  if (snapshot.kind === 'absent' || snapshot.identities.length !== snapshot.containerNames.length) {
    throw new Error('Managed runtime identity is incomplete; refusing lifecycle changes.');
  }
  return snapshot.identities.map(({ id }) => id);
}

async function restoreRunningRuntime(
  state: LoadedState,
  computer: ComputerConfig,
  initial: ManagedRuntimeSnapshot,
  dependencies: BrowserProfileCommandDependencies,
): Promise<void> {
  await dependencies.restartRuntime(state, computer, initial);
  assertExpectedRuntime(await dependencies.inspectRuntime(state, computer), initial, 'running');
}

async function restoreRuntime(
  state: LoadedState,
  computer: ComputerConfig,
  initial: ManagedRuntimeSnapshot,
  dependencies: BrowserProfileCommandDependencies,
): Promise<string> {
  try {
    await restoreRunningRuntime(state, computer, initial, dependencies);
    return ` Restored ${computer.name} to its prior running state.`;
  } catch {
    return ` Qubicl also could not restore ${computer.name} to its prior running state; run qubicl start ${computer.name}.`;
  }
}

function formatBrowserProfilePreview(
  computerName: string,
  presence: 'absent' | 'present',
  inventory: BrowserProfileInventory,
): string {
  const domains = inventory.domains.length
    ? inventory.domains.map((domain) => `  - ${domain}`).join('\n')
    : inventory.complete ? '  - None found' : '  - None could be identified reliably';
  const warnings = inventory.warnings.length
    ? `\nInventory warnings:\n${inventory.warnings.map((warning) => `  - ${warning}`).join('\n')}`
    : '';
  return [
    `Browser profile wipe preview for ${computerName}`,
    `Managed profile: ${BROWSER_PROFILE_CONTAINER_PATH} (${presence === 'present' ? 'present' : 'not present'})`,
    'This Chromium profile is durable and normally survives restarts, runtime recreation, and upgrades.',
    'Domains with stored cookies/site data:',
    domains,
    inventory.truncated ? '  - Additional domain metadata was omitted at the fixed inventory bound; some domains may not be listed.' : '',
    warnings,
    'What will be removed:',
    '  - Cookies',
    '  - Local storage',
    '  - History',
    '  - Preferences',
    '  - Sessions',
    `  - Every other item inside ${BROWSER_PROFILE_CONTAINER_PATH}`,
    'What will remain:',
    `  - ${BROWSER_DOWNLOADS_CONTAINER_PATH}`,
    `  - Every other file outside ${BROWSER_PROFILE_CONTAINER_PATH}`,
    'Existing full-home backups/checkpoints, clones, recoverable trash, and external copies are not changed and may retain or restore browser profile data.',
    'This operation ends active browser tabs, leases, managed processes, and viewer sessions while the computer is stopped.',
  ].filter(Boolean).join('\n');
}

export async function typedBrowserProfileConfirmation(computerName: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  const priorProcessInterruptListeners = process.rawListeners('SIGINT') as Array<() => void>;
  const abort = new AbortController();
  const interrupted = new Error('Browser profile confirmation was interrupted by SIGINT.');
  let receivedInterrupt = false;
  const interrupt = (): void => {
    if (receivedInterrupt) return;
    receivedInterrupt = true;
    abort.abort(interrupted);
    prompt.close();
  };
  prompt.on('SIGINT', interrupt);
  process.removeAllListeners('SIGINT');
  process.on('SIGINT', interrupt);
  try {
    const answer = await prompt.question(
      `Type ${computerName} to permanently wipe its managed Chromium profile: `,
      { signal: abort.signal },
    );
    if (receivedInterrupt) throw interrupted;
    return answer;
  } catch (error) {
    if (receivedInterrupt) throw interrupted;
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    for (const listener of priorProcessInterruptListeners) process.on('SIGINT', listener);
    prompt.off('SIGINT', interrupt);
    prompt.close();
  }
}

async function requireRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`The ${label} is not a real directory.`);
}

async function removeDirectoryContentsNoFollow(path: string, device: bigint, inode: bigint): Promise<void> {
  await assertSameRealDirectory(path, device, inode);
  const directory = await opendir(path);
  try {
    let entry;
    while ((entry = await directory.read())) {
      await assertSameRealDirectory(path, device, inode);
      const child = join(path, entry.name);
      const info = await lstat(child, { bigint: true });
      if (info.isDirectory() && !info.isSymbolicLink()) {
        if (info.dev !== device) throw new Error('The managed browser profile contains a mounted directory; refusing to cross it.');
        await removeDirectoryContentsNoFollow(child, device, info.ino);
        await assertSameRealDirectory(path, device, inode);
        await rmdir(child);
      } else {
        await assertSameRealDirectory(path, device, inode);
        await unlink(child);
      }
    }
  } finally {
    await directory.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
}

async function assertSameRealDirectory(path: string, device: bigint, inode: bigint): Promise<void> {
  const current = await lstat(path, { bigint: true });
  if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== device || current.ino !== inode) {
    throw new Error('The managed browser profile changed during removal; refusing to follow the changed path.');
  }
}

async function inventoryCookieDatabase(path: string, collector: DomainCollector): Promise<void> {
  if (!await regularBoundedSqliteSet(path, collector, 'Cookie domain metadata')) return;
  try {
    const database = await openReadOnlyDatabase(path);
    try {
      const rows = database.prepare(PROFILE_METADATA_QUERIES.cookies).all(MAX_BROWSER_PROFILE_DOMAINS + 1) as Array<{ domain?: unknown }>;
      collector.addRows(rows);
    } finally {
      database.close();
    }
  } catch {
    collector.warn('Cookie domain metadata could not be read; some domains may not be listed.');
  }
}

async function inventoryQuotaDatabase(path: string, collector: DomainCollector): Promise<void> {
  if (!await regularBoundedSqliteSet(path, collector, 'Site-data origin metadata')) return;
  try {
    const database = await openReadOnlyDatabase(path);
    let recognized = false;
    try {
      for (const query of [
        PROFILE_METADATA_QUERIES.quotaBucketsStorageKey,
        PROFILE_METADATA_QUERIES.quotaBucketsHost,
        PROFILE_METADATA_QUERIES.quotaOriginInfo,
      ]) {
        try {
          const rows = database.prepare(query).all(MAX_BROWSER_PROFILE_DOMAINS + 1) as Array<{ domain?: unknown }>;
          recognized = true;
          collector.addRows(rows);
        } catch {
          // Chromium has used several QuotaManager schemas. Only fixed,
          // metadata-only columns are attempted; unknown schemas stay opaque.
        }
      }
      if (!recognized) collector.warn('Site-data origin metadata uses an unknown Chromium schema; some domains may not be listed.');
    } finally {
      database.close();
    }
  } catch {
    collector.warn('Site-data origin metadata could not be read; some domains may not be listed.');
  }
}

async function noteUnsupportedLocalStorage(path: string, collector: DomainCollector): Promise<void> {
  try {
    const parent = await lstat(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      collector.warn('Local-storage metadata parent was not a real directory and was skipped.');
      return;
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      collector.warn('Local-storage metadata was not a real directory and was skipped.');
      return;
    }
    const directory = await opendir(path);
    try {
      if (await directory.read()) {
        collector.warn('Local-storage origin metadata uses an unsupported LevelDB format; some domains may not be listed.');
      }
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      collector.warn('Local-storage origin metadata could not be enumerated; some domains may not be listed.');
    }
  }
}

async function regularBoundedSqliteSet(path: string, collector: DomainCollector, label: string): Promise<boolean> {
  try {
    const parent = await lstat(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      collector.warn(`${label} parent was not a real directory and was skipped.`);
      return false;
    }
    let aggregateBytes = 0;
    let mainPresent = false;
    for (const [index, candidate] of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].entries()) {
      let info;
      try {
        info = await lstat(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (index === 0) mainPresent = true;
      if (info.isSymbolicLink() || !info.isFile()) {
        collector.warn(`${label} or a SQLite companion was not a real file and was skipped.`);
        return false;
      }
      aggregateBytes += info.size;
      if (aggregateBytes > MAX_SQLITE_BYTES) {
        collector.warn(`${label} and its SQLite companions exceeded the aggregate inventory size bound and were skipped.`);
        return false;
      }
    }
    if (!mainPresent) {
      if (aggregateBytes) collector.warn(`${label} had SQLite companions without a main database and was skipped.`);
      return false;
    }
    if (!collector.reserveSqliteBytes(aggregateBytes)) {
      collector.warn('Chromium SQLite metadata exceeded the total inventory byte bound; some domains may not be listed.');
      return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') collector.warn(`${label} could not be inspected.`);
    return false;
  }
}

async function openReadOnlyDatabase(path: string): Promise<import('node:sqlite').DatabaseSync> {
  const { DatabaseSync } = await sqliteModule();
  const database = new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: false,
  });
  database.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  return database;
}

function sqliteModule(): Promise<typeof import('node:sqlite')> {
  sqliteModulePromise ??= loadSqliteWithoutExperimentalNoise();
  return sqliteModulePromise;
}

async function loadSqliteWithoutExperimentalNoise(): Promise<typeof import('node:sqlite')> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...details: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning;
    const type = typeof details[0] === 'string' ? details[0] : undefined;
    if (type === 'ExperimentalWarning' && message === 'SQLite is an experimental feature and might change at any time') return;
    Reflect.apply(originalEmitWarning, process, [warning, ...details]);
  }) as typeof process.emitWarning;
  try {
    const sqlite = await import('node:sqlite');
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    return sqlite;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

class DomainCollector {
  private readonly found = new Set<string>();
  private readonly messages = new Set<string>();
  private malformed = false;
  private truncated = false;
  private sqliteBytes = 0;

  addRows(rows: Array<{ domain?: unknown }>): void {
    for (const row of rows) {
      if (typeof row.domain !== 'string') {
        this.malformed = true;
        continue;
      }
      const domain = normalizeStoredDomain(row.domain);
      if (!domain) {
        this.malformed = true;
        continue;
      }
      if (this.found.size >= MAX_BROWSER_PROFILE_DOMAINS && !this.found.has(domain)) {
        this.truncated = true;
        break;
      }
      this.found.add(domain);
    }
    if (rows.length > MAX_BROWSER_PROFILE_DOMAINS) this.truncated = true;
  }

  warn(message: string): void {
    if (this.messages.size < MAX_INVENTORY_WARNINGS) this.messages.add(message);
  }

  reserveSqliteBytes(bytes: number): boolean {
    if (this.sqliteBytes + bytes > MAX_SQLITE_BYTES) return false;
    this.sqliteBytes += bytes;
    return true;
  }

  isTruncated(): boolean {
    return this.truncated;
  }

  result(): BrowserProfileInventory {
    if (this.malformed) this.warn('Some malformed domain metadata was omitted.');
    if (this.truncated) this.warn('The domain inventory reached its fixed output bound.');
    const warnings = [...this.messages];
    return {
      domains: [...this.found].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      complete: warnings.length === 0,
      truncated: this.truncated,
      warnings,
    };
  }
}

function normalizedHostname(value: string): string | undefined {
  const hostname = value.toLowerCase().replace(/\.$/u, '');
  if (!hostname || hostname.length > 253 || /[\s\\/?#%@]/u.test(hostname)) return undefined;
  return hostname;
}

function defaultMountTableSource(): BrowserProfileMountTableSource {
  return {
    platform: process.platform,
    linuxMountInfo: async () => decodeUtf8Strict(
      await readBoundedFile('/proc/self/mountinfo', MAX_MOUNT_TABLE_BYTES),
      'Linux mountinfo',
    ),
    macOsMountTable: readMacOsMountTable,
  };
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw new Error('The host mount table exceeded the byte bound.');
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error('The host mount table exceeded the byte bound.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, total);
}

function executeMacOsMountCommand(
  executable: string,
  args: readonly string[],
  options: MacOsMountCommandOptions,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolvePromise, reject) => {
    execFile(executable, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error('macOS mount command failed, timed out, or was terminated.'));
        return;
      }
      if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr)) {
        reject(new Error('macOS mount command returned an unexpected output encoding.'));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function decodeUtf8Strict(contents: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${label} was not valid UTF-8.`);
  }
}

function assertMountTableText(contents: string, label: string): void {
  if (!contents || !contents.endsWith('\n') || contents.includes('\0') || contents.includes('\r')
    || contents.includes('\uFFFD') || Buffer.byteLength(contents) > MAX_MOUNT_TABLE_BYTES) {
    throw new Error(`${label} was empty, truncated, oversized, or malformed.`);
  }
}

function mountTableLines(contents: string, label: string): string[] {
  const lines = contents.slice(0, -1).split('\n');
  if (!lines.length || lines.length > MAX_MOUNT_TABLE_RECORDS
    || lines.some((line) => !line || Buffer.byteLength(line) > MAX_MOUNT_TABLE_LINE_BYTES)) {
    throw new Error(`${label} exceeded its record or line bounds.`);
  }
  return lines;
}

function decodeLinuxMountPath(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') {
      decoded += value[index];
      continue;
    }
    const escape = value.slice(index, index + 4);
    const replacement = ({
      '\\011': '\t',
      '\\012': '\n',
      '\\040': ' ',
      '\\134': '\\',
    } as Record<string, string>)[escape];
    if (replacement === undefined) throw new Error('Linux mountinfo contained an unsupported path escape.');
    decoded += replacement;
    index += 3;
  }
  return decoded;
}

function normalizedAbsoluteMountPath(value: string, label: string): string {
  if (!posix.isAbsolute(value) || value.includes('\0')) throw new Error(`${label} contained a non-absolute mount path.`);
  const normalized = posix.normalize(value);
  if (normalized !== value) throw new Error(`${label} contained a non-canonical mount path.`);
  return normalized;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function pathAtOrBelow(root: string, candidate: string): boolean {
  return root === '/' ? candidate.startsWith('/') : candidate === root || candidate.startsWith(`${root}/`);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function technicalCause(error: unknown): string {
  return ` Cause: ${error instanceof Error ? error.message : String(error)}`;
}
