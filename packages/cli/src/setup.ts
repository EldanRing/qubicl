import { stdin, stderr, stdout } from 'node:process';
import {
  CAPABILITY_CONTRACT_VERSION,
  ComputerDefaultsSchema,
  ConfigSchema,
  IMAGE_CATALOG,
  PRESET_DEFINITIONS,
  defaultConfig,
  defaultSecrets,
  formatBytes,
  memoryBytes,
  assertValidName,
  validateCpu,
  validateMemory,
  type ComputerConfig,
  type Preset,
} from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, numberOption, stringOption } from './args.js';
import { addConfiguredComputer } from './computers.js';
import {
  acquireCatalogGateway,
  acquireCatalogPreset,
  acquireCustomImage,
  assertGatewayPort,
  containerStatus,
  dockerDiskUsage,
  ensureRuntimeImages,
  gatewayStatus,
  portAvailable,
  probeBindMount,
} from './docker.js';
import { inspectStateFormat } from './migrations.js';
import {
  confirm,
  choosePreset,
  presetComparison,
  questionWithDefault,
  ReadlineSetupPrompt,
  SetupBackError,
  SetupCancelledError,
  type SetupPrompt,
} from './prompts.js';
import { runImagePreflight, runSetupPreflight, type PreflightResult } from './preflight.js';
import { buildSetupPlan, sameSetupSnapshot, snapshotSetup, type SetupSelections } from './setup-plan.js';
import { gatewayEndpointSet, type GatewayEndpointSet } from './gateway-access.js';
import {
  loadState,
  prepareStateDirectories,
  statePaths,
  withStateLock,
  type LoadedState,
} from './state.js';
import { createStateTransaction, executeStateTransaction } from './transactions.js';
import { synchronizeStartedSkillPolicies } from './policy-commands.js';

export interface SetupResult {
  ok: true;
  stateRoot: string;
  default: {
    preset: string;
    compatibility: string;
    image: string;
    cpus: number;
    memory: string;
  };
  gateway: { port: number; image: string };
  computer: null | {
    name: string;
    id: string;
    running: boolean;
    stdio: string;
    mcp: string;
    openapi: string;
    view?: string;
    remote?: GatewayEndpointSet;
  };
  warnings: string[];
}

