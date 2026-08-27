import { access, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import {
  ComputerDefaultsSchema,
  COMPUTER_PREVIEW_ACCESS_PROTOCOL,
  CORE_SKILL_IDS,
  ConfigSchema,
  GATEWAY_EXTERNAL_CONTAINER_PORT,
  GatewayExposureRuntimeSchema,
  IMAGE_CATALOG,
  MIN_DOCKER_COMPOSE_VERSION,
  MIN_DOCKER_ENGINE_VERSION,
  QUBICL_BUILD,
  McpResultModeSchema,
  PRESET_DEFINITIONS,
  PresetSchema,
  ToolProfileSchema,
  SUPPORTED_NODE_RANGE,
  assertValidName,
  gatewayExposureRuntime,
  gatewayExposureRuntimeId,
  parseManifestDocument,
  presetDefaults,
  memoryBytes,
  validateCpu,
  validateMemory,
  reconcileManifest,
  redactSecrets,
  supportedNodeVersion,
  versionSummary,
  type ComputerConfig,
  type ComputerDefaults,
  type QubiclManifest,
} from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, numberOption, stringOption } from './args.js';
import { connectionInstructions, connectionSnippet } from './client-config.js';
import { addConfiguredComputer } from './computers.js';
import { buildComputerConnectionResult, printComputerHandoff } from './computer-handoff.js';
import { doctorImageChecks } from './doctor-images.js';
import {
  acquireCatalogPreset,
  acquireCustomImage,
  buildSystemImages,
  assertGatewayPort,
  compose,
  containerStatus,
  docker,
  ensureRuntimeImages,
  ensureSystemImages,
  gatewayStatus,
  gatewayExternalPublicationFromInspection,
  imageExists,
  imageDrift,
  legacyRuntimeMigrationNeeded,
  managedComputerRuntimeObservation,
  managedGatewayRuntimeObservation,
  migrateLegacyRuntime,
  prepareRuntimeMigration,
  reconcileRuntimeImageContracts,
  portAvailable,
  run,
  startComputer,
  startComputerPreservingRuntimeAfterGateway,
  startGateway,
  validateDocker,
  verifyGatewayCompatibility,
  waitForGatewayComputer,
  waitForHealthy,
} from './docker.js';
import { serveMcpBridge } from './mcp.js';
import { ensureCurrentState, inspectStateFormat, recoverStateMigration } from './migrations.js';
import { LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION, PREVIEW_ACCESS_CONTAINER_PATH, computerContainerName, computerEgressContainerName, computerEgressServiceName, computerExecutorContainerName, computerExecutorServiceName, computerResourceEnvelope, computerRuntimeContainerNames, computerServiceName, computerSessionContainerName, computerSessionServiceName, computerSshContainerName, computerSshServiceName, computerWebContainerName, controlNetwork, displaySocketVolume, gatewayContainerName, GATEWAY_PIDS_LIMIT, gatewayNetworkName, hostIdentity, isPrimaryRuntimeRoot, projectName, renderRuntime, usesUnifiedComputerRuntime, workspaceNetwork } from './runtime.js';
import {
  auditState,
  atomicWrite,
  durableRemove,
  findTrash,
  loadState,
  newSecret,
  prepareStateDirectories,
  statePaths,
  withStateLock,
  type LoadedState,
} from './state.js';
import {
  createStateTransaction,
  executeStateTransaction,
  readPendingTransaction,
  recoverPendingTransaction,
} from './transactions.js';
import { upgradedComputer } from './upgrade.js';
import { setupCommand } from './setup.js';
import { checkViewerHealth } from './viewer-health.js';
import { networkCommand } from './network-policy.js';
import { secretCommand } from './secret-broker.js';
import { sshCommand } from './ssh-access.js';
import { backupCommand, checkpointCommand, cloneCommand } from './backups.js';
import { devcontainerCommand } from './devcontainer.js';
import { gitCommand } from './git-workflows.js';
import { auditCommand } from './audit-log.js';
import { creationPolicySelection, skillsCommand, synchronizeStartedSkillPolicies, toolsCommand } from './policy-commands.js';
import { browserOpenInvocation, inspectHostPlatform, windowsWslStdioLauncher } from './host-platform.js';
import { validateStatePath } from './preflight.js';
import { browserProfileCommand } from './browser-profile.js';
import { printBrowserProfileDisclosure } from './browser-profile-disclosures.js';
import { cleanupCommand } from './cleanup-command.js';
import { lifecycleUpdateStatus, upgradeAllCommand, validateUpgradeInvocation } from './lifecycle-command.js';
import {
  assertRemotePreviewUpgradeCompatibility,
  computerUpgradeRuntimePlan,
  requirePreservedRuntimeState,
} from './lifecycle-update.js';
import {
  maybePrintLocalUpdateNotification,
  parseUpdateNotificationPreference,
  readLocalPreferences,
  writeUpdateNotificationPreference,
} from './update-notifications.js';
import { gatewayCommand } from './gateway-command.js';
import {
  GatewayExposureManualProbeRequiredError,
  gatewayBindAddressPresent,
  gatewayEndpointSet,
  gatewayExposurePaths,
  probeGatewayExposure,
  validateConfiguredGatewayTls,
  validateGatewayExposureRuntimeSnapshot,
} from './gateway-access.js';

export async function execute(command: string | undefined, args: ParsedArgs): Promise<void> {
  validateInvocation(command, args);
  if (flag(args, 'help')) {
    console.log(helpText);
    return;
  }
  await prepareStateBeforeCommand(command, args);
  await maybePrintLocalUpdateNotification(command, args);
  switch (command) {
    case undefined:
    case 'help':
      console.log(helpText);
      return;
    case 'version':
      console.log(versionSummary());
      return;
    case 'setup': return setupCommand(args);
    case 'config': return config(args);
    case 'gateway': return gatewayCommand(args);
    case 'up': return up();
    case 'down': return down();
    case 'create': return create(args);
    case 'upgrade': return upgrade(args);
    case 'list': return list(args);
    case 'status': return status(args.positionals[0]);
    case 'inspect': return inspect(required(args.positionals[0], 'computer name'));
    case 'logs': return logs(args.positionals[0]);
    case 'doctor': return doctor(args);
    case 'repair': return repair(args);
    case 'start': return start(required(args.positionals[0], 'computer name'));
    case 'stop': return stop(required(args.positionals[0], 'computer name'));
    case 'restart': return restart(required(args.positionals[0], 'computer name'));
    case 'control': return control(args);
    case 'browser': return browserProfileCommand(args);
    case 'network': return networkCommand(args);
    case 'secret': return secretCommand(args);
    case 'ssh': return sshCommand(args);
    case 'backup': return backupCommand(args);
    case 'checkpoint': return checkpointCommand(args);
    case 'clone': return cloneCommand(args);
    case 'devcontainer': return devcontainerCommand(args);
    case 'git': return gitCommand(args);
    case 'audit': return auditCommand(args);
    case 'skills': return skillsCommand(args);
    case 'tools': return toolsCommand(args);
    case 'cleanup': return cleanupCommand(args);
    case 'rename': return renameComputer(required(args.positionals[0], 'old name'), required(args.positionals[1], 'new name'));
    case 'delete': return deleteComputer(required(args.positionals[0], 'computer name'));
    case 'restore': return restoreComputer(required(args.positionals[0], 'computer name or ID'));
    case 'purge': return purge(required(args.positionals[0], 'computer name or ID'), flag(args, 'yes'));
    case 'view': return view(required(args.positionals[0], 'computer name'), flag(args, 'no-open'), stringOption(args, 'access'));
    case 'connect': return connectClient(
      required(args.positionals[0], 'computer name'),
      stringOption(args, 'client') ?? 'generic',
      stringOption(args, 'transport'),
      stringOption(args, 'profile'),
      stringOption(args, 'result-mode'),
      stringOption(args, 'client-host'),
      stringOption(args, 'access'),
    );
    case 'mcp': return mcp(
      required(args.positionals[0], 'computer name'),
      ToolProfileSchema.parse(stringOption(args, 'profile') ?? 'full'),
      McpResultModeSchema.parse(stringOption(args, 'result-mode') ?? 'text'),
    );
    case 'token': return token(args);
    case 'image': return image(args);
    case 'export': return exportManifest(stringOption(args, 'output') ?? 'qubicl.yaml');
    case 'apply': return applyManifest(required(args.positionals[0], 'manifest path'), flag(args, 'dry-run'), flag(args, 'prune'));
    default: throw new Error(`Unknown command ${command}. Run qubicl help.`);
  }
}

async function config(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'config action (show or set)');
  if (action === 'show') {
    if ([...args.options.keys()].some((name) => name !== 'help')) throw new Error('Config show does not accept setting options.');
    const state = await loadState();
    await printConfig(state);
    return;
  }
  if (action !== 'set') throw new Error('Config action must be show or set.');
  const requested = {
    gatewayPort: numberOption(args, 'gateway-port'),
    preset: stringOption(args, 'default-preset'),
    image: stringOption(args, 'default-image'),
    cpus: numberOption(args, 'default-cpus'),
    memory: stringOption(args, 'default-memory'),
    updateNotifications: parseUpdateNotificationPreference(stringOption(args, 'update-notifications')),
  };
  if (Object.values(requested).every((value) => value === undefined)) {
    throw new Error('Config set requires at least one setting option.');
  }
  if (requested.preset && requested.image) throw new Error('--default-preset and --default-image are mutually exclusive.');

  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const changesManagedConfig = requested.gatewayPort !== undefined
      || requested.preset !== undefined
      || requested.image !== undefined
      || requested.cpus !== undefined
      || requested.memory !== undefined;
    if (!changesManagedConfig) {
      const preferences = await writeUpdateNotificationPreference(requested.updateNotifications!, paths);
      console.log(JSON.stringify({ localPreferences: preferences }, null, 2));
      return;
    }
    const prior = structuredClone(state.config);
    let dockerHost: Awaited<ReturnType<typeof validateDocker>> | undefined;
    if (requested.gatewayPort !== undefined) state.config.gateway.port = requested.gatewayPort;
    if (requested.preset || requested.image) {
      const host = dockerHost ??= await validateDocker();
      if (requested.preset) {
        const preset = PresetSchema.parse(requested.preset);
        const acquired = await acquireCatalogPreset(preset, { platform: host.platform });
        const defaults = presetDefaults(preset, host.platform);
        state.config.defaults = ComputerDefaultsSchema.parse({ ...defaults, image: acquired.identity });
      } else {
        const acquired = await acquireCustomImage(requested.image!, { platform: host.platform });
        const recommendation = IMAGE_CATALOG.presets[acquired.manifest.compatibility];
        state.config.defaults = ComputerDefaultsSchema.parse({
          preset: 'custom',
          compatibility: acquired.manifest.compatibility,
          image: acquired.identity,
          capabilityContractVersion: 1,
          capabilities: acquired.manifest.capabilities,
          cpus: recommendation.recommendedCpus,
          memory: recommendation.recommendedMemory,
        });
      }
    }
    if (requested.cpus !== undefined || requested.memory !== undefined) {
      const host = dockerHost ??= await validateDocker();
      if (requested.cpus !== undefined) validateCpu(requested.cpus, host.cpus);
      if (requested.memory !== undefined) requested.memory = validateMemory(requested.memory, host.memoryBytes);
    }
    if (requested.cpus !== undefined) state.config.defaults.cpus = requested.cpus;
    if (requested.memory !== undefined) state.config.defaults.memory = requested.memory;
    state.config = ConfigSchema.parse(state.config);

    const portChanged = state.config.gateway.port !== prior.gateway.port;
    if (portChanged) await assertGatewayPort(state);
    const gatewayWasRunning = portChanged && (await gatewayStatus(state)).status === 'running';
    const runningComputerIds = gatewayWasRunning
      ? (await Promise.all(state.config.computers.map(async (computer) => ({
        id: computer.id,
        running: (await containerStatus(state, computer.id)).status === 'running',
      })))).filter(({ running }) => running).map(({ id }) => id)
      : [];
    await executeStateTransaction(paths, createStateTransaction('config', state, {
      // Recreating the gateway drops the per-computer network attachments that
      // Docker Compose does not own. Directly reconnect only computers that
      // were already running, without reconciling/recreating their containers
      // or changing stopped computers' lifecycle state.
      runtime: { startGateway: gatewayWasRunning, reconnectIds: runningComputerIds },
    }));
    if (requested.updateNotifications !== undefined) {
      await writeUpdateNotificationPreference(requested.updateNotifications, paths);
    }
    await printConfig(state);
  });
}

async function printConfig(state: LoadedState): Promise<void> {
  const [gatewayDrift, defaultDrift, localPreferences] = await Promise.all([
    imageDrift(state.config.gateway.image),
    imageDrift(state.config.defaults.image, true),
    readLocalPreferences(state.paths),
  ]);
  const catalogEntry = state.config.defaults.preset === 'custom' ? undefined : IMAGE_CATALOG.presets[state.config.defaults.preset];
  const catalogDrift = catalogEntry ? catalogEntry.manifestSha256 !== state.config.defaults.image.manifestSha256 : false;
  console.log(JSON.stringify({ gateway: state.config.gateway, defaults: state.config.defaults, localPreferences, drift: { gateway: gatewayDrift, defaultImage: defaultDrift, catalog: catalogDrift } }, null, 2));
}

