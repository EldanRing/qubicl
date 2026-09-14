import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chown, copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopApplicationName, Preset } from '@qubicl/core';
import { QubiclError } from './errors.js';

const DEFAULT_ROOT = '/home/qubicl';
const DEFAULT_MAX_APPLICATIONS = 8;
const GRACEFUL_CLOSE_MS = 1_500;
const FORCED_CLOSE_MS = 500;

type AllowedPathKind = 'file' | 'directory' | 'either';

export interface DesktopApplicationDefinition {
  executable: string;
  fixedArguments: readonly string[];
  allowedPathKind: AllowedPathKind;
  allowedExtensions?: readonly string[];
  isolatedLibreOfficeProfile?: boolean;
}

const APPLICATION_DEFINITIONS: Readonly<Record<string, DesktopApplicationDefinition>> = {
  writer: {
    executable: '/usr/bin/libreoffice',
    fixedArguments: ['--writer'],
    allowedPathKind: 'file',
    allowedExtensions: ['.odt', '.doc', '.docx', '.rtf', '.txt'],
    isolatedLibreOfficeProfile: true,
  },
  calc: {
    executable: '/usr/bin/libreoffice',
    fixedArguments: ['--calc'],
    allowedPathKind: 'file',
    allowedExtensions: ['.ods', '.xls', '.xlsx', '.csv', '.tsv'],
    isolatedLibreOfficeProfile: true,
  },
  impress: {
    executable: '/usr/bin/libreoffice',
    fixedArguments: ['--impress'],
    allowedPathKind: 'file',
    allowedExtensions: ['.odp', '.ppt', '.pptx'],
    isolatedLibreOfficeProfile: true,
  },
  'text-editor': {
    executable: '/usr/bin/mousepad',
    fixedArguments: [],
    allowedPathKind: 'file',
    allowedExtensions: ['', '.txt', '.md', '.log', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.sh'],
  },
  'file-manager': { executable: '/usr/bin/thunar', fixedArguments: [], allowedPathKind: 'directory' },
};

const BUILTIN_APPLICATIONS_BY_COMPATIBILITY: Readonly<Record<Preset, readonly string[]>> = {
  'file-system': [], browser: [], computer: ['text-editor', 'file-manager'],
  workstation: ['writer', 'calc', 'impress', 'text-editor', 'file-manager'],
};

interface TrackedDesktopApplication {
  applicationId: string;
  application: DesktopApplicationName;
  child: ChildProcess;
  openedAt: string;
  finished: Promise<void>;
  completed: boolean;
  runtimeDirectory?: string;
}

export interface DesktopApplicationManagerOptions {
  root?: string;
  maxApplications?: number;
  definitions?: Readonly<Record<string, DesktopApplicationDefinition>>;
  environment?: NodeJS.ProcessEnv;
  runtimeRoot?: string;
  spawnUid?: number;
  spawnGid?: number;
}

export interface DesktopApplicationRecord {
  applicationId: string;
  application: DesktopApplicationName;
  state: 'running';
  lifecycle: 'desktop_session';
  survivesHumanTakeover: true;
  openedAt: string;
}

export interface AvailableDesktopApplication {
  application: DesktopApplicationName;
  label: string;
  source: 'builtin' | 'user' | 'system';
}

export class DesktopApplicationManager {
  private readonly applications = new Map<string, TrackedDesktopApplication>();
  private readonly builtinApplications: Set<string>;
  private readonly definitions: Readonly<Record<string, DesktopApplicationDefinition>>;
  private readonly supportsApplications: boolean;
  private readonly root: string;
  private readonly maxApplications: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runtimeRoot: string;
  private readonly spawnUid: number | undefined;
  private readonly spawnGid: number | undefined;
  private pendingApplications = 0;

  constructor(compatibility: Preset, options: DesktopApplicationManagerOptions = {}) {
    this.builtinApplications = new Set(BUILTIN_APPLICATIONS_BY_COMPATIBILITY[compatibility]);
    this.supportsApplications = compatibility === 'computer' || compatibility === 'workstation';
    this.definitions = { ...APPLICATION_DEFINITIONS, ...options.definitions };
    this.root = resolve(options.root ?? DEFAULT_ROOT);
    this.maxApplications = options.maxApplications ?? DEFAULT_MAX_APPLICATIONS;
    this.environment = options.environment ?? process.env;
    this.runtimeRoot = resolve(options.runtimeRoot ?? '/tmp/qubicl-desktop-applications');
    this.spawnUid = options.spawnUid;
    this.spawnGid = options.spawnGid;
    if ((this.spawnUid === undefined) !== (this.spawnGid === undefined)) throw new Error('spawnUid and spawnGid must be provided together.');
    if (!Number.isInteger(this.maxApplications) || this.maxApplications < 1 || this.maxApplications > 32) {
      throw new Error('maxApplications must be an integer from 1 to 32.');
    }
  }

  async open(application: DesktopApplicationName, requestedPaths: readonly string[]): Promise<DesktopApplicationRecord> {
    if (!this.supportsApplications) {
      throw new QubiclError('desktop_application_unsupported', 'This computer does not provide managed desktop applications.', 404);
    }
    if (this.applications.size + this.pendingApplications >= this.maxApplications) {
      throw new QubiclError('desktop_application_limit', `This desktop session already has ${this.maxApplications} tracked applications. Close one before opening another.`, 429);
    }
    this.pendingApplications += 1;
    try {
      const definition = this.builtinApplications.has(application)
        ? this.definitions[application]!
        : await installedApplicationDefinition(application, this.root);
      const paths = await Promise.all(requestedPaths.map((path) => this.safeExistingPath(path, definition)));
      const applicationId = randomBytes(12).toString('base64url');
      const runtimeDirectory = definition.isolatedLibreOfficeProfile ? resolve(this.runtimeRoot, applicationId) : undefined;
      const profileArguments = runtimeDirectory
        ? [`-env:UserInstallation=${pathToFileURL(resolve(runtimeDirectory, 'profile')).href}`]
        : [];
      if (runtimeDirectory) {
        const profile = resolve(runtimeDirectory, 'profile');
        const profileUser = resolve(profile, 'user');
        await mkdir(profileUser, { recursive: true, mode: 0o700 });
        try {
          await copyFile(
            '/etc/skel/.config/libreoffice/4/user/registrymodifications.xcu',
            resolve(profileUser, 'registrymodifications.xcu'),
          );
          if (this.spawnUid !== undefined) {
            await Promise.all([
              chown(runtimeDirectory, this.spawnUid, this.spawnGid!),
              chown(profile, this.spawnUid, this.spawnGid!),
              chown(profileUser, this.spawnUid, this.spawnGid!),
              chown(resolve(profileUser, 'registrymodifications.xcu'), this.spawnUid, this.spawnGid!),
            ]);
          }
        } catch (error) {
          await rm(runtimeDirectory, { recursive: true, force: true });
          throw new QubiclError('desktop_application_launch_failed', `The fixed LibreOffice desktop-session profile could not be prepared: ${(error as Error).message}`, 500);
        }
      }
      const child = spawn(definition.executable, [...profileArguments, ...definition.fixedArguments, ...paths], {
        cwd: this.root,
        detached: true,
        env: sanitizedDesktopEnvironment(this.root, this.environment),
        ...(this.spawnUid === undefined ? {} : { uid: this.spawnUid, gid: this.spawnGid }),
        stdio: 'ignore',
      });
      let finish!: () => void;
      const finished = new Promise<void>((resolveFinished) => { finish = resolveFinished; });
      const tracked: TrackedDesktopApplication = {
        applicationId,
        application,
        child,
        openedAt: new Date().toISOString(),
        finished,
        completed: false,
        ...(runtimeDirectory ? { runtimeDirectory } : {}),
      };
      this.applications.set(applicationId, tracked);
      child.once('exit', () => this.complete(tracked, finish));
      const started = new Promise<void>((resolveStarted, reject) => {
        child.once('spawn', resolveStarted);
        child.once('error', (error) => {
          this.complete(tracked, finish);
          if (runtimeDirectory) void rm(runtimeDirectory, { recursive: true, force: true });
          reject(new QubiclError('desktop_application_launch_failed', `Could not launch desktop application ${application}: ${error.message}`, 500));
        });
      });
      await started;
      child.unref();
      if (tracked.completed) {
        throw new QubiclError('desktop_application_launch_failed', `Desktop application ${application} exited during launch.`, 500);
      }
      return publicRecord(tracked);
    } finally {
      this.pendingApplications -= 1;
    }
  }

  list(): DesktopApplicationRecord[] {
    return [...this.applications.values()].filter(({ completed }) => !completed).map(publicRecord);
  }

  async available(): Promise<AvailableDesktopApplication[]> {
    if (!this.supportsApplications) return [];
    return discoverDesktopApplications(this.root, this.builtinApplications, this.definitions);
  }

  async close(applicationId: string, discardUnsavedChanges = false): Promise<{
    applicationId: string;
    application: DesktopApplicationName;
    state: 'closed';
    lifecycle: 'desktop_session';
    forcedKill: boolean;
  }> {
    const tracked = this.applications.get(applicationId);
    if (!tracked || tracked.completed) {
      throw new QubiclError('desktop_application_not_found', `Desktop application ${applicationId} was not found.`, 404);
    }
    if (!discardUnsavedChanges) {
      throw new QubiclError(
        'desktop_application_close_confirmation_required',
        'Closing a desktop application may discard unsaved changes. Retry with discardUnsavedChanges=true after reviewing the visible application.',
        409,
      );
    }
    const forcedKill = await terminateGroup(tracked, GRACEFUL_CLOSE_MS, FORCED_CLOSE_MS);
    this.applications.delete(applicationId);
    if (tracked.runtimeDirectory) await rm(tracked.runtimeDirectory, { recursive: true, force: true });
    return {
      applicationId,
      application: tracked.application,
      state: 'closed',
      lifecycle: 'desktop_session',
      forcedKill,
    };
  }

  count(): number {
    return this.list().length;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.applications.values()].map(async (tracked) => {
      if (!tracked.completed) await terminateGroup(tracked, GRACEFUL_CLOSE_MS, FORCED_CLOSE_MS);
      this.applications.delete(tracked.applicationId);
      if (tracked.runtimeDirectory) await rm(tracked.runtimeDirectory, { recursive: true, force: true });
    }));
  }

  private async safeExistingPath(requested: string, definition: DesktopApplicationDefinition): Promise<string> {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(requested)) {
      throw new QubiclError('desktop_application_path_unsafe', 'Desktop application paths cannot be URLs or URI schemes.', 400);
    }
    const candidate = resolve(this.root, requested);
    if (!isWithinOrEqual(this.root, candidate)) {
      throw new QubiclError('desktop_application_path_unsafe', `Desktop application paths must stay under ${this.root}.`, 400);
    }
    let canonicalRoot: string;
    let canonicalPath: string;
    try {
      [canonicalRoot, canonicalPath] = await Promise.all([realpath(this.root), realpath(candidate)]);
    } catch {
      throw new QubiclError('desktop_application_path_invalid', `Desktop application path ${candidate} must already exist.`, 400);
    }
    if (!isWithinOrEqual(canonicalRoot, canonicalPath)) {
      throw new QubiclError('desktop_application_path_unsafe', `Desktop application paths must resolve under ${this.root}.`, 400);
    }
    const info = await lstat(canonicalPath);
    if ((definition.allowedPathKind === 'file' && !info.isFile())
      || (definition.allowedPathKind === 'directory' && !info.isDirectory())
      || (definition.allowedPathKind === 'either' && !info.isFile() && !info.isDirectory())) {
      throw new QubiclError('desktop_application_path_invalid', `${canonicalPath} is not an allowed ${definition.allowedPathKind} path for this desktop application.`, 400);
    }
    if (definition.allowedExtensions && !definition.allowedExtensions.includes(extname(canonicalPath).toLowerCase())) {
      throw new QubiclError('desktop_application_path_invalid', `${canonicalPath} does not have an allowlisted file extension for this desktop application.`, 400);
    }
    return canonicalPath;
  }

  private complete(tracked: TrackedDesktopApplication, finish: () => void): void {
    if (tracked.completed) return;
    tracked.completed = true;
    if (this.applications.get(tracked.applicationId) === tracked) this.applications.delete(tracked.applicationId);
    if (tracked.runtimeDirectory) void rm(tracked.runtimeDirectory, { recursive: true, force: true });
    finish();
  }
}

