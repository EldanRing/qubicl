import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  GATEWAY_PROTOCOL_VERSION,
  VIEWER_AUTHENTICATION_HEADER_V1,
  deriveInternalServiceKey,
  previewHostname,
  tokenMatches,
  type RuntimeRoute,
} from '@qubicl/core';
import { RouteStore } from './routes.js';

interface TimedValue { id: string; expiresAt: number; tokenHash: string; controlling: boolean }
interface ViewSession extends TimedValue { key: string }
interface ViewerSocket { socket: Duplex; controlling: boolean }
interface EpochSynchronization {
  signature: string;
  acknowledged: boolean;
  inFlight: boolean;
  nextAttemptAt: number;
  retryDelayMs: number;
}

const VIEWER_KEY_HEADER = 'x-qubicl-viewer-key';

export class Gateway {
  readonly server = createServer((request, response) => void this.handle(request, response));
  private readonly tickets = new Map<string, TimedValue>();
  private readonly sessions = new Map<string, ViewSession>();
  private readonly viewerSockets = new Map<string, Set<ViewerSocket>>();
  private readonly abandonedControlTimers = new Map<string, NodeJS.Timeout>();
  private readonly gatewayEpoch = randomBytes(18).toString('base64url');
  private readonly epochSynchronizations = new Map<string, EpochSynchronization>();
  private readonly epochRequests = new Set<ClientRequest>();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  private closing = false;

  constructor(
    readonly routes: RouteStore,
    private readonly maintenanceIntervalMs = 1_000,
    private readonly abandonedControlGraceMs = 10_000,
  ) {
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
  }

