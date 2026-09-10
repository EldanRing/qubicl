import { operationOutput } from './operation-context.js';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  ConfigSchema,
  DockerPlatformSchema,
  GATEWAY_EXPOSURE_PROTOCOL,
  IMAGE_CATALOG,
  RuntimeContainerBindingSchema,
  catalogImageIdentity,
  formatBytes,
  presetDefaults,
  type DockerPlatform,
  type ImageCatalog,
  type QubiclConfig,
  type RuntimeContainerBinding,
} from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag } from './args.js';
import { printBrowserProfileDisclosure } from './browser-profile-disclosures.js';
import {
  acquireCatalogGatewayContract,
  acquireCatalogPreset,
  imageDrift,
  imageExists,
  managedComputerRuntimeObservation,
  managedGatewayRuntimeObservation,
  validateDocker,
} from './docker.js';
import {
  buildLifecycleUpdateStatus,
  buildUpgradeAllPlan,
  acceptedUpgradeAllPlan,
  assertAcceptedUpgradeAllRecovery,
  computerUpgradeRuntimePlan,
  digestUpgradeConfig,
  executeUpgradeAll,
  gatewayUpgradeRuntimePlan,
  upgradeAllPlanHasMutations,
  type AcquiredUpgradeTarget,
  type ComputerUpgradeMutation,
  type ExactUpgradeTarget,
  type GatewayAndDefaultsMutation,
  type LifecycleUpdateStatus,
  type ManagedRuntimeObservation,
  type PreservedRuntimeState,
  type UpgradeAllPlan,
  type UpgradeAllAcceptance,
  type UpgradeAllExecutionDependencies,
} from './lifecycle-update.js';
import { inspectPendingBackupCreation } from './backups.js';
import { inspectPendingComputerLifecycle, type ComputerLifecycleJournal } from './lifecycle-operations.js';
import { synchronizeStartedSkillPolicies } from './policy-commands.js';
import { atomicWrite, durableRemove, loadState, statePaths, withStateLock, type LoadedState, type StatePaths } from './state.js';
import { createStateTransaction, executeStateTransaction, inspectPendingTransaction } from './transactions.js';

export async function upgradeAllCommand(args: ParsedArgs): Promise<void> {
  validateUpgradeInvocation(args);
  if (!flag(args, 'all')) throw new Error('Internal error: upgradeAllCommand requires --all.');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const pendingUpgrade = await inspectPendingUpgradeAll(state);
    if (pendingUpgrade) {
      if (!flag(args, 'yes')) {
        throw new Error(`Accepted upgrade ${pendingUpgrade.operationId} requires explicit recovery. Re-run qubicl upgrade --all --yes to validate and roll forward only its recorded targets.`);
      }
      await recoverPendingUpgradeAll(state);
      operationOutput('log', `Recovered accepted upgrade ${pendingUpgrade.operationId} in validated roll-forward order.`);
      return;
    }
    const host = await validateDocker();
    const plan = await collectUpgradeAllPlan(state, host.platform);
    printUpgradeAllPreview(plan);
    printBrowserProfileDisclosure('upgrade');

    const result = await executeUpgradeAll(
      plan,
      state.config,
      upgradeExecutionDependencies(paths, state, host.platform, flag(args, 'offline'), {
        confirm: async () => confirmUpgradeAll(flag(args, 'yes')),
      }),
    );

    if (result.outcome === 'cancelled') {
      operationOutput('log', 'Upgrade cancelled. No images were acquired and no Qubicl state or runtime was changed.');
      return;
    }
    operationOutput('log', `Upgrade completed in roll-forward order: ${result.completed.join(', ') || 'no state/runtime replacements were needed'}.`);
    operationOutput('log', `Inspected ${result.acquiredExactTargets.length} deduplicated exact image target${result.acquiredExactTargets.length === 1 ? '' : 's'} before the first mutation.`);
  });
}

