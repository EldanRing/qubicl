import { createHash } from 'node:crypto';

export type CleanupDockerKind = 'container' | 'network' | 'volume' | 'image';
export type CleanupItemKind = CleanupDockerKind | 'cache-record' | 'evidence-record';

export interface CleanupSelection {
  orphans: boolean;
  images: boolean;
  records: boolean;
}

interface NamedDockerResource {
  id: string;
  name: string;
  labels: Readonly<Record<string, string>>;
}

export interface CleanupContainer extends NamedDockerResource {
  kind: 'container';
  status: string;
}

export interface CleanupAttachment {
  containerId: string;
  running: boolean;
}

export interface CleanupNetwork extends NamedDockerResource {
  kind: 'network';
  attachedContainers: CleanupAttachment[];
}

export interface CleanupVolume extends NamedDockerResource {
  kind: 'volume';
  attachedContainers: CleanupAttachment[];
  durableHome: boolean;
}

export interface CleanupImage {
  kind: 'image';
  id: string;
  name: string;
  labels: Readonly<Record<string, string>>;
  references: string[];
  referencedByContainers: CleanupAttachment[];
}

export interface CleanupRecord {
  kind: 'cache-record' | 'evidence-record';
  id: string;
  name: string;
  namespace: 'qubicl-runtime';
  schemaVersion: number;
  obsolete: boolean;
  referenced: boolean;
}

export type CleanupInventoryItem = CleanupContainer | CleanupNetwork | CleanupVolume | CleanupImage | CleanupRecord;

export interface CleanupSnapshot {
  installationId: string;
  projectName: string;
  expectedContainers: ReadonlySet<string>;
  expectedNetworks: ReadonlySet<string>;
  expectedVolumes: ReadonlySet<string>;
  /** Configured identities, reviewed upgrade targets, and content IDs. */
  protectedImageReferences: ReadonlySet<string>;
  /** Image IDs/references used by any current or deliberately retained managed runtime. */
  retainedManagedImageReferences: ReadonlySet<string>;
  items: CleanupInventoryItem[];
}

export type CleanupPreservationReason =
  | 'not-selected'
  | 'ownership-unverified'
  | 'current-managed-runtime'
  | 'running-resource'
  | 'attached-resource'
  | 'durable-home'
  | 'mutable-identity'
  | 'shared-global-image'
  | 'current-or-retained-image'
  | 'container-referenced-image'
  | 'not-obsolete'
  | 'record-referenced';

export interface CleanupCandidate {
  kind: CleanupItemKind;
  id: string;
  name: string;
  validationDigest: string;
}

export interface PreservedCleanupItem {
  kind: CleanupItemKind;
  id: string;
  name: string;
  reason: CleanupPreservationReason;
  detail: string;
}

export interface CleanupPlan {
  schemaVersion: 1;
  reviewDigest: string;
  selection: CleanupSelection;
  candidates: CleanupCandidate[];
  preserved: PreservedCleanupItem[];
}

/**
 * Selects only resources with independently verifiable Qubicl ownership.
 * Durable homes and daemon-global Docker images never become candidates.
 */
export function buildCleanupPlan(snapshot: CleanupSnapshot, selection: CleanupSelection): CleanupPlan {
  validateSnapshot(snapshot);
  const candidates: CleanupCandidate[] = [];
  const preserved: PreservedCleanupItem[] = [];
  const ordered = [...snapshot.items].sort(compareInventoryItems);
  for (const item of ordered) {
    const decision = cleanupDecision(snapshot, selection, item);
    if (decision.candidate) candidates.push(decision.candidate);
    else preserved.push({
      kind: item.kind,
      id: item.id,
      name: item.name,
      reason: decision.reason,
      detail: decision.detail,
    });
  }
  candidates.sort(compareCandidates);
  preserved.sort(comparePreserved);
  const digestInput = {
    schemaVersion: 1 as const,
    selection: { ...selection },
    candidates,
    preserved,
  };
  return {
    ...digestInput,
    reviewDigest: digest(digestInput),
  };
}

