import { X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { createSecureContext, type TLSSocket } from 'node:tls';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { isIP, type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { MANAGEMENT_OPERATIONS, type ManagementRequest } from './contracts.js';
import { DashboardAssetError, type VerifiedDashboardAssetLoader } from './assets.js';
import { DashboardAuthError, type DashboardAuthManager } from './auth.js';

const MAX_REQUEST_TARGET_BYTES = 4 * 1024;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MAX_PUBLIC_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 256 * 1024;
const SESSION_COOKIE_REMOTE = '__Host-qubicl-admin';
const LOCAL_AUTHORIZATION_SCHEME = 'Qubicl-Session';
const CSRF_HEADER = 'x-qubicl-csrf';
const IDENTIFIER = /^[A-Za-z0-9_-]{8,128}$/u;
const EVENT_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const COMPUTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECOVERY_OPERATIONS = new Set<ManagementRequest['operation']>(['gateway.start', 'dashboard.restart', 'recovery.resume']);
const FORBIDDEN_RESPONSE_KEYS = new Set([
  'authorization', 'bearer', 'cookie', 'csrftoken', 'internalkey', 'password', 'passwordhash',
  'privatekey', 'secret', 'secretvalue', 'token', 'tokenvalue', 'credentialvalue',
]);

export interface DashboardApplicationEvent {
  id: string;
  event?: string;
  data: unknown;
}

export interface DashboardApplicationAdapter {
  query(resource: string, params: URLSearchParams): Promise<unknown>;
  plan(body: ManagementRequest, sessionId: string, reauthenticated?: boolean): Promise<unknown>;
  execute(planId: string, body: unknown, sessionId: string, reauthenticated: boolean): Promise<unknown>;
  cancel?(planId: string, sessionId: string): { cancelled: true };
  operation(id: string): Promise<unknown>;
  action?(resource: string, body: unknown, sessionId: string): Promise<unknown>;
  events?(signal: AbortSignal, lastEventId?: string): AsyncIterable<DashboardApplicationEvent>;
}

export interface DashboardTlsOptions {
  certificate: string | Buffer;
  privateKey: string | Buffer;
}

export interface DashboardServerOptions {
  origin: string;
  auth: DashboardAuthManager;
  application: DashboardApplicationAdapter;
  assets: VerifiedDashboardAssetLoader;
  tls?: DashboardTlsOptions;
  allowPeer?: (remoteAddress: string) => boolean;
  maxBodyBytes?: number;
  authRefresh?: () => Promise<void>;
  authRefreshIntervalMs?: number;
}

export interface DashboardServerStartOptions {
  host: string;
  port: number;
  ipv6Only?: boolean;
}

export class DashboardHttpError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'DashboardHttpError';
  }
}

export class DashboardServer {
  readonly server: HttpServer | HttpsServer;
  private readonly origin: URL;
  private readonly secure: boolean;
  private readonly allowPeer: (remoteAddress: string) => boolean;
  private readonly maxBodyBytes: number;
  private readonly recoveryPlans = new Map<string, string>();
  private authRefreshTimer: NodeJS.Timeout | undefined;
  private authRefreshFailed = false;
  private readonly sockets = new Set<Socket>();
  private closing: Promise<void> | undefined;