export async function setupCommand(args: ParsedArgs, injectedPrompt?: SetupPrompt): Promise<void> {
  const paths = statePaths();
  const existing = await optionalState(paths);
  const snapshot = snapshotSetup(existing?.config);
  const json = flag(args, 'json');
  const interactive = !json && (Boolean(injectedPrompt) || stdin.isTTY);
  const output = json ? stderr : stdout;
  const write = (message: string) => output.write(`${message}\n`);
  const verbose = flag(args, 'verbose');
  const prompt = injectedPrompt ?? (interactive ? new ReadlineSetupPrompt(output, !flag(args, 'no-clear') && !verbose) : undefined);
  const progress: { stage: 'review' | 'acquisition' | 'transaction' | 'complete' } = { stage: 'review' };
  let retryCommand: string | undefined;
  try {
    validateSetupMode(args, interactive);
    let selections = selectionsFromArgs(args);
    const preflight = await runSetupPreflight(paths, existing, IMAGE_CATALOG, selections.gatewayPort);
    const hardFailures = preflight.checks.filter(({ status, id }) => status === 'fail' && id !== 'gateway-port');
    if (!interactive || verbose || hardFailures.length) printPreflight(preflight, write, verbose);
    if (hardFailures.length) throw new Error(`Setup preflight failed: ${hardFailures.map(({ id }) => id).join(', ')}.`);
    if (!preflight.docker) throw new Error('Docker preflight did not produce host capacity information.');

    if (shouldPromptForSetupSelections(args, selections, interactive)) {
      selections = await completeInteractiveSelections(prompt!, selections, existing, preflight, verbose);
    }
    const plan = buildSetupPlan(snapshot, selections, IMAGE_CATALOG, preflight.docker.platform, {
      cpus: preflight.docker.cpus,
      memoryBytes: preflight.docker.memoryBytes,
    });
    retryCommand = setupRetryCommand(plan);
    const imageChecks = await runImagePreflight(plan.gateway.image, plan.proposedDefault.image, plan.offline);
    const missingOfflineImages = imageChecks.filter(({ status }) => status === 'fail');
    if (missingOfflineImages.length) {
      printImageChecks(imageChecks, write, verbose);
      throw new Error(`Setup image preflight failed: ${missingOfflineImages.map(({ id }) => id).join(', ')}.`);
    }
    const imageNotice: string[] = [];
    printImageChecks(imageChecks, (line) => imageNotice.push(line), verbose);

    if (!(await selectedPortAvailable(existing, plan.gateway.port))) {
      throw new Error(`Gateway port 127.0.0.1:${plan.gateway.port} is occupied. Choose another with --gateway-port.`);
    }
    const dockerUsage = verbose ? await dockerDiskUsage().catch(() => 'Docker disk usage unavailable') : '';
    const preview: string[] = [];
    printPreview(plan, paths.root, preflight, dockerUsage, (line) => preview.push(line), verbose);
    if (interactive && prompt?.redraw && !verbose) prompt.redraw([...imageNotice, ...preview].join('\n'));
    else for (const line of [...imageNotice, ...preview]) write(line);
    if (!flag(args, 'yes')) {
      if (!interactive) throw new Error('Noninteractive setup requires --yes.');
      if (!(await confirm(prompt!, 'Proceed?', true))) {
        write('Setup cancelled. No Qubicl state was changed and no images were obtained.');
        return;
      }
    }

    progress.stage = 'acquisition';
    const result = await withStateLock(paths, async () => {
      const current = await optionalState(paths);
      if (!sameSetupSnapshot(plan.snapshot, current?.config)) throw new Error('Qubicl state changed while setup was being reviewed. Rerun qubicl setup.');
      phase(write, 'validating');
      const gatewayWasRunning = current ? (await gatewayStatus(current)).status === 'running' : false;
      const priorGateway = current?.config.gateway;
      const runningIds = current ? (await Promise.all(current.config.computers.map(async (computer) => ({
        id: computer.id,
        running: (await containerStatus(current, computer.id)).status === 'running',
      })))).filter(({ running }) => running).map(({ id }) => id) : [];

      phase(write, 'obtaining gateway');
      const gatewayIdentity = await acquireCatalogGateway({
        offline: plan.offline,
        stderr: json,
        platform: plan.platform,
        progress: write,
      });
      phase(write, 'obtaining preset');
      const acquired = plan.selected.kind === 'preset'
        ? await acquireCatalogPreset(plan.selected.preset, { offline: plan.offline, stderr: json, platform: plan.platform, progress: write })
        : await acquireCustomImage(
          plan.selected.image,
          { offline: plan.offline, stderr: json, platform: plan.platform, progress: write },
          plan.proposedDefault.image.resolved,
        );
      const defaultContract = ComputerDefaultsSchema.parse({
        preset: plan.selected.kind === 'preset' ? plan.selected.preset : 'custom',
        compatibility: acquired.manifest.compatibility,
        image: acquired.identity,
        capabilityContractVersion: CAPABILITY_CONTRACT_VERSION,
        capabilities: acquired.manifest.capabilities,
        cpus: plan.proposedDefault.cpus,
        memory: plan.proposedDefault.memory,
      });
      const recommendation = PRESET_DEFINITIONS[defaultContract.compatibility];
      if ((defaultContract.cpus < recommendation.cpus || memoryBytes(defaultContract.memory) < memoryBytes(recommendation.memory))
        && !plan.unsupportedResources) {
        throw new Error(`Custom image resolves to ${defaultContract.compatibility} compatibility and requires explicit approval below ${recommendation.cpus} CPU / ${recommendation.memory}.`);
      }
      phase(write, 'checking bind mount');
      await probeBindMount(paths.root, acquired.identity.resolved, json);

      if (!(await selectedPortAvailable(current, plan.gateway.port))) {
        throw new Error(`Gateway port 127.0.0.1:${plan.gateway.port} became occupied while setup was being reviewed. Rerun setup and choose an available port.`);
      }
      phase(write, 'saving configuration');
      await prepareStateDirectories(paths);
      const state: LoadedState = current ?? { paths, config: defaultConfig(), secrets: defaultSecrets() };
      state.config.gateway = {
        port: plan.gateway.port,
        image: gatewayIdentity,
        ...(state.config.gateway.exposure ? { exposure: structuredClone(state.config.gateway.exposure) } : {}),
      };
      state.config.defaults = defaultContract;
      let computer: ComputerConfig | undefined;
      if (plan.createName) computer = addConfiguredComputer(state, plan.createName, defaultContract);
      state.config = ConfigSchema.parse(state.config);

      const gatewayChanged = !priorGateway || JSON.stringify(priorGateway) !== JSON.stringify(state.config.gateway);
      const startCreatedComputer = Boolean(computer && plan.start);
      const replacingGateway = gatewayChanged && (gatewayWasRunning || startCreatedComputer);
      const reconnectIds = replacingGateway ? runningIds : [];
      // Cached content-ID contracts cover existing retained runtimes. Do not
      // make a gateway-only replacement depend on their pruned image objects.
      const contractComputers = computer ? [computer] : [];
      await ensureRuntimeImages(state, contractComputers, true);
      // Preserve the pre-setup runtime state. A running empty gateway still
      // needs recreation when its image or port changes; a stopped empty
      // installation must remain stopped.
      const startGateway = replacingGateway;
      if (startGateway || reconnectIds.length || startCreatedComputer) phase(write, 'starting gateway/computer');
      if (computer && plan.start) phase(write, 'verifying health and capabilities');
      progress.stage = 'transaction';
      await executeStateTransaction(paths, createStateTransaction('setup', state, {
        ...(computer ? { activeSources: { [computer.id]: 'create' as const } } : {}),
        runtime: {
          startGateway,
          reconnectIds,
          startIds: computer && plan.start ? [computer.id] : [],
        },
      }));
      if (computer && plan.start) await synchronizeStartedSkillPolicies(state, [computer]);
      progress.stage = 'complete';
      return buildSetupResult(state, computer, Boolean(computer && plan.start), plan.warnings);
    });

    phase(write, 'complete');
    if (json) stdout.write(`${JSON.stringify(result)}\n`);
    else printHandoff(result, write);
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      write('Setup cancelled. No Qubicl state was changed and no images were obtained.');
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (progress.stage === 'acquisition') {
      throw new Error(`${detail} Existing Qubicl defaults were not changed. Docker may retain reusable image cache; correct the reported problem and retry with the same choices: ${retryCommand ?? 'qubicl setup'}.`);
    }
    if (progress.stage === 'transaction') {
      throw new Error(`${detail} Setup has a recoverable transaction in protected Qubicl state. Correct the reported problem, then rerun qubicl setup or run qubicl up to resume runtime recovery.`);
    }
    throw error;
  } finally {
    prompt?.close();
  }
}

