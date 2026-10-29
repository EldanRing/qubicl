import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import test from 'node:test';
import { createEgressServer } from '../../packages/control/dist/egress.js';

test('ordinary forwarded HTTP preserves every Set-Cookie header and authenticates the next request', async (context) => {
  const cookies = ['session=ready; Path=/; HttpOnly', 'theme=dark; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/'];
  const target = createServer((incoming, response) => {
    if (incoming.url === '/login') {
      response.writeHead(302, { 'set-cookie': cookies, location: '/account' });
      response.end('login');
    } else {
      response.writeHead(incoming.headers.cookie?.includes('session=ready') ? 200 : 401);
      response.end(incoming.headers.cookie ?? 'missing session');
    }
  });
  const targetPort = await listen(target);
  const key = 'fixture-proxy-key';
  const proxy = createEgressServer({ configurations: () => [{
    id: 'cookie-regression', proxyKey: key, brokerKey: 'fixture-broker-key',
    policy: { profile: 'custom', allowDomains: [], denyDomains: [], allowCidrs: ['127.0.0.1/32'], allowTcpPorts: [targetPort], temporaryApprovals: [] },
  }] });
  const proxyPort = await listen(proxy);
  context.after(async () => { await close(proxy); await close(target); });
  const call = (path: string, cookie?: string) => new Promise<{ status: number; cookies: string[] | undefined; body: string; location: string | undefined }>((resolve, reject) => {
    request({ hostname: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${targetPort}${path}`, headers: {
      'proxy-authorization': `Basic ${Buffer.from(`qubicl:${key}`).toString('base64')}`, ...(cookie ? { cookie } : {}),
    } }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode!, cookies: response.headers['set-cookie'], location: response.headers.location, body }));
    }).once('error', reject).end();
  });
  const login = await call('/login');
  assert.equal(login.status, 302); assert.equal(login.location, '/account'); assert.deepEqual(login.cookies, cookies);
  const account = await call('/account', login.cookies!.map(cookie => cookie.split(';')[0]).join('; '));
  assert.equal(account.status, 200); assert.equal(account.body, 'session=ready; theme=dark');
});

test('HTTP forwarding closes interrupted transfers and upstream work after client aborts', { timeout: 5000 }, async (context) => {
  let downloadClosed!: () => void; let uploadStarted!: () => void; let uploadAborted!: () => void;
  const downloadDone = new Promise<void>(resolve => { downloadClosed = resolve; });
  const uploadReady = new Promise<void>(resolve => { uploadStarted = resolve; });
  const uploadDone = new Promise<void>(resolve => { uploadAborted = resolve; });
  const target = createServer((incoming, response) => {
    if (incoming.url === '/broken') {
      response.writeHead(200, { 'content-length': 1000 }); response.write('partial');
      setTimeout(() => response.destroy(), 10);
    } else if (incoming.url === '/download') {
      response.write('started'); response.once('close', downloadClosed);
    } else {
      incoming.once('data', uploadStarted); incoming.once('aborted', uploadAborted);
      incoming.on('error', () => undefined);
    }
  });
  const targetPort = await listen(target);
  const key = 'fixture-stream-proxy';
  const proxy = createEgressServer({ configurations: () => [{
    id: 'forward-stream-regression', proxyKey: key, brokerKey: 'fixture-broker-key',
    policy: { profile: 'developer', allowDomains: [], denyDomains: [], allowCidrs: [], allowTcpPorts: [], temporaryApprovals: [] },
  }] });
  const proxyPort = await listen(proxy);
  context.after(async () => { await close(proxy); await close(target); });
  const options = (path: string) => ({ hostname: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${targetPort}${path}`, headers: { 'proxy-authorization': `Basic ${Buffer.from(`qubicl:${key}`).toString('base64')}` } });
  const interrupted = await new Promise<{ body: string; complete: boolean }>((resolve, reject) => {
    request(options('/broken'), response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('error', () => undefined);
      response.once('close', () => resolve({ body, complete: response.complete }));
    }).once('error', reject).end();
  });
  assert.deepEqual(interrupted, { body: 'partial', complete: false });
  const download = request(options('/download'), response => {
    response.on('error', () => undefined); response.once('data', () => response.destroy());
  });
  download.on('error', () => undefined); download.end(); await downloadDone;
  const upload = request({ ...options('/upload'), method: 'POST' });
  upload.on('error', () => undefined); upload.write('partial upload');
  await uploadReady; upload.destroy(); await uploadDone;
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return (server.address() as { port: number }).port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
