import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_CATALOG, NAME_PATTERN, validateCpu, validateMemory, NetworkPolicySchema, SecretsSchema, PRESET_DEFINITIONS, QUBICL_BUILD, toolsForCapabilities } from '@qubicl/core';
import { atomicWrite, auditState, loadState, statePaths, withStateLock, type LoadedState } from '../state.js';
import { inspectStateFormat } from '../migrations.js';
import { managedComputerRuntimeObservation, managedGatewayRuntimeObservation, validateDocker } from '../docker.js';
import { collectUpgradeAllPlan, lifecycleUpdateStatus } from '../lifecycle-command.js';
import { inHostOperation } from '../operation-context.js';
import { buildSetupPlan, snapshotSetup, type SetupSelections } from '../setup-plan.js';
import { dashboardBackups, dashboardTrash } from './metadata.js';
import { dashboardCatalogIdentity, readDashboardConfiguration } from './runtime.js';
import { listInstalledSkills } from '../skill-store.js';
import { gatewayEndpointSet, type GatewayEndpointSet } from '../gateway-access.js';
import { executeHostManagementRequest } from '../commands.js';
import { MANAGEMENT_OPERATIONS, type ManagementRequest, type ManagementPlan, type ManagementJob, type ManagementSnapshot, type ManagementComputer } from './contracts.js';