export function setupRetryCommand(plan: ReturnType<typeof buildSetupPlan>): string {
  const selected = plan.selected.kind === 'preset'
    ? ['--preset', plan.selected.preset]
    : ['--image', plan.selected.image];
  const create = plan.createName
    ? ['--create', plan.createName, ...(plan.start ? [] : ['--no-start'])]
    : ['--no-create'];
  const args = [
    'qubicl', 'setup', ...selected,
    '--cpus', `${plan.proposedDefault.cpus}`,
    '--memory', plan.proposedDefault.memory,
    '--gateway-port', `${plan.gateway.port}`,
    ...create,
    ...(plan.offline ? ['--offline'] : []),
    ...(plan.unsupportedResources ? ['--allow-unsupported-resources'] : []),
    '--yes',
  ];
  return args.map(shellArgument).join(' ');
}

function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function validateSetupMode(args: ParsedArgs, interactive: boolean): void {
  const preset = stringOption(args, 'preset');
  const image = stringOption(args, 'image');
  if (preset && image) throw new Error('--preset and --image are mutually exclusive.');
  if (flag(args, 'no-create') && stringOption(args, 'create')) throw new Error('--create and --no-create are mutually exclusive.');
  if (flag(args, 'no-start') && !stringOption(args, 'create')) throw new Error('--no-start is valid only with --create.');
  if (!interactive) {
    if (!flag(args, 'yes')) throw new Error('Noninteractive setup requires --yes.');
    if (!preset && !image) throw new Error('Noninteractive setup requires --preset or --image.');
    const createChoices = Number(Boolean(stringOption(args, 'create'))) + Number(flag(args, 'no-create'));
    if (createChoices !== 1) throw new Error('Noninteractive setup requires exactly one of --create NAME or --no-create.');
  }
}

