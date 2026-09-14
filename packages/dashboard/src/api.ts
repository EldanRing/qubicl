import type {
  BackupItem,
  ClientCredentialItem,
  DashboardSessionItem,
  ListResponse,
  ManagementComputer,
  ManagementJob,
  ManagementPlan,
  ManagementRequest,
  ManagementSnapshot,
  ManagedProcess,
  PublishedPreview,
  SessionState,
  SkillItem,
  ToolItem,
} from './types.js';

const API_ROOT = '/api/v1';
const MAX_EVENT_BUFFER_BYTES = 1024 * 1024;
let csrfToken = '';
let authorizationToken = sessionStorage.getItem('qubicl-session-token') ?? '';
let authenticationGeneration = 0;
let authenticationLost: (() => void) | undefined;

interface SessionEnvelope extends SessionState { authorizationToken?: unknown }
export interface ManagementEvent { type: string; data: string; id?: string }
export interface EventSubscription { close(): void }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const generation = authenticationGeneration;
  const response = await apiFetch(path, init, 'application/json');
  if (response.status === 401 && generation === authenticationGeneration) forgetAuthentication();
  const value = await readJson(response);
  if (!response.ok) {
    const error = asRecord(asRecord(value).error);
    const message = typeof error.message === 'string' ? error.message : `Request failed (${response.status}).`;
    throw new ApiError(message, response.status, typeof error.code === 'string' ? error.code : undefined);
  }
  return value as T;
}

async function apiFetch(path: string, init: RequestInit, accept: string): Promise<Response> {
  const url = new URL(`${API_ROOT}${path}`, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith(`${API_ROOT}/`)) throw new Error('Refusing a non-API request.');
  const method = init.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init.headers);
  headers.set('Accept', accept);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(method) && csrfToken) headers.set('X-Qubicl-CSRF', csrfToken);
  if (usesMemoryToken() && authorizationToken) headers.set('Authorization', `Qubicl-Session ${authorizationToken}`);
  else headers.delete('Authorization');
  return fetch(url.href, { ...init, headers, credentials: usesMemoryToken() ? 'omit' : 'same-origin', cache: 'no-store' });
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { throw new ApiError('The server returned an unreadable response.', response.status); }
}

function rememberSession(session: SessionEnvelope, requireFreshToken = false): SessionState {
  const { authorizationToken: receivedToken, ...publicSession } = session;
  if (!publicSession.authenticated) clearAuthentication();
  else {
    csrfToken = typeof publicSession.csrfToken === 'string' ? publicSession.csrfToken : csrfToken;
    if (usesMemoryToken()) {
      if (receivedToken !== undefined && !validAuthorizationToken(receivedToken)) {
        clearAuthentication();
        throw new ApiError('The server returned an invalid local session.', 502);
      }
      if (typeof receivedToken === 'string') {
        authorizationToken = receivedToken;
        sessionStorage.setItem('qubicl-session-token', receivedToken);
        authenticationGeneration += 1;
      }
      if (requireFreshToken && !receivedToken) {
        clearAuthentication();
        throw new ApiError('The server did not return a local session token.', 502);
      }
    }
  }
  return publicSession;
}