export class ManagementError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
interface StoredJob { schemaVersion: 1; job: ManagementJob; acceptance: { keyHash: string; planId: string } }
interface RetainedPlan { public: ManagementPlan; request: ManagementRequest; sessionId: string; fingerprint: string; evaluating: boolean }
export interface ManagementTimer { unref(): void }
export interface ManagementTiming {
  now(): number;
  setTimeout(action: () => void, delay: number): ManagementTimer;
  clearTimeout(timer: ManagementTimer): void;
}
export interface ManagementBackend {
  fingerprint(): Promise<string>;
  query(resource: string, params: URLSearchParams): Promise<unknown>;
  preview(request: ManagementRequest): Promise<Pick<ManagementPlan, 'effects' | 'warnings' | 'requiresInterruption'>>;
  run(request: ManagementRequest): Promise<unknown>;
}
const sensitive = /^(credential\.|token\.|network\.|tools\.|skills\.|skill\.|dashboard\.revoke|gateway\.revoke|recovery\.resume|backup\.prune)/u;
const disruptive = /^(computer\.(stop|restart|rename|delete|resources|upgrade|clone)|computers\.stop|upgrade\.all|network\.|gateway\.(restart|revoke)|credential\.|token\.|backup\.create|checkpoint\.|process\.stop)/u;
const defaultManagementTiming: ManagementTiming = {
  now: Date.now,
  setTimeout: (action, delay) => setTimeout(action, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export function managementInterruptionRequired(operation: ManagementRequest['operation'], runtimeStatus?: string): boolean {
  return disruptive.test(operation) && (runtimeStatus === undefined || !['absent', 'exited', 'created'].includes(runtimeStatus));
}
const inputFields: Record<string, readonly string[]> = {
  setup: ['preset', 'cpus', 'memory', 'gatewayPort', 'createName'],
  'computer.create': ['name', 'preset', 'cpus', 'memory'], 'computer.rename': ['name'],
  'computer.resources': ['cpus', 'memory'], 'computer.upgrade': ['preset'],
  'process.stop': ['processId'], 'preview.revoke': ['previewId'],
  'tools.set': ['ids'], 'skills.set': ['ids'], 'skill.import': ['url', 'commit'],
  'skill.update': ['id', 'url', 'commit'], 'skill.reset': ['id'], 'skill.remove': ['id'], 'skill.restore': ['id'],
  'network.set': ['profile', 'allowDomains', 'denyDomains'], 'network.approve': ['domain', 'duration'], 'network.revoke': ['domain'],
  'credential.add': ['id', 'baseUrl', 'pathPrefix', 'methods', 'header', 'value'],
  'credential.replace': ['id', 'baseUrl', 'pathPrefix', 'methods', 'header', 'value'], 'credential.remove': ['id'],
  'backup.create': ['consistency'], 'checkpoint.create': ['consistency'],
  'backup.restore': ['name'], 'backup.prune': ['keep'], 'computer.clone': ['name'],
};
export function validateManagementRequest(value: unknown): ManagementRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('invalid_request', 'Expected an operation object.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['operation', 'target', 'input'].includes(key))
    || typeof record.operation !== 'string' || !(MANAGEMENT_OPERATIONS as readonly string[]).includes(record.operation)) {
    throw new ManagementError('invalid_operation', 'Unknown management operation or field.');
  }
  if (record.target !== undefined && (typeof record.target !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(record.target))) {
    throw new ManagementError('invalid_target', 'Select a computer or backup identifier.');
  }
  const input = record.input ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ManagementError('invalid_input', 'Expected input fields.');
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !(inputFields[record.operation as string] ?? []).includes(key))) {
    throw new ManagementError('invalid_input', 'This operation contains an unsupported input field.');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 32768) throw new ManagementError('input_too_large', 'Operation input exceeds its limit.');
  for (const [key, entry] of Object.entries(fields)) {
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new ManagementError('invalid_input', 'Numeric values must be finite.');
    if (typeof entry !== 'string' && typeof entry !== 'number' && !(Array.isArray(entry) && entry.every((item) => typeof item === 'string'))) {
      throw new ManagementError('invalid_input', `Invalid ${key} value.`);
    }
  }
  const operation = record.operation;
  const needsTarget = /^(computer\.(?!create)|control\.|process\.|preview\.|tools\.|skills\.|skill\.|network\.|credential\.|token\.|backup\.|checkpoint\.)/u.test(operation);
  if (needsTarget !== Boolean(record.target)) throw new ManagementError('invalid_target', needsTarget ? 'Select an immutable target.' : 'This operation does not accept a target.');
  const requiredFields: Record<string, string[]> = {
    setup: ['preset'], 'computer.create': ['name', 'preset'], 'computer.rename': ['name'],
    'computer.clone': ['name'], 'backup.restore': ['name'], 'backup.prune': ['keep'],
    'process.stop': ['processId'], 'preview.revoke': ['previewId'], 'tools.set': ['ids'], 'skills.set': ['ids'],
    'network.set': ['profile'], 'network.approve': ['domain', 'duration'], 'network.revoke': ['domain'],
    'credential.add': ['id', 'baseUrl', 'value'], 'credential.replace': ['id', 'baseUrl', 'value'], 'credential.remove': ['id'],
    'skill.update': ['id'], 'skill.reset': ['id'], 'skill.remove': ['id'], 'skill.restore': ['id'],
    'backup.create': ['consistency'], 'checkpoint.create': ['consistency'],
  };
  if ((requiredFields[operation] ?? []).some((key) => fields[key] === undefined || fields[key] === '')) throw new ManagementError('invalid_input', 'Required operation fields are missing.');
  for (const key of ['name', 'createName']) if (fields[key] !== undefined && (typeof fields[key] !== 'string' || !NAME_PATTERN.test(fields[key]))) throw new ManagementError('invalid_name', 'Use a lowercase name containing letters, digits, and hyphens.');
  if (fields.preset !== undefined && (typeof fields.preset !== 'string' || !Object.hasOwn(PRESET_DEFINITIONS, fields.preset))) throw new ManagementError('invalid_preset', 'Select an embedded curated preset.');
  if (fields.cpus !== undefined && (typeof fields.cpus !== 'number' || fields.cpus <= 0 || fields.cpus > 1024)) throw new ManagementError('invalid_resources', 'CPU allocation must be a positive number.');
  if (fields.memory !== undefined && (typeof fields.memory !== 'string' || !/^[0-9]+(?:\.[0-9]+)?[kmg]$/iu.test(fields.memory))) throw new ManagementError('invalid_resources', 'Specify memory such as 4g.');
  if (fields.gatewayPort !== undefined && (typeof fields.gatewayPort !== 'number' || !Number.isInteger(fields.gatewayPort) || fields.gatewayPort < 1024 || fields.gatewayPort > 65535)) throw new ManagementError('invalid_port', 'Choose an unprivileged gateway port.');
  if (operation === 'computer.resources' && fields.cpus === undefined && fields.memory === undefined) throw new ManagementError('invalid_resources', 'Choose a CPU or memory change.');
  for (const key of ['ids', 'allowDomains', 'denyDomains', 'methods']) if (fields[key] !== undefined && (!Array.isArray(fields[key]) || fields[key].length > 256 || fields[key].some((value) => typeof value !== 'string' || !value || value.length > 256))) throw new ManagementError('invalid_input', `Invalid ${key} list.`);
  if (fields.profile !== undefined && !['developer', 'web-only', 'offline', 'custom'].includes(String(fields.profile))) throw new ManagementError('invalid_profile', 'Select a supported network profile.');
  if (fields.duration !== undefined && (typeof fields.duration !== 'number' || !Number.isInteger(fields.duration) || fields.duration < 60 || fields.duration > 86400)) throw new ManagementError('invalid_duration', 'Approval duration must be 60–86400 seconds.');
  if (fields.keep !== undefined && (typeof fields.keep !== 'number' || !Number.isInteger(fields.keep) || fields.keep < 1 || fields.keep > 1000)) throw new ManagementError('invalid_retention', 'Retain between one and 1000 backups.');
  if (fields.consistency !== undefined && !['quiesced', 'stopped'].includes(String(fields.consistency))) throw new ManagementError('invalid_consistency', 'Choose a quiesced or stopped backup.');
  if (operation.startsWith('credential.') && operation !== 'credential.remove') {
    let url: URL;
    try { url = new URL(String(fields.baseUrl)); } catch { throw new ManagementError('invalid_scope', 'Use an HTTPS credential scope.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || typeof fields.value !== 'string' || /[\r\n\0]/u.test(fields.value)) throw new ManagementError('invalid_scope', 'Use a credential-free HTTPS scope and a single-line credential value.');
    if (fields.pathPrefix !== undefined && (typeof fields.pathPrefix !== 'string' || !fields.pathPrefix.startsWith('/') || /[?#\\\r\n]/u.test(fields.pathPrefix))) throw new ManagementError('invalid_scope', 'Use an absolute URL path prefix.');
    if (fields.methods !== undefined && (fields.methods as string[]).some((method) => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))) throw new ManagementError('invalid_scope', 'Select supported HTTP methods.');
    if (fields.header !== undefined && (typeof fields.header !== 'string' || !/^[A-Za-z0-9-]{1,80}$/u.test(fields.header))) throw new ManagementError('invalid_scope', 'Invalid credential header name.');
  }
  if (record.operation === 'skill.import' || record.operation === 'skill.update') {
    let url: URL;
    try { url = new URL(String(fields.url)); } catch { throw new ManagementError('invalid_source', 'Use an HTTPS Git URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{40}$/u.test(String(fields.commit))) {
      throw new ManagementError('invalid_source', 'Skill imports require a credential-free HTTPS Git URL and an exact 40-character commit.');
    }
  }
  return structuredClone({ operation: record.operation, ...(record.target ? { target: record.target } : {}), input }) as ManagementRequest;
}

/** A durable acceptance ledger; the existing transaction journal owns recovery. */
export class ManagementApplication {
  private readonly plans = new Map<string, RetainedPlan>();
  private readonly jobs = new Map<string, ManagementJob>();
  private readonly executions = new Map<string, { planId: string; operationId: string }>();
  private readonly receipts = new Map<string, StoredJob['acceptance']>();
  private expiryTimer: ManagementTimer | undefined;
  private busy = false;
  private sequence = 0;
  constructor(
    private readonly root: string,
    private readonly backend: ManagementBackend = new HostManagementBackend(root),
    private readonly timing: ManagementTiming = defaultManagementTiming,
  ) {}

  async initialize(): Promise<void> {
    const directory = join(this.root, 'dashboard', 'operations');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new ManagementError('unsafe_state', 'Unsafe operation directory.');
    const names = (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name)).sort();
    if (names.length > 1000) throw new ManagementError('operation_limit', 'Operation history requires local review.');
    for (const name of names) {
      const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let stored: StoredJob;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new ManagementError('invalid_history', 'Unsafe operation record.');
        if (info.size > 16384) throw new ManagementError('invalid_history', 'Operation record exceeds its limit.');
        stored = JSON.parse(await handle.readFile('utf8')) as StoredJob;
      } finally { await handle.close(); }
      if (stored.schemaVersion !== 1 || !stored.job || !stored.acceptance || !/^[a-f0-9]{64}$/u.test(stored.acceptance.keyHash) || !/^[a-f0-9-]{36}$/u.test(stored.acceptance.planId)) throw new ManagementError('invalid_history', 'Invalid acceptance receipt.');
      const value = stored.job;
      if (!['running', 'succeeded', 'failed', 'recovery-required'].includes(value.status) || typeof value.message !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || Object.keys(value).some((key) => !['id', 'operation', 'target', 'status', 'createdAt', 'updatedAt', 'message'].includes(key))) throw new ManagementError('invalid_history', 'Invalid operation status.');
      this.receipts.set(value.id, stored.acceptance);
      this.executions.set(stored.acceptance.keyHash, { planId: stored.acceptance.planId, operationId: value.id });
      if (value.id !== name.slice(0, -5) || !(MANAGEMENT_OPERATIONS as readonly string[]).includes(value.operation)) throw new ManagementError('invalid_history', 'Invalid operation record.');
      if (value.status === 'running') {
        const pending = await pendingManagementRecovery(this.root).catch(() => true);
        value.status = pending ? 'recovery-required' : 'failed'; value.message = pending ? 'Interrupted operation requires recorded recovery; it will not be replayed blindly.' : 'Interrupted operation outcome is unconfirmed. Review current state before preparing a new request.';
        value.updatedAt = new Date().toISOString(); await this.persist(value);
      }
      this.jobs.set(value.id, value);
    }
  }
  async query(resource: string, params = new URLSearchParams()): Promise<unknown> {
    if (resource.replace(/^\//u, '') === 'activity') return { items: this.recentJobs(100) };
    const result = await this.backend.query(resource, params);
    if (resource.replace(/^\//u, '') === 'snapshot' && result && typeof result === 'object') return { ...result, operations: this.recentJobs(20) };
    return result;
  }
  async plan(body: unknown, sessionId: string): Promise<ManagementPlan> {
    this.expirePlans();
    if (this.plans.size >= 100) throw new ManagementError('plan_limit', 'Too many pending plans.', 429);
    const request = validateManagementRequest(body);
    const fingerprint = await this.backend.fingerprint();
    const preview = await this.backend.preview(request);
    const plan: ManagementPlan = {
      id: randomUUID(), operation: request.operation, ...(request.target ? { target: request.target } : {}),
      expiresAt: new Date(this.timing.now() + 300000).toISOString(), ...preview,
      preserved: ['Durable homes and unrelated computers are preserved.', 'Credentials are never returned to the browser.'],
      requiresReauthentication: sensitive.test(request.operation),
    };
    this.plans.set(plan.id, { public: plan, request, sessionId, fingerprint, evaluating: false });
    this.schedulePlanExpiry();
    return structuredClone(plan);
  }
  async execute(planId: string, body: unknown, sessionId: string, reauthenticated: boolean): Promise<{ operationId: string }> {
    const input = body as { idempotencyKey?: unknown; confirmInterruption?: unknown } | null;
    if (!input || typeof input.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/u.test(input.idempotencyKey)) throw new ManagementError('invalid_idempotency_key', 'Provide a bounded idempotency key.');
    const key = createHash('sha256').update(`${sessionId}:${input.idempotencyKey}`).digest('hex');
    const previous = this.executions.get(key);
    if (previous) {
      if (previous.planId !== planId) throw new ManagementError('idempotency_conflict', 'This key belongs to a different plan.', 409);
      return { operationId: previous.operationId };
    }
    const plan = this.plans.get(planId);
    if (!plan || plan.sessionId !== sessionId || Date.parse(plan.public.expiresAt) <= this.timing.now()) {
      if (plan && plan.sessionId === sessionId) this.discardPlan(planId);
      throw new ManagementError('plan_expired', 'Prepare a fresh plan.', 409);
    }
    if (plan.public.requiresReauthentication && !reauthenticated) throw new ManagementError('reauthentication_required', 'Re-enter the administrator password before this change.', 403);
    if (plan.public.requiresInterruption && input.confirmInterruption !== true) throw new ManagementError('interruption_confirmation_required', 'Confirm interruption of active work.', 409);
    if (this.busy) throw new ManagementError('operation_busy', 'Another management operation is running.', 409);
    this.busy = true;
    plan.evaluating = true;
    this.schedulePlanExpiry();
    try {
      await this.trimHistory();
      if (this.jobs.size >= 1000) throw new ManagementError('operation_limit', 'Resolve retained recovery records before accepting more work.', 409);
    } catch (error) {
      plan.evaluating = false;
      this.busy = false;
      this.schedulePlanExpiry();
      throw error;
    }
    // Keep the state lock from final revalidation through the accepted operation.
    let accept!: (value: { operationId: string }) => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<{ operationId: string }>((resolve, fail) => { accept = resolve; reject = fail; });
    void inHostOperation(this.root, () => withStateLock(statePaths(this.root), async () => {
      if (Date.parse(plan.public.expiresAt) <= this.timing.now()) {
        this.discardPlan(planId);
        throw new ManagementError('plan_expired', 'Prepare a fresh plan.', 409);
      }
      if (await this.backend.fingerprint() !== plan.fingerprint) {
        this.discardPlan(planId);
        throw new ManagementError('stale_plan', 'State or runtime changed; review a fresh plan.', 409);
      }
      if (Date.parse(plan.public.expiresAt) <= this.timing.now()) {
        this.discardPlan(planId);
        throw new ManagementError('plan_expired', 'Prepare a fresh plan.', 409);
      }
      const now = new Date().toISOString();
      const job: ManagementJob = { id: randomUUID(), operation: plan.request.operation, ...(plan.request.target ? { target: plan.request.target } : {}), status: 'running', createdAt: now, updatedAt: now, message: 'Operation accepted.' };
      this.receipts.set(job.id, { keyHash: key, planId });
      await this.persist(job); this.jobs.set(job.id, job);
      this.executions.set(key, { planId, operationId: job.id }); this.detachPlan(planId);
      accept({ operationId: job.id });
      try {
        await this.backend.run(plan.request);
        if (plan.request.operation === 'recovery.resume') {
          for (const earlier of this.jobs.values()) if (earlier.status === 'recovery-required') {
            earlier.status = 'failed'; earlier.message = 'Recorded recovery completed. The original request was not replayed; review current state before preparing new work.'; earlier.updatedAt = new Date().toISOString(); await this.persist(earlier);
          }
        }
        job.status = 'succeeded'; job.message = 'Operation completed.';
      } catch {
        const pending = await pendingManagementRecovery(this.root).catch(() => true);
        job.status = pending ? 'recovery-required' : 'failed'; job.message = pending ? 'Operation did not complete. Review recovery before retrying.' : 'Operation failed. Review current state and prepare a fresh plan; no request is replayed automatically.';
      } finally {
        scrubManagementRequest(plan.request); job.updatedAt = new Date().toISOString();
        await this.persist(job); this.sequence += 1;
      }
    })).catch((error) => {
      if (this.plans.get(planId) === plan) {
        plan.evaluating = false;
        this.schedulePlanExpiry();
      }
      reject(error);
    }).finally(() => { this.busy = false; });
    return accepted;
  }
  async operation(id: string): Promise<ManagementJob> {
    const job = this.jobs.get(id);
    if (!job) throw new ManagementError('operation_not_found', 'Operation was not found.', 404);
    return structuredClone(job);
  }
  async action(resource: string, body: unknown, _sessionId: string): Promise<unknown> {
    const match = /^\/?computers\/([a-f0-9-]{36})\/(view|previews\/([a-zA-Z0-9_-]{1,128})\/open)$/u.exec(resource);
    if (!match) throw new ManagementError('not_found', 'Management action was not found.', 404);
    const state = await loadState(statePaths(this.root));
    const computer = state.config.computers.find(({ id }) => id === match[1]);
    if (!computer || (match[2] === 'view' && !computer.capabilities.includes('viewer'))) throw new ManagementError('viewer_unavailable', 'This computer does not provide the requested publication.', 409);
    const input = body as { access?: unknown } | null;
    if (!input || Object.keys(input).some((key) => key !== 'access') || !['local', 'remote'].includes(String(input.access))) throw new ManagementError('invalid_access', 'Choose local or remote access.');
    const access = input.access as 'local' | 'remote';
    const endpoint = gatewayEndpointSet(state.config.gateway, computer, access);
    if (!endpoint) throw new ManagementError('viewer_not_exposed', 'Enable separate gateway TLS exposure on the host for remote viewing.', 409);
    if (match[3]) {
      if (!endpoint.previewBase) throw new ManagementError('preview_not_exposed', 'Enable an isolated remote preview domain before opening this publication.', 409);
      const value = await new HostManagementBackend(this.root).operator(state, computer.id, '/previews/open', 'POST', { previewId: match[3], access }) as { path?: unknown };
      if (typeof value.path !== 'string') throw new ManagementError('preview_unavailable', 'Preview ticket was unavailable.', 502);
      return { url: managementPreviewUrl(endpoint, computer.id, match[3], value.path) };
    }
    const response = await fetch(`http://127.0.0.1:${state.config.gateway.port}/computers/${computer.id}/view-ticket`, { method: 'POST', headers: { authorization: `Bearer ${state.secrets.computers[computer.id]!.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    const value = await boundedJson(response, 16384) as { url?: unknown };
    if (!response.ok || typeof value.url !== 'string' || !value.url.startsWith(`/computers/${computer.id}/view?`) || value.url.includes('#')) throw new ManagementError('viewer_unavailable', 'Gateway could not create a valid viewer ticket.', 502);
    return { url: `${endpoint.origin}${value.url}` };
  }
  async *events(signal: AbortSignal): AsyncIterable<{ id: string; event: string; data: unknown }> {
    while (!signal.aborted) {
      yield { id: String(this.sequence), event: 'snapshot', data: { operations: this.recentJobs(20) } };
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 2000); signal.addEventListener('abort', done, { once: true });
      });
    }
  }
  private recentJobs(limit: number): ManagementJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, limit);
  }
  private async trimHistory(): Promise<void> {
    const completed = [...this.jobs.values()].filter(({ status }) => status === 'succeeded' || status === 'failed').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of completed.slice(0, Math.max(0, completed.length - 500))) {
      await unlink(join(this.root, 'dashboard', 'operations', `${job.id}.json`));
      const receipt = this.receipts.get(job.id); if (receipt) this.executions.delete(receipt.keyHash);
      this.receipts.delete(job.id); this.jobs.delete(job.id);
    }
  }
  private async persist(job: ManagementJob): Promise<void> {
    const acceptance = this.receipts.get(job.id);
    if (!acceptance) throw new ManagementError('invalid_history', 'Missing acceptance receipt.');
    await atomicWrite(join(this.root, 'dashboard', 'operations', `${job.id}.json`), `${JSON.stringify({ schemaVersion: 1, job, acceptance })}\n`, 0o600);
  }
  private expirePlans(): void {
    const now = this.timing.now();
    for (const [id, plan] of this.plans) {
      if (!plan.evaluating && Date.parse(plan.public.expiresAt) <= now) this.discardPlan(id, false);
    }
    this.schedulePlanExpiry();
  }
  private schedulePlanExpiry(): void {
    if (this.expiryTimer) this.timing.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const expirations = [...this.plans.values()]
      .filter(({ evaluating }) => !evaluating)
      .map(({ public: plan }) => Date.parse(plan.expiresAt));
    if (!expirations.length) return;
    const delay = Math.max(0, Math.min(...expirations) - this.timing.now());
    this.expiryTimer = this.timing.setTimeout(() => {
      this.expiryTimer = undefined;
      this.expirePlans();
    }, delay);
    this.expiryTimer.unref();
  }
  private detachPlan(id: string): RetainedPlan | undefined {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    this.schedulePlanExpiry();
    return plan;
  }
  private discardPlan(id: string, reschedule = true): void {
    const plan = this.plans.get(id);
    if (plan) scrubManagementRequest(plan.request);
    this.plans.delete(id);
    if (reschedule) this.schedulePlanExpiry();
  }
}

export function managementPreviewUrl(endpoint: Pick<GatewayEndpointSet, 'previewBase'>, computerId: string, previewId: string, path: string): string {
  if (!endpoint.previewBase) throw new ManagementError('preview_not_exposed', 'Enable an isolated remote preview domain before opening this publication.', 409);
  if (!path.startsWith('/')) throw new ManagementError('preview_unavailable', 'Preview ticket was invalid.', 502);
  const base = new URL(`${endpoint.previewBase.replace(/\/$/u, '')}/`);
  const expectedBasePath = `/computers/${computerId}/previews/`;
  if (base.username || base.password || base.search || base.hash || base.pathname !== expectedBasePath) {
    throw new ManagementError('preview_unavailable', 'Preview ticket was invalid.', 502);
  }
  let url: URL;
  try { url = new URL(path, base); }
  catch { throw new ManagementError('preview_unavailable', 'Preview ticket was invalid.', 502); }
  const prefix = `${expectedBasePath}${previewId}/`;
  const tickets = url.searchParams.getAll('ticket');
  if (url.origin !== base.origin || url.username || url.password || url.hash || !url.pathname.startsWith(prefix)
    || tickets.length !== 1 || !/^[a-zA-Z0-9_-]{32,128}$/u.test(tickets[0]!)
    || [...url.searchParams.keys()].some((key) => key !== 'ticket')) {
    throw new ManagementError('preview_unavailable', 'Preview ticket was invalid.', 502);
  }
  return url.href;
}

function scrubManagementRequest(request: ManagementRequest): void {
  request.input = {};
}

export class HostManagementBackend implements ManagementBackend {
  private snapshotCache: { expires: number; value: Promise<unknown> } | undefined;
  constructor(private readonly root: string) {}
  async fingerprint(): Promise<string> {
    const paths = statePaths(this.root);
    const sources = await Promise.all([paths.config, paths.secrets, paths.journal, paths.migration, paths.runtimeMigration, join(paths.runtime, 'backup-create.json'), join(paths.runtime, 'upgrade-all.json'), join(paths.runtime, 'computer-lifecycle.json')].map(async (path) => {
      try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
    }));
    const format = await inspectStateFormat(paths);
    const state = format.status === 'current' ? await loadState(paths) : undefined;
    sources.push(JSON.stringify(await readDashboardConfiguration(this.root)));
    if (state) sources.push(JSON.stringify(await dashboardBackups(this.root)), JSON.stringify(await dashboardTrash(this.root)));
    if (state) {
      try {
        const runtime = await mapBounded(state.config.computers, 4, (computer) => managedComputerRuntimeObservation(state, computer));
        const gateway = await managedGatewayRuntimeObservation(state);
        sources.push(JSON.stringify(runtime), JSON.stringify(gateway));
      } catch { sources.push('runtime-observation-unavailable'); }

    }
    return createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  }
  async query(resource: string, _params: URLSearchParams): Promise<unknown> {
    if (resource.replace(/^\//u, '') !== 'snapshot') return this.queryUncached(resource, _params);
    if (!this.snapshotCache || this.snapshotCache.expires <= Date.now()) {
      const value = this.queryUncached(resource, _params);
      this.snapshotCache = { expires: Date.now() + 2000, value };
      void value.catch(() => { if (this.snapshotCache?.value === value) this.snapshotCache = undefined; });
    }
    return this.snapshotCache.value;
  }
  private async queryUncached(resource: string, _params: URLSearchParams): Promise<unknown> {
    resource = resource.replace(/^\//u, '');
    const paths = statePaths(this.root);
    const format = await inspectStateFormat(paths);
    let state: LoadedState | undefined;
    if (format.status === 'current') state = await loadState(paths);
    if (resource === 'snapshot') {
      const host = await validateDocker().then(() => ({ available: true })).catch(() => ({ available: false, message: 'Docker is unavailable. Start it on the host, then refresh.' }));
      const computers: ManagementComputer[] = state ? await mapBounded(state.config.computers, 4, async (computer) => {
        const runtime = host.available ? await managedComputerRuntimeObservation(state!, computer).catch(() => ({ status: 'unknown' })) : { status: 'unknown' };
        const status = runtime.status === 'running' ? await this.operator(state!, computer.id, '/status', 'GET').catch(() => undefined) as { controller?: unknown; managedProcesses?: number; activePreviews?: number } | undefined : undefined;
        return { id: computer.id, name: computer.name, preset: computer.preset, status: runtime.status, ...('health' in runtime && typeof runtime.health === 'string' ? { health: runtime.health } : {}), ...(status ? { controller: status.controller, resources: { managedProcesses: status.managedProcesses, activePreviews: status.activePreviews } } : {}), cpus: computer.cpus, memory: computer.memory, image: computer.image, capabilities: computer.capabilities, tools: computer.toolPolicy ?? toolsForCapabilities(computer.capabilities), skills: computer.skillPolicy?.enabledCatalogSkills ?? [], network: computer.network ?? { profile: 'developer' } };
      }) : [];
      const snapshot: ManagementSnapshot = {
        protocolVersion: 1, initialized: Boolean(state), migrationRequired: ['legacy', 'migration-pending'].includes(format.status),
        recoveryRequired: format.status === 'invalid' || await pendingManagementRecovery(this.root), docker: host,
        gateway: { status: state && host.available ? (await managedGatewayRuntimeObservation(state).catch(() => ({ status: 'unknown' }))).status : 'unknown' },
        computers, trash: state ? await dashboardTrash(this.root) : [], operations: [], release: QUBICL_BUILD.version,
        presets: Object.entries(PRESET_DEFINITIONS).map(([id, preset]) => ({ id, cpus: preset.cpus, memory: preset.memory, capabilities: [...preset.capabilities] })),
      };
      return snapshot;
    }
    if (!state) throw new ManagementError('setup_required', 'Complete setup or state migration on the host.', 409);
    if (resource === 'updates') {
      const status = await lifecycleUpdateStatus(state, (await validateDocker()).platform);
      const [dashboard, target] = await Promise.all([readDashboardConfiguration(this.root), dashboardCatalogIdentity()]);
      return { ...status, dashboard: {
        configured: Boolean(dashboard), currentImage: dashboard?.image ?? null, targetImage: target.image,
        updateAvailable: Boolean(dashboard && (dashboard.image.resolved !== target.image.resolved || dashboard.assetManifestSha256 !== target.assetManifestSha256)),
      } };
    }
    if (resource === 'diagnostics') return { checks: (await auditState(state)).map((check) => ({ ...check, detail: check.ok ? check.detail.replaceAll(this.root, '[Qubicl state]') : 'This check needs attention. Run qubicl doctor on the host for detailed repair guidance.' })) };
    if (resource === 'settings') {
      const dashboard = await readDashboardConfiguration(this.root);
      return { service: { release: QUBICL_BUILD.version, catalog: IMAGE_CATALOG.releaseVersion, enabled: dashboard?.enabled ?? false, desiredRunning: dashboard?.desiredRunning ?? false, localOrigin: dashboard ? `http://qubicl-admin.localhost:${dashboard.localPort}` : null }, remote: { administration: dashboard?.remote ? `https://${dashboard.remote.hostname}:${dashboard.remote.port}` : 'disabled', certificateExpiresAt: dashboard?.remote?.expiresAt ?? null, gateway: state.config.gateway.exposure ? `https://${state.config.gateway.exposure.hostname}:${state.config.gateway.exposure.port}` : 'disabled' }, encryptedBackups: 'cli-only' };
    }
    if (resource === 'backups') return { items: await dashboardBackups(this.root) };
    const match = /^computers\/([a-zA-Z0-9-]+)(?:\/(tools|skills|processes|previews|credentials))?$/u.exec(resource);
    const computer = match && state.config.computers.find(({ id }) => id === match[1]);
    if (!computer) throw new ManagementError('not_found', 'Management resource was not found.', 404);
    if (match![2] === 'credentials') return { items: (state.secrets.computers[computer.id]?.brokerCredentials ?? []).map(({ id, baseUrl, pathPrefix, methods, header, expiresAt }) => ({ id, baseUrl: publicCredentialScope(baseUrl), pathPrefix, methods, header, ...(expiresAt ? { expiresAt } : {}) })) };
    if (match![2] === 'tools') return { items: toolsForCapabilities(computer.capabilities).map((id) => ({ id, enabled: (computer.toolPolicy ?? toolsForCapabilities(computer.capabilities)).includes(id), locked: ['get_computer_status', 'acquire_lease', 'renew_lease', 'release_lease'].includes(id) })) };
    if (match![2] === 'skills') return { items: (await listInstalledSkills(join(paths.computers, computer.id, 'home'), computer.skillPolicy?.enabledCatalogSkills ?? [])).map(({ id, name, description, kind, enabled, drift, resetAvailable }) => ({ id, name, description, kind, enabled, drift, resetAvailable })) };
    if (match![2] === 'processes' || match![2] === 'previews') return this.operator(state, computer.id, `/${match![2]}`, 'GET');
    return (await this.query('snapshot', _params) as ManagementSnapshot).computers.find(({ id }) => id === computer.id);
  }
  async preview(request: ManagementRequest): Promise<Pick<ManagementPlan, 'effects' | 'warnings' | 'requiresInterruption'>> {
    const format = await inspectStateFormat(statePaths(this.root));
    const state = format.status === 'current' ? await loadState(statePaths(this.root)) : undefined;
    if (!['setup', 'dashboard.restart', 'dashboard.revoke', 'recovery.resume'].includes(request.operation) && !state) throw new ManagementError('setup_required', 'Complete setup before this operation.', 409);
    if (!['recovery.resume', 'dashboard.restart', 'dashboard.revoke'].includes(request.operation) && (['invalid', 'migration-pending', 'legacy'].includes(format.status) || await pendingManagementRecovery(this.root))) throw new ManagementError('recovery_required', 'Recover or migrate the installation before planning changes.', 409);
    const computer = state?.config.computers.find(({ id }) => id === request.target);
    if (request.target && !computer && !['computer.restore', 'backup.restore', 'backup.verify'].includes(request.operation)) throw new ManagementError('not_found', 'Target computer was not found.', 404);
    const input = request.input ?? {};
    if (['computer.create', 'computer.resources'].includes(request.operation)) {
      const host = await validateDocker();
      if (input.cpus !== undefined) validateCpu(Number(input.cpus), host.cpus);
      if (input.memory !== undefined) validateMemory(String(input.memory), host.memoryBytes);
    }
    if (request.operation === 'network.set') {
      NetworkPolicySchema.parse({ profile: input.profile, allowDomains: input.allowDomains ?? [], denyDomains: input.denyDomains ?? [], temporaryApprovals: [] });
      if (input.profile === 'custom' && !(input.allowDomains as string[] | undefined)?.length) throw new ManagementError('invalid_network', 'Custom network policy requires allowed domains.');
    }
    if (state?.config.computers.some(({ name, id }) => name === input.name && id !== computer?.id)) throw new ManagementError('duplicate_name', 'This computer name is already in use.', 409);
    const effects: string[] = []; const warnings: string[] = [];
    if (request.operation === 'setup') {
      if (state) throw new ManagementError('already_initialized', 'Use computer and settings actions for an initialized installation.', 409);
      const host = await validateDocker();
      const plan = buildSetupPlan(snapshotSetup(), { ...input, createName: input.createName ?? null } as SetupSelections, IMAGE_CATALOG, host.platform, host);
      const dashboard = await readDashboardConfiguration(this.root);
      if (dashboard && [dashboard.localPort, dashboard.assetPort, dashboard.remote?.port].includes(plan.gateway.port)) throw new ManagementError('port_conflict', 'Gateway and dashboard ports must differ.');
      effects.push(`Initialize Qubicl with ${plan.proposedDefault.preset}, ${plan.proposedDefault.cpus} CPUs and ${plan.proposedDefault.memory} memory.`, `Gateway: loopback port ${plan.gateway.port}; exact image ${plan.gateway.image.resolved}.`, plan.createName ? `Create and start ${plan.createName}.` : 'Leave the computer list empty.', `Image download estimate: ${plan.downloadBytes ?? 'unknown'} bytes; expanded estimate: ${plan.expandedBytes ?? 'unknown'} bytes.`);
      warnings.push(...plan.warnings);
    } else if (request.operation === 'upgrade.all') {
      const plan = await collectUpgradeAllPlan(state!, (await validateDocker()).platform);
      if (plan.blockers.length) throw new ManagementError('upgrade_blocked', plan.blockers.map(({ detail }) => detail).join(' '), 409);
      effects.push(...plan.rows.map((row) => `${row.name}: ${row.action}; ${row.currentImage.resolved} → ${row.targetImage?.resolved ?? 'unchanged'}.`));
      effects.push(plan.space.statement);
    } else if (request.operation === 'dashboard.restart') {
      const target = await dashboardCatalogIdentity();
      effects.push(`Start the dashboard image ${target.image.resolved} with verified asset manifest ${target.assetManifestSha256}.`, 'Replace only the static dashboard container; reload the dashboard after completion.');
    } else {
      const descriptions: Record<string, string> = {
        'computer.create': `Create ${input.name} using ${input.preset}, ${input.cpus ?? 'preset'} CPUs and ${input.memory ?? 'preset'} memory, then start it.`,
        'computer.start': 'Start this exact managed runtime, or create it from its pinned image when absent.',
        'computer.stop': 'Stop every verified container belonging to this computer.',
        'computer.restart': 'Restart every verified retained container belonging to this computer.',
        'computer.rename': `Rename this computer to ${input.name}; preserve its identity and durable home.`,
        'computer.clone': `Checkpoint this source home and restore a new stopped computer named ${input.name}; temporarily pause a running source during capture.`,
        'computer.delete': 'Stop and remove the managed runtime, then move this computer and its home into recoverable trash.',
        'computer.restore': 'Restore the selected trashed computer with a new client token.',
        'computer.resources': `Change allocation from ${computer?.cpus} CPUs / ${computer?.memory} to ${input.cpus ?? computer?.cpus} CPUs / ${input.memory ?? computer?.memory}; replace retained runtime containers.`,
        'computer.upgrade': `Upgrade to the embedded ${input.preset ?? computer?.preset} image; preserve whether the computer was running, stopped, or absent.`,
        'computers.stop': `Stop ${state?.config.computers.map(({ name }) => name).join(', ') || 'no computers'}.`,
        'gateway.start': 'Start the managed gateway and verify protocol compatibility.',
        'gateway.restart': 'Restart the exact managed gateway; interrupt all connected agent transports and viewers.',
        'gateway.revoke': 'Remove remote gateway exposure and invalidate remote access.',
        'dashboard.revoke': 'Close remote administration and revoke its browser sessions.',
        'control.release': 'Release current human control so agents may acquire control again.',
        'process.stop': `Stop the managed process with exact identifier ${input.processId}; output and command content are not retrieved.`,
        'preview.revoke': `Revoke publication ${input.previewId} and its access URL.`,
        'tools.set': `Set enabled tools to ${(input.ids as string[] | undefined)?.join(', ') || 'required control tools only'}.`,
        'skills.set': `Set enabled skills to ${(input.ids as string[] | undefined)?.join(', ') || 'none'}.`,
        'skill.import': `Import and validate ${input.url} at commit ${input.commit}.`,
        'skill.update': `Update ${input.id} from ${input.url} at commit ${input.commit}.`,
        'skill.reset': `Reset the editable working copy of ${input.id} to its approved source.`,
        'skill.remove': `Disable and move ${input.id} into recoverable skill trash.`,
        'skill.restore': `Restore the approved source of ${input.id} from skill trash.`,
        'network.set': `Set network profile to ${input.profile}; allow ${(input.allowDomains as string[] | undefined)?.join(', ') || 'no extra domains'}; deny ${(input.denyDomains as string[] | undefined)?.join(', ') || 'no extra domains'}.`,
        'network.approve': `Allow ${input.domain} for ${input.duration} seconds.`,
        'network.revoke': `Revoke the temporary approval for ${input.domain}.`,
        'credential.add': `Add scoped credential ${input.id} for ${input.baseUrl}${input.pathPrefix ?? '/'}; permitted methods ${(input.methods as string[] | undefined)?.join(', ') ?? 'GET'}.`,
        'credential.replace': `Replace scoped credential ${input.id} and its permitted destination/methods.`,
        'credential.remove': `Remove scoped credential ${input.id}.`,
        'token.rotate': 'Replace this computer’s client token; reconnect clients with newly generated configuration from the host CLI.',
        'backup.create': `Create an unencrypted ${input.consistency} backup of this durable home.`,
        'checkpoint.create': `Create an unencrypted ${input.consistency} checkpoint of this durable home.`,
        'backup.verify': 'Verify the selected backup archive digest and safe extraction structure.',
        'backup.restore': `Verify and restore this backup into a new computer named ${input.name}; preserve the source backup.`,
        'backup.prune': `Retain the newest ${input.keep} backups for this computer and permanently remove older matching backups.`,
        'recovery.resume': 'Resume only the validated migration, state, lifecycle, upgrade, or backup journal; never replay an unjournaled browser request.',
      };
      effects.push(`${computer ? `${computer.name}: ` : ''}${descriptions[request.operation] ?? request.operation}`);
    }
    if (request.operation === 'computer.restore') {
      const trash = (await dashboardTrash(this.root)).find(({ id }) => id === request.target);
      if (!trash) throw new ManagementError('not_found', 'Trashed computer was not found.', 404);
      effects.push(`Restore ${trash.name} (${trash.id}).`);
    }
    if (['backup.restore', 'backup.verify', 'backup.prune'].includes(request.operation)) {
      const backups = await dashboardBackups(this.root);
      if (request.operation === 'backup.prune') {
        const pruned = backups.filter(({ sourceId }) => sourceId === computer!.id).slice(Number(input.keep));
        effects.push(pruned.length ? `Remove exactly: ${pruned.map(({ id }) => id).join(', ')}.` : 'No archives will be removed.');
      } else {
        const backup = backups.find(({ id }) => id === request.target);
        if (!backup) throw new ManagementError('not_found', 'Backup was not found.', 404);
        if (backup.encrypted) throw new ManagementError('cli_required', 'Encrypted backup operations require the local CLI.', 409);
        effects.push(`Archive ${backup.id}, created ${backup.createdAt}, SHA-256 ${backup.sha256}.`);
      }
    }
    if (request.operation === 'tools.set' && (input.ids as string[]).some((id) => !toolsForCapabilities(computer!.capabilities).includes(id as never))) throw new ManagementError('invalid_tools', 'Selected tools exceed this computer’s capabilities.');
    if (request.operation.startsWith('credential.')) {
      const exists = state!.secrets.computers[computer!.id]?.brokerCredentials?.some(({ id }) => id === input.id) ?? false;
      if (request.operation !== 'credential.remove') {
        const candidate = structuredClone(state!.secrets);
        candidate.computers[computer!.id]!.brokerCredentials = [{ id: input.id, baseUrl: input.baseUrl, pathPrefix: input.pathPrefix ?? '/', methods: input.methods ?? ['GET'], header: input.header ?? 'Authorization', provider: { type: 'direct', value: input.value } } as never];
        SecretsSchema.parse(candidate);
      }
      if (exists === (request.operation === 'credential.add')) throw new ManagementError('credential_conflict', exists ? 'Credential already exists; use replace.' : 'Credential was not found.', 409);
    }
    const runtime = computer && state ? await managedComputerRuntimeObservation(state, computer) : undefined;
    if (runtime && !['complete', 'absent'].includes(runtime.group)) throw new ManagementError('runtime_ambiguous', 'Repair the partial or inconsistent runtime before changing it.', 409);
    if (request.operation === 'backup.create' || request.operation === 'checkpoint.create' || request.operation === 'computer.clone') warnings.push('Backups may contain browser profiles, cookies, credentials and personal data; storage is unencrypted.');
    if (request.operation === 'backup.prune') warnings.push('Pruned backup archives cannot be restored from Qubicl trash.');
    if (disruptive.test(request.operation)) warnings.push('Active work and client connections may be interrupted. Container replacement discards changes outside the durable home.');
    return { effects, warnings, requiresInterruption: managementInterruptionRequired(request.operation, runtime?.status) };
  }
  async run(request: ManagementRequest): Promise<unknown> { this.snapshotCache = undefined; try { return await executeHostManagementRequest(this.root, request); } finally { this.snapshotCache = undefined; } }
  async operator(state: LoadedState, id: string, path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${state.config.gateway.port}/computers/${id}/operator/management${path}`, {
      method, headers: { 'x-qubicl-operator-key': state.secrets.computers[id]!.internalKey, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new ManagementError('runtime_management_unavailable', 'Upgrade this computer runtime to enable management observation.', 409);
    return boundedJson(response, 262144);
  }
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ManagementError('empty_response', 'Runtime returned no response.', 502);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ManagementError('runtime_response_limit', 'Runtime response exceeds its limit.', 502); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function mapBounded<T, R>(values: T[], concurrency: number, action: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await action(values[index]!); }
  }));
  return results;
}

export async function pendingManagementRecovery(root: string): Promise<boolean> {
  const paths = statePaths(root);
  const files = [paths.journal, paths.migration, join(paths.runtime, 'backup-create.json'), join(paths.runtime, 'upgrade-all.json'), join(paths.runtime, 'computer-lifecycle.json')];
  return (await Promise.all(files.map(async (path) => Boolean(await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; }))))).some(Boolean);
}

function publicCredentialScope(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[invalid scope]'; }
}