export function selectionsFromArgs(args: ParsedArgs): SetupSelections {
  const presetValue = stringOption(args, 'preset');
  const create = stringOption(args, 'create');
  return {
    ...(presetValue ? { preset: presetValue as Preset } : {}),
    ...(stringOption(args, 'image') ? { image: stringOption(args, 'image')! } : {}),
    ...(numberOption(args, 'cpus') !== undefined ? { cpus: numberOption(args, 'cpus')! } : {}),
    ...(stringOption(args, 'memory') ? { memory: stringOption(args, 'memory')! } : {}),
    ...(numberOption(args, 'gateway-port') !== undefined ? { gatewayPort: numberOption(args, 'gateway-port')! } : {}),
    ...(create ? { createName: create } : flag(args, 'no-create') ? { createName: null } : {}),
    start: !flag(args, 'no-start'),
    offline: flag(args, 'offline'),
    allowUnsupportedResources: flag(args, 'allow-unsupported-resources'),
  };
}

export function shouldPromptForSetupSelections(
  args: ParsedArgs,
  selections: SetupSelections,
  interactive: boolean,
): boolean {
  if (!interactive) return false;
  if (!flag(args, 'yes')) return true;
  return !(
    (selections.preset !== undefined || selections.image !== undefined)
    && selections.cpus !== undefined
    && selections.memory !== undefined
    && selections.gatewayPort !== undefined
    && selections.createName !== undefined
  );
}