async function installedApplicationDefinition(application: string, home: string): Promise<DesktopApplicationDefinition> {
  const allowedDirectories = [resolve(home, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  for (const directory of allowedDirectories) {
    const candidate = resolve(directory, application);
    try {
      await access(candidate, constants.X_OK);
      const executable = await realpath(candidate);
      const info = await lstat(executable);
      if (!info.isFile() || !allowedDirectories.some((root) => isWithinOrEqual(root, executable))) continue;
      return { executable, fixedArguments: [], allowedPathKind: 'either' };
    } catch {
      // Try the next executable directory.
    }
  }
  throw new QubiclError('desktop_application_not_found', `Installed desktop application ${application} was not found.`, 404);
}

async function discoverDesktopApplications(
  home: string,
  builtins: ReadonlySet<string>,
  definitions: Readonly<Record<string, DesktopApplicationDefinition>>,
): Promise<AvailableDesktopApplication[]> {
  const found = new Map<string, AvailableDesktopApplication>();
  for (const application of [...builtins].sort()) {
    if (!definitions[application]) continue;
    found.set(application, { application, label: application, source: 'builtin' });
  }
  const directories = [
    { path: resolve(home, '.local', 'share', 'applications'), source: 'user' as const, confinedTo: home },
    { path: '/usr/local/share/applications', source: 'system' as const },
    { path: '/usr/share/applications', source: 'system' as const },
  ];
  let inspected = 0;
  for (const directory of directories) {
    if (found.size >= 256 || inspected >= 2_048) break;
    try {
      const directoryInfo = await lstat(directory.path);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;
      const canonical = await realpath(directory.path);
      if (directory.confinedTo && !isWithinOrEqual(await realpath(directory.confinedTo), canonical)) continue;
      const names = (await readdir(canonical)).filter((name) => name.endsWith('.desktop')).sort().slice(0, 2_048 - inspected);
      inspected += names.length;
      for (const name of names) {
        if (found.size >= 256) break;
        try {
          const path = resolve(canonical, name);
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) continue;
          const fields = desktopEntryFields(await readFile(path, 'utf8'));
          if (fields.Hidden === 'true' || fields.NoDisplay === 'true' || !fields.Exec) continue;
          const executableToken = desktopExecutableToken(fields.Exec);
          if (!executableToken) continue;
          const application = executableToken.split('/').pop() ?? '';
          if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(application) || found.has(application)) continue;
          await installedApplicationDefinition(application, home);
          const label = (fields.Name ?? application).replaceAll(/[\r\n\t]/gu, ' ').trim().slice(0, 120) || application;
          found.set(application, { application, label, source: directory.source });
        } catch {
          // A disappearing or malformed entry does not hide the rest.
        }
      }
    } catch {
      // Missing, unreadable, or malformed application entries are omitted.
    }
  }
  return [...found.values()].sort((left, right) => left.label.localeCompare(right.label) || left.application.localeCompare(right.application));
}

