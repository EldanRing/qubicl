import {
  IMAGE_CATALOG,
  catalogImageIdentity,
  presetDefaults,
  type DockerPlatform,
} from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag } from './args.js';
import {
  buildCleanupPlan,
  executeCleanupPlan,
  type CleanupAttachment,
  type CleanupCandidate,
  type CleanupImage,
  type CleanupExecutionResult,
  type CleanupInventoryItem,
  type CleanupPlan,
  type CleanupSelection,
  type CleanupSnapshot,
} from './cleanup-plan.js';
import { docker, validateDocker } from './docker.js';
import {
  computerRuntimeContainerNames,
  controlNetwork,
  displaySocketVolume,
  gatewayContainerName,
  gatewayNetworkName,
  projectName,
  readRuntimeImageContracts,
  removeRuntimeImageContractRecords,
  usesUnifiedComputerRuntime,
  workspaceNetwork,
} from './runtime.js';
import { loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { inspectPendingTransaction } from './transactions.js';

const INVENTORY_TIMEOUT_MS = 30_000;
const INVENTORY_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const INVENTORY_OPTIONS = {
  timeoutMs: INVENTORY_TIMEOUT_MS,
  maxOutputBytes: INVENTORY_OUTPUT_LIMIT_BYTES,
} as const;

export async function cleanupCommand(args: ParsedArgs): Promise<void> {
  const selection: CleanupSelection = {
    orphans: flag(args, 'orphans'),
    images: flag(args, 'images'),
    records: flag(args, 'images'),
  };
  if (!selection.orphans && !selection.images) throw new Error('Cleanup requires --orphans and/or --images.');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    let state = await loadState(paths);
    const pending = await inspectPendingTransaction(paths);
    if (pending) {
      throw new Error(`Cleanup is blocked while lifecycle transaction ${pending.id} is ${pending.phase}; recover it before reviewing deletion candidates.`);
    }
    const host = await validateDocker();
    const buildPlan = async (): Promise<CleanupPlan> => {
      state = await loadState(paths);
      return buildCleanupPlan(await collectCleanupSnapshot(state, host.platform), selection);
    };
    const reviewed = await buildPlan();
    printCleanupPreview(reviewed);
    if (!flag(args, 'yes')) {
      console.log('Preview only. No resources were removed; rerun the same command with --yes to approve this exact inventory.');
      return;
    }

    const result = await executeCleanupPlan(reviewed, {
      replan: buildPlan,
      remove: async (candidate) => removeCleanupCandidate(state, candidate),
    });
    console.log(`Cleanup removed ${result.removed.length} reviewed item${result.removed.length === 1 ? '' : 's'}.`);
    for (const item of result.removed) console.log(`  removed\t${item.kind}\t${item.name}\t${item.id}`);
    for (const item of result.preserved) console.log(`  preserved\t${item.candidate.kind}\t${item.candidate.name}\t${item.detail}`);
    for (const item of result.failed) console.log(`  failed/preserved by Docker\t${item.candidate.kind}\t${item.candidate.name}\t${item.detail}`);
    assertCleanupSucceeded(result);
  });
}

