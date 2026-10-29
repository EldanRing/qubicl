import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { Script, createContext } from 'node:vm';
import { Gateway } from '@qubicl/gateway/server';
import { RouteStore } from '@qubicl/gateway/routes';
import { hashToken, presetDefaults, previewHostname } from '@qubicl/core';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(context: TestContext, grace = 10_000) {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-viewer-races-'));
  const sockets = new Set<Duplex>();
  const calls: string[] = [];
  let upstreamViewerConnections = 0;
  let handler: ((path: string, response: ServerResponse) => boolean) | undefined;
  const backend = createServer((request, response) => {
    const path = request.url ?? '';
    calls.push(path);
    if (handler?.(path, response)) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  backend.on('upgrade', (_request, socket) => {
    upstreamViewerConnections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = (backend.address() as { port: number }).port;
  const id = '00000000-0000-4000-8000-000000000191';
  const defaults = presetDefaults('workstation');
  const path = join(directory, 'routes.json');
  await writeFile(path, JSON.stringify({ version: 3, generatedAt: new Date().toISOString(), routes: [{
    id, name: 'viewer-races', host: '127.0.0.1', controlPort: backendPort, viewPort: backendPort, controlViewPort: backendPort,
    preset: defaults.preset, compatibility: defaults.compatibility, capabilities: defaults.capabilities,
    manifestSha256: defaults.image.manifestSha256!, tokenHash: hashToken('fixture'), internalKey: 'fixture-internal-key-long-enough-for-validation',
  }] }));
  const gateway = new Gateway(new RouteStore(path), 60_000, grace);
  await gateway.start(0);
  const port = (gateway.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/computers/${id}`;
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await gateway.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const newSession = async () => {
    const ticket = await fetch(`${base}/view-ticket`, { method: 'POST', headers: { authorization: 'Bearer fixture' } }).then((response) => response.json()) as { url: string };
    const exchange = await fetch(`${origin}${ticket.url}`, { redirect: 'manual' });
    assert.equal(exchange.status, 302);
    return exchange.headers.get('set-cookie')!.split(';')[0]!;
  };
  const control = (cookie: string, action: string) => fetch(`${base}/human-control/${action}`, { method: 'POST', headers: { cookie, origin } });
  const status = (cookie: string) => fetch(`${base}/human-control/status`, { headers: { cookie } }).then((response) => response.json()) as Promise<{ controlling: boolean; reconnectDeadline: string | null }>;
  const websocket = async (cookie: string): Promise<Duplex> => new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', reject);
    socket.once('connect', () => socket.write([
      `GET /computers/${id}/view/websockify HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: ${origin}`,
      'Connection: Upgrade', 'Upgrade: websocket', `Cookie: ${cookie}`, '', '',
    ].join('\r\n')));
    socket.once('data', (chunk) => {
      assert.match(chunk.toString(), /^HTTP\/1\.1 101/);
      resolve(socket);
    });
  });
  return { gateway, base, origin, port, calls, newSession, control, status, websocket, viewerConnections: () => upstreamViewerConnections, setHandler: (value: typeof handler) => { handler = value; } };
}

test('gateway serializes concurrent viewer takeovers and rechecks the exclusive owner', { timeout: 10_000 }, async (context) => {
  const env = await fixture(context);
  const first = await env.newSession();
  const second = await env.newSession();
  const arrived = deferred<ServerResponse>();
  env.setHandler((path, response) => {
    if (path !== '/_qubicl/human/take') return false;
    arrived.resolve(response);
    return true;
  });
  const firstResult = env.control(first, 'take');
  const pending = await arrived.promise;
  const secondArrived = new Promise<void>((resolve) => env.gateway.server.once('request', () => resolve()));
  const secondResult = env.control(second, 'take');
  await secondArrived;
  pending.writeHead(200, { 'content-type': 'application/json' });
  pending.end('{"controller":"human"}');
  assert.equal((await firstResult).status, 200);
  assert.equal((await secondResult).status, 409);
  assert.equal(env.calls.filter((path) => path === '/_qubicl/human/take').length, 1);
  assert.equal((await env.status(first)).controlling, true);
  assert.equal((await env.status(second)).controlling, false);
  assert.equal((await env.control(second, 'release')).status, 409);
  assert.equal((await env.control(first, 'release')).status, 200);
  env.setHandler(undefined);
  assert.equal((await env.control(second, 'take')).status, 200, 'queue remains usable after an ownership conflict');
});

test('reconnecting during automatic release restores the backend fence and preserves the new viewer', { timeout: 10_000 }, async (context) => {
  const env = await fixture(context, 30);
  const cookie = await env.newSession();
  const releaseArrived = deferred<ServerResponse>();
  const restored = deferred<ServerResponse>();
  let takes = 0;
  env.setHandler((path, response) => {
    if (path === '/_qubicl/human/release') { releaseArrived.resolve(response); return true; }
    if (path === '/_qubicl/human/take' && ++takes === 2) { restored.resolve(response); return true; }
    return false;
  });
  assert.equal((await env.control(cookie, 'take')).status, 200);
  const pendingRelease = await releaseArrived.promise;
  const upgradeSeen = new Promise<void>((resolve) => env.gateway.server.once('upgrade', () => resolve()));
  const reconnecting = env.websocket(cookie);
  await upgradeSeen;
  pendingRelease.writeHead(200, { 'content-type': 'application/json' });
  pendingRelease.end('{}');
  const pendingRestore = await restored.promise;
  assert.equal(env.viewerConnections(), 0, 'reconnected viewer cannot forward input before the backend fence is restored');
  pendingRestore.writeHead(200, { 'content-type': 'application/json' });
  pendingRestore.end('{}');
  const reconnected = await reconnecting;
  const status = await env.status(cookie);
  assert.equal(status.controlling, true);
  assert.equal(status.reconnectDeadline, null);
  assert.equal(reconnected.destroyed, false);
  assert.equal(takes, 2, 'successful backend release must be countered by a new takeover, not only a local flag');
  env.setHandler(undefined);
  assert.equal((await env.control(cookie, 'release')).status, 200);
  assert.equal((await env.status(cookie)).controlling, false);
});

test('viewer status restores input mode in both directions without reloading unchanged state or accepting an old poll', { timeout: 10_000 }, async (context) => {
  const env = await fixture(context);
  const cookie = await env.newSession();
  const html = await fetch(`${env.base}/view/`, { headers: { cookie } }).then((response) => response.text());
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const staleStatus = deferred<{ ok: boolean; json(): Promise<unknown> }>();
  const explicitTake = deferred<{ ok: boolean; json(): Promise<unknown> }>();
  let reloads = 0;
  let frameSource = `${env.base}/view/vnc.html?view_only=true`;
  const node = () => ({ textContent: '', setAttribute: () => undefined, addEventListener: () => undefined, classList: { add: () => undefined } });
  const nodes = new Map<string, ReturnType<typeof node>>();
  for (const id of ['state', 'stage', 'desktop', 'agent-pointer', 'agent-toggle', 'take', 'release']) nodes.set(`#${id}`, node());
  const desktop = nodes.get('#desktop')!;
  Object.defineProperty(desktop, 'src', { get: () => frameSource, set: (value: URL) => { frameSource = String(value); reloads += 1; } });
  const vm = createContext({
    URL, Date, Number, Math, String, Promise,
    document: { querySelector: (selector: string) => nodes.get(selector) },
    localStorage: { getItem: () => null }, window: { addEventListener: () => undefined },
    ResizeObserver: class { observe() {} }, setTimeout: () => 0,
    fetch: (path: string) => path.endsWith('/status') ? staleStatus.promise : path.endsWith('/take') ? explicitTake.promise : new Promise(() => undefined),
  });
  new Script(script).runInContext(vm);
  const functions = new Script('({ applyControlStatus, control })').runInContext(vm) as {
    applyControlStatus(value: { controlling: boolean; reconnectDeadline: string | null }): void;
    control(action: string): Promise<void>;
  };
  functions.applyControlStatus({ controlling: true, reconnectDeadline: null });
  assert.equal(new URL(frameSource).searchParams.get('view_only'), 'false', 'page reload recovers an already controlling session');
  functions.applyControlStatus({ controlling: true, reconnectDeadline: null });
  assert.equal(reloads, 1, 'unchanged polling does not interrupt a healthy websocket');
  functions.applyControlStatus({ controlling: true, reconnectDeadline: new Date(Date.now() + 1_000).toISOString() });
  assert.match(nodes.get('#state')!.textContent, /interrupted/);
  functions.applyControlStatus({ controlling: true, reconnectDeadline: null });
  assert.match(nodes.get('#state')!.textContent, /Human control active/);
  functions.applyControlStatus({ controlling: false, reconnectDeadline: null });
  assert.equal(new URL(frameSource).searchParams.get('view_only'), 'true');
  assert.match(nodes.get('#state')!.textContent, /Observer mode/);
  const taking = functions.control('take');
  explicitTake.resolve({ ok: true, json: async () => ({}) });
  await taking;
  staleStatus.resolve({ ok: true, json: async () => ({ controlling: false, reconnectDeadline: null }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(new URL(frameSource).searchParams.get('view_only'), 'false', 'poll started before take must not overwrite its result');
});

test('truncated gateway backend responses terminate downstream and release the control queue', { timeout: 10_000 }, async (context) => {
  const env = await fixture(context);
  const cookie = await env.newSession();
  env.setHandler((path, response) => {
    const preview = path.startsWith('/_qubicl/previews/');
    if (path !== '/_qubicl/human/take' && !preview) return false;
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100', ...(preview ? { 'set-cookie': 'preview=fixture; HttpOnly' } : {}) });
    response.write('{');
    setImmediate(() => response.destroy());
    return true;
  });
  const redirect = await new Promise<{ status: number | undefined; location: string | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest(`${env.base}/previews/fixture/?ticket=one-time`, {
      headers: { host: `${previewHostname('00000000-0000-4000-8000-000000000191')}:${env.port}` },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (value: string) => { body += value; });
      response.once('end', () => resolve({ status: response.statusCode, location: response.headers.location, body }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(redirect.status, 302, 'a completed credential-scrubbing redirect survives later upstream abort');
  assert.equal(redirect.location, '/computers/00000000-0000-4000-8000-000000000191/previews/fixture/');
  assert.equal(redirect.body, '');
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(`${env.base}/human-control/take`, { method: 'POST', headers: { cookie, origin: env.origin } }, (response) => {
      response.resume();
      response.once('aborted', resolve);
      response.once('error', () => resolve());
      response.once('end', () => reject(new Error('truncated payload must not appear complete')));
    });
    request.once('error', () => resolve());
    request.end();
  });
  env.setHandler(undefined);
  assert.equal((await env.control(cookie, 'release')).status, 200, 'aborted backend response cannot wedge the transition queue');
});
