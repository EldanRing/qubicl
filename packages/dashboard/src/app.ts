// oxlint-disable-next-line import/no-unassigned-import -- esbuild emits this stylesheet as a separate linked asset
import './styles.css';
import { ApiError, api } from './api.js';
import type { EventSubscription, ManagementEvent } from './api.js';
import type {
  BackupItem,
  ManagementComputer,
  ManagementJob,
  ManagementOperation,
  ManagementPlan,
  ManagementRequest,
  ManagementSnapshot,
  SessionState,
  SkillItem,
  ToolItem,
} from './types.js';

const root = requiredRoot();

interface AppState {
  session: SessionState | undefined;
  snapshot: ManagementSnapshot | undefined;
  plan: ManagementPlan | undefined;
  activeJob: ManagementJob | undefined;
  busy: boolean;
  execution: { planId: string; idempotencyKey: string; uncertain: boolean } | undefined;
  pendingClientSecret: { planId: string; clientId: string; token: string } | undefined;
}

const state: AppState = { session: undefined, snapshot: undefined, plan: undefined, activeJob: undefined, busy: false, execution: undefined, pendingClientSecret: undefined };
const RECOVERY_SAFE_OPERATIONS = new Set<ManagementOperation>(['recovery.resume', 'dashboard.restart', 'dashboard.revoke']);
let refreshTimer: number | undefined;
let eventStream: EventSubscription | undefined;
let lastSessionActivity = 0;
let navigationGeneration = 0;
let snapshotUpdatedAt: number | undefined;
let snapshotStale = false;

window.addEventListener('hashchange', () => void navigate());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session?.authenticated) void refreshSnapshot(false);
});
document.addEventListener('pointerdown', recordSessionActivity, { passive: true });
document.addEventListener('keydown', recordSessionActivity, { passive: true });

root.addEventListener('click', (event) => void handleClick(event));
root.addEventListener('submit', (event) => void handleSubmit(event));
api.onAuthenticationLost(() => endSession('Your session ended. Sign in again.'));

void boot();

async function boot(): Promise<void> {
  applyTheme(localStorage.getItem('qubicl-theme') ?? 'system');
  renderLoading('Opening your local control plane…');
  try {
    state.session = await api.session();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) return renderFatal(error);
    state.session = { authenticated: false };
  }
  if (!state.session.authenticated) return renderLogin();
  startSessionActivity();
  await refreshSnapshot(true);
}

