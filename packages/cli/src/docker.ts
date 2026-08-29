import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { createServer } from 'node:net';
import YAML from 'yaml';
import {
  ComputerManifestSchema,
  COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_EXTERNAL_CONTAINER_PORT,
  GATEWAY_EXPOSURE_PROTOCOL,
  IMAGE_CATALOG,
  MIN_DOCKER_COMPOSE_VERSION,
  MIN_DOCKER_ENGINE_VERSION,
  QUBICL_BUILD,
  RuntimeRoutesSchema,
  VIEWER_AUTHENTICATION_HEADER_V1,
  capabilitiesForCompatibility,
  gatewayExposureRuntime,
  gatewayExposureRuntimeId,
  manifestSha256,
  normalizeDockerPlatform,
  viewerForCapabilities,
  versionAtLeast,
  type ComputerConfig,
  type ComputerManifest,
  type DockerPlatform,
  type ImageCatalog,
  type ImageIdentity,
  type Preset,
  type RuntimeContainerBinding,
  type ViewerAuthentication,
} from '@qubicl/core';
import { atomicWrite, durableRemove, type LoadedState } from './state.js';
import { packagedAssetsPath } from './assets.js';
import { COMPUTER_RUNTIME_TOPOLOGY_VERSION, LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION, LEGACY_VIEWER_AUTHENTICATION, PREVIEW_ACCESS_CONTAINER_DIRECTORY, PREVIEW_ACCESS_CONTAINER_PATH, PREVIEW_ACCESS_RUNTIME_DIRECTORY, computerContainerName, computerEgressContainerName, computerEgressServiceName, computerExecutorContainerName, computerExecutorServiceName, computerRuntimeContainerNames, computerServiceName, computerSessionContainerName, computerSessionServiceName, computerSshContainerName, computerWebContainerName, computerWebServiceName, containerName, controlNetwork, displaySocketVolume, gatewayContainerName, gatewayNetworkName, hostIdentity, projectName, readRuntimeImageContracts, recordRuntimeImageContracts, runtimeImageReference, serviceName, usesUnifiedComputerRuntime, workspaceNetwork, type RuntimeImageContract, type RuntimeImageContractsDocument } from './runtime.js';

export interface RunOptions {
  cwd?: string;
  inherit?: boolean;
  stderr?: boolean;
  allowFailure?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const PROBE_CPUS = '0.25';
const PROBE_MEMORY = '128m';
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const PROBE_CLEANUP_TIMEOUT_MS = 10_000;
const PROBE_CLEANUP_OUTPUT_LIMIT_BYTES = 64 * 1024;
const GATEWAY_HEALTH_ATTEMPTS = 3;
const GATEWAY_HEALTH_TIMEOUT_MS = 5_000;
const GATEWAY_HEALTH_RETRY_DELAY_MS = 250;
const LEGACY_GATEWAY_CONTAINER = 'qubicl-gateway';
const LEGACY_GATEWAY_NETWORK = 'qubicl-gateway';

type LegacyRuntimeState = 'absent' | 'running' | 'paused' | 'stopped';

interface LegacyRuntimeMigration {
  version: 1;
  installationId: string;
  createdAt: string;
  gateway: LegacyRuntimeState;
  computers: Record<string, LegacyRuntimeState>;
}

interface NamedRuntimeService {
  name: string;
  service?: string;
  network?: string;
  status: LegacyRuntimeState;
}

interface NamedRuntimeMigration {
  version: 2;
  installationId: string;
  createdAt: string;
  sourceProject: string;
  topologyCurrent?: boolean;
  gateway: NamedRuntimeService;
  computers: Record<string, NamedRuntimeService>;
}

type RuntimeMigration = LegacyRuntimeMigration | NamedRuntimeMigration;

export interface RuntimeInspection {
  Id?: string;
  Name?: string;
  Image?: string;
  State?: { Status?: string; Health?: { Status?: string } };
  Config?: { Labels?: Record<string, string> | null; Env?: string[] | null };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
}

export interface LegacyRuntimeMigrationAdapter {
  docker(args: string[], options?: RunOptions): Promise<string>;
  compose(state: LoadedState, args: string[]): Promise<string>;
  inspectContainer(name: string): Promise<RuntimeInspection | undefined>;
  waitForContainerHealthy(name: string, label: string): Promise<void>;
  waitForHealthy(state: LoadedState, id: string): Promise<void>;
  waitForGatewayComputer(state: LoadedState, id: string): Promise<void>;
}

export interface DockerHostInfo {
  context: string;
  endpoint: string;
  engineVersion: string;
  composeVersion: string;
  operatingSystem: string;
  os: string;
  architecture: string;
  platform: DockerPlatform;
  cpus: number;
  memoryBytes: number;
}

export interface InspectedComputerImage {
  identity: ImageIdentity;
  manifest: ComputerManifest;
  labels: Record<string, string>;
  compatibility: RuntimeImageCompatibility;
}

export interface RuntimeImageCompatibility {
  contentId?: `sha256:${string}`;
  gatewayProtocolVersion?: number;
  gatewayExposureProtocol?: typeof GATEWAY_EXPOSURE_PROTOCOL;
  previewAccessProtocol?: typeof COMPUTER_PREVIEW_ACCESS_PROTOCOL;
  viewerAuthentication?: ViewerAuthentication;
}

export interface RuntimeImageContractImageInspection {
  id: `sha256:${string}`;
  labels: Readonly<Record<string, string>>;
  env: readonly string[];
}

export interface RuntimeImageContractEvidenceAdapter {
  inspectContainer(name: string): Promise<RuntimeInspection | undefined>;
  inspectImage(contentId: `sha256:${string}`): Promise<RuntimeImageContractImageInspection | undefined>;
}

export interface RuntimeImageContractReplacementPlan {
  gatewaySource?: readonly RuntimeContainerBinding[];
  computerSources?: Readonly<Record<string, readonly RuntimeContainerBinding[]>>;
}

export interface InspectedGatewayImage {
  identity: ImageIdentity;
  compatibility: RuntimeImageCompatibility;
}

export interface AcquireOptions {
  offline?: boolean;
  stderr?: boolean;
  catalog?: ImageCatalog;
  platform?: DockerPlatform;
  progress?: (message: string) => void;
}

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('Command timeout must be a positive number of milliseconds.');
  }
  if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)) {
    throw new Error('Command output limit must be a positive whole number of bytes.');
  }
  if (options.maxOutputBytes !== undefined && (options.inherit || options.stderr)) {
    throw new Error('Command output can only be limited when output is captured.');
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.inherit ? 'inherit' : options.stderr ? ['ignore', process.stderr, process.stderr] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let completed = false;
    let timeout: NodeJS.Timeout | undefined;
    const commandText = `${command} ${args.join(' ')}`;
    const finish = (error?: Error, terminate = false): void => {
      if (completed) return;
      completed = true;
      if (timeout) clearTimeout(timeout);
      if (terminate && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (error) reject(error);
      else resolvePromise(stdout.trim());
    };
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (completed) return;
      const nextOutputBytes = outputBytes + chunk.byteLength;
      if (options.maxOutputBytes !== undefined && nextOutputBytes > options.maxOutputBytes) {
        finish(new Error(`${commandText} exceeded the ${options.maxOutputBytes}-byte output limit.`), true);
        return;
      }
      outputBytes = nextOutputBytes;
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    if (!options.inherit && !options.stderr) {
      child.stdout!.on('data', (chunk: Buffer) => capture('stdout', chunk));
      child.stderr!.on('data', (chunk: Buffer) => capture('stderr', chunk));
    }
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) finish();
      else finish(new Error(`${commandText} failed (${code}): ${stderr.trim()}`));
    });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        finish(new Error(`${commandText} exceeded the ${options.timeoutMs}ms timeout.`), true);
      }, options.timeoutMs);
      timeout.unref();
    }
  });
}

export async function docker(args: string[], options: RunOptions = {}): Promise<string> {
  return run('docker', args, options);
}

export async function compose(state: LoadedState, args: string[], options: RunOptions = {}): Promise<string> {
  return docker(['compose', '--project-name', projectName(state.config.installationId, state.paths.root), '--file', state.paths.compose, ...args], options);
}