export async function collectCleanupSnapshot(state: LoadedState, platform: DockerPlatform): Promise<CleanupSnapshot> {
  const installationId = state.config.installationId;
  const project = projectName(installationId, state.paths.root);
  const expectedContainers = new Set([
    gatewayContainerName(installationId, state.paths.root),
    ...state.config.computers.flatMap((computer) => computerRuntimeContainerNames(state, computer)),
  ]);
  const expectedNetworks = new Set([
    gatewayNetworkName(installationId, state.paths.root),
    ...state.config.computers.flatMap((computer) => usesUnifiedComputerRuntime(computer)
      ? [controlNetwork(installationId, computer.id, state.paths.root)]
      : [controlNetwork(installationId, computer.id, state.paths.root), workspaceNetwork(installationId, computer.id, state.paths.root)]),
  ]);
  const expectedVolumes = new Set(state.config.computers
    .filter((computer) => computer.capabilities.includes('viewer') && !usesUnifiedComputerRuntime(computer))
    .map((computer) => displaySocketVolume(installationId, computer.id, state.paths.root)));

  const containerIds = parseIdentifierLines(await docker([
    'ps', '--all', '--no-trunc', '--format', '{{.ID}}',
    '--filter', `label=dev.qubicl.installation=${installationId}`,
  ], INVENTORY_OPTIONS), 'Qubicl container inventory', /^[a-f0-9]{64}$/);
  const containerInspections = await inspectMany<ContainerInspection>('container', containerIds);
  const containerItems = containerInspections.map(containerInventoryItem);
  const retainedManagedImageReferences = new Set(containerInspections
    .map(({ Image }) => Image)
    .filter((value): value is string => Boolean(value)));

  const networkIds = parseIdentifierLines(await docker([
    'network', 'ls', '--no-trunc', '--format', '{{.ID}}',
    '--filter', `label=com.docker.compose.project=${project}`,
  ], INVENTORY_OPTIONS), 'Qubicl network inventory', /^[a-f0-9]{64}$/);
  const networkInspections = await inspectMany<NetworkInspection>('network', networkIds);
  const networkContainerIds = new Set(networkInspections.flatMap((network) => Object.keys(network.Containers ?? {})));
  const networkStatuses = await containerStatusMap(networkContainerIds);
  const networkItems: CleanupInventoryItem[] = networkInspections.map((network) => ({
    kind: 'network',
    id: requiredString(network.Id, 'Docker network ID'),
    name: requiredString(network.Name, 'Docker network name'),
    labels: stringRecord(network.Labels),
    attachedContainers: attachments(Object.keys(network.Containers ?? {}), networkStatuses),
  }));

  const volumeNames = parseIdentifierLines(await docker([
    'volume', 'ls', '--format', '{{.Name}}',
    '--filter', `label=com.docker.compose.project=${project}`,
  ], INVENTORY_OPTIONS), 'Qubicl volume inventory', /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
  const volumeInspections = await inspectMany<VolumeInspection>('volume', volumeNames);
  const volumeItems: CleanupInventoryItem[] = [];
  for (const volume of volumeInspections) {
    const name = requiredString(volume.Name, 'Docker volume name');
    const attachedIds = parseIdentifierLines(await docker([
      'ps', '--all', '--no-trunc', '--format', '{{.ID}}', '--filter', `volume=${name}`,
    ], INVENTORY_OPTIONS), `containers attached to volume ${name}`, /^[a-f0-9]{64}$/);
    const statuses = await containerStatusMap(new Set(attachedIds));
    volumeItems.push({
      kind: 'volume',
      id: name,
      name,
      labels: stringRecord(volume.Labels),
      attachedContainers: attachments(attachedIds, statuses),
      // Qubicl homes are bind directories. Any named volume outside the exact
      // ephemeral display convention is nevertheless protected as durable.
      durableHome: !name.endsWith('-x11'),
    });
  }

  const imageIds = parseIdentifierLines(await docker([
    'image', 'ls', '--no-trunc', '--format', '{{.ID}}',
    '--filter', 'label=org.opencontainers.image.source=https://github.com/EldanRing/qubicl',
  ], INVENTORY_OPTIONS), 'Qubicl image inventory', /^sha256:[a-f0-9]{64}$/);
  const imageInspections = await inspectMany<ImageInspection>('image', imageIds);
  const imageItems: CleanupImage[] = [];
  for (const image of imageInspections) {
    const id = requiredString(image.Id, 'Docker image ID');
    const referencingIds = parseIdentifierLines(await docker([
      'ps', '--all', '--no-trunc', '--format', '{{.ID}}', '--filter', `ancestor=${id}`,
    ], INVENTORY_OPTIONS), `containers referencing image ${id}`, /^[a-f0-9]{64}$/);
    const statuses = await containerStatusMap(new Set(referencingIds));
    const references = [...new Set([...(image.RepoDigests ?? []), ...(image.RepoTags ?? [])])].sort();
    imageItems.push({
      kind: 'image',
      id,
      name: references[0] ?? id,
      labels: stringRecord(image.Config?.Labels),
      references,
      referencedByContainers: attachments(referencingIds, statuses),
    });
  }

  const protectedImageReferences = configuredAndTargetImageReferences(state, platform);
  const contractCache = await readRuntimeImageContracts(state);
  const recordItems: CleanupInventoryItem[] = Object.keys(contractCache.images).sort().map((contentId) => {
    const referenced = protectedImageReferences.has(contentId) || retainedManagedImageReferences.has(contentId);
    return {
      kind: 'cache-record',
      id: contentId,
      name: contentId,
      namespace: 'qubicl-runtime',
      schemaVersion: 1,
      obsolete: !referenced,
      referenced,
    };
  });

  return {
    installationId,
    projectName: project,
    expectedContainers,
    expectedNetworks,
    expectedVolumes,
    protectedImageReferences,
    retainedManagedImageReferences,
    items: [...containerItems, ...networkItems, ...volumeItems, ...imageItems, ...recordItems],
  };
}

export function printCleanupPreview(plan: CleanupPlan, write: (line: string) => void = console.log): void {
  write(`Cleanup preview (schema ${plan.schemaVersion}; inventory ${plan.reviewDigest}):`);
  if (plan.candidates.length === 0) write('  candidates: none');
  for (const candidate of plan.candidates) write(`  candidate\t${candidate.kind}\t${candidate.name}\t${candidate.id}`);
  const preservedCounts = new Map<string, number>();
  for (const item of plan.preserved) preservedCounts.set(item.reason, (preservedCounts.get(item.reason) ?? 0) + 1);
  for (const [reason, count] of [...preservedCounts].sort(([left], [right]) => left.localeCompare(right))) {
    write(`  preserved\t${reason}\t${count}`);
  }
  write('Protected by design: running/current/retained resources, durable homes, backups, trash, unrelated caches, and daemon-global Docker images (including label-only or cross-installation images).');
}

export function assertCleanupSucceeded(result: CleanupExecutionResult): void {
  if (result.failed.length > 0) {
    throw new Error(`Cleanup was partial: Docker preserved ${result.failed.length} reviewed item${result.failed.length === 1 ? '' : 's'} after removal failed. Review the exact results above.`);
  }
}

async function removeCleanupCandidate(state: LoadedState, candidate: CleanupCandidate): Promise<void> {
  switch (candidate.kind) {
    case 'container': await docker(['rm', candidate.id], INVENTORY_OPTIONS); return;
    case 'network': await docker(['network', 'rm', candidate.id], INVENTORY_OPTIONS); return;
    case 'volume': throw new Error(`Automatic volume deletion is disabled because Docker volume name ${candidate.name} is not an immutable identity.`);
    case 'image': throw new Error(`Automatic image deletion is disabled because Docker image ${candidate.id} may be shared by another Qubicl installation.`);
    case 'cache-record': {
      if (await removeRuntimeImageContractRecords(state, [candidate.id]) !== 1) {
        throw new Error(`Runtime cache record ${candidate.id} disappeared before deletion.`);
      }
      return;
    }
    case 'evidence-record': throw new Error(`Unsupported cleanup evidence record ${candidate.id}; it was preserved.`);
  }
}

function configuredAndTargetImageReferences(state: LoadedState, platform: DockerPlatform): Set<string> {
  const references = new Set<string>();
  const add = (image: { requested: string; resolved: string; contentId?: string | undefined }) => {
    references.add(image.requested);
    references.add(image.resolved);
    if (image.contentId) references.add(image.contentId);
  };
  add(state.config.gateway.image);
  add(state.config.defaults.image);
  for (const computer of state.config.computers) add(computer.image);
  add(catalogImageIdentity(IMAGE_CATALOG.gateway, platform));
  if (state.config.defaults.preset !== 'custom') add(presetDefaults(state.config.defaults.preset, platform, IMAGE_CATALOG).image);
  for (const computer of state.config.computers) {
    if (computer.preset !== 'custom') add(presetDefaults(computer.preset, platform, IMAGE_CATALOG).image);
  }
  return references;
}

interface ContainerInspection {
  Id?: string;
  Name?: string;
  Image?: string;
  State?: { Status?: string };
  Config?: { Labels?: Record<string, string> | null };
}

interface NetworkInspection {
  Id?: string;
  Name?: string;
  Labels?: Record<string, string> | null;
  Containers?: Record<string, unknown>;
}

interface VolumeInspection {
  Name?: string;
  Labels?: Record<string, string> | null;
}

interface ImageInspection {
  Id?: string;
  RepoDigests?: string[] | null;
  RepoTags?: string[] | null;
  Config?: { Labels?: Record<string, string> | null };
}

function containerInventoryItem(value: ContainerInspection): CleanupInventoryItem {
  return {
    kind: 'container',
    id: requiredString(value.Id, 'Docker container ID'),
    name: requiredString(value.Name, 'Docker container name').replace(/^\//, ''),
    labels: stringRecord(value.Config?.Labels),
    status: requiredString(value.State?.Status, 'Docker container status'),
  };
}

async function inspectMany<T>(kind: 'container' | 'network' | 'volume' | 'image', ids: string[]): Promise<T[]> {
  if (ids.length === 0) return [];
  const output = await docker([kind, 'inspect', ...ids], INVENTORY_OPTIONS);
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) {
    throw new Error(`Docker ${kind} inspection did not return the complete reviewed inventory.`);
  }
  assertExactInspectionIdentitySet(kind, ids, value);
  return value as T[];
}

export function assertExactInspectionIdentitySet(
  kind: 'container' | 'network' | 'volume' | 'image',
  requested: readonly string[],
  inspections: readonly unknown[],
): void {
  const actual = inspections.map((inspection) => {
    if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
      throw new Error(`Docker ${kind} inspection returned a non-object entry.`);
    }
    const record = inspection as Record<string, unknown>;
    const identity = kind === 'volume' ? record.Name : record.Id;
    if (typeof identity !== 'string' || !identity) throw new Error(`Docker ${kind} inspection omitted its exact identity.`);
    return identity;
  });
  if (new Set(actual).size !== actual.length) throw new Error(`Docker ${kind} inspection returned duplicate identities.`);
  const expected = [...requested].sort();
  const observed = [...actual].sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error(`Docker ${kind} inspection substituted, omitted, or added an identity.`);
  }
}