async function refreshSnapshot(navigateAfter: boolean): Promise<void> {
  try {
    state.snapshot = await api.snapshot();
    snapshotUpdatedAt = Date.now();
    snapshotStale = false;
    if (navigateAfter) await navigate();
    else {
      updateStatusRail();
      const route = currentRoute();
      if ((route[0] ?? 'fleet') === 'fleet' && !state.plan && !state.activeJob) {
        const outlet = document.querySelector<HTMLElement>('#view');
        if (outlet) renderFleet(outlet);
      } else if (route[0] === 'computers' && route[1] && !state.plan && !state.activeJob) {
        await refreshActiveComputerDetail(route[1], route[2] ?? 'overview');
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      endSession('Your session ended. Sign in again.');
      return;
    }
    snapshotStale = true;
    updateStatusRail();
    showToast(errorMessage(error), 'error');
  }
}

async function refreshActiveComputerDetail(id: string, section: string): Promise<void> {
  const sectionRoot = document.querySelector<HTMLElement>('#computer-section');
  if (!sectionRoot || sectionRoot.querySelector(':focus') instanceof HTMLInputElement || sectionRoot.querySelector(':focus') instanceof HTMLTextAreaElement || sectionRoot.querySelector(':focus') instanceof HTMLSelectElement) return;
  const generation = navigationGeneration;
  try {
    const computer = await api.computer(id);
    if (generation !== navigationGeneration || currentRoute()[1] !== id || (currentRoute()[2] ?? 'overview') !== section) return;
    if (section === 'processes') await renderProcesses(sectionRoot, computer);
    else if (section === 'previews') await renderPreviews(sectionRoot, computer);
    else if (section === 'overview') renderOverview(sectionRoot, computer);
    else return;
    sectionRoot.dataset.stale = 'false';
  } catch {
    if (generation !== navigationGeneration || !sectionRoot.isConnected) return;
    sectionRoot.dataset.stale = 'true';
    sectionRoot.querySelector('[data-detail-freshness]')?.replaceChildren(document.createTextNode('Update failed · showing earlier data'));
  }
}

async function navigate(): Promise<void> {
  const generation = navigationGeneration += 1;
  if (!state.session?.authenticated) return renderLogin();
  if (!state.snapshot) return refreshSnapshot(true);
  const route = currentRoute();
  if (!state.snapshot.initialized && route[0] !== 'setup') {
    location.hash = '#/setup';
    return;
  }
  renderShell();
  const outlet = document.querySelector<HTMLElement>('#view');
  if (!outlet) return;
  outlet.innerHTML = loadingView();
  try {
    if (route[0] === 'setup') renderSetup(outlet);
    else if (route[0] === 'new') renderCreate(outlet);
    else if (route[0] === 'computers' && route[1]) await renderComputer(outlet, route[1], route[2] ?? 'overview');
    else if (route[0] === 'backups') await renderBackups(outlet);
    else if (route[0] === 'updates') await renderUpdates(outlet);
    else if (route[0] === 'diagnostics') await renderDiagnostics(outlet);
    else if (route[0] === 'activity') await renderActivity(outlet);
    else if (route[0] === 'settings') await renderSettings(outlet);
    else renderFleet(outlet);
  } catch (error) {
    if (generation !== navigationGeneration) return;
    outlet.innerHTML = errorPanel(errorMessage(error));
  }
  if (generation !== navigationGeneration) return;
  finishRouteNavigation(outlet);
}

function finishRouteNavigation(outlet: HTMLElement): void {
  const snapshot = state.snapshot;
  if (snapshot?.migrationRequired) {
    outlet.insertAdjacentHTML('afterbegin', '<div id="global-state-notice" class="notice warning global-notice" role="alert"><strong>Migration required.</strong><span>Use the local Qubicl CLI to review the backed-up state migration.</span></div>');
  } else if (snapshot?.recoveryRequired) {
    outlet.insertAdjacentHTML('afterbegin', `<div id="global-state-notice" class="notice warning global-notice" role="alert"><span>Recovery is required before another host change can run.</span>${actionButton('recovery.resume', '', 'Review recovery', 'secondary-button')}</div>`);
  }
  applyRecoveryRestrictions(outlet);
  outlet.querySelector<HTMLElement>('.tabs a[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  const heading = outlet.querySelector<HTMLElement>('h1, h2');
  if (heading) {
    heading.classList.add('route-focus');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  } else {
    outlet.focus({ preventScroll: true });
  }
}

function applyRecoveryRestrictions(outlet: HTMLElement): void {
  if (!managementRestricted()) return;
  const reason = restrictionMessage();
  for (const button of outlet.querySelectorAll<HTMLButtonElement>('[data-plan-action]')) {
    const operation = button.dataset.planAction as ManagementOperation | undefined;
    if (operation && RECOVERY_SAFE_OPERATIONS.has(operation)) continue;
    button.disabled = true;
    button.title = reason;
  }
  for (const form of outlet.querySelectorAll<HTMLFormElement>('form[data-plan]')) {
    const operation = form.dataset.plan as ManagementOperation | undefined;
    if (operation && RECOVERY_SAFE_OPERATIONS.has(operation)) continue;
    form.setAttribute('aria-disabled', 'true');
    for (const button of form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) button.disabled = true;
  }
  for (const button of outlet.querySelectorAll<HTMLButtonElement>('[data-action="restore-backup"], [data-action="verify-encrypted-backup"], [data-action="restore-encrypted-backup"], [data-action="update-skill"]')) {
    button.disabled = true;
    button.title = reason;
  }
}

function managementRestricted(): boolean {
  return Boolean(state.snapshot?.recoveryRequired || state.snapshot?.migrationRequired);
}

function restrictionMessage(): string {
  return state.snapshot?.migrationRequired
    ? 'Complete the state migration with the local CLI before making host changes.'
    : 'Complete the pending recovery before making another host change.';
}

async function requestPlan(request: ManagementRequest): Promise<ManagementPlan> {
  if (managementRestricted() && !RECOVERY_SAFE_OPERATIONS.has(request.operation)) throw new Error(restrictionMessage());
  return api.plan(request);
}

function currentRoute(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

function renderShell(): void {
  const snapshot = state.snapshot!;
  root.innerHTML = `
    <a class="skip-link" href="#view">Skip to content</a>
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="#/fleet" aria-label="Qubicl fleet">
          <img src="/assets/qubicl-mark.svg" width="36" height="36" alt="">
          <span>Qubicl</span><small>${escapeHtml(snapshot.release)}</small>
        </a>
        <nav aria-label="Main navigation">
          ${navLink('fleet', 'Fleet', icon('grid'))}
          ${navLink('backups', 'Backups', icon('archive'))}
          ${navLink('updates', 'Updates', icon('arrow'))}
          ${navLink('diagnostics', 'Diagnostics', icon('pulse'))}
          ${navLink('activity', 'Activity', icon('list'))}
          ${navLink('settings', 'Settings', icon('sliders'))}
        </nav>
        <div id="status-rail">${statusRail(snapshot)}</div>
        <div class="sidebar-actions">
          <button class="icon-button" type="button" data-action="theme" aria-label="Change color theme">${icon('sun')}</button>
          <button class="quiet-button" type="button" data-action="logout">Sign out</button>
        </div>
      </aside>
      <main id="view" tabindex="-1"></main>
    </div>
    <div id="toast-region" class="toast-region" aria-live="polite"></div>
    <dialog id="plan-dialog" class="plan-dialog"></dialog>`;
}

function navLink(route: string, label: string, glyph: string): string {
  const active = (currentRoute()[0] ?? 'fleet') === route;
  return `<a href="#/${route}" ${active ? 'aria-current="page"' : ''}>${glyph}<span>${label}</span></a>`;
}

function statusRail(snapshot: ManagementSnapshot): string {
  const docker = snapshot.docker.available ? 'online' : 'offline';
  const freshness = snapshotStale ? 'Status stale' : snapshotUpdatedAt ? `Updated ${relativeTime(snapshotUpdatedAt)}` : 'Updating';
  return `<div class="status-rail"><span class="status-dot ${snapshotStale ? 'offline' : docker}"></span><span>Docker ${docker}</span><span class="rail-divider"></span><span>Gateway ${escapeHtml(snapshot.gateway.status)}</span><span class="rail-divider"></span><span>${escapeHtml(freshness)}</span></div>`;
}

function updateStatusRail(): void {
  const rail = document.querySelector<HTMLElement>('#status-rail');
  if (rail && state.snapshot) rail.innerHTML = statusRail(state.snapshot);
}

function renderFleet(outlet: HTMLElement): void {
  const snapshot = state.snapshot!;
  const running = snapshot.computers.filter((computer) => computer.status === 'running').length;
  const attention = snapshot.computers.filter((computer) => isAttention(computer)).length;
  outlet.innerHTML = `
    <header class="page-header split">
      <div><p class="eyebrow">Control plane</p><h1>Your computers</h1><p class="lede">A live view of durable homes and their disposable runtimes.</p></div>
      <a class="primary-button" href="#/new">${icon('plus')} New computer</a>
    </header>
    ${!snapshot.docker.available ? `<div class="notice warning"><strong>Docker is unavailable.</strong><span>${escapeHtml(snapshot.docker.message ?? 'Runtime observations are temporarily unknown. Durable configuration remains visible.')}</span></div>` : ''}
    <section class="metric-row" aria-label="Fleet summary">
      ${metric(`${snapshot.computers.length}`, 'Computers')}${metric(`${running}`, 'Running')}${metric(`${attention}`, 'Needs attention')}${metric(snapshot.gateway.status, 'Gateway')}
    </section>
    <section class="section-heading"><div><h2>Fleet</h2><p>${snapshot.computers.length ? 'Select a computer to inspect or change it.' : 'Create your first durable computer.'}</p></div>
      ${snapshot.computers.some((computer) => computer.status === 'running') ? actionButton('computers.stop', '', 'Stop all', 'secondary-button') : ''}
    </section>
    <div class="computer-grid">
      ${snapshot.computers.map(computerCard).join('') || emptyState('No computers yet', 'Each computer gets its own durable home, policy, and runtime.', '<a class="primary-button" href="#/new">Create a computer</a>')}
    </div>
    ${snapshot.trash.length ? `<section class="subsection"><div class="section-heading"><div><h2>Recoverable</h2><p>Deleted homes stay here until explicitly purged from the CLI.</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>ID</th><th></th></tr></thead><tbody>${snapshot.trash.map((entry) => `<tr><td><strong>${escapeHtml(entry.name)}</strong>${entry.diagnostic ? `<small>${escapeHtml(entry.diagnostic)}</small>` : ''}</td><td class="mono">${shortId(entry.id)}</td><td>${entry.status === 'available' ? actionButton('computer.restore', entry.id, 'Restore', 'text-button') : 'Needs local review'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
}

function computerCard(computer: ManagementComputer): string {
  const status = displayStatus(computer.status);
  return `<article class="computer-card">
    <div class="card-top"><span class="computer-mark">${escapeHtml(computer.name.slice(0, 1).toUpperCase())}</span>${statusPill(computer.status)}</div>
    <h3><a href="#/computers/${encodeURIComponent(computer.id)}">${escapeHtml(computer.name)}</a></h3>
    <p>${escapeHtml(computer.preset)} · ${escapeHtml(String(computer.cpus))} CPU · ${escapeHtml(computer.memory)}</p>
    <dl class="card-facts"><div><dt>Health</dt><dd>${escapeHtml(computer.health ?? (state.snapshot?.docker.available ? 'unknown' : 'unavailable'))}</dd></div><div><dt>Runtime</dt><dd>${escapeHtml(status)}</dd></div></dl>
    <div class="card-actions">${lifecycleButtons(computer)}<a class="text-button" href="#/computers/${encodeURIComponent(computer.id)}">Manage ${icon('chevron')}</a></div>
  </article>`;
}

function renderSetup(outlet: HTMLElement): void {
  if (state.snapshot?.migrationRequired || state.snapshot?.recoveryRequired) {
    outlet.innerHTML = `<div class="narrow-page"><header class="page-header"><p class="eyebrow">Existing installation</p><h1>Review recovery first</h1><p class="lede">Existing state needs attention before setup can proceed.</p></header><p>${state.snapshot.migrationRequired ? 'Use the local Qubicl CLI to approve the backed-up state migration. Older CLIs cannot write the migrated state.' : 'Resume the recorded operation from the recovery notice.'}</p><p>Refresh after completing the host operation.</p></div>`;
    return;
  }

  const presets = state.snapshot?.presets ?? [];
  outlet.innerHTML = `<div class="narrow-page"><header class="page-header"><p class="eyebrow">First run</p><h1>Set up Qubicl</h1><p class="lede">Choose a starting profile. Qubicl will present a complete plan before changing the host.</p></header>
    <form class="paper-form" data-plan="setup">
      <fieldset><legend>Starting profile</legend><div class="choice-grid">${presets.map((preset) => `<label class="choice-card"><input type="radio" name="preset" value="${escapeAttr(preset.id)}" ${preset.id === state.snapshot?.defaultPreset ? 'checked' : ''}><span><strong>${escapeHtml(titleCase(preset.id))}</strong><small>${escapeHtml(preset.purpose)}</small><small>${escapeHtml(String(preset.cpus))} CPU · ${escapeHtml(preset.memory)}</small></span></label>`).join('')}</div></fieldset>
      <div class="field-row"><label>CPU limit <input name="cpus" inputmode="decimal" placeholder="Use preset"></label><label>Memory limit <input name="memory" placeholder="Use preset, e.g. 4g"></label></div>
      <label>Local gateway port <input name="gatewayPort" type="number" min="1024" max="65535" placeholder="3211"></label>
      <label>First computer name <input name="createName" autocomplete="off" placeholder="Optional"></label>
      <button class="primary-button" type="submit">Review setup plan</button>
    </form></div>`;
}

function renderCreate(outlet: HTMLElement): void {
  const presets = state.snapshot?.presets ?? [];
  outlet.innerHTML = `<div class="narrow-page"><a class="back-link" href="#/fleet">${icon('arrow-left')} Fleet</a><header class="page-header"><p class="eyebrow">New computer</p><h1>Create a durable workspace</h1><p class="lede">The image and runtime can be replaced later. The home persists.</p></header>
    <form class="paper-form" data-plan="computer.create">
      <label>Computer name <input name="name" required minlength="1" maxlength="63" autocomplete="off" placeholder="research"></label>
      <fieldset><legend>Preset</legend><div class="choice-grid">${presets.map((preset) => `<label class="choice-card"><input type="radio" name="preset" value="${escapeAttr(preset.id)}" ${preset.id === state.snapshot?.defaultPreset ? 'checked' : ''}><span><strong>${escapeHtml(titleCase(preset.id))}</strong><small>${escapeHtml(preset.purpose)}</small><small>${escapeHtml(preset.description)}</small></span></label>`).join('')}</div></fieldset>
      <div class="field-row"><label>CPU limit <input name="cpus" inputmode="decimal" placeholder="Use preset"></label><label>Memory limit <input name="memory" placeholder="Use preset"></label></div>
      <button class="primary-button" type="submit">Review create plan</button>
    </form></div>`;
}

async function renderComputer(outlet: HTMLElement, id: string, section: string): Promise<void> {
  const computer = await api.computer(id);
  outlet.innerHTML = `<a class="back-link" href="#/fleet">${icon('arrow-left')} Fleet</a>
    <header class="computer-header"><div class="computer-title"><span class="computer-mark large">${escapeHtml(computer.name.slice(0, 1).toUpperCase())}</span><div><div class="title-line"><h1>${escapeHtml(computer.name)}</h1>${statusPill(computer.status)}</div><p>${escapeHtml(computer.preset)} · <span class="mono">${shortId(computer.id)}</span></p></div></div><div class="header-actions">${viewerButton(computer)}${lifecycleButtons(computer)}</div></header>
    <nav class="tabs" aria-label="Computer sections">${['overview', 'processes', 'previews', 'tools', 'skills', 'network', 'access'].map((name) => `<a href="#/computers/${encodeURIComponent(id)}/${name}" ${section === name ? 'aria-current="page"' : ''}>${titleCase(name)}</a>`).join('')}</nav>
    <div id="computer-section">${loadingView()}</div>`;
  const sectionRoot = document.querySelector<HTMLElement>('#computer-section');
  if (!sectionRoot) return;
  if (section === 'processes') await renderProcesses(sectionRoot, computer);
  else if (section === 'previews') await renderPreviews(sectionRoot, computer);
  else if (section === 'tools') await renderTools(sectionRoot, computer);
  else if (section === 'skills') await renderSkills(sectionRoot, computer);
  else if (section === 'network') renderNetwork(sectionRoot, computer);
  else if (section === 'access') await renderAccess(sectionRoot, computer);
  else renderOverview(sectionRoot, computer);
}

function renderOverview(outlet: HTMLElement, computer: ManagementComputer): void {
  const controller = record(computer.controller);
  const actor = record(controller.actor);
  const controllerKind = stringValue(controller.kind, 'none');
  const controllerDetail = controllerKind === 'none'
    ? 'None'
    : `${titleCase(controllerKind)} · generation ${metricValue(controller.generation)}${actor.untrustedLabel ? ` · Source provided: ${stringValue(actor.untrustedLabel)}` : ''}${actor.protocol ? ` · ${stringValue(actor.protocol)}` : ''}`;
  const resources = record(computer.resources);
  const browser = record(computer.browser);
  const browserPanel = Object.keys(browser).length ? `<section class="panel subsection"><div class="section-heading"><div><h2>Browser security and compatibility</h2><p>The effective runtime posture. Recent diagnostics are sanitized; inspect them with <span class="mono">browser_diagnostics</span>.</p></div></div>${objectDetails({
    state: browser.state,
    engineVersion: browser.engineVersion ?? 'Available after browser start',
    sandbox: browser.sandbox,
    profile: browser.profile,
    extensions: browser.extensions,
    passwordStore: browser.passwordStore,
    publicExtraction: browser.publicExtraction,
    agentTabLimit: record(browser.tabPolicy).agentOpenLimit,
    automaticTabEviction: record(browser.tabPolicy).automaticEviction,
    recentDiagnosticCount: browser.recentDiagnosticCount,
    lastDiagnostic: record(browser.lastDiagnostic).detail,
  })}</section>` : '';
  outlet.innerHTML = `<section class="detail-grid"><div class="panel"><div class="section-heading"><div><h2>Runtime</h2><p>Durable intent and the latest host observation.</p></div><small data-detail-freshness>Updated ${relativeTime(Date.now())}</small></div>
      <dl class="detail-list"><div><dt>Status</dt><dd>${escapeHtml(displayStatus(computer.status))}</dd></div><div><dt>Health</dt><dd>${escapeHtml(computer.health ?? 'unknown')}</dd></div><div><dt>Controller</dt><dd>${escapeHtml(controllerDetail)}</dd></div>${controller.expiresAt ? `<div><dt>Lease expires</dt><dd>${formatTime(controller.expiresAt)}</dd></div>` : ''}<div><dt>Managed processes</dt><dd>${escapeHtml(metricValue(resources.managedProcesses ?? 0))}</dd></div><div><dt>Active previews</dt><dd>${escapeHtml(metricValue(resources.activePreviews ?? 0))}</dd></div><div><dt>Image</dt><dd class="mono wrap">${escapeHtml(computer.image.resolved || computer.image.requested)}</dd></div></dl>
      ${controllerKind === 'human' ? actionButton('control.release', computer.id, 'Release human control', 'secondary-button') : ''}
    </div><div class="panel"><div class="section-heading"><div><h2>Resources</h2><p>Changing limits recreates the disposable runtime.</p></div></div>
      <form data-plan="computer.resources" data-target="${escapeAttr(computer.id)}"><div class="field-row"><label>CPUs <input name="cpus" required inputmode="decimal" value="${escapeAttr(String(computer.cpus))}"></label><label>Memory <input name="memory" required value="${escapeAttr(computer.memory)}"></label></div><button class="secondary-button" type="submit">Review resource change</button></form>
    </div></section>${browserPanel}
    <section class="panel subsection"><div class="section-heading"><div><h2>Identity</h2><p>The computer ID and home remain stable through a rename.</p></div></div><form data-plan="computer.rename" data-target="${escapeAttr(computer.id)}" class="inline-form"><label><span class="sr-only">New name</span><input name="name" required value="${escapeAttr(computer.name)}"></label><button class="secondary-button" type="submit">Review rename</button></form><hr><div class="section-heading"><div><h3>Clone durable home</h3><p>Create a verified checkpoint and restore it as a new, stopped computer.</p></div></div><form data-plan="computer.clone" data-target="${escapeAttr(computer.id)}" class="inline-form"><label><span class="sr-only">Clone name</span><input name="name" required placeholder="clone-name" autocomplete="off"></label><button class="secondary-button" type="submit">Review clone</button></form></section>
    <section class="panel danger-zone"><div><h2>Delete computer</h2><p>Moves the durable home to recoverable trash and invalidates access.</p></div>${actionButton('computer.delete', computer.id, 'Review delete', 'danger-button')}</section>`;
}

async function renderProcesses(outlet: HTMLElement, computer: ManagementComputer): Promise<void> {
  const { items } = await api.processes(computer.id);
  outlet.innerHTML = `<div class="section-heading"><div><h2>Processes</h2><p>Bounded metadata for retained commands. Process input and output are not shown here.</p><small data-detail-freshness>Updated ${relativeTime(Date.now())}</small></div><span class="count-badge">${items.length}</span></div>
    ${items.length ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Started</th><th>Owner</th><th></th></tr></thead><tbody>${items.map((item) => `<tr><td><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(titleCase(item.lifecycle))} · <span class="mono">${escapeHtml(shortId(item.id))}</span></small></td><td>${statusPill(item.status)}${item.finishedAt ? `<small>Finished ${formatTime(item.finishedAt)}</small>` : ''}</td><td>${formatTime(item.startedAt)}</td><td>${escapeHtml(`${titleCase(item.owner)} · generation ${item.ownerGeneration}`)}</td><td>${isTerminalStatus(item.status) ? '' : actionButton('process.stop', computer.id, 'Stop', 'text-button', { processId: item.id })}</td></tr>`).join('')}</tbody></table></div>` : emptyState('No retained processes', 'Processes started by connected agents will appear here.')}`;
}

async function renderPreviews(outlet: HTMLElement, computer: ManagementComputer): Promise<void> {
  const { items } = await api.previews(computer.id);
  outlet.innerHTML = `<div class="section-heading"><div><h2>Previews</h2><p>Local owner access follows the app. Remote shares are separate and expire.</p><small data-detail-freshness>Updated ${relativeTime(Date.now())}</small></div><span class="count-badge">${items.length}</span></div>
    ${items.length ? `<div class="card-list">${items.map((item) => `<article class="row-card"><div><strong>${escapeHtml(item.kind === 'port' && item.port ? `Port ${item.port}` : 'File preview')}</strong><p>${escapeHtml(titleCase(item.status))} · ${item.lifetime === 'while-listening' ? 'follows listening app' : `expires ${formatTime(item.expiresAt!)}`}${item.shareExpiresAt ? ` · shared until ${formatTime(item.shareExpiresAt)}` : ''}</p><small class="mono">${escapeHtml(shortId(item.id))}</small></div><div class="row-actions"><button class="secondary-button" type="button" data-action="preview-open" data-computer="${escapeAttr(computer.id)}" data-target="${escapeAttr(item.id)}">Open</button>${item.kind === 'port' ? item.shareExpiresAt ? actionButton('preview.unshare', computer.id, 'Revoke share', 'text-button', { previewId: item.id }) : `<form class="inline-form" data-plan="preview.share" data-target="${escapeAttr(computer.id)}"><input type="hidden" name="previewId" value="${escapeAttr(item.id)}"><label><span class="sr-only">Share duration</span><select name="duration" aria-label="Share duration"><option value="900">15 minutes</option><option value="3600" selected>1 hour</option><option value="14400">4 hours</option><option value="86400">24 hours</option></select></label><button class="text-button" type="submit">Review share</button></form>` : ''}${actionButton('preview.revoke', computer.id, 'Revoke publication', 'text-button', { previewId: item.id })}</div></article>`).join('')}</div>` : emptyState('No active previews', 'Agents can publish local app previews that follow the listening process.')}`;
}

async function renderTools(outlet: HTMLElement, computer: ManagementComputer): Promise<void> {
  const { items } = await api.tools(computer.id);
  outlet.innerHTML = `<form data-plan="tools.set" data-target="${escapeAttr(computer.id)}" data-collection="ids"><div class="section-heading"><div><h2>Tool policy</h2><p>Changes revoke an active agent lease so new policy takes effect immediately.</p></div><button class="primary-button" type="submit">Review tool changes</button></div><div class="toggle-list">${items.map(toolToggle).join('')}</div></form>`;
}

function toolToggle(tool: ToolItem): string {
  return `<label class="toggle-row ${tool.locked ? 'locked' : ''}"><span><strong>${escapeHtml(titleCase(tool.id.replaceAll('_', ' ')))}</strong><small class="mono">${escapeHtml(tool.id)}</small></span>${tool.locked && tool.enabled ? `<input type="hidden" name="ids" value="${escapeAttr(tool.id)}">` : ''}<input type="checkbox" name="ids" value="${escapeAttr(tool.id)}" ${tool.enabled ? 'checked' : ''} ${tool.locked ? 'disabled' : ''}><span class="switch" aria-hidden="true"></span>${tool.locked ? '<em>Required</em>' : ''}</label>`;
}

async function renderSkills(outlet: HTMLElement, computer: ManagementComputer): Promise<void> {
  const { items } = await api.skills(computer.id);
  outlet.innerHTML = `<form data-plan="skills.set" data-target="${escapeAttr(computer.id)}" data-collection="ids"><div class="section-heading"><div><h2>Skills</h2><p>Enable reviewed instruction packages for connected agents.</p></div><button class="primary-button" type="submit">Review skill changes</button></div><div class="toggle-list">${items.map((skill) => skillToggle(skill, computer.id)).join('')}</div></form>
    <section class="panel subsection"><div class="section-heading"><div><h2>Import exact Git revision</h2><p>HTTPS only. Qubicl never runs repository hooks or installers.</p></div></div><form data-plan="skill.import" data-target="${escapeAttr(computer.id)}"><label>Repository URL <input type="url" name="url" required pattern="https://.*" placeholder="https://github.com/org/repo.git"></label><label>Full commit SHA <input name="commit" required pattern="[a-f0-9]{40}" minlength="40" maxlength="40" class="mono"></label><button class="secondary-button" type="submit">Review import</button></form></section>
    <section class="panel subsection"><div class="section-heading"><div><h2>Restore removed skill</h2><p>Enter the exact approved skill ID from recoverable skill trash.</p></div></div><form data-plan="skill.restore" data-target="${escapeAttr(computer.id)}" class="inline-form"><label><span class="sr-only">Skill ID</span><input name="id" required placeholder="skill-id" autocomplete="off"></label><button class="secondary-button" type="submit">Review restore</button></form></section>`;
}

function skillToggle(skill: SkillItem, computerId: string): string {
  const source = skill.kind ?? skill.origin ?? 'installed';
  const drift = skill.drift ?? (skill.drifted ? 'modified' : 'unchanged');
  return `<div class="skill-row"><label class="toggle-row"><span><strong>${escapeHtml(skill.name)}</strong><small>${escapeHtml(source)} · ${escapeHtml(drift)}${skill.description ? ` · ${escapeHtml(skill.description)}` : ''}</small></span><input type="checkbox" name="ids" value="${escapeAttr(skill.id)}" ${skill.enabled ? 'checked' : ''}><span class="switch" aria-hidden="true"></span></label><div class="skill-actions"><button class="text-button" type="button" data-action="update-skill" data-target="${escapeAttr(computerId)}" data-skill="${escapeAttr(skill.id)}" data-name="${escapeAttr(skill.name)}">Update</button>${skill.resetAvailable ? actionButton('skill.reset', computerId, 'Reset', 'text-button', { id: skill.id }) : ''}${actionButton('skill.remove', computerId, 'Remove', 'text-button', { id: skill.id })}</div></div>`;
}

function renderNetwork(outlet: HTMLElement, computer: ManagementComputer): void {
  const network = record(computer.network);
  const selected = stringValue(network.profile ?? network.mode, 'web-only');
  const approvals = Array.isArray(network.temporaryApprovals) ? network.temporaryApprovals.map(record) : [];
  outlet.innerHTML = `<div class="section-heading"><div><h2>Network policy</h2><p>Policy is enforced at the computer boundary. Changes may recreate the runtime.</p></div></div>
    <form class="paper-form" data-plan="network.set" data-target="${escapeAttr(computer.id)}"><fieldset><legend>Connection profile</legend><div class="choice-grid compact">${['offline', 'web-only', 'developer', 'custom'].map((profile) => `<label class="choice-card"><input type="radio" name="profile" value="${profile}" ${selected === profile ? 'checked' : ''}><span><strong>${titleCase(profile)}</strong><small>${networkDescription(profile)}</small></span></label>`).join('')}</div></fieldset><label>Allowed domains <textarea name="allowDomains" rows="3" placeholder="One domain per line">${escapeHtml(stringList(network.allowDomains).join('\n'))}</textarea></label><label>Denied domains <textarea name="denyDomains" rows="3" placeholder="One domain per line">${escapeHtml(stringList(network.denyDomains).join('\n'))}</textarea></label><button class="primary-button" type="submit">Review network change</button></form>
    <section class="panel subsection"><div class="section-heading"><div><h2>Temporary approval</h2><p>Allow one domain for a bounded period.</p></div></div><form class="inline-form wrap-fields" data-plan="network.approve" data-target="${escapeAttr(computer.id)}"><label>Domain <input name="domain" required placeholder="api.example.com"></label><label>Duration <select name="duration"><option value="900">15 minutes</option><option value="3600">1 hour</option><option value="14400">4 hours</option></select></label><button class="secondary-button" type="submit">Review approval</button></form>${approvals.length ? `<div class="approval-list">${approvals.map((approval) => `<div><span><strong>${escapeHtml(stringValue(approval.domain, 'Approved domain'))}</strong><small>${approval.expiresAt ? `Expires ${formatTime(approval.expiresAt)}` : 'Temporary'}</small></span>${actionButton('network.revoke', computer.id, 'Revoke', 'text-button', { domain: stringValue(approval.domain) })}</div>`).join('')}</div>` : ''}</section>`;
}

async function renderAccess(outlet: HTMLElement, computer: ManagementComputer): Promise<void> {
  const [credentials, clients] = await Promise.all([
    api.credentials(computer.id).then(({ items }) => items).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }),
    api.clients(computer.id).then(({ items }) => items),
  ]);
  outlet.innerHTML = `<div class="section-heading"><div><h2>Access and credentials</h2><p>Each connected client can have its own identity, scopes, and revocation boundary.</p></div></div>
    <section class="panel"><div class="section-heading"><div><h3>Client connections</h3><p>Scope names describe what the bearer can ask this computer to do. Operator authority remains separate.</p></div><span class="count-badge">${clients.length}</span></div>
      <div class="card-list">${clients.map((client) => `<article class="row-card"><div><strong>${escapeHtml(client.label)}</strong><p>${escapeHtml(client.scopes.join(', '))}</p><small><span class="mono">${escapeHtml(client.id)}</span> · ${client.lastUsedAt ? `last used ${formatTime(client.lastUsedAt)}` : 'never used'}</small></div><div class="row-actions">${client.id === 'default' ? actionButton('token.rotate', computer.id, 'Rotate default', 'text-button') : `${actionButton('client.rotate', computer.id, 'Rotate', 'text-button', { id: client.id })}${actionButton('client.revoke', computer.id, 'Revoke', 'text-button', { id: client.id })}`}</div></article>`).join('')}</div>
      <form class="subsection" data-plan="client.create" data-target="${escapeAttr(computer.id)}"><div class="field-row"><label>Client ID <input name="id" required pattern="[a-z0-9][a-z0-9-]{0,62}" autocomplete="off" placeholder="coding-agent"></label><label>Display label <input name="label" required maxlength="120" autocomplete="off" placeholder="Coding agent"></label></div><fieldset><legend>Allowed scopes</legend><div class="scope-grid">${['observe', 'files', 'tasks', 'interactive', 'publish'].map((scope) => `<label><input type="checkbox" name="scopes" value="${scope}" checked> ${titleCase(scope)}</label>`).join('')}</div></fieldset><button class="primary-button" type="submit">Review new client</button></form>
      <div class="subsection"><h4>Connection guide</h4><p>Generate a client-specific HTTP or OpenAPI snippet on the host:</p><code class="command-example">qubicl connect ${escapeHtml(computer.name)} --client generic --transport http --credential &lt;client-id&gt;</code></div>
    </section>
    <section class="panel subsection"><div class="section-heading"><div><h3>Brokered API credentials</h3><p>Secret values are write-only. They never return to this browser.</p></div></div>
    ${credentials.length ? `<div class="credential-list">${credentials.map((credential) => `<article class="row-card"><div><strong>${escapeHtml(stringValue(credential.id, 'Credential'))}</strong><p>${escapeHtml(stringValue(credential.header, 'Header'))} · ${escapeHtml(stringList(credential.methods).join(', '))}</p><small>${escapeHtml(stringValue(credential.baseUrl))}${escapeHtml(stringValue(credential.pathPrefix, '/'))}</small></div>${actionButton('credential.remove', computer.id, 'Review removal', 'text-button', { id: stringValue(credential.id) })}</article>`).join('')}</div>` : '<p class="muted">No scoped credentials are configured.</p>'}
    <div class="subsection"><div class="section-heading"><div><h3>Add or replace scoped credential</h3><p>Scope every header to an HTTPS origin, path, and explicit methods.</p></div></div><form data-plan="credential.add" data-target="${escapeAttr(computer.id)}" data-sensitive="value"><label>Action <select name="_operation"><option value="credential.add">Add a new credential</option><option value="credential.replace">Replace an existing credential</option></select></label><div class="field-row"><label>Credential ID <input name="id" required autocomplete="off"></label><label>Header <input name="header" value="Authorization" required autocomplete="off"></label></div><label>HTTPS base URL <input type="url" name="baseUrl" required pattern="https://.*" placeholder="https://api.example.com"></label><div class="field-row"><label>Path prefix <input name="pathPrefix" value="/" required></label><label>Methods <select name="methods" multiple size="5"><option selected>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></label></div><label>Secret value <input type="password" name="value" required autocomplete="new-password" spellcheck="false"></label><button class="primary-button" type="submit">Review credential</button></form></div>
    <section class="panel subsection"><div class="section-heading"><div><h3>Remove credential</h3><p>Enter the exact credential ID. The stored value stays hidden.</p></div></div><form data-plan="credential.remove" data-target="${escapeAttr(computer.id)}" class="inline-form"><label><span class="sr-only">Credential ID</span><input name="id" required placeholder="credential-id" autocomplete="off"></label><button class="secondary-button" type="submit">Review removal</button></form></section>
    </section>`;
}

async function renderBackups(outlet: HTMLElement): Promise<void> {
  const { items } = await api.backups();
  const computers = state.snapshot?.computers ?? [];
  outlet.innerHTML = `<header class="page-header"><p class="eyebrow">Durable homes</p><h1>Backups</h1><p class="lede">Manual, checksummed copies of computer homes. Complete disaster recovery also requires a private copy of Qubicl's state root.</p></header>
    <section class="panel"><div class="section-heading"><div><h2>Create home backup</h2><p>Quiesced pauses a running computer briefly. Stopped requires it to already be stopped.</p></div></div><form data-plan="backup.create" data-sensitive="passphrase"><div class="field-row"><label>Computer <select name="_target" required>${computerOptions(computers)}</select></label><label>Consistency <select name="consistency"><option value="quiesced">Quiesced</option><option value="stopped">Already stopped</option></select></label></div><label class="confirmation"><input type="checkbox" name="encrypted" value="true"> <span>Encrypt this backup with a passphrase</span></label><label>Backup passphrase <input type="password" name="passphrase" minlength="12" maxlength="16384" autocomplete="new-password" spellcheck="false"><small>Required when encryption is selected. It is kept only in memory for this operation; losing it makes the backup unrecoverable.</small></label><button class="primary-button" type="submit">Review backup</button></form></section>
    <section class="panel subsection"><div class="section-heading"><div><h2>Create restore checkpoint</h2><p>Capture a verified home checkpoint for recovery work without creating an encrypted export.</p></div></div><form data-plan="checkpoint.create"><div class="field-row"><label>Computer <select name="_target" required>${computerOptions(computers)}</select></label><label>Consistency <select name="consistency"><option value="quiesced">Quiesced</option><option value="stopped">Already stopped</option></select></label></div><button class="secondary-button" type="submit">Review checkpoint</button></form></section>
    <div class="section-heading subsection"><div><h2>Available backups</h2><p>Restore always creates a new computer name.</p></div><span class="count-badge">${items.length}</span></div>
    ${items.length ? `<div class="card-list">${items.map(backupCard).join('')}</div>` : emptyState('No backups yet', 'Create a manual home backup before a risky workload change.')}
    <section class="panel subsection"><div class="section-heading"><div><h2>Retention</h2><p>Keep the newest manual backups for one computer.</p></div></div><form class="inline-form wrap-fields" data-plan="backup.prune"><label>Computer <select name="_target" required>${computerOptions(computers)}</select></label><label>Keep newest <input type="number" name="keep" value="3" min="1" max="100" required></label><button class="secondary-button" type="submit">Review pruning</button></form></section>`;
}

function backupCard(backup: BackupItem): string {
  if (backup.status === 'quarantined') return `<article class="row-card"><div><strong>${escapeHtml(backup.name)}</strong><p>Needs local review</p><small>${escapeHtml(backup.diagnostic ?? 'The metadata is not safe to use.')}</small><small class="mono">${escapeHtml(shortId(backup.id))}</small></div></article>`;
  const actions = backup.encrypted
    ? `<button class="text-button" type="button" data-action="verify-encrypted-backup" data-target="${escapeAttr(backup.id)}">Verify</button><button class="secondary-button" type="button" data-action="restore-encrypted-backup" data-target="${escapeAttr(backup.id)}" data-name="${escapeAttr(backup.name)}">Restore</button>`
    : `${actionButton('backup.verify', backup.id, 'Verify', 'text-button')}<button class="secondary-button" type="button" data-action="restore-backup" data-target="${escapeAttr(backup.id)}" data-name="${escapeAttr(backup.name)}">Restore</button>`;
  return `<article class="row-card"><div><strong>${escapeHtml(backup.name)}</strong><p>${formatTime(backup.createdAt!)} · ${escapeHtml(backup.consistency!)}${backup.encrypted ? ' · encrypted' : ''}</p><small class="mono">${shortId(backup.id)}</small></div><div class="row-actions">${actions}</div></article>`;
}

async function renderUpdates(outlet: HTMLElement): Promise<void> {
  const report = await api.updates();
  const dashboard = report.dashboard ? dashboardUpdateCard(report.dashboard) : '';
  outlet.innerHTML = `<header class="page-header split"><div><p class="eyebrow">Bundled catalog</p><h1>Updates</h1><p class="lede">Only exact images shipped in this Qubicl release are offered. The dashboard does not check the internet for versions.</p></div>${report.recoveryRequired ? '' : actionButton('upgrade.all', '', 'Review gateway & computers', 'primary-button')}</header>
    ${report.recoveryRequired ? `<div class="notice warning"><span>${escapeHtml(report.recoveryDetail ?? 'A pending operation must be recovered before images can be updated.')}</span>${actionButton('recovery.resume', '', 'Review recovery', 'secondary-button')}</div>` : ''}
    ${dashboard || report.rows.length ? `<div class="card-list">${dashboard}${report.rows.map((row) => updateCard(row, !report.recoveryRequired)).join('')}</div>` : emptyState('No catalog status', 'The service did not return any image entries.')}`;
}

function dashboardUpdateCard(row: { configured: boolean; currentImage: unknown; targetImage: unknown; updateAvailable: boolean }): string {
  const current = row.configured ? imageLabel(row.currentImage, 'Unknown configured image') : 'Not configured';
  const target = imageLabel(row.targetImage, 'No bundled target');
  const action = row.configured && row.updateAvailable
    ? actionButton('dashboard.restart', '', 'Review dashboard update', 'secondary-button')
    : '';
  const status = !row.configured ? 'Not configured' : row.updateAvailable ? 'Update available' : 'Current';
  return `<article class="row-card"><div><strong>Management dashboard</strong><p><span class="mono wrap">${escapeHtml(current)}</span> ${icon('arrow')} <span class="mono wrap">${escapeHtml(target)}</span></p><small>Dashboard · ${escapeHtml(status)}</small></div>${action}</article>`;
}

function updateCard(row: Record<string, unknown>, actionsEnabled: boolean): string {
  const kind = stringValue(row.kind, 'computer');
  const key = stringValue(row.key);
  const id = stringValue(row.id ?? row.computerId) || (kind === 'computer' && key.startsWith('computer:') ? key.slice('computer:'.length) : '');
  const current = imageLabel(row.currentImage ?? row.current ?? row.from, 'current');
  const target = imageLabel(row.targetImage ?? row.exactTarget ?? row.available ?? row.to, 'No automatic target');
  const action = stringValue(row.action) || (row.updateAvailable === true ? 'upgrade' : row.updateAvailable === false ? 'current' : row.automatic === false ? 'manual-custom-image' : 'unknown');
  const canUpgrade = kind === 'computer' && row.updateAvailable === true;
  return `<article class="row-card"><div><strong>${escapeHtml(stringValue(row.name, 'Catalog entry'))}</strong><p><span class="mono">${escapeHtml(current)}</span> ${icon('arrow')} <span class="mono">${escapeHtml(target)}</span></p><small>${escapeHtml(titleCase(kind))} · ${escapeHtml(displayStatus(action))}</small></div>${actionsEnabled && canUpgrade && id ? actionButton('computer.upgrade', id, 'Review update', 'secondary-button') : ''}</article>`;
}

async function renderDiagnostics(outlet: HTMLElement): Promise<void> {
  const report = await api.diagnostics();
  outlet.innerHTML = `<header class="page-header"><p class="eyebrow">On demand</p><h1>Diagnostics</h1><p class="lede">A redacted view of protected host-state checks.</p></header>
    ${report.message ? `<div class="notice"><span>${escapeHtml(report.message)}</span></div>` : ''}
    <div class="check-list">${report.checks.map((check) => { const status = stringValue(check.status) || (check.ok === true ? 'pass' : check.ok === false ? 'fail' : 'unknown'); return `<article class="check-row"><span class="check-icon ${escapeAttr(status)}">${status === 'pass' || status === 'ok' ? '✓' : status === 'warn' || status === 'warning' ? '!' : '×'}</span><div><strong>${escapeHtml(stringValue(check.name ?? check.id ?? check.check, 'Diagnostic check'))}</strong><p>${escapeHtml(stringValue(check.message ?? check.detail, 'No detail reported.'))}</p></div><span>${escapeHtml(status)}</span></article>`; }).join('') || emptyState('No diagnostic report', 'The service did not return any checks.')}</div>`;
}

async function renderActivity(outlet: HTMLElement): Promise<void> {
  const { items } = await api.activityLog();
  outlet.innerHTML = `<header class="page-header"><p class="eyebrow">Durable operations</p><h1>Activity</h1><p class="lede">Accepted work continues if this browser disconnects.</p></header>${jobList(items)}`;
}

async function renderSettings(outlet: HTMLElement): Promise<void> {
  const [settings, sessionResponse] = await Promise.all([api.settings(), api.sessions()]);
  const remote = record(settings.remote);
  const adminDetails = { ...record(settings.service), remoteAdministration: remote.administration, certificateExpiresAt: remote.certificateExpiresAt };
  const currentTheme = localStorage.getItem('qubicl-theme') ?? 'system';
  const gatewayStatus = state.snapshot?.gateway.status ?? 'unknown';
  const gatewayAction = gatewayStatus === 'running'
    ? actionButton('gateway.restart', '', 'Review gateway restart', 'secondary-button')
    : actionButton('gateway.start', '', 'Review gateway start', 'secondary-button');
  outlet.innerHTML = `<header class="page-header"><p class="eyebrow">Owner controls</p><h1>Settings</h1><p class="lede">Local service and explicit private-network administration.</p></header>
    <div class="detail-grid"><section class="panel"><h2>Admin service</h2>${objectDetails(adminDetails)}<div class="panel-actions">${actionButton('dashboard.restart', '', 'Review restart', 'secondary-button')}${actionButton('dashboard.revoke', '', 'Revoke remote administration', 'danger-button')}</div></section><section class="panel"><h2>Agent gateway</h2>${objectDetails({ status: gatewayStatus, remoteAccess: remote.gateway })}<p class="fine-print">Certificate and key paths can only be changed with the local CLI.</p><div class="panel-actions">${gatewayAction}${actionButton('gateway.revoke', '', 'Revoke remote agent/viewer access', 'secondary-button')}</div></section></div>
    <section class="panel subsection mobile-owner-actions"><div><h2>Appearance and session</h2><p>Current theme: <span id="current-theme">${escapeHtml(titleCase(currentTheme))}</span>.</p></div><div class="panel-actions"><button class="secondary-button" type="button" data-action="theme">Change theme</button><button class="quiet-button" type="button" data-action="logout">Sign out</button></div></section>
    <section class="panel subsection"><div class="section-heading"><div><h2>Sessions on this administrator origin</h2><p>Other local or remote listeners keep separate browser sessions.</p></div><span class="count-badge">${sessionResponse.sessions.length}</span></div>${sessionList(sessionResponse.sessions)}</section>`;
}

function renderPlanDialog(plan: ManagementPlan): void {
  state.plan = plan;
  if (state.execution?.planId !== plan.id) state.execution = { planId: plan.id, idempotencyKey: crypto.randomUUID(), uncertain: false };
  const dialog = document.querySelector<HTMLDialogElement>('#plan-dialog');
  if (!dialog) return;
  dialog.setAttribute('aria-labelledby', 'plan-dialog-title');
  dialog.innerHTML = `<form method="dialog" class="dialog-card"><div class="dialog-top"><div><p class="eyebrow">Review plan</p><h2 id="plan-dialog-title">${escapeHtml(operationTitle(plan.operation))}</h2></div><button class="icon-button" type="button" data-action="dismiss-dialog" aria-label="Close plan">${icon('close')}</button></div>
    <p class="expires">Plan expires ${formatTime(plan.expiresAt)}</p>
    ${plan.effects.length ? planList('Will change', plan.effects, 'effect') : ''}${plan.preserved.length ? planList('Will preserve', plan.preserved, 'preserve') : ''}${plan.warnings.length ? planList('Review carefully', plan.warnings, 'warning') : ''}
    ${plan.requiresInterruption ? `<label class="confirmation"><input type="checkbox" id="confirm-interruption"> <span>I understand this interrupts the running computer or service.</span></label>` : ''}
    ${plan.requiresReauthentication ? `<label>Admin password <input id="reauth-password" type="password" required autocomplete="current-password" spellcheck="false"><small>Required again for this sensitive action. It is not stored.</small></label>` : ''}
    <div class="dialog-actions"><button class="quiet-button" type="button" data-action="dismiss-dialog">Cancel</button><button class="primary-button" type="button" data-action="execute-plan">Execute plan</button></div></form>`;
  dialog.addEventListener('close', () => {
    if (state.plan?.id === plan.id && !state.activeJob) void api.cancelPlan(plan.id).catch(() => undefined);
    state.plan = undefined;
    if (state.execution?.planId === plan.id) state.execution = undefined;
    if (state.pendingClientSecret?.planId === plan.id && !state.activeJob) state.pendingClientSecret = undefined;
    dialog.innerHTML = '';
  }, { once: true });
  if (!dialog.open) dialog.showModal();
}

function renderJobDialog(job: ManagementJob): void {
  const alreadyWatching = state.activeJob?.id === job.id;
  state.activeJob = job;
  const dialog = document.querySelector<HTMLDialogElement>('#plan-dialog');
  if (!dialog) return;
  const finished = job.status !== 'running';
  dialog.setAttribute('aria-labelledby', 'plan-dialog-title');
  const outcomeLabel = job.status === 'succeeded' ? 'Succeeded' : job.status === 'failed' ? 'Failed' : job.status === 'recovery-required' ? 'Recovery required' : job.status === 'outcome-unknown' ? 'Outcome unknown' : 'Working';
  const pendingClientSecret = state.pendingClientSecret;
  let clientSecret = '';
  if (job.status === 'succeeded' && pendingClientSecret && pendingClientSecret.planId === state.execution?.planId) {
    clientSecret = `<section class="one-time-secret"><h3>Client token for ${escapeHtml(pendingClientSecret.clientId)}</h3><p>Copy it now. Qubicl keeps it in the protected host state, but this dashboard will clear its copy when you close the result.</p><code id="client-token-value">${escapeHtml(pendingClientSecret.token)}</code><button class="secondary-button" type="button" data-action="copy-client-token">Copy token</button></section>`;
  }
  dialog.innerHTML = `<div class="dialog-card job-dialog"><div class="job-orbit ${finished ? job.status : ''}" aria-hidden="true"></div><p class="eyebrow">${outcomeLabel}</p><h2 id="plan-dialog-title">${escapeHtml(operationTitle(job.operation))}</h2><p role="status" aria-live="polite">${escapeHtml(job.message)}</p><div class="job-status">${statusPill(job.status)}<span>Updated ${formatTime(job.updatedAt)}</span></div>${clientSecret}${finished ? '<button class="primary-button" type="button" data-action="close-job">Done</button>' : '<p class="fine-print">You can close this page. Accepted work continues on the host.</p>'}</div>`;
  if (!dialog.open) dialog.showModal();
  if (job.status === 'running') {
    if (!alreadyWatching) watchJob(job.id);
  } else {
    eventStream?.close();
    eventStream = undefined;
  }
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (!form.reportValidity() || state.busy) return;
  const selectedOperation = new FormData(form).get('_operation');
  const operation = (typeof selectedOperation === 'string' && selectedOperation ? selectedOperation : form.dataset.plan) as ManagementOperation | undefined;
  if (!operation) return;
  const sensitiveValues = sensitiveFieldValues(form);
  let generatedClient: { clientId: string; token: string } | undefined;
  setBusy(form, true);
  try {
    const { target, input } = formInput(form);
    generatedClient = operation === 'client.create'
      ? { clientId: String(input.id), token: generateClientToken() }
      : undefined;
    if (generatedClient) input.token = generatedClient.token;
    const plan = await requestPlan({ operation, ...(target ? { target } : {}), ...(Object.keys(input).length ? { input } : {}) });
    state.pendingClientSecret = generatedClient ? { ...generatedClient, planId: plan.id } : undefined;
    clearSensitiveFields(form);
    renderPlanDialog(plan);
  } catch (error) {
    if (generatedClient) state.pendingClientSecret = undefined;
    clearSensitiveFields(form);
    showToast(redactValues(errorMessage(error), sensitiveValues), 'error');
  } finally {
    setBusy(form, false);
  }
}

async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action],[data-plan-action]') : null;
  if (!target) return;
  if (target.dataset.planAction) {
    event.preventDefault();
    await prepareButtonPlan(target);
    return;
  }
  const action = target.dataset.action;
  if (action === 'logout') await logout();
  else if (action === 'theme') cycleTheme();
  else if (action === 'reload') location.reload();
  else if (action === 'execute-plan') await executePlan();
  else if (action === 'close-job') closeJob();
  else if (action === 'viewer') await openViewer(target.dataset.target ?? '');
  else if (action === 'preview-open') await openPreview(target.dataset.computer ?? '', target.dataset.target ?? '');
  else if (action === 'session-revoke') await revokeSession(target.dataset.target ?? '');
  else if (action === 'copy-client-token') await copyClientToken();
  else if (action === 'restore-backup') renderRestorePrompt(target.dataset.target ?? '', target.dataset.name ?? 'backup');
  else if (action === 'verify-encrypted-backup') renderEncryptedBackupPrompt('backup.verify', target.dataset.target ?? '', '');
  else if (action === 'restore-encrypted-backup') renderEncryptedBackupPrompt('backup.restore', target.dataset.target ?? '', target.dataset.name ?? 'backup');
  else if (action === 'update-skill') renderSkillUpdatePrompt(target.dataset.target ?? '', target.dataset.skill ?? '', target.dataset.name ?? 'skill');
  else if (action === 'dismiss-dialog') target.closest<HTMLDialogElement>('dialog')?.close();
}

async function prepareButtonPlan(button: HTMLElement): Promise<void> {
  if (state.busy) return;
  const operation = button.dataset.planAction as ManagementOperation;
  const target = button.dataset.target;
  let input: Record<string, unknown> | undefined;
  if (button.dataset.input) {
    try { input = JSON.parse(button.dataset.input) as Record<string, unknown>; } catch { return showToast('This action has invalid input.', 'error'); }
  }
  const generatedClient = operation === 'client.rotate' && typeof input?.id === 'string'
    ? { clientId: input.id, token: generateClientToken() }
    : undefined;
  if (generatedClient) input = { ...input, token: generatedClient.token };
  state.busy = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const plan = await requestPlan({ operation, ...(target ? { target } : {}), ...(input ? { input } : {}) });
    state.pendingClientSecret = generatedClient ? { ...generatedClient, planId: plan.id } : undefined;
    renderPlanDialog(plan);
  } catch (error) {
    if (generatedClient) state.pendingClientSecret = undefined;
    showToast(errorMessage(error), 'error');
  }
  finally { state.busy = false; button.removeAttribute('aria-busy'); }
}

async function executePlan(): Promise<void> {
  const plan = state.plan;
  if (!plan || state.busy) return;
  const interruption = document.querySelector<HTMLInputElement>('#confirm-interruption');
  if (plan.requiresInterruption && !interruption?.checked) {
    interruption?.focus();
    return showToast('Confirm the interruption before executing.', 'error');
  }
  const reauth = document.querySelector<HTMLInputElement>('#reauth-password');
  const password = reauth?.value ?? '';
  if (plan.requiresReauthentication && !password) {
    reauth?.focus();
    return showToast('Enter the admin password to continue.', 'error');
  }
  state.busy = true;
  try {
    if (plan.requiresReauthentication) await api.reauthenticate(password);
    if (reauth) reauth.value = '';
    const execution = state.execution?.planId === plan.id ? state.execution : { planId: plan.id, idempotencyKey: crypto.randomUUID(), uncertain: false };
    state.execution = execution;
    const { operationId } = await api.execute(plan.id, {
      idempotencyKey: execution.idempotencyKey,
      ...(plan.requiresInterruption ? { confirmInterruption: true } : {}),
    });
    execution.uncertain = false;
    const job = await api.operation(operationId);
    renderJobDialog(job);
  } catch (error) {
    if (reauth) reauth.value = '';
    const uncertain = !(error instanceof ApiError) || error.status >= 500;
    if (state.execution?.planId === plan.id) state.execution.uncertain = uncertain;
    const message = uncertain ? `Acceptance could not be confirmed. Retry this plan to check the same operation receipt. ${errorMessage(error)}` : errorMessage(error);
    showToast(redactValues(message, password ? [password] : []), 'error');
  } finally { state.busy = false; }
}

function watchJob(id: string): void {
  eventStream?.close();
  const update = (event: ManagementEvent): void => {
    try {
      const data = JSON.parse(event.data) as { operations?: ManagementJob[] } | ManagementJob;
      const envelope = data as { operations?: ManagementJob[] };
      const job = Array.isArray(envelope.operations)
        ? envelope.operations.find((item) => item.id === id)
        : ('id' in data ? data as ManagementJob : undefined);
      if (job) renderJobDialog(job);
    } catch { /* polling remains authoritative */ }
  };
  eventStream = api.eventSource(
    (event) => { if (event.type === 'snapshot' || event.type === 'message') update(event); },
    () => { eventStream?.close(); eventStream = undefined; },
  );
  void pollJob(id);
}

async function pollJob(id: string): Promise<void> {
  while (state.activeJob?.id === id && state.activeJob.status === 'running') {
    await delay(2000);
    try { renderJobDialog(await api.operation(id)); } catch { /* reconnect on the next bounded poll */ }
  }
  await refreshSnapshot(false);
}

function closeJob(): void {
  eventStream?.close();
  eventStream = undefined;
  state.activeJob = undefined;
  state.plan = undefined;
  state.execution = undefined;
  state.pendingClientSecret = undefined;
  const dialog = document.querySelector<HTMLDialogElement>('#plan-dialog');
  dialog?.close();
  void refreshSnapshot(true);
}

async function openViewer(id: string): Promise<void> {
  await openTicket(() => api.viewer(id), 'The server returned an invalid viewer address.');
}

async function openPreview(computerId: string, previewId: string): Promise<void> {
  await openTicket(() => api.openPreview(computerId, previewId), 'The server returned an invalid preview address.');
}

async function openTicket(mint: () => Promise<string>, invalidMessage: string): Promise<void> {
  const viewer = window.open('about:blank', '_blank');
  if (viewer) viewer.opener = null;
  try {
    const url = safeUrl(await mint());
    if (!url) throw new Error(invalidMessage);
    if (viewer) viewer.location.replace(url);
    else window.location.assign(url);
  } catch (error) {
    viewer?.close();
    showToast(errorMessage(error), 'error');
  }
}

async function revokeSession(id: string): Promise<void> {
  if (!id || state.busy) return;
  state.busy = true;
  try {
    const result = await api.revokeSession(id);
    if (!result.authenticated) {
      endSession('This browser session was signed out.');
      return;
    }
    showToast('Session revoked.');
    await navigate();
  } catch (error) { showToast(errorMessage(error), 'error'); }
  finally { state.busy = false; }
}

function renderRestorePrompt(backupId: string, backupName: string): void {
  const dialog = document.querySelector<HTMLDialogElement>('#plan-dialog');
  if (!dialog) return;
  dialog.setAttribute('aria-labelledby', 'plan-dialog-title');
  dialog.innerHTML = `<form class="dialog-card" data-plan="backup.restore" data-target="${escapeAttr(backupId)}"><div class="dialog-top"><div><p class="eyebrow">Restore home backup</p><h2 id="plan-dialog-title">${escapeHtml(backupName)}</h2></div><button class="icon-button" type="button" data-action="dismiss-dialog" aria-label="Close">${icon('close')}</button></div><p>The restored home receives a new computer identity and access token.</p><label>New computer name <input name="name" required autocomplete="off"></label><div class="dialog-actions"><button class="quiet-button" type="button" data-action="dismiss-dialog">Cancel</button><button class="primary-button" type="submit">Review restore plan</button></div></form>`;
  dialog.showModal();
}

function renderEncryptedBackupPrompt(operation: 'backup.verify' | 'backup.restore', backupId: string, backupName: string): void {
  const dialog = document.querySelector<HTMLDialogElement>('#plan-dialog');
  if (!dialog) return;
  const restoring = operation === 'backup.restore';
  dialog.setAttribute('aria-labelledby', 'plan-dialog-title');
  dialog.innerHTML = `<form class="dialog-card" data-plan="${operation}" data-target="${escapeAttr(backupId)}" data-sensitive="passphrase"><div class="dialog-top"><div><p class="eyebrow">${restoring ? 'Restore encrypted backup' : 'Verify encrypted backup'}</p><h2 id="plan-dialog-title">${escapeHtml(backupName || shortId(backupId))}</h2></div><button class="icon-button" type="button" data-action="dismiss-dialog" aria-label="Close">${icon('close')}</button></div><p>The passphrase is held only in memory for this operation and is cleared when the dialog closes.</p>${restoring ? '<label>New computer name <input name="name" required autocomplete="off"></label>' : ''}<label>Backup passphrase <input type="password" name="passphrase" required minlength="12" maxlength="16384" autocomplete="current-password" spellcheck="false"></label><div class="dialog-actions"><button class="quiet-button" type="button" data-action="dismiss-dialog">Cancel</button><button class="primary-button" type="submit">Review ${restoring ? 'restore' : 'verification'} plan</button></div></form>`;
  dialog.showModal();
}

function renderSkillUpdatePrompt(computerId: string, skillId: string, skillName: string): void {
  const dialog = document.querySelector<HTMLDialogElement>('#plan-dialog');
  if (!dialog) return;
  dialog.setAttribute('aria-labelledby', 'plan-dialog-title');
  dialog.innerHTML = `<form class="dialog-card" data-plan="skill.update" data-target="${escapeAttr(computerId)}"><div class="dialog-top"><div><p class="eyebrow">Update exact source</p><h2 id="plan-dialog-title">${escapeHtml(skillName)}</h2></div><button class="icon-button" type="button" data-action="dismiss-dialog" aria-label="Close">${icon('close')}</button></div><input type="hidden" name="id" value="${escapeAttr(skillId)}"><label>Repository URL <input type="url" name="url" required pattern="https://.*" placeholder="https://github.com/org/repo.git"></label><label>Full commit SHA <input name="commit" required pattern="[a-f0-9]{40}" minlength="40" maxlength="40" class="mono"></label><div class="dialog-actions"><button class="quiet-button" type="button" data-action="dismiss-dialog">Cancel</button><button class="primary-button" type="submit">Review update</button></div></form>`;
  dialog.showModal();
}

async function logout(): Promise<void> {
  try { await api.logout(); } catch { /* local state still closes */ }
  endSession();
}

function renderLogin(message?: string): void {
  stopTimers();
  const localSessionNote = location.protocol === 'http:' ? ' This local sign-in stays in this tab across refreshes and clears when the tab closes.' : '';
  root.innerHTML = `<main class="login-page"><section class="login-card"><a class="login-brand" href="https://qubicl.org" aria-label="Qubicl.org"><img src="/assets/qubicl-mark.svg" width="64" height="64" alt=""><span>Qubicl</span></a><div><p class="eyebrow">Owner console</p><h1>Welcome back</h1><p>Manage the computers on this host.</p></div>${message ? `<div class="notice warning">${escapeHtml(message)}</div>` : ''}<form id="login-form"><label>Admin password <input type="password" name="password" required autofocus autocomplete="current-password" spellcheck="false"></label><button class="primary-button wide" type="submit">Sign in</button></form><p class="fine-print">Your password stays on this host and is never written to browser storage.${localSessionNote}</p></section><aside class="login-art" aria-hidden="true"><div class="orbit one"></div><div class="orbit two"></div><p>Local computers.<br>Clear control.</p></aside></main>`;
  const form = document.querySelector<HTMLFormElement>('#login-form');
  form?.addEventListener('submit', (event) => void login(event));
}

function endSession(message?: string): void {
  stopTimers();
  state.session = { authenticated: false };
  state.snapshot = undefined;
  state.plan = undefined;
  state.activeJob = undefined;
  state.execution = undefined;
  state.pendingClientSecret = undefined;
  renderLogin(message);
}

async function login(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement) || state.busy) return;
  const field = form.elements.namedItem('password');
  if (!(field instanceof HTMLInputElement)) return;
  const password = field.value;
  field.value = '';
  setBusy(form, true);
  try {
    state.session = await api.login(password);
    if (!state.session.authenticated) throw new Error('The host did not create an authenticated session.');
    startSessionActivity();
    await refreshSnapshot(true);
  } catch (error) {
    renderLogin(redactValues(errorMessage(error), [password]));
  } finally { state.busy = false; }
}