export async function legacyRuntimeMigrationNeeded(state: LoadedState): Promise<boolean> {
  for (const marker of [state.paths.runtimeMigration, state.paths.runtimeNamespacePending]) {
    try {
      const info = await lstat(marker);
      if (!info.isFile()) throw new Error(`${marker} exists but is not a regular file.`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    const document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as RuntimeComposeDocument | null;
    return runtimeComposeNeedsMigration(state, document);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function migrateLegacyRuntime(state: LoadedState, adapter: LegacyRuntimeMigrationAdapter = defaultLegacyRuntimeMigrationAdapter()): Promise<boolean> {
  const migration = await readRuntimeMigration(state)
    ?? await captureNamedRuntime(state, adapter)
    ?? await captureLegacyRuntime(state, adapter);
  if (!migration) {
    await durableRemove(state.paths.runtimeNamespacePending);
    return false;
  }
  if (migration.version === 1) {
    await removeLegacyRuntime(state, migration, adapter);
    await restoreRuntime(state, migration.gateway, migration.computers, adapter);
  } else if (canRenameRuntimeInPlace(state, migration)) {
    await renameRuntimeContainers(state, migration, adapter);
    await verifyRestoredRuntime(state, migration.gateway.status, Object.fromEntries(Object.entries(migration.computers).map(([id, service]) => [id, service.status])), adapter);
  } else {
    await assertRuntimeMigrationImagesAvailable(state, migration, adapter);
    await removeNamedRuntime(state, migration, adapter);
    await restoreRuntime(
      state,
      migration.gateway.status,
      Object.fromEntries(Object.entries(migration.computers).map(([id, service]) => [id, service.status])),
      adapter,
    );
  }
  await durableRemove(state.paths.runtimeMigration);
  await durableRemove(state.paths.runtimeNamespacePending);
  return true;
}

function canRenameRuntimeInPlace(state: LoadedState, migration: NamedRuntimeMigration): boolean {
  if (migration.topologyCurrent !== true) return false;
  if (migration.sourceProject !== projectName(state.config.installationId, state.paths.root)) return false;
  if (migration.gateway.service !== 'gateway') return false;
  if (migration.gateway.network !== gatewayNetworkName(state.config.installationId, state.paths.root)) return false;
  return state.config.computers.every((computer) => {
    const source = migration.computers[computer.id];
    return !source || (source.service === computerServiceName(state, computer)
      && source.network === controlNetwork(state.config.installationId, computer.id, state.paths.root));
  });
}

function gatewayRequiresRecreation(state: LoadedState, migration: NamedRuntimeMigration): boolean {
  if (migration.gateway.status === 'absent') return false;
  return migration.sourceProject !== projectName(state.config.installationId, state.paths.root)
    || migration.gateway.service !== 'gateway'
    || migration.gateway.name !== gatewayContainerName(state.config.installationId, state.paths.root)
    || migration.gateway.network !== gatewayNetworkName(state.config.installationId, state.paths.root);
}

function computerRequiresRecreation(
  state: LoadedState,
  migration: NamedRuntimeMigration,
  id: string,
  computer: ComputerConfig | undefined,
): boolean {
  const source = migration.computers[id];
  if (!source || source.status === 'absent') return false;
  if (!computer) return true;
  return migration.topologyCurrent !== true
    || migration.sourceProject !== projectName(state.config.installationId, state.paths.root)
    || source.service !== computerServiceName(state, computer)
    || source.name !== computerContainerName(state, computer)
    || source.network !== controlNetwork(state.config.installationId, computer.id, state.paths.root);
}

export async function prepareRuntimeMigration(
  state: LoadedState,
  adapter: LegacyRuntimeMigrationAdapter = defaultLegacyRuntimeMigrationAdapter(),
): Promise<boolean> {
  if (await readRuntimeMigration(state)) return true;
  return Boolean(await captureNamedRuntime(state, adapter) ?? await captureLegacyRuntime(state, adapter));
}

interface RuntimeComposeDocument {
  name?: string;
  services?: Record<string, { container_name?: string; networks?: string[]; labels?: Record<string, string> }>;
  networks?: Record<string, { name?: string }>;
}

function runtimeComposeNeedsMigration(state: LoadedState, document: RuntimeComposeDocument | null): boolean {
  if (document?.name !== projectName(state.config.installationId, state.paths.root)) return true;
  if (document.services?.gateway?.container_name !== gatewayContainerName(state.config.installationId, state.paths.root)) return true;
  if (document.networks?.gateway?.name !== gatewayNetworkName(state.config.installationId, state.paths.root)) return true;
  return state.config.computers.some((computer) => {
    const key = computerServiceName(state, computer);
    const executorKey = computerExecutorServiceName(state, computer);
    const sessionKey = computerSessionServiceName(state, computer);
    const egressKey = computerEgressServiceName(state, computer);
    const webKey = computerWebServiceName(state, computer);
    const unifiedRuntime = usesUnifiedComputerRuntime(computer);
    const webRuntime = computer.controlProtocolVersion === LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION;
    const networkKey = `control_${computer.id.replaceAll('-', '')}`;
    const workspaceKey = `workspace_${computer.id.replaceAll('-', '')}`;
    if (document.services?.[key]?.container_name !== computerContainerName(state, computer)
      || document.networks?.[networkKey]?.name !== controlNetwork(state.config.installationId, computer.id, state.paths.root)) return true;
    if (unifiedRuntime) {
      return document.services?.[key]?.labels?.['dev.qubicl.topology-version'] !== COMPUTER_RUNTIME_TOPOLOGY_VERSION
        || document.services?.[executorKey] !== undefined
        || document.services?.[egressKey] !== undefined
        || document.services?.[webKey] !== undefined
        || document.services?.[sessionKey] !== undefined
        || document.networks?.[workspaceKey] !== undefined;
    }
    return document.services?.[key]?.labels?.['dev.qubicl.topology-version'] !== '5'
      || document.services?.[executorKey]?.container_name !== `${computerContainerName(state, computer)}-executor`
      || document.services?.[egressKey]?.container_name !== `${computerContainerName(state, computer)}-egress`
      || (webRuntime && document.services?.[webKey]?.container_name !== `${computerContainerName(state, computer)}-web`)
      || (computer.capabilities.includes('viewer') && document.services?.[sessionKey]?.container_name !== `${computerContainerName(state, computer)}-session`)
      || document.networks?.[workspaceKey]?.name !== workspaceNetwork(state.config.installationId, computer.id, state.paths.root);
  });
}

function runtimeComposeHasIsolatedTopology(state: LoadedState, document: RuntimeComposeDocument): boolean {
  const primaryServices = Object.entries(document.services ?? {})
    .filter(([, definition]) => definition.labels?.['dev.qubicl.role'] === 'computer');
  return primaryServices.every(([service, definition]) => {
    const id = definition.labels?.['dev.qubicl.id'];
    const computer = state.config.computers.find((candidate) => candidate.id === id);
    if (!computer) return false;
    const workspaceKey = `workspace_${computer.id.replaceAll('-', '')}`;
    if (usesUnifiedComputerRuntime(computer)) {
      return definition.labels?.['dev.qubicl.topology-version'] === COMPUTER_RUNTIME_TOPOLOGY_VERSION
        && document.services?.[`${service}-executor`] === undefined
        && document.services?.[`${service}-egress`] === undefined
        && document.services?.[`${service}-web`] === undefined
        && document.services?.[`${service}-session`] === undefined
        && document.networks?.[workspaceKey] === undefined;
    }
    return definition.labels?.['dev.qubicl.topology-version'] === '5'
      && document.services?.[`${service}-executor`]?.container_name !== undefined
      && document.services?.[`${service}-egress`]?.container_name !== undefined
      && (computer.controlProtocolVersion !== LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION || document.services?.[`${service}-web`]?.container_name !== undefined)
      && (!computer.capabilities.includes('viewer') || document.services?.[`${service}-session`]?.container_name !== undefined)
      && document.networks?.[workspaceKey]?.name !== undefined;
  });
}

function composeComputerService(
  state: LoadedState,
  document: RuntimeComposeDocument,
  computer: ComputerConfig,
): [string, NonNullable<RuntimeComposeDocument['services']>[string]] | undefined {
  const labeled = Object.entries(document.services ?? {})
    .filter(([, definition]) => definition.labels?.['dev.qubicl.id'] === computer.id);
  if (labeled.length > 1) throw new Error(`Runtime Compose document identifies multiple services for Qubicl computer ${computer.name}.`);
  if (labeled[0]) return labeled[0];
  for (const key of [computerServiceName(state, computer), serviceName(computer.id)]) {
    const definition = document.services?.[key];
    if (definition) return [key, definition];
  }
  return undefined;
}

async function captureNamedRuntime(state: LoadedState, adapter: LegacyRuntimeMigrationAdapter): Promise<NamedRuntimeMigration | undefined> {
  let document: RuntimeComposeDocument;
  try {
    document = YAML.parse(await readFile(state.paths.compose, 'utf8')) as RuntimeComposeDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!document.name || !document.services?.gateway?.container_name) return undefined;
  const gatewayName = document.services.gateway.container_name;
  const gatewayInspection = await adapter.inspectContainer(gatewayName);
  if (gatewayInspection) verifyManagedGateway(state, gatewayInspection, gatewayName);
  const computers: Record<string, NamedRuntimeService> = {};
  for (const computer of state.config.computers) {
    const entry = composeComputerService(state, document, computer);
    const name = entry?.[1].container_name;
    if (!name) {
      computers[computer.id] = { name: computerContainerName(state, computer), service: computerServiceName(state, computer), status: 'absent' };
      continue;
    }
    const inspection = await adapter.inspectContainer(name);
    if (inspection) verifyManagedComputer(state, computer.id, inspection, name);
    const networkKey = `control_${computer.id.replaceAll('-', '')}`;
    computers[computer.id] = {
      name,
      service: entry[0],
      ...(document.networks?.[networkKey]?.name ? { network: document.networks[networkKey]!.name } : {}),
      status: normalizedRuntimeState(inspection?.State?.Status),
    };
  }
  const gateway = normalizedRuntimeState(gatewayInspection?.State?.Status);
  if (gateway === 'absent' && Object.values(computers).every(({ status }) => status === 'absent')
    && !runtimeComposeNeedsMigration(state, document)) return undefined;
  const migration: NamedRuntimeMigration = {
    version: 2,
    installationId: state.config.installationId,
    createdAt: new Date().toISOString(),
    sourceProject: document.name,
    topologyCurrent: runtimeComposeHasIsolatedTopology(state, document),
    gateway: {
      name: gatewayName,
      service: 'gateway',
      ...(document.networks?.gateway?.name ? { network: document.networks.gateway.name } : {}),
      status: gateway,
    },
    computers,
  };
  if (!canRenameRuntimeInPlace(state, migration)) await assertRuntimeMigrationImagesAvailable(state, migration, adapter);
  await atomicWrite(state.paths.runtimeMigration, `${JSON.stringify(migration, null, 2)}\n`, 0o600);
  return migration;
}

async function assertRuntimeMigrationImagesAvailable(
  state: LoadedState,
  migration: NamedRuntimeMigration,
  adapter: LegacyRuntimeMigrationAdapter,
): Promise<void> {
  const required = new Set<string>();
  if (gatewayRequiresRecreation(state, migration)) required.add(runtimeImageReference(state.config.gateway.image, 'gateway'));
  for (const computer of state.config.computers) {
    if (computerRequiresRecreation(state, migration, computer.id, computer)) {
      required.add(runtimeImageReference(computer.image, 'computer', computer.compatibility));
    }
  }
  for (const image of required) {
    const available = await adapter.docker(['image', 'inspect', '--format', '{{.Id}}', image], { allowFailure: true });
    if (!available) {
      throw new Error(`Qubicl cannot safely migrate Docker runtime names because exact image ${image} is not local. The existing containers were left unchanged. Restore or rebuild that image, then retry.`);
    }
  }
}

async function captureLegacyRuntime(state: LoadedState, adapter: LegacyRuntimeMigrationAdapter): Promise<LegacyRuntimeMigration | undefined> {
  const gatewayInspection = await adapter.inspectContainer(LEGACY_GATEWAY_CONTAINER);
  if (gatewayInspection) verifyLegacyGateway(state, gatewayInspection);
  const computers: Record<string, LegacyRuntimeState> = {};
  for (const computer of state.config.computers) {
    const inspection = await adapter.inspectContainer(legacyContainerName(computer.id));
    if (inspection) verifyLegacyComputer(state, computer.id, inspection);
    computers[computer.id] = normalizedRuntimeState(inspection?.State?.Status);
  }
  const gateway = normalizedRuntimeState(gatewayInspection?.State?.Status);
  if (gateway === 'absent' && Object.values(computers).every((status) => status === 'absent')) return undefined;
  const migration: LegacyRuntimeMigration = {
    version: 1,
    installationId: state.config.installationId,
    createdAt: new Date().toISOString(),
    gateway,
    computers,
  };
  await atomicWrite(state.paths.runtimeMigration, `${JSON.stringify(migration, null, 2)}\n`, 0o600);
  return migration;
}

async function readRuntimeMigration(state: LoadedState): Promise<RuntimeMigration | undefined> {
  let contents: string;
  try {
    const info = await lstat(state.paths.runtimeMigration);
    if (!info.isFile()) throw new Error(`${state.paths.runtimeMigration} exists but is not a regular file.`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`${state.paths.runtimeMigration} must have mode 0600.`);
    contents = await readFile(state.paths.runtimeMigration, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(contents) as Partial<RuntimeMigration>;
  if ((value.version !== 1 && value.version !== 2) || value.installationId !== state.config.installationId
    || typeof value.createdAt !== 'string' || !value.computers || typeof value.computers !== 'object') {
    throw new Error(`Legacy runtime migration journal ${state.paths.runtimeMigration} is invalid or belongs to another installation.`);
  }
  const configuredIds = new Set(state.config.computers.map(({ id }) => id));
  const validComputer = (id: string): boolean => value.version === 1
    ? validRuntimeState((value.computers as LegacyRuntimeMigration['computers'])[id])
    : validNamedRuntimeService((value.computers as NamedRuntimeMigration['computers'])[id]);
  const validGateway = value.version === 1 ? validRuntimeState(value.gateway) : validNamedRuntimeService(value.gateway);
  const invalidEntries = value.version === 1
    ? Object.keys(value.computers).some((id) => !configuredIds.has(id) || !validComputer(id))
    : Object.values(value.computers).some((service) => !validNamedRuntimeService(service));
  if (!validGateway || invalidEntries
    || (value.version === 1 && state.config.computers.some(({ id }) => !validComputer(id)))) {
    throw new Error(`Legacy runtime migration journal ${state.paths.runtimeMigration} does not match configured computers.`);
  }
  if (value.version === 2 && typeof value.sourceProject !== 'string') {
    throw new Error(`Legacy runtime migration journal ${state.paths.runtimeMigration} does not identify its source project.`);
  }
  return value as RuntimeMigration;
}

function validNamedRuntimeService(value: unknown): value is NamedRuntimeService {
  if (!value || typeof value !== 'object') return false;
  const service = value as Partial<NamedRuntimeService>;
  return typeof service.name === 'string' && service.name.length > 0
    && (service.service === undefined || typeof service.service === 'string')
    && (service.network === undefined || typeof service.network === 'string')
    && validRuntimeState(service.status);
}

async function removeLegacyRuntime(state: LoadedState, migration: LegacyRuntimeMigration, adapter: LegacyRuntimeMigrationAdapter): Promise<void> {
  for (const [id, status] of Object.entries(migration.computers)) {
    if (status === 'absent') continue;
    const inspection = await adapter.inspectContainer(legacyContainerName(id));
    if (inspection) {
      verifyLegacyComputer(state, id, inspection);
      await adapter.docker(['rm', '--force', legacyContainerName(id)]);
    }
    const network = legacyControlNetwork(id);
    await adapter.docker(['network', 'disconnect', '--force', network, LEGACY_GATEWAY_CONTAINER], { allowFailure: true });
    await adapter.docker(['network', 'rm', network], { allowFailure: true });
  }
  if (migration.gateway !== 'absent') {
    const inspection = await adapter.inspectContainer(LEGACY_GATEWAY_CONTAINER);
    if (inspection) {
      verifyLegacyGateway(state, inspection);
      await adapter.docker(['rm', '--force', LEGACY_GATEWAY_CONTAINER]);
    }
    await adapter.docker(['network', 'rm', LEGACY_GATEWAY_NETWORK], { allowFailure: true });
  }
}

async function removeNamedRuntime(state: LoadedState, migration: NamedRuntimeMigration, adapter: LegacyRuntimeMigrationAdapter): Promise<void> {
  const targetNetworks = new Set([
    gatewayNetworkName(state.config.installationId, state.paths.root),
    ...state.config.computers.map((computer) => controlNetwork(state.config.installationId, computer.id, state.paths.root)),
    ...state.config.computers.map((computer) => workspaceNetwork(state.config.installationId, computer.id, state.paths.root)),
  ]);
  await assertRuntimeDestinationsAvailable(state, migration, adapter);
  for (const [id, service] of Object.entries(migration.computers)) {
    const target = state.config.computers.find((computer) => computer.id === id);
    if (computerRequiresRecreation(state, migration, id, target)) {
      const inspection = await adapter.inspectContainer(service.name);
      if (inspection) {
        verifyManagedComputer(state, id, inspection, service.name);
        await adapter.docker(['rm', '--force', service.name]);
      }
    }
    if (service.network && !targetNetworks.has(service.network)) {
      await adapter.docker(['network', 'disconnect', '--force', service.network, migration.gateway.name], { allowFailure: true });
      await adapter.docker(['network', 'rm', service.network], { allowFailure: true });
    }
  }
  if (gatewayRequiresRecreation(state, migration)) {
    const inspection = await adapter.inspectContainer(migration.gateway.name);
    if (inspection) {
      verifyManagedGateway(state, inspection, migration.gateway.name);
      await adapter.docker(['rm', '--force', migration.gateway.name]);
    }
  }
  if (migration.gateway.network && !targetNetworks.has(migration.gateway.network)) {
    await adapter.docker(['network', 'rm', migration.gateway.network], { allowFailure: true });
  }
}

async function renameRuntimeContainers(state: LoadedState, migration: NamedRuntimeMigration, adapter: LegacyRuntimeMigrationAdapter): Promise<void> {
  await assertRuntimeDestinationsAvailable(state, migration, adapter);
  const targetGateway = gatewayContainerName(state.config.installationId, state.paths.root);
  await renameManagedContainer(state, migration.gateway.name, targetGateway, 'gateway', undefined, adapter);
  for (const [id, service] of Object.entries(migration.computers)) {
    const computer = state.config.computers.find((candidate) => candidate.id === id)!;
    await renameManagedContainer(state, service.name, computerContainerName(state, computer), 'computer', id, adapter);
  }
}

async function assertRuntimeDestinationsAvailable(state: LoadedState, migration: NamedRuntimeMigration, adapter: LegacyRuntimeMigrationAdapter): Promise<void> {
  const sources = new Set([migration.gateway.name, ...Object.values(migration.computers).map(({ name }) => name)]);
  const targets = [
    { name: gatewayContainerName(state.config.installationId, state.paths.root), role: 'gateway' as const, id: undefined },
    ...state.config.computers.map((computer) => ({ name: computerContainerName(state, computer), role: 'computer' as const, id: computer.id })),
  ];
  for (const target of targets) {
    if (sources.has(target.name)) continue;
    const inspection = await adapter.inspectContainer(target.name);
    if (!inspection) continue;
    if (target.role === 'gateway') verifyManagedGateway(state, inspection, target.name);
    else verifyManagedComputer(state, target.id!, inspection, target.name);
  }
}

async function renameManagedContainer(
  state: LoadedState,
  source: string,
  target: string,
  role: 'gateway' | 'computer',
  id: string | undefined,
  adapter: LegacyRuntimeMigrationAdapter,
): Promise<void> {
  if (source === target) return;
  const [sourceInspection, targetInspection] = await Promise.all([
    adapter.inspectContainer(source),
    adapter.inspectContainer(target),
  ]);
  if (targetInspection) {
    if (role === 'gateway') verifyManagedGateway(state, targetInspection, target);
    else verifyManagedComputer(state, id!, targetInspection, target);
    if (sourceInspection) throw new Error(`Both runtime names ${source} and ${target} exist for the same Qubicl service; refusing an ambiguous rename.`);
    return;
  }
  if (!sourceInspection) return;
  if (role === 'gateway') verifyManagedGateway(state, sourceInspection, source);
  else verifyManagedComputer(state, id!, sourceInspection, source);
  await adapter.docker(['rename', source, target]);
}

async function restoreRuntime(
  state: LoadedState,
  gatewayStatus: LegacyRuntimeState,
  computerStatuses: Record<string, LegacyRuntimeState>,
  adapter: LegacyRuntimeMigrationAdapter,
): Promise<void> {
  await restoreService(state, 'gateway', gatewayContainerName(state.config.installationId, state.paths.root), gatewayStatus, false, adapter);
  for (const computer of state.config.computers) {
    const status = computerStatuses[computer.id] ?? 'absent';
    await restoreService(state, computerServiceName(state, computer), computerContainerName(state, computer), status, true, adapter);
    if (status !== 'absent' && gatewayStatus !== 'absent') {
      try {
        await adapter.docker(['network', 'connect', controlNetwork(state.config.installationId, computer.id, state.paths.root), gatewayContainerName(state.config.installationId, state.paths.root)]);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('already exists in network')) throw error;
      }
    }
  }
  await verifyRestoredRuntime(state, gatewayStatus, computerStatuses, adapter);
}

async function verifyRestoredRuntime(
  state: LoadedState,
  gatewayStatus: LegacyRuntimeState,
  computerStatuses: Record<string, LegacyRuntimeState>,
  adapter: LegacyRuntimeMigrationAdapter,
): Promise<void> {
  if (gatewayStatus === 'running') await adapter.waitForContainerHealthy(gatewayContainerName(state.config.installationId, state.paths.root), 'Gateway');
  for (const computer of state.config.computers) {
    if (computerStatuses[computer.id] === 'running') await adapter.waitForHealthy(state, computer.id);
  }
  if (gatewayStatus === 'running') {
    for (const computer of state.config.computers) {
      if (computerStatuses[computer.id] === 'running') await adapter.waitForGatewayComputer(state, computer.id);
    }
  }
}

async function restoreService(state: LoadedState, service: string, name: string, desired: LegacyRuntimeState, includeDependencies: boolean, adapter: LegacyRuntimeMigrationAdapter): Promise<void> {
  if (desired === 'absent') return;
  const existing = await adapter.inspectContainer(name);
  if (existing) verifyNamespacedContainer(state, existing, name);
  const existingStatus = normalizedRuntimeState(existing?.State?.Status);
  if (desired === 'running' || desired === 'paused') {
    if (existingStatus === desired) return;
    await adapter.compose(state, ['up', '--detach', ...(includeDependencies ? [] : ['--no-deps']), service]);
    if (desired === 'paused') await adapter.docker(['pause', name]);
    return;
  }
  if (!existing) await adapter.compose(state, ['create', ...(includeDependencies ? [] : ['--no-deps']), service]);
  else if (existingStatus !== 'stopped') await adapter.compose(state, ['stop', service]);
}

async function inspectContainer(name: string): Promise<RuntimeInspection | undefined> {
  // Generic `docker inspect` resolves containers, images, volumes, and networks.
  // The primary installation intentionally has a `qubicl-gateway` network, so a
  // secondary installation must not mistake that network for a legacy container.
  const output = await docker(['container', 'inspect', name], { allowFailure: true });
  if (!output) return undefined;
  const values = JSON.parse(output) as RuntimeInspection[];
  return values[0];
}

function defaultLegacyRuntimeMigrationAdapter(): LegacyRuntimeMigrationAdapter {
  return {
    docker,
    compose: (state, args) => compose(state, args),
    inspectContainer,
    waitForContainerHealthy: (name, label) => waitForContainerHealthy(name, label),
    waitForHealthy: (state, id) => waitForHealthy(state, id),
    waitForGatewayComputer: (state, id) => waitForGatewayComputer(state, id),
  };
}

function verifyLegacyGateway(state: LoadedState, inspection: RuntimeInspection): void {
  const labels = inspection.Config?.Labels ?? {};
  const mount = inspection.Mounts?.find(({ Destination }) => Destination === '/runtime');
  if (labels['dev.qubicl.role'] !== 'gateway' || !mount?.Source || !sameDockerBindSource(mount.Source, state.paths.runtime)) {
    throw legacyOwnershipError(LEGACY_GATEWAY_CONTAINER, state.paths.root);
  }
}

function verifyManagedGateway(state: LoadedState, inspection: RuntimeInspection, name: string): void {
  const labels = inspection.Config?.Labels ?? {};
  const mount = inspection.Mounts?.find(({ Destination }) => Destination === '/runtime');
  if (labels['dev.qubicl.role'] !== 'gateway'
    || labels['dev.qubicl.installation'] !== state.config.installationId
    || !mount?.Source || !sameDockerBindSource(mount.Source, state.paths.runtime)) {
    throw new Error(`Runtime name ${name} is occupied by a container that is not the managed gateway for ${state.paths.root}. Refusing to replace it.`);
  }
}

function verifyLegacyComputer(state: LoadedState, id: string, inspection: RuntimeInspection): void {
  const labels = inspection.Config?.Labels ?? {};
  const mount = inspection.Mounts?.find(({ Destination }) => Destination === '/home');
  const expectedHome = resolve(join(state.paths.computers, id, 'home'));
  if (labels['dev.qubicl.role'] !== 'computer' || labels['dev.qubicl.id'] !== id
    || !mount?.Source || !sameDockerBindSource(mount.Source, expectedHome)) {
    throw legacyOwnershipError(legacyContainerName(id), state.paths.root);
  }
}

function verifyManagedComputer(state: LoadedState, id: string, inspection: RuntimeInspection, name: string): void {
  const labels = inspection.Config?.Labels ?? {};
  const mount = inspection.Mounts?.find(({ Destination }) => Destination === '/home');
  const expectedHome = resolve(join(state.paths.computers, id, 'home'));
  const mismatches = [
    ...(labels['dev.qubicl.role'] === 'computer' ? [] : ['role label']),
    ...(labels['dev.qubicl.installation'] === state.config.installationId ? [] : ['installation label']),
    ...(labels['dev.qubicl.id'] === id ? [] : ['computer ID label']),
    ...(mount?.Source && sameDockerBindSource(mount.Source, expectedHome) ? [] : ['/home bind mount']),
  ];
  if (mismatches.length) {
    const mountDetail = mismatches.includes('/home bind mount')
      ? ` (found ${mount?.Source ?? 'none'}; expected ${expectedHome})`
      : '';
    throw new Error(`Runtime name ${name} is occupied by a container that is not managed computer ${id} for ${state.paths.root}; mismatched ${mismatches.join(', ')}${mountDetail}. Refusing to replace it.`);
  }
}

/** Docker Desktop may expose a Linux host bind through its `/host_mnt` VM prefix. */
function sameDockerBindSource(actual: string, expected: string): boolean {
  const normalizedActual = resolve(actual);
  const normalizedExpected = resolve(expected);
  return normalizedActual === normalizedExpected
    || normalizedActual === resolve('/host_mnt', normalizedExpected.slice(1));
}

function verifyNamespacedContainer(state: LoadedState, inspection: RuntimeInspection, name: string): void {
  if (inspection.Config?.Labels?.['dev.qubicl.installation'] !== state.config.installationId) {
    throw new Error(`Runtime name ${name} is occupied by a container that does not belong to Qubicl installation ${state.config.installationId}. Refusing to replace it.`);
  }
}

function legacyOwnershipError(name: string, stateRoot: string): Error {
  return new Error(`Legacy runtime name ${name} is already owned by a different Qubicl state directory. Refusing to replace it while migrating ${stateRoot}. Start this installation after the owning legacy installation has migrated, or remove only the verified conflicting legacy runtime.`);
}

function normalizedRuntimeState(status: string | undefined): LegacyRuntimeState {
  if (!status) return 'absent';
  if (status === 'running' || status === 'restarting') return 'running';
  if (status === 'paused') return 'paused';
  return 'stopped';
}

function validRuntimeState(value: unknown): value is LegacyRuntimeState {
  return value === 'absent' || value === 'running' || value === 'paused' || value === 'stopped';
}

function legacyContainerName(id: string): string {
  return `qubicl-${id}`;
}

function legacyControlNetwork(id: string): string {
  return `qubicl-${id}-control`;
}

export async function inspectDockerHost(): Promise<DockerHostInfo> {
  const context = await docker(['context', 'show']);
  const inspectedContext = JSON.parse(await docker(['context', 'inspect', context])) as Array<{ Endpoints?: { docker?: { Host?: string } } }>;
  const endpoint = inspectedContext[0]?.Endpoints?.docker?.Host;
  if (!endpoint) throw new Error(`Docker context ${context} does not expose a Docker endpoint.`);
  if (!localDockerEndpoint(endpoint)) {
    throw new Error(`Docker context ${context} uses remote endpoint ${endpoint}. Qubicl requires a local Docker daemon for private bind mounts and localhost routing.`);
  }
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}'])) as {
    ServerVersion?: string;
    OperatingSystem?: string;
    OSType?: string;
    Architecture?: string;
    NCPU?: number;
    MemTotal?: number;
  };
  const engineVersion = info.ServerVersion ?? '';
  if (!versionAtLeast(engineVersion, MIN_DOCKER_ENGINE_VERSION)) throw new Error(`Docker Engine ${MIN_DOCKER_ENGINE_VERSION} or newer is required; found ${engineVersion || 'unknown'}.`);
  if (info.OSType !== 'linux') throw new Error(`Qubicl requires a Linux Docker daemon; found ${info.OSType ?? 'unknown'}.`);
  if (!info.Architecture) throw new Error('Docker did not report its server architecture.');
  const composeVersion = await docker(['compose', 'version', '--short']);
  if (!versionAtLeast(composeVersion, MIN_DOCKER_COMPOSE_VERSION)) throw new Error(`Docker Compose ${MIN_DOCKER_COMPOSE_VERSION} or newer is required; found ${composeVersion}.`);
  if (!Number.isFinite(info.NCPU) || info.NCPU! <= 0) throw new Error('Docker did not report usable CPU capacity.');
  if (!Number.isFinite(info.MemTotal) || info.MemTotal! <= 0) throw new Error('Docker did not report usable memory capacity.');
  return {
    context,
    endpoint,
    engineVersion,
    composeVersion,
    operatingSystem: info.OperatingSystem ?? 'unknown',
    os: info.OSType,
    architecture: info.Architecture,
    platform: normalizeDockerPlatform(info.OSType, info.Architecture),
    cpus: info.NCPU!,
    memoryBytes: info.MemTotal!,
  };
}

export async function validateDocker(): Promise<DockerHostInfo> {
  return inspectDockerHost();
}

export function localDockerEndpoint(endpoint: string): boolean {
  if (endpoint.startsWith('unix://') || endpoint.startsWith('npipe://')) return true;
  return endpoint.startsWith('/') && !endpoint.startsWith('//');
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await docker(['image', 'inspect', '--format', '{{.Id}}', image], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_CLEANUP_OUTPUT_LIMIT_BYTES,
    });
    return true;
  } catch (error) {
    if (/No such (?:image|object)/i.test(errorMessage(error))) return false;
    throw error;
  }
}

export async function buildSystemImages(presets: readonly Preset[] = ['file-system', 'browser', 'computer', 'workstation'], stderr = false): Promise<void> {
  if (!IMAGE_CATALOG.development) {
    throw new Error('Image build-system is available only in a Qubicl source-development build. Release images are obtained from the exact signed catalog.');
  }
  await buildBundledGateway(IMAGE_CATALOG.gateway.requested, stderr);
  await inspectGatewayImage(IMAGE_CATALOG.gateway.requested, IMAGE_CATALOG.gateway.requested, VIEWER_AUTHENTICATION_HEADER_V1);
  for (const preset of presets) {
    const contract = IMAGE_CATALOG.presets[preset];
    await buildBundledPreset(preset, contract.image.requested, stderr);
    await inspectComputerImage(contract.image.requested, contract.image.requested, contract.manifestSha256, preset, contract.viewerAuthentication);
  }
}

async function buildBundledGateway(tag: string, stderr: boolean): Promise<void> {
  await buildBundledImage('gateway', tag, undefined, undefined, stderr);
}

async function buildBundledPreset(preset: Preset, tag: string, stderr: boolean): Promise<void> {
  const contract = IMAGE_CATALOG.presets[preset];
  await buildBundledImage('computer', tag, preset, contract.manifestSha256, stderr, contract.capabilities);
}

async function buildBundledImage(kind: 'gateway' | 'computer', tag: string, target?: Preset, expectedManifest?: string, stderr = false, capabilities?: readonly string[]): Promise<void> {
  const assets = imageAssetsPath();
  await access(assets);
  const args = [
    'build',
    // Source-development images are consumed only from the local Docker
    // store. Disable BuildKit's attestation manifest here: release candidate
    // assembly has its own mandatory provenance path, while Docker Desktop
    // versions in the supported range can otherwise leave the local `docker
    // build` client waiting after the image has already been loaded.
    '--provenance=false',
    '--build-arg', `QUBICL_VERSION=${QUBICL_BUILD.version}`,
    '--build-arg', `QUBICL_REVISION=${QUBICL_BUILD.revision}`,
    '--build-arg', `QUBICL_CREATED=${QUBICL_BUILD.date}`,
    '--build-arg', 'QUBICL_SOURCE=https://github.com/EldanRing/qubicl',
  ];
  if (target) {
    args.push('--target', target);
    args.push('--build-arg', `QUBICL_CONTRACT_PRESET=${target}`);
    args.push('--build-arg', `QUBICL_CONTRACT_COMPATIBILITY=${target}`);
    args.push('--build-arg', `QUBICL_CONTRACT_CAPABILITIES=${capabilities?.join(',') ?? ''}`);
  }
  if (expectedManifest) args.push('--build-arg', `QUBICL_MANIFEST_SHA256=${expectedManifest}`);
  args.push('--tag', tag, join(assets, kind));
  await docker(args, stderr ? { stderr: true } : { inherit: true });
}

function imageAssetsPath(): string {
  return packagedAssetsPath();
}

export async function acquireCatalogGateway(options: AcquireOptions = {}): Promise<ImageIdentity> {
  return (await acquireCatalogGatewayContract(options)).identity;
}

export async function acquireCatalogGatewayContract(options: AcquireOptions = {}): Promise<InspectedGatewayImage> {
  const catalog = options.catalog ?? IMAGE_CATALOG;
  const platform = options.platform ?? catalog.supportedPlatforms[0]!;
  const variant = catalog.gateway.platforms[platform];
  if (!variant) throw new Error(`Gateway image is unavailable for ${platform}.`);
  await obtainImage(catalog.gateway.requested, variant.resolved, { ...options, kind: 'gateway' });
  return inspectGatewayImageContract(catalog.gateway.requested, variant.resolved, VIEWER_AUTHENTICATION_HEADER_V1);
}

export async function acquireCatalogPreset(preset: Preset, options: AcquireOptions = {}): Promise<InspectedComputerImage> {
  const catalog = options.catalog ?? IMAGE_CATALOG;
  const platform = options.platform ?? catalog.supportedPlatforms[0]!;
  const entry = catalog.presets[preset];
  const variant = entry.image.platforms[platform];
  if (!variant) throw new Error(`Preset ${preset} is unavailable for ${platform}.`);
  await obtainImage(entry.image.requested, variant.resolved, { ...options, kind: 'preset', preset });
  try {
    return await inspectComputerImage(entry.image.requested, variant.resolved, entry.manifestSha256, preset, entry.viewerAuthentication);
  } catch (error) {
    throw developmentImageMismatchError(error, entry.image.requested, catalog);
  }
}

export function developmentImageMismatchError(error: unknown, requested: string, catalog: ImageCatalog): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const isManifestMismatch = original.message.startsWith(`Image ${requested} manifest digest `)
    && original.message.includes(' does not match expected ');
  if (!catalog.development || !isManifestMismatch) return original;
  return new Error(
    `${original.message} This local development image is stale. Run npm run images:build from the Qubicl source checkout, then rerun qubicl setup.`,
    { cause: original },
  );
}

