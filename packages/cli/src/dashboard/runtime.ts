import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { IMAGE_CATALOG, ImageIdentitySchema, catalogPlatformForHost, type ImageIdentity } from '@qubicl/core';
import { packagedAssetsPath } from '../assets.js';
import { docker, validateDocker } from '../docker.js';
import { isPrimaryRuntimeRoot, projectName, runtimeNamespace } from '../runtime.js';
import { atomicWrite, loadState, statePaths } from '../state.js';
import { readProtectedJson, writeProtectedJson } from './storage.js';

export interface DashboardExposure {
  bind: string;
  hostname: string;
  port: number;
  allowNetworks: string[];
  certificate: string;
  privateKey: string;
  certificateSha256: string;
  privateKeySha256: string;
  expiresAt: string;
}
export interface DashboardConfiguration {
  schemaVersion: 1;
  installationId: string;
  enabled: boolean;
  desiredRunning: boolean;
  localPort: number;
  assetPort: number;
  image: ImageIdentity;
  assetManifestSha256: string;
  remote?: DashboardExposure;
}
export const DASHBOARD_SERVICE = 'qubicl.dashboard';
export function dashboardConfigPath(root: string): string { return join(root, 'dashboard', 'config.json'); }
export function dashboardComposePath(root: string): string { return join(root, 'dashboard', 'runtime', 'compose.yaml'); }
export function dashboardContainerName(root: string, id: string): string {
  return isPrimaryRuntimeRoot(root) ? DASHBOARD_SERVICE : `${runtimeNamespace(id, root)}.dashboard`;
}
export async function readDashboardConfiguration(root: string): Promise<DashboardConfiguration | undefined> {
  let value: unknown;
  try { value = await readProtectedJson(dashboardConfigPath(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  assertDashboardConfiguration(value);
  const core = await loadState(statePaths(root)).catch(() => undefined);
  if (core && core.config.installationId !== value.installationId) throw new Error('Dashboard installation identity does not match core state.');
  return value;
}
export async function saveDashboardConfiguration(root: string, config: DashboardConfiguration): Promise<void> {
  assertDashboardConfiguration(config);
  await writeProtectedJson(dashboardConfigPath(root), config);
}
export function assertDashboardConfiguration(value: unknown): asserts value is DashboardConfiguration {
  if (!value || typeof value !== 'object') throw new Error('Invalid dashboard configuration.');
  const config = value as DashboardConfiguration;
  if (config.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/u.test(config.installationId)
    || typeof config.enabled !== 'boolean' || typeof config.desiredRunning !== 'boolean'
    || ![config.localPort, config.assetPort].every((port) => Number.isInteger(port) && port > 1023 && port <= 65535)
    || config.localPort === config.assetPort || !/^[a-f0-9]{64}$/u.test(config.assetManifestSha256)
    || !config.image || typeof config.image.requested !== 'string' || typeof config.image.resolved !== 'string') throw new Error('Invalid dashboard configuration.');
  ImageIdentitySchema.parse(config.image);
  const allowed = new Set(['schemaVersion', 'installationId', 'enabled', 'desiredRunning', 'localPort', 'assetPort', 'image', 'assetManifestSha256', 'remote']);
  if (Object.keys(config).some((key) => !allowed.has(key))) throw new Error('Unknown dashboard configuration field.');
}
export function renderDashboardCompose(root: string, config: DashboardConfiguration): Record<string, unknown> {
  return {
    name: projectName(config.installationId, root),
    services: {
      [DASHBOARD_SERVICE]: {
        image: config.image.contentId ?? config.image.resolved, pull_policy: 'never',
        container_name: dashboardContainerName(root, config.installationId),
        user: '1000:1000', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
        cpus: 0.25, mem_limit: '96m', pids_limit: 32, restart: 'no',
        ports: [`127.0.0.1:${config.assetPort}:3213`], networks: ['dashboard_assets'],
        labels: {
          'dev.qubicl.installation': config.installationId, 'dev.qubicl.role': 'dashboard',
          'dev.qubicl.dashboard-protocol-version': '1', 'dev.qubicl.asset-manifest-sha256': config.assetManifestSha256,
        },
      },
    },
    networks: { dashboard_assets: { name: `${runtimeNamespace(config.installationId, root)}-dashboard-assets`, driver: 'bridge' } },
  };
}
export async function dashboardCatalogIdentity(): Promise<{ image: ImageIdentity; assetManifestSha256: string }> {
  const platform = catalogPlatformForHost(IMAGE_CATALOG);
  const catalog = IMAGE_CATALOG.dashboard;
  const target = catalog.image.platforms[platform];
  if (!target) throw new Error('No dashboard image is available for this Docker platform.');
  let digest = catalog.assetManifestSha256;
  if (IMAGE_CATALOG.development && /^0+$/u.test(digest)) {
    digest = createHash('sha256').update(await readFile(join(packagedAssetsPath(), 'dashboard', 'asset-manifest.json'))).digest('hex');
  }
  return { image: { requested: catalog.image.requested, resolved: target.resolved }, assetManifestSha256: digest };
}
export async function acquireDashboardImage(root: string, config: DashboardConfiguration, offline = false): Promise<void> {
  config.image.contentId = await verifiedDashboardImageContentId(config, offline);
  await saveDashboardConfiguration(root, config);
}
async function verifiedDashboardImageContentId(config: DashboardConfiguration, offline: boolean): Promise<string> {
  await validateDocker();
  let raw = await docker(['image', 'inspect', config.image.resolved], { allowFailure: true });
  if (!raw) {
    if (offline || IMAGE_CATALOG.development) throw new Error('Exact dashboard image is unavailable. Build the development dashboard image or obtain the released image explicitly.');
    await docker(['pull', config.image.resolved]);
    raw = await docker(['image', 'inspect', config.image.resolved]);
  }
  const info = (JSON.parse(raw) as Array<{ Id: string; Config: { Labels?: Record<string, string> } }>)[0];
  const labels = info?.Config?.Labels ?? {};
  if (!info?.Id || labels['dev.qubicl.dashboard-protocol-version'] !== '1'
    || labels['dev.qubicl.asset-manifest-sha256'] !== config.assetManifestSha256) throw new Error('Dashboard image does not match its trusted asset contract.');
  return info.Id;
}
export async function assertDashboardRuntime(root: string, config: DashboardConfiguration, requireRunning = false): Promise<boolean> {
  const raw = await docker(['inspect', dashboardContainerName(root, config.installationId)], { allowFailure: true });
  if (!raw) return false;
  return assertDashboardRuntimeInspection((JSON.parse(raw) as unknown[])[0], root, config, requireRunning);
}

export function assertDashboardRuntimeInspection(infoValue: unknown, root: string, config: DashboardConfiguration, requireRunning = false): boolean {
  if (infoValue === undefined) return false;
  const info = infoValue as {
    Id?: unknown;
    Image?: unknown;
    State?: { Running?: unknown };
    Config?: { Labels?: Record<string, string> };
    Mounts?: unknown[];
    NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: unknown; HostPort?: unknown }> | null> | null; Networks?: Record<string, unknown> };
    HostConfig?: {
      ReadonlyRootfs?: unknown;
      CapDrop?: unknown[];
      SecurityOpt?: unknown[];
      Privileged?: unknown;
      PortBindings?: Record<string, Array<{ HostIp?: unknown; HostPort?: unknown }> | null> | null;
    };
  };
  const labels = info?.Config?.Labels ?? {};
  const expectedNetwork = `${runtimeNamespace(config.installationId, root)}-dashboard-assets`;
  const configuredPorts = info?.HostConfig?.PortBindings ?? {};
  const configuredAssetPort = configuredPorts['3213/tcp'];
  const livePorts = info?.NetworkSettings?.Ports ?? {};
  const liveAssetPort = livePorts['3213/tcp'];
  const exactAssetBinding = (bindings: Array<{ HostIp?: unknown; HostPort?: unknown }> | null | undefined): boolean => Boolean(
    bindings && bindings.length === 1
    && bindings[0]!.HostIp === '127.0.0.1'
    && bindings[0]!.HostPort === String(config.assetPort),
  );
  if (!info || typeof info.Id !== 'string' || !info.Id || !config.image.contentId
    || labels['dev.qubicl.installation'] !== config.installationId || labels['dev.qubicl.role'] !== 'dashboard'
    || labels['dev.qubicl.dashboard-protocol-version'] !== '1' || labels['dev.qubicl.asset-manifest-sha256'] !== config.assetManifestSha256
    || labels['com.docker.compose.project'] !== projectName(config.installationId, root)
    || info.Image !== config.image.contentId || !Array.isArray(info.Mounts) || info.Mounts.length || info.HostConfig?.Privileged
    || info.HostConfig?.ReadonlyRootfs !== true || !info.HostConfig?.CapDrop?.some((cap) => typeof cap === 'string' && cap.toUpperCase() === 'ALL')
    || !info.HostConfig?.SecurityOpt?.some((value) => typeof value === 'string' && value.startsWith('no-new-privileges'))
    || !info.NetworkSettings?.Networks || Object.keys(info.NetworkSettings.Networks).some((network) => network !== expectedNetwork)
    || Object.entries(configuredPorts).some(([port, bindings]) => port !== '3213/tcp' && Boolean(bindings?.length))
    || !exactAssetBinding(configuredAssetPort)
    || typeof info.State?.Running !== 'boolean'
    || (info.State.Running && (Object.entries(livePorts).some(([port, bindings]) => port !== '3213/tcp' && Boolean(bindings?.length))
      || !exactAssetBinding(liveAssetPort)))) {
    throw new Error('Dashboard runtime ownership or isolation differs from the reviewed configuration.');
  }
  return !requireRunning || info.State.Running;
}
export async function setDashboardRunning(root: string, running: boolean, recreate = false): Promise<void> {
  const config = await readDashboardConfiguration(root);
  if (!config) return;
  config.desiredRunning = running;
  await saveDashboardConfiguration(root, config);
  await validateDocker();
  const exists = await assertDashboardRuntime(root, config);
  if (!running && !exists) return;
  if (running && !config.image.contentId) throw new Error('Acquire and verify the dashboard image before starting it.');
  await writeDashboardCompose(root, config);
  await docker(['compose', '--project-name', projectName(config.installationId, root), '--file', dashboardComposePath(root), ...(running ? ['up', '--detach', '--no-deps', ...(recreate ? ['--force-recreate'] : []), DASHBOARD_SERVICE] : ['stop', DASHBOARD_SERVICE])]);
  if (running) await requireRunningDashboardRuntime(root, config);
}

/** Explicitly move the dashboard runtime to the exact image embedded in this CLI. */
export interface DashboardCatalogStartRuntime {
  catalogIdentity(): Promise<{ image: ImageIdentity; assetManifestSha256: string }>;
  acquireContentId(root: string, config: DashboardConfiguration, offline: boolean): Promise<string>;
  inspectRuntime: typeof assertDashboardRuntime;
  replaceRuntime(root: string, config: DashboardConfiguration): Promise<void>;
  saveConfiguration(root: string, config: DashboardConfiguration): Promise<void>;
  setRunning(root: string, running: boolean, recreate: boolean): Promise<void>;
  readConfiguration(root: string): Promise<DashboardConfiguration | undefined>;
}

const defaultDashboardCatalogStartRuntime: DashboardCatalogStartRuntime = {
  catalogIdentity: dashboardCatalogIdentity,
  acquireContentId: async (_root, config, offline) => await verifiedDashboardImageContentId(config, offline),
  inspectRuntime: assertDashboardRuntime,
  replaceRuntime: async (root, config) => {
    await writeDashboardCompose(root, config);
    await docker(['compose', '--project-name', projectName(config.installationId, root), '--file', dashboardComposePath(root), 'up', '--detach', '--no-deps', '--force-recreate', DASHBOARD_SERVICE]);
  },
  saveConfiguration: saveDashboardConfiguration,
  setRunning: setDashboardRunning,
  readConfiguration: readDashboardConfiguration,
};

export async function startDashboardAtCurrentCatalog(
  root: string,
  previous: DashboardConfiguration,
  offline = false,
  recreate = false,
  runtime: DashboardCatalogStartRuntime = defaultDashboardCatalogStartRuntime,
): Promise<DashboardConfiguration> {
  const identity = await runtime.catalogIdentity();
  const candidate = dashboardConfigurationAtCatalog(previous, identity);
  candidate.image.contentId = await runtime.acquireContentId(root, candidate, offline);

  let candidateExists = false;
  try {
    candidateExists = await runtime.inspectRuntime(root, candidate);
  } catch (candidateError) {
    // Only replace a conflicting retained container when it still matches the
    // exact previously reviewed dashboard identity.
    if (!await runtime.inspectRuntime(root, previous)) throw candidateError;
  }
  if (!candidateExists) {
    await runtime.replaceRuntime(root, candidate);
    await requireRunningDashboardRuntime(root, candidate, runtime.inspectRuntime);
    // Publish the new trust root only after its runtime is verified. A retry
    // can finish this save if the host exits after successful replacement.
    await runtime.saveConfiguration(root, candidate);
    return candidate;
  }

  await runtime.saveConfiguration(root, candidate);
  await runtime.setRunning(root, true, recreate);
  return (await runtime.readConfiguration(root)) ?? candidate;
}

export async function requireRunningDashboardRuntime(
  root: string,
  config: DashboardConfiguration,
  inspect: typeof assertDashboardRuntime = assertDashboardRuntime,
): Promise<void> {
  if (!await inspect(root, config, true)) throw new Error('Dashboard runtime did not reach its reviewed running state.');
}

export function dashboardConfigurationAtCatalog(
  previous: DashboardConfiguration,
  identity: { image: ImageIdentity; assetManifestSha256: string },
): DashboardConfiguration {
  const candidate: DashboardConfiguration = {
    ...structuredClone(previous),
    desiredRunning: true,
    image: structuredClone(identity.image),
    assetManifestSha256: identity.assetManifestSha256,
  };
  assertDashboardConfiguration(candidate);
  return candidate;
}

async function writeDashboardCompose(root: string, config: DashboardConfiguration): Promise<void> {
  const directory = join(root, 'dashboard', 'runtime');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe dashboard runtime directory.');
  await atomicWrite(dashboardComposePath(root), YAML.stringify(renderDashboardCompose(root, config)), 0o600);
}