function startSessionActivity(): void {
  stopTimers();
  lastSessionActivity = Date.now();
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible' && !state.busy && !state.plan) void refreshSnapshot(false);
  }, 10_000);
}

function recordSessionActivity(): void {
  const now = Date.now();
  if (!state.session?.authenticated || now - lastSessionActivity < 60_000) return;
  lastSessionActivity = now;
  void api.activity().then((session) => { state.session = session; }).catch(() => undefined);
}

function stopTimers(): void {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = undefined;
  eventStream?.close();
  eventStream = undefined;
}

function formInput(form: HTMLFormElement): { target?: string; input: Record<string, unknown> } {
  const data = new FormData(form);
  const explicitTarget = form.dataset.target || stringValue(data.get('_target'));
  const input: Record<string, unknown> = {};
  if (form.dataset.collection) {
    input[form.dataset.collection] = data.getAll(form.dataset.collection).map(String);
    return { ...(explicitTarget ? { target: explicitTarget } : {}), input };
  }
  const multi = new Set(['methods', 'scopes']);
  for (const [name, raw] of data) {
    if (name.startsWith('_') || raw instanceof File) continue;
    const preserveExact = name === 'value' || name === 'token' || name === 'passphrase';
    const value = preserveExact ? raw : raw.trim();
    if (!value && !preserveExact) continue;
    if (multi.has(name)) {
      input[name] = data.getAll(name).map(String);
      continue;
    }
    if (name === 'allowDomains' || name === 'denyDomains') input[name] = value.split(/\r?\n|,/).map((part) => part.trim()).filter(Boolean);
    else if (['cpus'].includes(name)) input[name] = Number(value);
    else if (['gatewayPort', 'duration', 'keep'].includes(name)) input[name] = Number.parseInt(value, 10);
    else input[name] = value;
  }
  return { ...(explicitTarget ? { target: explicitTarget } : {}), input };
}

