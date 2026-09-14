import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  RemoteBrokerManager,
  RemoteBrowserManager,
  RemoteDesktopApplicationManager,
  RemoteDesktopManager,
  RemotePortManager,
  RemoteWebManager,
} from '../../packages/control/dist/remote-runners.js';

test('isolated runner clients use the intended route, method, body, and protected credential header', async () => {
  const requests: Array<{ path: string; method: string; runnerKey?: string; brokerKey?: string; body?: unknown }> = [];
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({
      path: request.url ?? '', method: request.method ?? '',
      ...(typeof request.headers['x-qubicl-runner-key'] === 'string' ? { runnerKey: request.headers['x-qubicl-runner-key'] } : {}),
      ...(typeof request.headers['x-qubicl-broker-key'] === 'string' ? { brokerKey: request.headers['x-qubicl-broker-key'] } : {}),
      ...(body === undefined ? {} : { body }),
    });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/ports') return response.end(JSON.stringify({ ports: [{ port: 3000, address: 'loopback', protocol: 'tcp' }] }));
    if (request.url === '/v1/applications' && request.method === 'GET') return response.end(JSON.stringify({ applications: [], availableApplications: [] }));
    if (request.url === '/v1/status') return response.end(JSON.stringify({ desktopApplications: 2 }));
    if (request.url === '/v1/clipboard' && request.method === 'GET') return response.end(JSON.stringify({ text: 'clipboard' }));
    response.end(JSON.stringify({ ok: true, written: true, applicationId: 'app-1', application: 'writer', state: 'closed', lifecycle: 'desktop_session', forcedKill: false }));
  });
  await listen(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await new RemotePortManager(base, 'runner-secret').listPorts())[0]?.port, 3000);
    await new RemoteBrokerManager(base, 'broker-secret').request({ credentialId: 'github' });

    const web = new RemoteWebManager(base, 'runner-secret');
    await web.search({ query: 'Qubicl', limit: 3 });
    await web.extract({ url: 'https://example.test', format: 'markdown', maxChars: 1000 });
    await web.extractRendered({ finalUrl: 'https://example.test', title: 'Example', contentType: 'text/html', html: '<p>Example</p>', sourceTruncated: false, format: 'text', maxChars: 1000 });

    const desktop = new RemoteDesktopManager(base, 'runner-secret');
    await desktop.screenshot();
    await desktop.control({ action: 'click', x: 10, y: 20 });
    assert.equal((await desktop.readClipboard()).text, 'clipboard');
    assert.equal((await desktop.writeClipboard('updated')).written, true);

    const applications = new RemoteDesktopApplicationManager(base, 'runner-secret');
    await applications.open('writer', ['/home/qubicl/document.odt']);
    assert.deepEqual(await applications.list(), []);
    assert.deepEqual(await applications.available(), []);
    assert.equal((await applications.close('app-1', true)).state, 'closed');
    assert.equal(await applications.count(), 2);
    await applications.shutdown();

    const browser = new RemoteBrowserManager(base, 'runner-secret');
    assert.equal(browser.count(), 0);
    await browser.health();
    await browser.navigate('https://example.test');
    await browser.snapshot();
    await browser.screenshot(false);
    await browser.click('e1', 'left');
    await browser.type('e2', 'hello', true, true);
    await browser.tabs();
    await browser.newTab();
    await browser.permissions('https://example.test', ['clipboard-read'], false);
    await browser.computer([{ type: 'wait', milliseconds: 1 }]);
    assert.equal(browser.count(), 1);
    await browser.shutdown();
    assert.equal(browser.count(), 0);

    assert.ok(requests.some(({ path, method, runnerKey }) => path === '/v1/ports' && method === 'GET' && runnerKey === 'runner-secret'));
    assert.ok(requests.some(({ path, brokerKey }) => path === '/v1/broker/request' && brokerKey === 'broker-secret'));
    assert.ok(requests.some(({ path, body }) => path === '/v1/browser/invoke' && (body as { method?: string }).method === 'computer'));
    assert.ok(requests.every(({ brokerKey, runnerKey }) => Boolean(brokerKey || runnerKey)));
  } finally {
    await close(server);
  }
});

async function readJson(request: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
