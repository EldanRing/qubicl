import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect, type AddressInfo } from 'node:net';
import test from 'node:test';
import { createEgressServer } from '../../packages/control/dist/egress.js';
import { discoverListeningPorts } from '../../packages/control/dist/ports.js';
import { PreviewManager } from '../../packages/control/dist/previews.js';
import { decryptBackupFile, encryptBackupFile } from '../../packages/cli/dist/backups.js';

test('port discovery reports only the current computer-user listener', { skip: process.platform !== 'linux' }, async () => {
  const listener = createServer((_request, response) => response.end('ok'));
  const port = await listen(listener);
  try {
    const discovered = await discoverListeningPorts(process.getuid!());
    const match = discovered.find((entry) => entry.port === port);
    assert.ok(match);
    assert.equal(match.protocol, 'tcp');
    assert.equal(match.address, 'loopback');
    assert.equal(match.pid, process.pid);
  } finally {
    await close(listener);
  }
});

test('authenticated previews proxy HTTP, establish a private cookie, and revoke immediately', async () => {
  const target = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, leakedAuthorization: request.headers.authorization ?? null }));
  });
  const targetPort = await listen(target);
  const manager = new PreviewManager(
    { listPorts: async () => [{ port: targetPort, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1',
    'http://127.0.0.1:3211/computers/example/previews',
    'http://gateway:3211/computers/example/previews',
  );
  const front = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!manager.handle(request, response, url)) response.writeHead(404).end();
  });
  const frontPort = await listen(front);
  try {
    const publication = await manager.publish(targetPort, 300);
    const id = publication.id as string;
    const token = new URL(publication.url as string).searchParams.get('token');
    assert.ok(token);
    assert.equal((await fetch(`http://127.0.0.1:${frontPort}/_qubicl/previews/${id}/hello`)).status, 401);

    const authenticated = await fetch(`http://127.0.0.1:${frontPort}/_qubicl/previews/${id}/hello?answer=42&token=${encodeURIComponent(token)}`, {
      headers: { authorization: 'Bearer must-not-reach-preview' },
    });
    assert.equal(authenticated.status, 200);
    const cookie = authenticated.headers.get('set-cookie');
    assert.match(cookie ?? '', new RegExp(`^qubicl_preview_${id}=`));
    assert.match(cookie ?? '', new RegExp(`Path=/computers/example/previews/${id}/(?:;|$)`));
    assert.deepEqual(await authenticated.json(), { path: '/hello?answer=42', leakedAuthorization: null });

    const withCookie = await fetch(`http://127.0.0.1:${frontPort}/_qubicl/previews/${id}/again`, { headers: { cookie: cookie!.split(';')[0]! } });
    assert.equal(withCookie.status, 200);
    assert.equal(manager.list().length, 1);
    manager.clear();
    assert.equal((await fetch(`http://127.0.0.1:${frontPort}/_qubicl/previews/${id}/again`, { headers: { cookie: cookie!.split(';')[0]! } })).status, 401);
  } finally {
    await Promise.all([close(front), close(target)]);
  }
});

test('offline egress is healthy but rejects authenticated and unauthenticated proxy traffic', { concurrency: false }, async () => {
  const prior = { policy: process.env.QUBICL_NETWORK_POLICY, proxy: process.env.QUBICL_PROXY_KEY, broker: process.env.QUBICL_BROKER_KEY };
  const proxyKey = 'p'.repeat(43);
  process.env.QUBICL_NETWORK_POLICY = JSON.stringify({ profile: 'offline', allowDomains: [], denyDomains: [], temporaryApprovals: [] });
  process.env.QUBICL_PROXY_KEY = proxyKey;
  process.env.QUBICL_BROKER_KEY = 'b'.repeat(43);
  const server = createEgressServer();
  const port = await listen(server);
  try {
    assert.deepEqual(await jsonRequest(port, '/health'), { status: 200, body: { status: 'ok', profile: 'offline' } });
    assert.equal((await jsonRequest(port, 'http://example.com/')).status, 407);
    const denied = await jsonRequest(port, 'http://example.com/', { 'proxy-authorization': `Basic ${Buffer.from(`qubicl:${proxyKey}`).toString('base64')}` });
    assert.equal(denied.status, 403);
    assert.equal((denied.body as { error: { code: string } }).error.code, 'network_policy_denied');
  } finally {
    await close(server);
    restoreEnvironment('QUBICL_NETWORK_POLICY', prior.policy);
    restoreEnvironment('QUBICL_PROXY_KEY', prior.proxy);
    restoreEnvironment('QUBICL_BROKER_KEY', prior.broker);
  }
});