async function up(): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    await validateDocker();
    const runtimes = await Promise.all(state.config.computers.map(async (computer) => ({
      computer,
      runtime: await containerStatus(state, computer.id),
    })));
    // `up` still starts every configured computer, but retained containers do
    // not need their original image object merely to start again.
    await ensureRuntimeImages(state, runtimes.filter(({ runtime }) => runtime.status === 'absent').map(({ computer }) => computer));
    await renderRuntime(state);
    await startGateway(state);
    await verifyGatewayCompatibility(state);
    for (const computer of state.config.computers) {
      await startComputerPreservingRuntimeAfterGateway(state, computer);
    }
    await synchronizeStartedSkillPolicies(state, state.config.computers);
    console.log(`Started Qubicl with ${state.config.computers.length} computer${state.config.computers.length === 1 ? '' : 's'}.`);
  });
}

async function down(): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    await compose(state, ['stop']);
    console.log('Stopped Qubicl. Persistent homes were left intact.');
  });
}

async function create(args: ParsedArgs): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const host = await validateDocker();
    const presetValue = stringOption(args, 'preset');
    const image = stringOption(args, 'image');
    if (presetValue && image) throw new Error('--preset and --image are mutually exclusive.');
    const cpus = numberOption(args, 'cpus');
    const memory = stringOption(args, 'memory');
    if (cpus !== undefined) validateCpu(cpus, host.cpus);
    const normalizedMemory = memory === undefined ? undefined : validateMemory(memory, host.memoryBytes);
    let defaults: ComputerDefaults = structuredClone(state.config.defaults);
    if (presetValue) {
      const preset = PresetSchema.parse(presetValue);
      const acquired = await acquireCatalogPreset(preset, { offline: flag(args, 'offline'), platform: host.platform });
      defaults = ComputerDefaultsSchema.parse({ ...presetDefaults(preset, host.platform), image: acquired.identity });
    } else if (image) {
      const acquired = await acquireCustomImage(image, { offline: flag(args, 'offline'), platform: host.platform });
      const recommendation = IMAGE_CATALOG.presets[acquired.manifest.compatibility];
      defaults = ComputerDefaultsSchema.parse({
        preset: 'custom',
        compatibility: acquired.manifest.compatibility,
        image: acquired.identity,
        capabilityContractVersion: 1,
        capabilities: acquired.manifest.capabilities,
        cpus: recommendation.recommendedCpus,
        memory: recommendation.recommendedMemory,
      });
    }
    defaults = ComputerDefaultsSchema.parse({ ...defaults, ...(cpus === undefined ? {} : { cpus }), ...(normalizedMemory === undefined ? {} : { memory: normalizedMemory }) });
    const recommendation = PRESET_DEFINITIONS[defaults.compatibility];
    if (defaults.cpus < recommendation.cpus || memoryBytes(defaults.memory) < memoryBytes(recommendation.memory)) {
      console.warn(`Warning: resources are below the tested ${defaults.compatibility} recommendation (${recommendation.cpus} CPU / ${recommendation.memory}).`);
    }
    const policies = await creationPolicySelection(
      { capabilities: defaults.capabilities, compatibility: defaults.compatibility },
      stringOption(args, 'skills'),
      stringOption(args, 'tools'),
      flag(args, 'yes'),
    );
    const computer = addConfiguredComputer(state, args.positionals[0], defaults, policies);
    const nonCoreSkills = computer.skillPolicy?.enabledCatalogSkills.filter((id) => !(CORE_SKILL_IDS as readonly string[]).includes(id)) ?? [];
    if (nonCoreSkills.length) console.warn('Warning: imported skills are operator-reviewed but best-effort; verify their declared tools and commands before use.');
    const startNow = !flag(args, 'no-start');
    // Creating one computer must not depend on an unrelated stopped
    // computer's pinned image still being available.
    await ensureRuntimeImages(state, [computer], flag(args, 'offline'));
    await executeStateTransaction(paths, createStateTransaction('create', state, {
      activeSources: { [computer.id]: 'create' },
      runtime: { ensureImages: false, startIds: startNow ? [computer.id] : [] },
    }));
    if (startNow) await synchronizeStartedSkillPolicies(state, [computer]);
    const result = buildComputerConnectionResult(state.config.gateway.port, computer, startNow, state.config.gateway.exposure);
    if (flag(args, 'json')) console.log(JSON.stringify(result, null, 2));
    else printComputerHandoff(result, console.log);
  });
}

async function upgrade(args: ParsedArgs): Promise<void> {
  if (flag(args, 'all')) return upgradeAllCommand(args);
  if (flag(args, 'yes')) throw new Error('--yes is accepted only with qubicl upgrade --all.');
  return upgradeComputer(args);
}

async function upgradeComputer(args: ParsedArgs): Promise<void> {
  const name = required(args.positionals[0], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const host = await validateDocker();
    const current = findComputer(state, name);
    const reviewedComputerObservation = await managedComputerRuntimeObservation(state, current);
    const reviewedRuntime = requirePreservedRuntimeState(
      reviewedComputerObservation,
      `Computer ${current.name}`,
    );
    const reviewedGatewayObservation = await managedGatewayRuntimeObservation(state);
    const reviewedGatewayRuntime = requirePreservedRuntimeState(
      reviewedGatewayObservation,
      'Gateway',
    );
    if (reviewedRuntime === 'running' && reviewedGatewayRuntime !== 'running') {
      throw new Error(`Computer ${current.name} is running while the gateway is ${reviewedGatewayRuntime}; reconcile the runtime before upgrading.`);
    }
    printBrowserProfileDisclosure('upgrade');
    const presetValue = stringOption(args, 'preset');
    const image = stringOption(args, 'image');
    if (presetValue && image) throw new Error('--preset and --image are mutually exclusive.');

    let imageDefaults: ComputerDefaults;
    let targetPreviewAccessProtocol: typeof COMPUTER_PREVIEW_ACCESS_PROTOCOL | undefined;
    const targetPreset = presetValue ?? (image || current.preset === 'custom' ? undefined : current.preset);
    if (targetPreset) {
      const preset = PresetSchema.parse(targetPreset);
      const acquired = await acquireCatalogPreset(preset, {
        offline: flag(args, 'offline'),
        platform: host.platform,
      });
      targetPreviewAccessProtocol = acquired.compatibility.previewAccessProtocol;
      imageDefaults = ComputerDefaultsSchema.parse({
        ...presetDefaults(preset, host.platform),
        image: acquired.identity,
      });
    } else {
      const requested = image ?? current.image.requested;
      const acquired = await acquireCustomImage(requested, {
        offline: flag(args, 'offline'),
        platform: host.platform,
      });
      targetPreviewAccessProtocol = acquired.compatibility.previewAccessProtocol;
      const recommendation = IMAGE_CATALOG.presets[acquired.manifest.compatibility];
      imageDefaults = ComputerDefaultsSchema.parse({
        preset: 'custom',
        compatibility: acquired.manifest.compatibility,
        image: acquired.identity,
        capabilityContractVersion: 1,
        capabilities: acquired.manifest.capabilities,
        cpus: recommendation.recommendedCpus,
        memory: recommendation.recommendedMemory,
      });
    }
    assertRemotePreviewUpgradeCompatibility(
      state.config.gateway.exposure?.previewDomain,
      current.name,
      targetPreviewAccessProtocol,
    );

    const replacement = upgradedComputer(current, imageDefaults);
    const recommendation = PRESET_DEFINITIONS[replacement.compatibility];
    if (replacement.cpus < recommendation.cpus || memoryBytes(replacement.memory) < memoryBytes(recommendation.memory)) {
      console.warn(`Warning: preserved resources are below the tested ${replacement.compatibility} recommendation (${recommendation.cpus} CPU / ${recommendation.memory}).`);
    }
    const currentComputerObservation = await managedComputerRuntimeObservation(state, current);
    const currentRuntime = requirePreservedRuntimeState(
      currentComputerObservation,
      `Computer ${current.name}`,
    );
    const currentGatewayObservation = await managedGatewayRuntimeObservation(state);
    const currentGatewayRuntime = requirePreservedRuntimeState(
      currentGatewayObservation,
      'Gateway',
    );
    if (currentRuntime !== reviewedRuntime
      || currentGatewayRuntime !== reviewedGatewayRuntime
      || JSON.stringify(currentComputerObservation.containers) !== JSON.stringify(reviewedComputerObservation.containers)
      || JSON.stringify(currentGatewayObservation.containers) !== JSON.stringify(reviewedGatewayObservation.containers)) {
      throw new Error(`Runtime state changed during image acquisition (computer ${reviewedRuntime} -> ${currentRuntime}; gateway ${reviewedGatewayRuntime} -> ${currentGatewayRuntime}). No Qubicl state or runtime was changed.`);
    }
    const index = state.config.computers.findIndex(({ id }) => id === current.id);
    state.config.computers[index] = replacement;
    state.config = ConfigSchema.parse(state.config);

    await executeStateTransaction(paths, createStateTransaction('upgrade', state, {
      runtime: computerUpgradeRuntimePlan(
        reviewedRuntime,
        replacement.id,
        reviewedComputerObservation.containers,
        reviewedGatewayObservation.containers,
      ),
    }));
    if (reviewedRuntime === 'running') await synchronizeStartedSkillPolicies(state, [replacement]);
    console.log(`Upgraded ${replacement.name} to ${replacement.image.resolved}.`);
    console.log(`Computer ID, token, resources, policy, and durable home are unchanged. Runtime state was preserved as ${reviewedRuntime}.`);
  });
}

async function list(args: ParsedArgs): Promise<void> {
  const state = await loadState();
  const rows = await Promise.all(state.config.computers.map(async (computer) => ({ computer, runtime: await containerStatus(state, computer.id), imageDrift: await imageDrift(computer.image, true) })));
  if (flag(args, 'json')) {
    console.log(JSON.stringify(rows.map(({ computer, runtime, imageDrift: drift }) => ({ ...computer, runtime, imageDrift: drift })), null, 2));
    return;
  }
  if (!rows.length) { console.log('No Qubicl computers.'); return; }
  console.log('NAME\tSTATUS\tHEALTH\tPRESET\tCOMPATIBILITY\tDRIFT\tID\tIMAGE');
  for (const { computer, runtime, imageDrift: drift } of rows) console.log(`${computer.name}\t${runtime.status}\t${runtime.health ?? '-'}\t${computer.preset}\t${computer.compatibility}\t${drift.drifted ? 'yes' : 'no'}\t${computer.id}\t${computer.image.resolved}`);
}

async function status(name?: string): Promise<void> {
  const state = await loadState();
  const dockerHost = await validateDocker();
  const updates = await lifecycleUpdateStatus(state, dockerHost.platform);
  if (name) {
    const computer = findComputer(state, name);
    const update = updates.rows.find(({ key }) => key === `computer:${computer.id}`);
    console.log(JSON.stringify({
      qubicl: QUBICL_BUILD,
      ...computer,
      resourceEnvelope: computerResourceEnvelope(computer),
      runtime: await containerStatus(state, computer.id),
      update,
      imageDrift: await imageDrift(computer.image, true),
      recoveryRequired: updates.recoveryRequired,
      endpoints: applicableEndpoints(state, computer),
    }, null, 2));
    return;
  }
  const gateway = await docker(['inspect', '--format', '{{.State.Status}}', gatewayContainerName(state.config.installationId, state.paths.root)], { allowFailure: true });
  const computers = await Promise.all(state.config.computers.map(async (computer) => ({
    name: computer.name,
    id: computer.id,
    preset: computer.preset,
    compatibility: computer.compatibility,
    capabilities: computer.capabilities,
    resourceEnvelope: computerResourceEnvelope(computer),
    image: computer.image,
    update: updates.rows.find(({ key }) => key === `computer:${computer.id}`),
    imageDrift: await imageDrift(computer.image, true),
    ...(await containerStatus(state, computer.id)),
  })));
  console.log(JSON.stringify({
    qubicl: QUBICL_BUILD,
    updates,
    gateway: {
      runtime: gateway || 'absent',
      config: state.config.gateway,
      update: updates.rows.find(({ key }) => key === 'gateway'),
      imageDrift: await imageDrift(state.config.gateway.image),
    },
    computers,
  }, null, 2));
}

async function inspect(name: string): Promise<void> {
  const state = await loadState();
  const computer = findComputer(state, name);
  const runtime = await docker(['inspect', computerContainerName(state, computer)], { allowFailure: true });
  console.log(JSON.stringify(redactSecrets({ config: computer, imageDrift: await imageDrift(computer.image, true), endpoints: applicableEndpoints(state, computer), runtime: runtime ? JSON.parse(runtime) : null }), null, 2));
}

