import { nativeDesktop } from './desktop-native.js';
import { WORKSTATION_APPLICATION_CAPABILITIES } from './workstation-applications.js';
import { randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, chown, copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DesktopApplicationName, Preset } from '@qubicl/core';
import { workloadPath, workloadEnvironment } from './environments.js';
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
  reusesExistingProcess?: boolean;
  workingDirectory?: string;
  launcher?: { path: string; name: string; icon?: string; arguments: string[] };
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
    reusesExistingProcess: true,
    fixedArguments: [],
    allowedPathKind: 'file',
    allowedExtensions: ['', '.txt', '.md', '.log', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.sh'],
  },
  gimp: { executable: '/usr/bin/gimp', fixedArguments: [], allowedPathKind: 'file' },
  inkscape: { executable: '/usr/bin/inkscape', fixedArguments: [], allowedPathKind: 'file' },
  blender: { executable: '/usr/bin/blender', fixedArguments: [], allowedPathKind: 'file' },
  freecad: { executable: '/usr/bin/freecad', fixedArguments: [], allowedPathKind: 'file' },
  kdenlive: { executable: '/usr/bin/kdenlive', fixedArguments: [], allowedPathKind: 'file' },
  'file-manager': { reusesExistingProcess: true, executable: '/usr/bin/thunar', fixedArguments: [], allowedPathKind: 'directory' },
};

const BUILTIN_APPLICATIONS_BY_COMPATIBILITY: Readonly<Record<Preset, readonly string[]>> = {
  'file-system': [], browser: [], computer: ['text-editor', 'file-manager'],
  workstation: ['writer', 'calc', 'impress', 'text-editor', 'file-manager', 'gimp', 'inkscape', 'blender', 'freecad', 'kdenlive'],
};

interface TrackedDesktopApplication {
  applicationId: string;
  application: DesktopApplicationName;
  executable: string;
  child: ChildProcess;
  openedAt: string;
  finished: Promise<void>;
  completed: boolean;
  runtimeDirectory?: string;
  reuseCandidateId?: string;
}

export interface DesktopApplicationManagerOptions {
  root?: string;
  maxApplications?: number;
  definitions?: Readonly<Record<string, DesktopApplicationDefinition>>;
  environment?: NodeJS.ProcessEnv;
  runtimeRoot?: string;
  spawnUid?: number;
  spawnGid?: number;
  requestClose?: (pid: number) => Promise<Record<string, unknown>>;
}

export interface DesktopApplicationRecord {
  pid?: number;
  aliases?: string[];
  disposition?: 'started' | 'reused';
  applicationId: string;
  application: DesktopApplicationName;
  executable: string;
  state: 'running';
  lifecycle: 'desktop_session';
  survivesHumanTakeover: true;
  openedAt: string;
}

export interface AvailableDesktopApplication {
  application: DesktopApplicationName;
  label: string;
  source: 'builtin' | 'user' | 'system';
  desktopEntryId?: string;
  executable?: string;
  capabilities?: Record<string, unknown>;
}

export class DesktopApplicationManager {
  private readonly applications = new Map<string, TrackedDesktopApplication>();
  private readonly aliases = new Map<string, string>();
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
  private readonly requestClose: (pid: number) => Promise<Record<string, unknown>>;

