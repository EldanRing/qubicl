import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { PreviewManager } from '../../packages/control/dist/previews.js';

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}
function get(url: URL, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: url.port, path: url.pathname + url.search,
      headers: { host: url.host, ...headers } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part) => { body += part; });
      response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    });
    request.on('error', reject); request.end();
  });
}
function upgrade(url: URL, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), '127.0.0.1', () => {
      socket.write([`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`, 'Connection: Upgrade', 'Upgrade: websocket',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', ''].join('\r\n'));
    });
    socket.setTimeout(3_000, () => socket.destroy(new Error('Upgrade timed out')));
    socket.once('error', reject);
    socket.once('data', (data) => { resolve(data.toString()); socket.destroy(); });
  });
}

test('integrated-browser owner origins route authenticated HTTP and WebSockets only to their own publication', async (context) => {
  const upstream: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const app = createServer((request, response) => {
    upstream.push({ path: request.url!, headers: request.headers });
    response.setHeader('set-cookie', ['app=retained; Domain=localhost; Path=/', 'qubicl_preview_forbidden=bad']);
    response.end(request.url);
  });
  app.on('upgrade', (request, socket) => {
    upstream.push({ path: request.url!, headers: request.headers });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const appPort = await listen(app);
  let manager: PreviewManager;
  let controllerRequests = 0;
  const server = createServer((request, response) => {
    if (manager.handleBrowser(request, response)) return;
    controllerRequests += 1;
    response.writeHead(401); response.end('controller authentication required');
  });
  server.on('upgrade', (request, socket, head) => {
    if (!manager.handleBrowserUpgrade(request, socket, head)) socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
  });
  const port = await listen(server);
  manager = new PreviewManager({ listPorts: async () => [{ port: appPort, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1', 'http://preview-example.localhost:3211/computers/example/previews',
    `http://preview-example.localhost:${port}/computers/example/previews`);
  context.after(async () => { manager.clear(); await close(server); await close(app); });
  const publication = await manager.publish(appPort);
  const browser = new URL(publication.browserUrl as string);
  assert.equal(browser.hostname, `${publication.id}--preview-example.localhost`);
  const first = await get(browser, { 'x-qubicl-internal-key': 'must-not-reach-app', 'x-qubicl-client-id': 'forged', 'x-qubicl-access-surface': 'external' });
  assert.equal(first.status, 200);
  assert.equal(first.body, '/');
  const previewCookie = first.headers['set-cookie']!.find(value => value.startsWith(`qubicl_preview_${publication.id}=`))!;
  assert.match(previewCookie, /HttpOnly; SameSite=Strict; Path=\//u);
  assert.ok(first.headers['set-cookie']!.every(value => !/Domain=/iu.test(value)));
  const cookie = `${previewCookie.split(';')[0]}; app=retained`;
  const nested = new URL('/nested/asset?v=1', browser);
  assert.equal((await get(nested)).status, 401);
  assert.equal((await get(nested, { cookie, origin: browser.origin, authorization: 'Basic app-credential' })).body, '/nested/asset?v=1');
  assert.equal(upstream.at(-1)!.headers.authorization, 'Basic app-credential');
  assert.equal(upstream.at(-1)!.headers.cookie, 'app=retained');
  assert.equal(upstream.at(-1)!.headers.host, browser.host);
  assert.equal(upstream.at(-1)!.headers['x-forwarded-proto'], 'http');
  assert.equal(upstream[0]!.headers['x-qubicl-internal-key'], undefined);
  assert.equal(upstream[0]!.headers['x-qubicl-client-id'], undefined);
  assert.equal((await get(nested, { cookie, origin: 'http://other.localhost' })).status, 403);
  const other = await manager.publish(appPort);
  assert.equal((await get(new URL(other.browserUrl as string), { cookie })).status, 200, 'the second publication has its own entry token');
  const secondWithoutToken = new URL(other.browserUrl as string); secondWithoutToken.search = '';
  assert.equal((await get(secondWithoutToken, { cookie })).status, 401, 'cookies cannot authorize another publication');
  const wrongComputer = new URL(browser); wrongComputer.hostname = `${publication.id}--preview-other.localhost`;
  assert.equal((await get(wrongComputer)).status, 403);
  const toolsPath = new URL('/v1/tools/exec_command', browser);
  assert.equal((await get(toolsPath, { cookie, 'x-qubicl-internal-key': 'forged' })).body, '/v1/tools/exec_command');
  assert.equal(controllerRequests, 0, 'preview hosts never enter controller API routing');
  const websocket = new URL('/hmr?revision=1', browser);
  assert.match(await upgrade(websocket, { cookie, origin: browser.origin }), /^HTTP\/1\.1 101/u);
  assert.equal(upstream.at(-1)!.path, '/hmr?revision=1');
  assert.equal(upstream.at(-1)!.headers.cookie, 'app=retained');
  assert.equal(upstream.at(-1)!.headers.host, browser.host);
  assert.match(await upgrade(websocket, { cookie, origin: 'http://other.localhost' }), /^HTTP\/1\.1 403/u);
  manager.unpublish(publication.id as string);
  assert.equal((await get(nested, { cookie })).status, 401);
});

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;
test('Chromium opens an isolated guest-loopback owner URL and retains its cookie for relative assets', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE for the focused live browser check.', timeout: 15_000,
}, async (context) => {
  const app = createServer((request, response) => {
    if (request.url === '/asset') { response.end('preview asset'); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<title>Guest preview</title><h1>Local application</h1>');
  });
  const appPort = await listen(app);
  let manager: PreviewManager;
  const control = createServer((request, response) => {
    if (!manager.handleBrowser(request, response)) { response.writeHead(401); response.end(); }
  });
  const port = await listen(control);
  manager = new PreviewManager({ listPorts: async () => [{ port: appPort, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1', 'http://preview-example.localhost:3211/computers/example/previews',
    `http://preview-example.localhost:${port}/computers/example/previews`);
  context.after(async () => { manager.clear(); await close(control); await close(app); });
  const publication = await manager.publish(appPort);
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  const response = await page.goto(publication.browserUrl as string);
  assert.equal(response?.status(), 200);
  assert.equal(await page.title(), 'Guest preview');
  assert.equal(await page.evaluate(async () => (await fetch('/asset')).text()), 'preview asset');
  const isolated = new URL(publication.browserUrl as string); isolated.search = '';
  assert.equal((await page.goto(isolated.href))?.status(), 200, 'owner cookie authorizes a clean follow-up URL');
});