async function containerStatusMap(ids: ReadonlySet<string>): Promise<Map<string, string>> {
  const inspections = await inspectMany<ContainerInspection>('container', [...ids].sort());
  return new Map(inspections.map((value) => [
    requiredString(value.Id, 'Docker container ID'),
    requiredString(value.State?.Status, 'Docker container status'),
  ]));
}

function attachments(ids: Iterable<string>, statuses: ReadonlyMap<string, string>): CleanupAttachment[] {
  return [...ids].sort().map((containerId) => {
    const status = statuses.get(containerId);
    if (!status) throw new Error(`Docker did not return status for attached container ${containerId}.`);
    return { containerId, running: status === 'running' || status === 'paused' || status === 'restarting' };
  });
}

export function parseIdentifierLines(output: string, subject: string, pattern: RegExp): string[] {
  const values = output.split('\n').map((value) => value.trim()).filter(Boolean);
  if (values.length > 4_096) throw new Error(`${subject} exceeded the bounded item count.`);
  for (const value of values) {
    pattern.lastIndex = 0;
    if (!pattern.test(value)) throw new Error(`${subject} returned invalid identifier ${JSON.stringify(value)}.`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${subject} returned duplicate identifiers.`);
  return values.sort();
}

function stringRecord(value: Record<string, string> | null | undefined): Record<string, string> {
  if (!value) return {};
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'string') throw new Error(`Docker label ${key} is not a string.`);
  }
  return value;
}

function requiredString(value: string | undefined, subject: string): string {
  if (!value) throw new Error(`${subject} is missing.`);
  return value;
}