  constructor(private readonly options: DashboardServerOptions) {
    this.origin = normalizeAdminOrigin(options.origin);
    this.secure = this.origin.protocol === 'https:';
    this.allowPeer = options.allowPeer ?? isLoopbackPeer;
    this.maxBodyBytes = positiveInteger(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 'Dashboard body limit');
    if (this.secure !== Boolean(options.tls)) throw new Error('Dashboard TLS material must match the configured HTTPS origin.');
    const handler = (request: IncomingMessage, response: ServerResponse) => void this.handle(request, response);
    if (options.tls) {
      assertTlsIdentity(options.tls, this.origin.hostname);
      const secureContext = createSecureContext({ cert: options.tls.certificate, key: options.tls.privateKey, minVersion: 'TLSv1.2' });
      this.server = createHttpsServer({
        cert: options.tls.certificate,
        key: options.tls.privateKey,
        minVersion: 'TLSv1.2',
        handshakeTimeout: 10_000,
        SNICallback: (serverName, callback) => {
          if (normalizedHostname(serverName) === normalizedHostname(this.origin.hostname)) callback(null, secureContext);
          else callback(new Error('Unrecognized Qubicl dashboard TLS server name.'));
        },
      }, handler);
    } else {
      this.server = createHttpServer(handler);
    }
    this.server.maxConnections = 128;
    this.server.maxHeadersCount = 64;
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 30_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxRequestsPerSocket = 100;
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      if (this.closing || !socket.remoteAddress || !this.allowPeer(normalizedPeer(socket.remoteAddress))) socket.destroy();
    });
    this.server.on('upgrade', (_request, socket) => socket.destroy());
  }

  async start(options: DashboardServerStartOptions): Promise<AddressInfo> {
    if (!options.host || !Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error('Dashboard bind address and port are invalid.');
    }
    if (this.options.authRefresh) await this.refreshAuth();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen({ port: options.port, host: options.host, ipv6Only: options.ipv6Only });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Dashboard server did not report its TCP listener.');
    if (this.options.authRefresh) {
      const interval = positiveInteger(this.options.authRefreshIntervalMs ?? 30_000, 'Dashboard authentication refresh interval');
      this.authRefreshTimer = setInterval(() => void this.refreshAuth(), interval);
      this.authRefreshTimer.unref();
    }
    return address;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.authRefreshTimer) clearInterval(this.authRefreshTimer);
    this.authRefreshTimer = undefined;
    if (!this.server.listening) return;
    this.closing = new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    // Revocation must also close SSE, keep-alive and incomplete TLS connections.
    // Accepted host operations belong to the application and continue independently.
    for (const socket of this.sockets) socket.destroy();
    return this.closing;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    applySecurityHeaders(response, this.secure);
    try {
      const peer = request.socket.remoteAddress ? normalizedPeer(request.socket.remoteAddress) : '';
      if (!peer || !this.allowPeer(peer)) throw new DashboardHttpError('network_not_allowed', 'Client network is not allowed.', 403);
      this.requireExactHost(request);
      this.requireExactSni(request);
      rejectUnexpectedReadBody(request);
      const target = canonicalRequestTarget(request.url);
      const url = new URL(target, this.origin);
      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(request, response, url, peer);
      } else {
        await this.handleAsset(request, response, url.pathname);
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendError(response, error);
      else if (!response.writableEnded) response.destroy();
    }
  }

  private async handleApi(request: IncomingMessage, response: ServerResponse, url: URL, peer: string): Promise<void> {
    if (request.method === 'OPTIONS') throw new DashboardHttpError('method_not_allowed', 'Method not allowed.', 405);
    if (this.authRefreshFailed) throw new DashboardHttpError('authentication_unavailable', 'Dashboard authentication state is unavailable.', 503);
    const recoveryMode = await this.checkAssetMode();
    const token = this.requestSessionToken(request);
    if (request.method === 'POST' && url.pathname === '/api/v1/session/login') {
      this.requireUnsafeBrowserRequest(request);
      const body = await readJsonBody(request, this.maxBodyBytes);
      const password = exactPasswordBody(body);
      const { token, session } = await this.options.auth.login(password, peer);
      if (this.secure) response.setHeader('set-cookie', sessionCookie(token));
      sendPublicJson(response, 200, {
        authenticated: true,
        csrfToken: session.csrfToken,
        ...(!this.secure ? { authorizationToken: token } : {}),
      });
      return;
    }

    const session = this.options.auth.authenticate(token);
    if (request.method === 'GET' && url.pathname === '/api/v1/session') {
      sendPublicJson(response, 200, session
        ? { authenticated: true, csrfToken: session.csrfToken }
        : { authenticated: false });
      return;
    }
    if (!token || !session) throw new DashboardHttpError('authentication_required', 'Dashboard authentication is required.', 401);

    if (request.method === 'POST' && url.pathname === '/api/v1/session/logout') {
      this.requireAuthorizedMutation(request, token);
      await readEmptyJsonBody(request, this.maxBodyBytes);
      this.options.auth.logout(token);
      if (this.secure) response.setHeader('set-cookie', expiredSessionCookie());
      sendPublicJson(response, 200, { authenticated: false });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/session/activity') {
      this.requireAuthorizedMutation(request, token);
      await readEmptyJsonBody(request, this.maxBodyBytes);
      const updated = this.options.auth.recordActivity(token);
      if (!updated) throw new DashboardHttpError('authentication_required', 'Dashboard authentication is required.', 401);
      sendPublicJson(response, 200, { authenticated: true, csrfToken: updated.csrfToken });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/session/reauth') {
      this.requireAuthorizedMutation(request, token);
      const body = await readJsonBody(request, this.maxBodyBytes);
      const updated = await this.options.auth.reauthenticate(token, exactPasswordBody(body), peer);
      if (this.secure) response.setHeader('set-cookie', sessionCookie(updated.token));
      sendPublicJson(response, 200, {
        authenticated: true,
        csrfToken: updated.session.csrfToken,
        reauthenticatedUntil: updated.session.view.reauthenticatedUntil,
        ...(!this.secure ? { authorizationToken: updated.token } : {}),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/sessions') {
      if (recoveryMode) throw new DashboardHttpError('recovery_route_required', 'Only recovery operations are available.', 503);
      const sessions = this.options.auth.list().map((entry) => ({ ...entry, current: entry.id === session.actorId }));
      sendPublicJson(response, 200, { sessions });
      return;
    }
    const revokeMatch = /^\/api\/v1\/sessions\/([A-Za-z0-9-]{8,64})$/u.exec(url.pathname);
    if (request.method === 'DELETE' && revokeMatch) {
      if (recoveryMode) throw new DashboardHttpError('recovery_route_required', 'Only recovery operations are available.', 503);
      this.requireAuthorizedMutation(request, token);
      await readEmptyJsonBody(request, this.maxBodyBytes);
      const sessionId = revokeMatch[1]!;
      const revoked = this.options.auth.revoke(sessionId);
      if (!revoked) throw new DashboardHttpError('session_not_found', 'Dashboard session was not found.', 404);
      if (sessionId === session.actorId && this.secure) response.setHeader('set-cookie', expiredSessionCookie());
      else this.options.auth.recordActivity(token);
      sendPublicJson(response, 200, { revoked: true, authenticated: sessionId !== session.actorId });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/events') {
      if (recoveryMode) throw new DashboardHttpError('recovery_route_required', 'Event streaming is unavailable during recovery.', 503);
      if (!this.options.application.events) throw new DashboardHttpError('not_supported', 'Dashboard event stream is unavailable.', 404);
      await this.streamEvents(request, response, token, lastEventId(request));
      return;
    }
    const operationMatch = /^\/api\/v1\/operations\/([A-Za-z0-9_-]{8,128})$/u.exec(url.pathname);
    if (request.method === 'GET' && operationMatch) {
      const result = await this.options.application.operation(operationMatch[1]!);
      sendApplicationJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/plans') {
      this.requireAuthorizedMutation(request, token);
      const body = managementRequest(await readJsonBody(request, this.maxBodyBytes));
      if (recoveryMode && !RECOVERY_OPERATIONS.has(body.operation)) {
        throw new DashboardHttpError('recovery_route_required', 'Only recovery operations are available.', 503);
      }
      const current = this.options.auth.recordActivity(token);
      if (!current) throw new DashboardHttpError('authentication_required', 'Dashboard authentication is required.', 401);
      const result = await this.options.application.plan(body, current.actorId, current.reauthenticated);
      if (recoveryMode) {
        if (!isPlainObject(result) || typeof result.id !== 'string' || !IDENTIFIER.test(result.id)) {
          throw new Error('Dashboard application returned an invalid recovery plan.');
        }
        if (this.recoveryPlans.size >= 128) this.recoveryPlans.delete(this.recoveryPlans.keys().next().value as string);
        this.recoveryPlans.set(result.id, current.actorId);
      }
      sendApplicationJson(response, 200, result);
      return;
    }
    const executeMatch = /^\/api\/v1\/plans\/([A-Za-z0-9_-]{8,128})\/execute$/u.exec(url.pathname);
    if (request.method === 'POST' && executeMatch) {
      this.requireAuthorizedMutation(request, token);
      const body = executeRequest(await readJsonBody(request, this.maxBodyBytes));
      if (recoveryMode && this.recoveryPlans.get(executeMatch[1]!) !== session.actorId) {
        throw new DashboardHttpError('recovery_route_required', 'Prepare a recovery plan before executing it.', 503);
      }
      const current = this.options.auth.recordActivity(token);
      if (!current) throw new DashboardHttpError('authentication_required', 'Dashboard authentication is required.', 401);
      // Accepted work is deliberately not tied to request abort or browser connectivity.
      const result = await this.options.application.execute(executeMatch[1]!, body, current.actorId, current.reauthenticated);
      this.recoveryPlans.delete(executeMatch[1]!);
      if (!response.destroyed) sendApplicationJson(response, 202, result);
      return;
    }
    const cancelPlanMatch = /^\/api\/v1\/plans\/([A-Za-z0-9_-]{8,128})$/u.exec(url.pathname);
    if (request.method === 'DELETE' && cancelPlanMatch) {
      if (!this.options.application.cancel) throw new DashboardHttpError('not_supported', 'Plan cancellation is unavailable.', 404);
      this.requireAuthorizedMutation(request, token);
      await readEmptyJsonBody(request, this.maxBodyBytes);
      const current = this.options.auth.recordActivity(token);
      if (!current) throw new DashboardHttpError('authentication_required', 'Dashboard authentication is required.', 401);
      const result = this.options.application.cancel(cancelPlanMatch[1]!, current.actorId);
      this.recoveryPlans.delete(cancelPlanMatch[1]!);
      sendApplicationJson(response, 200, result);
      return;
    }
    const viewMatch = /^\/api\/v1\/computers\/([0-9a-f-]{36})\/view$/u.exec(url.pathname);
    if (request.method === 'POST' && viewMatch) {
      if (recoveryMode) throw new DashboardHttpError('recovery_route_required', 'Viewer handoff is unavailable during recovery.', 503);
      if (!COMPUTER_ID.test(viewMatch[1]!)) throw new DashboardHttpError('invalid_request', 'Computer ID is invalid.', 400);
      if (!this.options.application.action) throw new DashboardHttpError('not_supported', 'Viewer handoff is unavailable.', 404);
      this.requireAuthorizedMutation(request, token);
      const body = await readJsonBody(request, this.maxBodyBytes);
      if (!isPlainObject(body)) throw new DashboardHttpError('invalid_request', 'Viewer request must be a JSON object.', 400);
      const current = this.options.auth.recordActivity(token);
      if (!current) throw new DashboardHttpError('authentication_required', 'Dashboard authentication is required.', 401);
      const result = await this.options.application.action(`/computers/${viewMatch[1]}/view`, body, current.actorId);
      sendApplicationJson(response, 200, result);
      return;
    }
    const previewOpenMatch = /^\/api\/v1\/computers\/([0-9a-f-]{36})\/previews\/([A-Za-z0-9_-]{16})\/open$/u.exec(url.pathname);
    if (request.method === 'POST' && previewOpenMatch) {
      if (recoveryMode) throw new DashboardHttpError('recovery_route_required', 'Preview handoff is unavailable during recovery.', 503);
      if (!COMPUTER_ID.test(previewOpenMatch[1]!)) throw new DashboardHttpError('invalid_request', 'Computer ID is invalid.', 400);
      if (!this.options.application.action) throw new DashboardHttpError('not_supported', 'Preview handoff is unavailable.', 404);
      this.requireAuthorizedMutation(request, token);
      const body = await readJsonBody(request, this.maxBodyBytes);
      if (!isPlainObject(body) || (body.access !== 'local' && body.access !== 'remote')
        || Object.keys(body).some((key) => key !== 'access')) {
        throw new DashboardHttpError('invalid_request', 'Preview access must be local or remote.', 400);
      }
      const current = this.options.auth.recordActivity(token);
      if (!current) throw new DashboardHttpError('authentication_required', 'Dashboard authentication is required.', 401);
      const resource = `/computers/${previewOpenMatch[1]}/previews/${previewOpenMatch[2]}/open`;
      const result = await this.options.application.action(resource, body, current.actorId);
      sendApplicationJson(response, 200, result);
      return;
    }
    if (request.method === 'GET') {
      const resource = queryResource(url.pathname);
      if (resource) {
        if (recoveryMode && resource !== '/snapshot') {
          throw new DashboardHttpError('recovery_route_required', 'Only recovery status is available.', 503);
        }
        const result = await this.options.application.query(resource, new URLSearchParams(url.searchParams));
        sendApplicationJson(response, 200, result);
        return;
      }
    }
    throw new DashboardHttpError('not_found', 'Dashboard API route was not found.', 404);
  }

  private async handleAsset(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new DashboardHttpError('method_not_allowed', 'Method not allowed.', 405);
    let asset;
    try {
      await this.options.assets.verifyAvailability();
      asset = await this.options.assets.load(path);
      this.recoveryPlans.clear();
    } catch (error) {
      if (!this.secure && isAssetFailure(error)) {
        const embedded = recoveryAsset(path);
        if (!embedded) throw error;
        response.statusCode = 200;
        response.setHeader('content-type', embedded.contentType);
        response.setHeader('content-length', `${Buffer.byteLength(embedded.body)}`);
        response.setHeader('cache-control', 'no-store');
        response.end(request.method === 'HEAD' ? undefined : embedded.body);
        return;
      }
      throw error;
    }
    response.statusCode = 200;
    response.setHeader('content-type', asset.contentType);
    response.setHeader('content-length', `${asset.bytes.length}`);
    response.setHeader('cache-control', asset.cacheControl);
    response.setHeader('etag', asset.etag);
    if (singleHeader(request, 'if-none-match') === asset.etag) {
      response.statusCode = 304;
      response.removeHeader('content-length');
      response.end();
      return;
    }
    response.end(request.method === 'HEAD' ? undefined : asset.bytes);
  }

  private async streamEvents(request: IncomingMessage, response: ServerResponse, token: string, cursor?: string): Promise<void> {
    const abort = new AbortController();
    request.once('close', () => abort.abort());
    response.once('close', () => abort.abort());
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
    }, 15_000);
    heartbeat.unref();
    const availability = setInterval(() => {
      if (this.authRefreshFailed || !this.options.auth.authenticate(token)) {
        abort.abort();
        if (!response.destroyed) response.destroy();
        return;
      }
      void this.options.assets.verifyAvailability().catch(() => {
        abort.abort();
        if (!response.destroyed) response.destroy();
      });
    }, 2_000);
    availability.unref();
    try {
      for await (const event of this.options.application.events!(abort.signal, cursor)) {
        if (abort.signal.aborted || response.destroyed) break;
        if (this.authRefreshFailed || !this.options.auth.authenticate(token)) {
          abort.abort();
          if (!response.destroyed) response.destroy();
          break;
        }
        try {
          await this.options.assets.verifyAvailability();
        } catch {
          abort.abort();
          if (!response.destroyed) response.destroy();
          break;
        }
        const body = encodeSseEvent(event);
        if (!response.write(body)) await once(response, 'drain', { signal: abort.signal });
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(availability);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }

  private requireExactHost(request: IncomingMessage): void {
    const host = singleHeader(request, 'host');
    if (!host || host.toLowerCase() !== this.origin.host.toLowerCase()) {
      throw new DashboardHttpError('host_rejected', 'Request host is not allowed.', 421);
    }
  }

  private requestSessionToken(request: IncomingMessage): string | undefined {
    const authorization = singleHeader(request, 'authorization');
    if (this.secure) {
      if (authorization !== undefined) {
        throw new DashboardHttpError('authorization_rejected', 'Remote administration accepts only its host-only session cookie.', 400);
      }
      return requestCookie(request, SESSION_COOKIE_REMOTE);
    }
    if (authorization === undefined) return undefined;
    const match = new RegExp(`^${LOCAL_AUTHORIZATION_SCHEME} ([A-Za-z0-9_-]{43})$`, 'u').exec(authorization);
    if (!match) throw new DashboardHttpError('authorization_rejected', 'Local dashboard authorization is invalid.', 401);
    return match[1];
  }

  private requireExactSni(request: IncomingMessage): void {
    if (!this.secure) return;
    const serverName = (request.socket as TLSSocket).servername;
    if (!serverName || normalizedHostname(serverName) !== normalizedHostname(this.origin.hostname)) {
      throw new DashboardHttpError('sni_rejected', 'TLS server name is not allowed.', 421);
    }
  }

  private requireUnsafeBrowserRequest(request: IncomingMessage): void {
    const origin = singleHeader(request, 'origin');
    if (origin !== this.origin.origin) throw new DashboardHttpError('origin_rejected', 'Request origin is not allowed.', 403);
    const fetchSite = singleHeader(request, 'sec-fetch-site');
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      throw new DashboardHttpError('origin_rejected', 'Cross-site requests are not allowed.', 403);
    }
    const contentType = singleHeader(request, 'content-type')?.toLowerCase().replaceAll(/\s+/gu, '');
    if (contentType !== 'application/json' && contentType !== 'application/json;charset=utf-8') {
      throw new DashboardHttpError('content_type_required', 'Requests must use application/json.', 415);
    }
  }

  private requireAuthorizedMutation(request: IncomingMessage, token: string): void {
    this.requireUnsafeBrowserRequest(request);
    const csrf = singleHeader(request, CSRF_HEADER);
    if (!this.options.auth.hasValidCsrf(token, csrf)) throw new DashboardHttpError('csrf_rejected', 'CSRF validation failed.', 403);
  }

  private async checkAssetMode(): Promise<boolean> {
    try {
      await this.options.assets.verifyAvailability();
      this.recoveryPlans.clear();
      return false;
    } catch (error) {
      if (this.secure || !isAssetFailure(error)) throw error;
      return true;
    }
  }

  private async refreshAuth(): Promise<void> {
    try {
      await this.options.authRefresh?.();
      this.authRefreshFailed = false;
    } catch {
      this.authRefreshFailed = true;
      this.options.auth.revokeAll();
    }
  }
}