export function validateUpgradeInvocation(args: ParsedArgs): void {
  if (flag(args, 'all')) {
    if (args.positionals.length > 0) throw new Error('qubicl upgrade --all does not accept a computer name.');
    if (args.options.has('preset') || args.options.has('image')) {
      throw new Error('qubicl upgrade --all uses exact curated catalog targets and does not accept --preset or --image.');
    }
    return;
  }
  if (flag(args, 'yes')) throw new Error('--yes is accepted only with qubicl upgrade --all.');
  if (args.positionals.length !== 1) throw new Error('qubicl upgrade requires one computer name or --all.');
}

export async function collectUpgradeAllPlan(
  state: LoadedState,
  platform: DockerPlatform,
  options: { ignoreUpgradeJournal?: boolean } = {},
): Promise<UpgradeAllPlan> {
  const exactTargets = curatedExactTargets(state.config, platform);
  const [gatewayRuntime, gatewayDrift, pending, pendingBackup, pendingUpgrade, pendingComputerLifecycle, presence, computerObservations] = await Promise.all([
    managedGatewayRuntimeObservation(state),
    imageDrift(state.config.gateway.image),
    inspectPendingTransaction(state.paths),
    inspectPendingBackupCreation(state),
    options.ignoreUpgradeJournal ? undefined : inspectPendingUpgradeAll(state),
    inspectPendingComputerLifecycle(state),
    Promise.all(exactTargets.map(async (target) => [target, await imageExists(target)] as const)),
    Promise.all(state.config.computers.map(async (computer) => {
      const [runtime, drift] = await Promise.all([
        managedComputerRuntimeObservation(state, computer),
        imageDrift(computer.image, true),
      ]);
      return [computer.id, { ...runtime, contentDrift: drift.drifted }] as const;
    })),
  ]);
  return buildUpgradeAllPlan({
    config: state.config,
    catalog: IMAGE_CATALOG,
    platform,
    runtime: {
      gateway: { ...gatewayRuntime, contentDrift: gatewayDrift.drifted },
      computers: Object.fromEntries(computerObservations),
    },
    presentExactTargets: new Set(presence.filter(([, present]) => present).map(([target]) => target)),
    capacity: {
      availableBytes: null,
      directlyMeasured: false,
      detail: 'Docker does not expose portable remaining image-store/VM capacity',
    },
    recovery: recoveryObservation(pending, pendingBackup, pendingUpgrade, pendingComputerLifecycle),
  });
}

export async function lifecycleUpdateStatus(
  state: LoadedState,
  platform: DockerPlatform,
  catalog: ImageCatalog = IMAGE_CATALOG,
): Promise<LifecycleUpdateStatus> {
  const [pending, pendingBackup, pendingUpgrade, pendingComputerLifecycle] = await Promise.all([
    inspectPendingTransaction(state.paths),
    inspectPendingBackupCreation(state),
    inspectPendingUpgradeAll(state),
    inspectPendingComputerLifecycle(state),
  ]);
  return buildLifecycleUpdateStatus(
    state.config,
    catalog,
    platform,
    recoveryObservation(pending, pendingBackup, pendingUpgrade, pendingComputerLifecycle),
  );
}

export interface UpgradeAllJournal {
  version: 1;
  operationId: string;
  installationId: string;
  createdAt: string;
  offline: boolean;
  checkpointConfigDigest: string;
  activeStep: { key: string; expectedConfigDigest: string } | null;
  accepted: UpgradeAllAcceptance;
}

function upgradeAllJournalPath(paths: StatePaths): string {
  return `${paths.runtime}/upgrade-all.json`;
}

export async function inspectPendingUpgradeAll(state: LoadedState): Promise<UpgradeAllJournal | undefined> {
  const journal = await readUpgradeAllJournal(state.paths);
  if (journal && journal.installationId !== state.config.installationId) {
    throw new Error('Upgrade-all journal belongs to another Qubicl installation and was preserved.');
  }
  return journal ? structuredClone(journal) : undefined;
}

export interface UpgradeAllRecoveryRuntime {
  validateDocker(): Promise<{ platform: DockerPlatform }>;
  collectPlan(state: LoadedState, platform: DockerPlatform): Promise<UpgradeAllPlan>;
  execute(plan: UpgradeAllPlan, state: LoadedState, journal: UpgradeAllJournal): Promise<void>;
}