interface CleanupDecisionCandidate {
  candidate: CleanupCandidate;
}

interface CleanupDecisionPreserved {
  candidate?: never;
  reason: CleanupPreservationReason;
  detail: string;
}

type CleanupDecision = CleanupDecisionCandidate | CleanupDecisionPreserved;

function cleanupDecision(
  snapshot: CleanupSnapshot,
  selection: CleanupSelection,
  item: CleanupInventoryItem,
): CleanupDecision {
  if ((item.kind === 'container' || item.kind === 'network' || item.kind === 'volume') && !selection.orphans) {
    return preserve('not-selected', 'Orphan runtime cleanup was not selected.');
  }
  if (item.kind === 'image' && !selection.images) {
    return preserve('not-selected', 'Image cleanup was not selected.');
  }
  if ((item.kind === 'cache-record' || item.kind === 'evidence-record') && !selection.records) {
    return preserve('not-selected', 'Cache/evidence cleanup was not selected.');
  }

  switch (item.kind) {
    case 'container': return containerDecision(snapshot, item);
    case 'network': return networkDecision(snapshot, item);
    case 'volume': return volumeDecision(snapshot, item);
    case 'image': return imageDecision(snapshot, item);
    case 'cache-record':
    case 'evidence-record': return recordDecision(item);
  }
}

function containerDecision(snapshot: CleanupSnapshot, item: CleanupContainer): CleanupDecision {
  if (!verifiedContainerOwnership(snapshot.installationId, item.labels)) {
    return preserve('ownership-unverified', 'Container does not have a complete Qubicl installation/role identity.');
  }
  if (snapshot.expectedContainers.has(item.name)) {
    return preserve('current-managed-runtime', 'Container belongs to the current managed runtime.');
  }
  if (!removableContainerStatus(item.status)) {
    return preserve('running-resource', `Container status ${item.status} is not safe for orphan removal.`);
  }
  return candidate(item);
}

function networkDecision(snapshot: CleanupSnapshot, item: CleanupNetwork): CleanupDecision {
  if (!verifiedComposeOwnership(snapshot.projectName, item, 'network')) {
    return preserve('ownership-unverified', 'Network does not have the exact Qubicl Compose project/name identity.');
  }
  if (snapshot.expectedNetworks.has(item.name)) {
    return preserve('current-managed-runtime', 'Network belongs to the current managed runtime.');
  }
  if (item.attachedContainers.some(({ running }) => running)) {
    return preserve('running-resource', 'Network is attached to a running container.');
  }
  if (item.attachedContainers.length > 0) {
    return preserve('attached-resource', 'Network remains attached to a container.');
  }
  return candidate(item);
}

function volumeDecision(snapshot: CleanupSnapshot, item: CleanupVolume): CleanupDecision {
  if (item.durableHome) {
    return preserve('durable-home', 'Durable computer homes are outside cleanup scope.');
  }
  if (!verifiedComposeOwnership(snapshot.projectName, item, 'volume')) {
    return preserve('ownership-unverified', 'Volume is not a verified Qubicl ephemeral X11 volume.');
  }
  if (snapshot.expectedVolumes.has(item.name)) {
    return preserve('current-managed-runtime', 'Volume belongs to the current managed runtime.');
  }
  if (item.attachedContainers.some(({ running }) => running)) {
    return preserve('running-resource', 'Volume is attached to a running container.');
  }
  if (item.attachedContainers.length > 0) {
    return preserve('attached-resource', 'Volume remains attached to a container.');
  }
  return preserve('mutable-identity', 'Docker volumes have no immutable ID; preserve this orphan for explicit manual review because its name can be reused.');
}

