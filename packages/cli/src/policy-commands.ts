import { join } from 'node:path';
import {
  ConfigSchema,
  ToolPolicySchema,
  defaultCatalogSkillsForCompatibility,
  isToolName,
  toolDefinitions,
  toolTitle,
  toolsForCapabilities,
  type ComputerConfig,
  type ComputerToolName,
  type Preset,
} from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, stringOption } from './args.js';
import { containerStatus } from './docker.js';
import { renderRuntime } from './runtime.js';
import { loadState, statePaths, withStateLock, type LoadedState, type StatePaths } from './state.js';
import { createStateTransaction, executeStateTransaction } from './transactions.js';
import { checkboxSelector, singleSelector, type SelectorItem } from './selector.js';
import {
  importSkill,
  listInstalledSkills,
  loadCoreCatalog,
  materializeSkills,
  materializeSkillsIfInitialized,
  removeImportedSkill,
  resetInstalledSkill,
  restoreImportedSkill,
  skillStorePaths,
  synchronizeSkillDiscovery,
  updateImportedSkill,
  type CoreCatalog,
  type CoreSkill,
  type InstalledSkill,
  type SkillStatus,
} from './skill-store.js';

export const TOOL_CATEGORIES: ReadonlyArray<{ id: string; label: string; tools: readonly ComputerToolName[] }> = [
  { id: 'control', label: 'Control & status', tools: ['get_computer_status', 'acquire_lease', 'renew_lease', 'release_lease'] },
  { id: 'terminal', label: 'Terminal & processes', tools: ['exec_command', 'write_stdin', 'stop_process'] },
  { id: 'previews', label: 'Ports & previews', tools: ['list_ports', 'publish_port', 'list_previews', 'unpublish_port'] },
  { id: 'credentials', label: 'Credential broker', tools: ['broker_request'] },
  { id: 'skills', label: 'Skills', tools: ['skills_list', 'skill_view', 'skill_manage'] },
  { id: 'web', label: 'Web', tools: ['web_search', 'web_extract'] },
  { id: 'files', label: 'Files', tools: ['list_files', 'get_file_info', 'read_file', 'write_file', 'edit_file', 'copy_path', 'move_path', 'delete_path'] },
  { id: 'desktop', label: 'Desktop interaction', tools: ['take_screenshot', 'control_computer'] },
  { id: 'browser-semantic', label: 'Browser — semantic', tools: ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_history', 'browser_wait', 'browser_tabs', 'browser_use_tab', 'browser_new_tab', 'browser_close_tab', 'browser_reset'] },
  { id: 'browser-visual', label: 'Browser — visual', tools: ['browser_click_at', 'browser_double_click_at', 'browser_hover_at', 'browser_drag', 'browser_scroll_at', 'browser_type_focused', 'browser_inspect_at', 'browser_computer'] },
  { id: 'clipboard', label: 'Clipboard', tools: ['read_clipboard', 'write_clipboard'] },
  { id: 'desktop-apps', label: 'Desktop applications', tools: ['open_desktop_application', 'list_desktop_applications', 'close_desktop_application'] },
];

const LOCKED_TOOLS = new Set<ComputerToolName>(['get_computer_status', 'acquire_lease', 'renew_lease', 'release_lease']);
const SKILL_ACTIONS = new Set(['import', 'inspect', 'update', 'enable', 'disable', 'reset', 'remove', 'restore']);

export async function skillsCommand(args: ParsedArgs): Promise<void> {
  validateSkillsInvocation(args);
  const name = required(args.positionals[0], 'computer name');
  const action = args.positionals[1];
  if (action) {
    if (!SKILL_ACTIONS.has(action)) throw new Error(`Unknown skills action ${action}.`);
    return skillActionCommand(name, action, args);
  }
  if (interactiveRequested(args)) {
    const state = await loadState();
    const computer = findComputer(state.config.computers, name);
    const home = computerHome(state.paths, computer);
    const catalog = await loadCoreCatalog();
    await materializeSkillsIfInitialized(computer, home);
    const installed = await listInstalledSkills(home, computer.skillPolicy?.enabledCatalogSkills ?? []);
    const selected = await checkboxSelector(
      `Skills for ${computer.name}`,
      installed.map((skill) => installedSelectorItem(skill, catalog, computer.compatibility)),
      new Set(computer.skillPolicy?.enabledCatalogSkills ?? []),
      { searchable: true },
    );
    const previouslyEnabled = new Set(computer.skillPolicy?.enabledCatalogSkills ?? []);
    for (const id of selected) if (!previouslyEnabled.has(id)) assertCoreSkillCompatible(resolveStatus(installed, id), catalog, computer.compatibility);
    return updatePolicy(name, 'skills', syntheticArgs(name, { profile: 'none', enable: [...selected].join(',') }));
  }
  await updatePolicy(name, 'skills', args);
}

export function validateSkillsInvocation(args: ParsedArgs): void {
  const action = args.positionals[1];
  const allowed = action === undefined
    ? new Set(['enable', 'disable', 'profile', 'yes', 'json'])
    : new Set(action === 'import' ? ['ref', 'path', 'enable', 'yes', 'json']
      : action === 'update' ? ['ref', 'path', 'yes', 'json']
        : action === 'inspect' ? ['json']
          : action === 'reset' ? ['all', 'yes', 'json']
            : ['yes', 'json']);
  for (const option of args.options.keys()) if (!allowed.has(option)) throw new Error(`Option --${option} is not valid for ${action ? `skills ${action}` : 'the skills selector'}.`);
  if (action === 'import' && args.options.has('enable') && !flag(args, 'enable')) throw new Error('Option --enable does not take a value for skills import.');
  const count = args.positionals.length;
  if (action === undefined && count !== 1) throw new Error('skills requires exactly one computer name unless an action is selected.');
  if (action === 'import' && count !== 3) throw new Error('skills import requires exactly one source directory or HTTPS Git URL.');
  if (action === 'update' && count !== 4) throw new Error('skills update requires a skill name and replacement source.');
  if (action === 'reset') {
    const all = flag(args, 'all');
    if ((all && count !== 2) || (!all && count !== 3)) throw new Error('skills reset requires either one skill name or --all.');
  } else if (action && !['import', 'update'].includes(action) && count !== 3) {
    throw new Error(`skills ${action} requires exactly one skill name.`);
  }
}

export async function toolsCommand(args: ParsedArgs): Promise<void> {
  const name = required(args.positionals[0], 'computer name');
  if (interactiveRequested(args)) {
    const state = await loadState();
    const computer = findComputer(state.config.computers, name);
    const maximum = toolsForCapabilities(computer.capabilities);
    const current = new Set(computer.toolPolicy ?? maximum);
    const selected = await checkboxSelector(
      `Tools for ${computer.name}`,
      TOOL_CATEGORIES.flatMap(({ label, tools }) => tools.filter((tool) => maximum.includes(tool)).map((tool) => ({ id: tool, label: toolDisplayLabel(tool), category: label, detail: toolDetail(tool), locked: LOCKED_TOOLS.has(tool) }))),
      current,
    );
    const disabled = maximum.filter((tool) => !selected.has(tool));
    return updatePolicy(name, 'tools', syntheticArgs(name, { profile: 'full', disable: disabled.join(',') }));
  }
  await updatePolicy(name, 'tools', args);
}

export async function creationPolicySelection(
  computer: Pick<ComputerConfig, 'capabilities' | 'compatibility'>,
  requestedSkills: string | undefined,
  requestedTools: string | undefined,
  assumeRecommended: boolean,
): Promise<{ toolPolicy: ComputerToolName[]; skillPolicy: { enabledCatalogSkills: string[] } }> {
  if (requestedSkills !== undefined || requestedTools !== undefined || assumeRecommended || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { toolPolicy: toolSelection(requestedTools, computer), skillPolicy: { enabledCatalogSkills: await skillSelection(requestedSkills, computer.compatibility) } };
  }
  const catalog = await loadCoreCatalog();
  const recommended = defaultCatalogSkillsForCompatibility(computer.compatibility);
  const skillProfile = await singleSelector('Skill package', [
    { id: 'core', label: 'Core (recommended)', category: 'Profiles', detail: skillProfileDetail(computer.compatibility) },
    { id: 'custom', label: 'Custom', category: 'Profiles', detail: 'Choose individual Qubicl core skills compatible with this preset.' },
    { id: 'none', label: 'None', category: 'Profiles', detail: 'Start without active core skills; skills can be enabled or imported later.' },
  ], 'core');
  const compatible = catalog.skills.filter(({ compatiblePresets }) => compatiblePresets.includes(computer.compatibility));
  const selectedSkills = skillProfile === 'custom'
    ? [...await checkboxSelector('Choose core skills', compatible.map(coreSelectorItem), new Set(recommended), { searchable: true })]
    : await skillSelection(skillProfile, computer.compatibility);
  const toolProfile = await singleSelector('Tool package', [
    { id: 'full', label: 'Full (recommended)', category: 'Profiles', detail: 'Enable every tool allowed by the selected computer preset.' },
    { id: 'custom', label: 'Custom', category: 'Profiles', detail: 'Choose individual tools, grouped by category.' },
  ], 'full');
  const maximum = toolsForCapabilities(computer.capabilities);
  const selectedTools = toolProfile === 'custom'
    ? [...await checkboxSelector('Choose tools', TOOL_CATEGORIES.flatMap(({ label, tools }) => tools.filter((tool) => maximum.includes(tool)).map((tool) => ({ id: tool, label: toolDisplayLabel(tool), category: label, detail: toolDetail(tool), locked: LOCKED_TOOLS.has(tool) }))), new Set(maximum))] as ComputerToolName[]
    : maximum;
  return { toolPolicy: maximum.filter((tool) => selectedTools.includes(tool)), skillPolicy: { enabledCatalogSkills: selectedSkills } };
}

export async function skillSelection(spec: string | undefined, compatibility: Preset = 'workstation'): Promise<string[]> {
  const catalog = await loadCoreCatalog();
  if (spec === undefined || spec === 'core') return defaultCatalogSkillsForCompatibility(compatibility);
  if (spec === 'none') return [];
  if (spec === 'hermes') throw new Error('The Hermes bulk catalog is no longer packaged; import a reviewed Agent Skills package explicitly with qubicl skills COMPUTER import SOURCE.');
  return resolveCoreSkills(commaList(spec), catalog, compatibility);
}

export function toolSelection(spec: string | undefined, computer: Pick<ComputerConfig, 'capabilities'>): ComputerToolName[] {
  const maximum = toolsForCapabilities(computer.capabilities);
  if (!spec || spec === 'full') return maximum;
  const selected = new Set<ComputerToolName>(LOCKED_TOOLS);
  for (const value of commaList(spec)) for (const tool of expandTool(value, maximum)) selected.add(tool);
  return maximum.filter((tool) => selected.has(tool));
}

// Retain the old export name for internal callers while the storage semantics
// are now editable working copies rather than duplicated immutable catalog files.
export const materializeCatalogSkills = materializeSkills;
export const materializeCatalogSkillsIfInitialized = materializeSkillsIfInitialized;

/**
 * Finish skill initialization for computers that have just started.
 *
 * A new home cannot be materialized safely until the session runtime has
 * established its ownership marker. Rewrite the protected policy digest only
 * after that materialization, then explicitly reload each running controller
 * so there is no window where an initialized registry is compared with the
 * pre-start `not-initialized` policy snapshot.
 */
export async function synchronizeStartedSkillPolicies(state: LoadedState, computers: readonly ComputerConfig[]): Promise<void> {
  if (!computers.length) return;
  for (const computer of computers) await materializeSkills(computer, computerHome(state.paths, computer));
  await renderRuntime(state);
  for (const computer of computers) {
    const runtime = await containerStatus(state, computer.id);
    if (runtime.status === 'running') {
      await reloadOperatorPolicy(state.config.gateway.port, computer.id, state.secrets.computers[computer.id]!.internalKey);
    }
  }
}

async function skillActionCommand(computerName: string, action: string, args: ParsedArgs): Promise<void> {
  const paths = statePaths();
  let result: Record<string, unknown> = {};
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state.config.computers, computerName);
    const home = computerHome(paths, computer);
    await materializeSkillsIfInitialized(computer, home);
    const idOrName = args.positionals[2];
    const source = args.positionals[2];
    const mutation = action !== 'inspect';
    if (mutation && !flag(args, 'yes')) throw new Error(`qubicl skills ${computer.name} ${action} requires --yes after reviewing the source and impact.`);
    if (action === 'import') {
      const gitRef = stringOption(args, 'ref');
      const sourcePath = stringOption(args, 'path');
      const installed = await importSkill({ homeRoot: home, source: required(source, 'skill source'), ...(gitRef ? { gitRef } : {}), ...(sourcePath ? { sourcePath } : {}) });
      if (flag(args, 'enable')) computer.skillPolicy = { enabledCatalogSkills: [...new Set([...(computer.skillPolicy?.enabledCatalogSkills ?? []), installed.id])] };
      await persistSkillMutation(paths, state, computer, home);
      result = { action, skill: installed, enabled: computer.skillPolicy?.enabledCatalogSkills.includes(installed.id) ?? false, editableWorkingCopy: join(skillStorePaths(home).installed, installed.name) };
    } else if (action === 'update') {
      const gitRef = stringOption(args, 'ref');
      const sourcePath = stringOption(args, 'path');
      const updated = await updateImportedSkill({ homeRoot: home, idOrName: required(idOrName, 'skill name'), source: required(args.positionals[3], 'updated skill source'), ...(gitRef ? { gitRef } : {}), ...(sourcePath ? { sourcePath } : {}) });
      await persistSkillMutation(paths, state, computer, home);
      result = { action, skill: updated };
    } else if (action === 'reset') {
      if (flag(args, 'all') && idOrName) throw new Error('Use either a skill name or --all, not both.');
      if (!flag(args, 'all') && !idOrName) throw new Error('Reset requires a skill name or --all.');
      const reset: InstalledSkill[] = [];
      const resetIds = flag(args, 'all')
        ? (await listInstalledSkills(home, computer.skillPolicy?.enabledCatalogSkills ?? [])).map(({ id }) => id)
        : [idOrName!];
      for (const id of resetIds) reset.push(await resetInstalledSkill(home, id));
      await persistSkillMutation(paths, state, computer, home);
      result = { action, skills: reset, localEditsDiscarded: true };
    } else if (action === 'remove') {
      const statuses = await listInstalledSkills(home, computer.skillPolicy?.enabledCatalogSkills ?? []);
      const target = resolveStatus(statuses, required(idOrName, 'skill name'));
      computer.skillPolicy = { enabledCatalogSkills: (computer.skillPolicy?.enabledCatalogSkills ?? []).filter((id) => id !== target.id) };
      // Persist fail-closed disablement before moving package bytes. An
      // interruption can leave a disabled installed skill, never an enabled
      // policy pointing at a removed working copy.
      await persistSkillMutation(paths, state, computer, home);
      const removed = await removeImportedSkill(home, target.id);
      await persistSkillMutation(paths, state, computer, home);
      result = { action, ...removed, recoverable: true };
    } else if (action === 'restore') {
      const restored = await restoreImportedSkill(home, required(idOrName, 'skill name'));
      await persistSkillMutation(paths, state, computer, home);
      result = { action, skill: restored, enabled: false };
    } else if (action === 'enable' || action === 'disable') {
      const statuses = await listInstalledSkills(home, computer.skillPolicy?.enabledCatalogSkills ?? []);
      const target = resolveStatus(statuses, required(idOrName, 'skill name'));
      if (action === 'enable') assertCoreSkillCompatible(target, await loadCoreCatalog(), computer.compatibility);
      const selected = new Set(computer.skillPolicy?.enabledCatalogSkills ?? []);
      if (action === 'enable') selected.add(target.id); else selected.delete(target.id);
      computer.skillPolicy = { enabledCatalogSkills: [...selected] };
      await persistSkillMutation(paths, state, computer, home);
      result = { action, id: target.id, name: target.name, enabled: action === 'enable' };
    } else {
      const statuses = await listInstalledSkills(home, computer.skillPolicy?.enabledCatalogSkills ?? []);
      result = { computer: computer.name, skill: resolveStatus(statuses, required(idOrName, 'skill name')), editable: true, operatorControlsActivation: true };
    }
  });
  printResult(result, args);
}