async function logs(name?: string): Promise<void> {
  const state = await loadState();
  const services = name ? (() => {
    const computer = findComputer(state, name);
    return [
      computerServiceName(state, computer),
      computerExecutorServiceName(state, computer),
      computerEgressServiceName(state, computer),
      ...(computer.capabilities.includes('viewer') ? [computerSessionServiceName(state, computer)] : []),
      ...(computer.ssh?.enabled ? [computerSshServiceName(state, computer)] : []),
    ];
  })() : [];
  await compose(state, ['logs', '--tail', '200', ...services], { inherit: true });
}

async function doctor(args: ParsedArgs): Promise<void> {
  const platformHost = await inspectHostPlatform();
  const checks: DoctorCheck[] = [
    { status: 'ok', check: 'qubicl', detail: `${QUBICL_BUILD.version} revision=${QUBICL_BUILD.revision} built=${QUBICL_BUILD.date}` },
    {
      status: ['darwin', 'linux'].includes(platformHost.platform) && ['arm64', 'x64'].includes(platformHost.arch) ? 'ok' : 'fail',
      check: 'platform',
      detail: `${platformHost.platform}-${platformHost.arch}`,
    },
    {
      status: supportedNodeVersion() ? 'ok' : 'fail',
      check: 'node',
      detail: `${process.versions.node} (supported: ${SUPPORTED_NODE_RANGE})`,
    },
  ];
  if (platformHost.wsl) {
    checks.push({
      status: platformHost.wsl.version === 2 ? 'ok' : 'fail',
      check: 'wsl-version',
      detail: `WSL ${platformHost.wsl.version}${platformHost.wsl.distro ? ` (${platformHost.wsl.distro})` : ''}; kernel ${platformHost.wsl.kernelRelease || 'unknown'}`,
    });
    checks.push({
      status: platformHost.wsl.interop ? 'ok' : 'warning',
      check: 'wsl-interop',
      detail: platformHost.wsl.interop ? 'Windows executable interoperability is available' : 'Windows executable interoperability is disabled',
    });
  }

  try {
    checks.push({ status: 'ok', check: 'docker-cli', detail: await docker(['--version']) });
  } catch (error) {
    checks.push({ status: 'fail', check: 'docker-cli', detail: message(error) });
  }

  let engineAvailable = false;
  try {
    const host = await validateDocker();
    engineAvailable = true;
    checks.push({ status: 'ok', check: 'docker-context', detail: `${host.context}: ${host.endpoint}` });
    checks.push({ status: 'ok', check: 'docker-engine', detail: `${host.engineVersion} (minimum: ${MIN_DOCKER_ENGINE_VERSION}); ${host.platform}` });
    checks.push({ status: 'ok', check: 'docker-compose', detail: `${host.composeVersion} (minimum: ${MIN_DOCKER_COMPOSE_VERSION})` });
    checks.push({ status: 'ok', check: 'docker-resources', detail: `${host.cpus} CPU; ${host.memoryBytes} bytes memory` });
  } catch (error) {
    checks.push({
      status: 'fail',
      check: 'docker-host',
      detail: message(error),
      ...(platformHost.wsl ? { repair: 'Start Docker Desktop and enable WSL integration for this distribution, then verify docker version as the normal WSL user.' } : {}),
    });
  }

  let state: LoadedState | undefined;
  const paths = statePaths();
  try {
    checks.push({ status: 'ok', check: 'state-path-host', detail: await validateStatePath(paths.root) });
  } catch (error) {
    checks.push({
      status: 'fail',
      check: 'state-path-host',
      detail: message(error),
      repair: platformHost.wsl
        ? 'Move QUBICL_HOME to a user-owned WSL Linux path such as /home/<user>/.qubicl, then restore or set up state there.'
        : 'Move QUBICL_HOME to an absolute, user-owned path with no symlinked components.',
    });
  }
  const stateFormat = await inspectStateFormat(paths);
  checks.push({
    status: stateFormat.status === 'current' ? 'ok' : stateFormat.status === 'legacy' ? 'warning' : 'fail',
    check: 'state-format',
    detail: stateFormat.detail,
  });
  if (stateFormat.status === 'current') {
    try {
      state = await loadState(paths);
      checks.push({ status: 'ok', check: 'state', detail: state.paths.root });
      try {
        await access(state.paths.root, fsConstants.R_OK | fsConstants.W_OK);
        checks.push({ status: 'ok', check: 'state-home-access', detail: `${state.paths.root} is readable and writable` });
      } catch (error) {
        checks.push({ status: 'fail', check: 'state-home-access', detail: message(error), repair: `Restore read/write ownership of ${state.paths.root} to the current user.` });
      }
      checks.push(...(await auditState(state)).map(({ check, ok, detail }) => ({ status: ok ? 'ok' as const : 'fail' as const, check, detail })));
      checks.push(...await gatewayExposureStateChecks(state));
    } catch (error) {
      checks.push({ status: 'fail', check: 'state', detail: message(error) });
    }
  }

  if (state && engineAvailable) {
    const computerRuntimes = new Map(await Promise.all(state.config.computers.map(async (computer) => (
      [computer.name, await containerStatus(state, computer.id)] as const
    ))));
    const imageChecks = await doctorImageChecks(
      state.config,
      imageExists,
      async (name) => computerRuntimes.get(name) ?? { status: 'absent' },
    );
    for (const [index, imageCheck] of imageChecks.entries()) {
      checks.push({
        status: imageCheck.status,
        check: `image-${index + 1}`,
        detail: imageCheck.detail,
        ...(imageCheck.repair ? { repair: imageCheck.repair } : {}),
      });
    }

    const gateway = await gatewayStatus(state);
    checks.push(runtimeCheck('gateway-runtime', gateway));
    if (gateway.status === 'running') {
      const response = await fetch(`http://127.0.0.1:${state.config.gateway.port}/health`).catch(() => undefined);
      let gatewayHealthDocument: unknown;
      if (response?.ok) {
        try { gatewayHealthDocument = await response.json(); }
        catch { gatewayHealthDocument = undefined; }
      }
      checks.push({
        status: response?.ok ? 'ok' : 'fail',
        check: 'gateway-health',
        detail: response ? `HTTP ${response.status} on 127.0.0.1:${state.config.gateway.port}` : `not reachable on 127.0.0.1:${state.config.gateway.port}`,
      });
      if (state.config.gateway.exposure) {
        const exposure = state.config.gateway.exposure;
        const readiness = gatewayExternalReadinessCheck(
          gatewayHealthDocument,
          gatewayExposureRuntimeId(gatewayExposureRuntime(exposure)),
        );
        checks.push(readiness);
        try {
          if (readiness.status !== 'ok') {
            // The local health contract is authoritative even when a raw TLS
            // socket happens to accept a connection during partial startup.
          } else if (state.secrets.gateway?.tls.clientCertificateAuthorityPem) {
            checks.push({
              status: 'warning',
              check: 'gateway-external-tls',
              detail: 'The direct TLS listener reports ready locally; an authenticated end-to-end probe requires an operator-provided client certificate',
            });
          } else {
            const probe = await probeGatewayExposure(exposure);
            checks.push({
              status: 'ok',
              check: 'gateway-external-tls',
              detail: `${probe.protocol}; HTTP ${probe.statusCode}; ${probe.fingerprint256}`,
            });
          }
        } catch (error) {
          checks.push({
            status: error instanceof GatewayExposureManualProbeRequiredError ? 'warning' : 'fail',
            check: 'gateway-external-tls',
            detail: message(error),
            ...(error instanceof GatewayExposureManualProbeRequiredError
              ? {}
              : { repair: 'Verify the configured bind address and certificate, then re-run qubicl gateway expose with the intended TLS material.' }),
          });
        }
        checks.push({
          status: 'warning',
          check: 'gateway-external-firewall',
          detail: 'Qubicl does not manage or prove the host firewall, router, DNS, or Docker Desktop client-IP forwarding; verify those boundaries separately',
        });
      }
      checks.push(...await gatewaySecurityChecks(state));
    } else {
      const available = await portAvailable(state.config.gateway.port);
      checks.push({
        status: available ? 'ok' : 'fail',
        check: 'gateway-port',
        detail: available
          ? `127.0.0.1:${state.config.gateway.port} is available for Qubicl`
          : `127.0.0.1:${state.config.gateway.port} is occupied by another process`,
        ...(!available ? { repair: 'Stop the conflicting process or run qubicl config set --gateway-port PORT with a free port.' } : {}),
      });
    }
    for (const computer of state.config.computers) {
      const runtime = computerRuntimes.get(computer.name)!;
      checks.push(runtimeCheck(`computer-${computer.name}-runtime`, runtime));
      if (runtime.status === 'running') {
        const response = await fetch(endpoints(state, computer).health).catch(() => undefined);
        checks.push({
          status: response?.ok ? 'ok' : 'fail',
          check: `computer-${computer.name}-route`,
          detail: response ? `gateway returned HTTP ${response.status}` : 'gateway route is unreachable',
        });
        if (computer.capabilities.includes('viewer')) {
          try {
            const detail = await checkViewerHealth(
              `http://127.0.0.1:${state.config.gateway.port}/computers/${computer.id}`,
              state.secrets.computers[computer.id]!.token,
            );
            checks.push({ status: 'ok', check: `computer-${computer.name}-viewer`, detail });
          } catch (error) {
            checks.push({
              status: 'fail',
              check: `computer-${computer.name}-viewer`,
              detail: message(error),
              repair: `Run qubicl restart ${computer.name}, then inspect qubicl logs ${computer.name} if the viewer still fails.`,
            });
          }
        }
        checks.push(...await computerSecurityChecks(state, computer));
      }
    }
    checks.push(await runtimeInventoryCheck(state));
  }

  for (const check of checks) {
    const repair = doctorRepair(check);
    if (!check.repair && repair) check.repair = repair;
  }
  if (flag(args, 'json')) {
    console.log(JSON.stringify({ ok: !checks.some(({ status }) => status === 'fail'), warnings: checks.filter(({ status }) => status === 'warning').length, checks }, null, 2));
  } else {
    for (const check of checks) {
      console.log(`${check.status === 'warning' ? 'WARN' : check.status === 'fail' ? 'FAIL' : 'ok'}\t${check.check}\t${check.detail}${check.repair ? `\trepair: ${check.repair}` : ''}`);
    }
  }
  if (checks.some(({ status }) => status === 'fail')) throw new Error('One or more doctor checks failed.');
}

export function gatewayExternalReadinessCheck(value: unknown, expectedConfigurationId?: string): DoctorCheck {
  const external = (value as { external?: unknown } | null)?.external as {
    configured?: unknown;
    ready?: unknown;
    protocol?: unknown;
    configurationId?: unknown;
  } | undefined;
  const ok = external?.configured === true
    && external.ready === true
    && external.protocol === 'direct-tls-v1'
    && (expectedConfigurationId === undefined || external.configurationId === expectedConfigurationId);
  return ok
    ? { status: 'ok', check: 'gateway-external-readiness', detail: 'local gateway health confirms direct-tls-v1 is configured and ready' }
    : {
      status: 'fail',
      check: 'gateway-external-readiness',
      detail: 'local gateway health did not confirm configured, ready direct-tls-v1 exposure',
      repair: 'Inspect the managed TLS snapshot and external bind, then re-run qubicl gateway expose or revoke the exposure.',
    };
}