export async function acquireCustomImage(requested: string, options: AcquireOptions = {}, resolved = requested): Promise<InspectedComputerImage> {
  await obtainImage(requested, resolved, { ...options, kind: 'custom' });
  return inspectComputerImage(requested, resolved);
}

interface ObtainOptions extends AcquireOptions {
  kind: 'gateway' | 'preset' | 'custom';
  preset?: Preset;
}

async function obtainImage(requested: string, resolved: string, options: ObtainOptions): Promise<void> {
  // A supported catalog's resolved reference is the tested multi-platform
  // index digest; its catalog entry separately binds the measured host child.
  // A mutable tag with the same repository name is not an offline substitute.
  // Development and custom identities resolve to their local/requested name, so
  // this single check covers those cases without weakening release exactness.
  if (await imageExists(resolved)) return;
  if (options.offline) throw new Error(`Offline setup requires ${resolved} to already exist locally; no pull or build was attempted.`);
  const catalog = options.catalog ?? IMAGE_CATALOG;
  const progress = options.progress ?? (() => undefined);
  if (catalog.development && options.kind === 'gateway' && requested === catalog.gateway.requested) {
    progress(`Building local gateway image ${requested}`);
    await buildBundledGateway(requested, options.stderr ?? false);
    return;
  }
  if (catalog.development && options.kind === 'preset' && options.preset && requested === catalog.presets[options.preset].image.requested) {
    progress(`Building local ${options.preset} image ${requested}`);
    await buildBundledPreset(options.preset, requested, options.stderr ?? false);
    return;
  }
  progress(`Pulling ${resolved}`);
  await docker(['pull', resolved], options.stderr ? { stderr: true } : { inherit: true });
}

export async function inspectGatewayImage(
  requested: string,
  reference = requested,
  expectedViewerAuthentication?: ViewerAuthentication,
): Promise<ImageIdentity> {
  return (await inspectGatewayImageContract(requested, reference, expectedViewerAuthentication)).identity;
}

export async function inspectGatewayImageContract(
  requested: string,
  reference = requested,
  expectedViewerAuthentication?: ViewerAuthentication,
): Promise<InspectedGatewayImage> {
  const inspection = await rawImageInspection(reference);
  const compatibility = gatewayCompatibilityFromLabels(requested, inspection.labels, expectedViewerAuthentication);
  return {
    identity: {
      requested,
      resolved: resolveRepositoryDigest(requested, reference, inspection.repoDigests),
      contentId: inspection.id,
    },
    compatibility: { contentId: inspection.id, ...compatibility },
  };
}