export function createDashboardServer(options: DashboardServerOptions): DashboardServer {
  return new DashboardServer(options);
}

function normalizeAdminOrigin(input: string): URL {
  const origin = new URL(input);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== input) {
    throw new Error('Dashboard origin must be one canonical HTTP or HTTPS origin without a path.');
  }
  if (origin.protocol === 'http:' && !isLoopbackHostname(origin.hostname)) {
    throw new Error('Plain HTTP dashboard origins must use a loopback hostname.');
  }
  return origin;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '127.0.0.1' || normalized === '::1';
}

function isLoopbackPeer(remoteAddress: string): boolean {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1';
}

function normalizedPeer(remoteAddress: string): string {
  return remoteAddress.startsWith('::ffff:') && isIP(remoteAddress.slice('::ffff:'.length)) === 4
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
}

function canonicalRequestTarget(input: string | undefined): string {
  if (!input || !input.startsWith('/') || input.startsWith('//') || Buffer.byteLength(input) > MAX_REQUEST_TARGET_BYTES
    || hasInvalidTargetCharacter(input)) {
    throw new DashboardHttpError('invalid_request_target', 'Request target is invalid.', 400);
  }
  const rawPath = input.split('?', 1)[0]!;
  if (rawPath.includes('%') || rawPath.includes('//') || rawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new DashboardHttpError('invalid_request_target', 'Request target is not canonical.', 400);
  }
  return input;
}

function hasInvalidTargetCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || character === '\\' || character === '#') return true;
  }
  return false;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = singleHeader(request, 'content-length');
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new DashboardHttpError('body_too_large', 'Request body exceeds the size limit.', 413);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > limit) throw new DashboardHttpError('body_too_large', 'Request body exceeds the size limit.', 413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown;
  } catch {
    throw new DashboardHttpError('invalid_json', 'Request body must be valid JSON.', 400);
  }
}

async function readEmptyJsonBody(request: IncomingMessage, limit: number): Promise<void> {
  const value = await readJsonBody(request, limit);
  if (!isPlainObject(value) || Object.keys(value).length !== 0) {
    throw new DashboardHttpError('invalid_request', 'Request body must be an empty JSON object.', 400);
  }
}

function exactPasswordBody(value: unknown): string {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || typeof value.password !== 'string') {
    throw new DashboardHttpError('invalid_request', 'Password request is invalid.', 400);
  }
  return value.password;
}

function managementRequest(value: unknown): ManagementRequest {
  if (!isPlainObject(value) || typeof value.operation !== 'string'
    || !(MANAGEMENT_OPERATIONS as readonly string[]).includes(value.operation)
    || (value.target !== undefined && (typeof value.target !== 'string' || value.target.length > 256))
    || (value.input !== undefined && !isPlainObject(value.input))) {
    throw new DashboardHttpError('invalid_request', 'Management plan request is invalid.', 400);
  }
  const allowed = new Set(['operation', 'target', 'input']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new DashboardHttpError('invalid_request', 'Management plan request is invalid.', 400);
  return {
    operation: value.operation as ManagementRequest['operation'],
    ...(value.target === undefined ? {} : { target: value.target }),
    ...(value.input === undefined ? {} : { input: value.input }),
  };
}

function executeRequest(value: unknown): { idempotencyKey: string; confirmInterruption?: boolean } {
  if (!isPlainObject(value) || typeof value.idempotencyKey !== 'string' || !IDENTIFIER.test(value.idempotencyKey)
    || (value.confirmInterruption !== undefined && typeof value.confirmInterruption !== 'boolean')
    || Object.keys(value).some((key) => !['idempotencyKey', 'confirmInterruption'].includes(key))) {
    throw new DashboardHttpError('invalid_request', 'Execute request is invalid.', 400);
  }
  return {
    idempotencyKey: value.idempotencyKey,
    ...(value.confirmInterruption === undefined ? {} : { confirmInterruption: value.confirmInterruption }),
  };
}

function rejectUnexpectedReadBody(request: IncomingMessage): void {
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') return;
  const length = singleHeader(request, 'content-length');
  if ((length !== undefined && length !== '0') || singleHeader(request, 'transfer-encoding') !== undefined) {
    throw new DashboardHttpError('invalid_request', 'Read requests must not contain a body.', 400);
  }
}

function queryResource(path: string): string | undefined {
  if (['/api/v1/snapshot', '/api/v1/activity', '/api/v1/backups', '/api/v1/updates', '/api/v1/diagnostics', '/api/v1/settings'].includes(path)) {
    return path.slice('/api/v1'.length);
  }
  const match = /^\/api\/v1\/computers\/([0-9a-f-]{36})(\/(?:clients|credentials|processes|previews|tools|skills))?$/u.exec(path);
  if (!match || !COMPUTER_ID.test(match[1]!)) return undefined;
  return path.slice('/api/v1'.length);
}

function requestCookie(request: IncomingMessage, name: string): string | undefined {
  const raw = singleHeader(request, 'cookie');
  if (!raw || raw.length > 8 * 1024) return undefined;
  const matches = raw.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_REMOTE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`;
}

function expiredSessionCookie(): string {
  return `${SESSION_COOKIE_REMOTE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function lastEventId(request: IncomingMessage): string | undefined {
  const value = singleHeader(request, 'last-event-id');
  if (value === undefined) return undefined;
  if (!EVENT_IDENTIFIER.test(value)) throw new DashboardHttpError('invalid_request', 'Last-Event-ID is invalid.', 400);
  return value;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  let found: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() !== name.toLowerCase()) continue;
    if (found !== undefined) throw new DashboardHttpError('invalid_headers', `Duplicate ${name} header is not allowed.`, 400);
    found = request.rawHeaders[index + 1];
  }
  return found;
}

function encodeSseEvent(event: DashboardApplicationEvent): string {
  if (!EVENT_IDENTIFIER.test(event.id) || (event.event !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/u.test(event.event))) {
    throw new Error('Dashboard application returned an invalid event envelope.');
  }
  assertPublicResponse(event.data);
  const json = JSON.stringify(event.data);
  if (Buffer.byteLength(json) > MAX_SSE_EVENT_BYTES) throw new Error('Dashboard application event exceeds the size limit.');
  return `id: ${event.id}\n${event.event ? `event: ${event.event}\n` : ''}data: ${json.replaceAll('\n', '\ndata: ')}\n\n`;
}

function sendApplicationJson(response: ServerResponse, status: number, value: unknown): void {
  assertPublicResponse(value);
  sendJson(response, status, value);
}

function sendPublicJson(response: ServerResponse, status: number, value: unknown): void {
  sendJson(response, status, value);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > MAX_PUBLIC_RESPONSE_BYTES) throw new Error('Dashboard response exceeds the size limit.');
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', `${Buffer.byteLength(body)}`);
  response.setHeader('cache-control', 'no-store');
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  const known = isPublicHttpError(error);
  const status = known ? error.status : 500;
  const code = known ? error.code : 'internal_error';
  const message = known ? error.message : 'Dashboard request failed.';
  if (known && 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number') {
    response.setHeader('retry-after', `${error.retryAfterSeconds}`);
  }
  sendJson(response, status, { error: { code, message } });
}