async function repair(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'repair action');
  if (action !== 'ownership') throw new Error('Repair action must be ownership.');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    await validateDocker();
    const runtime = await containerStatus(state, computer.id);
    if (['running', 'restarting', 'paused', 'removing'].includes(runtime.status)) {
      throw new Error(`Stop ${computer.name} before repairing its home ownership.`);
    }
    if (!(await imageExists(computer.image.resolved))) {
      throw new Error(`Computer image ${computer.image.resolved} is not available locally. Obtain or build it before repairing ownership.`);
    }
    if (!flag(args, 'yes')) {
      if (!stdin.isTTY) throw new Error('Ownership repair requires --yes when stdin is not interactive.');
      const prompt = createInterface({ input: stdin, output: stdout });
      const answer = await prompt.question(`Recursively set the durable home for ${computer.name} to the current host user? Type its name to confirm: `);
      prompt.close();
      if (answer !== computer.name) throw new Error('Confirmation did not match; ownership was not changed.');
    }

    const { uid, gid } = hostIdentity();
    const homeRoot = join(state.paths.computers, computer.id, 'home');
    const journal = join(state.paths.computers, computer.id, 'ownership-repair.json');
    const repairCompose = join(state.paths.computers, computer.id, 'ownership-repair.compose.yaml');
    await atomicWrite(journal, `${JSON.stringify({ version: 1, computerId: computer.id, uid, gid, startedAt: new Date().toISOString() }, null, 2)}\n`, 0o600);
    await atomicWrite(repairCompose, YAML.stringify({
      name: `qubicl-ownership-repair-${computer.id.replaceAll('-', '')}`,
      services: {
        repair: {
          image: computer.image.resolved,
          user: '0:0',
          network_mode: 'none',
          read_only: true,
          pids_limit: 64,
          cap_drop: ['ALL'],
          cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
          security_opt: ['no-new-privileges:true'],
          entrypoint: '/bin/bash',
          environment: { QUBICL_REPAIR_UID: `${uid}`, QUBICL_REPAIR_GID: `${gid}` },
          volumes: [{ type: 'bind', source: homeRoot, target: '/home' }],
        },
      },
    }), 0o600);
    console.log(`Repairing ${computer.name}. This scans its durable home once and can be safely re-run if interrupted.`);
    try {
      await docker([
        'compose',
        '--project-name', `qubicl-repair-${computer.id.replaceAll('-', '').slice(0, 12)}`,
        '--file', repairCompose,
        'run', '--rm', '--no-deps', 'repair',
        '-ceu',
        'test -d /home/qubicl; find /home/qubicl -xdev \\( -type d -o -type f \\) -exec chown -- "${QUBICL_REPAIR_UID}:${QUBICL_REPAIR_GID}" {} +; for marker in /home/qubicl/.qubicl-owner /home/qubicl/.qubicl-initialized; do if [ -d "$marker" ] && [ ! -L "$marker" ]; then echo "Refusing to replace marker directory $marker" >&2; exit 1; fi; rm -f -- "$marker"; done; printf "%s:%s\\n" "$QUBICL_REPAIR_UID" "$QUBICL_REPAIR_GID" > /home/qubicl/.qubicl-owner; touch /home/qubicl/.qubicl-initialized; chown -- "${QUBICL_REPAIR_UID}:${QUBICL_REPAIR_GID}" /home/qubicl/.qubicl-owner /home/qubicl/.qubicl-initialized',
      ], { inherit: true });
      await durableRemove(repairCompose);
      await durableRemove(journal);
      console.log(`Repaired ${computer.name}. Start it with qubicl start ${computer.name}.`);
    } catch (error) {
      await durableRemove(repairCompose).catch(() => undefined);
      throw new Error(`Ownership repair did not finish. Its journal remains at ${journal}; re-run the same command to resume safely. ${message(error)}`);
    }
  });
}

async function start(name: string): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    await validateDocker();
    const computer = findComputer(state, name);
    const runtime = await containerStatus(state, computer.id);
    await ensureRuntimeImages(state, runtime.status === 'absent' ? [computer] : []);
    await renderRuntime(state);
    await startComputer(state, computer);
    await synchronizeStartedSkillPolicies(state, [computer]);
    console.log(`Started ${computer.name}.`);
  });
}

async function stop(name: string): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    const runtime = await containerStatus(state, computer.id);
    if (runtime.status === 'absent') throw new Error(`Computer ${computer.name} has no retained runtime to stop.`);
    const containers = await existingComputerRuntimeContainers(state, computer);
    await docker(['stop', ...containers]);
    console.log(`Stopped ${computer.name}. Its home remains durable; root changes are not guaranteed.`);
  });
}

async function restart(name: string): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    const runtime = await containerStatus(state, computer.id);
    if (runtime.status === 'absent') {
      throw new Error(`Computer ${computer.name} has no retained runtime to restart. Use qubicl start ${computer.name}; recreating it requires its exact pinned image ${computer.image.resolved}.`);
    }
    // Docker can restart an existing container from its retained snapshot even
    // when its original image object can no longer be used to recreate it.
    await ensureRuntimeImages(state, []);
    await renderRuntime(state);
    await startGateway(state);
    await verifyGatewayCompatibility(state);
    const expected = computerRuntimeContainerNames(state, computer);
    const existing = await existingComputerRuntimeContainers(state, computer);
    if (existing.length === expected.length) await docker(['restart', ...existing]);
    else await compose(state, ['up', '--detach', computerServiceName(state, computer)]);
    try { await docker(['network', 'connect', controlNetwork(state.config.installationId, computer.id, state.paths.root), gatewayContainerName(state.config.installationId, state.paths.root)]); } catch (error) {
      if (!message(error).includes('already exists in network')) throw error;
    }
    await waitForHealthy(state, computer.id);
    await waitForGatewayComputer(state, computer.id);
    await releaseHumanControlThroughGateway(state, computer);
    console.log(`Restarted ${computer.name}.`);
  });
}

async function existingComputerRuntimeContainers(state: LoadedState, computer: ComputerConfig): Promise<string[]> {
  const results: string[] = [];
  for (const name of computerRuntimeContainerNames(state, computer)) {
    if (await docker(['inspect', '--format', '{{.Id}}', name], { allowFailure: true })) results.push(name);
  }
  return results;
}

async function control(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'control action');
  if (action !== 'release') throw new Error(`Unknown control action ${action}. Run qubicl help.`);
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    await releaseHumanControlThroughGateway(state, computer);
    console.log(`Released human control of ${computer.name}. Agents may acquire a fresh lease.`);
  });
}

async function releaseHumanControlThroughGateway(state: LoadedState, computer: ComputerConfig): Promise<void> {
  const secret = state.secrets.computers[computer.id];
  if (!secret) throw new Error(`Missing secret material for ${computer.name}.`);
  const response = await fetch(
    `http://127.0.0.1:${state.config.gateway.port}/computers/${computer.id}/operator/human-control/release`,
    { method: 'POST', headers: { authorization: `Bearer ${secret.token}` } },
  ).catch((error: unknown) => {
    throw new Error(`Could not reach the Qubicl gateway to release human control: ${message(error)}`);
  });
  if (response.ok) return;
  const detail = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  throw new Error(detail?.error?.message ?? `Gateway returned HTTP ${response.status} while releasing human control.`);
}

async function renameComputer(oldName: string, newName: string): Promise<void> {
  assertValidName(newName);
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, oldName);
    await validateDocker();
    const priorRuntime = await containerStatus(state, computer.id);
    if (state.config.computers.some(({ name, id }) => name === newName && id !== computer.id)) throw new Error(`Computer name ${newName} is already in use.`);
    const friendlyRuntime = isPrimaryRuntimeRoot(state.paths.root);
    if (friendlyRuntime && newName === 'gateway') throw new Error('Computer name gateway is reserved by the primary Qubicl runtime.');
    // Recover against the retained old-name container before the primary
    // namespace migration changes its lookup name.
    if (friendlyRuntime) await reconcileRuntimeImageContracts(state);
    computer.name = newName;
    if (friendlyRuntime) computer.runtimeName = newName;
    if (friendlyRuntime) await prepareRuntimeMigration(state);
    const restart = priorRuntime.status === 'running' || priorRuntime.status === 'restarting';
    await executeStateTransaction(paths, createStateTransaction('rename', state, {
      runtime: { startIds: !friendlyRuntime && restart ? [computer.id] : [] },
    }));
    if (friendlyRuntime) await migrateLegacyRuntime(state);
    console.log(`Renamed ${oldName} to ${newName}. ID, routes, token, and home are unchanged.`);
  });
}

async function deleteComputer(name: string): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    await validateDocker();
    const computer = findComputer(state, name);
    printBrowserProfileDisclosure('delete');
    state.config.computers = state.config.computers.filter(({ id }) => id !== computer.id);
    delete state.secrets.computers[computer.id];
    const metadata = { ...computer, deletedAt: new Date().toISOString() };
    await executeStateTransaction(paths, createStateTransaction('delete', state, {
      trash: [metadata],
      runtime: { removeIds: [computer.id] },
    }));
    console.log(`Moved ${computer.name} to recoverable trash and invalidated its token.`);
  });
}

async function restoreComputer(name: string): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    await validateDocker();
    const found = await findTrash(state.paths, name);
    if (state.config.computers.some(({ name: activeName }) => activeName === found.metadata.name)) throw new Error(`Active computer name ${found.metadata.name} is already in use.`);
    printBrowserProfileDisclosure('restore');
    const { deletedAt: _deletedAt, ...computer } = found.metadata;
    state.config.computers.push(computer);
    state.secrets.computers[computer.id] = newSecret();
    await ensureRuntimeImages(state, [computer]);
    await executeStateTransaction(paths, createStateTransaction('restore', state, {
      activeSources: { [computer.id]: 'trash' },
      runtime: { ensureImages: false, startIds: [computer.id] },
    }));
    await synchronizeStartedSkillPolicies(state, [computer]);
    console.log(`Restored ${computer.name} with the same ID, route, and home and a new token.`);
    printConnection(state, computer);
  });
}

async function purge(name: string, yes: boolean): Promise<void> {
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const found = await findTrash(state.paths, name);
    printBrowserProfileDisclosure('purge');
    if (!yes) {
      if (!stdin.isTTY) throw new Error('Permanent purge requires --yes when stdin is not interactive.');
      const prompt = createInterface({ input: stdin, output: stdout });
      const answer = await prompt.question(`Permanently delete the home for ${found.metadata.name}? Type its name to confirm: `);
      prompt.close();
      if (answer !== found.metadata.name) throw new Error('Confirmation did not match; nothing was purged.');
    }
    await rm(found.directory, { recursive: true, force: false });
    await rm(join(state.paths.audits, `${found.metadata.id}.jsonl`), { force: true });
    console.log(`Permanently purged ${found.metadata.name}. This cannot be recovered by Qubicl.`);
  });
}

async function view(name: string, noOpen: boolean, accessValue?: string): Promise<void> {
  const state = await loadState();
  const computer = findComputer(state, name);
  if (!computer.capabilities.includes('viewer')) throw new Error(`${computer.name} uses the ${computer.compatibility} capability contract, which does not provide a viewer. Choose browser, computer, or workstation for desktop viewing.`);
  const secret = state.secrets.computers[computer.id]!;
  const access = parseGatewayAccess(accessValue);
  const local = gatewayEndpointSet(state.config.gateway, computer, 'local')!;
  const selected = gatewayEndpointSet(state.config.gateway, computer, access);
  if (!selected) throw new Error('Remote gateway access is off. Run qubicl gateway expose before requesting --access remote.');
  const response = await fetch(`${local.origin}/computers/${computer.id}/view-ticket`, { method: 'POST', headers: { authorization: `Bearer ${secret.token}` } });
  const value = await response.json() as { url?: string; error?: { message?: string } };
  if (!response.ok || !value.url) throw new Error(value.error?.message ?? `Gateway returned ${response.status}.`);
  const url = `${selected.origin}${value.url}`;
  console.log(url);
  if (!noOpen) await openBrowser(url);
}

async function connectClient(
  name: string,
  client: string,
  transport: string | undefined,
  profile: string | undefined,
  resultMode: string | undefined,
  clientHost: string | undefined,
  accessValue: string | undefined,
): Promise<void> {
  if (profile) ToolProfileSchema.parse(profile);
  if (resultMode) McpResultModeSchema.parse(resultMode);
  const state = await loadState();
  const computer = findComputer(state, name);
  const access = parseGatewayAccess(accessValue);
  const selectedEndpoints = gatewayEndpointSet(state.config.gateway, computer, access);
  if (!selectedEndpoints) throw new Error('Remote gateway access is off. Run qubicl gateway expose before requesting --access remote.');
  const host = clientHost === 'windows' ? await inspectHostPlatform() : undefined;
  const snippet = connectionSnippet({
    client,
    computerName: computer.name,
    endpoints: { mcp: selectedEndpoints.mcp, openapi: selectedEndpoints.openapi },
    ...(transport === undefined ? {} : { transport }),
    ...(profile === undefined ? {} : { profile }),
    ...(resultMode === undefined ? {} : { resultMode }),
    ...(clientHost === undefined ? {} : { clientHost }),
    ...(host === undefined ? {} : { stdioLauncher: windowsWslStdioLauncher(host) }),
  });
  if (access === 'remote' && snippet.transport === 'stdio') {
    throw new Error('--access remote requires an HTTP or OpenAPI connection; token-free stdio remains local.');
  }
  const instructions = connectionInstructions(snippet);
  for (const line of instructions.before) console.error(line);
  console.log(snippet.content);
  for (const line of instructions.after) console.error(line);
}

async function mcp(name: string, profile: import('@qubicl/core').ToolProfile, resultMode: import('@qubicl/core').McpResultMode): Promise<void> {
  serveMcpBridge(await loadState(), name, { profile, resultMode });
}

async function token(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'token action (show or rotate)');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    if (action === 'show') { console.log(state.secrets.computers[computer.id]!.token); return; }
    if (action !== 'rotate') throw new Error('Token action must be show or rotate.');
    state.secrets.computers[computer.id]!.token = newSecret().token;
    await executeStateTransaction(paths, createStateTransaction('token-rotate', state, {
      runtime: { verifyTokenIds: [computer.id] },
    }));
    console.log(state.secrets.computers[computer.id]!.token);
  });
}

async function image(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'image action');
  if (action === 'build-system') {
    if (args.positionals.length !== 1) throw new Error('Image build-system does not accept additional arguments.');
    await buildSystemImages();
    return;
  }
  if (action !== 'build') throw new Error('Image action must be build.');
  if (args.positionals.length !== 3) throw new Error('Image build requires an image tag and build directory.');
  const tag = required(args.positionals[1], 'image tag');
  const directory = resolve(required(args.positionals[2], 'build directory'));
  await docker(['build', '--tag', tag, directory], { inherit: true });
}

