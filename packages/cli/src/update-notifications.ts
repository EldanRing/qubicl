import { lstat, readFile } from 'node:fs/promises';
import {
  IMAGE_CATALOG,
  type DockerPlatform,
  type ImageCatalog,
  type QubiclConfig,
} from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag } from './args.js';
import { buildLifecycleUpdateStatus } from './lifecycle-update.js';
import { atomicWrite, loadState, statePaths, type StatePaths } from './state.js';

export interface LocalPreferences {
  version: 1;
  updateNotifications: boolean;
}

export const DEFAULT_LOCAL_PREFERENCES: LocalPreferences = {
  version: 1,
  updateNotifications: false,
};

export async function readLocalPreferences(paths: StatePaths = statePaths()): Promise<LocalPreferences> {
  let contents: string;
  try {
    const info = await lstat(paths.preferences);
    if (!info.isFile()) throw new Error(`Local preferences ${paths.preferences} must be a regular file.`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`Local preferences ${paths.preferences} must have mode 0600.`);
    contents = await readFile(paths.preferences, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_LOCAL_PREFERENCES);
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (error) { throw new Error(`Local preferences ${paths.preferences} contain invalid JSON.`, { cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Local preferences must be an object.');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.updateNotifications !== 'boolean'
    || Object.keys(record).some((key) => key !== 'version' && key !== 'updateNotifications')) {
    throw new Error('Local preferences use an unsupported schema or contain unknown fields.');
  }
  return { version: 1, updateNotifications: record.updateNotifications };
}

export async function writeUpdateNotificationPreference(
  enabled: boolean,
  paths: StatePaths = statePaths(),
): Promise<LocalPreferences> {
  const preferences: LocalPreferences = { version: 1, updateNotifications: enabled };
  await atomicWrite(paths.preferences, `${JSON.stringify(preferences, null, 2)}\n`, 0o600);
  return preferences;
}

export function parseUpdateNotificationPreference(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error('--update-notifications must be on or off.');
}

export function localUpdateNotification(
  config: QubiclConfig,
  preferences: LocalPreferences,
  catalog: ImageCatalog,
  platform: DockerPlatform,
): string | undefined {
  if (!preferences.updateNotifications) return undefined;
  const status = buildLifecycleUpdateStatus(config, catalog, platform);
  const updates = status.rows.filter(({ automatic, updateAvailable }) => automatic && updateAvailable === true);
  if (updates.length === 0) return undefined;
  const gateways = updates.filter(({ kind }) => kind === 'gateway').length;
  const defaults = updates.filter(({ kind }) => kind === 'default').length;
  const computers = updates.filter(({ kind }) => kind === 'computer').length;
  const counts = [
    gateways ? `${gateways} gateway` : '',
    defaults ? `${defaults} configured default` : '',
    computers ? `${computers} computer${computers === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');
  return `Qubicl local update notice: bundled catalog ${catalog.releaseVersion} (${catalog.revision}) has exact targets for ${counts}. Run qubicl status, then qubicl upgrade --all. No network check, telemetry, pull, or automatic mutation was performed.`;
}

const NOTIFICATION_EXCLUDED_COMMANDS = new Set([
  'help', 'version', 'setup', 'config', 'upgrade', 'status', 'connect', 'mcp', 'image', 'doctor',
]);

export function shouldEmitLocalUpdateNotification(command: string | undefined, args: ParsedArgs): boolean {
  return Boolean(command)
    && !NOTIFICATION_EXCLUDED_COMMANDS.has(command!)
    && !flag(args, 'json')
    && !flag(args, 'help');
}

export interface LocalUpdateNotificationDependencies {
  paths?: StatePaths;
  readPreferences?: (paths: StatePaths) => Promise<LocalPreferences>;
  loadConfig?: (paths: StatePaths) => Promise<QubiclConfig>;
  catalog?: ImageCatalog;
  platform?: DockerPlatform;
  hostArchitecture?: string;
  write?: (message: string) => void;
}

export function localNotificationPlatformForHost(
  catalog: ImageCatalog,
  hostArchitecture: string = process.arch,
): DockerPlatform | undefined {
  const architecture = hostArchitecture === 'x64'
    ? 'amd64'
    : hostArchitecture === 'arm64'
      ? 'arm64'
      : undefined;
  if (!architecture) return undefined;
  const platform: DockerPlatform = `linux/${architecture}`;
  return catalog.supportedPlatforms.includes(platform) ? platform : undefined;
}

export async function maybePrintLocalUpdateNotification(
  command: string | undefined,
  args: ParsedArgs,
  dependencies: LocalUpdateNotificationDependencies = {},
): Promise<void> {
  if (!shouldEmitLocalUpdateNotification(command, args)) return;
  try {
    const paths = dependencies.paths ?? statePaths();
    const preferences = await (dependencies.readPreferences ?? readLocalPreferences)(paths);
    if (!preferences.updateNotifications) return;
    const catalog = dependencies.catalog ?? IMAGE_CATALOG;
    const platform = dependencies.platform
      ?? localNotificationPlatformForHost(catalog, dependencies.hostArchitecture);
    if (!platform) return;
    const config = await (dependencies.loadConfig ?? (async (target) => (await loadState(target)).config))(paths);
    const message = localUpdateNotification(config, preferences, catalog, platform);
    if (message) (dependencies.write ?? console.error)(message);
  } catch {
    // Notifications are optional and must never prevent the requested command.
    // Explicit config show/set paths still read and validate this document strictly.
  }
}