test('shared gateway egress authenticates and applies the policy for the matching computer', async () => {
  const firstKey = '1'.repeat(43);
  const secondKey = '2'.repeat(43);
  const server = createEgressServer({ configurations: () => [
    {
      id: 'first',
      policy: { profile: 'offline', allowDomains: [], denyDomains: [], temporaryApprovals: [] },
      proxyKey: firstKey,
      brokerKey: '3'.repeat(43),
    },
    {
      id: 'second',
      policy: { profile: 'custom', allowDomains: ['allowed.example'], denyDomains: [], temporaryApprovals: [] },
      proxyKey: secondKey,
      brokerKey: '4'.repeat(43),
    },
  ] });
  const port = await listen(server);
  try {
    assert.deepEqual(await jsonRequest(port, '/health'), { status: 200, body: { status: 'ok', computers: 2 } });
    const first = await jsonRequest(port, 'http://example.com/', { 'proxy-authorization': basicProxy(firstKey) });
    assert.equal(first.status, 403);
    assert.match((first.body as { error: { message: string } }).error.message, /disabled/u);
    const second = await jsonRequest(port, 'http://example.com/', { 'proxy-authorization': basicProxy(secondKey) });
    assert.equal(second.status, 403);
    assert.match((second.body as { error: { message: string } }).error.message, /allowlist/u);
    assert.equal((await jsonRequest(port, 'http://example.com/', { 'proxy-authorization': basicProxy('x'.repeat(43)) })).status, 407);
  } finally {
    await close(server);
  }
});

test('an abruptly reset CONNECT tunnel does not crash the shared egress server', async () => {
  const proxyKey = 'r'.repeat(43);
  const target = createServer((_request, response) => response.end('ok'));
  const targetPort = await listen(target);
  const proxy = createEgressServer({ configurations: () => [{
    id: 'reset-test',
    policy: { profile: 'developer', allowDomains: [], denyDomains: [], temporaryApprovals: [] },
    proxyKey,
    brokerKey: 's'.repeat(43),
  }] });
  const proxyPort = await listen(proxy);
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = netConnect(proxyPort, '127.0.0.1', () => socket.write([
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1`,
        `Host: 127.0.0.1:${targetPort}`,
        `Proxy-Authorization: ${basicProxy(proxyKey)}`,
        '',
        '',
      ].join('\r\n')));
      socket.once('error', reject);
      socket.once('data', (data) => {
        assert.match(data.toString('utf8'), /^HTTP\/1\.1 200 Connection Established/u);
        socket.removeListener('error', reject);
        socket.resetAndDestroy();
        resolve();
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await jsonRequest(proxyPort, '/health'), { status: 200, body: { status: 'ok', computers: 1 } });
  } finally {
    await Promise.all([close(proxy), close(target)]);
  }
});

test('backup encryption round-trips and rejects the wrong passphrase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-backup-crypto-'));
  try {
    const source = join(root, 'source');
    const encrypted = join(root, 'backup.enc');
    const restored = join(root, 'restored');
    await writeFile(source, 'durable home\n', { mode: 0o600 });
    await encryptBackupFile(source, encrypted, 'correct horse battery staple');
    await decryptBackupFile(encrypted, restored, 'correct horse battery staple');
    assert.equal(await readFile(restored, 'utf8'), 'durable home\n');
    await assert.rejects(decryptBackupFile(encrypted, join(root, 'wrong'), 'definitely the wrong password'), /wrong or the archive was modified/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function basicProxy(key: string): string {
  return `Basic ${Buffer.from(`qubicl:${key}`).toString('base64')}`;
}

async function jsonRequest(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }));
    });
    request.once('error', reject);
    request.end();
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
