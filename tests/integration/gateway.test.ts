import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { Script } from 'node:vm';
import { Gateway, mapViewerPointerToCanvas } from '@qubicl/gateway/server';
import { RouteStore } from '@qubicl/gateway/routes';
import { deriveInternalServiceKey, hashToken, presetDefaults, previewHostname } from '@qubicl/core';

const workstation = presetDefaults('workstation');
const fileSystem = presetDefaults('file-system');

test('viewer pointer maps through the actual noVNC canvas offset and scale', () => {
  assert.deepEqual(mapViewerPointerToCanvas(
    { x: 720, y: 450 },
    { width: 1_440, height: 900 },
    { left: 80, top: 35, width: 960, height: 600 },
  ), { x: 560, y: 335 });
  assert.deepEqual(mapViewerPointerToCanvas(
    { x: 1_440, y: 900 },
    { width: 1_440, height: 900 },
    { left: 0, top: 120, width: 1_440, height: 900 },
  ), { x: 1_440, y: 1_020 });
  assert.equal(mapViewerPointerToCanvas(
    { x: 10, y: 20 },
    { width: 0, height: 900 },
    { left: 0, top: 0, width: 1_440, height: 900 },
  ), undefined);
});

function route(id: string, name: string, controlPort: number, token: string, internalKey: string, viewPort = controlPort, controlViewPort = controlPort, authenticatedViewer = false) {
  return {
    id,
    name,
    host: '127.0.0.1',
    controlPort,
    viewPort,
    controlViewPort,
    ...(authenticatedViewer ? { viewerAuthentication: 'header-v1' as const } : {}),
    preset: workstation.preset,
    compatibility: workstation.compatibility,
    capabilities: workstation.capabilities,
    manifestSha256: workstation.image.manifestSha256!,
    tokenHash: hashToken(token),
    internalKey,
  };
}

