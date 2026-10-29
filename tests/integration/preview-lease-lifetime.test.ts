import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolExecutor } from '../../packages/control/dist/executor.js';
import { ProcessManager } from '../../packages/control/dist/processes.js';
import { PreviewManager } from '../../packages/control/dist/previews.js';
import type { LeaseProof } from '../../packages/control/dist/lease.js';

const base = 'http://preview.test/previews';
const remoteBase = 'https://remote.test/previews';
type Preview = { id: string; url: string };
type Monitor = { removeStoppedPortPublications(): Promise<void> };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-preview-lease-'));
  const processes = new ProcessManager({ home: root, outputDirectory: join(root, 'output') });
  const ports: number[] = [];
  const previews = new PreviewManager({ listPorts: async () => {
    const states = await Promise.all(ports.map(async port => ({ port, active: await listening(port) })));
    return states.filter(({ active }) => active).map(({ port }) => ({ port, address: 'loopback', protocol: 'tcp' }));
  } }, '127.0.0.1', base, base, remoteBase);
  const executor = new ToolExecutor(undefined, { durableRoot: root, processes, previews });
  const proxy = createServer((request, response) => {
    if (!previews.handle(request, response, new URL(request.url!, base))) { response.writeHead(404); response.end(); }
  });
  const proxyPort = await listen(proxy);
  const children: string[] = [];
  context.after(async () => {
    for (const id of children) await processes.stopForManagement(id).catch(() => undefined);
    await executor.shutdown();
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const start = async (owner: LeaseProof, lifecycle: 'task' | 'session') => {
    const script = "const s=require('node:http').createServer((q,r)=>r.end('retained app'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));";
    const result = await processes.exec(`${quote(process.execPath)} -e ${quote(script)}`, root, 250, 4096, owner, undefined, 'combined', lifecycle, `${lifecycle} preview`);
    children.push(result.processId);
    assert.ok(typeof result.output === 'string', 'combined process output must be present');
    let output = result.output;
    if (!output.trim()) {
      const next = await processes.write(result.processId, '', false, 1000, owner);
      assert.ok(typeof next.output === 'string', 'combined readiness output must be present');
      output += next.output;
    }
    const port = Number(output.trim()); assert.ok(Number.isInteger(port) && port > 0, `server readiness output: ${output}`);
    ports.push(port);
    const publication = await executor.call('publish_port', { lease: owner, port, openInBrowser: false }) as Preview;
    return { processId: result.processId, port, publication };
  };
  const url = (publication: Preview, token = new URL(publication.url).searchParams.get('token')!) => `http://127.0.0.1:${proxyPort}/_qubicl/previews/${publication.id}/?token=${token}`;
  return { root, processes, previews, executor, start, url, proxyPort };
}

test('lease release and human takeover preserve retained app previews while session processes and stopped-port publications are removed', { timeout: 10_000 }, async context => {
  const f = await fixture(context);
  const owner = f.executor.leases.acquire(60);
  const app = await f.start(owner, 'task'); const session = await f.start(owner, 'session');
  const share = f.previews.share(app.publication.id, 60);
  assert.equal(await (await fetch(f.url(app.publication))).text(), 'retained app');
  await f.executor.call('release_lease', { lease: owner });
  assert.equal(await listening(app.port), true); assert.equal(await listening(session.port), false);
  await (f.previews as unknown as Monitor).removeStoppedPortPublications();
  assert.deepEqual(f.previews.list().map(({ id }) => id), [app.publication.id]);
  assert.equal(await (await fetch(f.url(app.publication))).text(), 'retained app');
  const fresh = f.executor.leases.acquire(60);
  const takeover = await f.executor.takeHumanControl() as { terminatedManagedProcesses: number };
  assert.equal(takeover.terminatedManagedProcesses, 0);
  assert.throws(() => f.executor.leases.verify(fresh), /stale/u);
  assert.equal(await (await fetch(f.url(app.publication))).text(), 'retained app');
  const remoteToken = new URL(share.remoteUrl).searchParams.get('token')!;
  const external = { 'x-qubicl-access-surface': 'external' };
  assert.equal((await fetch(f.url(app.publication, remoteToken), { headers: external })).status, 200);
  f.previews.revokeShare(app.publication.id);
  assert.equal((await fetch(f.url(app.publication, remoteToken), { headers: external })).status, 401);
  assert.equal((await fetch(f.url(app.publication))).status, 200);
  const expiringShare = f.previews.share(app.publication.id, 60);
  const clock = context.mock.method(Date, 'now', () => Date.parse(expiringShare.expiresAt) + 1);
  try {
    const expiredToken = new URL(expiringShare.remoteUrl).searchParams.get('token')!;
    assert.equal((await fetch(f.url(app.publication, expiredToken), { headers: external })).status, 401);
    assert.equal((await fetch(f.url(app.publication))).status, 200);
  } finally { clock.mock.restore(); }
  await f.processes.stopForManagement(app.processId);
  await (f.previews as unknown as Monitor).removeStoppedPortPublications();
  assert.equal((await fetch(f.url(app.publication))).status, 401);
});

test('file and management credentials keep their scoped lifetime across handoff, while epoch and shutdown revoke all capabilities', { timeout: 10_000 }, async context => {
  const f = await fixture(context); const owner = f.executor.leases.acquire(60);
  const app = await f.start(owner, 'task');
  await f.executor.observeGatewayEpoch('initial');
  const path = join(f.root, 'report.html'); await writeFile(path, '<p>report</p>');
  const file = await f.previews.publishFile(path, 60, f.executor.files);
  const ticket = f.previews.openForManagement(app.publication.id, 'local');
  const remoteTicket = f.previews.openForManagement(app.publication.id, 'remote');
  await f.executor.takeHumanControl();
  const fileUrl = new URL(file.url);
  const fileResponse = await fetch(`http://127.0.0.1:${f.proxyPort}/_qubicl/previews/${file.id}/report.html${fileUrl.search}`);
  assert.equal(fileResponse.status, 200);
  const target = (path: string) => `http://127.0.0.1:${f.proxyPort}/_qubicl/previews/${app.publication.id}/${new URL(path, base).search}`;
  const opened = await fetch(target(ticket.path), { headers: { 'x-qubicl-access-surface': 'local' } });
  assert.equal(opened.status, 200);
  const cookie = opened.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await fetch(target(ticket.path), { headers: { 'x-qubicl-access-surface': 'local' } })).status, 401, 'management ticket remains single-use');
  assert.equal((await fetch(target(remoteTicket.path), { headers: { 'x-qubicl-access-surface': 'local' } })).status, 401);
  assert.equal((await fetch(target(remoteTicket.path), { headers: { 'x-qubicl-access-surface': 'remote' } })).status, 401, 'only the actual gateway external surface redeems remote management tickets');
  assert.equal((await fetch(target(remoteTicket.path), { headers: { 'x-qubicl-access-surface': 'external' } })).status, 200);
  const bare = `http://127.0.0.1:${f.proxyPort}/_qubicl/previews/${app.publication.id}/`;
  assert.equal((await fetch(bare, { headers: { cookie, 'x-qubicl-access-surface': 'local' } })).status, 200);
  assert.equal((await fetch(bare, { headers: { cookie, 'x-qubicl-access-surface': 'external' } })).status, 401);
  const expiredFileClock = context.mock.method(Date, 'now', () => Date.parse(file.expiresAt) + 1);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${f.proxyPort}/_qubicl/previews/${file.id}/report.html${fileUrl.search}`)).status, 401);
    assert.equal((await fetch(bare, { headers: { cookie, 'x-qubicl-access-surface': 'local' } })).status, 200);
  } finally { expiredFileClock.mock.restore(); }
  await f.executor.observeGatewayEpoch('rotated');
  assert.equal((await fetch(f.url(app.publication))).status, 401);
  assert.equal((await fetch(bare, { headers: { cookie, 'x-qubicl-access-surface': 'local' } })).status, 401);
  assert.equal(f.previews.listForManagement().length, 0);
  assert.equal(await listening(app.port), true, 'epoch invalidates capabilities without killing a retained app');
  const republished = await f.previews.publish(app.port) as Preview;
  await f.executor.shutdown();
  assert.equal((await fetch(f.url(republished))).status, 401);
});
