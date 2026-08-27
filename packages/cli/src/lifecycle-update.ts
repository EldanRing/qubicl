import { createHash } from 'node:crypto';
import {
  COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  ComputerDefaultsSchema,
  CURATED_PRESETS,
  GATEWAY_EXPOSURE_PROTOCOL,
  catalogImageIdentity,
  presetDefaults,
  type ComputerConfig,
  type ComputerDefaults,
  type DockerPlatform,
  type ImageCatalog,
  type ImageIdentity,
  type Preset,
  type QubiclConfig,
  type RuntimeContainerBinding,
} from '@qubicl/core';
import {
  estimateImageAcquisition,
  type ImageAcquisitionEstimate,
  type ImageAcquisitionTarget,
} from './image-acquisition.js';
import { upgradedComputer } from './upgrade.js';

export type PreservedRuntimeState = 'running' | 'stopped' | 'absent';
export type RuntimeGroupState = 'complete' | 'absent' | 'partial' | 'inconsistent';

export interface ManagedRuntimeObservation {
  status: string;
  group: RuntimeGroupState;
  contentDrift?: boolean;
  containers?: readonly RuntimeContainerBinding[];
}

export interface UpgradeCapacityObservation {
  /** Capacity available to the Docker image store, not merely an unrelated filesystem. */
  availableBytes: number | null;
  directlyMeasured: boolean;
  detail: string;
}

export interface UpgradeRecoveryObservation {
  required: boolean;
  detail?: string;
}

export interface UpgradeAllPlanningInput {
  config: QubiclConfig;
  catalog: ImageCatalog;
  platform: DockerPlatform;
  runtime: {
    gateway: ManagedRuntimeObservation;
    computers: Readonly<Record<string, ManagedRuntimeObservation | undefined>>;
  };
  presentExactTargets: ReadonlySet<string>;
  capacity?: UpgradeCapacityObservation;
  recovery?: UpgradeRecoveryObservation;
}

export type UpgradeRowAction =
  | 'current'
  | 'upgrade'
  | 'repair-content-drift'
  | 'update-default'
  | 'manual-custom-image'
  | 'blocked-runtime';

export interface UpgradePreviewRow {
  key: string;
  kind: 'gateway' | 'default' | 'computer';
  name: string;
  preset: Preset | 'custom' | null;
  currentImage: ImageIdentity;
  targetImage: ImageIdentity | null;
  targetDefaults: ComputerDefaults | null;
  currentResources: { cpus: number; memory: string } | null;
  acquisition: {
    exactTarget: string;
    present: boolean;
    basis: 'already-present-exact-target' | 'catalog-full-acquisition-upper-bound';
    downloadBytes: number | null;
    expandedBytes: number | null;
  } | null;
  runtimeState: PreservedRuntimeState | 'not-applicable' | 'blocked';
  observedRuntimeStatus: string | null;
  runtimeContainers: RuntimeContainerBinding[];
  updateAvailable: boolean | null;
  contentDrift: boolean;
  automatic: boolean;
  action: UpgradeRowAction;
}

export interface UpgradeTargetConsumer {
  id: string;
  kind: 'gateway' | 'default' | 'computer';
  preset: Preset | null;
  image: ImageIdentity;
}

export interface ExactUpgradeTarget {
  exactTarget: string;
  consumers: UpgradeTargetConsumer[];
  requestedReferences: string[];
  present: boolean;
  downloadBytes: number | null;
  expandedBytes: number | null;
}

export interface UpgradeSpaceAssessment {
  basis: 'whole-image-download-plus-expanded-upper-bound';
  requiredBytes: number | null;
  availableBytes: number | null;
  capacityDirectlyMeasured: boolean;
  hardFailure: boolean;
  uncertain: boolean;
  statement: string;
}

export type UpgradeBlockerCode = 'capacity' | 'recovery-required' | 'runtime-unstable';

export interface UpgradeBlocker {
  code: UpgradeBlockerCode;
  subject: string;
  detail: string;
}

export interface UpgradeAllPlan {
  schemaVersion: 1;
  catalogRevision: string;
  catalogReleaseVersion: string;
  platform: DockerPlatform;
  configDigest: string;
  reviewDigest: string;
  rows: UpgradePreviewRow[];
  exactTargets: ExactUpgradeTarget[];
  acquisition: ImageAcquisitionEstimate;
  space: UpgradeSpaceAssessment;
  blockers: UpgradeBlocker[];
  recoveryRequired: boolean;
}

export interface UpdateAvailabilityRow {
  key: string;
  kind: 'gateway' | 'default' | 'computer';
  name: string;
  preset: Preset | 'custom' | null;
  currentImage: ImageIdentity;
  exactTarget: ImageIdentity | null;
  updateAvailable: boolean | null;
  automatic: boolean;
}