function isPublicHttpError(error: unknown): error is Error & { code: string; status: number; retryAfterSeconds?: number } {
  if (error instanceof DashboardHttpError || error instanceof DashboardAuthError || error instanceof DashboardAssetError) return true;
  return error instanceof Error && 'code' in error && 'status' in error
    && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
    && typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
    && error.message.length <= 512;
}

function assertPublicResponse(value: unknown, path = '$', seen = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new Error('Dashboard application response is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && (/^Bearer\s/iu.test(value) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value))) {
      throw new Error('Dashboard application attempted to return secret material.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Dashboard application returned a cyclic response.');
    seen.add(value);
    value.forEach((entry, index) => assertPublicResponse(entry, `${path}[${index}]`, seen, depth + 1));
    return;
  }
  if (!isPlainObject(value) || seen.has(value)) throw new Error('Dashboard application returned a non-JSON response.');
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
    if (FORBIDDEN_RESPONSE_KEYS.has(normalized)) throw new Error(`Dashboard application response contains forbidden field ${path}.${key}.`);
    assertPublicResponse(entry, `${path}.${key}`, seen, depth + 1);
  }
}

function applySecurityHeaders(response: ServerResponse, secure: boolean): void {
  response.setHeader('content-security-policy', [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
    "font-src 'self'", "connect-src 'self'", "worker-src 'none'", "manifest-src 'none'",
  ].join('; '));
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('permissions-policy', 'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  if (secure) response.setHeader('strict-transport-security', 'max-age=86400');
}

function assertTlsIdentity(tls: DashboardTlsOptions, hostname: string): void {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(tls.certificate);
    const matched = isIP(normalizedHostname(hostname))
      ? certificate.checkIP(normalizedHostname(hostname))
      : certificate.checkHost(normalizedHostname(hostname), { subject: 'never' });
    if (!matched) throw new Error('hostname mismatch');
    const now = Date.now();
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error('certificate date');
    const certificateKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const privateKey = createPublicKey(createPrivateKey(tls.privateKey)).export({ type: 'spki', format: 'der' });
    if (certificateKey.length !== privateKey.length || !timingSafeEqual(certificateKey, privateKey)) throw new Error('key mismatch');
  } catch {
    throw new Error('Dashboard TLS certificate, hostname, or private key is invalid.');
  }
}

