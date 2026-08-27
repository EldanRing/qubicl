import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { checkViewerHealth } from '../../packages/cli/dist/viewer-health.js';

const id = '00000000-0000-4000-8000-000000000001';

test('viewer health follows the configured path through an authenticated WebSocket upgrade', async (context) => {
  let upgrades = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === `/computers/${id}/view-ticket`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ url: `/computers/${id}/view?ticket=valid` }));
      return;
    }
    if (request.url === `/computers/${id}/view?ticket=valid`) {
      response.writeHead(302, {
        location: `/computers/${id}/view/`,
        'set-cookie': `qubicl_view=session; HttpOnly; Path=/computers/${id}/`,
      });
      response.end();
      return;
    }
    if (request.url === `/computers/${id}/view/` && request.headers.cookie === 'qubicl_view=session') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<iframe id="desktop" src="/computers/${id}/view/vnc.html?path=${encodeURIComponent(`/computers/${id}/view/websockify`)}"></iframe>`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request, socket) => {
    const webSocketKey = request.headers['sec-websocket-key'];
    if (request.url !== `/computers/${id}/view/websockify`
      || request.headers.cookie !== 'qubicl_view=session'
      || request.headers.origin !== `http://127.0.0.1:${(server.address() as { port: number }).port}`
      || typeof webSocketKey !== 'string'
      || Buffer.from(webSocketKey, 'base64').length !== 16) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    upgrades += 1;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const detail = await checkViewerHealth(`http://127.0.0.1:${port}/computers/${id}`, 'token');
  assert.equal(detail, `viewer page HTTP 200; WebSocket HTTP 101 at /computers/${id}/view/websockify`);
  assert.equal(upgrades, 1);
});

test('viewer health reports a noVNC path that resolves to the wrong route', async (context) => {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === `/computers/${id}/view-ticket`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ url: `/computers/${id}/view?ticket=valid` }));
      return;
    }
    if (request.url === `/computers/${id}/view?ticket=valid`) {
      response.writeHead(302, {
        location: `/computers/${id}/view/`,
        'set-cookie': `qubicl_view=session; HttpOnly; Path=/computers/${id}/`,
      });
      response.end();
      return;
    }
    if (request.url === `/computers/${id}/view/`) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<iframe id="desktop" src="/computers/${id}/view/vnc.html?path=${encodeURIComponent(`computers/${id}/view/websockify`)}"></iframe>`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  await assert.rejects(
    checkViewerHealth(`http://127.0.0.1:${port}/computers/${id}`, 'token'),
    /viewer WebSocket returned HTTP\/1\.1 404 Not Found/,
  );
});