export interface LifecycleUpdateStatus {
  schemaVersion: 1;
  catalogReleaseVersion: string;
  catalogRevision: string;
  platform: DockerPlatform;
  recoveryRequired: boolean;
  recoveryDetail?: string;
  rows: UpdateAvailabilityRow[];
}

/** Pure update availability; content drift is reported separately by callers. */
export function buildLifecycleUpdateStatus(
  config: QubiclConfig,
  catalog: ImageCatalog,
  platform: DockerPlatform,
  recovery: UpgradeRecoveryObservation = { required: false },
): LifecycleUpdateStatus {
  const gatewayTarget = catalogImageIdentity(catalog.gateway, platform);
  const rows: UpdateAvailabilityRow[] = [{
    key: 'gateway',
    kind: 'gateway',
    name: 'gateway',
    preset: null,
    currentImage: structuredClone(config.gateway.image),
    exactTarget: gatewayTarget,
    updateAvailable: !sameGatewayTarget(config.gateway.image, gatewayTarget),
    automatic: true,
  }];
  if (config.defaults.preset === 'custom') {
    rows.push(updateStatusCustomRow('default', 'default', 'configured default', config.defaults.image));
  } else {
    const target = presetDefaults(config.defaults.preset, platform, catalog);
    rows.push({
      key: 'default',
      kind: 'default',
      name: 'configured default',
      preset: config.defaults.preset,
      currentImage: structuredClone(config.defaults.image),
      exactTarget: structuredClone(target.image),
      updateAvailable: !sameComputerTarget(config.defaults, target),
      automatic: true,
    });
  }
  for (const computer of [...config.computers]
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id))) {
    const key = `computer:${computer.id}`;
    if (computer.preset === 'custom') {
      rows.push(updateStatusCustomRow(key, 'computer', computer.name, computer.image));
      continue;
    }
    const target = presetDefaults(computer.preset, platform, catalog);
    rows.push({
      key,
      kind: 'computer',
      name: computer.name,
      preset: computer.preset,
      currentImage: structuredClone(computer.image),
      exactTarget: structuredClone(target.image),
      updateAvailable: !sameComputerTarget(computer, target),
      automatic: true,
    });
  }
  return {
    schemaVersion: 1,
    catalogReleaseVersion: catalog.releaseVersion,
    catalogRevision: catalog.revision,
    platform,
    recoveryRequired: recovery.required,
    ...(recovery.detail ? { recoveryDetail: recovery.detail } : {}),
    rows,
  };
}

interface ConsumerDefinition {
  consumer: UpgradeTargetConsumer;
  downloadBytes: number | null;
  expandedBytes: number | null;
}

/**
 * Builds the complete, read-only `upgrade --all` preview. Callers supply
 * observations; this function performs no Docker, filesystem, or network work.
 */