  constructor(compatibility: Preset, options: DesktopApplicationManagerOptions = {}) {
    this.requestClose = options.requestClose ?? ((pid) => nativeDesktop.closeProcessWindows(pid));
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
    this.pendingApplications += 1;
    try {
      const definition = this.builtinApplications.has(application)
        ? this.definitions[application]!
        : await installedApplicationDefinition(application, this.root);
      const reuseCandidate = definition.reusesExistingProcess ? [...this.applications.values()].find((item) => !item.completed && item.executable === definition.executable) : undefined;
      if (this.applications.size + this.pendingApplications > this.maxApplications && !reuseCandidate) {
        throw new QubiclError('desktop_application_limit', `This desktop session already has ${this.maxApplications} tracked applications. Close one before opening another.`, 429);
      }
      const paths = await Promise.all(requestedPaths.map((path) => this.safeExistingPath(path, definition)));
      const applicationId = randomBytes(12).toString('base64url');
      const runtimeDirectory = definition.isolatedLibreOfficeProfile ? resolve(this.runtimeRoot, applicationId) : undefined;
      const profileArguments = runtimeDirectory
        ? [`-env:UserInstallation=${pathToFileURL(resolve(runtimeDirectory, 'profile')).href}`]
        : [];
      if (runtimeDirectory) {
        const profile = resolve(runtimeDirectory, 'profile');
        const profileUser = resolve(profile, 'user');
        let created = false;
        try {
          // Keep the registry parent owned by the manager, with search-only
          // access for the workload group. Each isolated profile remains 0700.
          await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
          const parent = await lstat(this.runtimeRoot);
          if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()) {
            throw new Error('The managed profile parent must be a directory owned by the runtime user.');
          }
          if (this.spawnUid !== undefined && this.spawnUid !== process.getuid?.()) {
            await chown(this.runtimeRoot, parent.uid, this.spawnGid!);
            await chmod(this.runtimeRoot, 0o710);
          } else await chmod(this.runtimeRoot, 0o700);
          await mkdir(runtimeDirectory, { mode: 0o700 });
          created = true;
          await mkdir(profileUser, { recursive: true, mode: 0o700 });
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
          if (created) await rm(runtimeDirectory, { recursive: true, force: true });
          throw new QubiclError('desktop_application_launch_failed', `The fixed LibreOffice desktop-session profile could not be prepared: ${(error as Error).message}`, 500);
        }
      }
      const child = spawn(definition.executable, [...profileArguments, ...desktopLaunchArguments(definition, paths)], {
        cwd: definition.workingDirectory ?? this.root,
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
        executable: definition.executable,
        child,
        openedAt: new Date().toISOString(),
        finished,
        completed: false,
        ...(reuseCandidate ? { reuseCandidateId: reuseCandidate.applicationId } : {}),
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
      if (reuseCandidate) await Promise.race([finished, delay(250)]);
      const canonical = this.applications.get(this.aliases.get(applicationId) ?? '');
      if (canonical && !canonical.completed) return { ...this.record(canonical), disposition: 'reused' };
      if (tracked.completed) {
        throw new QubiclError('desktop_application_launch_failed', `Desktop application ${application} exited during launch.`, 500);
      }
      return { ...this.record(tracked), disposition: 'started' };
    } finally {
      this.pendingApplications -= 1;
    }
  }

  list(): DesktopApplicationRecord[] {
    return [...this.applications.values()].filter(({ completed }) => !completed).map((tracked) => this.record(tracked));
  }

  async available(): Promise<AvailableDesktopApplication[]> {
    if (!this.supportsApplications) return [];
    return discoverDesktopApplications(this.root, this.builtinApplications, this.definitions);
  }

  async close(applicationId: string, discardUnsavedChanges = false, mode?: 'request' | 'terminate'): Promise<{
    applicationId: string;
    application: DesktopApplicationName;
    state: 'closed' | 'close_requested';
    closeRequest?: Record<string, unknown>;
    lifecycle: 'desktop_session';
    forcedKill: boolean;
  }> {
    applicationId = this.aliases.get(applicationId) ?? applicationId;
    const tracked = this.applications.get(applicationId);
    if (!tracked || tracked.completed) {
      throw new QubiclError('desktop_application_not_found', `Desktop application ${applicationId} was not found.`, 404);
    }
    if ((mode ?? (discardUnsavedChanges ? 'terminate' : 'request')) === 'request') {
      const closeRequest = await this.requestClose(tracked.child.pid!);
      return { applicationId, application: tracked.application, state: 'close_requested', lifecycle: 'desktop_session', forcedKill: false, closeRequest };
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

  private record(tracked: TrackedDesktopApplication): DesktopApplicationRecord {
    return { ...publicRecord(tracked), aliases: [...this.aliases].filter(([, id]) => id === tracked.applicationId).map(([alias]) => alias) };
  }

  private complete(tracked: TrackedDesktopApplication, finish: () => void): void {
    if (tracked.completed) return;
    tracked.completed = true;
    const canonical = tracked.reuseCandidateId ? this.applications.get(tracked.reuseCandidateId) : undefined;
    if (tracked.child.exitCode === 0 && canonical && !canonical.completed) {
      this.aliases.set(tracked.applicationId, canonical.applicationId);
      while (this.aliases.size > 256) this.aliases.delete(this.aliases.keys().next().value!);
    }
    if (this.applications.get(tracked.applicationId) === tracked) this.applications.delete(tracked.applicationId);
    if (tracked.runtimeDirectory) void rm(tracked.runtimeDirectory, { recursive: true, force: true });
    finish();
  }
}

async function installedApplicationDefinition(application: string, home: string): Promise<DesktopApplicationDefinition> {
  if (application.startsWith('desktop:')) {
    const entry = (await desktopEntries(home)).get(application);
    if (!entry) throw new QubiclError('desktop_application_not_found', `Desktop entry ${application} is unavailable or unsupported.`, 404);
    return entry.definition;
  }
  const candidates = isAbsolute(application) ? [application] : workloadPath(home).split(':').map((directory) => resolve(directory, application));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const executable = await realpath(candidate);
      const info = await lstat(executable);
      if (!info.isFile()) continue;
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
  for (const [application, entry] of await desktopEntries(home)) {
    if (found.size >= 256) break;
    found.set(application, { application, label: entry.label, source: entry.source, desktopEntryId: application.slice(8), executable: entry.definition.executable });
  }
  for (const [application, record] of found) {
    const capabilities = WORKSTATION_APPLICATION_CAPABILITIES[application];
    if (capabilities) record.capabilities = { ...capabilities, packageVersion: await packageVersion(capabilities.package) };
  }
  return [...found.values()].sort((left, right) => left.label.localeCompare(right.label) || left.application.localeCompare(right.application));
}

async function packageVersion(name: string): Promise<string | null> {
  return new Promise((resolveVersion) => execFile('/usr/bin/dpkg-query', ['-W', '-f=${Version}', name], { timeout: 2000, maxBuffer: 4096 }, (error, stdout) => resolveVersion(error ? null : stdout.trim())));
}

type DesktopEntry = { label: string; source: 'user' | 'system'; definition: DesktopApplicationDefinition };
async function desktopEntries(home: string): Promise<Map<string, DesktopEntry>> {
  const entries = new Map<string, DesktopEntry>();
  const seen = new Set<string>();
  const directories = [
    { path: resolve(home, '.local/share/applications'), source: 'user' as const, confinedTo: home },
    { path: '/usr/local/share/applications', source: 'system' as const },
    { path: '/usr/share/applications', source: 'system' as const },
  ];
  let inspected = 0;
  for (const directory of directories) {
    try {
      const info = await lstat(directory.path);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const canonical = await realpath(directory.path);
      if (directory.confinedTo && !isWithinOrEqual(await realpath(directory.confinedTo), canonical)) continue;
      const names = (await readdir(canonical)).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._+-]*\.desktop$/u.test(name)).sort();
      for (const name of names) {
        if (++inspected > 2048 || entries.size >= 256) return entries;
        const application = `desktop:${name}`;
        if (seen.has(application)) continue;
        seen.add(application); // A hidden user entry masks the corresponding system entry.
        try {
          const path = resolve(canonical, name);
          const file = await lstat(path);
          if (!file.isFile() || file.isSymbolicLink() || file.size > 65536) continue;
          const fields = desktopEntryFields(await readFile(path, 'utf8'));
          if (fields.Hidden === 'true' || fields.NoDisplay === 'true' || fields.Terminal === 'true' || (fields.Type && fields.Type !== 'Application') || !fields.Exec) continue;
          const tokens = parseDesktopExec(fields.Exec);
          if (!isAbsolute(tokens[0]!) && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(tokens[0]!)) continue;
          const executable = await installedApplicationDefinition(tokens[0]!, home);
          if (fields.TryExec) await installedApplicationDefinition(fields.TryExec, home);
          let workingDirectory: string | undefined;
          if (fields.Path) {
            if (!isAbsolute(fields.Path)) continue;
            workingDirectory = await realpath(fields.Path);
            if (!(await lstat(workingDirectory)).isDirectory()) continue;
          }
          const label = (fields.Name ?? name).replaceAll(/[\r\n\t]/gu, ' ').trim().slice(0, 120) || name;
          const definition = { ...executable, ...(workingDirectory ? { workingDirectory } : {}), launcher: { path, name: label, ...(fields.Icon ? { icon: fields.Icon } : {}), arguments: tokens.slice(1) } };
          desktopLaunchArguments(definition, []); // Reject unsupported/ambiguous field codes during discovery too.
          entries.set(application, { label, source: directory.source, definition });
        } catch { /* Malformed or unavailable entries do not hide other applications. */ }
      }
    } catch { /* Missing application directory. */ }
  }
  return entries;
}

function desktopEntryFields(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inDesktopEntry = false;
  for (const line of contents.split(/\r?\n/u)) {
    if (line.startsWith('[')) { inDesktopEntry = line.trim() === '[Desktop Entry]'; continue; }
    if (!inDesktopEntry || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (['Name', 'Exec', 'Hidden', 'NoDisplay', 'Icon', 'Type', 'Terminal', 'TryExec', 'Path'].includes(key) && result[key] === undefined) result[key] = key === 'Exec' ? line.slice(separator + 1) : unescapeDesktopString(line.slice(separator + 1));
  }
  return result;
}

function unescapeDesktopString(value: string): string {
  return value.replaceAll(/\\([sntr\\])/gu, (_match, escaped: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[escaped]!);
}

export function parseDesktopExec(value: string): string[] {
  // The desktop-entry string escape pass precedes Exec quoting (four slashes encode one literal slash).
  value = unescapeDesktopString(value);
  const tokens: string[] = [];
  let token = '', quoted = false, started = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '\\') {
      const next = value[++index];
      if (next === undefined) throw new QubiclError('desktop_launcher_invalid', 'Trailing escape in desktop launcher.');
      token += next; started = true;
    } else if (character === '"') { quoted = !quoted; started = true; }
    else if (/\s/u.test(character) && !quoted) {
      if (started) tokens.push(token);
      token = ''; started = false;
    } else { token += character; started = true; }
  }
  if (quoted) throw new QubiclError('desktop_launcher_invalid', 'Unterminated quote in desktop launcher.');
  if (started) tokens.push(token);
  if (!tokens[0] || tokens[0].includes('=') || tokens[0].includes('%') || tokens.some((item) => /[\0\r\n]/u.test(item))) throw new QubiclError('desktop_launcher_invalid', 'Invalid desktop launcher command.');
  return tokens;
}

export function desktopLaunchArguments(definition: DesktopApplicationDefinition, paths: readonly string[]): string[] {
  if (!definition.launcher) return [...definition.fixedArguments, ...paths];
  const launcher = definition.launcher;
  const arguments_: string[] = [];
  let fileCodes = 0;
  for (const value of launcher.arguments) {
    if (['%f', '%F', '%u', '%U'].includes(value)) {
      if (++fileCodes > 1) throw new QubiclError('desktop_launcher_invalid', 'Only one file field code is supported.');
      if (['%f', '%u'].includes(value) && paths.length > 1) throw new QubiclError('desktop_launcher_single_file', 'This launcher accepts one file per launch; open another window for additional files.');
      arguments_.push(...paths.map((path) => ['%u', '%U'].includes(value) ? pathToFileURL(path).href : path));
    } else if (['%d', '%D', '%n', '%N', '%v', '%m'].includes(value)) continue;
    else if (value === '%i') { if (launcher.icon) arguments_.push('--icon', launcher.icon); }
    else if (value === '%c') arguments_.push(launcher.name);
    else if (value === '%k') arguments_.push(launcher.path);
    else {
      if (value.replaceAll('%%', '').includes('%')) throw new QubiclError('desktop_launcher_invalid', 'Unsupported or embedded desktop-entry field code.');
      arguments_.push(value.replaceAll('%%', '%'));
    }
  }
  if (paths.length && !fileCodes) throw new QubiclError('desktop_launcher_no_files', 'This desktop entry does not declare file opening; use its executable interface explicitly.');
  return arguments_;
}

function publicRecord(tracked: TrackedDesktopApplication): DesktopApplicationRecord {
  return {
    applicationId: tracked.applicationId,
    ...(tracked.child.pid ? { pid: tracked.child.pid } : {}),
    application: tracked.application,
    executable: tracked.executable,
    state: 'running',
    lifecycle: 'desktop_session',
    survivesHumanTakeover: true,
    openedAt: tracked.openedAt,
  };
}

function sanitizedDesktopEnvironment(root: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const display = typeof source.DISPLAY === 'string' && /^:[0-9]+(?:\.[0-9]+)?$/.test(source.DISPLAY) ? source.DISPLAY : ':0';
  return {
    ...workloadEnvironment(source, root),
    HOME: root,
    USER: 'qubicl',
    LOGNAME: 'qubicl',
    PATH: workloadPath(root),
    VIRTUAL_ENV: resolve(root, '.local/share/qubicl/python/current'),
    npm_config_prefix: resolve(root, '.local'),
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
