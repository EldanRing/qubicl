import { IMAGE_CATALOG, QUBICL_BUILD } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag } from './args.js';
import { buildLifecycleUpdateStatus } from './lifecycle-update.js';
import { operationOutput } from './operation-context.js';
import { loadState } from './state.js';
import { localNotificationPlatformForHost } from './update-notifications.js';

const REGISTRY_LATEST = 'https://registry.npmjs.org/qubicl-cli/latest';
const MAX_REGISTRY_RESPONSE_BYTES = 64 * 1024;

export async function updateCommand(args: ParsedArgs, lookup: () => Promise<RegistryRelease> = discoverLatestRelease): Promise<void> {
  const action = args.positionals[0] ?? 'check';
  if (action !== 'check') throw new Error(`Unknown update action ${action}; use check.`);
  const state = await loadState();
  const platform = localNotificationPlatformForHost(IMAGE_CATALOG);
  const local = platform ? buildLifecycleUpdateStatus(state.config, IMAGE_CATALOG, platform) : undefined;
  let latest: RegistryRelease | undefined;
  let discovery: Record<string, unknown>;
  if (flag(args, 'offline')) {
    discovery = { attempted: false, reason: 'offline-requested', endpoint: REGISTRY_LATEST };
  } else {
    try {
      latest = await lookup();
      discovery = { attempted: true, source: 'npm-registry', endpoint: REGISTRY_LATEST, checkedAt: new Date().toISOString() };
    } catch (error) {
      discovery = { attempted: true, source: 'npm-registry', endpoint: REGISTRY_LATEST, error: (error as Error).message };
    }
  }
  const affected = local?.rows.filter((row) => row.updateAvailable === true).map((row) => ({ kind: row.kind, name: row.name, current: row.currentImage.requested, target: row.exactTarget?.requested ?? null, automatic: row.automatic })) ?? [];
  operationOutput('log', JSON.stringify({
    installedCli: { version: QUBICL_BUILD.version, revision: QUBICL_BUILD.revision },
    bundledCatalog: { version: IMAGE_CATALOG.releaseVersion, revision: IMAGE_CATALOG.revision, matchesInstalledCli: IMAGE_CATALOG.releaseVersion === QUBICL_BUILD.version },
    latestAvailable: latest ? {
      version: latest.version,
      publishedAt: latest.publishedAt,
      newerThanInstalled: compareVersions(latest.version, QUBICL_BUILD.version) > 0,
    } : null,
    discovery,
    localTargets: { platform: platform ?? null, affected },
    upgradeBehavior: {
      canary: 'qubicl upgrade COMPUTER upgrades one selected computer first',
      rollForward: 'qubicl upgrade --all previews exact targets and resumes its recorded transaction after interruption',
      preserved: ['computer ID and name', 'client credentials and operator settings', 'durable home and browser profile', 'running or stopped intent'],
      interrupted: ['ordinary in-memory tasks and open interactive terminals'],
      resumed: ['declared services restart; ordinary task records and retained logs remain without replay'],
      replaced: ['disposable runtime containers and root-filesystem changes'],
    },
  }, null, 2));
}

export interface RegistryRelease { version: string; publishedAt?: string }

export async function discoverLatestRelease(): Promise<RegistryRelease> {
  const response = await fetch(REGISTRY_LATEST, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Update discovery returned HTTP ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_REGISTRY_RESPONSE_BYTES) throw new Error('Update discovery returned an oversized response.');
  let value: unknown;
  try { value = JSON.parse(body.toString('utf8')); }
  catch { throw new Error('Update discovery returned invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Update discovery returned an invalid record.');
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(record.version)) throw new Error('Update discovery returned an invalid version.');
  return { version: record.version };
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number, string] => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value);
    if (!match) return [0, 0, 0, 'invalid'];
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return Number(a[index]) - Number(b[index]);
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3].localeCompare(b[3]);
}