export async function recoverPendingUpgradeAll(
  state: LoadedState,
  injected?: UpgradeAllRecoveryRuntime,
): Promise<boolean> {
  const journal = await inspectPendingUpgradeAll(state);
  if (!journal) return false;
  const pendingTransaction = await inspectPendingTransaction(state.paths);
  if (pendingTransaction) {
    throw new Error(`Recover transaction ${pendingTransaction.id} before resuming accepted upgrade ${journal.operationId}.`);
  }
  const runtime: UpgradeAllRecoveryRuntime = injected ?? {
    validateDocker,
    collectPlan: (current, platform) => collectUpgradeAllPlan(current, platform, { ignoreUpgradeJournal: true }),
    execute: async (plan, current, pending) => {
      await executeUpgradeAll(
        plan,
        current.config,
        upgradeExecutionDependencies(current.paths, current, plan.platform, pending.offline, {
          confirm: async () => true,
          ignoreUpgradeJournal: true,
          journalIdentity: { operationId: pending.operationId, createdAt: pending.createdAt },
        }),
      );
    },
  };
  const host = await runtime.validateDocker();
  if (host.platform !== journal.accepted.platform) {
    throw new Error(`Accepted upgrade targets ${journal.accepted.platform}, but Docker now reports ${host.platform}; the journal was preserved.`);
  }
  const currentState = await loadState(state.paths);
  const currentPlan = await runtime.collectPlan(currentState, host.platform);
  const currentDigest = digestUpgradeConfig(currentState.config);
  if (currentDigest !== journal.checkpointConfigDigest
    && currentDigest !== journal.activeStep?.expectedConfigDigest) {
    throw new Error('Qubicl configuration changed outside the accepted upgrade checkpoint; the journal was preserved for review.');
  }
  assertAcceptedUpgradeAllRecovery(journal.accepted, currentPlan);
  if (currentPlan.blockers.length) {
    throw new Error(`Accepted upgrade cannot resume: ${currentPlan.blockers.map(({ subject, detail }) => `${subject}: ${detail}`).join(' | ')}`);
  }
  if (!upgradeAllPlanHasMutations(currentPlan)) {
    await durableRemove(upgradeAllJournalPath(state.paths));
    return true;
  }
  await runtime.execute(currentPlan, currentState, journal);
  return true;
}

function recoveryObservation(
  transaction: { id: string; phase: string } | undefined,
  backup: { operationId: string; phase: string } | undefined,
  upgrade: UpgradeAllJournal | undefined,
  computerLifecycle: ComputerLifecycleJournal | undefined,
): { required: boolean; detail?: string } {
  const details = [
    ...(transaction ? [`transaction ${transaction.id} is ${transaction.phase}`] : []),
    ...(backup ? [`backup ${backup.operationId} is ${backup.phase}`] : []),
    ...(upgrade ? [`accepted upgrade ${upgrade.operationId} awaits roll-forward`] : []),
    ...(computerLifecycle ? [`computer ${computerLifecycle.operation} ${computerLifecycle.operationId} awaits explicit recovery`] : []),
  ];
  return details.length ? { required: true, detail: details.join('; ') } : { required: false };
}

