import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  ConfigSchema,
  GATEWAY_EXPOSURE_PROTOCOL,
  IMAGE_CATALOG,
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
  computerUpgradeRuntimePlan,
  executeUpgradeAll,
  gatewayUpgradeRuntimePlan,
  type AcquiredUpgradeTarget,
  type ComputerUpgradeMutation,
  type ExactUpgradeTarget,
  type GatewayAndDefaultsMutation,
  type LifecycleUpdateStatus,
  type ManagedRuntimeObservation,
  type PreservedRuntimeState,
  type UpgradeAllPlan,
} from './lifecycle-update.js';
import { synchronizeStartedSkillPolicies } from './policy-commands.js';
import { loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { createStateTransaction, executeStateTransaction, inspectPendingTransaction } from './transactions.js';

export async function upgradeAllCommand(args: ParsedArgs): Promise<void> {
  validateUpgradeInvocation(args);
  if (!flag(args, 'all')) throw new Error('Internal error: upgradeAllCommand requires --all.');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    let state = await loadState(paths);
    const host = await validateDocker();
    const plan = await collectUpgradeAllPlan(state, host.platform);
    printUpgradeAllPreview(plan);
    printBrowserProfileDisclosure('upgrade');

    const result = await executeUpgradeAll(plan, state.config, {
      confirm: async () => confirmUpgradeAll(flag(args, 'yes')),
      replan: async () => collectUpgradeAllPlan(await loadState(paths), host.platform),
      acquireAndInspect: async (target) => acquireAndInspectExactTarget(target, host.platform, flag(args, 'offline')),
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
    });

    if (result.outcome === 'cancelled') {
      console.log('Upgrade cancelled. No images were acquired and no Qubicl state or runtime was changed.');
      return;
    }
    console.log(`Upgrade completed in roll-forward order: ${result.completed.join(', ') || 'no state/runtime replacements were needed'}.`);
    console.log(`Inspected ${result.acquiredExactTargets.length} deduplicated exact image target${result.acquiredExactTargets.length === 1 ? '' : 's'} before the first mutation.`);
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

export async function collectUpgradeAllPlan(state: LoadedState, platform: DockerPlatform): Promise<UpgradeAllPlan> {
  const exactTargets = curatedExactTargets(state.config, platform);
  const [gatewayRuntime, gatewayDrift, pending, presence, computerObservations] = await Promise.all([
    managedGatewayRuntimeObservation(state),
    imageDrift(state.config.gateway.image),
    inspectPendingTransaction(state.paths),
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
    recovery: {
      required: Boolean(pending),
      ...(pending ? { detail: `transaction ${pending.id} is ${pending.phase} and requires recovery` } : {}),
    },
  });
}

export async function lifecycleUpdateStatus(
  state: LoadedState,
  platform: DockerPlatform,
  catalog: ImageCatalog = IMAGE_CATALOG,
): Promise<LifecycleUpdateStatus> {
  const pending = await inspectPendingTransaction(state.paths);
  return buildLifecycleUpdateStatus(
    state.config,
    catalog,
    platform,
    {
      required: Boolean(pending),
      ...(pending ? { detail: `transaction ${pending.id} is ${pending.phase}` } : {}),
    },
  );
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