test('gateway exposes no viewer surface for a non-viewer route', async (context) => {
  const backend = createServer((_request, response) => { response.writeHead(200); response.end('{}'); });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-no-viewer-'));
  const routesPath = join(directory, 'routes.json');
  const id = '00000000-0000-4000-8000-000000000099';
  await writeFile(routesPath, JSON.stringify({
    version: 2,
    generatedAt: new Date().toISOString(),
    routes: [{
      id,
      name: 'files',
      host: '127.0.0.1',
      controlPort: backendPort,
      preset: fileSystem.preset,
      compatibility: fileSystem.compatibility,
      capabilities: fileSystem.capabilities,
      manifestSha256: fileSystem.image.manifestSha256!,
      tokenHash: hashToken('token'),
      internalKey: 'internal-key-that-is-definitely-long-enough',
    }],
  }));
  const gateway = new Gateway(new RouteStore(routesPath));
  await gateway.start(0);
  context.after(() => gateway.close());
  const port = (gateway.server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/computers/${id}/view-ticket`, { method: 'POST', headers: { authorization: 'Bearer token' } });
  assert.equal(response.status, 404);
  assert.match(JSON.stringify(await response.json()), /capability_unsupported/);
});

test('gateway authenticates, proxies internal credentials, and hot-reloads token hashes', async (context) => {
  let internalKey: string | undefined;
  let gatewayEpoch: string | undefined;
  const backend = createServer((request, response) => {
    internalKey = request.headers['x-qubicl-internal-key'] as string | undefined;
    gatewayEpoch = request.headers['x-qubicl-gateway-epoch'] as string | undefined;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url }));
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-gateway-'));
  const routesPath = join(directory, 'routes.json');
  const id = '00000000-0000-4000-8000-000000000001';
  const writeRoutes = async (token: string): Promise<void> => {
    const temporary = `${routesPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), routes: [route(id, 'qubicl-1', backendPort, token, 'internal-key-that-is-definitely-long-enough')] }));
    await rename(temporary, routesPath);
  };
  await writeRoutes('first');
  const gateway = new Gateway(new RouteStore(routesPath));
  await gateway.start(0);
  context.after(() => gateway.close());
  const port = (gateway.server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/computers/${id}/openapi.json`;

  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer first' } })).status, 200);
  assert.equal(internalKey, 'internal-key-that-is-definitely-long-enough');
  assert.ok(gatewayEpoch);

  await writeRoutes('second');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer first' } })).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer second' } })).status, 200);

  await writeFile(routesPath, '{');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer second' } })).status, 200);
  await writeFile(routesPath, JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), routes: [route(id, 'qubicl-1', backendPort, 'third', 'internal-key-that-is-definitely-long-enough')] }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer second' } })).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer third' } })).status, 200);
});

test('gateway permits authenticated browser OpenAPI calls only from loopback HTTP origins', async (context) => {
  let backendRequests = 0;
  const backend = createServer((request, response) => {
    if (request.url !== '/_qubicl/gateway-epoch') backendRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url }));
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-browser-openapi-'));
  const routesPath = join(directory, 'routes.json');
  const id = '00000000-0000-4000-8000-000000000003';
  await writeFile(routesPath, JSON.stringify({
    version: 2,
    generatedAt: new Date().toISOString(),
    routes: [route(id, 'browser-openapi', backendPort, 'token', 'internal-key-that-is-definitely-long-enough')],
  }));
  const gateway = new Gateway(new RouteStore(routesPath));
  await gateway.start(0);
  context.after(() => gateway.close());
  const port = (gateway.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/computers/${id}`;
  const origin = 'http://127.0.0.1:3000';

  const specPreflight = await fetch(`${base}/openapi.json`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(specPreflight.status, 204);
  assert.equal(specPreflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(specPreflight.headers.get('access-control-allow-methods'), 'GET');
  assert.match(specPreflight.headers.get('access-control-allow-headers') ?? '', /Authorization/);
  assert.equal(backendRequests, 0);

  const toolPreflight = await fetch(`${base}/v1/tools/acquire_lease`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
  assert.equal(toolPreflight.status, 204);
  assert.equal(toolPreflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(toolPreflight.headers.get('access-control-allow-methods'), 'POST');
  assert.equal(backendRequests, 0);

  const unauthorized = await fetch(`${base}/openapi.json`, { headers: { origin } });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), origin);
  assert.equal(backendRequests, 0);

  const spec = await fetch(`${base}/openapi.json`, { headers: { origin, authorization: 'Bearer token' } });
  assert.equal(spec.status, 200);
  assert.equal(spec.headers.get('access-control-allow-origin'), origin);
  assert.match(spec.headers.get('vary') ?? '', /Origin/);
  assert.equal(backendRequests, 1);

  for (const rejectedOrigin of ['https://127.0.0.1:3000', 'http://example.com', 'null', 'not-an-origin']) {
    const rejected = await fetch(`${base}/v1/tools/acquire_lease`, {
      method: 'POST',
      headers: { origin: rejectedOrigin, authorization: 'Bearer token', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(rejected.status, 403, rejectedOrigin);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null, rejectedOrigin);
  }
  assert.equal(backendRequests, 1);

  const rejectedPreflight = await fetch(`${base}/v1/tools/acquire_lease`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'DELETE',
      'access-control-request-headers': 'x-unbounded-header',
    },
  });
  assert.equal(rejectedPreflight.status, 403);
  assert.equal(backendRequests, 1);

  const mcp = await fetch(`${base}/mcp`, { headers: { origin, authorization: 'Bearer token' } });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.headers.get('access-control-allow-origin'), null);
  assert.equal(backendRequests, 2);
});