function upgradeExecutionDependencies(
  paths: StatePaths,
  initialState: LoadedState,
  platform: DockerPlatform,
  offline: boolean,
  options: {
    confirm(plan: UpgradeAllPlan): Promise<boolean>;
    ignoreUpgradeJournal?: boolean;
    journalIdentity?: { operationId: string; createdAt: string };
  },
): UpgradeAllExecutionDependencies {
  let state = initialState;
  return {
    confirm: options.confirm,
    replan: async () => {
      state = await loadState(paths);
      return collectUpgradeAllPlan(state, platform, options.ignoreUpgradeJournal ? { ignoreUpgradeJournal: true } : {});
    },
    recordAccepted: async (plan) => {
      state = await loadState(paths);
      await recordAcceptedUpgradeAll(state, plan, offline, options.journalIdentity);
    },
    recordStepStarted: async (step, expectedConfigDigest) => {
      const journal = await requiredUpgradeAllJournal(state);
      if (journal.activeStep) throw new Error(`Accepted upgrade already records active step ${journal.activeStep.key}.`);
      journal.activeStep = { key: step, expectedConfigDigest };
      await writeUpgradeAllJournal(state.paths, journal);
    },
    recordStepCompleted: async (step, configDigest) => {
      const journal = await requiredUpgradeAllJournal(state);
      if (journal.activeStep?.key !== step || journal.activeStep.expectedConfigDigest !== configDigest) {
        throw new Error(`Accepted upgrade checkpoint does not match completed step ${step}.`);
      }
      journal.checkpointConfigDigest = configDigest;
      journal.activeStep = null;
      await writeUpgradeAllJournal(state.paths, journal);
    },
    clearAccepted: async () => durableRemove(upgradeAllJournalPath(paths)),
    acquireAndInspect: async (target) => acquireAndInspectExactTarget(target, platform, offline),
    applyGatewayAndDefaults: async (mutation) => {
      state = await loadState(paths);
      await applyGatewayAndDefaults(state, mutation);
      state = await loadState(paths);
      return (await managedGatewayRuntimeObservation(state)).containers;
    },
    applyComputer: async (mutation) => {
      state = await loadState(paths);
      await applyComputerUpgrade(state, mutation);
      state = await loadState(paths);
    },
  };
}

export async function recordAcceptedUpgradeAll(
  state: LoadedState,
  plan: UpgradeAllPlan,
  offline: boolean,
  identity: { operationId: string; createdAt: string } = {
    operationId: randomUUID(),
    createdAt: new Date().toISOString(),
  },
): Promise<void> {
  const journal: UpgradeAllJournal = {
    version: 1,
    ...identity,
    installationId: state.config.installationId,
    offline,
    checkpointConfigDigest: plan.configDigest,
    activeStep: null,
    accepted: acceptedUpgradeAllPlan(plan),
  };
  await writeUpgradeAllJournal(state.paths, journal);
}

async function requiredUpgradeAllJournal(state: LoadedState): Promise<UpgradeAllJournal> {
  const journal = await readUpgradeAllJournal(state.paths);
  if (!journal) throw new Error('Accepted upgrade journal disappeared while the operation was running.');
  if (journal.installationId !== state.config.installationId) {
    throw new Error('Accepted upgrade journal changed installation identity while the operation was running.');
  }
  return journal;
}