function desktopEntryFields(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inDesktopEntry = false;
  for (const line of contents.split(/\r?\n/u)) {
    if (line.startsWith('[')) {
      inDesktopEntry = line.trim() === '[Desktop Entry]';
      continue;
    }
    if (!inDesktopEntry || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (['Name', 'Exec', 'Hidden', 'NoDisplay'].includes(key) && result[key] === undefined) result[key] = line.slice(separator + 1);
  }
  return result;
}

function desktopExecutableToken(value: string): string | undefined {
  const trimmed = value.trim();
  const match = /^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+))/u.exec(trimmed);
  const token = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!token || token.includes('%') || token.includes('\0')) return undefined;
  return token.replaceAll(/\\(["\\])/gu, '$1');
}

function publicRecord(tracked: TrackedDesktopApplication): DesktopApplicationRecord {
  return {
    applicationId: tracked.applicationId,
    application: tracked.application,
    state: 'running',
    lifecycle: 'desktop_session',
    survivesHumanTakeover: true,
    openedAt: tracked.openedAt,
  };
}

function sanitizedDesktopEnvironment(root: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const display = typeof source.DISPLAY === 'string' && /^:[0-9]+(?:\.[0-9]+)?$/.test(source.DISPLAY) ? source.DISPLAY : ':0';
  return {
    HOME: root,
    USER: 'qubicl',
    LOGNAME: 'qubicl',
    PATH: `${resolve(root, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`,
    DISPLAY: display,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    XDG_CONFIG_HOME: resolve(root, '.config'),
    XDG_DATA_HOME: resolve(root, '.local/share'),
    XDG_CACHE_HOME: resolve(root, '.cache'),
  };
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const nested = relative(parent, candidate);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

async function terminateGroup(tracked: TrackedDesktopApplication, gracefulMs: number, forcedMs: number): Promise<boolean> {
  if (tracked.completed) return false;
  try { process.kill(-(tracked.child.pid!), 'SIGTERM'); } catch { return false; }
  await Promise.race([tracked.finished, delay(gracefulMs)]);
  if (tracked.completed) return false;
  try { process.kill(-(tracked.child.pid!), 'SIGKILL'); } catch { return false; }
  await Promise.race([tracked.finished, delay(forcedMs)]);
  if (!tracked.completed && processGroupExists(tracked.child.pid)) {
    throw new QubiclError('desktop_application_close_failed', `Could not confirm that desktop application ${tracked.applicationId} closed.`, 500);
  }
  return true;
}

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