export function gatewayCompatibilityFromLabels(
  reference: string,
  labels: Readonly<Record<string, string>>,
  expectedViewerAuthentication?: ViewerAuthentication,
): RuntimeImageCompatibility {
  const rawProtocol = labels['dev.qubicl.gateway-protocol-version'];
  const rawAuthentication = labels['dev.qubicl.viewer-authentication'];
  const rawExposure = labels['dev.qubicl.gateway-exposure'];
  if (rawProtocol === undefined && rawAuthentication === undefined && rawExposure === undefined) {
    if (expectedViewerAuthentication) throw new Error(`Gateway image ${reference} is missing its authenticated-viewer contract labels.`);
    return {};
  }
  if (rawProtocol !== `${GATEWAY_PROTOCOL_VERSION}` || rawAuthentication !== VIEWER_AUTHENTICATION_HEADER_V1) {
    throw new Error(`Gateway image ${reference} has an invalid authenticated-viewer contract (${JSON.stringify(rawProtocol)}, ${JSON.stringify(rawAuthentication)}).`);
  }
  if (rawExposure !== undefined && rawExposure !== GATEWAY_EXPOSURE_PROTOCOL) {
    throw new Error(`Gateway image ${reference} has an invalid remote-exposure contract ${JSON.stringify(rawExposure)}.`);
  }
  if (expectedViewerAuthentication && rawAuthentication !== expectedViewerAuthentication) {
    throw new Error(`Gateway image ${reference} viewer authentication is ${JSON.stringify(rawAuthentication)}; expected ${JSON.stringify(expectedViewerAuthentication)}.`);
  }
  return {
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
    ...(rawExposure === GATEWAY_EXPOSURE_PROTOCOL ? { gatewayExposureProtocol: GATEWAY_EXPOSURE_PROTOCOL } : {}),
  };
}

export async function inspectComputerImage(
  requested: string,
  reference = requested,
  expectedManifestSha256?: string,
  expectedCompatibility?: Preset,
  expectedViewerAuthentication?: ViewerAuthentication,
): Promise<InspectedComputerImage> {
  const inspection = await rawImageInspection(reference);
  const probeName = `qubicl-image-probe-${uniqueProbeSuffix()}`;
  let rawManifest: string;
  try {
    rawManifest = await docker([
      'run', '--name', probeName, '--rm', '--pull=never', '--network', 'none', '--read-only',
      '--cpus', PROBE_CPUS, '--memory', PROBE_MEMORY, '--memory-swap', PROBE_MEMORY, '--pids-limit', '64',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--entrypoint', 'cat', reference, '/opt/qubicl/computer-manifest.json',
    ], { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_OUTPUT_LIMIT_BYTES });
  } finally {
    await removeProbeContainer(probeName);
  }
  let manifest: ComputerManifest;
  try { manifest = ComputerManifestSchema.parse(JSON.parse(rawManifest)); }
  catch (error) { throw new Error(`Image ${requested} does not contain a valid Qubicl computer contract: ${errorMessage(error)}`); }
  const digest = manifestSha256(manifest);
  if (expectedManifestSha256 && digest !== expectedManifestSha256) {
    throw new Error(`Image ${requested} manifest digest ${digest} does not match expected ${expectedManifestSha256}.`);
  }
  if (expectedCompatibility && manifest.compatibility !== expectedCompatibility) {
    throw new Error(`Image ${requested} advertises ${manifest.compatibility} compatibility; expected ${expectedCompatibility}.`);
  }
  validateComputerLabels(requested, inspection.labels, manifest, digest);
  const bakedStartupProfile = imageEnvironmentValue(inspection.env, 'QUBICL_IMAGE_STARTUP_PROFILE');
  if (bakedStartupProfile !== manifest.startupProfile) {
    throw new Error(`Image ${requested} bakes startup profile ${JSON.stringify(bakedStartupProfile)}; expected ${JSON.stringify(manifest.startupProfile)}.`);
  }
  const viewerAuthentication = computerViewerAuthentication(
    requested,
    inspection.labels,
    inspection.env,
    manifest.viewer,
    expectedViewerAuthentication,
  );
  const previewAccessProtocol = computerPreviewAccessFromLabels(
    requested,
    inspection.labels,
    inspection.env,
  );
  return {
    identity: {
      requested,
      resolved: resolveRepositoryDigest(requested, reference, inspection.repoDigests),
      contentId: inspection.id,
      manifestSha256: digest,
    },
    manifest,
    labels: inspection.labels,
    compatibility: {
      contentId: inspection.id,
      ...(viewerAuthentication ? { viewerAuthentication } : {}),
      ...(previewAccessProtocol ? { previewAccessProtocol } : {}),
    },
  };
}

export function computerPreviewAccessFromLabels(
  reference: string,
  labels: Readonly<Record<string, string>>,
  environment: readonly string[],
): typeof COMPUTER_PREVIEW_ACCESS_PROTOCOL | undefined {
  const label = labels['dev.qubicl.preview-access'];
  const baked = imageEnvironmentValue(environment, 'QUBICL_IMAGE_PREVIEW_ACCESS');
  if (label === undefined && baked === undefined) return undefined;
  if (label !== COMPUTER_PREVIEW_ACCESS_PROTOCOL || baked !== COMPUTER_PREVIEW_ACCESS_PROTOCOL) {
    throw new Error(`Image ${reference} has a mismatched dynamic preview-access contract (${JSON.stringify(label)}, ${JSON.stringify(baked)}).`);
  }
  return COMPUTER_PREVIEW_ACCESS_PROTOCOL;
}

export function computerViewerAuthentication(
  reference: string,
  labels: Readonly<Record<string, string>>,
  environment: readonly string[],
  viewer: boolean,
  expected?: ViewerAuthentication,
): ViewerAuthentication | undefined {
  const label = labels['dev.qubicl.viewer-authentication'];
  const baked = imageEnvironmentValue(environment, 'QUBICL_IMAGE_VIEWER_AUTHENTICATION');
  if (label === undefined && baked === undefined) {
    if (expected) throw new Error(`Image ${reference} is missing its authenticated-viewer image contract.`);
    return undefined;
  }
  if (!viewer || label !== VIEWER_AUTHENTICATION_HEADER_V1 || baked !== VIEWER_AUTHENTICATION_HEADER_V1) {
    throw new Error(`Image ${reference} has a mismatched authenticated-viewer image contract (${JSON.stringify(label)}, ${JSON.stringify(baked)}).`);
  }
  if (expected && label !== expected) {
    throw new Error(`Image ${reference} viewer authentication is ${JSON.stringify(label)}; expected ${JSON.stringify(expected)}.`);
  }
  return VIEWER_AUTHENTICATION_HEADER_V1;
}

function validateComputerLabels(reference: string, labels: Record<string, string>, manifest: ComputerManifest, digest: string): void {
  const expected: Record<string, string> = {
    'dev.qubicl.contract-version': `${manifest.schemaVersion}`,
    'dev.qubicl.preset': manifest.preset,
    'dev.qubicl.compatibility': manifest.compatibility,
    'dev.qubicl.capabilities': manifest.capabilities.join(','),
    'dev.qubicl.manifest-sha256': digest,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (labels[name] !== value) throw new Error(`Image ${reference} label ${name} is ${JSON.stringify(labels[name])}; expected ${JSON.stringify(value)}.`);
  }
  const expectedCapabilities = capabilitiesForCompatibility(manifest.compatibility);
  if (JSON.stringify(manifest.capabilities) !== JSON.stringify(expectedCapabilities)) {
    throw new Error(`Image ${reference} advertises capabilities outside its compatibility contract.`);
  }
}

async function rawImageInspection(reference: string): Promise<{ id: `sha256:${string}`; repoDigests: string[]; labels: Record<string, string>; env: string[] }> {
  const values = JSON.parse(await docker(['image', 'inspect', reference], {
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: PROBE_OUTPUT_LIMIT_BYTES,
  })) as Array<{
    Id?: string;
    RepoDigests?: string[];
    Config?: { Labels?: Record<string, string> | null; Env?: string[] | null };
  }>;
  const value = values[0];
  if (!value?.Id || !/^sha256:[a-f0-9]{64}$/.test(value.Id)) throw new Error(`Docker did not report a valid content ID for ${reference}.`);
  return { id: value.Id as `sha256:${string}`, repoDigests: value.RepoDigests ?? [], labels: value.Config?.Labels ?? {}, env: value.Config?.Env ?? [] };
}