async function exportManifest(output: string): Promise<void> {
  const state = await loadState();
  const manifest: QubiclManifest = {
    version: 2,
    gateway: { port: state.config.gateway.port, image: state.config.gateway.image },
    defaults: state.config.defaults,
    computers: state.config.computers.map(({ name, preset, compatibility, image, capabilityContractVersion, capabilities, cpus, memory }) => ({
      name, preset, compatibility, image, capabilityContractVersion, capabilities, cpus, memory,
    })),
  };
  await writeFile(resolve(output), YAML.stringify(manifest));
  console.log(`Exported secret-free manifest to ${resolve(output)}.`);
}

async function applyManifest(path: string, dryRun: boolean, prune: boolean): Promise<void> {
  const document = YAML.parse(await readFile(resolve(path), 'utf8')) as unknown;
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const { manifest, migrated } = parseManifestDocument(document, state.config);
    const reconciliation = reconcileManifest(state.config, manifest, prune);
    const deletes = reconciliation.trashes;
    console.log(JSON.stringify({ manifestMigratedFromV1: migrated, create: reconciliation.creates.map(({ name }) => name), update: reconciliation.updates.map(({ name }) => name), trash: deletes.map(({ name }) => name), gateway: reconciliation.gatewayChanged ? manifest.gateway : 'unchanged', defaults: reconciliation.defaultsChanged ? manifest.defaults : 'unchanged' }, null, 2));
    if (dryRun) return;
    await validateDocker();

    const localExposure = state.config.gateway.exposure;
    const targetGateway = {
      ...structuredClone(manifest.gateway),
      ...(localExposure ? { exposure: structuredClone(localExposure) } : {}),
    };
    if (reconciliation.gatewayChanged && state.config.gateway.port !== manifest.gateway.port) {
      const priorGateway = state.config.gateway;
      state.config.gateway = targetGateway;
      try { await assertGatewayPort(state); }
      catch (error) { state.config.gateway = priorGateway; throw error; }
    }
    state.config.gateway = targetGateway;
    state.config.defaults = structuredClone(manifest.defaults);
    for (const declared of manifest.computers) {
      const current = state.config.computers.find(({ name }) => name === declared.name);
      if (current) {
        Object.assign(current, structuredClone(declared));
      } else {
        const { name, ...defaults } = declared;
        addConfiguredComputer(state, name, ComputerDefaultsSchema.parse(defaults));
      }
    }
    state.config = ConfigSchema.parse(state.config);
    await ensureSystemImages(state, true);
    const deletedAt = new Date().toISOString();
    for (const computer of deletes) {
      state.config.computers = state.config.computers.filter(({ id }) => id !== computer.id);
      delete state.secrets.computers[computer.id];
    }
    const createdIds = reconciliation.creates.map(({ name }) => findComputer(state, name).id);
    await executeStateTransaction(paths, createStateTransaction('apply', state, {
      activeSources: Object.fromEntries(createdIds.map((id) => [id, 'create'])),
      trash: deletes.map((computer) => ({ ...computer, deletedAt })),
      runtime: {
        ensureImages: false,
        startGateway: true,
        startIds: manifest.computers.map(({ name }) => findComputer(state, name).id),
        removeIds: deletes.map(({ id }) => id),
      },
    }));
    await synchronizeStartedSkillPolicies(state, manifest.computers.map(({ name }) => findComputer(state, name)));
  });
}

async function prepareStateBeforeCommand(command: string | undefined, args: ParsedArgs): Promise<void> {
  if (!command || ['help', 'version', 'image', 'doctor'].includes(command)) return;
  const paths = statePaths();
  const notificationPreferenceOnly = command === 'config'
    && args.positionals[0] === 'set'
    && args.options.has('update-notifications')
    && [...args.options.keys()].every((name) => name === 'update-notifications');
  const readOnlyLifecycle = command === 'status'
    || command === 'cleanup'
    || (command === 'upgrade' && flag(args, 'all'))
    || (command === 'gateway' && args.positionals[0] === 'status')
    || notificationPreferenceOnly;
  if (readOnlyLifecycle) {
    const format = await inspectStateFormat(paths);
    if (format.status !== 'current') {
      throw new Error(`${command} requires current Qubicl state and will not migrate or recover it implicitly: ${format.detail}`);
    }
    return;
  }
  if (command === 'setup' && (await inspectStateFormat(paths)).status === 'uninitialized') return;
  const requiresRuntime = new Set([
    'setup', 'up', 'down', 'create', 'upgrade', 'start', 'stop', 'restart', 'control', 'rename', 'delete', 'restore', 'purge', 'repair', 'apply',
    'browser', 'network', 'secret', 'ssh', 'backup', 'checkpoint', 'clone', 'devcontainer', 'cleanup', 'skills', 'tools', 'gateway',
  ]);
  const includeRuntime = requiresRuntime.has(command)
    || (command === 'config' && args.positionals[0] === 'set')
    || (command === 'token' && args.positionals[0] === 'rotate');
  // Upgrade deliberately replaces an obsolete runtime and therefore must be
  // able to run before the general legacy-runtime migration path.
  const migrateRuntime = command !== 'upgrade' && (includeRuntime || ['list', 'status', 'inspect', 'logs', 'view', 'mcp'].includes(command));
  await withStateLock(paths, async () => {
    const recoveredMigration = await recoverStateMigration(paths);
    const pendingBeforeRecovery = await readPendingTransaction(paths);
    if (pendingBeforeRecovery) {
      // Preserve legacy-runtime discovery before durable transaction recovery
      // renders the new namespaced Compose document. Runtime replay happens
      // only after the legacy resources have been migrated.
      const pendingState: LoadedState = {
        paths,
        config: structuredClone(pendingBeforeRecovery.config),
        secrets: structuredClone(pendingBeforeRecovery.secrets),
      };
      if (await legacyRuntimeMigrationNeeded(pendingState)) {
        await validateDocker();
        await prepareStateDirectories(paths);
        const captureState = await loadState(paths).catch(() => pendingState);
        await reconcileRuntimeImageContracts(captureState);
        await prepareRuntimeMigration(captureState);
      }
      await recoverPendingTransaction(paths, { includeRuntime: false });
    }
    const initialized = await ensureCurrentState(paths);
    const current = initialized || recoveredMigration || (await inspectStateFormat(paths)).status === 'current';
    if (!current) return;
    await prepareStateDirectories(paths);
    const state = await loadState(paths);
    const legacyRuntimePending = await legacyRuntimeMigrationNeeded(state);
    if (migrateRuntime && (initialized || recoveredMigration || legacyRuntimePending)) {
      await validateDocker();
      if (legacyRuntimePending) {
        await reconcileRuntimeImageContracts(state);
        await prepareRuntimeMigration(state);
      }
      await renderRuntime(state);
      await migrateLegacyRuntime(state);
    }
    if (includeRuntime && await readPendingTransaction(paths)) {
      await recoverPendingTransaction(paths, { includeRuntime: true });
    }
    if ((!legacyRuntimePending || migrateRuntime)
      && isPrimaryRuntimeRoot(state.paths.root)
      && state.config.computers.some((computer) => computer.runtimeName !== computer.name)
      && !(await readPendingTransaction(paths))) {
      for (const computer of state.config.computers) computer.runtimeName = computer.name;
      await executeStateTransaction(paths, createStateTransaction('config', state), { includeRuntime: false });
    }
  });
}

function findComputer(state: LoadedState, name: string): ComputerConfig {
  const computer = state.config.computers.find(({ name: current, id }) => current === name || id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return computer;
}

function endpoints(state: LoadedState, computer: ComputerConfig): { mcp: string; openapi: string; view: string; health: string } {
  const local = gatewayEndpointSet(state.config.gateway, computer, 'local')!;
  return { mcp: local.mcp, openapi: local.openapi, view: local.view!, health: local.health };
}

function applicableEndpoints(state: LoadedState, computer: ComputerConfig): { mcp: string; openapi: string; health: string; view?: string; remote?: ReturnType<typeof gatewayEndpointSet> } {
  const all = endpoints(state, computer);
  const remote = gatewayEndpointSet(state.config.gateway, computer, 'remote');
  return {
    mcp: all.mcp,
    openapi: all.openapi,
    health: all.health,
    ...(computer.capabilities.includes('viewer') ? { view: all.view } : {}),
    ...(remote ? { remote } : {}),
  };
}

function parseGatewayAccess(value: string | undefined): 'local' | 'remote' {
  if (value === undefined || value === 'local') return 'local';
  if (value === 'remote') return 'remote';
  throw new Error('--access must be local or remote.');
}

function printConnection(state: LoadedState, computer: ComputerConfig, running = true): void {
  console.log(JSON.stringify(buildComputerConnectionResult(state.config.gateway.port, computer, running, state.config.gateway.exposure), null, 2));
}

async function openBrowser(url: string): Promise<void> {
  const { command, args } = browserOpenInvocation(url, await inspectHostPlatform());
  await run(command, args, { allowFailure: false });
}

function required(value: string | undefined, description: string): string {
  if (!value) throw new Error(`Missing ${description}.`);
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface DoctorCheck {
  status: 'ok' | 'warning' | 'fail';
  check: string;
  detail: string;
  repair?: string;
}

function doctorRepair(check: DoctorCheck): string | undefined {
  if (check.status === 'ok') return undefined;
  if (check.check === 'docker-cli') return 'Install Docker Desktop or Docker Engine and ensure docker is on PATH.';
  if (check.check === 'docker-engine') return `Start Docker and upgrade it to ${MIN_DOCKER_ENGINE_VERSION} or newer if necessary.`;
  if (check.check === 'docker-compose') return `Install or upgrade Docker Compose to ${MIN_DOCKER_COMPOSE_VERSION} or newer.`;
  if (check.check === 'docker-host' || check.check === 'docker-context') return 'Use a running, supported local Docker Engine/Desktop context; remote tcp:// and ssh:// contexts are rejected.';
  if (check.check === 'wsl-version') return 'Upgrade this distribution to WSL 2. Qubicl does not support WSL 1.';
  if (check.check === 'wsl-interop') return 'Enable WSL interoperability to launch Windows-hosted clients, open the Windows browser, and use Windows credential helpers.';
  if (check.check === 'state-format') return 'Run a normal Qubicl command to complete state migration, or restore a verified backup.';
  if (check.check === 'state-transaction-journal') return 'Run qubicl up to finish the pending runtime recovery.';
  if (check.check === 'gateway-health') return 'Run qubicl up; if the port is occupied, choose another with qubicl config set --gateway-port PORT.';
  if (check.check.endsWith('-ownership-repair')) {
    const name = check.check.slice('computer-'.length, -'-ownership-repair'.length);
    return `Keep ${name} stopped and re-run qubicl repair ownership ${name}.`;
  }
  if (check.check.startsWith('image-')) return 'Run qubicl up while online, or build/provide the configured image locally.';
  if (check.check.includes('-runtime')) return 'Run qubicl up, then inspect qubicl logs if the resource does not become healthy.';
  if (check.check.startsWith('state-') || check.check.startsWith('computer-') || check.check.startsWith('trash-')) {
    return 'Preserve ~/.qubicl, inspect the reported path, and restore from a verified Qubicl backup if needed.';
  }
  return undefined;
}

function runtimeCheck(check: string, runtime: { status: string; health?: string }): DoctorCheck {
  const detail = runtime.health ? `${runtime.status}; health=${runtime.health}` : runtime.status;
  if (runtime.status === 'running' && runtime.health === 'healthy') return { status: 'ok', check, detail };
  if (runtime.status === 'dead' || (runtime.status === 'running' && runtime.health === 'unhealthy')) return { status: 'fail', check, detail };
  if (['absent', 'created', 'exited', 'paused', 'restarting', 'removing'].includes(runtime.status)
    || (runtime.status === 'running' && runtime.health === 'starting')) {
    return { status: 'warning', check, detail };
  }
  return { status: 'fail', check, detail };
}

async function gatewayExposureStateChecks(state: LoadedState): Promise<DoctorCheck[]> {
  const exposure = state.config.gateway.exposure;
  const paths = gatewayExposurePaths(state.paths);
  if (!exposure) {
    try {
      await lstat(paths.directory);
      return [{
        status: 'fail',
        check: 'gateway-exposure-state',
        detail: `${paths.directory} remains even though remote access is off`,
        repair: 'Run qubicl gateway revoke --yes to reconcile the local-only gateway state.',
      }];
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? [{ status: 'ok', check: 'gateway-exposure-state', detail: 'remote access is off and no managed TLS runtime snapshot remains' }]
        : [{ status: 'fail', check: 'gateway-exposure-state', detail: message(error) }];
    }
  }

  const problems: string[] = [];
  const warnings: DoctorCheck[] = [];
  const secret = state.secrets.gateway?.tls;
  if (!secret) {
    problems.push('protected TLS material is missing');
  } else {
    try {
      const certificate = validateConfiguredGatewayTls(exposure, secret);
      const remaining = Date.parse(certificate.notAfter) - Date.now();
      if (remaining < 30 * 24 * 60 * 60 * 1_000) {
        warnings.push({
          status: 'warning',
          check: 'gateway-certificate-expiry',
          detail: `certificate expires at ${certificate.notAfter}; renew it by re-running qubicl gateway expose`,
        });
      }
    } catch (error) {
      problems.push(message(error));
    }
  }
  if (!gatewayBindAddressPresent(exposure.bindAddress)) problems.push(`bind address ${exposure.bindAddress} is not assigned to a host interface`);

  try {
    const expectedFiles = new Set([
      paths.document,
      paths.certificate,
      paths.privateKey,
      ...(secret?.clientCertificateAuthorityPem ? [paths.clientCertificateAuthority] : []),
    ]);
    const directory = await lstat(paths.directory);
    const uid = typeof process.getuid === 'function' ? process.getuid() : directory.uid;
    if (!directory.isDirectory() || directory.isSymbolicLink()) problems.push(`${paths.directory} is not a real directory`);
    if (directory.uid !== uid) problems.push(`${paths.directory} is not owned by the current user`);
    if ((directory.mode & 0o777) !== 0o700) problems.push(`${paths.directory} mode is not 0700`);
    const entries = await readdir(paths.directory);
    const actualFiles = new Set(entries.map((name) => join(paths.directory, name)));
    for (const expected of expectedFiles) if (!actualFiles.has(expected)) problems.push(`${expected} is missing`);
    for (const actual of actualFiles) if (!expectedFiles.has(actual)) problems.push(`${actual} is unexpected`);
    for (const path of expectedFiles) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) problems.push(`${path} is not a regular file`);
        if (info.uid !== uid) problems.push(`${path} is not owned by the current user`);
        if ((info.mode & 0o777) !== 0o600) problems.push(`${path} mode is not 0600`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`${path}: ${message(error)}`);
      }
    }
    try {
      const runtime = GatewayExposureRuntimeSchema.parse(JSON.parse(await readFile(paths.document, 'utf8')));
      if (JSON.stringify(runtime) !== JSON.stringify(gatewayExposureRuntime(exposure))) {
        problems.push('managed gateway exposure runtime document does not match durable configuration');
      }
    } catch (error) {
      problems.push(`managed gateway exposure runtime document is invalid: ${message(error)}`);
    }
    try { await validateGatewayExposureRuntimeSnapshot(state); }
    catch (error) { problems.push(message(error)); }
  } catch (error) {
    problems.push(message(error));
  }

  return [securityCheck('gateway-exposure-state', problems), ...warnings];
}

