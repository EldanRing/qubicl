import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { access, chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  IMAGE_CATALOG,
  CONTROL_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_EXTERNAL_CONTAINER_PORT,
  GATEWAY_EXPOSURE_PROTOCOL,
  PRESET_DEFINITIONS,
  QUBICL_BUILD,
  VIEWER_AUTHENTICATION_HEADER_V1,
  deriveInternalServiceKey,
  hashToken,
  managedSshForCompatibility,
  memoryBytes,
  previewHostname,
  toolsForCapabilities,
  viewerForCapabilities,
  type ComputerConfig,
  type ImageIdentity,
  type Preset,
  type RuntimeRoutes,
  type ViewerAuthentication,
} from '@qubicl/core';
import type { LoadedState } from './state.js';
import { atomicWrite, statePaths, writeMountedRuntimeFile } from './state.js';
import { resolvedBrokerDocument } from './broker-secrets.js';
import { packagedAssetsPath } from './assets.js';
import {
  GATEWAY_EXPOSURE_CERTIFICATE_FILE,
  GATEWAY_EXPOSURE_CLIENT_CA_FILE,
  GATEWAY_EXPOSURE_PRIVATE_KEY_FILE,
  GATEWAY_EXPOSURE_RUNTIME_DIRECTORY,
  GATEWAY_EXPOSURE_RUNTIME_DOCUMENT,
  gatewayEndpointSet,
  materializeGatewayExposure,
} from './gateway-access.js';

export const GATEWAY_PIDS_LIMIT = 128;
export const COMPUTER_PIDS_LIMIT = 1024;
export const COMPUTER_RUNTIME_TOPOLOGY_VERSION = '6';
export const LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION = 9;

const LEGACY_PROJECT_NAME = 'qubicl';
const INSTALLATION_FINGERPRINT_LENGTH = 20;
const COMPUTER_FINGERPRINT_LENGTH = 24;
const RUNTIME_IMAGE_CONTRACTS_VERSION = 1;
export const PREVIEW_ACCESS_RUNTIME_DIRECTORY = 'preview-access';
export const PREVIEW_ACCESS_RUNTIME_FILE = 'access.json';
export const PREVIEW_ACCESS_CONTAINER_DIRECTORY = '/run/qubicl/preview-access';
export const PREVIEW_ACCESS_CONTAINER_PATH = `${PREVIEW_ACCESS_CONTAINER_DIRECTORY}/${PREVIEW_ACCESS_RUNTIME_FILE}`;

export const LEGACY_VIEWER_AUTHENTICATION = 'legacy' as const;
export type RuntimeViewerAuthentication = typeof LEGACY_VIEWER_AUTHENTICATION | ViewerAuthentication;

export interface RuntimeImageContract {
  kind: 'gateway' | 'computer';
  contentId: `sha256:${string}`;
  viewerAuthentication: RuntimeViewerAuthentication;
  gatewayProtocolVersion?: number;
  gatewayExposureProtocol?: typeof GATEWAY_EXPOSURE_PROTOCOL;
}

export interface RuntimeImageContractsDocument {
  version: typeof RUNTIME_IMAGE_CONTRACTS_VERSION;
  images: Record<string, RuntimeImageContract>;
}

export function runtimeImageContractsPath(state: LoadedState): string {
  return join(state.paths.runtime, 'image-contracts.json');
}

export async function readRuntimeImageContracts(state: LoadedState): Promise<RuntimeImageContractsDocument> {
  let raw: string;
  try {
    const info = await lstat(runtimeImageContractsPath(state));
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw new Error(`Runtime image contracts ${runtimeImageContractsPath(state)} must be a regular file with mode 0600.`);
    }
    raw = await readFile(runtimeImageContractsPath(state), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: RUNTIME_IMAGE_CONTRACTS_VERSION, images: {} };
    throw error;
  }
  const value = JSON.parse(raw) as { version?: unknown; images?: unknown };
  if (value.version !== RUNTIME_IMAGE_CONTRACTS_VERSION || !value.images || typeof value.images !== 'object' || Array.isArray(value.images)) {
    throw new Error(`Runtime image contracts ${runtimeImageContractsPath(state)} are invalid.`);
  }
  const images: Record<string, RuntimeImageContract> = {};
  for (const [contentId, candidate] of Object.entries(value.images)) {
    const contract = candidate as Partial<RuntimeImageContract> | null;
    const viewerAuthentication = contract?.viewerAuthentication;
    const validComputer = contract?.kind === 'computer'
      && contract.gatewayProtocolVersion === undefined
      && contract.gatewayExposureProtocol === undefined;
    const validGateway = contract?.kind === 'gateway'
      && (viewerAuthentication === LEGACY_VIEWER_AUTHENTICATION
        ? contract.gatewayProtocolVersion === undefined && contract.gatewayExposureProtocol === undefined
        : contract.gatewayProtocolVersion === GATEWAY_PROTOCOL_VERSION
          && (contract.gatewayExposureProtocol === undefined
            || contract.gatewayExposureProtocol === GATEWAY_EXPOSURE_PROTOCOL));
    if (!/^sha256:[a-f0-9]{64}$/u.test(contentId)
      || !contract || contract.contentId !== contentId
      || (contract.kind !== 'gateway' && contract.kind !== 'computer')
      || (viewerAuthentication !== LEGACY_VIEWER_AUTHENTICATION && viewerAuthentication !== VIEWER_AUTHENTICATION_HEADER_V1)
      || (!validComputer && !validGateway)) {
      throw new Error(`Runtime image contract ${JSON.stringify(contentId)} is invalid.`);
    }
    images[contentId] = contract as RuntimeImageContract;
  }
  return { version: RUNTIME_IMAGE_CONTRACTS_VERSION, images };
}