function imageEnvironmentValue(environment: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return environment.toReversed().find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function resolveRepositoryDigest(requested: string, inspectedReference: string, repoDigests: string[]): string {
  if (inspectedReference.includes('@sha256:')) return inspectedReference;
  const repository = imageRepository(requested);
  return repoDigests.find((digest) => imageRepository(digest) === repository) ?? inspectedReference;
}

function imageRepository(reference: string): string {
  const withoutDigest = reference.split('@')[0]!;
  const parsed = parse(withoutDigest);
  const basename = parsed.base;
  const colon = basename.lastIndexOf(':');
  return colon > 0 ? join(parsed.dir, basename.slice(0, colon)).replaceAll('\\', '/') : withoutDigest;
}

export type StoredImageEnsurer = (
  identity: ImageIdentity,
  kind: 'gateway' | 'computer',
  compatibility: Preset | undefined,
  offline: boolean,
) => Promise<RuntimeImageCompatibility>;

interface ConfiguredViewerContracts {
  byComputerId: Map<string, RuntimeImageContract>;
  recovered: RuntimeImageContract[];
}

function computerContractFromCompatibility(compatibility: RuntimeImageCompatibility): RuntimeImageContract | undefined {
  if (!compatibility.contentId) return undefined;
  return {
    kind: 'computer',
    contentId: compatibility.contentId,
    viewerAuthentication: compatibility.viewerAuthentication ?? LEGACY_VIEWER_AUTHENTICATION,
  };
}

function gatewayContractFromCompatibility(compatibility: RuntimeImageCompatibility): RuntimeImageContract | undefined {
  if (!compatibility.contentId) return undefined;
  if (compatibility.viewerAuthentication === undefined
    && compatibility.gatewayProtocolVersion === undefined
    && compatibility.gatewayExposureProtocol === undefined) {
    return {
      kind: 'gateway',
      contentId: compatibility.contentId,
      viewerAuthentication: LEGACY_VIEWER_AUTHENTICATION,
    };
  }
  if (compatibility.viewerAuthentication !== VIEWER_AUTHENTICATION_HEADER_V1
    || compatibility.gatewayProtocolVersion !== GATEWAY_PROTOCOL_VERSION
    || (compatibility.gatewayExposureProtocol !== undefined
      && compatibility.gatewayExposureProtocol !== GATEWAY_EXPOSURE_PROTOCOL)) {
    throw new Error(`Gateway image ${compatibility.contentId} has an inconsistent runtime viewer contract.`);
  }
  return {
    kind: 'gateway',
    contentId: compatibility.contentId,
    viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
    gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
    ...(compatibility.gatewayExposureProtocol === GATEWAY_EXPOSURE_PROTOCOL
      ? { gatewayExposureProtocol: GATEWAY_EXPOSURE_PROTOCOL }
      : {}),
  };
}

function computerContractFromEvidence(
  computer: ComputerConfig,
  contentId: `sha256:${string}`,
  labels: Readonly<Record<string, string>>,
  environment: readonly string[],
): RuntimeImageContract {
  const viewerAuthentication = computerViewerAuthentication(
    `${computer.image.resolved} (${contentId})`,
    labels,
    environment,
    viewerForCapabilities(computer.capabilities),
  );
  return {
    kind: 'computer',
    contentId,
    viewerAuthentication: viewerAuthentication ?? LEGACY_VIEWER_AUTHENTICATION,
  };
}

async function recoverComputerImageContract(
  state: LoadedState,
  computer: ComputerConfig,
  adapter: RuntimeImageContractEvidenceAdapter,
  replacementSource?: readonly RuntimeContainerBinding[],
): Promise<RuntimeImageContract> {
  const contentId = computer.image.contentId as `sha256:${string}`;
  const name = computerContainerName(state, computer);
  const retained = await adapter.inspectContainer(name);
  if (retained) {
    verifyManagedComputer(state, computer.id, retained, name);
    if (retained.Image !== contentId) {
      assertPlannedContractSource(name, 'computer', retained, replacementSource, `computer ${computer.name}`);
      return recoverComputerImageContractFromImage(computer, contentId, adapter);
    }
    return computerContractFromEvidence(
      computer,
      contentId,
      retained.Config?.Labels ?? {},
      retained.Config?.Env ?? [],
    );
  }

  return recoverComputerImageContractFromImage(computer, contentId, adapter);
}

async function recoverComputerImageContractFromImage(
  computer: ComputerConfig,
  contentId: `sha256:${string}`,
  adapter: RuntimeImageContractEvidenceAdapter,
): Promise<RuntimeImageContract> {
  const image = await adapter.inspectImage(contentId);
  if (!image) {
    throw new Error(`Viewer image ${computer.image.resolved} for ${computer.name} has no verified runtime image contract, retained container, or locally inspectable exact image ${contentId}. Restore or reacquire the exact image before changing or starting this runtime.`);
  }
  if (image.id !== contentId) {
    throw new Error(`Exact image evidence for ${computer.name} drifted from configured content ID ${contentId} to ${image.id}. Refusing to reconstruct its viewer contract.`);
  }
  return computerContractFromEvidence(computer, contentId, image.labels, image.env);
}

function gatewayContractFromEvidence(
  contentId: `sha256:${string}`,
  reference: string,
  labels: Readonly<Record<string, string>>,
): RuntimeImageContract {
  return gatewayContractFromCompatibility({
    contentId,
    ...gatewayCompatibilityFromLabels(`${reference} (${contentId})`, labels),
  })!;
}

async function recoverGatewayImageContract(
  state: LoadedState,
  adapter: RuntimeImageContractEvidenceAdapter,
  replacementSource?: readonly RuntimeContainerBinding[],
): Promise<RuntimeImageContract> {
  const configuredContentId = state.config.gateway.image.contentId;
  if (!configuredContentId) {
    throw new Error(`Gateway image ${state.config.gateway.image.resolved} is not bound to a stored content ID. Upgrade the gateway before changing any authenticated viewer runtime.`);
  }
  const contentId = configuredContentId as `sha256:${string}`;
  const name = gatewayContainerName(state.config.installationId, state.paths.root);
  const retained = await adapter.inspectContainer(name);
  if (retained) {
    verifyManagedGateway(state, retained, name);
    if (retained.Image !== contentId) {
      assertPlannedContractSource(name, 'gateway', retained, replacementSource, 'gateway');
      return recoverGatewayImageContractFromImage(state, contentId, adapter);
    }
    return gatewayContractFromEvidence(contentId, state.config.gateway.image.resolved, retained.Config?.Labels ?? {});
  }

  return recoverGatewayImageContractFromImage(state, contentId, adapter);
}

async function recoverGatewayImageContractFromImage(
  state: LoadedState,
  contentId: `sha256:${string}`,
  adapter: RuntimeImageContractEvidenceAdapter,
): Promise<RuntimeImageContract> {
  const image = await adapter.inspectImage(contentId);
  if (!image) {
    throw new Error(`Gateway image ${state.config.gateway.image.resolved} has no verified runtime image contract, retained container, or locally inspectable exact image ${contentId}. Restore or reacquire the exact gateway before changing any authenticated viewer runtime.`);
  }
  if (image.id !== contentId) {
    throw new Error(`Exact gateway image evidence drifted from configured content ID ${contentId} to ${image.id}. Refusing to reconstruct its viewer contract.`);
  }
  return gatewayContractFromEvidence(contentId, state.config.gateway.image.resolved, image.labels);
}

function assertPlannedContractSource(
  name: string,
  role: RuntimeContainerBinding['role'],
  retained: RuntimeInspection,
  replacementSource: readonly RuntimeContainerBinding[] | undefined,
  subject: string,
): void {
  if (!replacementSource
    || new Set(replacementSource.map((binding) => binding.id)).size !== replacementSource.length
    || new Set(replacementSource.map((binding) => binding.name)).size !== replacementSource.length
    || (role === 'gateway' && replacementSource.length !== 1)) {
    throw new Error(`Retained ${subject} was created from ${retained.Image ?? 'an unknown image'}, not its configured content ID, and has no unique immutable planned replacement source. Refusing to reconstruct its viewer contract.`);
  }
  const matching = replacementSource.filter((binding) => binding.name === name && binding.role === role);
  if (matching.length !== 1) {
    throw new Error(`Retained ${subject} was created from ${retained.Image ?? 'an unknown image'}, not its configured content ID. Refusing to reconstruct its viewer contract without one immutable planned replacement source.`);
  }
  const observed = runtimeBinding(retained, name);
  if (!sameRuntimeBinding(observed, matching[0]!)) {
    throw new Error(`Retained ${subject} changed immutable identity or status before viewer-contract reconciliation.`);
  }
}

export async function assertConfiguredGatewaySupportsExposure(
  state: LoadedState,
  adapter: RuntimeImageContractEvidenceAdapter = defaultRuntimeImageContractEvidenceAdapter(),
): Promise<void> {
  const contentId = state.config.gateway.image.contentId;
  if (!contentId) {
    throw new Error(`Gateway image ${state.config.gateway.image.resolved} is not bound to immutable content evidence. Run qubicl upgrade --all before enabling remote access.`);
  }
  const cached = (await readRuntimeImageContracts(state)).images[contentId];
  const contract = cached?.kind === 'gateway' && cached.gatewayExposureProtocol === GATEWAY_EXPOSURE_PROTOCOL
    ? cached
    : await recoverGatewayImageContract(state, adapter);
  if (contract.gatewayExposureProtocol !== GATEWAY_EXPOSURE_PROTOCOL) {
    throw new Error(`Gateway image ${state.config.gateway.image.resolved} does not declare ${GATEWAY_EXPOSURE_PROTOCOL} support. Run qubicl upgrade --all before enabling remote access.`);
  }
}

export async function assertConfiguredComputersSupportRemotePreviews(
  state: LoadedState,
  adapter: RuntimeImageContractEvidenceAdapter = defaultRuntimeImageContractEvidenceAdapter(),
): Promise<void> {
  for (const computer of state.config.computers) {
    const configuredContentId = computer.image.contentId;
    if (!configuredContentId) {
      throw new Error(`Computer ${computer.name} is not bound to immutable image evidence required for remote previews. Run qubicl upgrade --all before enabling a remote preview domain.`);
    }
    const contentId = configuredContentId as `sha256:${string}`;
    const name = computerContainerName(state, computer);
    const retained = await adapter.inspectContainer(name);
    if (retained) {
      verifyManagedComputer(state, computer.id, retained, name);
      if (retained.Image !== contentId) {
        throw new Error(`Retained computer ${computer.name} was created from ${retained.Image ?? 'an unknown image'}, not its configured content ID ${contentId}. Refusing to enable remote previews.`);
      }
      if (computerPreviewAccessFromLabels(
        `${computer.image.resolved} (${contentId})`,
        retained.Config?.Labels ?? {},
        retained.Config?.Env ?? [],
      ) !== COMPUTER_PREVIEW_ACCESS_PROTOCOL) {
        throw new Error(`Computer image ${computer.image.resolved} for ${computer.name} does not declare ${COMPUTER_PREVIEW_ACCESS_PROTOCOL} preview access. Run qubicl upgrade --all before enabling a remote preview domain.`);
      }
      const expectedSource = join(state.paths.runtime, PREVIEW_ACCESS_RUNTIME_DIRECTORY, computer.id);
      const previewMounts = (retained.Mounts ?? []).filter(({ Destination }) => Destination === PREVIEW_ACCESS_CONTAINER_DIRECTORY);
      if (previewMounts.length !== 1
        || previewMounts[0]?.Type !== 'bind'
        || previewMounts[0].RW !== false
        || !previewMounts[0].Source
        || !sameDockerBindSource(previewMounts[0].Source, expectedSource)
        || !(retained.Config?.Env ?? []).includes(`QUBICL_PREVIEW_ACCESS_PATH=${PREVIEW_ACCESS_CONTAINER_PATH}`)) {
        throw new Error(`Retained computer ${computer.name} does not have the managed read-only dynamic preview-access mount. Upgrade or recreate it before enabling a remote preview domain.`);
      }
      continue;
    }

    const image = await adapter.inspectImage(contentId);
    if (!image || image.id !== contentId) {
      throw new Error(`Computer ${computer.name} has no locally inspectable exact image ${contentId} for remote preview verification. Restore or reacquire it before enabling a remote preview domain.`);
    }
    if (computerPreviewAccessFromLabels(
      `${computer.image.resolved} (${contentId})`,
      image.labels,
      image.env,
    ) !== COMPUTER_PREVIEW_ACCESS_PROTOCOL) {
      throw new Error(`Computer image ${computer.image.resolved} for ${computer.name} does not declare ${COMPUTER_PREVIEW_ACCESS_PROTOCOL} preview access. Run qubicl upgrade --all before enabling a remote preview domain.`);
    }
  }
}

async function resolveConfiguredViewerContracts(
  state: LoadedState,
  cache: RuntimeImageContractsDocument,
  overrides: ReadonlyMap<string, RuntimeImageContract>,
  gatewayOverride: RuntimeImageContract | undefined,
  adapter: RuntimeImageContractEvidenceAdapter,
  replacements?: RuntimeImageContractReplacementPlan,
): Promise<ConfiguredViewerContracts> {
  const byComputerId = new Map<string, RuntimeImageContract>();
  const recovered: RuntimeImageContract[] = [];
  for (const computer of state.config.computers) {
    const contentId = computer.image.contentId;
    if (!contentId || !viewerForCapabilities(computer.capabilities)) continue;
    const override = overrides.get(contentId);
    if (override) {
      byComputerId.set(computer.id, override);
      continue;
    }
    const cached = cache.images[contentId];
    if (cached?.kind === 'computer') {
      byComputerId.set(computer.id, cached);
      continue;
    }
    const contract = await recoverComputerImageContract(
      state,
      computer,
      adapter,
      replacements?.computerSources?.[computer.id],
    );
    byComputerId.set(computer.id, contract);
    recovered.push(contract);
  }
  const authenticatedNames = state.config.computers
    .filter((computer) => byComputerId.get(computer.id)?.viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1)
    .map(({ name }) => name);
  if (authenticatedNames.length) {
    const configuredGatewayId = state.config.gateway.image.contentId;
    const cachedGateway = configuredGatewayId ? cache.images[configuredGatewayId] : undefined;
    const gatewayContract = gatewayOverride
      ?? (cachedGateway?.kind === 'gateway'
        ? cachedGateway
        : await recoverGatewayImageContract(state, adapter, replacements?.gatewaySource));
    if (gatewayContract.viewerAuthentication !== VIEWER_AUTHENTICATION_HEADER_V1
      || gatewayContract.gatewayProtocolVersion !== GATEWAY_PROTOCOL_VERSION) {
      throw new Error(`Gateway image ${state.config.gateway.image.resolved} cannot route authenticated viewers required by ${authenticatedNames.join(', ')}. Upgrade the gateway before changing any computer runtime.`);
    }
    if (!gatewayOverride && cachedGateway?.kind !== 'gateway') recovered.push(gatewayContract);
  }
  return { byComputerId, recovered };
}

function defaultRuntimeImageContractEvidenceAdapter(): RuntimeImageContractEvidenceAdapter {
  return {
    inspectContainer,
    inspectImage: async (contentId) => {
      if (!(await imageExists(contentId))) return undefined;
      const inspection = await rawImageInspection(contentId);
      return { id: inspection.id, labels: inspection.labels, env: inspection.env };
    },
  };
}

/**
 * Repair only absent or wrong-kind viewer contracts from immutable Docker
 * evidence. A valid content-ID-bound cache entry remains the normal fast path;
 * malformed documents fail closed in readRuntimeImageContracts.
 */
export async function reconcileRuntimeImageContracts(
  state: LoadedState,
  adapter: RuntimeImageContractEvidenceAdapter = defaultRuntimeImageContractEvidenceAdapter(),
  replacements?: RuntimeImageContractReplacementPlan,
): Promise<void> {
  const cache = await readRuntimeImageContracts(state);
  const resolved = await resolveConfiguredViewerContracts(state, cache, new Map(), undefined, adapter, replacements);
  if (resolved.recovered.length) await recordRuntimeImageContracts(state, resolved.recovered);
}

/** Ensure the gateway and only the computers the caller intends to operate. */
export async function ensureRuntimeImages(
  state: LoadedState,
  computers: readonly ComputerConfig[],
  offline = false,
  ensure: StoredImageEnsurer = ensureStoredImage,
  evidenceAdapter: RuntimeImageContractEvidenceAdapter = defaultRuntimeImageContractEvidenceAdapter(),
): Promise<void> {
  const gateway = await ensure(state.config.gateway.image, 'gateway', undefined, offline);
  if (state.config.gateway.exposure && gateway.gatewayExposureProtocol !== GATEWAY_EXPOSURE_PROTOCOL) {
    throw new Error(`Gateway image ${state.config.gateway.image.resolved} does not declare ${GATEWAY_EXPOSURE_PROTOCOL} support required by the preserved remote-access configuration. Revoke remote access before selecting this gateway image, or choose a compatible gateway.`);
  }
  const inspectedComputers = await Promise.all(computers.map(async (computer) => ({
    computer,
    compatibility: await ensure(computer.image, 'computer', computer.compatibility, offline),
  })));
  if (state.config.gateway.exposure?.previewDomain) {
    for (const { computer, compatibility } of inspectedComputers) {
      if (compatibility.previewAccessProtocol !== COMPUTER_PREVIEW_ACCESS_PROTOCOL) {
        throw new Error(`Computer image ${computer.image.resolved} for ${computer.name} does not declare ${COMPUTER_PREVIEW_ACCESS_PROTOCOL} preview access required by the preserved remote preview domain. Upgrade the image or revoke/reconfigure remote previews first.`);
      }
    }
  }
  if (gateway.viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1
    && (!state.config.gateway.image.contentId || gateway.contentId !== state.config.gateway.image.contentId)) {
    throw new Error(`Authenticated-viewer gateway ${state.config.gateway.image.resolved} is not bound to its stored content ID.`);
  }
  for (const { computer, compatibility } of inspectedComputers) {
    if (compatibility.viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1
      && (!computer.image.contentId || compatibility.contentId !== computer.image.contentId)) {
      throw new Error(`Authenticated viewer image ${computer.image.resolved} is not bound to its stored content ID.`);
    }
  }
  if (state.config.gateway.image.contentId && gateway.contentId !== state.config.gateway.image.contentId) {
    throw new Error(`Gateway image ${state.config.gateway.image.resolved} drifted from stored content ID ${state.config.gateway.image.contentId} to ${gateway.contentId ?? 'an unknown image'}.`);
  }
  for (const { computer, compatibility } of inspectedComputers) {
    if (computer.image.contentId && compatibility.contentId !== computer.image.contentId) {
      throw new Error(`Computer image ${computer.image.resolved} drifted from stored content ID ${computer.image.contentId} to ${compatibility.contentId ?? 'an unknown image'}.`);
    }
  }

  const cache = await readRuntimeImageContracts(state);
  const selectedContracts = inspectedComputers
    .map(({ compatibility }) => computerContractFromCompatibility(compatibility))
    .filter((contract): contract is RuntimeImageContract => contract !== undefined);
  const overrides = new Map(selectedContracts.map((contract) => [contract.contentId, contract]));
  const gatewayContract = gatewayContractFromCompatibility(gateway);
  const configuredContracts = await resolveConfiguredViewerContracts(state, cache, overrides, gatewayContract, evidenceAdapter);
  const contracts: RuntimeImageContract[] = [];
  if (gatewayContract) contracts.push(gatewayContract);
  contracts.push(...selectedContracts, ...configuredContracts.recovered);
  if (contracts.length) await recordRuntimeImageContracts(state, contracts);
}

export async function ensureSystemImages(state: LoadedState, includeComputers = true, offline = false): Promise<void> {
  await ensureRuntimeImages(state, includeComputers ? state.config.computers : [], offline);
}

async function ensureStoredImage(identity: ImageIdentity, kind: 'gateway' | 'computer', compatibility: Preset | undefined, offline: boolean): Promise<RuntimeImageCompatibility> {
  let reference = runtimeImageReference(identity, kind, compatibility);
  let available = await imageExists(reference);
  if (!available && reference !== identity.resolved && await imageExists(identity.resolved)) {
    reference = identity.resolved;
    available = true;
  }
  if (!available) {
    if (offline) throw new Error(`Offline mode requires ${identity.resolved} to already exist locally.`);
    if (await rebuildStoredDevelopmentImage(identity, kind, compatibility)) {
      if (!(await imageExists(reference))) {
        throw new Error(`Rebuilt ${identity.requested}, but the stored exact image ${identity.resolved} (${identity.contentId ?? 'content ID unavailable'}) is no longer available. The computer remains configured and its home is unchanged; explicitly replace or restore its pinned image before starting it.`);
      }
    } else {
      await docker(['pull', identity.resolved], { inherit: true });
    }
  }
  if (kind === 'gateway') {
    const current = await inspectGatewayImageContract(identity.requested, reference);
    if (identity.contentId && identity.contentId !== current.identity.contentId) throw new Error(`Gateway image ${identity.resolved} drifted from stored content ID ${identity.contentId} to ${current.identity.contentId}.`);
    return current.compatibility;
  }
  let current: InspectedComputerImage;
  try {
    current = await inspectComputerImage(identity.requested, reference, identity.manifestSha256, compatibility);
  } catch (error) {
    if (!(await rebuildLegacyDevelopmentComputer(identity, compatibility))) throw error;
    current = await inspectComputerImage(identity.requested, reference, identity.manifestSha256, compatibility);
  }
  if (identity.contentId && identity.contentId !== current.identity.contentId) {
    throw new Error(`Computer image ${identity.resolved} drifted from stored content ID ${identity.contentId} to ${current.identity.contentId}.`);
  }
  if (current.compatibility.viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1 && !identity.contentId) {
    throw new Error(`Authenticated viewer image ${identity.resolved} is not bound to a stored content ID. Explicitly upgrade or reacquire this computer image before starting it.`);
  }
  return current.compatibility;
}

async function rebuildStoredDevelopmentImage(
  identity: ImageIdentity,
  kind: 'gateway' | 'computer',
  compatibility: Preset | undefined,
): Promise<boolean> {
  if (!IMAGE_CATALOG.development) return false;
  if (kind === 'gateway' && identity.requested === IMAGE_CATALOG.gateway.requested) {
    await buildBundledGateway(identity.requested, false);
    return true;
  }
  if (kind === 'computer' && compatibility
    && identity.requested === IMAGE_CATALOG.presets[compatibility].image.requested) {
    await buildBundledPreset(compatibility, identity.requested, false);
    return true;
  }
  if (kind === 'computer' && compatibility === 'workstation' && identity.requested === 'qubicl/computer:dev') {
    await buildBundledPreset('workstation', identity.requested, false);
    return true;
  }
  return false;
}

async function rebuildLegacyDevelopmentComputer(identity: ImageIdentity, compatibility: Preset | undefined): Promise<boolean> {
  if (!IMAGE_CATALOG.development || compatibility !== 'workstation' || identity.requested !== 'qubicl/computer:dev') return false;
  await buildBundledPreset('workstation', identity.requested, false);
  return true;
}

export async function probeBindMount(stateRoot: string, image: string, _stderr = false): Promise<void> {
  const parent = await nearestExistingDirectory(stateRoot);
  const temporary = await mkdtemp(join(parent, '.qubicl-bind-probe-'));
  const probeDirectory = join(temporary, 'mount');
  const probe = join(probeDirectory, 'probe.txt');
  const composePath = join(temporary, 'compose.yaml');
  const suffix = uniqueProbeSuffix();
  const projectName = `qubicl-probe-${suffix}`;
  const probeName = `qubicl-bind-probe-${suffix}`;
  try {
    await mkdir(probeDirectory, { mode: 0o700 });
    await atomicWrite(probe, 'qubicl-bind-probe\n', 0o600);
    await writeFile(composePath, YAML.stringify({
      name: projectName,
      services: {
        probe: bindMountProbeService(image, probeDirectory),
      },
    }), { mode: 0o600 });
    await docker([
      'compose', '--project-name', projectName, '--file', composePath,
      'run', '--name', probeName, '--rm', '--no-deps', 'probe',
    ], { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_OUTPUT_LIMIT_BYTES });
  } catch (error) {
    throw new Error(`Docker could not bind-mount the Qubicl state filesystem. Check Docker Desktop file sharing and host permissions. ${errorMessage(error)}`);
  } finally {
    await removeProbeContainer(probeName);
    await docker(['compose', '--project-name', projectName, '--file', composePath, 'down', '--remove-orphans'], {
      allowFailure: true,
      timeoutMs: PROBE_CLEANUP_TIMEOUT_MS,
      maxOutputBytes: PROBE_CLEANUP_OUTPUT_LIMIT_BYTES,
    }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

export function bindMountProbeService(image: string, source: string) {
  const { uid, gid } = hostIdentity();
  return {
    image,
    user: `${uid}:${gid}`,
    pull_policy: 'never',
    network_mode: 'none',
    read_only: true,
    cpus: Number(PROBE_CPUS),
    mem_limit: PROBE_MEMORY,
    memswap_limit: PROBE_MEMORY,
    pids_limit: 64,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    entrypoint: bindMountProbeEntrypoint(),
    volumes: [{ type: 'bind', source, target: '/probe', read_only: true }],
  };
}

function bindMountProbeEntrypoint(): string[] {
  // Compose replaces $$ with a literal $ before the command reaches the
  // container. Docker Desktop on WSL can expose a newly created bind source a
  // moment after container creation, so retry for two seconds before failing.
  return [
    '/bin/sh',
    '-ceu',
    'attempt=0; while [ "$$attempt" -lt 20 ]; do if [ "$$(cat /probe/probe.txt 2>/dev/null || true)" = qubicl-bind-probe ]; then exit 0; fi; attempt=$$((attempt + 1)); sleep 0.1; done; cat /probe/probe.txt',
  ];
}

function uniqueProbeSuffix(): string {
  return `${process.pid}-${randomBytes(6).toString('hex')}`;
}

async function removeProbeContainer(name: string): Promise<void> {
  await docker(['rm', '--force', name], {
    allowFailure: true,
    timeoutMs: PROBE_CLEANUP_TIMEOUT_MS,
    maxOutputBytes: PROBE_CLEANUP_OUTPUT_LIMIT_BYTES,
  }).catch(() => undefined);
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = resolve(path);
  for (;;) {
    try {
      const info = await lstat(candidate);
      if (!info.isDirectory()) throw new Error(`${candidate} is not a real directory.`);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`Could not find an existing parent for ${path}.`);
      candidate = parent;
    }
  }
}

export async function dockerDiskUsage(): Promise<string> {
  return docker(['system', 'df']);
}

export async function startGateway(state: LoadedState): Promise<void> {
  await assertGatewayPorts(state);
  await compose(state, ['up', '--detach', '--no-deps', 'gateway']);
  await waitForContainerHealthy(gatewayContainerName(state.config.installationId, state.paths.root), 'Gateway');
}

export async function verifyGatewayCompatibility(
  state: LoadedState,
  skipComputerIds: readonly string[] = [],
  options: { allowUnavailableExposure?: boolean } = {},
): Promise<void> {
  const routes = RuntimeRoutesSchema.parse(JSON.parse(await readFile(state.paths.routes, 'utf8')));
  if (routes.routes.some(({ viewerAuthentication }) => viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1)
    || state.config.gateway.exposure) {
    const response = await fetchGatewayHealthWithRuntimeRecovery(state);
    if (!response.ok) throw new Error(`Gateway capability check failed with HTTP ${response.status}.`);
    const health = await response.json();
    if (routes.routes.some(({ viewerAuthentication }) => viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1)) {
      assertGatewayHealthCompatibility(health);
    }
    if (state.config.gateway.exposure) {
      const external = (health as { external?: unknown } | null)?.external as {
        configured?: unknown;
        ready?: unknown;
        protocol?: unknown;
      } | undefined;
      const knownUnavailable = external?.configured === true
        && external.ready === false
        && external.protocol === 'direct-tls-v1';
      if (!knownUnavailable || !options.allowUnavailableExposure) {
        assertGatewayExposureHealth(
          health,
          gatewayExposureRuntimeId(gatewayExposureRuntime(state.config.gateway.exposure)),
        );
      }
    }
  }
  // Compose may recreate the shared gateway for an image, port, label, or
  // binary-version change from any lifecycle command. Reattach every running
  // computer after the capability gate; stopped computers remain untouched.
  const skipped = new Set(skipComputerIds);
  for (const computer of state.config.computers) {
    if (skipped.has(computer.id)) continue;
    const runtime = await managedComputerRuntimeObservation(state, computer);
    if (runtime.group === 'partial' || runtime.group === 'inconsistent') {
      throw new Error(`Computer ${computer.name} runtime is ${runtime.group}; gateway reconnection cannot be verified.`);
    }
    if (runtime.group === 'complete' && runtime.status === 'running') {
      await connectComputerToGateway(state, computer);
    }
  }
}

async function fetchGatewayHealth(port: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GATEWAY_HEALTH_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(GATEWAY_HEALTH_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (attempt < GATEWAY_HEALTH_ATTEMPTS) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, GATEWAY_HEALTH_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

async function fetchGatewayHealthWithRuntimeRecovery(state: LoadedState): Promise<Response> {
  try {
    return await fetchGatewayHealth(state.config.gateway.port);
  } catch (initialError) {
    const name = gatewayContainerName(state.config.installationId, state.paths.root);
    await docker(['restart', name]);
    await waitForContainerHealthy(name, 'Gateway');
    try {
      return await fetchGatewayHealth(state.config.gateway.port);
    } catch (recoveryError) {
      throw new Error('Gateway loopback health remained unavailable after restarting the managed gateway once.', {
        cause: recoveryError ?? initialError,
      });
    }
  }
}

export function assertGatewayExposureHealth(value: unknown, expectedConfigurationId?: string): void {
  const external = (value as { external?: unknown } | null)?.external as {
    configured?: unknown;
    ready?: unknown;
    protocol?: unknown;
    configurationId?: unknown;
  } | undefined;
  if (!external || external.configured !== true || external.ready !== true || external.protocol !== 'direct-tls-v1') {
    throw new Error('Running gateway did not confirm the configured direct TLS listener; the exposure transaction remains pending recovery.');
  }
  if (expectedConfigurationId !== undefined && external.configurationId !== expectedConfigurationId) {
    throw new Error('Running gateway confirmed a different direct TLS configuration; the exposure transaction remains pending recovery.');
  }
}

export function assertGatewayHealthCompatibility(value: unknown): void {
  const health = value as { protocolVersion?: unknown; viewerAuthentication?: unknown } | null;
  if (!health || health.protocolVersion !== GATEWAY_PROTOCOL_VERSION
    || health.viewerAuthentication !== VIEWER_AUTHENTICATION_HEADER_V1) {
    throw new Error(`Running gateway does not support authenticated viewer routing (expected protocol ${GATEWAY_PROTOCOL_VERSION} and ${VIEWER_AUTHENTICATION_HEADER_V1}).`);
  }
}

export async function portAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(port, host, () => server.close(() => resolvePromise(true)));
  });
}

export async function assertGatewayPort(state: LoadedState): Promise<void> {
  if (await portAvailable(state.config.gateway.port)) return;
  try {
    const published = await docker(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "3211/tcp") 0).HostPort}}', gatewayContainerName(state.config.installationId, state.paths.root)]);
    if (Number.parseInt(published, 10) === state.config.gateway.port) return;
  } catch { /* a different process owns the port */ }
  throw new Error(`Gateway port 127.0.0.1:${state.config.gateway.port} is already in use. Choose another with --gateway-port.`);
}