export function buildUpgradeAllPlan(input: UpgradeAllPlanningInput): UpgradeAllPlan {
  const gatewayTarget = catalogImageIdentity(input.catalog.gateway, input.platform);
  const gatewayVariant = requiredVariant(input.catalog.gateway, input.platform, 'gateway');
  const rows: UpgradePreviewRow[] = [];
  const blockers: UpgradeBlocker[] = [];
  const consumers: ConsumerDefinition[] = [];

  const gatewayRuntime = normalizeRuntime('gateway', input.runtime.gateway, blockers);
  const gatewayUpdate = !sameGatewayTarget(input.config.gateway.image, gatewayTarget);
  const gatewayDrift = input.runtime.gateway.contentDrift ?? false;
  rows.push({
    key: 'gateway',
    kind: 'gateway',
    name: 'gateway',
    preset: null,
    currentImage: structuredClone(input.config.gateway.image),
    targetImage: structuredClone(gatewayTarget),
    targetDefaults: null,
    currentResources: null,
    acquisition: null,
    runtimeState: gatewayRuntime,
    observedRuntimeStatus: input.runtime.gateway.status,
    runtimeContainers: structuredClone([...(input.runtime.gateway.containers ?? [])]),
    updateAvailable: gatewayUpdate,
    contentDrift: gatewayDrift,
    automatic: true,
    action: gatewayRuntime === 'blocked'
      ? 'blocked-runtime'
      : gatewayUpdate ? 'upgrade' : gatewayDrift ? 'repair-content-drift' : 'current',
  });
  consumers.push({
    consumer: { id: 'gateway', kind: 'gateway', preset: null, image: gatewayTarget },
    downloadBytes: gatewayVariant.downloadBytes,
    expandedBytes: gatewayVariant.expandedBytes,
  });

  if (input.config.defaults.preset === 'custom') {
    rows.push(customRow(
      'default',
      'configured default',
      input.config.defaults.image,
      'default',
      { cpus: input.config.defaults.cpus, memory: input.config.defaults.memory },
    ));
  } else {
    const targetDefaults = presetDefaults(input.config.defaults.preset, input.platform, input.catalog);
    const entry = input.catalog.presets[input.config.defaults.preset];
    const variant = requiredVariant(entry.image, input.platform, `preset ${input.config.defaults.preset}`);
    const updateAvailable = !sameComputerTarget(input.config.defaults, targetDefaults);
    rows.push({
      key: 'default',
      kind: 'default',
      name: 'configured default',
      preset: input.config.defaults.preset,
      currentImage: structuredClone(input.config.defaults.image),
      targetImage: structuredClone(targetDefaults.image),
      targetDefaults: structuredClone(targetDefaults),
      currentResources: { cpus: input.config.defaults.cpus, memory: input.config.defaults.memory },
      acquisition: null,
      runtimeState: 'not-applicable',
      observedRuntimeStatus: null,
      runtimeContainers: [],
      updateAvailable,
      contentDrift: false,
      automatic: true,
      action: updateAvailable ? 'update-default' : 'current',
    });
    consumers.push({
      consumer: {
        id: 'default',
        kind: 'default',
        preset: input.config.defaults.preset,
        image: targetDefaults.image,
      },
      downloadBytes: variant.downloadBytes,
      expandedBytes: variant.expandedBytes,
    });
  }

  const sortedComputers = [...input.config.computers]
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
  for (const computer of sortedComputers) {
    const key = `computer:${computer.id}`;
    if (computer.preset === 'custom') {
      const observation = input.runtime.computers[computer.id];
      const runtimeState = normalizeRuntime(computer.name, observation, blockers);
      const row = customRow(
        key,
        computer.name,
        computer.image,
        'computer',
        { cpus: computer.cpus, memory: computer.memory },
      );
      row.runtimeState = runtimeState;
      row.observedRuntimeStatus = observation?.status ?? 'unknown';
      row.runtimeContainers = structuredClone([...(observation?.containers ?? [])]);
      row.contentDrift = observation?.contentDrift ?? false;
      if (runtimeState === 'blocked') row.action = 'blocked-runtime';
      rows.push(row);
      continue;
    }

    const preset = computer.preset;
    const targetDefaults = presetDefaults(preset, input.platform, input.catalog);
    const entry = input.catalog.presets[preset];
    const variant = requiredVariant(entry.image, input.platform, `preset ${preset}`);
    const observation = input.runtime.computers[computer.id];
    const runtimeState = normalizeRuntime(computer.name, observation, blockers);
    const updateAvailable = !sameComputerTarget(computer, targetDefaults);
    const contentDrift = observation?.contentDrift ?? false;
    rows.push({
      key,
      kind: 'computer',
      name: computer.name,
      preset,
      currentImage: structuredClone(computer.image),
      targetImage: structuredClone(targetDefaults.image),
      targetDefaults: structuredClone(targetDefaults),
      currentResources: { cpus: computer.cpus, memory: computer.memory },
      acquisition: null,
      runtimeState,
      observedRuntimeStatus: observation?.status ?? 'unknown',
      runtimeContainers: structuredClone([...(observation?.containers ?? [])]),
      updateAvailable,
      contentDrift,
      automatic: true,
      action: runtimeState === 'blocked'
        ? 'blocked-runtime'
        : updateAvailable ? 'upgrade' : contentDrift ? 'repair-content-drift' : 'current',
    });
    consumers.push({
      consumer: { id: key, kind: 'computer', preset, image: targetDefaults.image },
      downloadBytes: variant.downloadBytes,
      expandedBytes: variant.expandedBytes,
    });
  }

  const gatewayRow = rows.find(({ key }) => key === 'gateway')!;
  const runningWithoutGateway = rows.find((row) => row.kind === 'computer' && row.runtimeState === 'running')
    && gatewayRow.runtimeState !== 'running';
  if (runningWithoutGateway) {
    blockers.push({
      code: 'runtime-unstable',
      subject: 'gateway',
      detail: `Gateway is ${gatewayRow.runtimeState} while at least one computer is running; reconcile the runtime before upgrading.`,
    });
  }

  if (input.recovery?.required) {
    blockers.push({
      code: 'recovery-required',
      subject: 'lifecycle',
      detail: input.recovery.detail ?? 'A prior lifecycle transaction requires recovery before another upgrade can start.',
    });
  }

  // A target whose currently configured consumer has content drift is not
  // accepted as present merely because Docker can resolve the same reference.
  const driftedExactTargets = new Set(rows
    .filter((row) => row.contentDrift && row.targetImage?.resolved === row.currentImage.resolved)
    .map((row) => row.targetImage!.resolved));
  const verifiedPresentTargets = new Set([...input.presentExactTargets]
    .filter((target) => !driftedExactTargets.has(target)));
  const acquisition = estimateImageAcquisition(consumers.map(toAcquisitionTarget), verifiedPresentTargets);
  for (const row of rows) {
    if (!row.targetImage) continue;
    const estimate = acquisition.targets.find(({ exactTarget }) => exactTarget === row.targetImage!.resolved);
    if (!estimate) throw new Error(`Preview row ${row.key} has no exact acquisition target.`);
    row.acquisition = {
      exactTarget: estimate.exactTarget,
      present: estimate.present,
      basis: estimate.acquisition.basis,
      downloadBytes: estimate.acquisition.downloadBytes,
      expandedBytes: estimate.acquisition.expandedBytes,
    };
  }
  const exactTargets = buildExactTargets(consumers, acquisition);
  const space = assessUpgradeSpace(acquisition, input.capacity);
  if (space.hardFailure) {
    blockers.push({ code: 'capacity', subject: 'Docker image store', detail: space.statement });
  }

  blockers.sort((left, right) => compareText(left.code, right.code) || compareText(left.subject, right.subject));
  const digestInput = {
    schemaVersion: 1 as const,
    catalogRevision: input.catalog.revision,
    catalogReleaseVersion: input.catalog.releaseVersion,
    platform: input.platform,
    configDigest: createHash('sha256').update(stableJson(input.config)).digest('hex'),
    config: input.config,
    rows,
    exactTargets,
    acquisition,
    space,
    blockers,
    recoveryRequired: input.recovery?.required ?? false,
  };
  return {
    ...digestInput,
    reviewDigest: createHash('sha256').update(stableJson(digestInput)).digest('hex'),
  };
}