function imageDecision(snapshot: CleanupSnapshot, item: CleanupImage): CleanupDecision {
  if (!verifiedImageOwnership(item)) {
    return preserve('ownership-unverified', 'Image lacks the exact official Qubicl image contract labels.');
  }
  const identities = new Set([item.id, ...item.references]);
  if ([...identities].some((identity) => snapshot.protectedImageReferences.has(identity)
    || snapshot.retainedManagedImageReferences.has(identity))) {
    return preserve('current-or-retained-image', 'Image is a current exact target or is retained by managed runtime evidence.');
  }
  if (item.referencedByContainers.some(({ running }) => running)) {
    return preserve('running-resource', 'Image is referenced by a running container.');
  }
  if (item.referencedByContainers.length > 0) {
    return preserve('container-referenced-image', 'Image is referenced by a retained container.');
  }
  return preserve(
    'shared-global-image',
    'Docker images are daemon-global and may be pinned by another Qubicl installation; OCI labels and this installation\'s cache do not prove exclusive ownership. Preserve for explicit manual review.',
  );
}

function recordDecision(item: CleanupRecord): CleanupDecision {
  if (item.namespace !== 'qubicl-runtime' || item.schemaVersion !== 1) {
    return preserve('ownership-unverified', 'Record is outside the recognized versioned Qubicl runtime namespace.');
  }
  if (item.referenced) return preserve('record-referenced', 'Record still supports current or retained runtime evidence.');
  if (!item.obsolete) return preserve('not-obsolete', 'Record is not obsolete.');
  return candidate(item);
}

function verifiedContainerOwnership(installationId: string, labels: Readonly<Record<string, string>>): boolean {
  if (labels['dev.qubicl.installation'] !== installationId) return false;
  const role = labels['dev.qubicl.role'];
  if (role === 'gateway') return true;
  if (role === 'computer') return uuid(labels['dev.qubicl.id']);
  if (['computer-executor', 'computer-egress', 'computer-web', 'computer-session', 'computer-ssh'].includes(role ?? '')) {
    return uuid(labels['dev.qubicl.computer-id']);
  }
  return false;
}

function verifiedComposeOwnership(
  projectName: string,
  item: CleanupNetwork | CleanupVolume,
  kind: 'network' | 'volume',
): boolean {
  if (item.labels['com.docker.compose.project'] !== projectName) return false;
  if (item.labels[`com.docker.compose.${kind}`] === undefined) return false;
  if (!(item.name === projectName || item.name.startsWith(`${projectName}-`) || item.name.startsWith(`${projectName}_`))) return false;
  if (kind === 'volume' && !item.name.endsWith('-x11')) return false;
  return true;
}

function verifiedImageOwnership(item: CleanupImage): boolean {
  if (!/^sha256:[a-f0-9]{64}$/.test(item.id)) return false;
  if (item.labels['org.opencontainers.image.source'] !== 'https://github.com/EldanRing/qubicl') return false;
  if (item.labels['org.opencontainers.image.licenses'] !== 'Apache-2.0') return false;
  const title = item.labels['org.opencontainers.image.title'];
  if (title === 'Qubicl gateway') {
    return /^\d+$/.test(item.labels['dev.qubicl.gateway-protocol-version'] ?? '');
  }
  if (title !== 'Qubicl computer' || item.labels['dev.qubicl.contract-version'] !== '1') return false;
  return Boolean(item.labels['dev.qubicl.preset']
    && item.labels['dev.qubicl.compatibility']
    && /^[a-f0-9]{64}$/.test(item.labels['dev.qubicl.manifest-sha256'] ?? ''));
}

function removableContainerStatus(status: string): boolean {
  return status === 'exited' || status === 'created' || status === 'dead';
}

function candidate(item: CleanupInventoryItem): CleanupDecisionCandidate {
  const evidence = cleanupEvidence(item);
  return {
    candidate: {
      kind: item.kind,
      id: item.id,
      name: item.name,
      validationDigest: digest(evidence),
    },
  };
}

function cleanupEvidence(item: CleanupInventoryItem): unknown {
  switch (item.kind) {
    case 'container': return { ...item, labels: sortedRecord(item.labels) };
    case 'network':
    case 'volume': return {
      ...item,
      labels: sortedRecord(item.labels),
      attachedContainers: [...item.attachedContainers].sort(compareAttachments),
    };
    case 'image': return {
      ...item,
      labels: sortedRecord(item.labels),
      references: [...item.references].sort(compareText),
      referencedByContainers: [...item.referencedByContainers].sort(compareAttachments),
    };
    case 'cache-record':
    case 'evidence-record': return item;
  }
}