export async function assertGatewayPorts(state: LoadedState): Promise<void> {
  await assertGatewayPort(state);
  const exposure = state.config.gateway.exposure;
  if (!exposure) return;
  if (exposure.port === state.config.gateway.port) {
    throw new Error(`External TLS port ${exposure.port} must differ from the local gateway port.`);
  }
  if (await portAvailable(exposure.port, exposure.bindAddress)) return;
  try {
    const inspected = JSON.parse(await docker([
      'container', 'inspect', gatewayContainerName(state.config.installationId, state.paths.root),
    ])) as Array<{ HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> } }>;
    const bindings = inspected[0]?.HostConfig?.PortBindings?.[`${GATEWAY_EXTERNAL_CONTAINER_PORT}/tcp`] ?? [];
    if (bindings.length === 1
      && bindings[0]?.HostIp === exposure.bindAddress
      && Number(bindings[0]?.HostPort) === exposure.port) return;
  } catch { /* a different process owns the configured external port */ }
  throw new Error(`Gateway TLS port ${exposure.bindAddress}:${exposure.port} is already in use.`);
}

export interface GatewayExternalPublication {
  hostIp?: string;
  hostPort?: number;
  target?: 'external-tls' | 'local-http' | 'unexpected';
  verificationIssue?:
    | 'publish-all-ports'
    | 'host-runtime-mismatch'
    | 'unsafe-local-publication'
    | 'ambiguous-publication'
    | 'unexpected-publication';
  detail?: string;
}

interface GatewayPublicationInspection {
  State?: { Running?: boolean };
  HostConfig?: {
    PublishAllPorts?: boolean;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null | undefined>;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null | undefined>;
  };
}

export function gatewayExternalPublicationFromInspection(
  inspection: GatewayPublicationInspection,
  expectedLocalPort?: number,
): GatewayExternalPublication | undefined {
  const target = `${GATEWAY_EXTERNAL_CONTAINER_PORT}/tcp`;
  const planned = singleGatewayPublication(inspection.HostConfig?.PortBindings?.[target], 'configured');
  const actual = singleGatewayPublication(inspection.NetworkSettings?.Ports?.[target], 'observed');
  const running = inspection.State?.Running === true;
  const publishAllPorts = inspection.HostConfig?.PublishAllPorts === true;
  const localTarget = '3211/tcp';
  const plannedLocal = expectedLocalPort === undefined
    ? undefined
    : singleGatewayPublication(inspection.HostConfig?.PortBindings?.[localTarget], 'configured local HTTP');
  const actualLocal = expectedLocalPort === undefined
    ? undefined
    : singleGatewayPublication(inspection.NetworkSettings?.Ports?.[localTarget], 'observed local HTTP');
  const expectedLocal = expectedLocalPort === undefined
    ? undefined
    : { hostIp: '127.0.0.1', hostPort: expectedLocalPort };
  if (planned?.verificationIssue || actual?.verificationIssue) {
    return { ...(actual?.verificationIssue ? actual : planned!), target: 'external-tls' };
  }
  if (plannedLocal?.verificationIssue || actualLocal?.verificationIssue) {
    return { ...(actualLocal?.verificationIssue ? actualLocal : plannedLocal!), target: 'local-http' };
  }
  const localVerified = expectedLocalPort === undefined
    || (sameGatewayPublication(plannedLocal, expectedLocal)
      && (running ? sameGatewayPublication(actualLocal, expectedLocal) : actualLocal === undefined));
  if (publishAllPorts) {
    const publication = actual ?? planned ?? actualLocal ?? plannedLocal ?? expectedLocal;
    return {
      ...publication,
      target: actual || planned ? 'external-tls' : actualLocal || plannedLocal ? 'local-http' : 'unexpected',
      verificationIssue: 'publish-all-ports',
      ...(!publication ? { detail: 'Docker PublishAllPorts is enabled without an identifiable publication.' } : {}),
    };
  }
  const unexpectedTargets = new Set<string>();
  for (const [unexpectedTarget, bindings] of Object.entries(inspection.HostConfig?.PortBindings ?? {})) {
    if (![target, localTarget].includes(unexpectedTarget) && (bindings?.length ?? 0) > 0) {
      unexpectedTargets.add(unexpectedTarget);
    }
  }
  for (const [unexpectedTarget, bindings] of Object.entries(inspection.NetworkSettings?.Ports ?? {})) {
    if (![target, localTarget].includes(unexpectedTarget) && (bindings?.length ?? 0) > 0) {
      unexpectedTargets.add(unexpectedTarget);
    }
  }
  if (unexpectedTargets.size > 0) {
    return {
      target: 'unexpected',
      verificationIssue: 'unexpected-publication',
      detail: `Unexpected gateway target publication(s): ${[...unexpectedTargets].sort().join(', ')}.`,
    };
  }
  let external: GatewayExternalPublication | undefined;
  if (!running && planned && !actual) external = planned;
  else if (!running && !planned && !actual) external = undefined;
  else if (sameGatewayPublication(planned, actual)) external = actual ?? planned;
  else {
    const publication = actual ?? planned;
    if (publication) external = { ...publication, verificationIssue: 'host-runtime-mismatch' };
  }
  if (!localVerified) {
    const publication = external ?? actualLocal ?? plannedLocal ?? expectedLocal!;
    return {
      ...publication,
      target: external ? 'external-tls' : 'local-http',
      verificationIssue: 'unsafe-local-publication',
    };
  }
  return external;
}

export async function inspectGatewayExternalPublication(state: LoadedState): Promise<GatewayExternalPublication | undefined> {
  const name = gatewayContainerName(state.config.installationId, state.paths.root);
  const inspected = JSON.parse(await docker(['container', 'inspect', name])) as Array<{
    Name?: unknown;
    State?: { Running?: boolean };
    HostConfig?: {
      PublishAllPorts?: boolean;
      PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
    };
    NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
  }>;
  if (inspected.length !== 1 || inspected[0]?.Name !== `/${name}`) {
    throw new Error(`Docker returned an ambiguous gateway inspection while checking external publication for ${name}.`);
  }
  return gatewayExternalPublicationFromInspection(inspected[0], state.config.gateway.port);
}

function singleGatewayPublication(
  bindings: Array<{ HostIp?: string; HostPort?: string }> | null | undefined,
  label: string,
): GatewayExternalPublication | undefined {
  if (!bindings?.length) return undefined;
  if (bindings.length !== 1 || typeof bindings[0]?.HostIp !== 'string' || !/^\d+$/u.test(bindings[0].HostPort ?? '')) {
    return {
      verificationIssue: 'ambiguous-publication',
      detail: `Gateway has ambiguous ${label} port publications.`,
    };
  }
  const hostPort = Number(bindings[0].HostPort);
  if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
    return {
      verificationIssue: 'ambiguous-publication',
      detail: `Gateway ${label} publication has an invalid host port.`,
    };
  }
  return { hostIp: bindings[0].HostIp, hostPort };
}

function sameGatewayPublication(
  left: GatewayExternalPublication | undefined,
  right: GatewayExternalPublication | undefined,
): boolean {
  return left === undefined && right === undefined
    || left !== undefined && right !== undefined
      && left.verificationIssue === undefined && right.verificationIssue === undefined
      && left.hostIp !== undefined && left.hostPort !== undefined
      && left.hostIp === right.hostIp && left.hostPort === right.hostPort;
}

export async function startComputer(state: LoadedState, computer: ComputerConfig): Promise<void> {
  await startGateway(state);
  await verifyGatewayCompatibility(state);
  await startComputerPreservingRuntimeAfterGateway(state, computer);
}

export async function startComputerPreservingRuntimeAfterGateway(state: LoadedState, computer: ComputerConfig): Promise<void> {
  const status = await containerStatus(state, computer.id);
  const complete = await computerRuntimeGroupComplete(state, computer);
  if (!complete) {
    await startComputerAfterGateway(state, computer);
    return;
  }
  const action = retainedComputerStartAction(status.status);
  if (action === 'create') {
    await startComputerAfterGateway(state, computer);
    return;
  }
  if (action === 'unpause') {
    await docker(['unpause', ...computerRuntimeContainerNames(state, computer)]);
  } else if (action === 'start') {
    // Starting the retained container does not require its original image to
    // remain inspectable. This preserves ordinary stop -> start for source
    // computers after their mutable development tag has been rebuilt.
    await docker(['start', ...computerRuntimeContainerNames(state, computer).toReversed()]);
  }
  await connectComputerToGateway(state, computer);
  await waitForHealthy(state, computer.id);
  await waitForGatewayComputer(state, computer.id);
}

export function retainedComputerStartAction(status: string): 'create' | 'unpause' | 'start' | 'none' {
  if (status === 'absent') return 'create';
  if (status === 'paused') return 'unpause';
  if (status === 'running' || status === 'restarting') return 'none';
  return 'start';
}