export function assessUpgradeSpace(
  acquisition: ImageAcquisitionEstimate,
  capacity?: UpgradeCapacityObservation,
): UpgradeSpaceAssessment {
  assertCapacity(capacity);
  const requiredBytes = acquisition.downloadBytes === null || acquisition.expandedBytes === null
    ? null
    : safeSum(acquisition.downloadBytes, acquisition.expandedBytes);
  const availableBytes = capacity?.availableBytes ?? null;
  const capacityDirectlyMeasured = capacity?.directlyMeasured === true && availableBytes !== null;
  const hardFailure = requiredBytes !== null
    && capacityDirectlyMeasured
    && availableBytes! < requiredBytes;
  const uncertain = requiredBytes === null || !capacityDirectlyMeasured;
  const requirement = requiredBytes === null
    ? 'Required image-store space is unknown because at least one missing exact target has unmeasured catalog size.'
    : `Conservative image-store requirement is ${requiredBytes} bytes (whole-image download plus expanded upper bounds).`;
  const availability = capacityDirectlyMeasured
    ? ` Directly measured available capacity is ${availableBytes} bytes${capacity?.detail ? ` (${capacity.detail})` : ''}.`
    : ` Available Docker image-store capacity is not directly measured${capacity?.detail ? ` (${capacity.detail})` : ''}; no capacity failure is inferred.`;
  return {
    basis: 'whole-image-download-plus-expanded-upper-bound',
    requiredBytes,
    availableBytes,
    capacityDirectlyMeasured,
    hardFailure,
    uncertain,
    statement: `${requirement}${availability}`,
  };
}

export interface AcquiredUpgradeTarget {
  exactTarget: string;
  contentId: `sha256:${string}`;
  inspectedConsumers: string[];
  previewAccessProtocol?: typeof COMPUTER_PREVIEW_ACCESS_PROTOCOL;
  gatewayExposureProtocol?: typeof GATEWAY_EXPOSURE_PROTOCOL;
}

export function assertRemotePreviewUpgradeCompatibility(
  previewDomain: string | undefined,
  computerName: string,
  previewAccessProtocol: typeof COMPUTER_PREVIEW_ACCESS_PROTOCOL | undefined,
): void {
  if (previewDomain && previewAccessProtocol !== COMPUTER_PREVIEW_ACCESS_PROTOCOL) {
    throw new Error(`Computer image selected for ${computerName} does not declare ${COMPUTER_PREVIEW_ACCESS_PROTOCOL} preview access required by the preserved remote preview domain. Choose a compatible image or revoke/reconfigure remote previews first.`);
  }
}

export interface GatewayAndDefaultsMutation {
  priorGateway: QubiclConfig['gateway'];
  nextGateway: QubiclConfig['gateway'];
  priorDefaults: ComputerDefaults;
  nextDefaults: ComputerDefaults;
  gatewayRuntimeState: PreservedRuntimeState;
  gatewayAction: UpgradeRowAction;
  defaultAction: UpgradeRowAction;
  gatewayRuntimeBinding: RuntimeContainerBinding[];
}

export interface ComputerUpgradeMutation {
  prior: ComputerConfig;
  next: ComputerConfig;
  runtimeState: PreservedRuntimeState;
  action: 'upgrade' | 'repair-content-drift';
  runtimeBinding: RuntimeContainerBinding[];
  gatewayRuntimeBinding: RuntimeContainerBinding[];
}