function actionButton(operation: ManagementOperation, target: string, label: string, className: string, input?: Record<string, unknown>): string {
  return `<button class="${className}" type="button" data-plan-action="${operation}"${target ? ` data-target="${escapeAttr(target)}"` : ''}${input ? ` data-input="${escapeAttr(JSON.stringify(input))}"` : ''}>${escapeHtml(label)}</button>`;
}

function lifecycleButtons(computer: ManagementComputer): string {
  if (computer.status === 'running' || computer.status === 'paused') return `${actionButton('computer.stop', computer.id, 'Stop', 'text-button')}${actionButton('computer.restart', computer.id, 'Restart', 'text-button')}`;
  return actionButton('computer.start', computer.id, 'Start', 'secondary-button');
}

function viewerButton(computer: ManagementComputer): string {
  const supportsViewer = computer.capabilities.includes('viewer');
  return supportsViewer ? `<button class="primary-button" type="button" data-action="viewer" data-target="${escapeAttr(computer.id)}">${icon('screen')} Open viewer</button>` : '';
}

function metric(value: string, label: string): string { return `<article><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`; }
function statusPill(status: string): string { return `<span class="status-pill ${escapeAttr(statusClass(status))}"><i></i>${escapeHtml(displayStatus(status))}</span>`; }
function displayStatus(status: string): string { return titleCase(status.replaceAll('_', ' ')); }
function statusClass(status: string): string { return /running|succeeded|healthy|pass|ok/i.test(status) ? 'good' : /failed|unhealthy|recovery/i.test(status) ? 'bad' : /stopped|exited|absent|offline/i.test(status) ? 'neutral' : 'warn'; }
function isAttention(computer: ManagementComputer): boolean { return /failed|unhealthy|unknown|recovery/i.test(`${computer.status} ${computer.health ?? ''}`); }
function isTerminalStatus(status: string): boolean { return /exited|failed|stopped|complete|succeeded/i.test(status); }