export async function startComputerAfterGateway(state: LoadedState, computer: ComputerConfig): Promise<void> {
  await compose(state, ['up', '--detach', computerServiceName(state, computer)]);
  await connectComputerToGateway(state, computer);
  await waitForHealthy(state, computer.id);
  await waitForGatewayComputer(state, computer.id);
}

export async function reconnectComputerAfterGateway(state: LoadedState, computer: ComputerConfig): Promise<void> {
  const runtime = await managedComputerRuntimeObservation(state, computer);
  if (runtime.group === 'partial' || runtime.group === 'inconsistent') {
    throw new Error(`Computer ${computer.name} runtime is ${runtime.group}; refusing to complete gateway reconnection.`);
  }
  if (runtime.group !== 'complete' || runtime.status !== 'running') {
    console.warn(`Computer ${computer.name} was running before the gateway change but is now ${runtime.status}; it was left stopped. Its identity and home are unchanged. Run qubicl start ${computer.name}; only a missing retained container requires the exact pinned image.`);
    return;
  }
  await connectComputerToGateway(state, computer);
  await waitForHealthy(state, computer.id);
  await waitForGatewayComputer(state, computer.id);
}

async function connectComputerToGateway(state: LoadedState, computer: ComputerConfig): Promise<void> {
  try {
    await docker(['network', 'connect', controlNetwork(state.config.installationId, computer.id, state.paths.root), gatewayContainerName(state.config.installationId, state.paths.root)]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already exists in network')) throw error;
  }
}

export async function removeComputerRuntime(
  state: LoadedState,
  id: string,
  options: { preserveControlNetwork?: boolean } = {},
): Promise<void> {
  const computer = state.config.computers.find((candidate) => candidate.id === id);
  if (computer) {
    const existing = new Set<string>();
    for (const name of computerRuntimeContainerNames(state, computer)) {
      if (await docker(['inspect', '--format', '{{.Id}}', name], { allowFailure: true })) existing.add(name);
    }
    // An upgrade from topology 5 changes the configured protocol before the
    // replacement runtime is removed. Find every verified legacy sidecar by
    // labels as well so the rolling conversion cannot strand containers.
    const legacy = (await docker([
      'ps', '--all', '--format', '{{.Names}}',
      '--filter', `label=dev.qubicl.installation=${state.config.installationId}`,
      '--filter', `label=dev.qubicl.computer-id=${id}`,
    ], { allowFailure: true })).split('\n').filter(Boolean);
    for (const name of legacy) existing.add(name);
    if (existing.size) await docker(['rm', '--force', ...existing]);
  } else {
    const primary = (await docker([
      'ps', '--all', '--quiet',
      '--filter', `label=dev.qubicl.installation=${state.config.installationId}`,
      '--filter', `label=dev.qubicl.id=${id}`,
      '--filter', 'label=dev.qubicl.role=computer',
    ], { allowFailure: true })).split('\n').filter(Boolean);
    const sidecars = (await docker([
      'ps', '--all', '--quiet',
      '--filter', `label=dev.qubicl.installation=${state.config.installationId}`,
      '--filter', `label=dev.qubicl.computer-id=${id}`,
    ], { allowFailure: true })).split('\n').filter(Boolean);
    const runtimes = [...new Set([...primary, ...sidecars])];
    if (runtimes.length) await docker(['rm', '--force', ...runtimes]);
  }
  const network = controlNetwork(state.config.installationId, id, state.paths.root);
  // Plain `docker network inspect` prints `[]` on stdout when the network is
  // absent, even though it exits non-zero. Ask for the ID so absence remains
  // an empty result and deleting a never-started computer stays idempotent.
  const networkExists = await docker(['network', 'inspect', '--format', '{{.Id}}', network], { allowFailure: true });
  if (networkExists && !options.preserveControlNetwork) {
    await docker(['network', 'disconnect', '--force', network, gatewayContainerName(state.config.installationId, state.paths.root)], { allowFailure: true });
    await docker(['network', 'rm', network]);
  }
  const workspace = workspaceNetwork(state.config.installationId, id, state.paths.root);
  if (await docker(['network', 'inspect', '--format', '{{.Id}}', workspace], { allowFailure: true })) {
    await docker(['network', 'rm', workspace]);
  }
  const display = displaySocketVolume(state.config.installationId, id, state.paths.root);
  if (await docker(['volume', 'inspect', '--format', '{{.Name}}', display], { allowFailure: true })) {
    await docker(['volume', 'rm', display]);
  }
}

async function computerRuntimeGroupComplete(state: LoadedState, computer: ComputerConfig): Promise<boolean> {
  for (const name of computerRuntimeContainerNames(state, computer)) {
    if (!await docker(['inspect', '--format', '{{.Id}}', name], { allowFailure: true })) return false;
  }
  return true;
}

export async function containerStatus(state: LoadedState, id: string): Promise<{ status: string; health?: string }> {
  return runtimeContainerStatus(configuredComputerRuntimeName(state, id));
}

export async function gatewayStatus(state: LoadedState): Promise<{ status: string; health?: string }> {
  return runtimeContainerStatus(gatewayContainerName(state.config.installationId, state.paths.root));
}

export interface ManagedRuntimeGroupObservation {
  status: string;
  group: 'complete' | 'absent' | 'partial' | 'inconsistent';
  containers: RuntimeContainerBinding[];
}

export interface ManagedRuntimeObservationAdapter {
  docker(args: string[], options?: RunOptions): Promise<string>;
  inspectContainer(reference: string, expectedName?: string): Promise<RuntimeInspection | undefined>;
}

export type LifecycleDockerRunner = (args: string[], options?: RunOptions) => Promise<string>;

/**
 * Container-only lifecycle inspection. Only Docker's exact not-found response
 * is absence; daemon, permission, timeout, truncation, and malformed-output
 * failures remain errors so an upgrade cannot silently infer an absent runtime.
 */
export async function strictLifecycleContainerInspection(
  reference: string,
  runDocker: LifecycleDockerRunner = docker,
  expectedName = reference,
): Promise<RuntimeInspection | undefined> {
  if (!validDockerName(reference) || !validDockerName(expectedName)) {
    throw new Error(`Lifecycle inspection received an invalid Docker reference or name.`);
  }
  let output: string;
  try {
    output = await runDocker(['container', 'inspect', reference], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_OUTPUT_LIMIT_BYTES,
    });
  } catch (error) {
    if (exactContainerNotFound(error, reference)) return undefined;
    throw new Error(`Could not inspect managed container ${expectedName}; refusing to infer absence: ${errorMessage(error)}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error(`Docker container inspection for ${expectedName} returned invalid JSON.`, { cause: error });
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`Docker container inspection for ${expectedName} did not return exactly one container.`);
  }
  const inspection = value[0];
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
    throw new Error(`Docker container inspection for ${expectedName} returned a non-object entry.`);
  }
  const record = inspection as RuntimeInspection;
  if (!record.Id || !/^[a-f0-9]{64}$/.test(record.Id)) {
    throw new Error(`Docker container inspection for ${expectedName} omitted its full container ID.`);
  }
  if (/^[a-f0-9]{64}$/.test(reference) && record.Id !== reference) {
    throw new Error(`Docker container inspection for ${expectedName} substituted immutable container ID ${record.Id}.`);
  }
  if (record.Name !== expectedName && record.Name !== `/${expectedName}`) {
    throw new Error(`Docker container inspection for ${expectedName} returned a different container name ${JSON.stringify(record.Name)}.`);
  }
  if (!record.State || typeof record.State.Status !== 'string' || !record.State.Status) {
    throw new Error(`Docker container inspection for ${expectedName} omitted its runtime status.`);
  }
  if (!record.Image || !/^sha256:[a-f0-9]{64}$/.test(record.Image)) {
    throw new Error(`Docker container inspection for ${expectedName} omitted its immutable image ID.`);
  }
  if (record.State.Health !== undefined
    && (typeof record.State.Health !== 'object'
      || typeof record.State.Health.Status !== 'string'
      || !record.State.Health.Status)) {
    throw new Error(`Docker container inspection for ${expectedName} returned invalid health status.`);
  }
  return record;
}

export async function strictLifecycleRuntimeStatus(
  name: string,
  runDocker: LifecycleDockerRunner = docker,
): Promise<{ status: string; health?: string }> {
  const inspection = await strictLifecycleContainerInspection(name, runDocker);
  if (!inspection) return { status: 'absent' };
  const status = inspection.State!.Status!;
  const health = inspection.State!.Health?.Status;
  return { status, ...(health ? { health } : {}) };
}

/** Read-only inventory of the exact managed runtime group for upgrade planning. */
export async function managedComputerRuntimeObservation(
  state: LoadedState,
  computer: ComputerConfig,
  adapter: ManagedRuntimeObservationAdapter = defaultManagedRuntimeObservationAdapter(),
): Promise<ManagedRuntimeGroupObservation> {
  const expectedRoles = expectedComputerRuntimeRoles(state, computer);
  const actualInventory = await labeledComputerRuntimeInventory(state, computer.id, adapter);
  const actualByName = new Map(actualInventory.map((binding) => [binding.name, binding]));
  const containers: RuntimeContainerBinding[] = [];
  for (const inventory of actualInventory) {
    const inspection = await adapter.inspectContainer(inventory.id, inventory.name);
    if (!inspection) throw new Error(`Managed runtime container ${inventory.name} disappeared during immutable-ID inspection.`);
    const expectedRole = expectedRoles.get(inventory.name);
    if (!expectedRole) {
      return { status: inspection.State!.Status!, group: 'inconsistent', containers: [] };
    }
    assertExpectedComputerRuntimeInspection(state, computer, inventory.name, expectedRole, inspection);
    containers.push(runtimeBinding(inspection, inventory.name));
  }
  for (const name of expectedRoles.keys()) {
    if (actualByName.has(name)) continue;
    const inspection = await adapter.inspectContainer(name, name);
    if (inspection) return { status: inspection.State!.Status!, group: 'inconsistent', containers: [] };
  }
  if (containers.length === 0) return { status: 'absent', group: 'absent', containers: [] };
  containers.sort((left, right) => compareRuntimeBindingNames(expectedRoles, left.name, right.name));
  const primary = containers.find(({ name }) => name === computerContainerName(state, computer));
  const primaryStatus = primary?.status ?? containers[0]!.status;
  if (containers.length !== expectedRoles.size) return { status: primaryStatus, group: 'partial', containers };
  if (new Set(containers.map(({ status }) => status)).size !== 1) {
    return { status: primaryStatus, group: 'inconsistent', containers };
  }
  return { status: primaryStatus, group: 'complete', containers };
}

/** Read-only gateway ownership/status observation for upgrade planning. */
export async function managedGatewayRuntimeObservation(
  state: LoadedState,
  adapter: ManagedRuntimeObservationAdapter = defaultManagedRuntimeObservationAdapter(),
): Promise<ManagedRuntimeGroupObservation> {
  const name = gatewayContainerName(state.config.installationId, state.paths.root);
  const inspection = await adapter.inspectContainer(name, name);
  if (!inspection) return { status: 'absent', group: 'absent', containers: [] };
  try {
    verifyManagedGateway(state, inspection, name);
  } catch {
    return { status: inspection.State!.Status!, group: 'inconsistent', containers: [] };
  }
  return { status: inspection.State!.Status!, group: 'complete', containers: [runtimeBinding(inspection, name)] };
}

/**
 * Recovery-safe stopped gateway replacement. The transaction journal remains
 * until the newly rendered service exists in a non-running state.
 */
export async function replaceStoppedGatewayRuntime(
  state: LoadedState,
  binding: readonly RuntimeContainerBinding[] = [],
): Promise<void> {
  const name = gatewayContainerName(state.config.installationId, state.paths.root);
  const source = await inspectBoundGatewayTransition(state, binding, 'stopped', 'replace');
  if (source) {
    await docker(['rm', source.id]);
  }
  await assertGatewayPorts(state);
  await compose(state, ['create', '--no-deps', 'gateway']);
  const replacement = await strictLifecycleContainerInspection(name);
  if (!replacement) throw new Error('Stopped gateway replacement was not created.');
  verifyManagedGateway(state, replacement, name);
  assertStoppedReplacementStatus(replacement.State?.Status ?? 'unknown', 'Replacement gateway');
}

/**
 * Recovery-safe stopped computer replacement. Every discovered member must
 * retain the exact installation/computer labels and be non-running.
 */
export async function replaceStoppedComputerRuntime(
  state: LoadedState,
  computer: ComputerConfig,
  binding: readonly RuntimeContainerBinding[] = [],
): Promise<void> {
  await removeComputerRuntimeForLifecycleReplacement(state, computer, binding, true);
  await compose(state, ['create', computerServiceName(state, computer)]);
  const replacement = await managedComputerRuntimeObservation(state, computer);
  if (replacement.group !== 'complete') {
    throw new Error(`Stopped replacement for ${computer.name} is ${replacement.group}.`);
  }
  assertStoppedReplacementStatus(replacement.status, `Replacement computer ${computer.name}`);
}

export async function assertGatewayRuntimeBinding(
  state: LoadedState,
  binding: readonly RuntimeContainerBinding[],
  runDocker: LifecycleDockerRunner = docker,
): Promise<void> {
  await inspectBoundGatewayTransition(state, binding, 'running', 'assert', runDocker);
}

export async function removeGatewayRuntimeForLifecycleReplacement(
  state: LoadedState,
  binding: readonly RuntimeContainerBinding[],
  requireStopped: boolean,
  runDocker: LifecycleDockerRunner = docker,
): Promise<void> {
  const source = await inspectBoundGatewayTransition(
    state,
    binding,
    requireStopped ? 'stopped' : 'running',
    'replace',
    runDocker,
  );
  if (source) await runDocker(['rm', ...(requireStopped ? [] : ['--force']), source.id]);
}

/**
 * Removes only immutable source IDs captured in the reviewed lifecycle plan.
 * Recovery also accepts absent source members and independently verified
 * target members so interruption after removal/create can roll forward.
 */
export async function removeComputerRuntimeForLifecycleReplacement(
  state: LoadedState,
  computer: ComputerConfig,
  sourceBinding: readonly RuntimeContainerBinding[],
  requireStopped: boolean,
  adapter: ManagedRuntimeObservationAdapter = defaultManagedRuntimeObservationAdapter(),
): Promise<void> {
  if (sourceBinding.length === 0) {
    const target = await managedComputerRuntimeObservation(state, computer, adapter);
    if (target.group === 'absent') return;
    const desired = requireStopped ? 'stopped' : 'running';
    if ((target.group === 'complete' || target.group === 'partial')
      && Boolean(computer.image.contentId)
      && target.containers.every((container) => container.imageId === computer.image.contentId
        && allowedTransitionStatus(container.status, desired, true))) {
      // An old journal may recover only when the exact owned target is already
      // present; Compose can then finish it idempotently without deletion.
      return;
    }
    throw new Error(`Lifecycle journal for ${computer.name} has no immutable source binding; refusing mutable-name deletion. Restore or remove only the verified old runtime, then retry recovery.`);
  }
  const transition = await inspectComputerRuntimeTransition(
    state,
    computer,
    sourceBinding,
    requireStopped ? 'stopped' : 'running',
    adapter,
  );
  if (transition.sourceIds.length) {
    await adapter.docker(['rm', ...(requireStopped ? [] : ['--force']), ...transition.sourceIds]);
  }
}

async function runtimeContainerStatus(name: string): Promise<{ status: string; health?: string }> {
  try {
    const value = await docker(['inspect', '--format', '{{json .State}}', name]);
    const state = JSON.parse(value) as { Status?: string; Health?: { Status?: string } };
    const result: { status: string; health?: string } = { status: state.Status ?? 'unknown' };
    if (state.Health?.Status) result.health = state.Health.Status;
    return result;
  } catch { return { status: 'absent' }; }
}

interface ManagedRuntimeInventoryIdentity {
  id: string;
  name: string;
}

async function labeledComputerRuntimeInventory(
  state: LoadedState,
  id: string,
  adapter: ManagedRuntimeObservationAdapter,
): Promise<ManagedRuntimeInventoryIdentity[]> {
  const options = { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: PROBE_OUTPUT_LIMIT_BYTES };
  const primary = parseManagedRuntimeInventory(await adapter.docker([
    'container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}',
    '--filter', `label=dev.qubicl.installation=${state.config.installationId}`,
    '--filter', `label=dev.qubicl.id=${id}`,
  ], options), 'primary computer runtime inventory');
  const sidecars = parseManagedRuntimeInventory(await adapter.docker([
    'container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}',
    '--filter', `label=dev.qubicl.installation=${state.config.installationId}`,
    '--filter', `label=dev.qubicl.computer-id=${id}`,
  ], options), 'computer sidecar runtime inventory');
  const combined = [...primary, ...sidecars];
  if (new Set(combined.map(({ id: containerId }) => containerId)).size !== combined.length
    || new Set(combined.map(({ name }) => name)).size !== combined.length) {
    throw new Error('Managed computer runtime inventory returned overlapping or duplicate immutable identities.');
  }
  return combined.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseManagedRuntimeInventory(output: string, subject: string): ManagedRuntimeInventoryIdentity[] {
  const lines = output.split('\n').map((value) => value.trim()).filter(Boolean);
  if (lines.length > 1_024) throw new Error(`${subject} returned too many containers.`);
  const values = lines.map((line) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) { throw new Error(`${subject} returned invalid JSON inventory metadata.`, { cause: error }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${subject} returned a non-object inventory record.`);
    }
    const record = value as { ID?: unknown; Names?: unknown };
    if (typeof record.ID !== 'string' || !/^[a-f0-9]{64}$/.test(record.ID)
      || typeof record.Names !== 'string' || !validDockerName(record.Names)) {
      throw new Error(`${subject} returned invalid immutable container identity metadata.`);
    }
    return { id: record.ID, name: record.Names };
  });
  if (new Set(values.map(({ id }) => id)).size !== values.length
    || new Set(values.map(({ name }) => name)).size !== values.length) {
    throw new Error(`${subject} returned duplicate immutable container identities.`);
  }
  return values;
}