function preserve(reason: CleanupPreservationReason, detail: string): CleanupDecisionPreserved {
  return { reason, detail };
}

export interface CleanupExecutionDependencies {
  /** Rebuilds a plan from a fresh Docker/cache inventory. */
  replan(): Promise<CleanupPlan>;
  remove(candidate: CleanupCandidate): Promise<void>;
}

export interface CleanupFailure {
  candidate: CleanupCandidate;
  detail: string;
}

export interface CleanupExecutionResult {
  removed: CleanupCandidate[];
  preserved: CleanupFailure[];
  failed: CleanupFailure[];
}

/**
 * Recomputes the whole inventory immediately before deletion, then validates
 * each reviewed candidate again. Newly appearing candidates are never removed.
 */
export async function executeCleanupPlan(
  reviewed: CleanupPlan,
  dependencies: CleanupExecutionDependencies,
): Promise<CleanupExecutionResult> {
  const current = await dependencies.replan();
  if (current.reviewDigest !== reviewed.reviewDigest) {
    throw new Error('Cleanup inventory changed after preview; review the new exact candidate list before deletion.');
  }

  const result: CleanupExecutionResult = { removed: [], preserved: [], failed: [] };
  for (const reviewedCandidate of reviewed.candidates) {
    const revalidated = await dependencies.replan();
    const currentCandidate = revalidated.candidates.find((candidate) => sameCandidate(candidate, reviewedCandidate));
    if (!currentCandidate) {
      result.preserved.push({
        candidate: reviewedCandidate,
        detail: 'Candidate changed, became referenced/running/current, or disappeared during immediate revalidation.',
      });
      continue;
    }
    try {
      await dependencies.remove(reviewedCandidate);
      result.removed.push(reviewedCandidate);
    } catch (error) {
      result.failed.push({ candidate: reviewedCandidate, detail: errorMessage(error) });
    }
  }
  return result;
}

function sameCandidate(left: CleanupCandidate, right: CleanupCandidate): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && left.name === right.name
    && left.validationDigest === right.validationDigest;
}

function validateSnapshot(snapshot: CleanupSnapshot): void {
  if (!uuid(snapshot.installationId)) throw new Error('Cleanup snapshot installation ID must be a UUID.');
  if (!snapshot.projectName) throw new Error('Cleanup snapshot project name must be non-empty.');
  const keys = new Set<string>();
  for (const item of snapshot.items) {
    if (!item.id || !item.name) throw new Error('Cleanup inventory IDs and names must be non-empty.');
    const key = `${item.kind}\0${item.id}`;
    if (keys.has(key)) throw new Error(`Cleanup inventory contains duplicate ${item.kind} ID ${item.id}.`);
    keys.add(key);
  }
}

function uuid(value: string | undefined): boolean {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)));
}

const KIND_ORDER: Readonly<Record<CleanupItemKind, number>> = {
  container: 0,
  network: 1,
  volume: 2,
  image: 3,
  'cache-record': 4,
  'evidence-record': 5,
};

function compareInventoryItems(left: CleanupInventoryItem, right: CleanupInventoryItem): number {
  return KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || compareText(left.name, right.name)
    || compareText(left.id, right.id);
}

function compareCandidates(left: CleanupCandidate, right: CleanupCandidate): number {
  return KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || compareText(left.name, right.name)
    || compareText(left.id, right.id);
}

function comparePreserved(left: PreservedCleanupItem, right: PreservedCleanupItem): number {
  return KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || compareText(left.name, right.name)
    || compareText(left.id, right.id);
}

function compareAttachments(left: CleanupAttachment, right: CleanupAttachment): number {
  return compareText(left.containerId, right.containerId) || Number(left.running) - Number(right.running);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