async function gatewaySecurityChecks(state: LoadedState): Promise<DoctorCheck[]> {
  try {
    const inspected = JSON.parse(await docker(['inspect', gatewayContainerName(state.config.installationId, state.paths.root)])) as Array<Record<string, unknown>>;
    const container = inspected[0] as DockerInspection | undefined;
    if (!container) throw new Error('Docker returned no gateway inspection record.');
    const problems: string[] = [];
    const portBindings = container.HostConfig?.PortBindings ?? {};
    const observedPorts = container.NetworkSettings?.Ports ?? {};
    if (container.HostConfig?.PublishAllPorts === true) problems.push('gateway must not enable Docker PublishAllPorts');
    const localBindings = portBindings['3211/tcp'] ?? [];
    const localBinding = localBindings[0];
    if (localBindings.length !== 1 || localBinding?.HostIp !== '127.0.0.1'
      || Number(localBinding.HostPort) !== state.config.gateway.port) {
      problems.push('gateway does not have exactly one publication on the configured localhost port');
    }
    const observedLocalBindings = observedPorts['3211/tcp'] ?? [];
    const observedLocalBinding = observedLocalBindings[0];
    if (observedLocalBindings.length !== 1 || observedLocalBinding?.HostIp !== '127.0.0.1'
      || Number(observedLocalBinding.HostPort) !== state.config.gateway.port) {
      problems.push('running gateway does not report the exact configured localhost publication');
    }
    const exposure = state.config.gateway.exposure;
    const externalPublication = gatewayExternalPublicationFromInspection(container);
    if (externalPublication?.verificationIssue) {
      problems.push(`gateway external TLS publication is not verified: ${externalPublication.verificationIssue}`);
    }
    if (exposure) {
      if (externalPublication?.hostIp !== exposure.bindAddress || externalPublication.hostPort !== exposure.port
        || externalPublication.verificationIssue) {
        problems.push('gateway external TLS publication does not exactly match the configured address and port');
      }
    } else if (externalPublication) {
      problems.push('gateway external TLS port is published while remote access is off');
    }
    const unexpectedBindings = Object.entries(portBindings)
      .filter(([target, bindings]) => !['3211/tcp', `${GATEWAY_EXTERNAL_CONTAINER_PORT}/tcp`].includes(target) && (bindings?.length ?? 0) > 0)
      .map(([target]) => target);
    if (unexpectedBindings.length) problems.push(`unexpected gateway port publications: ${unexpectedBindings.join(', ')}`);
    const unexpectedObservedBindings = Object.entries(observedPorts)
      .filter(([target, bindings]) => !['3211/tcp', `${GATEWAY_EXTERNAL_CONTAINER_PORT}/tcp`].includes(target) && (bindings?.length ?? 0) > 0)
      .map(([target]) => target);
    if (unexpectedObservedBindings.length) problems.push(`unexpected running gateway port publications: ${unexpectedObservedBindings.join(', ')}`);
    if (container.HostConfig?.Privileged) problems.push('privileged mode is enabled');
    if (container.HostConfig?.ReadonlyRootfs !== true) problems.push('root filesystem is writable');
    if (!(container.HostConfig?.CapDrop ?? []).some((capability) => capability.toUpperCase() === 'ALL')) problems.push('Linux capabilities are not dropped');
    if ((container.HostConfig?.CapAdd ?? []).length) problems.push('extra Linux capabilities are enabled');
    if (!(container.HostConfig?.SecurityOpt ?? []).includes('no-new-privileges:true')) problems.push('no-new-privileges is not enabled');
    const mounts = container.Mounts ?? [];
    const runtimeMounts = mounts.filter((mount) => mount.Destination === '/runtime' && mount.RW === false);
    const auditMounts = mounts.filter((mount) => mount.Destination === '/audit' && mount.RW === true);
    if (runtimeMounts.length !== 1 || auditMounts.length !== 1 || mounts.length !== 2) {
      problems.push('gateway mounts must be the read-only runtime directory plus the writable audit directory');
    }
    const expectedUser = `${typeof process.getuid === 'function' ? process.getuid() : 1000}:${typeof process.getgid === 'function' ? process.getgid() : 1000}`;
    if (container.Config?.User !== expectedUser) problems.push(`gateway user does not match host user ${expectedUser}`);
    if (container.HostConfig?.PidsLimit !== GATEWAY_PIDS_LIMIT) problems.push(`PID limit does not match ${GATEWAY_PIDS_LIMIT}`);
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {}).toSorted();
    const expectedNetworks = [
      gatewayNetworkName(state.config.installationId, state.paths.root),
      ...state.config.computers.map((computer) => controlNetwork(state.config.installationId, computer.id, state.paths.root)),
    ].toSorted();
    if (JSON.stringify(networks) !== JSON.stringify(expectedNetworks)) problems.push(`gateway networks do not exactly match ${expectedNetworks.join(', ')}`);
    const environment = container.Config?.Env ?? [];
    const exposureEnvironment = environment.filter((entry) => entry.startsWith('QUBICL_GATEWAY_EXPOSURE_')
      || entry.startsWith('QUBICL_GATEWAY_TLS_') || entry.startsWith('QUBICL_GATEWAY_EXTERNAL_PORT='));
    if (exposure) {
      const required = [
        'QUBICL_GATEWAY_EXPOSURE_CONFIG_PATH=/runtime/gateway-exposure/gateway-exposure.json',
        'QUBICL_GATEWAY_TLS_CERT_PATH=/runtime/gateway-exposure/certificate.pem',
        'QUBICL_GATEWAY_TLS_KEY_PATH=/runtime/gateway-exposure/private-key.pem',
        `QUBICL_GATEWAY_EXTERNAL_PORT=${GATEWAY_EXTERNAL_CONTAINER_PORT}`,
        ...(state.secrets.gateway?.tls.clientCertificateAuthorityPem
          ? ['QUBICL_GATEWAY_TLS_CLIENT_CA_PATH=/runtime/gateway-exposure/client-ca.pem']
          : []),
      ];
      for (const value of required) if (!environment.includes(value)) problems.push(`gateway exposure environment is missing ${value.split('=')[0]}`);
      if (exposureEnvironment.length !== required.length) problems.push('gateway exposure environment contains missing, duplicate, or unexpected entries');
    } else if (exposureEnvironment.length) {
      problems.push('gateway exposure environment remains configured while remote access is off');
    }
    if (JSON.stringify(container).includes('docker.sock')) problems.push('Docker socket is mounted');
    return [securityCheck('gateway-isolation', problems)];
  } catch (error) {
    return [{ status: 'fail', check: 'gateway-isolation', detail: message(error), repair: 'Recreate the gateway with qubicl up and inspect its Docker configuration.' }];
  }
}

async function computerSecurityChecks(state: LoadedState, computer: ComputerConfig): Promise<DoctorCheck[]> {
  if (usesUnifiedComputerRuntime(computer)) return unifiedComputerSecurityChecks(state, computer);
  return splitComputerSecurityChecks(state, computer);
}

async function unifiedComputerSecurityChecks(state: LoadedState, computer: ComputerConfig): Promise<DoctorCheck[]> {
  try {
    const inspected = JSON.parse(await docker(['inspect', computerContainerName(state, computer)])) as Array<Record<string, unknown>>;
    const container = inspected[0] as DockerInspection | undefined;
    if (!container) throw new Error('Docker returned no unified computer inspection record.');
    const problems: string[] = [];
    inspectCommonIsolation('computer', container, problems);
    inspectMounts('computer', container, false, problems, true, true, dynamicPreviewAccessExpected('computer', container, problems));
    inspectNetworks('computer', container, [controlNetwork(state.config.installationId, computer.id, state.paths.root)], problems);
    if (container.HostConfig?.NanoCpus !== computer.cpus * 1_000_000_000) problems.push(`computer CPU limit does not match ${computer.cpus}`);
    if (container.HostConfig?.Memory !== memoryBytes(computer.memory)) problems.push(`computer memory limit does not match ${computer.memory}`);
    const expectedPids = PRESET_DEFINITIONS[computer.compatibility].pidsLimit;
    if (container.HostConfig?.PidsLimit !== expectedPids) problems.push(`computer PID limit does not match ${expectedPids}`);
    const environment = container.Config?.Env ?? [];
    if (!environment.includes('QUBICL_RUNTIME_ROLE=computer')) problems.push('unified computer role is not configured');
    if (computer.ssh?.enabled) {
      const binding = container.HostConfig?.PortBindings?.['2222/tcp']?.[0];
      if (binding?.HostIp !== '127.0.0.1' || Number(binding.HostPort) !== computer.ssh.port) problems.push('SSH is not published only on its configured loopback port');
    }
    const securityOptions = container.HostConfig?.SecurityOpt ?? [];
    if (!securityOptions.includes('no-new-privileges:true')) problems.push('computer no-new-privileges is not enabled');
    const policy = PRESET_DEFINITIONS[computer.compatibility];
    if (policy.shmSize && container.HostConfig?.ShmSize !== memoryBytes(policy.shmSize)) problems.push(`computer shared-memory limit does not match ${policy.shmSize}`);
    if (computer.capabilities.includes('viewer')) {
      const seccompPath = join(state.paths.runtime, 'chromium-seccomp.json');
      const observedSeccomp = securityOptions.find((option) => option.startsWith('seccomp='))?.slice('seccomp='.length);
      if (observedSeccomp !== seccompPath && !equivalentJson(observedSeccomp, await readFile(seccompPath, 'utf8'))) problems.push('computer does not use the managed Chromium seccomp profile');
    }
    return [securityCheck(`computer-${computer.name}-isolation`, problems)];
  } catch (error) {
    return [{ status: 'fail', check: `computer-${computer.name}-isolation`, detail: message(error), repair: `Recreate ${computer.name} with qubicl upgrade ${computer.name}.` }];
  }
}

