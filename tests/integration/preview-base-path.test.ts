import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { PreviewManager } from '../../packages/control/dist/previews.js';

test('published HTTP previews support path-relative assets and redirects without forwarding credentials or app cookies', async (context) => {
  const requests: string[] = [];
  const target = createServer((request, response) => {
    requests.push(request.url!);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-qubicl-internal-key'], undefined);
    response.setHeader('set-cookie', 'app-session=private');
    if (request.url === '/nested/start') { response.writeHead(302, { location: './page' }); response.end(); }
    else if (request.url === '/nested/page') response.end('<script src="./assets/main.js"></script>');
    else response.end('asset');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const port = (target.address() as { port: number }).port;
  const manager = new PreviewManager({ listPorts: async () => [{ port, address: 'loopback', protocol: 'tcp' }] }, '127.0.0.1', 'http://preview.local/previews', 'http://gateway/previews');
  await manager.publish(port, 300);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://local');
    if (!manager.proxyPublishedPort(request, response, port, url.pathname.replace(`/open-terminal/proxy/${port}`, '') + url.search)) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/open-terminal/proxy/${port}/nested/`;
  const headers = { authorization: 'Bearer operator', cookie: 'operator=secret', 'x-qubicl-internal-key': 'internal' };
  const redirect = await fetch(`${base}start`, { headers, redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('set-cookie'), null);
  const pageUrl = new URL(redirect.headers.get('location')!, `${base}start`);
  const page = await fetch(pageUrl, { headers });
  assert.match(await page.text(), /src="\.\/assets\/main.js"/);
  const asset = await fetch(new URL('./assets/main.js?v=1', pageUrl), { headers });
  assert.equal(await asset.text(), 'asset');
  assert.deepEqual(requests, ['/nested/start', '/nested/page', '/nested/assets/main.js?v=1']);
  manager.clear();
  assert.equal((await fetch(pageUrl)).status, 404);
});

test('isolated published preview WebSocket handoff keeps the path and strips operator credentials', async (context) => {
  const target = createServer();
  let receivedPath: string | undefined;
  target.on('upgrade', (request, socket) => {
    receivedPath = request.url;
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const port = (target.address() as { port: number }).port;
  const manager = new PreviewManager({ listPorts: async () => [{ port, address: 'loopback', protocol: 'tcp' }] }, '127.0.0.1', 'http://preview.local/previews', 'http://gateway/previews');
  const publication = await manager.publish(port, 300);
  const token = new URL(publication.url as string).searchParams.get('token')!;
  const server = createServer();
  server.on('upgrade', (request, socket, head) => manager.handleUpgrade(request, socket, head, new URL(request.url!, 'http://local')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect((server.address() as { port: number }).port, '127.0.0.1', () => {
      socket.write(`GET /_qubicl/previews/${publication.id}/nested/hmr?token=${token}&v=1 HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer operator\r\nCookie: operator=secret\r\n\r\n`);
    });
    socket.once('error', reject);
    socket.once('data', (data) => { resolve(data.toString()); socket.destroy(); });
  });
  assert.match(response, /101 Switching Protocols/);
  assert.equal(receivedPath, '/nested/hmr?v=1');
});