export interface UpgradeAllExecutionDependencies {
  confirm(plan: UpgradeAllPlan): Promise<boolean>;
  replan(): Promise<UpgradeAllPlan>;
  acquireAndInspect(target: ExactUpgradeTarget): Promise<AcquiredUpgradeTarget>;
  applyGatewayAndDefaults(mutation: GatewayAndDefaultsMutation): Promise<RuntimeContainerBinding[] | void>;
  applyComputer(mutation: ComputerUpgradeMutation): Promise<void>;
}

export interface UpgradeAllExecutionResult {
  outcome: 'cancelled' | 'completed';
  acquiredExactTargets: string[];
  completed: string[];
}

export class UpgradeAllPartialFailure extends Error {
  readonly completed: string[];
  readonly pending: string[];
  override readonly cause: unknown;

  constructor(completed: string[], pending: string[], cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Upgrade stopped after ${completed.length} completed step(s); retry rolls forward the remaining ${pending.length}: ${detail}`);
    this.name = 'UpgradeAllPartialFailure';
    this.completed = [...completed];
    this.pending = [...pending];
    this.cause = cause;
  }
}

/**
 * Executes a previously reviewed plan. Every exact target is acquired and
 * inspected before the first state/runtime mutation. Completed steps are never
 * rolled back; a fresh plan naturally treats them as current on retry.
 */
export async function executeUpgradeAll(
  reviewedPlan: UpgradeAllPlan,
  config: QubiclConfig,
  dependencies: UpgradeAllExecutionDependencies,
): Promise<UpgradeAllExecutionResult> {
  assertExecutable(reviewedPlan);
  if (createHash('sha256').update(stableJson(config)).digest('hex') !== reviewedPlan.configDigest) {
    throw new Error('The configuration supplied for execution does not match the reviewed upgrade plan.');
  }
  if (!(await dependencies.confirm(reviewedPlan))) {
    return { outcome: 'cancelled', acquiredExactTargets: [], completed: [] };
  }

  const plan = await dependencies.replan();
  assertExecutable(plan);
  if (plan.reviewDigest !== reviewedPlan.reviewDigest) {
    throw new Error('Upgrade inputs changed after preview; review the new plan before acquiring images.');
  }

  const acquired = new Map<string, AcquiredUpgradeTarget>();
  for (const target of plan.exactTargets) {
    const result = await dependencies.acquireAndInspect(structuredClone(target));
    assertAcquiredTarget(target, result);
    acquired.set(target.exactTarget, structuredClone(result));
  }
  assertPreservedGatewayExposureTarget(plan, config, acquired);
  assertPreservedRemotePreviewTargets(plan, config, acquired);

  const steps = mutationSteps(plan);
  const completed: string[] = [];
  let gatewayRuntimeBinding = structuredClone(
    plan.rows.find(({ key }) => key === 'gateway')?.runtimeContainers ?? [],
  );
  for (const step of steps) {
    try {
      if (step.kind === 'gateway-and-defaults') {
        const replacementBinding = await dependencies.applyGatewayAndDefaults(buildGatewayMutation(plan, config, acquired));
        if (replacementBinding) gatewayRuntimeBinding = structuredClone(replacementBinding);
      } else {
        await dependencies.applyComputer(buildComputerMutation(
          plan,
          config,
          acquired,
          step.computerId,
          gatewayRuntimeBinding,
        ));
      }
      completed.push(step.key);
    } catch (error) {
      throw new UpgradeAllPartialFailure(completed, steps.slice(completed.length).map(({ key }) => key), error);
    }
  }

  return {
    outcome: 'completed',
    acquiredExactTargets: plan.exactTargets.map(({ exactTarget }) => exactTarget),
    completed,
  };
}

function customRow(
  key: string,
  name: string,
  image: ImageIdentity,
  kind: 'default' | 'computer',
  currentResources: { cpus: number; memory: string },
): UpgradePreviewRow {
  return {
    key,
    kind,
    name,
    preset: 'custom',
    currentImage: structuredClone(image),
    targetImage: null,
    targetDefaults: null,
    currentResources,
    acquisition: null,
    runtimeState: kind === 'default' ? 'not-applicable' : 'absent',
    observedRuntimeStatus: kind === 'default' ? null : 'absent',
    runtimeContainers: [],
    updateAvailable: null,
    contentDrift: false,
    automatic: false,
    action: 'manual-custom-image',
  };
}

function updateStatusCustomRow(
  key: string,
  kind: 'default' | 'computer',
  name: string,
  image: ImageIdentity,
): UpdateAvailabilityRow {
  return {
    key,
    kind,
    name,
    preset: 'custom',
    currentImage: structuredClone(image),
    exactTarget: null,
    updateAvailable: null,
    automatic: false,
  };
}

function normalizeRuntime(
  subject: string,
  observation: ManagedRuntimeObservation | undefined,
  blockers: UpgradeBlocker[],
): PreservedRuntimeState | 'blocked' {
  try {
    return requirePreservedRuntimeState(observation, subject);
  } catch (error) {
    blockers.push({
      code: 'runtime-unstable',
      subject,
      detail: error instanceof Error ? error.message : String(error),
    });
    return 'blocked';
  }
}

export function requirePreservedRuntimeState(
  observation: ManagedRuntimeObservation | undefined,
  subject: string,
): PreservedRuntimeState {
  if (!observation) throw new Error(`${subject} runtime was not observed.`);
  if (observation.group === 'partial' || observation.group === 'inconsistent') {
    throw new Error(`${subject} runtime group is ${observation.group} (primary status ${observation.status}); repair it before upgrading.`);
  }
  if (observation.group === 'absent') {
    if (observation.status === 'absent') return 'absent';
    throw new Error(`${subject} runtime group is absent but its primary status is ${observation.status}.`);
  }
  if (observation.status === 'running') return 'running';
  if (observation.status === 'exited' || observation.status === 'created') return 'stopped';
  throw new Error(`${subject} runtime status ${observation.status} cannot be preserved safely; only running, exited, created, or absent groups are upgradeable.`);
}

export interface ComputerUpgradeRuntimePlan {
  replaceIds?: string[];
  replaceStoppedIds?: string[];
  verifyTokenIds?: string[];
  gatewayRuntimeBinding?: RuntimeContainerBinding[];
  computerRuntimeBindings?: Record<string, RuntimeContainerBinding[]>;
}

export interface GatewayUpgradeRuntimePlan {
  startGateway?: boolean;
  replaceGatewayRunning?: boolean;
  replaceGatewayStopped?: boolean;
  gatewayRuntimeBinding?: RuntimeContainerBinding[];
}

export function gatewayUpgradeRuntimePlan(
  changesGatewayRuntime: boolean,
  runtimeState: PreservedRuntimeState,
  binding: readonly RuntimeContainerBinding[] = [],
): GatewayUpgradeRuntimePlan {
  if (!changesGatewayRuntime || runtimeState === 'absent') return {};
  const runtimeBinding = binding.length
    ? { gatewayRuntimeBinding: structuredClone([...binding]) }
    : {};
  if (runtimeState === 'running') return {
    startGateway: true,
    replaceGatewayRunning: true,
    ...runtimeBinding,
  };
  return { replaceGatewayStopped: true, ...runtimeBinding };
}

export function computerUpgradeRuntimePlan(
  runtimeState: PreservedRuntimeState,
  computerId: string,
  runtimeBinding: readonly RuntimeContainerBinding[] = [],
  gatewayRuntimeBinding: readonly RuntimeContainerBinding[] = [],
): ComputerUpgradeRuntimePlan {
  const bindings = runtimeBinding.length
    ? { computerRuntimeBindings: { [computerId]: structuredClone([...runtimeBinding]) } }
    : {};
  if (runtimeState === 'running') return {
    replaceIds: [computerId],
    verifyTokenIds: [computerId],
    ...(gatewayRuntimeBinding.length ? { gatewayRuntimeBinding: structuredClone([...gatewayRuntimeBinding]) } : {}),
    ...bindings,
  };
  if (runtimeState === 'stopped') return { replaceStoppedIds: [computerId], ...bindings };
  return {};
}

function toAcquisitionTarget(definition: ConsumerDefinition): ImageAcquisitionTarget {
  return {
    consumer: definition.consumer.id,
    image: definition.consumer.image,
    catalogDownloadBytes: definition.downloadBytes,
    catalogExpandedBytes: definition.expandedBytes,
  };
}

function buildExactTargets(
  consumers: ConsumerDefinition[],
  acquisition: ImageAcquisitionEstimate,
): ExactUpgradeTarget[] {
  const byTarget = new Map<string, UpgradeTargetConsumer[]>();
  for (const definition of consumers) {
    const targetConsumers = byTarget.get(definition.consumer.image.resolved) ?? [];
    targetConsumers.push(structuredClone(definition.consumer));
    byTarget.set(definition.consumer.image.resolved, targetConsumers);
  }
  return acquisition.targets.map((estimate) => ({
    exactTarget: estimate.exactTarget,
    consumers: (byTarget.get(estimate.exactTarget) ?? [])
      .sort((left, right) => consumerOrder(left.kind) - consumerOrder(right.kind)
        || compareText(left.id, right.id)),
    requestedReferences: [...estimate.requestedReferences],
    present: estimate.present,
    downloadBytes: estimate.acquisition.downloadBytes,
    expandedBytes: estimate.acquisition.expandedBytes,
  }));
}

function sameGatewayTarget(current: ImageIdentity, target: ImageIdentity): boolean {
  return Boolean(current.contentId) && current.resolved === target.resolved;
}

function sameComputerTarget(
  current: Pick<ComputerDefaults, 'preset' | 'compatibility' | 'image' | 'capabilityContractVersion' | 'capabilities'>,
  target: ComputerDefaults,
): boolean {
  return Boolean(current.image.contentId)
    && current.preset === target.preset
    && current.compatibility === target.compatibility
    && current.image.resolved === target.image.resolved
    && current.image.manifestSha256 === target.image.manifestSha256
    && current.capabilityContractVersion === target.capabilityContractVersion
    && JSON.stringify(current.capabilities) === JSON.stringify(target.capabilities);
}

function requiredVariant(
  image: ImageCatalog['gateway'],
  platform: DockerPlatform,
  subject: string,
): NonNullable<ImageCatalog['gateway']['platforms'][DockerPlatform]> {
  const variant = image.platforms[platform];
  if (!variant) throw new Error(`${subject} image is unavailable for ${platform}.`);
  return variant;
}

function assertCapacity(capacity: UpgradeCapacityObservation | undefined): void {
  if (!capacity) return;
  if (capacity.availableBytes !== null
    && (!Number.isSafeInteger(capacity.availableBytes) || capacity.availableBytes < 0)) {
    throw new Error('Available capacity must be a non-negative safe integer or null.');
  }
  if (capacity.directlyMeasured && capacity.availableBytes === null) {
    throw new Error('Directly measured capacity must include available bytes.');
  }
  if (!capacity.detail) throw new Error('Capacity observation detail must be non-empty.');
}

function safeSum(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error('Required image-store byte total exceeds safe-integer precision.');
  return value;
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

function assertExecutable(plan: UpgradeAllPlan): void {
  if (plan.blockers.length === 0) return;
  throw new Error(`Upgrade is blocked: ${plan.blockers.map(({ subject, detail }) => `${subject}: ${detail}`).join(' | ')}`);
}

function assertAcquiredTarget(target: ExactUpgradeTarget, result: AcquiredUpgradeTarget): void {
  if (result.exactTarget !== target.exactTarget) {
    throw new Error(`Acquisition returned ${result.exactTarget}; expected exact target ${target.exactTarget}.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(result.contentId)) {
    throw new Error(`Acquisition returned an invalid content ID for ${target.exactTarget}.`);
  }
  const expected = target.consumers.map(({ id }) => id).sort(compareText);
  if (new Set(result.inspectedConsumers).size !== result.inspectedConsumers.length) {
    throw new Error(`Exact target ${target.exactTarget} returned duplicate consumer inspections.`);
  }
  const inspected = [...result.inspectedConsumers].sort(compareText);
  if (JSON.stringify(inspected) !== JSON.stringify(expected)) {
    throw new Error(`Exact target ${target.exactTarget} was not inspected for every consumer (expected ${expected.join(', ') || 'none'}; inspected ${inspected.join(', ') || 'none'}).`);
  }
}