async function persistSkillMutation(paths: StatePaths, state: Awaited<ReturnType<typeof loadState>>, computer: ComputerConfig, home: string): Promise<void> {
  state.config = ConfigSchema.parse(state.config);
  await executeStateTransaction(paths, createStateTransaction('config', state));
  await materializeSkillsIfInitialized(computer, home);
  await renderRuntime(state);
  const runtime = await containerStatus(state, computer.id);
  if (runtime.status === 'running') await reloadOperatorPolicy(state.config.gateway.port, computer.id, state.secrets.computers[computer.id]!.internalKey);
}

async function updatePolicy(name: string, kind: 'skills' | 'tools', args: ParsedArgs): Promise<void> {
  const enable = commaList(stringOption(args, 'enable'));
  const disable = commaList(stringOption(args, 'disable'));
  const profile = stringOption(args, 'profile');
  const mutating = enable.length > 0 || disable.length > 0 || profile !== undefined;
  if (mutating && !flag(args, 'yes') && !process.stdin.isTTY) throw new Error(`Non-interactive ${kind} changes require --yes.`);
  const paths = statePaths();
  let result: Record<string, unknown> | undefined;
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state.config.computers, name);
    const home = computerHome(paths, computer);
    const catalog = await loadCoreCatalog();
    await materializeSkillsIfInitialized(computer, home);
    const installed = await listInstalledSkills(home, computer.skillPolicy?.enabledCatalogSkills ?? []);
    if (!mutating) {
      result = kind === 'skills' ? skillsView(computer, installed, catalog) : toolsView(computer);
      return;
    }
    if (kind === 'skills') {
      const previouslyEnabled = new Set(computer.skillPolicy?.enabledCatalogSkills ?? []);
      const selected = new Set(profile ? await skillSelection(profile, computer.compatibility) : computer.skillPolicy?.enabledCatalogSkills ?? []);
      for (const id of resolveInstalledSkills(enable, installed)) {
        if (!previouslyEnabled.has(id)) assertCoreSkillCompatible(resolveStatus(installed, id), catalog, computer.compatibility);
        selected.add(id);
      }
      for (const id of resolveInstalledSkills(disable, installed)) selected.delete(id);
      computer.skillPolicy = { enabledCatalogSkills: installed.map(({ id }) => id).filter((id) => selected.has(id)) };
    } else {
      const maximum = toolsForCapabilities(computer.capabilities);
      const selected = new Set<ComputerToolName>(profile ? toolSelection(profile, computer) : computer.toolPolicy ?? maximum);
      for (const value of enable) for (const tool of expandTool(value, maximum)) selected.add(tool);
      for (const value of disable) for (const tool of expandTool(value, maximum)) if (!LOCKED_TOOLS.has(tool)) selected.delete(tool);
      computer.toolPolicy = ToolPolicySchema.parse(maximum.filter((tool) => selected.has(tool)));
    }
    state.config = ConfigSchema.parse(state.config);
    await executeStateTransaction(paths, createStateTransaction('config', state));
    await synchronizeSkillDiscovery(home, computer.skillPolicy?.enabledCatalogSkills ?? []);
    await renderRuntime(state);
    const runtime = await containerStatus(state, computer.id);
    const reload = runtime.status === 'running' ? await reloadOperatorPolicy(state.config.gateway.port, computer.id, state.secrets.computers[computer.id]!.internalKey) : { appliedOnNextStart: true };
    result = { ...(kind === 'skills' ? skillsView(computer, await listInstalledSkills(home, computer.skillPolicy?.enabledCatalogSkills ?? []), catalog) : toolsView(computer)), reload };
  });
  printResult(result!, args, kind === 'skills' ? 'Skills policy updated.' : 'Tools policy updated.');
}