export const api = {
  async session(): Promise<SessionState> {
    return rememberSession(await request<SessionEnvelope>('/session'));
  },
  async login(password: string): Promise<SessionState> {
    return rememberSession(await request<SessionEnvelope>('/session/login', { method: 'POST', body: JSON.stringify({ password }) }), usesMemoryToken());
  },
  async logout(): Promise<void> {
    try { await request('/session/logout', { method: 'POST', body: '{}' }); }
    finally { clearAuthentication(); }
  },
  async activity(): Promise<SessionState> {
    return rememberSession(await request<SessionState>('/session/activity', { method: 'POST', body: '{}' }));
  },
  async reauthenticate(password: string): Promise<SessionState> {
    return rememberSession(await request<SessionEnvelope>('/session/reauth', { method: 'POST', body: JSON.stringify({ password }) }), usesMemoryToken());
  },
  snapshot: () => request<ManagementSnapshot>('/snapshot'),
  computer: (id: string) => request<ManagementComputer>(`/computers/${encodeURIComponent(id)}`),
  processes: (id: string) => request<ListResponse<ManagedProcess>>(`/computers/${encodeURIComponent(id)}/processes`),
  previews: (id: string) => request<ListResponse<PublishedPreview>>(`/computers/${encodeURIComponent(id)}/previews`),
  tools: (id: string) => request<ListResponse<ToolItem>>(`/computers/${encodeURIComponent(id)}/tools`),
  skills: (id: string) => request<ListResponse<SkillItem>>(`/computers/${encodeURIComponent(id)}/skills`),
  credentials: (id: string) => request<ListResponse<Record<string, unknown>>>(`/computers/${encodeURIComponent(id)}/credentials`),
  clients: (id: string) => request<ListResponse<ClientCredentialItem>>(`/computers/${encodeURIComponent(id)}/clients`),
  backups: () => request<ListResponse<BackupItem>>('/backups'),
  updates: () => request<{
    rows: Array<Record<string, unknown>>;
    dashboard?: { configured: boolean; currentImage: unknown; targetImage: unknown; updateAvailable: boolean };
    recoveryRequired: boolean;
    recoveryDetail?: string;
  }>('/updates'),
  diagnostics: () => request<{ checks: Array<Record<string, unknown>>; message?: string }>('/diagnostics'),
  activityLog: () => request<ListResponse<ManagementJob>>('/activity'),
  settings: () => request<Record<string, unknown>>('/settings'),
  sessions: () => request<{ sessions: DashboardSessionItem[] }>('/sessions'),
  async revokeSession(id: string): Promise<{ revoked: boolean; authenticated: boolean }> {
    const result = await request<{ revoked: boolean; authenticated: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
    if (!result.authenticated) clearAuthentication();
    return result;
  },
  plan: (body: ManagementRequest) => request<ManagementPlan>('/plans', { method: 'POST', body: JSON.stringify(body) }),
  execute: (id: string, body: { idempotencyKey: string; confirmInterruption?: boolean }) => request<{ operationId: string }>(`/plans/${encodeURIComponent(id)}/execute`, { method: 'POST', body: JSON.stringify(body) }),
  cancelPlan: (id: string) => request<{ cancelled: true }>(`/plans/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' }),
  operation: (id: string) => request<ManagementJob>(`/operations/${encodeURIComponent(id)}`),
  async viewer(id: string): Promise<string> {
    const access = location.protocol === 'https:' ? 'remote' : 'local';
    const result = await request<{ url: string }>(`/computers/${encodeURIComponent(id)}/view`, { method: 'POST', body: JSON.stringify({ access }) });
    return result.url;
  },
  async openPreview(computerId: string, previewId: string): Promise<string> {
    const access = location.protocol === 'https:' ? 'remote' : 'local';
    const result = await request<{ url: string }>(`/computers/${encodeURIComponent(computerId)}/previews/${encodeURIComponent(previewId)}/open`, { method: 'POST', body: JSON.stringify({ access }) });
    return result.url;
  },
  eventSource(onEvent: (event: ManagementEvent) => void, onError: (error: unknown) => void): EventSubscription {
    const controller = new AbortController();
    void readEvents(controller.signal, onEvent).catch((error: unknown) => {
      if (!controller.signal.aborted) onError(error);
    });
    return { close: () => controller.abort() };
  },
  onAuthenticationLost(listener: () => void): void { authenticationLost = listener; },
};

async function readEvents(signal: AbortSignal, onEvent: (event: ManagementEvent) => void): Promise<void> {
  const response = await apiFetch('/events', { signal }, 'text/event-stream');
  if (response.status === 401) forgetAuthentication();
  if (!response.ok) {
    const value = await readJson(response);
    const error = asRecord(asRecord(value).error);
    throw new ApiError(typeof error.message === 'string' ? error.message : `Event stream failed (${response.status}).`, response.status, typeof error.code === 'string' ? error.code : undefined);
  }
  if (!response.body || !(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/event-stream')) {
    throw new ApiError('The server returned an invalid event stream.', 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    if (new TextEncoder().encode(buffer).byteLength > MAX_EVENT_BUFFER_BYTES) throw new ApiError('The event stream exceeded its safety limit.', 502);
    let boundary = /\r?\n\r?\n/u.exec(buffer);
    while (boundary?.index !== undefined) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const event = parseEvent(block);
      if (event) onEvent(event);
      boundary = /\r?\n\r?\n/u.exec(buffer);
    }
    if (done) break;
  }
}

function parseEvent(block: string): ManagementEvent | undefined {
  let type = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event' && value) type = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
  }
  return data.length ? { type, data: data.join('\n'), ...(id === undefined ? {} : { id }) } : undefined;
}

function usesMemoryToken(): boolean { return location.protocol === 'http:'; }
function validAuthorizationToken(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value); }
function clearAuthentication(): void {
  csrfToken = '';
  authorizationToken = '';
  sessionStorage.removeItem('qubicl-session-token');
  authenticationGeneration += 1;
}
function forgetAuthentication(): void {
  const hadAuthentication = Boolean(csrfToken || authorizationToken);
  clearAuthentication();
  if (hadAuthentication) authenticationLost?.();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}