function defaultManagedRuntimeObservationAdapter(): ManagedRuntimeObservationAdapter {
  return {
    docker,
    inspectContainer: (reference, expectedName = reference) => strictLifecycleContainerInspection(reference, docker, expectedName),
  };
}

function validDockerName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name);
}

function exactContainerNotFound(error: unknown, name: string): boolean {
  const match = errorMessage(error).match(/No such (?:container|object): ([^\r\n]+)\s*$/i);
  return match?.[1]?.trim() === name;
}

type ComputerRuntimeRole = Exclude<RuntimeContainerBinding['role'], 'gateway'>;

interface ExpectedComputerRuntimeRole {
  role: ComputerRuntimeRole;
  topologyVersion?: string;
}

function expectedComputerRuntimeRoles(
  state: LoadedState,
  computer: ComputerConfig,
): Map<string, ExpectedComputerRuntimeRole> {
  const primary = computerContainerName(state, computer);
  const roles = new Map<string, ComputerRuntimeRole>([
    [primary, 'computer'],
    [computerExecutorContainerName(state, computer), 'computer-executor'],
    [computerEgressContainerName(state, computer), 'computer-egress'],
    [computerWebContainerName(state, computer), 'computer-web'],
    [computerSessionContainerName(state, computer), 'computer-session'],
    [computerSshContainerName(state, computer), 'computer-ssh'],
  ]);
  return new Map(computerRuntimeContainerNames(state, computer).map((name) => {
    const role = roles.get(name);
    if (!role) throw new Error(`Qubicl computed an unknown lifecycle runtime role for ${name}.`);
    return [name, {
      role,
      ...(role === 'computer'
        ? { topologyVersion: usesUnifiedComputerRuntime(computer) ? COMPUTER_RUNTIME_TOPOLOGY_VERSION : '5' }
        : {}),
    }];
  }));
}

function assertExpectedComputerRuntimeInspection(
  state: LoadedState,
  computer: ComputerConfig,
  name: string,
  expected: ExpectedComputerRuntimeRole,
  inspection: RuntimeInspection,
): void {
  assertComputerBindingOwnership(state, computer.id, name, expected.role, expected.topologyVersion, inspection);
  if (expected.role === 'computer') {
    verifyManagedComputer(state, computer.id, inspection, name);
    if (inspection.Config?.Labels?.['dev.qubicl.name'] !== computer.name) {
      throw new Error(`Managed computer runtime ${name} has an unexpected configured-name binding.`);
    }
  }
}

function assertComputerBindingOwnership(
  state: LoadedState,
  computerId: string,
  name: string,
  expectedRole: ComputerRuntimeRole,
  topologyVersion: string | undefined,
  inspection: RuntimeInspection,
): void {
  const labels = inspection.Config?.Labels ?? {};
  const primary = expectedRole === 'computer';
  if (labels['dev.qubicl.installation'] !== state.config.installationId
    || labels['dev.qubicl.role'] !== expectedRole
    || labels[primary ? 'dev.qubicl.id' : 'dev.qubicl.computer-id'] !== computerId
    || labels[primary ? 'dev.qubicl.computer-id' : 'dev.qubicl.id'] !== undefined
    || (topologyVersion !== undefined && labels['dev.qubicl.topology-version'] !== topologyVersion)) {
    throw new Error(`Managed runtime container ${name} has an unexpected immutable ownership, role, or topology binding.`);
  }
}

function runtimeBinding(inspection: RuntimeInspection, name: string): RuntimeContainerBinding {
  const role = inspection.Config?.Labels?.['dev.qubicl.role'];
  if (!['gateway', 'computer', 'computer-executor', 'computer-egress', 'computer-web', 'computer-session', 'computer-ssh'].includes(role ?? '')) {
    throw new Error(`Managed runtime container ${name} has an invalid role binding.`);
  }
  const topologyVersion = inspection.Config?.Labels?.['dev.qubicl.topology-version'];
  return {
    name,
    id: inspection.Id!,
    status: inspection.State!.Status!,
    imageId: inspection.Image! as `sha256:${string}`,
    role: role as RuntimeContainerBinding['role'],
    ...(topologyVersion ? { topologyVersion } : {}),
  };
}

function compareRuntimeBindingNames(
  expected: ReadonlyMap<string, unknown>,
  left: string,
  right: string,
): number {
  return [...expected.keys()].indexOf(left) - [...expected.keys()].indexOf(right);
}

function sameRuntimeBinding(left: RuntimeContainerBinding, right: RuntimeContainerBinding): boolean {
  return left.name === right.name
    && left.id === right.id
    && left.status === right.status
    && left.imageId === right.imageId
    && left.role === right.role
    && left.topologyVersion === right.topologyVersion;
}

function allowedTransitionStatus(status: string, desired: 'running' | 'stopped', target: boolean): boolean {
  if (desired === 'stopped') return status === 'created' || status === 'exited';
  return target
    ? status === 'created' || status === 'exited' || status === 'running'
    : status === 'running';
}

async function inspectBoundGatewayTransition(
  state: LoadedState,
  sourceBinding: readonly RuntimeContainerBinding[],
  desired: 'running' | 'stopped',
  transition: 'assert' | 'replace',
  runDocker: LifecycleDockerRunner = docker,
): Promise<RuntimeContainerBinding | undefined> {
  if (sourceBinding.length > 1) throw new Error('Reviewed gateway runtime binding contains more than one container.');
  const name = gatewayContainerName(state.config.installationId, state.paths.root);
  const source = sourceBinding[0];
  if (!source) {
    const current = await strictLifecycleContainerInspection(name, runDocker);
    if (!current) return undefined;
    verifyManagedGateway(state, current, name);
    const binding = runtimeBinding(current, name);
    if (!allowedTransitionStatus(binding.status, desired, false)) {
      throw new Error(`Gateway changed to ${binding.status}; ${desired} lifecycle replacement is blocked.`);
    }
    return binding;
  }
  if (source.name !== name || source.role !== 'gateway') throw new Error('Reviewed gateway runtime binding is invalid.');
  const currentSource = await strictLifecycleContainerInspection(source.id, runDocker, name);
  if (currentSource) {
    verifyManagedGateway(state, currentSource, name);
    const currentBinding = runtimeBinding(currentSource, name);
    if (!sameRuntimeBinding(currentBinding, source) || !allowedTransitionStatus(currentBinding.status, desired, false)) {
      throw new Error('Gateway immutable source identity or status changed before lifecycle replacement.');
    }
    return currentBinding;
  }
  const target = await strictLifecycleContainerInspection(name, runDocker);
  if (!target) return undefined;
  verifyManagedGateway(state, target, name);
  const targetBinding = runtimeBinding(target, name);
  const expectedTargetImageId = transition === 'assert'
    ? source.imageId
    : state.config.gateway.image.contentId;
  if (!expectedTargetImageId
    || targetBinding.imageId !== expectedTargetImageId
    || !allowedTransitionStatus(targetBinding.status, desired, true)) {
    throw new Error('Gateway source disappeared but its same-name replacement is not the exact owned target runtime.');
  }
  return undefined;
}

async function inspectComputerRuntimeTransition(
  state: LoadedState,
  computer: ComputerConfig,
  sourceBinding: readonly RuntimeContainerBinding[],
  desired: 'running' | 'stopped',
  adapter: ManagedRuntimeObservationAdapter,
): Promise<{ sourceIds: string[] }> {
  if (new Set(sourceBinding.map(({ id }) => id)).size !== sourceBinding.length
    || new Set(sourceBinding.map(({ name }) => name)).size !== sourceBinding.length) {
    throw new Error(`Reviewed runtime binding for ${computer.name} contains duplicate identities.`);
  }
  const sourceById = new Map(sourceBinding.map((binding) => [binding.id, binding]));
  const targetRoles = expectedComputerRuntimeRoles(state, computer);
  const inventory = await labeledComputerRuntimeInventory(state, computer.id, adapter);
  const inventoryNames = new Set(inventory.map(({ name }) => name));
  const sourceIds: string[] = [];
  for (const item of inventory) {
    const inspection = await adapter.inspectContainer(item.id, item.name);
    if (!inspection) throw new Error(`Managed runtime ${item.name} disappeared during transition inspection.`);
    const reviewedSource = sourceById.get(item.id);
    if (reviewedSource) {
      assertComputerBindingOwnership(
        state,
        computer.id,
        item.name,
        reviewedSource.role as ComputerRuntimeRole,
        reviewedSource.topologyVersion,
        inspection,
      );
      const observed = runtimeBinding(inspection, item.name);
      if (!sameRuntimeBinding(observed, reviewedSource)
        || !allowedTransitionStatus(observed.status, desired, false)) {
        throw new Error(`Reviewed source runtime ${item.name} changed immutable identity or status.`);
      }
      sourceIds.push(item.id);
      continue;
    }
    const targetRole = targetRoles.get(item.name);
    if (!targetRole) throw new Error(`Runtime transition found unexpected owned container ${item.name}.`);
    assertExpectedComputerRuntimeInspection(state, computer, item.name, targetRole, inspection);
    const observed = runtimeBinding(inspection, item.name);
    if (!computer.image.contentId
      || observed.imageId !== computer.image.contentId
      || !allowedTransitionStatus(observed.status, desired, true)) {
      throw new Error(`Runtime transition container ${item.name} is not the exact owned target runtime.`);
    }
  }
  for (const name of new Set([...sourceBinding.map(({ name }) => name), ...targetRoles.keys()])) {
    if (inventoryNames.has(name)) continue;
    if (await adapter.inspectContainer(name, name)) {
      throw new Error(`Runtime name ${name} is occupied outside the exact source/target ownership inventory.`);
    }
  }
  // A missing source member is safe only after the journal exists: removal may
  // have completed partially. Remaining reviewed source IDs are removed by
  // immutable ID; verified target members are retained for idempotent Compose.
  return { sourceIds: sourceIds.sort() };
}

function assertStoppedReplacementStatus(status: string, subject: string): void {
  if (status !== 'exited' && status !== 'created') {
    throw new Error(`${subject} changed to ${status}; stopped replacement requires exited or created state.`);
  }
}

export async function waitForHealthy(state: LoadedState, id: string, timeoutMs = 180_000): Promise<void> {
  return waitForContainerHealthy(configuredComputerRuntimeName(state, id), 'Computer', timeoutMs);
}

function configuredComputerRuntimeName(state: LoadedState, id: string): string {
  const computer = state.config.computers.find((candidate) => candidate.id === id);
  return computer ? computerContainerName(state, computer) : containerName(state.config.installationId, id, undefined, state.paths.root);
}

async function waitForContainerHealthy(name: string, label: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await runtimeContainerStatus(name);
    if (status.status === 'running' && status.health === 'healthy') return;
    if (status.status === 'exited' || status.status === 'dead') throw new Error(`${label} container stopped before becoming healthy (${status.status}).`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`${label} did not become healthy before the timeout.`);
}

export async function waitForGatewayComputer(state: LoadedState, id: string, token?: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const path = token ? 'openapi.json' : 'health';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.config.gateway.port}/computers/${id}/${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
      if (response.ok) {
        if (!token) {
          const computer = state.config.computers.find((candidate) => candidate.id === id);
          const health = await response.json() as { manifestSha256?: string; capabilities?: string[] };
          if (computer && (health.manifestSha256 !== computer.image.manifestSha256
            || JSON.stringify(health.capabilities) !== JSON.stringify(computer.capabilities))) {
            throw new Error(`Computer ${computer.name} advertised a capability manifest different from stored state.`);
          }
        }
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('advertised a capability')) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Gateway route for computer ${id} did not become ready before the timeout.`);
}

export async function waitForGatewayComputerIfRunning(state: LoadedState, id: string, token?: string): Promise<void> {
  const gateway = await managedGatewayRuntimeObservation(state);
  if (gateway.group === 'inconsistent') throw new Error('Gateway ownership changed while verifying the upgraded computer route.');
  if (gateway.group !== 'complete' || gateway.status !== 'running') return;
  await waitForGatewayComputer(state, id, token);
}

export async function waitForGatewayRemoval(state: LoadedState, id: string, timeoutMs = 30_000): Promise<void> {
  const gateway = await managedGatewayRuntimeObservation(state);
  if (gateway.group === 'inconsistent') throw new Error('Gateway ownership changed while verifying route removal.');
  if (gateway.group !== 'complete' || gateway.status !== 'running') return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.config.gateway.port}/computers/${id}/health`);
      if (response.status === 404) return;
    } catch { /* retry while the route store reloads */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Gateway route for computer ${id} was not removed before the timeout.`);
}

export async function imageDrift(identity: ImageIdentity, computer = false): Promise<{ local: boolean; drifted: boolean; contentId?: string; detail: string }> {
  if (!(await imageExists(identity.resolved))) return { local: false, drifted: false, detail: `${identity.resolved} is not local` };
  try {
    const current = computer
      ? (await inspectComputerImage(identity.requested, identity.resolved, identity.manifestSha256)).identity
      : await inspectGatewayImage(identity.requested, identity.resolved);
    const drifted = Boolean(identity.contentId && current.contentId !== identity.contentId);
    return {
      local: true,
      drifted,
      ...(current.contentId ? { contentId: current.contentId } : {}),
      detail: drifted ? `stored ${identity.contentId}; local ${current.contentId}` : `local content ${current.contentId ?? 'unknown'}`,
    };
  } catch (error) {
    return { local: true, drifted: true, detail: errorMessage(error) };
  }
}

export async function filesystemObservation(path: string): Promise<{ path: string; availableBytes: number; totalBytes: number }> {
  const parent = await nearestExistingDirectory(path);
  const stats = await import('node:fs/promises').then(({ statfs }) => statfs(parent, { bigint: true }));
  return { path: parent, availableBytes: Number(stats.bavail * stats.bsize), totalBytes: Number(stats.blocks * stats.bsize) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