async function reloadOperatorPolicy(port: number, id: string, operatorKey: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/computers/${id}/operator/policy/reload`, { method: 'POST', headers: { 'x-qubicl-operator-key': operatorKey, 'content-type': 'application/json' }, body: '{}' });
  const value = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? `Gateway returned HTTP ${response.status} while applying operator policy.`);
  return value;
}

function skillsView(computer: ComputerConfig, installed: SkillStatus[], catalog: CoreCatalog): Record<string, unknown> {
  return {
    computer: computer.name,
    enabled: installed.filter(({ enabled }) => enabled),
    installed,
    coreAvailable: catalog.skills.filter(({ compatiblePresets }) => compatiblePresets.includes(computer.compatibility)).map(({ id, name, category, description }) => ({ id, name, category, description })),
    editableWorkingCopies: true,
    operatorControlsActivation: true,
  };
}

function toolsView(computer: ComputerConfig): Record<string, unknown> {
  const maximum = toolsForCapabilities(computer.capabilities);
  const enabled = new Set(computer.toolPolicy ?? maximum);
  return {
    computer: computer.name,
    categories: TOOL_CATEGORIES.map(({ id, label, tools }) => ({ id, label, tools: tools.filter((tool) => maximum.includes(tool)).map((tool) => ({ name: tool, enabled: enabled.has(tool), locked: LOCKED_TOOLS.has(tool) })) })).filter(({ tools }) => tools.length),
    enabled: maximum.filter((tool) => enabled.has(tool)),
    maximum,
  };
}

function resolveCoreSkills(values: string[], catalog: CoreCatalog, compatibility: Preset): string[] {
  return values.map((value) => {
    const matches = catalog.skills.filter(({ id, name, compatiblePresets }) => compatiblePresets.includes(compatibility) && (id === value || name === value));
    if (!matches.length) throw new Error(`Unknown or incompatible core skill ${value} for ${compatibility}.`);
    return matches[0]!.id;
  });
}

function resolveInstalledSkills(values: string[], skills: SkillStatus[]): string[] {
  return values.map((value) => resolveStatus(skills, value).id);
}

function resolveStatus(skills: SkillStatus[], value: string): SkillStatus {
  const matches = skills.filter(({ id, name }) => id === value || name === value);
  if (!matches.length) throw new Error(`Installed skill ${value} was not found.`);
  if (matches.length > 1) throw new Error(`Skill name ${value} is ambiguous; use its full ID.`);
  return matches[0]!;
}

function expandTool(value: string, maximum: ComputerToolName[]): ComputerToolName[] {
  const category = TOOL_CATEGORIES.find(({ id }) => id === value);
  if (category) return category.tools.filter((tool) => maximum.includes(tool));
  if (!isToolName(value) || !maximum.includes(value)) throw new Error(`Tool or category ${value} is not available for this computer's capability contract.`);
  return [value];
}

