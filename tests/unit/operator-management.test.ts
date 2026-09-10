import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LeaseManager } from '../../packages/control/dist/lease.js';
import { ProcessManager } from '../../packages/control/dist/processes.js';
import { PreviewManager } from '../../packages/control/dist/previews.js';
import { Gateway } from '../../packages/gateway/dist/server.js';
import { RouteStore } from '../../packages/gateway/dist/routes.js';

test('removing completed operator processes does not close reused output descriptors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-operator-descriptor-'));
  const processes = new ProcessManager({ outputDirectory: root });
  const owner = new LeaseManager().acquire(600);
  const descriptors: number[] = [];
  try {
    const completed = await processes.executeCompatibility('printf done', root, owner, { waitMs: 5_000 });
    assert.equal(completed.status, 'done');
    // Fill the newly freed descriptor slots as other concurrent requests would.
    for (let index = 0; index < 16; index += 1) descriptors.push(openSync('/dev/null', 'r'));
    await processes.stopForManagement(completed.id);
    for (const descriptor of descriptors) assert.doesNotThrow(() => fstatSync(descriptor));
  } finally {
    for (const descriptor of descriptors) { try { closeSync(descriptor); } catch { /* failing regression may have closed it */ } }
    await processes.terminateOwner(owner).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('operator process metadata omits commands and exact stop preserves managed-process fencing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-operator-process-'));
  const leases = new LeaseManager();
  const owner = leases.acquire(600, {
    protocol: 'mcp',
    untrustedLabel: '<untrusted-client> 1.0',
  });
  const processes = new ProcessManager({ outputDirectory: root, maxLifetimeMs: 60_000 });
  try {
    const started = await processes.exec('sleep 30 # command-must-not-leak', root, 0, 1024, owner);
    assert.equal(started.running, true);
    const items = processes.listForManagement();
    assert.deepEqual(items, [{
      id: started.processId,
      status: 'running',
      startedAt: items[0]!.startedAt,
      owner: 'agent',
      ownerGeneration: owner.generation,
    }]);
    assert.equal(JSON.stringify(items).includes('command-must-not-leak'), false);
    assert.equal(JSON.stringify(items).includes(root), false);
    assert.equal(JSON.stringify(items).includes(owner.id), false);
    assert.equal(JSON.stringify(leases.snapshot()).includes(owner.id), false);
    assert.deepEqual(leases.snapshot().actor, { protocol: 'mcp', untrustedLabel: '<untrusted-client> 1.0' });

    assert.deepEqual(await processes.stopForManagement(started.processId), { id: started.processId, status: 'stopped' });
    assert.deepEqual(processes.listForManagement(), []);
    await assert.rejects(processes.stopForManagement(started.processId), /not found/u);
  } finally {
    await processes.terminateOwner(owner).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('operator preview tickets are short-lived, single-use, surface-bound, and contain no service origin', async () => {
  const target = createServer((_request, response) => response.end('preview-ok'));
  const targetPort = await listen(target);
  const computerId = '123e4567-e89b-42d3-a456-426614174000';
  const manager = new PreviewManager(
    { listPorts: async () => [{ port: targetPort, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1',
    `http://preview-${computerId}.localhost/computers/${computerId}/previews`,
    `http://gateway:3211/computers/${computerId}/previews`,
    `https://preview-${computerId}.private.test/computers/${computerId}/previews`,
  );
  const proxy = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://control.internal');
    if (!manager.handle(request, response, url)) response.writeHead(404).end();
  });
  const proxyPort = await listen(proxy);
  try {
    const published = await manager.publish(targetPort, 300) as { id: string };
    const summaries = manager.listForManagement();
    assert.deepEqual(summaries, [{
      id: published.id,
      kind: 'port',
      status: 'published',
      createdAt: summaries[0]!.createdAt,
      expiresAt: summaries[0]!.expiresAt,
      port: targetPort,
    }]);
    assert.equal(JSON.stringify(summaries).includes('token'), false);
    assert.equal(JSON.stringify(summaries).includes('url'), false);

    const local = manager.openForManagement(published.id, 'local');
    assert.match(local.path, new RegExp(`^/computers/${computerId}/previews/${published.id}/\\?ticket=`, 'u'));
    assert.equal(local.path.includes('://'), false);
    const internalPath = local.path.replace(`/computers/${computerId}/previews`, '/_qubicl/previews');
    const opened = await request(proxyPort, internalPath, { 'x-qubicl-access-surface': 'local' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body, 'preview-ok');
    const cookie = String(opened.headers['set-cookie']).split(';', 1)[0]!;
    assert.match(cookie, new RegExp(`^qubicl_preview_${published.id}=`, 'u'));
    assert.equal((await request(proxyPort, internalPath, { 'x-qubicl-access-surface': 'local' })).status, 401, 'ticket cannot be replayed');
    assert.equal((await request(proxyPort, internalPath.split('?', 1)[0]!, { cookie })).status, 200, 'redeemed cookie remains publication-scoped');

    const remote = manager.openForManagement(published.id, 'remote');
    const remoteInternalPath = remote.path.replace(`/computers/${computerId}/previews`, '/_qubicl/previews');
    assert.equal((await request(proxyPort, remoteInternalPath, { 'x-qubicl-access-surface': 'local' })).status, 401);
    assert.deepEqual(manager.revokeForManagement(published.id), { id: published.id, status: 'revoked' });
    assert.equal((await request(proxyPort, internalPath.split('?', 1)[0]!, { cookie })).status, 401);
  } finally {
    await Promise.all([close(target), close(proxy)]);
  }
});

test('gateway operator management routes require the exact local operator key and proxy no bearer authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-operator-gateway-'));
  const backendRequests: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const backend = createServer((request, response) => {
    backendRequests.push({ path: request.url ?? '', headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url === '/_qubicl/gateway-epoch' ? '{"synchronized":true}' : '{"items":[]}');
  });
  const backendPort = await listen(backend);
  const routePath = join(root, 'routes.json');
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const internalKey = 'K'.repeat(43);
  await writeFile(routePath, `${JSON.stringify({
    version: 2,
    generatedAt: new Date().toISOString(),
    routes: [{
      id, name: 'operator-test', host: '127.0.0.1', controlPort: backendPort,
      preset: 'file-system', compatibility: 'file-system', capabilities: ['shell', 'process', 'files'],
      manifestSha256: 'a'.repeat(64), tokenHash: createHash('sha256').update('bearer').digest('hex'), internalKey,
    }],
  })}\n`);
  const gateway = new Gateway(new RouteStore(routePath), 60_000);
  try {
    await gateway.start(0);
    const address = gateway.server.address();
    if (!address || typeof address === 'string') throw new Error('Gateway did not start.');
    const path = `/computers/${id}/operator/management/processes`;
    assert.equal((await request(address.port, path, { authorization: 'Bearer bearer' })).status, 401);
    assert.equal((await request(address.port, path, { 'x-qubicl-operator-key': 'X'.repeat(43) })).status, 401);
    const accepted = await request(address.port, path, { 'x-qubicl-operator-key': internalKey });
    assert.equal(accepted.status, 200);
    const forwarded = backendRequests.find((entry) => entry.path === '/_qubicl/operator/management/processes');
    assert.ok(forwarded);
    assert.equal(forwarded.headers['x-qubicl-internal-key'], internalKey);
    assert.equal(forwarded.headers['x-qubicl-access-surface'], 'local');
    assert.equal(forwarded.headers.authorization, undefined);
    assert.equal(forwarded.headers['x-qubicl-operator-key'], undefined);
  } finally {
    await gateway.close().catch(() => undefined);
    await close(backend);
    await rm(root, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start.');
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function request(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}