async function splitComputerSecurityChecks(state: LoadedState, computer: ComputerConfig): Promise<DoctorCheck[]> {
  try {
    const hasWebRuntime = computer.controlProtocolVersion === LEGACY_SPLIT_CONTROL_PROTOCOL_VERSION;
    const names = [
      computerContainerName(state, computer),
      computerExecutorContainerName(state, computer),
      computerEgressContainerName(state, computer),
      ...(hasWebRuntime ? [computerWebContainerName(state, computer)] : []),
      ...(computer.capabilities.includes('viewer') ? [computerSessionContainerName(state, computer)] : []),
      ...(computer.ssh?.enabled ? [computerSshContainerName(state, computer)] : []),
    ];
    const inspected = JSON.parse(await docker(['inspect', ...names])) as Array<Record<string, unknown>>;
    const controller = inspected[0] as DockerInspection | undefined;
    const executor = inspected[1] as DockerInspection | undefined;
    const egress = inspected[2] as DockerInspection | undefined;
    const web = hasWebRuntime ? inspected[3] as DockerInspection | undefined : undefined;
    const sessionIndex = hasWebRuntime ? 4 : 3;
    const session = computer.capabilities.includes('viewer') ? inspected[sessionIndex] as DockerInspection | undefined : undefined;
    const ssh = computer.ssh?.enabled ? inspected[sessionIndex + (computer.capabilities.includes('viewer') ? 1 : 0)] as DockerInspection | undefined : undefined;
    if (!controller || !executor || !egress || (hasWebRuntime && !web) || (computer.capabilities.includes('viewer') && !session)) throw new Error('Docker returned an incomplete isolated computer runtime.');
    const problems: string[] = [];
    const control = controlNetwork(state.config.installationId, computer.id, state.paths.root);
    const workspace = workspaceNetwork(state.config.installationId, computer.id, state.paths.root);
    inspectCommonIsolation('controller', controller, problems);
    inspectCommonIsolation('executor', executor, problems);
    inspectCommonIsolation('egress', egress, problems);
    if (web) inspectCommonIsolation('web', web, problems);
    if (session) inspectCommonIsolation('session', session, problems);
    if (ssh) inspectSshIsolation(ssh, computer.ssh!.port, workspace, problems);
    inspectMounts('controller', controller, false, problems, true, true, dynamicPreviewAccessExpected('controller', controller, problems));
    inspectMounts('executor', executor, false, problems);
    const egressMounts = new Map((egress.Mounts ?? []).map((mount) => [mount.Destination, mount]));
    if (egressMounts.size !== 2
      || egressMounts.get('/run/qubicl/broker.json')?.RW !== false
      || egressMounts.get('/run/qubicl/audit.jsonl')?.RW !== true) {
      problems.push('egress mounts must be limited to the read-only broker document and writable private audit log');
    }
    if (session) inspectMounts('session', session, true, problems);
    if (web && (web.Mounts ?? []).length !== 0) problems.push('web service must not receive host or durable-home mounts');
    inspectNetworks('controller', controller, [control, workspace], problems);
    inspectNetworks('executor', executor, [workspace], problems);
    inspectNetworks('egress', egress, [gatewayNetworkName(state.config.installationId, state.paths.root), control, workspace], problems);
    if (web) inspectNetworks('web', web, [control, workspace], problems);
    if (session) inspectNetworks('session', session, [control, workspace], problems);
    if (controller.HostConfig?.NanoCpus !== 250_000_000 || controller.HostConfig?.Memory !== memoryBytes('256m') || controller.HostConfig?.PidsLimit !== 128) {
      problems.push('controller resource limits do not match 0.25 CPU / 256m / 128 PIDs');
    }
    if (executor.HostConfig?.NanoCpus !== computer.cpus * 1_000_000_000) problems.push(`executor CPU limit does not match ${computer.cpus}`);
    const expectedMemory = memoryBytes(computer.memory);
    if (executor.HostConfig?.Memory !== expectedMemory) problems.push(`executor memory limit does not match ${computer.memory}`);
    const expectedPids = PRESET_DEFINITIONS[computer.compatibility].pidsLimit;
    if (executor.HostConfig?.PidsLimit !== expectedPids) problems.push(`executor PID limit does not match ${expectedPids}`);
    if (egress.HostConfig?.NanoCpus !== 250_000_000 || egress.HostConfig?.Memory !== memoryBytes('128m') || egress.HostConfig?.PidsLimit !== 64) problems.push('egress resource limits do not match 0.25 CPU / 128m / 64 PIDs');
    if (web && (web.HostConfig?.NanoCpus !== 250_000_000 || web.HostConfig?.Memory !== memoryBytes('256m') || web.HostConfig?.PidsLimit !== 64)) problems.push('web resource limits do not match 0.25 CPU / 256m / 64 PIDs');
    const policy = PRESET_DEFINITIONS[computer.compatibility];
    if ((controller.Config?.Env ?? []).some((entry) => entry.startsWith('DISPLAY='))) problems.push('controller receives direct display access instead of using the isolated session runner');
    if ((executor.Config?.Env ?? []).some((entry) => entry.startsWith('DISPLAY=') || entry.startsWith('QUBICL_INTERNAL_KEY='))) problems.push('executor receives a display or gateway credential');
    if ((egress.Config?.Env ?? []).some((entry) => entry.startsWith('QUBICL_INTERNAL_KEY=') || entry.startsWith('QUBICL_EXECUTOR_KEY=') || entry.startsWith('QUBICL_SESSION_KEY='))) problems.push('egress receives an unexpected control credential');
    if (web && (web.Config?.Env ?? []).some((entry) => entry.startsWith('QUBICL_INTERNAL_KEY=') || entry.startsWith('QUBICL_EXECUTOR_KEY=') || entry.startsWith('QUBICL_SESSION_KEY=') || entry.startsWith('QUBICL_BROKER_KEY='))) problems.push('web service receives an unexpected control or broker credential');
    if (session) {
      if (session.HostConfig?.NanoCpus !== 1_000_000_000 || session.HostConfig?.Memory !== memoryBytes('2g') || session.HostConfig?.PidsLimit !== expectedPids) {
        problems.push(`session resource limits do not match 1 CPU / 2g / ${expectedPids} PIDs`);
      }
      if (policy.shmSize && session.HostConfig?.ShmSize !== memoryBytes(policy.shmSize)) problems.push(`session shared-memory limit does not match ${policy.shmSize}`);
      const securityOptions = session.HostConfig?.SecurityOpt ?? [];
      const seccompPath = join(state.paths.runtime, 'chromium-seccomp.json');
      const observedSeccomp = securityOptions.find((option) => option.startsWith('seccomp='))?.slice('seccomp='.length);
      if (!securityOptions.includes('no-new-privileges:true')) problems.push('session no-new-privileges is not enabled');
      if (observedSeccomp !== seccompPath && !equivalentJson(observedSeccomp, await readFile(seccompPath, 'utf8'))) {
        problems.push('session does not use the managed Chromium seccomp profile');
      }
      if ((session.Config?.Env ?? []).some((entry) => entry.startsWith('QUBICL_INTERNAL_KEY=') || entry.startsWith('QUBICL_EXECUTOR_KEY='))) problems.push('session receives a gateway or executor credential');
    }
    return [securityCheck(`computer-${computer.name}-isolation`, problems)];
  } catch (error) {
    return [{ status: 'fail', check: `computer-${computer.name}-isolation`, detail: message(error), repair: `Recreate ${computer.name} with qubicl stop ${computer.name}, docker rm ${computerContainerName(state, computer)}, and qubicl start ${computer.name}.` }];
  }
}

function equivalentJson(observed: string | undefined, expected: string): boolean {
  if (!observed) return false;
  try {
    return JSON.stringify(JSON.parse(observed)) === JSON.stringify(JSON.parse(expected));
  } catch {
    return false;
  }
}

function inspectCommonIsolation(label: string, container: DockerInspection, problems: string[]): void {
  const host = container.HostConfig;
  if (host?.Privileged) problems.push(`${label} privileged mode is enabled`);
  if ((host?.NetworkMode ?? '').includes('host')) problems.push(`${label} host networking is enabled`);
  if (host?.PidMode) problems.push(`${label} host PID mode is enabled`);
  if ((host?.CapAdd ?? []).length) problems.push(`${label} extra Linux capabilities are enabled`);
  if ((host?.Devices ?? []).length) problems.push(`${label} host devices are mounted`);
  if ((host?.SecurityOpt ?? []).some((option) => option.includes('unconfined'))) problems.push(`${label} has an unconfined security profile`);
  if (JSON.stringify(container).includes('docker.sock')) problems.push(`${label} mounts the Docker socket`);
}

function dynamicPreviewAccessExpected(label: string, container: DockerInspection, problems: string[]): boolean {
  const environment = container.Config?.Env ?? [];
  const imageCapability = environment.includes(`QUBICL_IMAGE_PREVIEW_ACCESS=${COMPUTER_PREVIEW_ACCESS_PROTOCOL}`);
  const runtimePath = environment.includes(`QUBICL_PREVIEW_ACCESS_PATH=${PREVIEW_ACCESS_CONTAINER_PATH}`);
  if (imageCapability !== runtimePath) {
    problems.push(`${label} dynamic preview-access image capability and runtime path do not match`);
  }
  return runtimePath;
}

export function inspectMounts(
  label: string,
  container: DockerInspection,
  display: boolean,
  problems: string[],
  audit = false,
  policy = false,
  previewAccess = false,
): void {
  const mounts = container.Mounts ?? [];
  const home = mounts.filter((mount) => mount.Type === 'bind' && mount.Destination === '/home' && mount.RW === true);
  const x11 = mounts.filter((mount) => mount.Type === 'volume' && mount.Destination === '/tmp/.X11-unix' && mount.RW === true);
  const audits = mounts.filter((mount) => mount.Type === 'bind' && mount.Destination === '/run/qubicl/audit.jsonl' && mount.RW === true);
  const policies = mounts.filter((mount) => mount.Type === 'bind' && mount.Destination === '/run/qubicl/policy.json' && mount.RW === false);
  const previewAccessMounts = mounts.filter((mount) => mount.Type === 'bind' && mount.Destination === '/run/qubicl/preview-access' && mount.RW === false);
  if (home.length !== 1 || x11.length !== (display ? 1 : 0) || audits.length !== (audit ? 1 : 0)
    || policies.length !== (policy ? 1 : 0) || previewAccessMounts.length !== (previewAccess ? 1 : 0)
    || mounts.length !== 1 + (display ? 1 : 0) + (audit ? 1 : 0) + (policy ? 1 : 0) + (previewAccess ? 1 : 0)) {
    problems.push(`${label} mounts do not match the private home${display ? ', display socket' : ''}${audit ? ', private audit file' : ''}${policy ? ', read-only operator policy' : ''}${previewAccess ? ', and read-only preview access document' : ''}`);
  }
}

function inspectSshIsolation(container: DockerInspection, port: number, workspace: string, problems: string[]): void {
  const binding = container.HostConfig?.PortBindings?.['2222/tcp']?.[0];
  if (binding?.HostIp !== '127.0.0.1' || Number(binding.HostPort) !== port) problems.push('SSH is not published only on its configured loopback port');
  inspectNetworks('ssh', container, [workspace], problems);
  const mounts = container.Mounts ?? [];
  if (mounts.length !== 1 || mounts[0]?.Destination !== '/home' || mounts[0]?.RW !== true) problems.push('SSH must mount only the private home');
  if ((container.Config?.Env ?? []).some((entry) => entry.startsWith('QUBICL_INTERNAL_KEY=') || entry.startsWith('QUBICL_BROKER_KEY='))) problems.push('SSH receives a control-plane credential');
}