test('gateway exposes the isolated Open Terminal compatibility namespace with bounded browser preflight', async (context) => {
  const proxied: { method?: string; path?: string; session?: string }[] = [];
  const backend = createServer((request, response) => {
    if (request.url !== '/_qubicl/gateway-epoch') {
      proxied.push({
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { path: request.url }),
        ...(typeof request.headers['x-session-id'] !== 'string'
          ? {}
          : { session: request.headers['x-session-id'] }),
      });
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-gateway-'));
  const routesPath = join(directory, 'routes.json');
  const id = '00000000-0000-4000-8000-000000000077';
  await writeFile(routesPath, JSON.stringify({
    version: 2,
    generatedAt: new Date().toISOString(),
    routes: [route(id, 'open-terminal', backendPort, 'token', 'internal-key-that-is-definitely-long-enough')],
  }));
  const gateway = new Gateway(new RouteStore(routesPath));
  await gateway.start(0);
  context.after(() => gateway.close());
  const port = (gateway.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/computers/${id}/open-terminal`;
  const origin = 'http://localhost:3000';

  const preflight = await fetch(`${base}/files/cwd`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, x-session-id',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /X-Session-Id/);
  assert.equal(proxied.length, 0);

  const rejected = await fetch(`${base}/files/delete`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(rejected.status, 403);

  const config = await fetch(`${base}/api/config`, {
    headers: { origin, authorization: 'Bearer token', 'x-session-id': 'chat-one' },
  });
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(proxied, [{ method: 'GET', path: '/open-terminal/api/config', session: 'chat-one' }]);
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
});

test('gateway isolates hostile previews from viewer and API authority by host', async (context) => {
  const backendPaths: string[] = [];
  const backend = createServer((request, response) => {
    if (request.url !== '/_qubicl/gateway-epoch') backendPaths.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('preview');
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-preview-origin-'));
  const routesPath = join(directory, 'routes.json');
  const id = '00000000-0000-4000-8000-000000000078';
  await writeFile(routesPath, JSON.stringify({
    version: 2,
    generatedAt: new Date().toISOString(),
    routes: [route(id, 'preview-origin', backendPort, 'token', 'internal-key-that-is-definitely-long-enough')],
  }));
  const gateway = new Gateway(new RouteStore(routesPath));
  await gateway.start(0);
  context.after(() => gateway.close());
  const port = (gateway.server.address() as { port: number }).port;
  const host = `${previewHostname(id)}:${port}`;
  const base = `http://127.0.0.1:${port}/computers/${id}`;
  const viewerCookie = 'qubicl_view=ambient-viewer-authority';

  assert.equal((await fetch(`${base}/previews/publication/path`)).status, 403);
  const preview = await requestWithHost(port, `/computers/${id}/previews/publication/path`, host);
  assert.equal(preview.status, 200);
  assert.equal(preview.body, 'preview');
  assert.equal((await requestWithHost(port, `/computers/${id}/human-control/take`, host, {
    method: 'POST',
    headers: { origin: `http://${host}`, cookie: viewerCookie },
  })).status, 403);
  assert.equal((await requestWithHost(port, `/computers/${id}/openapi.json`, host, {
    headers: { authorization: 'Bearer token' },
  })).status, 403);
  assert.deepEqual(backendPaths, ['/_qubicl/previews/publication/path']);
});

test('gateway epoch synchronization becomes idle after acknowledgement', async (context) => {
  let synchronizations = 0;
  const backend = createServer((request, response) => {
    if (request.url === '/_qubicl/gateway-epoch') synchronizations += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-epoch-'));
  const routesPath = join(directory, 'routes.json');
  const id = '00000000-0000-4000-8000-000000000010';
  const writeRoutes = async (internalKey: string): Promise<void> => {
    await writeFile(routesPath, JSON.stringify({
      version: 2,
      generatedAt: new Date().toISOString(),
      routes: [route(id, 'epoch-test', backendPort, 'token', internalKey)],
    }));
  };
  await writeRoutes('first-internal-key-that-is-long-enough');
  const gateway = new Gateway(new RouteStore(routesPath), 20);
  await gateway.start(0);
  context.after(() => gateway.close());

  await waitFor(async () => synchronizations === 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(synchronizations, 1);

  await writeRoutes('second-internal-key-that-is-long-enough');
  await waitFor(async () => synchronizations === 2);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(synchronizations, 2);
});

test('viewer tickets are read-only and token-bound', async (context) => {
  let observerConnections = 0;
  let controllingConnections = 0;
  let releaseRequests = 0;
  let pointerRequests = 0;
  let pointerInternalKey: string | undefined;
  let pointerGatewayEpoch: string | undefined;
  let pointerCookie: string | string[] | undefined;
  let failTakeover = false;
  const firstInternalKey = 'internal-key-that-is-definitely-long-enough';
  const rotatedInternalKey = 'rotated-internal-key-that-is-long-enough';
  const firstViewerKey = deriveInternalServiceKey(firstInternalKey, 'viewer');
  const rotatedViewerKey = deriveInternalServiceKey(rotatedInternalKey, 'viewer');
  let expectedViewerKey: string | undefined = firstViewerKey;
  const staticViewerHeaders: Array<string | undefined> = [];
  const observerViewerHeaders: Array<string | undefined> = [];
  const controllingViewerHeaders: Array<string | undefined> = [];
  const backendSockets = new Set<Duplex>();
  const controllingBackendSockets = new Set<Duplex>();
  context.after(() => {
    for (const socket of backendSockets) socket.destroy();
  });
  const backend = createServer((request, response) => {
    if (request.url?.startsWith('/vnc.html')) {
      const received = request.headers['x-qubicl-viewer-key'] as string | undefined;
      staticViewerHeaders.push(received);
      if (received !== expectedViewerKey) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>noVNC</title>');
      return;
    }
    if (request.url?.startsWith('/_qubicl/view/actions')) {
      pointerRequests += 1;
      pointerInternalKey = request.headers['x-qubicl-internal-key'] as string | undefined;
      pointerGatewayEpoch = request.headers['x-qubicl-gateway-epoch'] as string | undefined;
      pointerCookie = request.headers.cookie;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        events: [{ sequence: 1, type: 'show', kind: 'click', x: 125, y: 250, button: 1, pulse: true, occurredAt: 1_234_567_890 }],
        latestSequence: 1,
        current: { kind: 'click', x: 125, y: 250, button: 1, occurredAt: 1_234_567_890 },
        display: { width: 1_440, height: 900 },
      }));
      return;
    }
    if (request.url === '/_qubicl/human/release') releaseRequests += 1;
    if (request.url === '/_qubicl/human/take' && failTakeover) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'fencing_failed', message: 'Fencing failed.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url === '/_qubicl/human/take'
      ? JSON.stringify({ controller: 'human', generation: 4, terminatedManagedProcesses: 2, preservedDesktopApplications: 1, preservedBrowserSessions: 1 })
      : '{}');
  });
  backend.on('upgrade', (request, socket) => {
    const received = request.headers['x-qubicl-viewer-key'] as string | undefined;
    observerViewerHeaders.push(received);
    if (received !== expectedViewerKey) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    observerConnections += 1;
    backendSockets.add(socket);
    socket.once('close', () => backendSockets.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as { port: number }).port;
  const controllingBackend = createServer();
  controllingBackend.on('upgrade', (request, socket) => {
    const received = request.headers['x-qubicl-viewer-key'] as string | undefined;
    controllingViewerHeaders.push(received);
    if (received !== expectedViewerKey) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    controllingConnections += 1;
    backendSockets.add(socket);
    controllingBackendSockets.add(socket);
    socket.once('close', () => {
      backendSockets.delete(socket);
      controllingBackendSockets.delete(socket);
    });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise<void>((resolve) => controllingBackend.listen(0, '127.0.0.1', resolve));
  context.after(() => controllingBackend.close());
  const controllingPort = (controllingBackend.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-viewer-'));
  const routesPath = join(directory, 'routes.json');
  const id = '00000000-0000-4000-8000-000000000002';
  const writeRoutes = async (token: string, authenticatedViewer = true, internalKey = firstInternalKey): Promise<void> => {
    await writeFile(routesPath, JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), routes: [route(id, 'viewer', backendPort, token, internalKey, backendPort, controllingPort, authenticatedViewer)] }));
  };
  await writeRoutes('first');
  const gateway = new Gateway(new RouteStore(routesPath), 1_000, 25);
  await gateway.start(0);
  context.after(() => gateway.close());
  const port = (gateway.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/computers/${id}`;

  assert.equal((await fetch(`http://127.0.0.1:${backendPort}/vnc.html`)).status, 403, 'the hardened viewer rejects requests that bypass the gateway');

  const firstTicket = await fetch(`${base}/view-ticket`, { method: 'POST', headers: { authorization: 'Bearer first' } }).then((response) => response.json()) as { url: string };
  await writeRoutes('second');
  await waitFor(async () => (await fetch(`${base}/openapi.json`, { headers: { authorization: 'Bearer second' } })).ok);
  assert.equal((await fetch(`http://127.0.0.1:${port}${firstTicket.url}`, { redirect: 'manual' })).status, 401);

  const secondTicket = await fetch(`${base}/view-ticket`, { method: 'POST', headers: { authorization: 'Bearer second' } }).then((response) => response.json()) as { url: string };
  const exchange = await fetch(`http://127.0.0.1:${port}${secondTicket.url}`, { redirect: 'manual' });
  assert.equal(exchange.status, 302);
  const cookie = exchange.headers.get('set-cookie')!;
  const viewer = await fetch(`http://127.0.0.1:${port}${exchange.headers.get('location')}`, { headers: { cookie } });
  assert.equal(viewer.status, 200);
  const viewerHtml = await viewer.text();
  assert.match(viewerHtml, /view_only=true/);
  assert.match(viewerHtml, /Take control stops agent commands\. Desktop-session applications and the managed browser stay open\./);
  assert.match(viewerHtml, /Closing this viewer releases control after 10 seconds\./);
  assert.match(viewerHtml, /Chromium profile data is durable and survives restarts and upgrades\./);
  assert.match(viewerHtml, /preservedDesktopApplications/);
  assert.match(viewerHtml, /preservedBrowserSessions/);
  assert.match(viewerHtml, /terminatedManagedProcesses/);
  assert.match(viewerHtml, /Agent pointer: on/);
  assert.match(viewerHtml, /#b8e34a/);
  assert.match(viewerHtml, /actions\?after=/);
  assert.match(viewerHtml, /wait=1/);
  assert.match(viewerHtml, /qubicl-agent-pointer/);
  assert.match(viewerHtml, /#noVNC_canvas/);
  assert.match(viewerHtml, /framebufferRect/);
  assert.match(viewerHtml, /agent-pointer\.visible/);
  assert.match(viewerHtml, /const mapViewerPointerToCanvas=\(function mapViewerPointerToCanvas/);
  assert.doesNotMatch(viewerHtml, /viewBox="0 0 1440 900"/);
  const viewerScript = viewerHtml.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(viewerScript);
  assert.doesNotThrow(() => new Script(viewerScript));
  const frameSource = viewerHtml.match(/<iframe id="desktop" src="([^"]+)"/)?.[1];
  assert.ok(frameSource);
  const frameUrl = new URL(frameSource.replaceAll('&amp;', '&'), viewer.url);
  assert.equal(frameUrl.searchParams.get('path'), `/computers/${id}/view/websockify`);
  assert.equal(new URL(frameUrl.searchParams.get('path')!, frameUrl).pathname, `/computers/${id}/view/websockify`);
  assert.doesNotMatch(viewerHtml, new RegExp(firstViewerKey));
  const frame = await fetch(frameUrl, { headers: { cookie, 'x-qubicl-viewer-key': 's'.repeat(43) } });
  assert.equal(frame.status, 200);
  assert.equal(staticViewerHeaders.at(-1), firstViewerKey, 'the gateway replaces a spoofed static-viewer header');
  const contentSecurityPolicy = viewer.headers.get('content-security-policy') ?? '';
  assert.match(contentSecurityPolicy, /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.doesNotMatch(contentSecurityPolicy, /unsafe-inline/);
  assert.equal((await fetch(`${base}/view/actions?after=0`)).status, 401);
  const pointerResponse = await fetch(`${base}/view/actions?after=0`, { headers: { cookie } });
  assert.equal(pointerResponse.status, 200);
  assert.deepEqual(await pointerResponse.json(), {
    events: [{ sequence: 1, type: 'show', kind: 'click', x: 125, y: 250, button: 1, pulse: true, occurredAt: 1_234_567_890 }],
    latestSequence: 1,
    current: { kind: 'click', x: 125, y: 250, button: 1, occurredAt: 1_234_567_890 },
    display: { width: 1_440, height: 900 },
  });
  assert.equal(pointerRequests, 1);
  assert.equal(pointerInternalKey, 'internal-key-that-is-definitely-long-enough');
  assert.ok(pointerGatewayEpoch);
  assert.equal(pointerCookie, undefined);

  for (const origin of [
    null,
    'not-an-origin',
    `http://localhost:${port}`,
    `http://127.0.0.1:${port === 65_535 ? port - 1 : port + 1}`,
    `https://127.0.0.1:${port}`,
  ]) {
    await assert.rejects(openWebSocket(port, id, cookie, { origin }), /403 Forbidden/);
  }
  assert.equal(observerConnections, 0);
  assert.equal(controllingConnections, 0);

  const firstObserver = await openWebSocket(port, id, cookie, { viewerKey: 's'.repeat(43) });
  assert.equal(observerConnections, 1);
  assert.equal(observerViewerHeaders.at(-1), firstViewerKey, 'the gateway replaces a spoofed WebSocket viewer header');
  assert.equal(controllingConnections, 0);
  assert.equal((await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie } })).status, 403);
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie, origin: `https://127.0.0.1:${port}` } })).status, 403);
  assert.equal((await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie, origin: `http://localhost:${port}` } })).status, 403);
  const thirdTicket = await fetch(`${base}/view-ticket`, { method: 'POST', headers: { authorization: 'Bearer second' } }).then((response) => response.json()) as { url: string };
  const thirdExchange = await fetch(`http://127.0.0.1:${port}${thirdTicket.url}`, { redirect: 'manual' });
  const otherCookie = thirdExchange.headers.get('set-cookie')!;
  const takeover = await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie, origin } });
  assert.equal(takeover.status, 200);
  assert.deepEqual(await takeover.json(), {
    controller: 'human',
    generation: 4,
    terminatedManagedProcesses: 2,
    preservedDesktopApplications: 1,
    preservedBrowserSessions: 1,
  });
  const controller = await openWebSocket(port, id, cookie);
  assert.equal(controllingConnections, 1);
  assert.equal(controllingViewerHeaders.at(-1), firstViewerKey);
  assert.equal((await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie: otherCookie, origin } })).status, 409);
  assert.equal((await fetch(`${base}/human-control/release`, { method: 'POST', headers: { cookie: otherCookie, origin } })).status, 409);
  assert.equal((await fetch(`${base}/human-control/release`, { method: 'POST', headers: { cookie, origin } })).status, 200);
  await waitFor(async () => controller.destroyed);
  assert.equal(firstObserver.destroyed, false);
  failTakeover = true;
  assert.equal((await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie: otherCookie, origin } })).status, 500);
  const observerAfterFailedTakeover = await openWebSocket(port, id, otherCookie);
  assert.equal(observerConnections, 2);
  assert.equal(controllingConnections, 1);
  failTakeover = false;
  const secondObserver = await openWebSocket(port, id, cookie);
  assert.equal(observerConnections, 3);

  assert.equal((await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie: otherCookie, origin } })).status, 200);
  const abandonedController = await openWebSocket(port, id, otherCookie);
  for (const socket of controllingBackendSockets) socket.destroy();
  await waitFor(async () => abandonedController.destroyed);
  await waitFor(async () => releaseRequests >= 2);
  assert.equal((await fetch(`${base}/human-control/take`, { method: 'POST', headers: { cookie, origin } })).status, 200);
  assert.equal((await fetch(`${base}/operator/human-control/release`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/operator/human-control/release`, {
    method: 'POST',
    headers: { authorization: 'Bearer second' },
  })).status, 200);
  assert.equal((await fetch(`${base}/human-control/release`, { method: 'POST', headers: { cookie, origin } })).status, 409);

  expectedViewerKey = rotatedViewerKey;
  await writeRoutes('second', true, rotatedInternalKey);
  await waitFor(async () => {
    const response = await fetch(frameUrl, { headers: { cookie, 'x-qubicl-viewer-key': firstViewerKey } });
    return response.ok && staticViewerHeaders.at(-1) === rotatedViewerKey;
  });
  assert.equal((await fetch(`http://127.0.0.1:${backendPort}/vnc.html`, { headers: { 'x-qubicl-viewer-key': firstViewerKey } })).status, 403);
  const rotatedReconnect = await openWebSocket(port, id, cookie, { viewerKey: firstViewerKey });
  assert.equal(observerViewerHeaders.at(-1), rotatedViewerKey);

  expectedViewerKey = undefined;
  await writeRoutes('second', false, rotatedInternalKey);
  await waitFor(async () => {
    const response = await fetch(frameUrl, { headers: { cookie, 'x-qubicl-viewer-key': rotatedViewerKey } });
    return response.ok && staticViewerHeaders.at(-1) === undefined;
  });
  const legacyReconnect = await openWebSocket(port, id, cookie, { viewerKey: rotatedViewerKey });
  assert.equal(observerViewerHeaders.at(-1), undefined, 'unmarked routes remain compatible and still strip spoofed headers');

  expectedViewerKey = rotatedViewerKey;
  await writeRoutes('third', true, rotatedInternalKey);
  await waitFor(async () => (await fetch(`${base}/openapi.json`, { headers: { authorization: 'Bearer third' } })).ok);
  assert.equal((await fetch(`${base}/view/`, { headers: { cookie } })).status, 401);
  await waitFor(async () => firstObserver.destroyed && observerAfterFailedTakeover.destroyed && secondObserver.destroyed
    && rotatedReconnect.destroyed && legacyReconnect.destroyed);
});

test('production gateway bundle binds the viewer mapper independently of minified function names', async () => {
  const bundle = await readFile(new URL('../../packages/cli/dist/assets/gateway/gateway.mjs', import.meta.url), 'utf8');
  assert.match(bundle, /const mapViewerPointerToCanvas=\(\$\{[A-Za-z_$][\w$]*\.toString\(\)\}\);/);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition did not become true before timeout.');
}

async function requestWithHost(
  port: number,
  path: string,
  host: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method,
      headers: { ...options.headers, host },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

interface WebSocketOptions {
  origin?: string | null;
  viewerKey?: string;
}

async function openWebSocket(port: number, id: string, cookie: string, options: WebSocketOptions = {}): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    const origin = options.origin === undefined ? `http://127.0.0.1:${port}` : options.origin;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('WebSocket route did not open.'));
    }, 1_000);
    socket.on('connect', () => socket.write([
      `GET /computers/${id}/view/websockify HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ...(origin === null ? [] : [`Origin: ${origin}`]),
      ...(options.viewerKey === undefined ? [] : [`X-Qubicl-Viewer-Key: ${options.viewerKey}`]),
      `Cookie: ${cookie}`,
      '',
      '',
    ].join('\r\n')));
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timeout);
      if (!response.startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error(`WebSocket route returned: ${response.split('\r\n', 1)[0]}`));
        return;
      }
      resolve(socket);
    });
    socket.once('error', reject);
  });
}