export async function completeInteractiveSelections(
  prompt: SetupPrompt,
  initial: SetupSelections,
  existing: LoadedState | undefined,
  preflight: PreflightResult,
  verbose = false,
): Promise<SetupSelections> {
  const selections = { ...initial };
  const notices = verbose ? [] : visiblePreflightChecks(preflight).filter(({ status }) => status === 'warn');
  let firstScreen = true;
  const screen = (message: string): void => {
    const attention = firstScreen && notices.length
      ? `Setup notice:\n${notices.map(formatCheck).join('\n')}\n\n`
      : '';
    firstScreen = false;
    redraw(prompt, `${attention}${message}`);
  };
  const explicit = {
    cpus: initial.cpus !== undefined,
    memory: initial.memory !== undefined,
    create: initial.createName !== undefined,
  };
  let stage = selections.preset || selections.image ? 1 : 0;
  for (;;) {
    if (stage === 0) {
      screen(presetComparison(IMAGE_CATALOG, preflight.docker!.platform, undefined, verbose));
      const before = selectedKey(selections);
      const current = selections.preset
        ? { preset: selections.preset }
        : selections.image
          ? { customImage: selections.image }
          : existing?.config.defaults.preset === 'custom'
            ? { customImage: existing.config.defaults.image.requested }
            : existing ? { preset: existing.config.defaults.preset } : undefined;
      try {
        const selected = await choosePreset(prompt, current);
        delete selections.preset;
        delete selections.image;
        Object.assign(selections, selected);
        if (before && before !== selectedKey(selections)) {
          if (!explicit.cpus) delete selections.cpus;
          if (!explicit.memory) delete selections.memory;
          selections.allowUnsupportedResources = false;
        }
        stage = 1;
      } catch (error) {
        if (!(error instanceof SetupBackError)) throw error;
        prompt.write('Preset selection is the first setup step; choose a preset or type cancel.');
      }
      continue;
    }

    if (stage === 1) {
      const compatibility = recommendationForSelection(selections, existing);
      const recommendation = PRESET_DEFINITIONS[compatibility];
      const retained = selectionMatchesExisting(selections, existing);
      let proposedCpus = selections.cpus ?? (retained ? existing!.config.defaults.cpus : recommendation.cpus);
      let proposedMemory = selections.memory ?? (retained ? existing!.config.defaults.memory : recommendation.memory);
      const resourceSummary = `Resource limits\nRecommended: ${recommendation.cpus} CPU / ${recommendation.memory}\nAvailable to Docker: ${preflight.docker!.cpus} CPU / ${formatBytes(preflight.docker!.memoryBytes)}`;
      screen(resourceSummary);
      try {
        if (await confirm(prompt, 'Edit CPU or memory limits? (type back for preset selection)', false)) {
          proposedCpus = await promptCpu(prompt, proposedCpus, preflight.docker!.cpus, resourceSummary);
          proposedMemory = await promptMemory(prompt, proposedMemory, preflight.docker!.memoryBytes, proposedCpus);
        }
        validateCpu(proposedCpus, preflight.docker!.cpus);
        proposedMemory = validateMemory(proposedMemory, preflight.docker!.memoryBytes);
        selections.cpus = proposedCpus;
        selections.memory = proposedMemory;
        if (proposedCpus < recommendation.cpus || memoryBytes(proposedMemory) < memoryBytes(recommendation.memory)) {
          prompt.write('These limits are below the tested recommendation and may fail under the preset workload.');
          selections.allowUnsupportedResources = await confirm(prompt, 'Continue with unsupported resource limits?', false);
          if (!selections.allowUnsupportedResources) {
            prompt.write('Choose different limits or return to preset selection.');
            continue;
          }
        } else {
          selections.allowUnsupportedResources = false;
        }
        stage = 2;
      } catch (error) {
        if (!(error instanceof SetupBackError)) throw error;
        stage = 0;
      }
      continue;
    }

    if (stage === 2) {
      try {
        for (;;) {
          screen('Gateway settings\nQubicl listens on localhost only.');
          const fallback = selections.gatewayPort ?? existing?.config.gateway.port ?? 3211;
          const answer = await questionWithDefault(prompt, 'Gateway localhost port (or back)', `${fallback}`);
          const port = Number(answer);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            prompt.write('Enter an integer port from 1 through 65535.');
            continue;
          }
          if (!(await selectedPortAvailable(existing, port))) {
            prompt.write(`127.0.0.1:${port} is occupied. Choose another port.`);
            continue;
          }
          selections.gatewayPort = port;
          stage = 3;
          break;
        }
      } catch (error) {
        if (!(error instanceof SetupBackError)) throw error;
        stage = 1;
      }
      continue;
    }

    if (explicit.create) return selections;
    try {
      screen('First computer');
      const create = await confirm(prompt, 'Create a computer now? (type back for gateway settings)', !existing);
      if (!create) {
        selections.createName = null;
        return selections;
      }
      const suggested = nextName(existing?.config);
      for (;;) {
        redraw(prompt, 'First computer\nUse a short lowercase name with letters, numbers, and hyphens.');
        const name = await questionWithDefault(prompt, 'Computer name', suggested);
        try {
          assertValidName(name);
          if (existing?.config.computers.some((computer) => computer.name === name)) throw new Error(`Computer ${name} already exists.`);
          selections.createName = name;
          return selections;
        } catch (error) {
          if (error instanceof SetupBackError || error instanceof SetupCancelledError) throw error;
          prompt.write(error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      if (!(error instanceof SetupBackError)) throw error;
      delete selections.createName;
      stage = 2;
    }
  }
}

function selectedKey(selections: SetupSelections): string | undefined {
  return selections.preset ? `preset:${selections.preset}` : selections.image ? `image:${selections.image}` : undefined;
}

function selectionMatchesExisting(selections: SetupSelections, existing: LoadedState | undefined): boolean {
  if (!existing) return false;
  return selections.image
    ? existing.config.defaults.preset === 'custom' && existing.config.defaults.image.requested === selections.image
    : existing.config.defaults.preset === selections.preset;
}

function recommendationForSelection(selections: SetupSelections, existing: LoadedState | undefined): Preset {
  if (selections.preset) return selections.preset;
  return selectionMatchesExisting(selections, existing) ? existing!.config.defaults.compatibility : 'workstation';
}

async function promptCpu(prompt: SetupPrompt, fallback: number, capacity: number, summary: string): Promise<number> {
  for (;;) {
    redraw(prompt, summary);
    const answer = await questionWithDefault(prompt, 'CPU limit', `${fallback}`);
    const value = Number(answer);
    try { return validateCpu(value, capacity); }
    catch (error) { prompt.write(error instanceof Error ? error.message : String(error)); }
  }
}

async function promptMemory(prompt: SetupPrompt, fallback: string, capacity: number, cpus: number): Promise<string> {
  for (;;) {
    redraw(prompt, `Resource limits\nCPU: ${cpus}\nMemory can use k, m, or g units.`);
    const answer = await questionWithDefault(prompt, 'Memory limit', fallback);
    try { return validateMemory(answer, capacity); }
    catch (error) { prompt.write(error instanceof Error ? error.message : String(error)); }
  }
}

function redraw(prompt: SetupPrompt, message: string): void {
  if (prompt.redraw) prompt.redraw(message);
  else prompt.write(message);
}

function nextName(config: LoadedState['config'] | undefined): string {
  if (!config) return 'qubicl-1';
  let number = config.nextName;
  const names = new Set(config.computers.map(({ name }) => name));
  while (names.has(`qubicl-${number}`)) number += 1;
  return `qubicl-${number}`;
}

async function optionalState(paths: ReturnType<typeof statePaths>): Promise<LoadedState | undefined> {
  const format = await inspectStateFormat(paths);
  if (format.status === 'uninitialized') return undefined;
  if (format.status !== 'current') throw new Error(`Qubicl state is not ready for setup: ${format.detail}.`);
  return loadState(paths);
}

async function selectedPortAvailable(existing: LoadedState | undefined, port: number): Promise<boolean> {
  if (existing && existing.config.gateway.port === port) {
    const candidate = structuredClone(existing);
    candidate.config.gateway.port = port;
    try { await assertGatewayPort(candidate); return true; } catch { return false; }
  }
  return portAvailable(port);
}

export function printPreflight(preflight: PreflightResult, write: (message: string) => void, verbose = false): void {
  const visible = verbose ? preflight.checks : visiblePreflightChecks(preflight);
  if (!visible.length) return;
  write(verbose ? 'Preflight:' : 'Setup needs attention:');
  printChecks(visible, write);
}

function printChecks(checks: PreflightResult['checks'], write: (message: string) => void): void {
  for (const check of checks) write(formatCheck(check));
}

function visiblePreflightChecks(preflight: PreflightResult): PreflightResult['checks'] {
  return preflight.checks.filter(({ status, guidance }) => status === 'fail' || (status === 'warn' && Boolean(guidance)));
}

function formatCheck(check: PreflightResult['checks'][number]): string {
  return `${check.status.toUpperCase()}\t${check.id}\t${check.detail}${check.guidance ? `\t${check.guidance}` : ''}`;
}

function printImageChecks(checks: PreflightResult['checks'], write: (message: string) => void, verbose: boolean): void {
  const visible = verbose ? checks : checks.filter(({ status }) => status !== 'pass');
  if (!visible.length) return;
  write(verbose ? 'Selected image checks:' : 'Image notice:');
  printChecks(visible, write);
}

export function printPreview(
  plan: ReturnType<typeof buildSetupPlan>,
  root: string,
  preflight: PreflightResult,
  dockerUsage: string,
  write: (message: string) => void,
  verbose = false,
): void {
  write('Setup preview:');
  write(`  default: ${plan.selected.kind === 'preset' ? plan.selected.preset : `custom ${plan.selected.image}`}`);
  if (plan.downloadBytes === null && plan.expandedBytes === null && IMAGE_CATALOG.development) {
    write('  image size: not measured for source builds');
  } else {
    write(`  image content: download ${formatBytes(plan.downloadBytes)}; expanded ${formatBytes(plan.expandedBytes)}`);
  }
  write(`  host filesystem free: ${preflight.hostDisk ? formatBytes(preflight.hostDisk.availableBytes) : 'unknown'}`);
  write(`  limits: ${plan.proposedDefault.cpus} CPU / ${plan.proposedDefault.memory}`);
  write(`  binding: 127.0.0.1:${plan.gateway.port}`);
  write(`  first computer: ${plan.createName ?? 'none'}${plan.createName ? plan.start ? ' (create and start)' : ' (create, do not start)' : ''}`);
  if (verbose) {
    write(`  state: ${root}`);
    write(`  gateway image: ${plan.gateway.image.resolved}`);
    write(`  computer image: ${plan.proposedDefault.image.resolved}`);
    write(`  gateway content: download ${formatBytes(plan.gatewayDownloadBytes)}; expanded ${formatBytes(plan.gatewayExpandedBytes)}`);
    write(`  computer content: download ${formatBytes(plan.computerDownloadBytes)}; expanded ${formatBytes(plan.computerExpandedBytes)}`);
    write('  Docker image-store free capacity: unknown');
    write('  Docker usage now:');
    for (const line of dockerUsage.split('\n')) write(`    ${line}`);
  }
  for (const warning of plan.warnings) write(`  WARNING: ${warning}`);
}

function phase(write: (message: string) => void, name: string): void {
  write(`[${name}]`);
}

export function buildSetupResult(state: LoadedState, computer: ComputerConfig | undefined, running: boolean, warnings: string[]): SetupResult {
  const endpoints = computer ? gatewayEndpointSet(state.config.gateway, computer, 'local') : undefined;
  const remote = computer ? gatewayEndpointSet(state.config.gateway, computer, 'remote') : undefined;
  return {
    ok: true,
    stateRoot: state.paths.root,
    default: {
      preset: state.config.defaults.preset,
      compatibility: state.config.defaults.compatibility,
      image: state.config.defaults.image.resolved,
      cpus: state.config.defaults.cpus,
      memory: state.config.defaults.memory,
    },
    gateway: { port: state.config.gateway.port, image: state.config.gateway.image.resolved },
    computer: computer && endpoints ? {
      name: computer.name,
      id: computer.id,
      running,
      stdio: `qubicl mcp ${computer.name}`,
      mcp: endpoints.mcp,
      openapi: endpoints.openapi,
      ...(computer.capabilities.includes('viewer') ? { view: endpoints.view } : {}),
      ...(remote ? { remote } : {}),
    } : null,
    warnings,
  };
}

export function printHandoff(result: SetupResult, write: (message: string) => void): void {
  write(`Qubicl setup is complete at ${result.stateRoot}.`);
  write(`Default: ${result.default.preset} (${result.default.compatibility}) at ${result.default.cpus} CPU / ${result.default.memory}; image ${result.default.image}`);
  if (result.computer) {
    write(`Computer: ${result.computer.name} (${result.computer.id})${result.computer.running ? ' is healthy' : ' is configured but stopped'}.`);
    write(`Preferred token-free stdio bridge: ${result.computer.stdio}`);
    write(`MCP: ${result.computer.mcp}`);
    write(`OpenAPI: ${result.computer.openapi}`);
    if (result.computer.view) write(`Viewer: ${result.computer.view}`);
    if (result.computer.remote) write(`Remote HTTPS: ${result.computer.remote.origin}`);
    write(`Client adapter: qubicl connect ${result.computer.name} --client codex (other adapters are available)`);
    write(`HTTP authentication: qubicl token show ${result.computer.name}`);
    write('Direct MCP/OpenAPI URLs require that bearer token. The local stdio bridge reads it from protected Qubicl state.');
  }
  write('Only /home is durable. Packages or files installed elsewhere in a computer may disappear when its container is recreated.');
}