function assertPreservedRemotePreviewTargets(
  plan: UpgradeAllPlan,
  config: QubiclConfig,
  acquired: ReadonlyMap<string, AcquiredUpgradeTarget>,
): void {
  if (!config.gateway.exposure?.previewDomain) return;
  for (const row of plan.rows) {
    if (row.kind !== 'computer' || (row.action !== 'upgrade' && row.action !== 'repair-content-drift')) continue;
    const target = row.targetImage?.resolved;
    assertRemotePreviewUpgradeCompatibility(
      config.gateway.exposure.previewDomain,
      row.name,
      target ? acquired.get(target)?.previewAccessProtocol : undefined,
    );
  }
}

function assertPreservedGatewayExposureTarget(
  plan: UpgradeAllPlan,
  config: QubiclConfig,
  acquired: ReadonlyMap<string, AcquiredUpgradeTarget>,
): void {
  if (!config.gateway.exposure) return;
  const gateway = plan.rows.find(({ key }) => key === 'gateway');
  if (!gateway || (gateway.action !== 'upgrade' && gateway.action !== 'repair-content-drift')) return;
  const target = gateway.targetImage?.resolved;
  if (!target || acquired.get(target)?.gatewayExposureProtocol !== GATEWAY_EXPOSURE_PROTOCOL) {
    throw new Error(`Gateway image selected for upgrade does not declare ${GATEWAY_EXPOSURE_PROTOCOL} support required by the preserved remote-access configuration. Revoke remote access first or use a compatible gateway image.`);
  }
}