export async function recordRuntimeImageContracts(state: LoadedState, contracts: readonly RuntimeImageContract[]): Promise<void> {
  const document = await readRuntimeImageContracts(state);
  for (const contract of contracts) document.images[contract.contentId] = contract;
  await atomicWrite(runtimeImageContractsPath(state), `${JSON.stringify(document, null, 2)}\n`, 0o600);
}

export async function removeRuntimeImageContractRecords(state: LoadedState, contentIds: readonly string[]): Promise<number> {
  const document = await readRuntimeImageContracts(state);
  let removed = 0;
  for (const contentId of new Set(contentIds)) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(contentId)) throw new Error(`Invalid runtime image-contract record ID ${JSON.stringify(contentId)}.`);
    if (document.images[contentId]) {
      delete document.images[contentId];
      removed += 1;
    }
  }
  if (removed > 0) await atomicWrite(runtimeImageContractsPath(state), `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return removed;
}

function viewerAuthenticationForComputer(
  computer: Pick<ComputerConfig, 'name' | 'capabilities' | 'image'>,
  contracts: RuntimeImageContractsDocument,
): ViewerAuthentication | undefined {
  if (!viewerForCapabilities(computer.capabilities)) return undefined;
  // State migrated from releases that predate content-ID pinning can only use
  // the legacy viewer contract. Image acquisition rejects a hardened viewer
  // until it has been explicitly rebound to an immutable content ID.
  if (!computer.image.contentId) return undefined;
  const contract = contracts.images[computer.image.contentId];
  if (!contract) {
    throw new Error(`Viewer image ${computer.image.resolved} for ${computer.name} has no verified runtime image contract for ${computer.image.contentId}. Reinspect the exact image or retained computer before rendering its runtime.`);
  }
  if (contract.kind !== 'computer') {
    throw new Error(`Viewer image ${computer.image.resolved} for ${computer.name} has a ${contract.kind} runtime image contract for ${computer.image.contentId}. Reinspect the exact computer image or retained computer before rendering its runtime.`);
  }
  return contract.viewerAuthentication === LEGACY_VIEWER_AUTHENTICATION
    ? undefined
    : contract.viewerAuthentication;
}

function httpHealthcheck(port: number, startPeriod: string): Record<string, unknown> {
  return {
    test: [
      'CMD',
      'node',
      '--input-type=module',
      '--eval',
      `const response=await fetch('http://127.0.0.1:${port}/health');if(!response.ok)process.exit(1)`,
    ],
    interval: '5s',
    timeout: '3s',
    retries: 24,
    start_period: startPeriod,
  };
}

export function isPrimaryRuntimeRoot(root: string): boolean {
  return resolve(root) === resolve(join(homedir(), '.qubicl'));
}

export function runtimeNamespace(installationId: string, root = statePaths().root): string {
  if (isPrimaryRuntimeRoot(root)) return LEGACY_PROJECT_NAME;
  const suffix = installationId.replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(suffix)) throw new Error(`Invalid Qubicl installation ID ${JSON.stringify(installationId)}.`);
  // Docker's embedded DNS rejects host labels longer than 63 characters.
  // Keep enough UUID entropy to make collisions negligible while leaving room
  // for the computer fingerprint and the longest resource-name suffix.
  return `${LEGACY_PROJECT_NAME}-${suffix.slice(0, INSTALLATION_FINGERPRINT_LENGTH)}`;
}

export function projectName(installationId: string, root = statePaths().root): string {
  return runtimeNamespace(installationId, root);
}

export function gatewayContainerName(installationId: string, root = statePaths().root): string {
  return isPrimaryRuntimeRoot(root) ? 'gateway' : `${runtimeNamespace(installationId, root)}-gateway`;
}

export function gatewayNetworkName(installationId: string, root = statePaths().root): string {
  return `${runtimeNamespace(installationId, root)}-gateway`;
}

export function serviceName(id: string): string {
  return `computer_${id.replaceAll('-', '')}`;
}

export function computerServiceName(state: LoadedState, computer: { id: string; name: string }): string {
  return isPrimaryRuntimeRoot(state.paths.root) ? computer.name : serviceName(computer.id);
}

export function computerExecutorServiceName(state: LoadedState, computer: { id: string; name: string }): string {
  return `${computerServiceName(state, computer)}-executor`;
}

export function computerSessionServiceName(state: LoadedState, computer: { id: string; name: string }): string {
  return `${computerServiceName(state, computer)}-session`;
}

export function computerEgressServiceName(state: LoadedState, computer: { id: string; name: string }): string {
  return `${computerServiceName(state, computer)}-egress`;
}

export function computerWebServiceName(state: LoadedState, computer: { id: string; name: string }): string {
  return `${computerServiceName(state, computer)}-web`;
}

export function computerSshServiceName(state: LoadedState, computer: { id: string; name: string }): string {
  return `${computerServiceName(state, computer)}-ssh`;
}

export function containerName(installationId: string, id: string, runtimeName?: string, root = statePaths().root): string {
  return runtimeName ?? `${runtimeNamespace(installationId, root)}-${computerFingerprint(id)}`;
}

export function computerContainerName(state: LoadedState, computer: { id: string; name: string; runtimeName?: string | undefined }): string {
  const runtimeName = isPrimaryRuntimeRoot(state.paths.root) ? computer.name : computer.runtimeName;
  return containerName(state.config.installationId, computer.id, runtimeName, state.paths.root);
}

export function computerExecutorContainerName(state: LoadedState, computer: { id: string; name: string; runtimeName?: string | undefined }): string {
  return `${computerContainerName(state, computer)}-executor`;
}

export function computerSessionContainerName(state: LoadedState, computer: { id: string; name: string; runtimeName?: string | undefined }): string {
  return `${computerContainerName(state, computer)}-session`;
}

export function computerEgressContainerName(state: LoadedState, computer: { id: string; name: string; runtimeName?: string | undefined }): string {
  return `${computerContainerName(state, computer)}-egress`;
}

export function computerWebContainerName(state: LoadedState, computer: { id: string; name: string; runtimeName?: string | undefined }): string {
  return `${computerContainerName(state, computer)}-web`;
}

export function computerSshContainerName(state: LoadedState, computer: { id: string; name: string; runtimeName?: string | undefined }): string {
  return `${computerContainerName(state, computer)}-ssh`;
}

export function computerRuntimeContainerNames(state: LoadedState, computer: { id: string; name: string; runtimeName?: string | undefined; capabilities?: readonly string[]; controlProtocolVersion?: number | undefined; ssh?: { enabled?: boolean } | undefined }): string[] {
  if (usesUnifiedComputerRuntime(computer)) return [computerContainerName(state, computer)];
  return [
    computerContainerName(state, computer),
    computerExecutorContainerName(state, computer),
    computerEgressContainerName(state, computer),
    ...(computer.controlProtocolVersion === LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION ? [computerWebContainerName(state, computer)] : []),
    ...((computer.capabilities ?? []).includes('viewer') ? [computerSessionContainerName(state, computer)] : []),
    ...(computer.ssh?.enabled ? [computerSshContainerName(state, computer)] : []),
  ];
}

export function usesUnifiedComputerRuntime(computer: { controlProtocolVersion?: number | undefined }): boolean {
  return computer.controlProtocolVersion === CONTROL_PROTOCOL_VERSION;
}

export function readableContainerName(installationId: string, id: string, computerName: string, root = statePaths().root): string {
  if (isPrimaryRuntimeRoot(root)) return computerName;
  const installation = installationId.replaceAll('-', '').toLowerCase();
  const computer = id.replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(installation)) throw new Error(`Invalid Qubicl installation ID ${JSON.stringify(installationId)}.`);
  if (!/^[a-f0-9]{32}$/.test(computer)) throw new Error(`Invalid Qubicl computer ID ${JSON.stringify(id)}.`);
  const suffix = `-${computer.slice(0, 8)}-${installation.slice(0, 8)}`;
  const readable = computerName.slice(0, 63 - 'qubicl-'.length - suffix.length).replace(/[.-]+$/u, '');
  return `qubicl-${readable}${suffix}`;
}

export function controlNetwork(installationId: string, id: string, root = statePaths().root): string {
  return `${runtimeNamespace(installationId, root)}-${computerFingerprint(id)}-control`;
}

export function workspaceNetwork(installationId: string, id: string, root = statePaths().root): string {
  return `${runtimeNamespace(installationId, root)}-${computerFingerprint(id)}-workspace`;
}

export function displaySocketVolume(installationId: string, id: string, root = statePaths().root): string {
  return `${runtimeNamespace(installationId, root)}-${computerFingerprint(id)}-x11`;
}

function computerFingerprint(id: string): string {
  const suffix = id.replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(suffix)) throw new Error(`Invalid Qubicl computer ID ${JSON.stringify(id)}.`);
  return suffix.slice(0, COMPUTER_FINGERPRINT_LENGTH);
}

export function hostIdentity(): { uid: number; gid: number } {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  if (uid === 0) throw new Error('Qubicl must run as your normal host user, not root. Running as root would put durable state under the wrong account and weaken gateway isolation.');
  return { uid, gid };
}

export function computerResourceEnvelope(computer: { cpus: number; memory: string; compatibility: Preset; capabilities: readonly string[]; controlProtocolVersion?: number | undefined; ssh?: { enabled?: boolean } | undefined }): Record<string, unknown> {
  if (usesUnifiedComputerRuntime(computer)) {
    const boundary = { cpus: computer.cpus, memoryBytes: memoryBytes(computer.memory), pids: PRESET_DEFINITIONS[computer.compatibility].pidsLimit };
    return {
      workload: { cpus: computer.cpus, memory: computer.memory, pids: boundary.pids },
      sidecarOverhead: { cpus: 0, memoryBytes: 0, pids: 0 },
      maximum: boundary,
      note: 'The controller, tools, browser/desktop session, and optional SSH share one enforceable computer-container boundary.',
    };
  }
  const viewer = computer.capabilities.includes('viewer'); const ssh = computer.ssh?.enabled === true;
  const overheadMemory = memoryBytes('256m') + memoryBytes('128m') + memoryBytes('256m') + (viewer ? memoryBytes('2g') : 0) + (ssh ? memoryBytes('512m') : 0);
  const overheadCpu = 0.75 + (viewer ? 1 : 0) + (ssh ? 0.5 : 0);
  const overheadPids = 128 + 64 + 64 + (viewer ? PRESET_DEFINITIONS[computer.compatibility].pidsLimit : 0) + (ssh ? 256 : 0);
  return {
    workload: { cpus: computer.cpus, memory: computer.memory, pids: PRESET_DEFINITIONS[computer.compatibility].pidsLimit },
    sidecarOverhead: { cpus: overheadCpu, memoryBytes: overheadMemory, pids: overheadPids },
    maximum: { cpus: computer.cpus + overheadCpu, memoryBytes: memoryBytes(computer.memory) + overheadMemory, pids: PRESET_DEFINITIONS[computer.compatibility].pidsLimit + overheadPids },
    note: 'Limits are per container; maximum is the sum of enforceable ceilings, not a reservation.',
  };
}

/**
 * Source builds use mutable development tags, but configured computers remain
 * pinned to the exact image they were created with. Prefer their recorded
 * content ID when Docker still exposes it. A running/stopped container may
 * retain a runnable snapshot without keeping this image ID inspectable, so
 * callers must not assume this reference can recreate the container.
 */
export function runtimeImageReference(
  identity: ImageIdentity,
  kind: 'gateway' | 'computer',
  compatibility?: Preset,
): string {
  if (!IMAGE_CATALOG.development || !identity.contentId) return identity.resolved;
  if (kind === 'gateway' && identity.requested === IMAGE_CATALOG.gateway.requested) return identity.contentId;
  if (kind === 'computer' && compatibility
    && identity.requested === IMAGE_CATALOG.presets[compatibility].image.requested) return identity.contentId;
  // v1/v2 source installations used one workstation image name.
  if (kind === 'computer' && compatibility === 'workstation' && identity.requested === 'qubicl/computer:dev') return identity.contentId;
  return identity.resolved;
}

export async function renderRuntime(state: LoadedState): Promise<void> {
  await materializeGatewayExposure(state);
  const { uid: hostUid, gid: hostGid } = hostIdentity();
  const installationId = state.config.installationId;
  const gatewayAuditVolumes: Array<Record<string, unknown>> = [];
  const imageContracts = await readRuntimeImageContracts(state);
  const routes: RuntimeRoutes = {
    version: 2,
    generatedAt: new Date().toISOString(),
    routes: state.config.computers.map((computer) => {
      const secret = state.secrets.computers[computer.id];
      if (!secret) throw new Error(`Missing secret material for ${computer.name}.`);
      const viewer = viewerForCapabilities(computer.capabilities);
      const viewerAuthentication = viewerAuthenticationForComputer(computer, imageContracts);
      return {
        id: computer.id,
        name: computer.name,
        host: computerContainerName(state, computer),
        ...(viewer ? { viewHost: usesUnifiedComputerRuntime(computer) ? computerContainerName(state, computer) : computerSessionContainerName(state, computer) } : {}),
        controlPort: 3212,
        ...(viewer ? { viewPort: 6080, controlViewPort: 6081 } : {}),
        ...(viewerAuthentication ? { viewerAuthentication } : {}),
        preset: computer.preset,
        compatibility: computer.compatibility,
        capabilities: computer.capabilities,
        manifestSha256: computer.image.manifestSha256!,
        tokenHash: hashToken(secret.token),
        internalKey: secret.internalKey,
        networkPolicy: computer.network ?? { profile: 'developer', allowDomains: [], denyDomains: [], temporaryApprovals: [] },
      };
    }),
  };

  const services: Record<string, unknown> = {
    gateway: {
      image: runtimeImageReference(state.config.gateway.image, 'gateway'),
      // Acquisition and contract inspection happen before runtime mutation;
      // Compose must never bypass that trust boundary with an implicit pull.
      pull_policy: 'never',
      container_name: gatewayContainerName(installationId, state.paths.root),
      user: `${hostUid}:${hostGid}`,
      restart: 'unless-stopped',
      environment: {
        QUBICL_GATEWAY_PORT: '3211',
        QUBICL_ROUTES_PATH: '/runtime/routes.json',
        ...(state.config.gateway.exposure ? {
          QUBICL_GATEWAY_EXTERNAL_PORT: `${GATEWAY_EXTERNAL_CONTAINER_PORT}`,
          QUBICL_GATEWAY_EXPOSURE_CONFIG_PATH: `/runtime/${GATEWAY_EXPOSURE_RUNTIME_DIRECTORY}/${GATEWAY_EXPOSURE_RUNTIME_DOCUMENT}`,
          QUBICL_GATEWAY_TLS_CERT_PATH: `/runtime/${GATEWAY_EXPOSURE_RUNTIME_DIRECTORY}/${GATEWAY_EXPOSURE_CERTIFICATE_FILE}`,
          QUBICL_GATEWAY_TLS_KEY_PATH: `/runtime/${GATEWAY_EXPOSURE_RUNTIME_DIRECTORY}/${GATEWAY_EXPOSURE_PRIVATE_KEY_FILE}`,
          ...(state.config.gateway.exposure.tls.clientCertificateAuthoritySha256 ? {
            QUBICL_GATEWAY_TLS_CLIENT_CA_PATH: `/runtime/${GATEWAY_EXPOSURE_RUNTIME_DIRECTORY}/${GATEWAY_EXPOSURE_CLIENT_CA_FILE}`,
          } : {}),
        } : {}),
      },
      ports: [
        `127.0.0.1:${state.config.gateway.port}:3211`,
        ...(state.config.gateway.exposure ? [{
          target: GATEWAY_EXTERNAL_CONTAINER_PORT,
          published: `${state.config.gateway.exposure.port}`,
          host_ip: state.config.gateway.exposure.bindAddress,
          protocol: 'tcp',
        }] : []),
      ],
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      pids_limit: GATEWAY_PIDS_LIMIT,
      volumes: gatewayAuditVolumes,
      networks: ['gateway'],
      labels: {
        'dev.qubicl.role': 'gateway',
        'dev.qubicl.installation': installationId,
        'dev.qubicl.version': QUBICL_BUILD.version,
        'dev.qubicl.revision': QUBICL_BUILD.revision,
      },
      healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3211/health').then(r=>{if(!r.ok)process.exit(1)})"], interval: '5s', timeout: '3s', retries: 12 },
    },
  };
  const networks: Record<string, unknown> = {
    gateway: { name: gatewayNetworkName(installationId, state.paths.root), driver: 'bridge' },
  };
  const volumes: Record<string, unknown> = {};
  const brokerDirectory = join(state.paths.runtime, 'brokers');
  const policyDirectory = join(state.paths.runtime, 'policies');
  const previewAccessRoot = join(state.paths.runtime, PREVIEW_ACCESS_RUNTIME_DIRECTORY);
  const chromiumSeccompPath = join(state.paths.runtime, 'chromium-seccomp.json');
  await mkdir(brokerDirectory, { recursive: true, mode: 0o700 });
  await mkdir(policyDirectory, { recursive: true, mode: 0o700 });
  await ensurePrivateRuntimeDirectory(previewAccessRoot);
  if (state.config.computers.some((computer) => computer.capabilities.includes('viewer'))) {
    const profile = await readFile(join(packagedAssetsPath(), 'chromium-seccomp.json'), 'utf8');
    await writeMountedRuntimeFile(chromiumSeccompPath, profile, 0o600);
  }
  gatewayAuditVolumes.push({ type: 'bind', source: state.paths.runtime, target: '/runtime', read_only: true });
  // A stable directory mount survives computer deletion and purge. Individual
  // file binds cannot be restarted once their host-side file is removed.
  gatewayAuditVolumes.push({ type: 'bind', source: state.paths.audits, target: '/audit' });

  for (const computer of state.config.computers) {
    const secret = state.secrets.computers[computer.id]!;
    const policy = PRESET_DEFINITIONS[computer.compatibility];
    const viewerAuthentication = viewerAuthenticationForComputer(computer, imageContracts);
    const viewerKey = viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1
      ? deriveInternalServiceKey(secret.internalKey, 'viewer')
      : undefined;
    const networkKey = `control_${computer.id.replaceAll('-', '')}`;
    const workspaceNetworkKey = `workspace_${computer.id.replaceAll('-', '')}`;
    const executorService = computerExecutorServiceName(state, computer);
    const sessionService = computerSessionServiceName(state, computer);
    const egressService = computerEgressServiceName(state, computer);
    const webService = computerWebServiceName(state, computer);
    const sshService = computerSshServiceName(state, computer);
    const executorKey = deriveInternalServiceKey(secret.internalKey, 'executor');
    const sessionKey = deriveInternalServiceKey(secret.internalKey, 'session');
    const proxyKey = deriveInternalServiceKey(secret.internalKey, 'egress-proxy');
    const brokerKey = deriveInternalServiceKey(secret.internalKey, 'egress-broker');
    const webKey = deriveInternalServiceKey(secret.internalKey, 'web');
    const networkPolicy = computer.network ?? { profile: 'developer', allowDomains: [], denyDomains: [], temporaryApprovals: [] };
    const localPreviewBase = `http://${previewHostname(computer.id)}:${state.config.gateway.port}/computers/${computer.id}/previews`;
    const remotePreviewBase = gatewayEndpointSet(state.config.gateway, computer, 'remote')?.previewBase;
    const previewAccessDirectory = join(previewAccessRoot, computer.id);
    await ensurePrivateRuntimeDirectory(previewAccessDirectory);
    await writeMountedRuntimeFile(
      join(previewAccessDirectory, PREVIEW_ACCESS_RUNTIME_FILE),
      `${JSON.stringify({
        version: 1,
        publicBaseUrl: localPreviewBase,
        ...(remotePreviewBase ? { remoteBaseUrl: remotePreviewBase } : {}),
      }, null, 2)}\n`,
      0o600,
    );
    const unifiedRuntime = usesUnifiedComputerRuntime(computer);
    const webRuntime = unifiedRuntime || computer.controlProtocolVersion === LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION;
    const restrictedNetwork = networkPolicy.profile !== 'developer';
    const egressHost = unifiedRuntime ? gatewayContainerName(installationId, state.paths.root) : egressService;
    const proxyUrl = restrictedNetwork ? `http://qubicl:${proxyKey}@${egressHost}:3128` : undefined;
    const brokerPath = join(brokerDirectory, `${computer.id}.json`);
    await writeMountedRuntimeFile(brokerPath, `${JSON.stringify(await resolvedBrokerDocument(state, computer.id))}\n`, 0o600);
    const policyPath = join(policyDirectory, `${computer.id}.json`);
    const skillRegistryPath = join(state.paths.computers, computer.id, 'home', 'qubicl', '.local', 'share', 'qubicl', 'skills', 'registry.json');
    let skillRegistrySha256 = 'not-initialized';
    try { skillRegistrySha256 = createHash('sha256').update(await readFile(skillRegistryPath)).digest('hex'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const policyBody = {
      version: 1 as const,
      tools: computer.toolPolicy ?? toolsForCapabilities(computer.capabilities),
      catalogSkills: computer.skillPolicy?.enabledCatalogSkills ?? [],
      skillRegistrySha256,
    };
    const policyDocument = { ...policyBody, revision: createHash('sha256').update(JSON.stringify(policyBody)).digest('hex') };
    await writeMountedRuntimeFile(policyPath, `${JSON.stringify(policyDocument, null, 2)}\n`, 0o600);
    const auditPath = unifiedRuntime
      ? join(state.paths.audits, `${computer.id}.jsonl`)
      : join(state.paths.computers, computer.id, 'audit.jsonl');
    try { await access(auditPath); } catch { await atomicWrite(auditPath, '', 0o600); }
    const commonEnvironment: Record<string, string> = {
      QUBICL_ID: computer.id,
      QUBICL_NAME: computer.name,
      QUBICL_HOST_UID: `${hostUid}`,
      QUBICL_HOST_GID: `${hostGid}`,
      QUBICL_STARTUP_PROFILE: policy.startupProfile,
    };
    const environment: Record<string, string> = {
      ...commonEnvironment,
      QUBICL_RUNTIME_ROLE: 'control',
      QUBICL_INTERNAL_KEY: secret.internalKey,
      QUBICL_CONTROL_PORT: '3212',
      QUBICL_EXPECTED_MANIFEST_SHA256: computer.image.manifestSha256!,
      QUBICL_EXECUTOR_URL: `http://${unifiedRuntime ? '127.0.0.1' : executorService}:3213`,
      QUBICL_EXECUTOR_KEY: executorKey,
      QUBICL_EXECUTOR_HOST: unifiedRuntime ? computerContainerName(state, computer) : executorService,
      QUBICL_PUBLIC_PREVIEW_BASE: localPreviewBase,
      QUBICL_PREVIEW_ACCESS_PATH: PREVIEW_ACCESS_CONTAINER_PATH,
      QUBICL_INTERNAL_PREVIEW_BASE: `http://${gatewayContainerName(installationId, state.paths.root)}:3211/computers/${computer.id}/previews`,
      QUBICL_BROKER_URL: `http://${egressHost}:3128`,
      QUBICL_BROKER_KEY: brokerKey,
      ...(webRuntime ? { QUBICL_WEB_URL: `http://${unifiedRuntime ? '127.0.0.1' : webService}:3215`, QUBICL_WEB_KEY: webKey } : {}),
      QUBICL_AUDIT_PATH: '/run/qubicl/audit.jsonl',
      QUBICL_RESOURCE_ENVELOPE_JSON: JSON.stringify(computerResourceEnvelope(computer)),
      QUBICL_POLICY_PATH: '/run/qubicl/policy.json',
      ...(policy.viewer ? {
        QUBICL_SESSION_URL: `http://${unifiedRuntime ? '127.0.0.1' : sessionService}:3214`,
        QUBICL_SESSION_KEY: sessionKey,
      } : {}),
    };
    const homeVolume = { type: 'bind', source: join(state.paths.computers, computer.id, 'home'), target: '/home' };
    const displayVolumeKey = `display_${computer.id.replaceAll('-', '')}`;
    if (policy.viewer && !unifiedRuntime) volumes[displayVolumeKey] = { name: displaySocketVolume(installationId, computer.id, state.paths.root) };
    if (unifiedRuntime) {
      services[computerServiceName(state, computer)] = {
        image: runtimeImageReference(computer.image, 'computer', computer.compatibility),
        pull_policy: 'never',
        container_name: computerContainerName(state, computer),
        hostname: computer.name,
        restart: 'unless-stopped',
        environment: {
          ...environment,
          QUBICL_RUNTIME_ROLE: 'computer',
          QUBICL_COMPATIBILITY: computer.compatibility,
          QUBICL_WEB_KEY: webKey,
          QUBICL_NETWORK_POLICY: JSON.stringify(networkPolicy),
          QUBICL_BROWSER_EXECUTABLE: '/usr/local/bin/qubicl-chromium',
          QUBICL_INITIALIZE_HOME: '1',
          QUBICL_EXECUTOR_FENCE_UID: '0',
          ...(computer.environment ? { QUBICL_WORKLOAD_ENV_JSON: JSON.stringify(computer.environment) } : {}),
          ...(proxyUrl ? { QUBICL_PROXY_URL: proxyUrl } : {}),
          ...(policy.viewer ? { DISPLAY: ':0', QUBICL_POINTER_URL: 'http://127.0.0.1:3212/_qubicl/session/pointer' } : {}),
          ...(viewerKey ? { QUBICL_VIEWER_AUTHENTICATION: VIEWER_AUTHENTICATION_HEADER_V1, QUBICL_VIEWER_KEY: viewerKey } : {}),
          ...(computer.ssh?.enabled ? { QUBICL_SSH_PUBLIC_KEY: computer.ssh.publicKey } : {}),
        },
        volumes: [
          homeVolume,
          { type: 'bind', source: auditPath, target: '/run/qubicl/audit.jsonl' },
          { type: 'bind', source: policyPath, target: '/run/qubicl/policy.json', read_only: true },
          { type: 'bind', source: previewAccessDirectory, target: PREVIEW_ACCESS_CONTAINER_DIRECTORY, read_only: true },
        ],
        networks: [networkKey],
        ports: computer.ssh?.enabled ? [`127.0.0.1:${computer.ssh.port}:2222`] : undefined,
        cpus: computer.cpus,
        mem_limit: computer.memory,
        pids_limit: policy.pidsLimit,
        ...(policy.shmSize ? { shm_size: policy.shmSize } : {}),
        privileged: false,
        security_opt: policy.viewer
          ? ['no-new-privileges:true', `seccomp=${chromiumSeccompPath}`]
          : ['no-new-privileges:true'],
        labels: {
          'dev.qubicl.role': 'computer',
          'dev.qubicl.topology-version': COMPUTER_RUNTIME_TOPOLOGY_VERSION,
          'dev.qubicl.installation': installationId,
          'dev.qubicl.id': computer.id,
          'dev.qubicl.name': computer.name,
          'dev.qubicl.version': QUBICL_BUILD.version,
          'dev.qubicl.revision': QUBICL_BUILD.revision,
        },
        healthcheck: httpHealthcheck(3212, policy.viewer ? '20s' : '15s'),
      };
      networks[networkKey] = {
        name: controlNetwork(installationId, computer.id, state.paths.root),
        driver: 'bridge',
        ...(restrictedNetwork ? { internal: true } : {}),
      };
      continue;
    }
    services[computerServiceName(state, computer)] = {
      image: runtimeImageReference(computer.image, 'computer', computer.compatibility),
      // See the gateway comment above. This also makes missing exact images a
      // local, actionable failure rather than an attempted public-registry pull.
      pull_policy: 'never',
      container_name: computerContainerName(state, computer),
      hostname: computer.name,
      restart: 'unless-stopped',
      environment,
      volumes: [
        homeVolume,
        { type: 'bind', source: auditPath, target: '/run/qubicl/audit.jsonl' },
        { type: 'bind', source: policyPath, target: '/run/qubicl/policy.json', read_only: true },
        { type: 'bind', source: previewAccessDirectory, target: PREVIEW_ACCESS_CONTAINER_DIRECTORY, read_only: true },
      ],
      networks: [networkKey, workspaceNetworkKey],
      cpus: 0.25,
      mem_limit: '256m',
      pids_limit: 128,
      depends_on: {
        [executorService]: { condition: 'service_healthy' },
        [egressService]: { condition: 'service_healthy' },
        ...(webRuntime ? { [webService]: { condition: 'service_healthy' } } : {}),
        ...(policy.viewer ? { [sessionService]: { condition: 'service_healthy' } } : {}),
        ...(computer.ssh?.enabled ? { [sshService]: { condition: 'service_healthy' } } : {}),
      },
      privileged: false,
      labels: {
        'dev.qubicl.role': 'computer',
        'dev.qubicl.topology-version': '5',
        'dev.qubicl.installation': installationId,
        'dev.qubicl.id': computer.id,
        'dev.qubicl.name': computer.name,
        'dev.qubicl.version': QUBICL_BUILD.version,
        'dev.qubicl.revision': QUBICL_BUILD.revision,
      },
      healthcheck: httpHealthcheck(3212, '15s'),
    };
    services[executorService] = {
      image: runtimeImageReference(computer.image, 'computer', computer.compatibility),
      pull_policy: 'never',
      container_name: computerExecutorContainerName(state, computer),
      hostname: 'executor',
      restart: 'unless-stopped',
      environment: {
        ...commonEnvironment,
        QUBICL_RUNTIME_ROLE: 'executor',
        QUBICL_RUNNER_KEY: executorKey,
        ...(computer.environment ? { QUBICL_WORKLOAD_ENV_JSON: JSON.stringify(computer.environment) } : {}),
        ...(proxyUrl ? { QUBICL_PROXY_URL: proxyUrl } : {}),
        ...(!policy.viewer ? { QUBICL_INITIALIZE_HOME: '1' } : {}),
      },
      volumes: [homeVolume],
      networks: [workspaceNetworkKey],
      cpus: computer.cpus,
      mem_limit: computer.memory,
      pids_limit: policy.pidsLimit,
      privileged: false,
      labels: {
        'dev.qubicl.role': 'computer-executor',
        'dev.qubicl.installation': installationId,
        'dev.qubicl.computer-id': computer.id,
      },
      healthcheck: httpHealthcheck(3213, '15s'),
    };
    services[egressService] = {
      image: runtimeImageReference(computer.image, 'computer', computer.compatibility),
      pull_policy: 'never',
      container_name: computerEgressContainerName(state, computer),
      hostname: 'egress',
      restart: 'unless-stopped',
      environment: {
        QUBICL_RUNTIME_ROLE: 'egress',
        QUBICL_HOST_UID: `${hostUid}`,
        QUBICL_HOST_GID: `${hostGid}`,
        QUBICL_PROXY_KEY: proxyKey,
        QUBICL_BROKER_KEY: brokerKey,
        QUBICL_NETWORK_POLICY: JSON.stringify(networkPolicy),
        QUBICL_BROKER_PATH: '/run/qubicl/broker.json',
        QUBICL_AUDIT_PATH: '/run/qubicl/audit.jsonl',
      },
      volumes: [
        { type: 'bind', source: brokerPath, target: '/run/qubicl/broker.json', read_only: true },
        { type: 'bind', source: auditPath, target: '/run/qubicl/audit.jsonl' },
      ],
      networks: ['gateway', networkKey, workspaceNetworkKey],
      cpus: 0.25,
      mem_limit: '128m',
      pids_limit: 64,
      read_only: true,
      tmpfs: ['/tmp:rw,noexec,nosuid,size=16m'],
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      labels: {
        'dev.qubicl.role': 'computer-egress',
        'dev.qubicl.installation': installationId,
        'dev.qubicl.computer-id': computer.id,
      },
      healthcheck: httpHealthcheck(3128, '10s'),
    };
    if (webRuntime) services[webService] = {
      image: runtimeImageReference(computer.image, 'computer', computer.compatibility),
      pull_policy: 'never',
      container_name: computerWebContainerName(state, computer),
      hostname: 'web',
      user: `${hostUid}:${hostGid}`,
      restart: 'unless-stopped',
      environment: {
        QUBICL_RUNTIME_ROLE: 'web',
        QUBICL_RUNNER_KEY: webKey,
        QUBICL_NETWORK_POLICY: JSON.stringify(networkPolicy),
        ...(proxyUrl ? { QUBICL_PROXY_URL: proxyUrl } : {}),
      },
      networks: [networkKey, workspaceNetworkKey],
      cpus: 0.25,
      mem_limit: '256m',
      pids_limit: 64,
      read_only: true,
      tmpfs: ['/tmp:rw,noexec,nosuid,size=32m'],
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      depends_on: { [egressService]: { condition: 'service_healthy' } },
      labels: {
        'dev.qubicl.role': 'computer-web',
        'dev.qubicl.installation': installationId,
        'dev.qubicl.computer-id': computer.id,
      },
      healthcheck: httpHealthcheck(3215, '15s'),
    };
    if (policy.viewer) {
      services[sessionService] = {
        image: runtimeImageReference(computer.image, 'computer', computer.compatibility),
        pull_policy: 'never',
        container_name: computerSessionContainerName(state, computer),
        hostname: 'session',
        restart: 'unless-stopped',
        environment: {
          ...commonEnvironment,
          QUBICL_RUNTIME_ROLE: 'session',
          QUBICL_RUNNER_KEY: sessionKey,
          QUBICL_POINTER_URL: `http://${computerServiceName(state, computer)}:3212/_qubicl/session/pointer`,
          QUBICL_BROWSER_EXECUTABLE: '/usr/local/bin/qubicl-chromium',
          QUBICL_COMPATIBILITY: computer.compatibility,
          ...(computer.environment ? { QUBICL_WORKLOAD_ENV_JSON: JSON.stringify(computer.environment) } : {}),
          QUBICL_INITIALIZE_HOME: '1',
          DISPLAY: ':0',
          ...(viewerKey ? { QUBICL_VIEWER_AUTHENTICATION: VIEWER_AUTHENTICATION_HEADER_V1, QUBICL_VIEWER_KEY: viewerKey } : {}),
          ...(proxyUrl ? { QUBICL_PROXY_URL: proxyUrl } : {}),
        },
        volumes: [homeVolume, { type: 'volume', source: displayVolumeKey, target: '/tmp/.X11-unix' }],
        // The session needs the control network for its authenticated runner
        // and the workspace network so the visible browser can reach apps
        // started by the untrusted executor. Restricted profiles keep both
        // networks internal and route external traffic through egress.
        networks: [networkKey, workspaceNetworkKey],
        cpus: 1,
        mem_limit: '2g',
        pids_limit: policy.pidsLimit,
        ...(policy.shmSize ? { shm_size: policy.shmSize } : {}),
        privileged: false,
        // Chromium's user-namespace sandbox needs only the namespace clone and
        // unshare variants admitted by this default-deny profile. The profile
        // is scoped to the retained session; no capability, SYS_ADMIN, host
        // namespace, or unconfined seccomp exception is granted.
        security_opt: ['no-new-privileges:true', `seccomp=${chromiumSeccompPath}`],
        labels: {
          'dev.qubicl.role': 'computer-session',
          'dev.qubicl.installation': installationId,
          'dev.qubicl.computer-id': computer.id,
        },
        healthcheck: httpHealthcheck(3214, '15s'),
      };
    }
    if (computer.ssh?.enabled) {
      if (!managedSshForCompatibility(computer.compatibility)) throw new Error(`SSH access requires computer or workstation compatibility for ${computer.name}.`);
      services[sshService] = {
        image: runtimeImageReference(computer.image, 'computer', computer.compatibility),
        pull_policy: 'never',
        container_name: computerSshContainerName(state, computer),
        hostname: `${computer.name}-ssh`,
        restart: 'unless-stopped',
        environment: {
          QUBICL_RUNTIME_ROLE: 'ssh',
          QUBICL_HOST_UID: `${hostUid}`,
          QUBICL_HOST_GID: `${hostGid}`,
          QUBICL_SSH_PUBLIC_KEY: computer.ssh.publicKey,
          ...computer.environment,
          ...(proxyUrl ? { QUBICL_PROXY_URL: proxyUrl } : {}),
        },
        volumes: [homeVolume],
        networks: [workspaceNetworkKey],
        ports: [`127.0.0.1:${computer.ssh.port}:2222`],
        cpus: 0.5,
        mem_limit: '512m',
        pids_limit: 256,
        privileged: false,
        cap_drop: ['ALL'],
        cap_add: ['SETGID', 'SETUID', 'CHOWN', 'DAC_OVERRIDE', 'SYS_CHROOT'],
        security_opt: ['no-new-privileges:true'],
        labels: {
          'dev.qubicl.role': 'computer-ssh',
          'dev.qubicl.installation': installationId,
          'dev.qubicl.computer-id': computer.id,
        },
        healthcheck: { test: ['CMD-SHELL', "bash -c '</dev/tcp/127.0.0.1/2222'"], interval: '5s', timeout: '3s', retries: 24, start_period: '10s' },
      };
    }
    // Control traffic never needs direct external egress. Keeping this
    // network internal for every policy makes it a stable trust boundary while
    // the policy-dependent workspace network is safely recreated.
    networks[networkKey] = { name: controlNetwork(installationId, computer.id, state.paths.root), driver: 'bridge', internal: true };
    networks[workspaceNetworkKey] = { name: workspaceNetwork(installationId, computer.id, state.paths.root), driver: 'bridge', ...(restrictedNetwork ? { internal: true } : {}) };
  }

  await writeMountedRuntimeFile(state.paths.routes, `${JSON.stringify(routes, null, 2)}\n`, 0o600);
  await atomicWrite(state.paths.compose, YAML.stringify({ name: projectName(installationId, state.paths.root), services, networks, volumes }), 0o600);
}

async function ensurePrivateRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} must be a real runtime directory.`);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (info.uid !== expectedUid) throw new Error(`${path} is not owned by the current Qubicl operator.`);
  await chmod(path, 0o700);
}