function metricValue(value: unknown): string { return typeof value === 'number' || typeof value === 'boolean' ? String(value) : stringValue(value, 'Not configured'); }
function imageLabel(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  const image = record(value);
  return stringValue(image.resolved ?? image.requested, fallback);
}
function objectDetails(value: Record<string, unknown>): string {
  const entries = Object.entries(value).filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item));
  return entries.length ? `<dl class="detail-list">${entries.map(([key, item]) => `<div><dt>${escapeHtml(titleCase(key))}</dt><dd>${escapeHtml(metricValue(item))}</dd></div>`).join('')}</dl>` : '<p class="muted">Not configured.</p>';
}

function jobList(items: ManagementJob[]): string {
  return items.length ? `<div class="activity-list">${items.map((job) => `<article><div class="activity-line"><span class="activity-mark ${statusClass(job.status)}"></span><div><strong>${escapeHtml(operationTitle(job.operation))}</strong><p>${escapeHtml(job.message)}</p></div>${statusPill(job.status)}</div><footer><span class="mono">${shortId(job.id)}</span><time>${formatTime(job.updatedAt)}</time></footer></article>`).join('')}</div>` : emptyState('No operations yet', 'Prepared plans and accepted jobs will appear here.');
}

function sessionList(items: import('./types.js').DashboardSessionItem[]): string {
  return items.length ? `<div class="card-list">${items.map((session) => `<article class="row-card"><div><strong>${session.current ? 'This browser' : 'Browser session'}</strong><p>Active ${formatTime(session.lastActivityAt)} · idle expiry ${formatTime(session.idleExpiresAt)}</p><small class="mono">${escapeHtml(shortId(session.id))}</small></div><button class="${session.current ? 'secondary-button' : 'text-button'}" type="button" data-action="session-revoke" data-target="${escapeAttr(session.id)}">${session.current ? 'Sign out' : 'Revoke'}</button></article>`).join('')}</div>` : '<p class="muted">No active sessions on this origin.</p>';
}