type MutationStep =
  | { kind: 'gateway-and-defaults'; key: 'gateway-and-defaults' }
  | { kind: 'computer'; key: string; computerId: string };

function mutationSteps(plan: UpgradeAllPlan): MutationStep[] {
  const gateway = plan.rows.find(({ key }) => key === 'gateway')!;
  const defaults = plan.rows.find(({ key }) => key === 'default')!;
  const steps: MutationStep[] = [];
  if (gateway.action !== 'current' || defaults.action === 'update-default') {
    steps.push({ kind: 'gateway-and-defaults', key: 'gateway-and-defaults' });
  }
  for (const row of plan.rows) {
    if (row.kind !== 'computer' || (row.action !== 'upgrade' && row.action !== 'repair-content-drift')) continue;
    steps.push({ kind: 'computer', key: row.key, computerId: row.key.slice('computer:'.length) });
  }
  return steps;
}

function buildGatewayMutation(
  plan: UpgradeAllPlan,
  config: QubiclConfig,
  acquired: ReadonlyMap<string, AcquiredUpgradeTarget>,
): GatewayAndDefaultsMutation {
  const gatewayRow = plan.rows.find(({ key }) => key === 'gateway')!;
  const defaultRow = plan.rows.find(({ key }) => key === 'default')!;
  if (!gatewayRow.targetImage || gatewayRow.runtimeState === 'blocked' || gatewayRow.runtimeState === 'not-applicable') {
    throw new Error('Reviewed gateway target or runtime state is invalid.');
  }
  const gatewayImage = gatewayRow.action === 'current'
    ? structuredClone(config.gateway.image)
    : bindAcquiredImage(gatewayRow.targetImage, acquired);
  const nextDefaults = defaultRow.action === 'update-default' && defaultRow.targetImage && defaultRow.targetDefaults
    ? defaultsWithPreservedResources(
        defaultRow.targetDefaults,
        defaultRow.targetImage,
        config.defaults,
        acquired,
      )
    : structuredClone(config.defaults);
  return {
    priorGateway: structuredClone(config.gateway),
    nextGateway: { ...structuredClone(config.gateway), image: gatewayImage },
    priorDefaults: structuredClone(config.defaults),
    nextDefaults,
    gatewayRuntimeState: gatewayRow.runtimeState,
    gatewayAction: gatewayRow.action,
    defaultAction: defaultRow.action,
    gatewayRuntimeBinding: structuredClone(gatewayRow.runtimeContainers),
  };
}