function isAssetFailure(error: unknown): error is DashboardAssetError {
  return error instanceof DashboardAssetError && error.code !== 'asset_not_found';
}

function recoveryAsset(path: string): { contentType: string; body: string } | undefined {
  if (path === '/' || path === '/index.html') return { contentType: 'text/html; charset=utf-8', body: RECOVERY_HTML };
  if (path === '/recovery.js') return { contentType: 'application/javascript; charset=utf-8', body: RECOVERY_JAVASCRIPT };
  return undefined;
}

const RECOVERY_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qubicl recovery</title></head>
<body>
<main>
<h1>Qubicl recovery</h1>
<p>The dashboard assets are unavailable. This local page can inspect status and run bounded recovery actions.</p>
<form id="login"><label>Administrator password <input id="password" name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>
<section id="controls" hidden>
<button type="button" data-operation="gateway.start">Start gateway</button>
<button type="button" data-operation="dashboard.restart">Restart dashboard</button>
<button type="button" data-operation="recovery.resume">Resume recorded recovery</button>
<button id="refresh" type="button">Refresh status</button>
<button id="logout" type="button">Sign out</button>
</section>
<pre id="status" aria-live="polite">Checking dashboard session…</pre>
</main>
<script src="/recovery.js" defer></script>
</body>
</html>
`;

const RECOVERY_JAVASCRIPT = `'use strict';
const login=document.getElementById('login');
const password=document.getElementById('password');
const controls=document.getElementById('controls');
const status=document.getElementById('status');
let csrf='';
let authorizationToken='';
async function request(path,options={}){
  const headers={...(options.body?{'content-type':'application/json'}:{}),...(csrf?{'x-qubicl-csrf':csrf}:{}),...(authorizationToken?{'authorization':'Qubicl-Session '+authorizationToken}:{})};
  const response=await fetch(path,{...options,headers,credentials:'omit'});
  const value=await response.json();
  if(!response.ok)throw new Error(value.error&&value.error.message||'Recovery request failed.');
  return value;
}
function authenticated(value){if(value.authorizationToken)authorizationToken=value.authorizationToken;else if(!value.authenticated)authorizationToken='';csrf=value.csrfToken||'';login.hidden=Boolean(csrf);controls.hidden=!csrf;}
async function refresh(){
  try{const session=await request('/api/v1/session');authenticated(session);if(csrf){const snapshot=await request('/api/v1/snapshot');status.textContent=JSON.stringify(snapshot,null,2);}else status.textContent='Sign in to inspect recovery status.';}
  catch(error){status.textContent=error.message;}
}
login.addEventListener('submit',async(event)=>{event.preventDefault();try{const value=await request('/api/v1/session/login',{method:'POST',body:JSON.stringify({password:password.value})});password.value='';authenticated(value);await refresh();}catch(error){password.value='';status.textContent=error.message;}});
controls.addEventListener('click',async(event)=>{
  const operation=event.target&&event.target.dataset&&event.target.dataset.operation;
  if(!operation)return;
  try{
    const plan=await request('/api/v1/plans',{method:'POST',body:JSON.stringify({operation})});
    const detail=[...(plan.effects||[]),...(plan.warnings||[])].join('\n');
    if(!confirm((detail?detail+'\n\n':'')+'Run this recovery action?'))return;
    if(plan.requiresReauthentication){
      const reauthPassword=prompt('Re-enter the administrator password to run this recovery action.');
      if(reauthPassword===null)return;
      const reauthenticated=await request('/api/v1/session/reauth',{method:'POST',body:JSON.stringify({password:reauthPassword})});
      authenticated(reauthenticated);
    }
    const result=await request('/api/v1/plans/'+encodeURIComponent(plan.id)+'/execute',{method:'POST',body:JSON.stringify({idempotencyKey:crypto.randomUUID().replaceAll('-',''),confirmInterruption:true})});
    status.textContent='Recovery operation accepted: '+result.operationId;
  }catch(error){status.textContent=error.message;}
});
document.getElementById('refresh').addEventListener('click',refresh);
document.getElementById('logout').addEventListener('click',async()=>{try{await request('/api/v1/session/logout',{method:'POST',body:'{}'});}finally{csrf='';await refresh();}});
let lastActivity=0;
for(const name of ['pointerdown','keydown'])document.addEventListener(name,()=>{const now=Date.now();if(!csrf||now-lastActivity<60000)return;lastActivity=now;void request('/api/v1/session/activity',{method:'POST',body:'{}'}).catch(()=>{});},{passive:true});
void refresh();
`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}