async function writeUpgradeAllJournal(paths: StatePaths, journal: UpgradeAllJournal): Promise<void> {
  await atomicWrite(upgradeAllJournalPath(paths), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

async function readUpgradeAllJournal(paths: StatePaths): Promise<UpgradeAllJournal | undefined> {
  const path = upgradeAllJournalPath(paths);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== expectedUid || (info.mode & 0o777) !== 0o600) {
    throw new Error(`Upgrade-all journal ${path} must be a regular operator-owned file with mode 0600.`);
  }
  return parseUpgradeAllJournal(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function parseUpgradeAllJournal(value: unknown): UpgradeAllJournal {
  const record = strictRecord(value, [
    'accepted', 'activeStep', 'checkpointConfigDigest', 'createdAt', 'installationId', 'offline', 'operationId', 'version',
  ], 'upgrade-all journal');
  if (record.version !== 1) throw new Error('Upgrade-all journal has an unsupported version.');
  const operationId = uuidField(record.operationId, 'operation ID');
  const installationId = uuidField(record.installationId, 'installation ID');
  const createdAt = stringField(record.createdAt, 'creation timestamp');
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Upgrade-all journal has an invalid creation timestamp.');
  if (typeof record.offline !== 'boolean') throw new Error('Upgrade-all journal has an invalid offline policy.');
  const checkpointConfigDigest = digestField(record.checkpointConfigDigest, 'checkpoint configuration digest');
  const acceptedRecord = strictRecord(record.accepted, [
    'catalogReleaseVersion', 'catalogRevision', 'configDigest', 'exactTargets', 'platform', 'reviewDigest', 'rows',
  ], 'upgrade-all acceptance');
  const rows = arrayField(acceptedRecord.rows, 'accepted rows').map((entry) => {
    const row = strictRecord(entry, ['action', 'exactTarget', 'key', 'kind', 'preset', 'runtimeContainers', 'runtimeState'], 'accepted row');
    const action = enumField(row.action, [
      'current', 'upgrade', 'repair-content-drift', 'update-default', 'manual-custom-image', 'blocked-runtime',
    ] as const, 'row action');
    const kind = enumField(row.kind, ['gateway', 'default', 'computer'] as const, 'row kind');
    const runtimeState = enumField(row.runtimeState, [
      'running', 'stopped', 'absent', 'not-applicable', 'blocked',
    ] as const, 'row runtime state');
    const preset = row.preset === null
      ? null
      : enumField(row.preset, ['file-system', 'browser', 'computer', 'workstation', 'custom'] as const, 'row preset');
    if (row.exactTarget !== null && (typeof row.exactTarget !== 'string' || !row.exactTarget)) {
      throw new Error('Upgrade-all journal has an invalid exact row target.');
    }
    const runtimeContainers = arrayField(row.runtimeContainers, 'accepted row runtime containers')
      .map((binding) => RuntimeContainerBindingSchema.parse(binding));
    if (new Set(runtimeContainers.map(({ id }) => id)).size !== runtimeContainers.length
      || new Set(runtimeContainers.map(({ name }) => name)).size !== runtimeContainers.length) {
      throw new Error('Upgrade-all journal has duplicate accepted row runtime bindings.');
    }
    return {
      key: stringField(row.key, 'row key'),
      kind,
      action,
      preset,
      runtimeState,
      exactTarget: row.exactTarget as string | null,
      runtimeContainers,
    };
  });
  if (new Set(rows.map(({ key }) => key)).size !== rows.length) throw new Error('Upgrade-all journal has duplicate row keys.');
  const exactTargets = arrayField(acceptedRecord.exactTargets, 'exact targets').map((entry) => {
    const target = strictRecord(entry, ['consumerIds', 'exactTarget'], 'accepted exact target');
    const consumerIds = arrayField(target.consumerIds, 'target consumer IDs').map((id) => stringField(id, 'target consumer ID'));
    if (new Set(consumerIds).size !== consumerIds.length) throw new Error('Upgrade-all journal has duplicate target consumer IDs.');
    return { exactTarget: stringField(target.exactTarget, 'exact target'), consumerIds };
  });
  if (new Set(exactTargets.map(({ exactTarget }) => exactTarget)).size !== exactTargets.length) {
    throw new Error('Upgrade-all journal has duplicate exact targets.');
  }
  const configDigest = digestField(acceptedRecord.configDigest, 'configuration digest');
  const reviewDigest = digestField(acceptedRecord.reviewDigest, 'review digest');
  let activeStep: UpgradeAllJournal['activeStep'] = null;
  if (record.activeStep !== null) {
    const active = strictRecord(record.activeStep, ['expectedConfigDigest', 'key'], 'active upgrade step');
    activeStep = {
      key: stringField(active.key, 'active step key'),
      expectedConfigDigest: digestField(active.expectedConfigDigest, 'active step configuration digest'),
    };
    if (!rows.some(({ key, action }) => (key === activeStep!.key || activeStep!.key === 'gateway-and-defaults'
      && (key === 'gateway' || key === 'default'))
      && ['upgrade', 'repair-content-drift', 'update-default'].includes(action))) {
      throw new Error('Upgrade-all journal active step is outside the accepted mutation plan.');
    }
  }
  return {
    version: 1,
    operationId,
    installationId,
    createdAt,
    offline: record.offline,
    checkpointConfigDigest,
    activeStep,
    accepted: {
      platform: DockerPlatformSchema.parse(acceptedRecord.platform),
      catalogRevision: stringField(acceptedRecord.catalogRevision, 'catalog revision'),
      catalogReleaseVersion: stringField(acceptedRecord.catalogReleaseVersion, 'catalog release version'),
      configDigest,
      reviewDigest,
      rows,
      exactTargets,
    },
  };
}

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  const unexpected = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in record));
  if (unexpected.length || missing.length) {
    throw new Error(`${label} fields are invalid${unexpected.length ? `; unexpected: ${unexpected.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`);
  }
  return record;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Upgrade-all journal has an invalid ${label}.`);
  return value;
}

function uuidField(value: unknown, label: string): string {
  const parsed = stringField(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed)) {
    throw new Error(`Upgrade-all journal has an invalid ${label}.`);
  }
  return parsed;
}

function digestField(value: unknown, label: string): string {
  const parsed = stringField(value, label);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error(`Upgrade-all journal has an invalid ${label}.`);
  return parsed;
}

function arrayField(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Upgrade-all journal has invalid ${label}.`);
  return value;
}

function enumField<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error(`Upgrade-all journal has an invalid ${label}.`);
  return value;
}

export function printUpgradeAllPreview(plan: UpgradeAllPlan, write: (line: string) => void = console.log): void {
  write(`Upgrade-all preview (schema ${plan.schemaVersion}; catalog ${plan.catalogReleaseVersion} revision ${plan.catalogRevision}; ${plan.platform}):`);
  write('KIND\tNAME\tRUNTIME\tACTION\tCURRENT\tEXACT TARGET\tDOWNLOAD\tEXPANDED');
  for (const row of plan.rows) {
    write([
      row.kind,
      row.name,
      row.runtimeState,
      row.action,
      imageDescription(row.currentImage),
      row.targetImage ? imageDescription(row.targetImage) : 'manual custom image',
      row.acquisition ? formatBytes(row.acquisition.downloadBytes) : 'n/a',
      row.acquisition ? formatBytes(row.acquisition.expandedBytes) : 'n/a',
    ].join('\t'));
  }
  write(`Exact targets (${plan.exactTargets.length}, deduplicated):`);
  for (const target of plan.exactTargets) {
    write(`  ${target.exactTarget}\t${target.present ? 'already present (0 B)' : 'acquire/inspect'}\tconsumers=${target.consumers.map(({ id }) => id).join(',')}`);
  }
  write(`Required space: ${plan.space.statement}`);
  if (plan.blockers.length) {
    write('BLOCKED:');
    for (const blocker of plan.blockers) write(`  ${blocker.code}\t${blocker.subject}\t${blocker.detail}`);
  }
  for (const row of plan.rows) {
    if (!row.targetDefaults || row.kind === 'default') continue;
    const current = row.currentResources;
    if (current && (current.cpus < row.targetDefaults.cpus || memoryRank(current.memory) < memoryRank(row.targetDefaults.memory))) {
      write(`  WARNING: ${row.name} retains ${current.cpus} CPU / ${current.memory}, below the catalog recommendation ${row.targetDefaults.cpus} CPU / ${row.targetDefaults.memory}.`);
    }
  }
}

async function acquireAndInspectExactTarget(
  target: ExactUpgradeTarget,
  platform: DockerPlatform,
  offline: boolean,
): Promise<AcquiredUpgradeTarget> {
  const inspections = new Map<string, {
    contentId: `sha256:${string}`;
    consumerIds: string[];
    computer: boolean;
    previewAccessProtocol?: typeof COMPUTER_PREVIEW_ACCESS_PROTOCOL;
    gatewayExposureProtocol?: typeof GATEWAY_EXPOSURE_PROTOCOL;
  }>();
  for (const consumer of target.consumers) {
    const key = consumer.kind === 'gateway' ? 'gateway' : `preset:${consumer.preset}`;
    const existing = inspections.get(key);
    if (existing) {
      existing.consumerIds.push(consumer.id);
      continue;
    }
    if (consumer.kind === 'gateway') {
      const inspection = await acquireCatalogGatewayContract({ catalog: IMAGE_CATALOG, platform, offline, stderr: true });
      assertAcquiredIdentity(target, inspection.identity.resolved);
      inspections.set(key, {
        contentId: requiredContentId(inspection.identity.contentId, target.exactTarget),
        consumerIds: [consumer.id],
        computer: false,
        ...(inspection.compatibility.gatewayExposureProtocol
          ? { gatewayExposureProtocol: inspection.compatibility.gatewayExposureProtocol }
          : {}),
      });
      continue;
    }
    if (!consumer.preset) throw new Error(`Exact target consumer ${consumer.id} has no curated preset.`);
    const inspection = await acquireCatalogPreset(consumer.preset, { catalog: IMAGE_CATALOG, platform, offline, stderr: true });
    assertAcquiredIdentity(target, inspection.identity.resolved);
    inspections.set(key, {
      contentId: requiredContentId(inspection.identity.contentId, target.exactTarget),
      consumerIds: [consumer.id],
      computer: true,
      ...(inspection.compatibility.previewAccessProtocol
        ? { previewAccessProtocol: inspection.compatibility.previewAccessProtocol }
        : {}),
    });
  }
  const contentIds = new Set([...inspections.values()].map(({ contentId }) => contentId));
  if (contentIds.size !== 1) throw new Error(`Exact target ${target.exactTarget} produced inconsistent content IDs across contract inspections.`);
  const contentId = [...contentIds][0]!;
  const computerInspections = [...inspections.values()].filter(({ computer }) => computer);
  const previewAccessProtocol = computerInspections.length > 0
    && computerInspections.every((inspection) => inspection.previewAccessProtocol === COMPUTER_PREVIEW_ACCESS_PROTOCOL)
    ? COMPUTER_PREVIEW_ACCESS_PROTOCOL
    : undefined;
  const gatewayInspections = [...inspections.values()].filter(({ computer }) => !computer);
  const gatewayExposureProtocol = gatewayInspections.length > 0
    && gatewayInspections.every((inspection) => inspection.gatewayExposureProtocol === GATEWAY_EXPOSURE_PROTOCOL)
    ? GATEWAY_EXPOSURE_PROTOCOL
    : undefined;
  return {
    exactTarget: target.exactTarget,
    contentId,
    inspectedConsumers: [...inspections.values()].flatMap(({ consumerIds }) => consumerIds).sort(),
    ...(previewAccessProtocol ? { previewAccessProtocol } : {}),
    ...(gatewayExposureProtocol ? { gatewayExposureProtocol } : {}),
  };
}

async function applyGatewayAndDefaults(state: LoadedState, mutation: GatewayAndDefaultsMutation): Promise<void> {
  assertSame(mutation.priorGateway, state.config.gateway, 'gateway configuration');
  assertSame(mutation.priorDefaults, state.config.defaults, 'configured defaults');
  await assertRuntimeState(
    await managedGatewayRuntimeObservation(state),
    mutation.gatewayRuntimeState,
    'gateway',
    mutation.gatewayRuntimeBinding,
  );
  state.config.gateway = structuredClone(mutation.nextGateway);
  state.config.defaults = structuredClone(mutation.nextDefaults);
  state.config = ConfigSchema.parse(state.config);
  const changesGatewayRuntime = mutation.gatewayAction === 'upgrade' || mutation.gatewayAction === 'repair-content-drift';
  await executeStateTransaction(state.paths, createStateTransaction('upgrade', state, {
    runtime: gatewayUpgradeRuntimePlan(
      changesGatewayRuntime,
      mutation.gatewayRuntimeState,
      mutation.gatewayRuntimeBinding,
    ),
  }));
}

async function applyComputerUpgrade(state: LoadedState, mutation: ComputerUpgradeMutation): Promise<void> {
  const index = state.config.computers.findIndex(({ id }) => id === mutation.prior.id);
  if (index === -1) throw new Error(`Computer ${mutation.prior.id} disappeared before upgrade.`);
  assertSame(mutation.prior, state.config.computers[index], `computer ${mutation.prior.name}`);
  await assertRuntimeState(
    await managedComputerRuntimeObservation(state, mutation.prior),
    mutation.runtimeState,
    `computer ${mutation.prior.name}`,
    mutation.runtimeBinding,
  );
  if (mutation.runtimeState === 'running') {
    await assertRuntimeState(
      await managedGatewayRuntimeObservation(state),
      'running',
      'gateway',
      mutation.gatewayRuntimeBinding,
    );
  }
  state.config.computers[index] = structuredClone(mutation.next);
  state.config = ConfigSchema.parse(state.config);
  await executeStateTransaction(state.paths, createStateTransaction('upgrade', state, {
    runtime: computerUpgradeRuntimePlan(
      mutation.runtimeState,
      mutation.next.id,
      mutation.runtimeBinding,
      mutation.gatewayRuntimeBinding,
    ),
  }));
  if (mutation.runtimeState === 'running') await synchronizeStartedSkillPolicies(state, [mutation.next]);
}

async function confirmUpgradeAll(assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Non-interactive qubicl upgrade --all requires --yes after reviewing the preview.');
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question('Type upgrade-all to acquire every exact target and apply this roll-forward plan: ');
    return answer.trim() === 'upgrade-all';
  } finally {
    prompt.close();
  }
}

function curatedExactTargets(config: QubiclConfig, platform: DockerPlatform): string[] {
  const targets = new Set([catalogImageIdentity(IMAGE_CATALOG.gateway, platform).resolved]);
  if (config.defaults.preset !== 'custom') targets.add(presetDefaults(config.defaults.preset, platform, IMAGE_CATALOG).image.resolved);
  for (const computer of config.computers) {
    if (computer.preset !== 'custom') targets.add(presetDefaults(computer.preset, platform, IMAGE_CATALOG).image.resolved);
  }
  return [...targets].sort();
}

function assertAcquiredIdentity(target: ExactUpgradeTarget, resolved: string): void {
  if (resolved !== target.exactTarget) {
    throw new Error(`Catalog acquisition resolved ${resolved}; reviewed exact target was ${target.exactTarget}.`);
  }
}

function requiredContentId(contentId: string | undefined, exactTarget: string): `sha256:${string}` {
  if (!contentId || !/^sha256:[a-f0-9]{64}$/.test(contentId)) {
    throw new Error(`Exact target ${exactTarget} inspection did not return a valid immutable content ID.`);
  }
  return contentId as `sha256:${string}`;
}

async function assertRuntimeState(
  observation: ManagedRuntimeObservation,
  expected: PreservedRuntimeState,
  subject: string,
  binding: readonly RuntimeContainerBinding[] = [],
): Promise<void> {
  const current = observation.group === 'absent' && observation.status === 'absent'
    ? 'absent'
    : observation.group === 'complete' && observation.status === 'running'
      ? 'running'
      : observation.group === 'complete' && (observation.status === 'exited' || observation.status === 'created')
        ? 'stopped'
        : 'unstable';
  if (current !== expected) {
    throw new Error(`${subject} changed from reviewed ${expected} state to ${observation.group}/${observation.status}; no mutation was attempted.`);
  }
  if (JSON.stringify(observation.containers ?? []) !== JSON.stringify(binding)) {
    throw new Error(`${subject} changed immutable container identity after preview; no lifecycle mutation was attempted.`);
  }
}

function assertSame(expected: unknown, current: unknown, subject: string): void {
  if (JSON.stringify(expected) !== JSON.stringify(current)) {
    throw new Error(`${subject} changed after preview; no lifecycle mutation was attempted.`);
  }
}

function imageDescription(image: { requested: string; resolved: string; contentId?: string | undefined }): string {
  return `${image.requested} => ${image.resolved}${image.contentId ? ` (${image.contentId})` : ''}`;
}

function memoryRank(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)([kmg])$/i);
  if (!match) return 0;
  const factors = { k: 1, m: 1_024, g: 1_024 * 1_024 };
  return Number(match[1]) * factors[match[2]!.toLowerCase() as keyof typeof factors];
}