function defaultsWithPreservedResources(
  targetDefaults: ComputerDefaults,
  targetImage: ImageIdentity,
  current: ComputerDefaults,
  acquired: ReadonlyMap<string, AcquiredUpgradeTarget>,
): ComputerDefaults {
  return ComputerDefaultsSchema.parse({
    ...structuredClone(targetDefaults),
    image: bindAcquiredImage(targetImage, acquired),
    cpus: current.cpus,
    memory: current.memory,
  });
}

function buildComputerMutation(
  plan: UpgradeAllPlan,
  config: QubiclConfig,
  acquired: ReadonlyMap<string, AcquiredUpgradeTarget>,
  computerId: string,
  gatewayRuntimeBinding: readonly RuntimeContainerBinding[],
): ComputerUpgradeMutation {
  const row = plan.rows.find(({ key }) => key === `computer:${computerId}`);
  const computer = config.computers.find(({ id }) => id === computerId);
  if (!row || !computer || !row.targetImage || row.preset === null || row.preset === 'custom'
    || row.runtimeState === 'blocked' || row.runtimeState === 'not-applicable'
    || (row.action !== 'upgrade' && row.action !== 'repair-content-drift')) {
    throw new Error(`Reviewed computer target ${computerId} is invalid.`);
  }
  if (!row.targetDefaults) throw new Error(`Reviewed computer target ${computerId} has no contract defaults.`);
  const targetDefaults = structuredClone(row.targetDefaults);
  targetDefaults.image = bindAcquiredImage(row.targetImage, acquired);
  return {
    prior: structuredClone(computer),
    next: upgradedComputer(computer, targetDefaults),
    runtimeState: row.runtimeState,
    action: row.action,
    runtimeBinding: structuredClone(row.runtimeContainers),
    gatewayRuntimeBinding: structuredClone([...gatewayRuntimeBinding]),
  };
}

function bindAcquiredImage(
  target: ImageIdentity,
  acquired: ReadonlyMap<string, AcquiredUpgradeTarget>,
): ImageIdentity {
  const evidence = acquired.get(target.resolved);
  if (!evidence) throw new Error(`Exact target ${target.resolved} has no acquisition evidence.`);
  return {
    ...structuredClone(target),
    contentId: evidence.contentId,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function consumerOrder(kind: UpgradeTargetConsumer['kind']): number {
  return kind === 'gateway' ? 0 : kind === 'default' ? 1 : 2;
}

export function curatedPreset(value: string): value is Preset {
  return (CURATED_PRESETS as readonly string[]).includes(value);
}
