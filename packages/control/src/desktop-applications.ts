import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopApplicationName, Preset } from '@qubicl/core';
import { QubiclError } from './errors.js';

const DEFAULT_ROOT = '/home/qubicl';
const DEFAULT_MAX_APPLICATIONS = 8;
const GRACEFUL_CLOSE_MS = 1_500;
const FORCED_CLOSE_MS = 500;

type AllowedPathKind = 'file' | 'directory';

export interface DesktopApplicationDefinition {
  executable: string;
  fixedArguments: readonly string[];
  allowedPathKind: AllowedPathKind;
  allowedExtensions?: readonly string[];
  isolatedLibreOfficeProfile?: boolean;
}

const APPLICATION_DEFINITIONS: Readonly<Record<DesktopApplicationName, DesktopApplicationDefinition>> = {
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

const APPLICATIONS_BY_COMPATIBILITY: Readonly<Record<Preset, readonly DesktopApplicationName[]>> = {
  'file-system': [],
  browser: [],
  computer: ['text-editor', 'file-manager'],
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
  definitions?: Partial<Record<DesktopApplicationName, DesktopApplicationDefinition>>;
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

export class DesktopApplicationManager {
  private readonly applications = new Map<string, TrackedDesktopApplication>();
  private readonly allowedApplications: Set<DesktopApplicationName>;
  private readonly definitions: Readonly<Record<DesktopApplicationName, DesktopApplicationDefinition>>;
  private readonly root: string;
  private readonly maxApplications: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runtimeRoot: string;
  private readonly spawnUid: number | undefined;
  private readonly spawnGid: number | undefined;

  constructor(compatibility: Preset, options: DesktopApplicationManagerOptions = {}) {
    this.allowedApplications = new Set(APPLICATIONS_BY_COMPATIBILITY[compatibility]);
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
    if (!this.allowedApplications.has(application)) {
      throw new QubiclError('desktop_application_unsupported', `Desktop application ${application} is not available for this computer's compatibility contract.`, 404);
    }
    if (this.applications.size >= this.maxApplications) {
      throw new QubiclError('desktop_application_limit', `This desktop session already has ${this.maxApplications} tracked applications. Close one before opening another.`, 429);
    }
    const definition = this.definitions[application];
    const paths = await Promise.all(requestedPaths.map((path) => this.safeExistingPath(path, definition)));
    const applicationId = randomBytes(12).toString('base64url');
    const runtimeDirectory = definition.isolatedLibreOfficeProfile ? resolve(this.runtimeRoot, applicationId) : undefined;
    const profileArguments = runtimeDirectory
      ? [`-env:UserInstallation=${pathToFileURL(resolve(runtimeDirectory, 'profile')).href}`]
      : [];
    if (runtimeDirectory) {
      const profileUser = resolve(runtimeDirectory, 'profile/user');
      await mkdir(profileUser, { recursive: true, mode: 0o700 });
      try {
        await copyFile(
          '/etc/skel/.config/libreoffice/4/user/registrymodifications.xcu',
          resolve(profileUser, 'registrymodifications.xcu'),
        );
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
  }

  list(): DesktopApplicationRecord[] {
    return [...this.applications.values()].filter(({ completed }) => !completed).map(publicRecord);
  }

  async close(applicationId: string): Promise<{
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
    if ((definition.allowedPathKind === 'file' && !info.isFile()) || (definition.allowedPathKind === 'directory' && !info.isDirectory())) {
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
    PATH: '/usr/local/bin:/usr/bin:/bin',
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