function commaList(value: string | undefined): string[] { return value ? [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))] : []; }
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`Missing ${label}.`); return value; }
function interactiveRequested(args: ParsedArgs): boolean { return process.stdin.isTTY && process.stdout.isTTY && !flag(args, 'json') && [...args.options.keys()].every((name) => name === 'help'); }
function syntheticArgs(name: string, values: Record<string, string>): ParsedArgs { const options = new Map<string, string | boolean>(); for (const [key, value] of Object.entries(values)) if (value) options.set(key, value); options.set('yes', true); return { positionals: [name], options }; }
function findComputer(computers: ComputerConfig[], name: string): ComputerConfig { const computer = computers.find(({ name: candidate, id }) => candidate === name || id === name); if (!computer) throw new Error(`Computer ${name} was not found.`); return computer; }
function computerHome(paths: StatePaths, computer: ComputerConfig): string { return join(paths.computers, computer.id, 'home', 'qubicl'); }
function coreSelectorItem(skill: CoreSkill): SelectorItem { return { id: skill.id, label: skill.name, category: skill.category, detail: `${skill.description} [Qubicl core; ${skill.license}]` }; }
function installedSelectorItem(skill: SkillStatus, catalog: CoreCatalog, compatibility: Preset): SelectorItem {
  const core = catalog.skills.find(({ id }) => id === skill.id);
  const availability = core && !core.compatiblePresets.includes(compatibility) ? `; incompatible with ${compatibility}` : '';
  return { id: skill.id, label: skill.name, category: skill.kind === 'core' ? 'Qubicl core' : 'Imported', detail: `${skill.description} [${skill.drift}; editable${availability}]` };
}
function assertCoreSkillCompatible(skill: SkillStatus, catalog: CoreCatalog, compatibility: Preset): void {
  if (skill.kind !== 'core') return;
  const core = catalog.skills.find(({ id }) => id === skill.id);
  if (!core?.compatiblePresets.includes(compatibility)) throw new Error(`Core skill ${skill.name} is incompatible with the ${compatibility} preset because its tested image dependencies are absent.`);
}
export function toolDisplayLabel(tool: ComputerToolName): string { return toolTitle(tool) ?? tool; }

function toolDetail(tool: ComputerToolName): string {
  if (LOCKED_TOOLS.has(tool)) return 'Required for status and exclusive-control safety; cannot be disabled.';
  const title = toolTitle(tool);
  return title ? `${tool}: ${toolDefinitions[tool].description}` : `Qubicl tool: ${tool}`;
}
function skillProfileDetail(compatibility: Preset): string { return `Enable the tested Qubicl-native skills compatible with ${compatibility}.`; }
function printResult(result: Record<string, unknown>, args: ParsedArgs, heading?: string): void { if (heading && !flag(args, 'json') && process.stdout.isTTY) console.log(heading); console.log(JSON.stringify(result, null, 2)); }