  async start(port: number): Promise<void> {
    this.closing = false;
    await this.routes.start();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.maintainRuntimeState();
    this.heartbeatTimer = setInterval(() => this.maintainRuntimeState(), this.maintenanceIntervalMs);
    this.heartbeatTimer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const request of this.epochRequests) request.destroy();
    this.epochRequests.clear();
    this.epochSynchronizations.clear();
    for (const timer of this.abandonedControlTimers.values()) clearTimeout(timer);
    this.abandonedControlTimers.clear();
    this.routes.close();
    for (const key of this.viewerSockets.keys()) this.closeViewerSockets(key, false);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://gateway.local');
    if (url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        routes: this.routes.list().length,
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        viewerAuthentication: VIEWER_AUTHENTICATION_HEADER_V1,
      });
      return;
    }
    const match = url.pathname.match(/^\/computers\/([a-f0-9-]+)(\/.*)?$/);
    if (!match) {
      sendJson(response, 404, { error: { code: 'not_found', message: 'Route not found.' } });
      return;
    }
    const id = match[1]!;
    const suffix = match[2] ?? '/';
    const route = this.routes.get(id);
    if (!route) {
      sendJson(response, 404, { error: { code: 'computer_not_found', message: 'Computer not found.' } });
      return;
    }
    const previewOrigin = requestHost(request) === previewHostname(id);
    if (previewOrigin !== suffix.startsWith('/previews/')) {
      sendJson(response, 403, { error: { code: 'origin_boundary', message: previewOrigin ? 'The isolated preview origin serves previews only.' : 'Previews must be opened on their isolated localhost origin.' } });
      return;
    }

    const viewerRequest = suffix === '/view-ticket' || suffix === '/view' || suffix.startsWith('/view/')
      || suffix === '/human-control/take' || suffix === '/human-control/release';
    if (viewerRequest && (route.viewPort === undefined || route.controlViewPort === undefined || !route.capabilities.includes('viewer'))) {
      sendJson(response, 404, { error: { code: 'capability_unsupported', message: `The ${route.compatibility} capability contract does not provide a viewer.` } });
      return;
    }

    const browserOpenApiRequest = suffix === '/openapi.json'
      || suffix.startsWith('/v1/tools/')
      || suffix === '/open-terminal'
      || suffix.startsWith('/open-terminal/');
    if (browserOpenApiRequest && request.headers.origin !== undefined) {
      const origin = loopbackBrowserOrigin(request.headers.origin);
      if (!origin) {
        sendJson(response, 403, { error: { code: 'browser_origin_unsupported', message: 'Browser OpenAPI requests must originate from HTTP loopback (127.0.0.1, localhost, or [::1]).' } });
        return;
      }
      applyBrowserCors(response, origin);
      if (request.method === 'OPTIONS') {
        handleBrowserPreflight(request, response, suffix);
        return;
      }
    }

    if (request.method === 'GET' && suffix === '/health') {
      this.proxy(request, response, route, '/health');
      return;
    }
    if (request.method === 'POST' && suffix === '/view-ticket') {
      if (!this.requireBearer(request, response, route)) return;
      this.pruneExpired();
      const ticket = randomBytes(32).toString('base64url');
      this.tickets.set(ticket, { id, expiresAt: Date.now() + 60_000, tokenHash: route.tokenHash, controlling: false });
      sendJson(response, 200, { url: `/computers/${id}/view?ticket=${encodeURIComponent(ticket)}`, expiresInSeconds: 60 });
      return;
    }
    if (request.method === 'GET' && suffix === '/view') {
      const ticket = url.searchParams.get('ticket');
      const found = ticket ? this.tickets.get(ticket) : undefined;
      if (!ticket || !found || found.id !== id || found.tokenHash !== route.tokenHash || found.expiresAt <= Date.now()) {
        sendJson(response, 401, { error: { code: 'invalid_view_ticket', message: 'The view ticket is invalid or expired.' } });
        return;
      }
      this.tickets.delete(ticket);
      const session = randomBytes(32).toString('base64url');
      this.sessions.set(session, { key: session, id, expiresAt: Date.now() + 12 * 60 * 60 * 1000, tokenHash: route.tokenHash, controlling: false });
      response.writeHead(302, {
        location: `/computers/${id}/view/`,
        'set-cookie': `qubicl_view=${session}; HttpOnly; SameSite=Strict; Path=/computers/${id}/`,
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }
    if (suffix === '/view/' && request.method === 'GET') {
      if (!this.requireViewSession(request, response, route)) return;
      const nonce = randomBytes(18).toString('base64url');
      sendHtml(response, viewerHtml(id, route.name, nonce), nonce);
      return;
    }
    if (suffix === '/view/actions' && request.method === 'GET') {
      if (!this.requireViewSession(request, response, route)) return;
      this.proxy(request, response, route, `/_qubicl/view/actions${url.search}`);
      return;
    }
    if (suffix.startsWith('/view/')) {
      if (!this.requireViewSession(request, response, route)) return;
      const targetPath = suffix.slice('/view'.length) + url.search;
      this.proxy(request, response, route, targetPath, true);
      return;
    }
    if ((suffix === '/human-control/take' || suffix === '/human-control/release') && request.method === 'POST') {
      if (!this.requireSameOrigin(request, response)) return;
      const session = this.requireViewSession(request, response, route);
      if (!session) return;
      const taking = suffix === '/human-control/take';
      const existingController = [...this.sessions.values()].find((candidate) => candidate.id === id && candidate.controlling);
      if (taking && existingController && existingController !== session) {
        sendJson(response, 409, { error: { code: 'human_control_owned', message: 'Another viewer session currently controls this computer.' } });
        return;
      }
      if (!taking && !session.controlling) {
        sendJson(response, 409, { error: { code: 'human_control_not_owned', message: 'Only the controlling viewer session can release human control.' } });
        return;
      }
      this.proxy(request, response, route, taking ? '/_qubicl/human/take' : '/_qubicl/human/release', false, () => this.setControllingSession(id, taking ? session : undefined));
      return;
    }

    if (suffix.startsWith('/previews/')) {
      this.proxy(request, response, route, `/_qubicl${suffix}${url.search}`);
      return;
    }

    if (request.method === 'POST' && suffix === '/operator/policy/reload') {
      if (!this.requireOperator(request, response, route)) return;
      this.proxy(request, response, route, '/_qubicl/operator/policy/reload');
      return;
    }
    if (!this.requireBearer(request, response, route)) return;
    if (request.method === 'POST' && suffix === '/operator/human-control/release') {
      this.proxy(request, response, route, '/_qubicl/human/release', false, () => this.setControllingSession(id, undefined));
      return;
    }
    if (suffix === '/mcp'
      || suffix === '/openapi.json'
      || suffix.startsWith('/v1/tools/')
      || suffix === '/open-terminal'
      || suffix.startsWith('/open-terminal/')) {
      this.proxy(request, response, route, suffix + url.search);
      return;
    }
    sendJson(response, 404, { error: { code: 'not_found', message: 'Route not found.' } });
  }

  private requireBearer(request: IncomingMessage, response: ServerResponse, route: RuntimeRoute): boolean {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match || !tokenMatches(match[1]!, route.tokenHash)) {
      response.setHeader('www-authenticate', 'Bearer');
      sendJson(response, 401, { error: { code: 'unauthorized', message: 'A valid computer bearer token is required.' } });
      return false;
    }
    return true;
  }

  private requireOperator(request: IncomingMessage, response: ServerResponse, route: RuntimeRoute): boolean {
    const received = request.headers['x-qubicl-operator-key'];
    if (typeof received === 'string') {
      const left = Buffer.from(received);
      const right = Buffer.from(route.internalKey);
      if (left.length === right.length && timingSafeEqual(left, right)) return true;
    }
    sendJson(response, 401, { error: { code: 'operator_authority_required', message: 'This operation requires local Qubicl operator authority.' } });
    return false;
  }

  private requireViewSession(request: IncomingMessage, response: ServerResponse, route: RuntimeRoute): ViewSession | undefined {
    this.pruneExpired();
    const cookie = request.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith('qubicl_view='));
    const session = cookie?.slice('qubicl_view='.length);
    const found = session ? this.sessions.get(session) : undefined;
    if (!found || found.id !== route.id || found.tokenHash !== route.tokenHash || found.expiresAt <= Date.now()) {
      sendJson(response, 401, { error: { code: 'view_session_required', message: 'Open a fresh view URL with qubicl view.' } });
      return undefined;
    }
    found.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    return found;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.tickets) {
      const route = this.routes.get(value.id);
      if (value.expiresAt <= now || !route || route.tokenHash !== value.tokenHash) this.tickets.delete(key);
    }
    for (const [key, value] of this.sessions) {
      const route = this.routes.get(value.id);
      if (value.expiresAt <= now || !route || route.tokenHash !== value.tokenHash) {
        this.closeViewerSockets(key, false);
        if (value.controlling && route && route.tokenHash === value.tokenHash) {
          if (!this.abandonedControlTimers.has(key)) this.armAbandonedControlRelease(value);
        } else {
          this.clearAbandonedControlRelease(key);
          this.sessions.delete(key);
        }
      }
    }
  }

  private requireSameOrigin(request: IncomingMessage, response: ServerResponse): boolean {
    if (hasExactViewerOrigin(request)) return true;
    sendJson(response, 403, { error: { code: 'origin_mismatch', message: 'Human-control requests must originate from this Qubicl viewer.' } });
    return false;
  }

  private proxy(incoming: IncomingMessage, outgoing: ServerResponse, route: RuntimeRoute, path: string, view = false, onSuccess?: () => void): void {
    if (view && route.viewPort === undefined) {
      sendJson(outgoing, 404, { error: { code: 'capability_unsupported', message: 'This computer does not provide a viewer.' } });
      return;
    }
    const headers = { ...incoming.headers };
    delete headers.authorization;
    delete headers.cookie;
    delete headers.host;
    delete headers['x-qubicl-internal-key'];
    delete headers['x-qubicl-gateway-epoch'];
    delete headers['x-qubicl-operator-key'];
    delete headers[VIEWER_KEY_HEADER];
    if (!view) {
      headers['x-qubicl-internal-key'] = route.internalKey;
      headers['x-qubicl-gateway-epoch'] = this.gatewayEpoch;
    } else if (route.viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1) {
      headers[VIEWER_KEY_HEADER] = deriveInternalServiceKey(route.internalKey, 'viewer');
    }
    const proxied = httpRequest({
      hostname: view ? (route.viewHost ?? route.host) : route.host,
      port: view ? route.viewPort! : route.controlPort,
      method: incoming.method,
      path,
      headers,
      // Computer services are deliberately recreated while retaining their
      // route hostname. Never reuse a socket whose peer belonged to the prior
      // container or pin Docker DNS to that peer across a policy/lifecycle
      // transition.
      agent: false,
    }, (backend) => {
      if ((backend.statusCode ?? 500) >= 200 && (backend.statusCode ?? 500) < 300) onSuccess?.();
      const responseHeaders = { ...backend.headers };
      delete responseHeaders['set-cookie'];
      outgoing.writeHead(backend.statusCode ?? 502, responseHeaders);
      backend.pipe(outgoing);
    });
    proxied.on('error', (error) => {
      if (!outgoing.headersSent) sendJson(outgoing, 502, { error: { code: 'computer_unavailable', message: error.message } });
      else outgoing.destroy(error);
    });
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) proxied.destroy();
    });
    incoming.pipe(proxied);
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://gateway.local');
    const preview = url.pathname.match(/^\/computers\/([a-f0-9-]+)(\/previews\/.*)$/u);
    if (preview) {
      const route = this.routes.get(preview[1]!);
      if (!route) return rejectUpgrade(socket, 404, 'Not Found');
      if (requestHost(request) !== previewHostname(route.id)) return rejectUpgrade(socket, 403, 'Forbidden');
      const origin = request.headers.origin;
      if (origin !== undefined && !hasExactViewerOrigin(request)) return rejectUpgrade(socket, 403, 'Forbidden');
      const backend = connect(route.controlPort, route.host);
      backend.once('connect', () => {
        const lines = [`${request.method ?? 'GET'} /_qubicl${preview[2]}${url.search} HTTP/${request.httpVersion}`];
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          const name = request.rawHeaders[index]!;
          if (['host', 'authorization', 'x-qubicl-internal-key', 'x-qubicl-gateway-epoch', VIEWER_KEY_HEADER].includes(name.toLowerCase())) continue;
          lines.push(`${name}: ${request.rawHeaders[index + 1] ?? ''}`);
        }
        lines.push(`Host: ${route.host}:${route.controlPort}`, `X-Qubicl-Internal-Key: ${route.internalKey}`, `X-Qubicl-Gateway-Epoch: ${this.gatewayEpoch}`, '', '');
        backend.write(lines.join('\r\n'));
        if (head.length) backend.write(head);
        socket.pipe(backend).pipe(socket);
      });
      backend.on('error', () => socket.destroy());
      socket.on('error', () => backend.destroy());
      socket.on('close', () => backend.destroy());
      return;
    }
    const match = url.pathname.match(/^\/computers\/([a-f0-9-]+)\/view\/websockify$/);
    if (!match) return rejectUpgrade(socket, 404, 'Not Found');
    const id = match[1]!;
    const route = this.routes.get(id);
    if (!route) return rejectUpgrade(socket, 401, 'Unauthorized');
    if (requestHost(request) === previewHostname(id)) return rejectUpgrade(socket, 403, 'Forbidden');
    if (route.viewPort === undefined || route.controlViewPort === undefined || !route.capabilities.includes('viewer')) return rejectUpgrade(socket, 404, 'Viewer Unsupported');
    // Reject cross-origin upgrades before looking up (and refreshing) the
    // session or opening any connection to the computer-side viewer.
    if (!hasExactViewerOrigin(request)) return rejectUpgrade(socket, 403, 'Forbidden');
    const session = this.validViewSession(request, route);
    if (!session) return rejectUpgrade(socket, 401, 'Unauthorized');
    const viewPort = session.controlling ? route.controlViewPort : route.viewPort;
    this.trackViewerSocket(session.key, socket, session.controlling);
    const viewHost = route.viewHost ?? route.host;
    const backend = connect(viewPort, viewHost);
    backend.on('connect', () => {
      const lines = [`${request.method ?? 'GET'} /websockify${url.search} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!;
        if (['host', 'cookie', 'authorization', 'x-qubicl-internal-key', VIEWER_KEY_HEADER].includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${request.rawHeaders[index + 1] ?? ''}`);
      }
      lines.push(`Host: ${viewHost}:${viewPort}`);
      if (route.viewerAuthentication === VIEWER_AUTHENTICATION_HEADER_V1) {
        lines.push(`X-Qubicl-Viewer-Key: ${deriveInternalServiceKey(route.internalKey, 'viewer')}`);
      }
      lines.push('', '');
      backend.write(lines.join('\r\n'));
      if (head.length) backend.write(head);
      socket.pipe(backend).pipe(socket);
    });
    backend.on('error', () => socket.destroy());
    backend.on('close', () => socket.destroy());
    socket.on('error', () => backend.destroy());
    socket.on('close', () => backend.destroy());
  }

  private validViewSession(request: IncomingMessage, route: RuntimeRoute): ViewSession | undefined {
    this.pruneExpired();
    const cookie = request.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith('qubicl_view='));
    const session = cookie?.slice('qubicl_view='.length);
    const found = session ? this.sessions.get(session) : undefined;
    if (!found || found.id !== route.id || found.tokenHash !== route.tokenHash || found.expiresAt <= Date.now()) return undefined;
    found.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    return found;
  }

  private setControllingSession(id: string, controller: TimedValue | undefined): void {
    for (const [key, session] of this.sessions) {
      if (session.id !== id) continue;
      const controlling = session === controller;
      if (session.controlling && !controlling) this.closeViewerSockets(key, true);
      session.controlling = controlling;
      if (controlling) this.armAbandonedControlRelease(session);
      else this.clearAbandonedControlRelease(key);
    }
  }

  private trackViewerSocket(key: string, socket: Duplex, controlling: boolean): void {
    const tracked = { socket, controlling };
    const sockets = this.viewerSockets.get(key) ?? new Set<ViewerSocket>();
    sockets.add(tracked);
    this.viewerSockets.set(key, sockets);
    if (controlling) this.clearAbandonedControlRelease(key);
    socket.once('close', () => {
      sockets.delete(tracked);
      if (!sockets.size) this.viewerSockets.delete(key);
      if (controlling) {
        const session = this.sessions.get(key);
        if (session?.controlling) this.armAbandonedControlRelease(session);
      }
    });
  }

  private armAbandonedControlRelease(session: ViewSession): void {
    this.clearAbandonedControlRelease(session.key);
    const timer = setTimeout(() => void this.releaseAbandonedControl(session.key), this.abandonedControlGraceMs);
    timer.unref();
    this.abandonedControlTimers.set(session.key, timer);
  }

  private clearAbandonedControlRelease(key: string): void {
    const timer = this.abandonedControlTimers.get(key);
    if (timer) clearTimeout(timer);
    this.abandonedControlTimers.delete(key);
  }

  private async releaseAbandonedControl(key: string): Promise<void> {
    this.abandonedControlTimers.delete(key);
    if (this.closing) return;
    const session = this.sessions.get(key);
    if (!session?.controlling || this.hasControllingViewerSocket(key)) return;
    const route = this.routes.get(session.id);
    if (!route || route.tokenHash !== session.tokenHash) {
      this.setControllingSession(session.id, undefined);
      return;
    }
    const released = await this.requestHumanRelease(route);
    if (released) this.setControllingSession(session.id, undefined);
    else if (!this.closing && session.controlling && !this.hasControllingViewerSocket(key)) this.armAbandonedControlRelease(session);
  }

  private hasControllingViewerSocket(key: string): boolean {
    return [...(this.viewerSockets.get(key) ?? [])].some(({ controlling, socket }) => controlling && !socket.destroyed);
  }

  private requestHumanRelease(route: RuntimeRoute): Promise<boolean> {
    return new Promise((resolve) => {
      const request = httpRequest({
        hostname: route.host,
        port: route.controlPort,
        method: 'POST',
        path: '/_qubicl/human/release',
        agent: false,
        headers: {
          'content-length': '0',
          'x-qubicl-internal-key': route.internalKey,
          'x-qubicl-gateway-epoch': this.gatewayEpoch,
        },
        timeout: 2_000,
      }, (response) => {
        response.resume();
        response.once('end', () => resolve((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300));
        response.once('error', () => resolve(false));
        response.once('aborted', () => resolve(false));
      });
      request.once('timeout', () => request.destroy());
      request.once('error', () => resolve(false));
      request.end();
    });
  }

  private closeViewerSockets(key: string, controllingOnly: boolean): void {
    const sockets = this.viewerSockets.get(key);
    if (!sockets) return;
    for (const tracked of [...sockets]) {
      if (!controllingOnly || tracked.controlling) tracked.socket.destroy();
    }
  }

  private maintainRuntimeState(): void {
    this.pruneExpired();
    this.synchronizeGatewayEpoch();
  }

  private synchronizeGatewayEpoch(): void {
    const routes = this.routes.list();
    const routeIds = new Set(routes.map(({ id }) => id));
    for (const id of this.epochSynchronizations.keys()) {
      if (!routeIds.has(id)) this.epochSynchronizations.delete(id);
    }
    for (const route of routes) {
      const signature = `${route.host}:${route.controlPort}:${route.internalKey}`;
      let synchronization = this.epochSynchronizations.get(route.id);
      if (!synchronization || synchronization.signature !== signature) {
        synchronization = { signature, acknowledged: false, inFlight: false, nextAttemptAt: 0, retryDelayMs: 1_000 };
        this.epochSynchronizations.set(route.id, synchronization);
      }
      if (synchronization.acknowledged || synchronization.inFlight || synchronization.nextAttemptAt > Date.now()) continue;
      synchronization.inFlight = true;
      const heartbeat = httpRequest({
        hostname: route.host,
        port: route.controlPort,
        method: 'POST',
        path: '/_qubicl/gateway-epoch',
        agent: false,
        headers: {
          'content-length': '0',
          'x-qubicl-internal-key': route.internalKey,
          'x-qubicl-gateway-epoch': this.gatewayEpoch,
        },
        timeout: 2_000,
      }, (response) => {
        response.resume();
        response.once('end', () => this.finishEpochSynchronization(route.id, synchronization!, (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300));
        response.once('error', () => this.finishEpochSynchronization(route.id, synchronization!, false));
        response.once('aborted', () => this.finishEpochSynchronization(route.id, synchronization!, false));
      });
      this.epochRequests.add(heartbeat);
      heartbeat.once('close', () => this.epochRequests.delete(heartbeat));
      heartbeat.on('timeout', () => heartbeat.destroy());
      heartbeat.on('error', () => this.finishEpochSynchronization(route.id, synchronization!, false));
      heartbeat.end();
    }
  }

  private finishEpochSynchronization(id: string, synchronization: EpochSynchronization, acknowledged: boolean): void {
    if (this.epochSynchronizations.get(id) !== synchronization || !synchronization.inFlight) return;
    synchronization.inFlight = false;
    if (acknowledged) {
      synchronization.acknowledged = true;
      return;
    }
    synchronization.nextAttemptAt = Date.now() + synchronization.retryDelayMs;
    synchronization.retryDelayMs = Math.min(synchronization.retryDelayMs * 2, 30_000);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, body: string, nonce: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; frame-src 'self'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function hasExactViewerOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return false;
  const expected = `http://${host}`;
  if (origin !== expected) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.origin === expected;
  } catch {
    return false;
  }
}

function requestHost(request: IncomingMessage): string | undefined {
  const value = request.headers.host;
  if (typeof value !== 'string') return undefined;
  try { return new URL(`http://${value}`).hostname; } catch { return undefined; }
}

function loopbackBrowserOrigin(value: string | string[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' || parsed.origin !== value) return undefined;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function applyBrowserCors(response: ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', appendVary(response.getHeader('vary'), 'Origin'));
}

function handleBrowserPreflight(request: IncomingMessage, response: ServerResponse, suffix: string): void {
  const expectedMethods = browserMethods(suffix);
  const requestedMethod = request.headers['access-control-request-method'];
  const requestedHeaders = (request.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = suffix === '/openapi.json' || suffix.startsWith('/v1/tools/')
    ? ['authorization', 'content-type']
    : ['authorization', 'content-type', 'x-session-id'];
  if (typeof requestedMethod !== 'string'
    || !expectedMethods.includes(requestedMethod)
    || requestedHeaders.some((value) => !allowedHeaders.includes(value))) {
    sendJson(response, 403, { error: { code: 'cors_preflight_rejected', message: 'Browser OpenAPI preflight requested an unsupported method or header.' } });
    return;
  }
  response.setHeader('access-control-allow-methods', expectedMethods.join(', '));
  response.setHeader('access-control-allow-headers', allowedHeaders.map(headerName).join(', '));
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', appendVary(response.getHeader('vary'), 'Access-Control-Request-Method', 'Access-Control-Request-Headers'));
  response.writeHead(204);
  response.end();
}

function browserMethods(suffix: string): string[] {
  if (suffix === '/openapi.json') return ['GET'];
  if (suffix.startsWith('/v1/tools/')) return ['POST'];
  if (suffix.endsWith('/open-terminal/execute')) return ['GET', 'POST'];
  if (/\/open-terminal\/execute\/[A-Za-z0-9_-]{16,64}\/status$/u.test(suffix)) return ['GET'];
  if (/\/open-terminal\/execute\/[A-Za-z0-9_-]{16,64}\/input$/u.test(suffix)) return ['POST'];
  if (/\/open-terminal\/execute\/[A-Za-z0-9_-]{16,64}$/u.test(suffix)) return ['DELETE'];
  if (suffix.endsWith('/open-terminal/files/cwd')) return ['GET', 'POST'];
  if (suffix.endsWith('/files/delete')) return ['DELETE'];
  if (suffix.includes('/v1/tools/')
    || suffix.endsWith('/files/upload')
    || suffix.endsWith('/files/mkdir')
    || suffix.endsWith('/files/move')
    || suffix.endsWith('/files/archive')) return ['POST'];
  return ['GET'];
}

function headerName(value: string): string {
  switch (value) {
    case 'authorization': return 'Authorization';
    case 'content-type': return 'Content-Type';
    case 'x-session-id': return 'X-Session-Id';
    default: return value;
  }
}

function appendVary(current: number | string | readonly string[] | undefined, ...values: string[]): string {
  const entries = (Array.isArray(current) ? current : current === undefined ? [] : `${current}`.split(','))
    .map((value) => `${value}`.trim())
    .filter(Boolean);
  for (const value of values) {
    if (!entries.some((entry) => entry.toLowerCase() === value.toLowerCase())) entries.push(value);
  }
  return entries.join(', ');
}

export function mapViewerPointerToCanvas(
  point: { x: number; y: number },
  display: { width: number; height: number },
  canvas: { left: number; top: number; width: number; height: number },
): { x: number; y: number } | undefined {
  const values = [point.x, point.y, display.width, display.height, canvas.left, canvas.top, canvas.width, canvas.height];
  if (values.some((value) => !Number.isFinite(value)) || display.width <= 0 || display.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return undefined;
  return {
    x: canvas.left + point.x * canvas.width / display.width,
    y: canvas.top + point.y * canvas.height / display.height,
  };
}

function viewerHtml(id: string, name: string, nonce: string): string {
  const vncPath = encodeURIComponent(`/computers/${id}/view/websockify`);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)} — Qubicl</title>
<style nonce="${nonce}">
html,body{height:100%;margin:0;background:#111;color:#eee;font:14px system-ui}body{display:grid;grid-template-rows:auto 1fr}header{display:flex;align-items:center;gap:.75rem;padding:.55rem .8rem;background:#1d1d1d;flex-wrap:wrap}button{padding:.4rem .7rem}#state{opacity:.85}#policy,#profile-durability{flex-basis:100%;font-size:.85rem;opacity:.7}#stage{position:relative;min-height:0;overflow:hidden}iframe,#agent-layer{position:absolute;inset:0;width:100%;height:100%;border:0}#agent-layer{z-index:2;pointer-events:none}.agent-pointer{opacity:0}.agent-pointer.visible{opacity:1}.agent-ring{fill:none;stroke:#b8e34a;stroke-width:4;opacity:0;vector-effect:non-scaling-stroke;transform-box:fill-box;transform-origin:center}.agent-pointer.pulse .agent-ring{animation:agent-ring 620ms ease-out}.agent-ring-second{opacity:0}.agent-pointer.double_click.pulse .agent-ring-second{animation:agent-ring-second 620ms ease-out}.agent-pointer.right_click .agent-ring{stroke-dasharray:4 3}.agent-cursor{fill:#b8e34a;stroke:#17200a;stroke-width:2;paint-order:stroke;vector-effect:non-scaling-stroke;filter:drop-shadow(0 1px 2px #000)}@keyframes agent-ring{0%{transform:scale(.35);opacity:1}100%{transform:scale(1.45);opacity:0}}@keyframes agent-ring-second{10%{transform:scale(.35);opacity:1}100%{transform:scale(1.9);opacity:0}}@media(prefers-reduced-motion:reduce){.agent-pointer.pulse .agent-ring,.agent-pointer.double_click.pulse .agent-ring-second{animation:none}}
</style></head>
<body><header><strong>${escapeHtml(name)}</strong><button id="take">Take control</button><button id="release">Release control</button><button id="agent-toggle" type="button" aria-pressed="true">Agent pointer: on</button><span id="state">Observer mode</span><span id="policy">Take control stops agent commands. Desktop-session applications and the managed browser stay open. Closing this viewer releases control after 10 seconds.</span><span id="profile-durability">Chromium profile data is durable and survives restarts and upgrades.</span></header>
<main id="stage"><iframe id="desktop" src="/computers/${id}/view/vnc.html?autoconnect=true&resize=scale&view_only=true&path=${vncPath}" allow="clipboard-read; clipboard-write"></iframe><svg id="agent-layer" aria-hidden="true"><g id="agent-pointer" class="agent-pointer"><circle class="agent-ring" cx="0" cy="0" r="15"></circle><circle class="agent-ring agent-ring-second" cx="0" cy="0" r="15"></circle><path class="agent-cursor" d="M0 0 28 17 17 21 12 34Z"></path></g></svg></main>
<script nonce="${nonce}">
const mapViewerPointerToCanvas=(${mapViewerPointerToCanvas.toString()});
const state=document.querySelector('#state'),stage=document.querySelector('#stage'),desktop=document.querySelector('#desktop'),pointer=document.querySelector('#agent-pointer'),toggle=document.querySelector('#agent-toggle');
let pointerEnabled=true,actionSequence=0,polling=true,currentPointer=null,display={width:1440,height:900};
try{pointerEnabled=localStorage.getItem('qubicl-agent-pointer')!=='off'}catch{}
function updateToggle(){toggle.textContent='Agent pointer: '+(pointerEnabled?'on':'off');toggle.setAttribute('aria-pressed',String(pointerEnabled));if(pointerEnabled)renderPointer(false);else pointer.setAttribute('class','agent-pointer')}
function setViewOnly(value){const url=new URL(desktop.src);url.searchParams.set('view_only',String(value));desktop.src=url}
function counted(value,singular,plural){return value+' '+(value===1?singular:plural)}
async function control(action){const taking=action==='take';if(taking)state.textContent='Taking control — fencing agent tools…';const response=await fetch('../human-control/'+action,{method:'POST'});const value=await response.json();if(!response.ok)throw new Error(value.error?.message||response.statusText);if(taking)hidePointer();setViewOnly(!taking);state.textContent=taking?'Human control active — agent tools fenced; '+counted(value.preservedDesktopApplications||0,'desktop application','desktop applications')+' and '+counted(value.preservedBrowserSessions||0,'managed browser','managed browsers')+' preserved; '+counted(value.terminatedManagedProcesses||0,'managed command','managed commands')+' stopped.':'Observer mode — agent access requires a fresh lease.'}
function validState(value){return value&&Number.isFinite(value.x)&&Number.isFinite(value.y)&&typeof value.kind==='string'}
function framebufferRect(){const stageRect=stage.getBoundingClientRect(),frameRect=desktop.getBoundingClientRect();try{const canvas=desktop.contentDocument&&desktop.contentDocument.querySelector('#noVNC_canvas');if(canvas){const rect=canvas.getBoundingClientRect();if(rect.width>0&&rect.height>0)return{left:frameRect.left-stageRect.left+rect.left,top:frameRect.top-stageRect.top+rect.top,width:rect.width,height:rect.height}}}catch{}const scale=Math.min(frameRect.width/display.width,frameRect.height/display.height),width=display.width*scale,height=display.height*scale;return{left:frameRect.left-stageRect.left+(frameRect.width-width)/2,top:frameRect.top-stageRect.top+(frameRect.height-height)/2,width,height}}
function renderPointer(pulse){if(!pointerEnabled||!validState(currentPointer)){pointer.setAttribute('class','agent-pointer');return}const point=mapViewerPointerToCanvas(currentPointer,display,framebufferRect());if(!point){pointer.setAttribute('class','agent-pointer');return}pointer.setAttribute('transform','translate('+point.x+' '+point.y+')');pointer.setAttribute('class','agent-pointer visible '+currentPointer.kind);if(pulse){pointer.getBoundingClientRect();pointer.classList.add('pulse')}}
function hidePointer(){currentPointer=null;pointer.setAttribute('class','agent-pointer')}
function applyPayload(value,initial){if(value&&value.display&&Number.isFinite(value.display.width)&&Number.isFinite(value.display.height)&&value.display.width>0&&value.display.height>0)display=value.display;if(value&&Number.isSafeInteger(value.latestSequence))actionSequence=value.latestSequence;const events=value&&Array.isArray(value.events)?value.events:[];const event=events.at(-1);if(event&&event.type==='hide')hidePointer();else if(event&&event.type==='show'&&validState(event)){currentPointer=event;renderPointer(Boolean(event.pulse)&&Date.now()-event.occurredAt<1200)}else if(initial||!events.length){if(value&&validState(value.current)){currentPointer=value.current;renderPointer(false)}else if(value&&value.current===null)hidePointer()}}
async function poll(){while(polling){try{const response=await fetch('actions?after='+actionSequence+'&wait=1',{cache:'no-store'});if(response.status===401){polling=false;break}if(response.ok)applyPayload(await response.json(),false);else await new Promise(resolve=>setTimeout(resolve,500))}catch{if(polling)await new Promise(resolve=>setTimeout(resolve,500))}}}
async function initializePointer(){try{const response=await fetch('actions?after=9007199254740991',{cache:'no-store'});if(response.ok)applyPayload(await response.json(),true)}catch{}void poll()}
function refreshPointerLayout(){renderPointer(false)}
desktop.addEventListener('load',()=>{refreshPointerLayout();setTimeout(refreshPointerLayout,250);setTimeout(refreshPointerLayout,1000)});new ResizeObserver(refreshPointerLayout).observe(stage);window.addEventListener('resize',refreshPointerLayout);
toggle.onclick=()=>{pointerEnabled=!pointerEnabled;try{localStorage.setItem('qubicl-agent-pointer',pointerEnabled?'on':'off')}catch{}updateToggle()};document.querySelector('#take').onclick=()=>control('take').catch(e=>state.textContent=e.message);document.querySelector('#release').onclick=()=>control('release').catch(e=>state.textContent=e.message);window.addEventListener('pagehide',()=>{polling=false});updateToggle();void initializePointer();
</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