async function runtimeInventory(state: LoadedState): Promise<{ containers: string[]; networks: string[]; volumes: string[] }> {
  const installation = state.config.installationId;
  const expectedContainers = new Set([
    gatewayContainerName(installation, state.paths.root),
    ...state.config.computers.flatMap((computer) => computerRuntimeContainerNames(state, computer)),
  ]);
  const actualContainers = (await docker(['ps', '--all', '--filter', `label=dev.qubicl.installation=${installation}`, '--format', '{{.Names}}'], { allowFailure: true })).split('\n').filter(Boolean);
  const expectedNetworks = new Set([
    gatewayNetworkName(installation, state.paths.root),
    ...state.config.computers.flatMap((computer) => usesUnifiedComputerRuntime(computer)
      ? [controlNetwork(installation, computer.id, state.paths.root)]
      : [controlNetwork(installation, computer.id, state.paths.root), workspaceNetwork(installation, computer.id, state.paths.root)]),
  ]);
  const project = projectName(installation, state.paths.root);
  const actualNetworks = (await docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'], { allowFailure: true })).split('\n').filter(Boolean);
  const expectedVolumes = new Set(state.config.computers.filter((computer) => computer.capabilities.includes('viewer') && !usesUnifiedComputerRuntime(computer)).map((computer) => displaySocketVolume(installation, computer.id, state.paths.root)));
  const actualVolumes = (await docker(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'], { allowFailure: true })).split('\n').filter(Boolean);
  return {
    containers: actualContainers.filter((name) => !expectedContainers.has(name)).sort(),
    networks: actualNetworks.filter((name) => !expectedNetworks.has(name)).sort(),
    volumes: actualVolumes.filter((name) => !expectedVolumes.has(name)).sort(),
  };
}

async function runtimeInventoryCheck(state: LoadedState): Promise<DoctorCheck> {
  const orphaned = await runtimeInventory(state);
  const count = orphaned.containers.length + orphaned.networks.length + orphaned.volumes.length;
  return count
    ? { status: 'warning', check: 'runtime-orphans', detail: JSON.stringify(orphaned), repair: 'Review the exact names, then run qubicl cleanup --orphans --yes.' }
    : { status: 'ok', check: 'runtime-orphans', detail: 'no labeled orphan containers, networks, or volumes' };
}

function inspectNetworks(label: string, container: DockerInspection, expected: string[], problems: string[]): void {
  const actual = Object.keys(container.NetworkSettings?.Networks ?? {}).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected.toSorted())) problems.push(`${label} networks do not exactly match ${expected.join(', ')}`);
}

export interface DockerInspection {
  Config?: { User?: string; Env?: string[] };
  HostConfig?: {
    Privileged?: boolean;
    NetworkMode?: string;
    PidMode?: string;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    Devices?: unknown[] | null;
    SecurityOpt?: string[] | null;
    ReadonlyRootfs?: boolean;
    NanoCpus?: number;
    Memory?: number;
    PidsLimit?: number;
    ShmSize?: number;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | undefined>;
    PublishAllPorts?: boolean;
  };
  Mounts?: Array<{ Type?: string; Destination?: string; RW?: boolean }>;
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
}

function securityCheck(check: string, problems: string[]): DoctorCheck {
  return problems.length
    ? { status: 'fail', check, detail: problems.join('; '), repair: 'Recreate the affected runtime with Qubicl and re-run doctor.' }
    : { status: 'ok', check, detail: 'runtime isolation and resource limits match managed configuration' };
}

interface InvocationRule {
  minPositionals: number;
  maxPositionals: number;
  options?: readonly string[];
}

const invocationRules: Record<string, InvocationRule> = {
  help: { minPositionals: 0, maxPositionals: 0 },
  version: { minPositionals: 0, maxPositionals: 0 },
  setup: { minPositionals: 0, maxPositionals: 0, options: ['preset', 'image', 'cpus', 'memory', 'gateway-port', 'create', 'no-create', 'no-start', 'offline', 'allow-unsupported-resources', 'verbose', 'no-clear', 'yes', 'json'] },
  config: { minPositionals: 1, maxPositionals: 1, options: ['gateway-port', 'default-preset', 'default-image', 'default-cpus', 'default-memory', 'update-notifications'] },
  gateway: { minPositionals: 1, maxPositionals: 1, options: ['bind', 'port', 'hostname', 'cert', 'key', 'allow-networks', 'trusted-origins', 'preview-domain', 'client-ca', 'all-interfaces', 'allow-all-clients', 'yes', 'json'] },
  up: { minPositionals: 0, maxPositionals: 0 },
  down: { minPositionals: 0, maxPositionals: 0 },
  create: { minPositionals: 0, maxPositionals: 1, options: ['preset', 'image', 'cpus', 'memory', 'skills', 'tools', 'no-start', 'offline', 'yes', 'json'] },
  upgrade: { minPositionals: 0, maxPositionals: 1, options: ['preset', 'image', 'offline', 'all', 'yes'] },
  list: { minPositionals: 0, maxPositionals: 0, options: ['json'] },
  status: { minPositionals: 0, maxPositionals: 1 },
  inspect: { minPositionals: 1, maxPositionals: 1 },
  logs: { minPositionals: 0, maxPositionals: 1 },
  doctor: { minPositionals: 0, maxPositionals: 0, options: ['json'] },
  repair: { minPositionals: 2, maxPositionals: 2, options: ['yes'] },
  start: { minPositionals: 1, maxPositionals: 1 },
  stop: { minPositionals: 1, maxPositionals: 1 },
  restart: { minPositionals: 1, maxPositionals: 1 },
  control: { minPositionals: 2, maxPositionals: 2 },
  browser: { minPositionals: 3, maxPositionals: 3, options: ['yes'] },
  network: { minPositionals: 2, maxPositionals: 3, options: ['allow-domains', 'deny-domains', 'duration'] },
  secret: { minPositionals: 2, maxPositionals: 3, options: ['base-url', 'path-prefix', 'methods', 'header', 'provider', 'provider-ref', 'duration'] },
  ssh: { minPositionals: 2, maxPositionals: 2, options: ['port'] },
  backup: { minPositionals: 1, maxPositionals: 3, options: ['encrypt', 'passphrase-file', 'quiesce', 'stopped', 'keep', 'yes'] },
  checkpoint: { minPositionals: 1, maxPositionals: 1, options: ['encrypt', 'passphrase-file'] },
  clone: { minPositionals: 2, maxPositionals: 2, options: ['no-start'] },
  devcontainer: { minPositionals: 1, maxPositionals: 3, options: ['tag', 'no-start', 'offline'] },
  git: { minPositionals: 2, maxPositionals: 3, options: ['directory', 'repo', 'branch', 'remote', 'output', 'read-only', 'yes'] },
  audit: { minPositionals: 2, maxPositionals: 2, options: ['output', 'keep', 'yes'] },
  skills: { minPositionals: 1, maxPositionals: 4, options: ['enable', 'disable', 'profile', 'ref', 'path', 'all', 'yes', 'json'] },
  tools: { minPositionals: 1, maxPositionals: 1, options: ['enable', 'disable', 'profile', 'yes', 'json'] },
  cleanup: { minPositionals: 0, maxPositionals: 0, options: ['orphans', 'images', 'yes'] },
  rename: { minPositionals: 2, maxPositionals: 2 },
  delete: { minPositionals: 1, maxPositionals: 1 },
  restore: { minPositionals: 1, maxPositionals: 1 },
  purge: { minPositionals: 1, maxPositionals: 1, options: ['yes'] },
  view: { minPositionals: 1, maxPositionals: 1, options: ['no-open', 'access'] },
  connect: { minPositionals: 1, maxPositionals: 1, options: ['client', 'client-host', 'transport', 'profile', 'result-mode', 'access'] },
  mcp: { minPositionals: 1, maxPositionals: 1, options: ['profile', 'result-mode'] },
  token: { minPositionals: 2, maxPositionals: 2 },
  image: { minPositionals: 1, maxPositionals: 3 },
  export: { minPositionals: 0, maxPositionals: 0, options: ['output'] },
  apply: { minPositionals: 1, maxPositionals: 1, options: ['dry-run', 'prune'] },
};

function validateInvocation(command: string | undefined, args: ParsedArgs): void {
  const name = command ?? 'help';
  const rule = invocationRules[name];
  if (!rule) throw new Error(`Unknown command ${name}. Run qubicl help.`);
  const allowed = new Set([...(rule.options ?? []), 'help']);
  for (const option of args.options.keys()) {
    if (!allowed.has(option)) throw new Error(`Command ${name} does not accept --${option}.`);
  }
  if (flag(args, 'help')) return;
  if (args.positionals.length < rule.minPositionals) throw new Error(`Command ${name} is missing required arguments. Run qubicl help.`);
  if (args.positionals.length > rule.maxPositionals) throw new Error(`Command ${name} received too many arguments. Run qubicl help.`);
  if (name === 'upgrade') validateUpgradeInvocation(args);
}

const helpText = `Qubicl — private Docker computers for any compatible LLM

Usage: qubicl <command> [arguments]

  version                                Print build version and revision
  setup [--preset id | --image ref]      Configure an intentional default and optionally create a computer
        [--cpus n] [--memory 4g] [--gateway-port n]
        [--create name | --no-create] [--no-start] [--offline]
        [--allow-unsupported-resources] [--verbose] [--no-clear] [--yes] [--json]
  config show                            Print gateway and computer defaults as JSON
  config set [--gateway-port n] [--default-preset id | --default-image ref]
             [--default-cpus n] [--default-memory 4g] [--update-notifications on|off]
                                         Update managed settings and private local preferences
  gateway expose --bind ADDRESS --port PORT --hostname HOST
                 --cert FILE --key FILE --allow-networks CIDR[,CIDR...]
                 [--trusted-origins HTTPS_ORIGIN,...] [--preview-domain DOMAIN]
                 [--client-ca FILE] [--all-interfaces] [--allow-all-clients] [--yes]
  gateway status [--json] | gateway revoke [--yes]
                                         Manage the optional TLS-only remote listener
  up | down                              Start or stop all resources
  create [name] [--preset id | --image ref] [--cpus n] [--memory 4g]
                [--skills core|none|ids] [--tools full|names]
                [--no-start] [--offline] [--yes] [--json]
                                         Create a computer from exact stored/current catalog identity
  upgrade <name> [--preset id | --image ref] [--offline]
                                         Recreate one computer on the latest compatible image; preserve ID, token, settings, home, and runtime state
  upgrade --all [--offline] [--yes]      Preview exact gateway/default/curated targets, then confirm a deterministic roll-forward upgrade
  list [--json] | status [name] | inspect <name>
                                         Inspect runtime state
  logs [name] | doctor [--json]          Diagnose Qubicl with repair guidance
  repair ownership <name> [--yes]        Explicitly repair an imported or moved durable home
  start|stop|restart <name>              Manage one computer
  control release <name>                 Release an abandoned human-control session
  browser profile wipe <name> [--yes]    Permanently clear only the durable Chromium profile
  network show <name>                    Show its enforced egress profile
  network set <name> developer|web-only|offline|custom
              [--allow-domains a,b] [--deny-domains x,y]
  network approve|revoke <name> <domain> [--duration seconds]
                                         Recreate runtime boundaries with explicit egress policy
  secret list <name> | secret remove <name> <id>
  secret add <name> <id> --base-url https://... [--path-prefix /api]
         [--methods GET,POST] [--header Authorization]
         [--provider direct|environment|file|secret-tool|macos-keychain] [--provider-ref value]
                                         Configure host-resolved scoped credential brokering
  ssh enable <name> [--port n]           Create a loopback-only operator SSH endpoint and key
  ssh status|config|rotate|disable <name>
                                         Manage independent SSH/editor access
  backup create <name> [--quiesce|--stopped] [--encrypt --passphrase-file file]
  backup list [name] | verify <id> [--passphrase-file file]
  backup restore <id> <new-name> [--passphrase-file file]
  backup prune [name] --keep n --yes       Manage checksummed home-only backups
  checkpoint <name>                       Create a quiesced named home checkpoint
  clone <source> <new-name> [--no-start]   Clone a computer from a verified checkpoint
  devcontainer inspect <directory>
  devcontainer import <directory> <name> [--tag image] [--no-start] [--offline]
                                         Import a bounded Qubicl-compatible devcontainer
  git clone <computer> <url> [--directory dir] [--branch branch]
  git import <computer> <local-repo> [--directory dir] [--read-only]
  git status|diff <computer> [--repo dir]
  git patch <computer> --output file [--repo dir]
  git worktree <computer> <branch> [--repo dir] [--directory dir]
  git push <computer> [--repo dir] [--remote origin] [--branch name] --yes
                                         Host-mediated Git workflows; credentials remain outside
  audit show <computer> [--keep n] | audit export <computer> --output file
  audit prune <computer> [--keep n] --yes
                                         Inspect or retain the bounded private JSONL audit trail
  skills <computer> [--profile core|none] [--enable ids] [--disable ids] [--yes] [--json]
                                         Select operator-approved core/imported skills; working copies remain agent-editable
  skills <computer> import <directory|https-url> [--ref full-sha] [--path repo/path] [--enable] --yes
  skills <computer> inspect <name> [--json]
  skills <computer> enable|disable|reset|remove|restore <name> --yes [--json]
  skills <computer> reset --all --yes
  skills <computer> update <name> <directory|https-url> [--ref full-sha] [--path repo/path] --yes
                                         Import, inspect, recover, and reset bounded Agent Skills packages
  tools <computer> [--profile full] [--enable names|categories] [--disable names|categories] [--yes] [--json]
                                         Select the effective per-computer tool policy; control and lease tools stay locked
  cleanup --orphans [--images] [--yes]    Preview verified orphans and obsolete private cache records; images/volumes remain manual
  rename <old> <new>                     Rename without changing identity
  delete <name>                          Move a computer to recoverable trash
  restore <name-or-id>                   Restore with a new token
  purge <name-or-id> [--yes]             Permanently delete trashed data
  view <name> [--no-open] [--access local|remote]
                                         Open the interactive desktop
  connect <name> --client <client> [--client-host local|windows]
                 [--transport stdio|http|openapi]
                 [--access local|remote]
                 [--profile full|files|browser-semantic|browser-visual|desktop]
                 [--result-mode text|structured|compatible]
                                         Print setup instructions without editing client configuration
  mcp <name> [--profile ...] [--result-mode ...]
                                         Serve a lease-transparent MCP stdio bridge
  token show|rotate <name>               Manage bearer tokens
  image build <tag> <directory>          Build a custom computer image
  export [--output qubicl.yaml]          Export a secret-free manifest
  apply <file> [--dry-run] [--prune]     Reconcile a manifest`;