function planList(title: string, values: string[], style: string): string {
  return `<section class="plan-list ${style}"><h3>${escapeHtml(title)}</h3><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul></section>`;
}

function emptyState(title: string, message: string, action = ''): string { return `<div class="empty-state"><div class="empty-cube"></div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>${action}</div>`; }
function loadingView(): string { return '<div class="loading-view" role="status" aria-live="polite"><span aria-hidden="true"></span><p>Loading current state…</p></div>'; }
function errorPanel(message: string): string { return `<div class="empty-state error-state"><h2>That view could not load</h2><p>${escapeHtml(message)}</p><button class="secondary-button" type="button" data-action="reload">Reload</button></div>`; }
function renderLoading(message: string): void { root.innerHTML = `<main class="splash"><img src="/assets/qubicl-mark.svg" width="72" height="72" alt="Qubicl"><div class="loading-line"></div><p>${escapeHtml(message)}</p></main>`; }
function renderFatal(error: unknown): void { root.innerHTML = `<main class="splash">${errorPanel(errorMessage(error))}</main>`; }

function computerOptions(computers: ManagementComputer[]): string { return computers.map((computer) => `<option value="${escapeAttr(computer.id)}">${escapeHtml(computer.name)}</option>`).join(''); }
function networkDescription(profile: string): string { return ({ offline: 'No network access.', 'web-only': 'Common web traffic.', developer: 'Web and development services.', custom: 'Only explicit rules.' } as Record<string, string>)[profile] ?? ''; }
function operationTitle(operation: string): string { return titleCase(operation.replaceAll('.', ' ')); }
function titleCase(value: string): string { return value.replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase()); }
function shortId(value: string): string { return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value; }
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function formatTime(value: unknown): string { if (typeof value !== 'string') return 'Unknown time'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
function relativeTime(value: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  return seconds < 5 ? 'just now' : `${seconds}s ago`;
}
function safeUrl(value: unknown): string { if (typeof value !== 'string') return ''; try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The request could not be completed.'; }
function redactValues(message: string, values: string[]): string { return values.filter((value) => value.length > 0).reduce((result, value) => result.replaceAll(value, '[redacted]'), message); }
function sensitiveFieldValues(form: HTMLFormElement): string[] { return (form.dataset.sensitive ?? '').split(',').map((name) => { const field = form.elements.namedItem(name.trim()); return field instanceof HTMLInputElement ? field.value : ''; }).filter(Boolean); }
function clearSensitiveFields(form: HTMLFormElement): void { for (const name of (form.dataset.sensitive ?? '').split(',').filter(Boolean)) { const field = form.elements.namedItem(name.trim()); if (field instanceof HTMLInputElement) field.value = ''; } }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

function setBusy(form: HTMLFormElement, busy: boolean): void {
  state.busy = busy;
  form.toggleAttribute('aria-busy', busy);
  for (const button of form.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy;
}

function showToast(message: string, kind: 'info' | 'error' = 'info'): void {
  const region = document.querySelector<HTMLElement>('#toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

function generateClientToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `qubicl_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;
}

async function copyClientToken(): Promise<void> {
  const token = state.pendingClientSecret?.token;
  if (!token) return showToast('The one-time token is no longer available.', 'error');
  try {
    await navigator.clipboard.writeText(token);
    showToast('Client token copied.');
  } catch {
    const value = document.querySelector<HTMLElement>('#client-token-value');
    if (value) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(value);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    showToast('Select and copy the highlighted token.', 'error');
  }
}

function cycleTheme(): void {
  const current = localStorage.getItem('qubicl-theme') ?? 'system';
  const next = current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system';
  localStorage.setItem('qubicl-theme', next);
  applyTheme(next);
  const label = document.querySelector<HTMLElement>('#current-theme');
  if (label) label.textContent = titleCase(next);
  showToast(`Theme: ${next}`);
}

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
  document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
}

function escapeHtml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function escapeAttr(value: string): string { return escapeHtml(value).replaceAll('`', '&#96;'); }

function requiredRoot(): HTMLElement {
  const element = document.querySelector<HTMLElement>('#app');
  if (!element) throw new Error('Dashboard root is missing.');
  return element;
}

function icon(name: string): string {
  const paths: Record<string, string> = {
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    archive: '<rect x="3" y="4" width="18" height="5"/><path d="M5 9v11h14V9M9 13h6"/>',
    arrow: '<path d="M12 20V4m0 0-5 5m5-5 5 5"/>',
    pulse: '<path d="M3 12h4l2.5-7 4 14 2.5-7H21"/>',
    list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    sliders: '<path d="M4 6h16M4 18h16M4 12h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', chevron: '<path d="m9 18 6-6-6-6"/>', 'arrow-left': '<path d="m15 18-6-6 6-6"/>',
    screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ''}</svg>`;
}
