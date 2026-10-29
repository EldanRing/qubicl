import assert from 'node:assert/strict';
import { createServer, get, IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { PreviewManager } from '../../packages/control/dist/previews.js';

const base = 'http://preview.local/previews';
type Internal = { removeStoppedPortPublications(): Promise<void>; trackConnections(id: string, scope: 'owner' | 'share', ...connections: Array<{destroy(): void}>): () => void };

test('failed listener inspection preserves previews and a later successful check removes only stopped ports', async (context) => {
  let fail = false; let ports = [3000, 3001];
  const manager = new PreviewManager({listPorts: async () => {if(fail) throw new Error('temporary runner outage'); return ports.map(port=>({port,address:'loopback',protocol:'tcp'}));}}, '127.0.0.1',base,base);
  context.after(()=>manager.clear());
  await manager.publish(3000); await manager.publish(3001);
  fail=true; await (manager as unknown as Internal).removeStoppedPortPublications();
  assert.equal(manager.list().length,2);
  fail=false; ports=[3000]; await (manager as unknown as Internal).removeStoppedPortPublications();
  assert.deepEqual(manager.list().map(item=>item.port),[3000]);
});

test('share rotation closes old connections and their later cleanup cannot untrack the replacement share', async (context) => {
  const manager = new PreviewManager({listPorts:async()=>[{port:3000,address:'loopback',protocol:'tcp'}]},'127.0.0.1',base,base,'https://remote.test/previews');
  context.after(()=>manager.clear());
  const publication=await manager.publish(3000); const id=publication.id as string;
  const internal=manager as unknown as Internal;
  let oldClosed=0; let newClosed=0; let ownerClosed=0;
  manager.share(id,60);
  const oldRelease=internal.trackConnections(id,'share',{destroy:()=>{oldClosed++;}});
  internal.trackConnections(id,'owner',{destroy:()=>{ownerClosed++;}});
  const replacement=manager.share(id,3600);
  assert.equal(oldClosed,1); assert.equal(ownerClosed,0);
  internal.trackConnections(id,'share',{destroy:()=>{newClosed++;}});
  oldRelease();
  assert.equal(manager.list()[0]!.shareExpiresAt,replacement.expiresAt);
  manager.revokeShare(id); assert.equal(newClosed,1); assert.equal(ownerClosed,0);
});

test('a listener snapshot never invalidates a publication added after the inspection began', async (context) => {
  let pending: ((ports: Array<{port:number;address:'loopback';protocol:'tcp'}>)=>void) | undefined;
  let inspect=false;
  const manager=new PreviewManager({listPorts:()=>inspect ? new Promise(resolve=>{pending=resolve;}) : Promise.resolve([{port:3000,address:'loopback',protocol:'tcp'},{port:3001,address:'loopback',protocol:'tcp'}])},'127.0.0.1',base,base);
  context.after(()=>manager.clear()); await manager.publish(3000); inspect=true;
  const checking=(manager as unknown as Internal).removeStoppedPortPublications(); inspect=false;
  await manager.publish(3001); pending!([]); await checking;
  assert.deepEqual(manager.list().map(item=>item.port),[3001]);
});

test('rotating a share closes live HTTP streams and upgraded sockets while owner access survives', { timeout: 5000 }, async (context) => {
  const target = createServer((request, response) => {
    if (request.url === '/stream') response.write('stream started');
    else response.end('available');
  });
  const upgraded = new Set<Duplex>();
  target.on('upgrade', (_request, socket) => {
    upgraded.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => upgraded.delete(socket));
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const port = await listen(target);
  const manager = new PreviewManager({ listPorts: async () => [{ port, address: 'loopback', protocol: 'tcp' }] }, '127.0.0.1', base, base, 'https://remote.test/previews');
  const publication = await manager.publish(port);
  const id = publication.id as string;
  const proxy = createServer((request, response) => {
    manager.handle(request, response, new URL(request.url!, base));
  });
  proxy.on('upgrade', (request, socket, head) => {
    manager.handleUpgrade(request, socket, head, new URL(request.url!, base));
  });
  const proxyPort = await listen(proxy);
  context.after(async () => {
    manager.clear();
    for (const socket of upgraded) socket.destroy();
    await close(proxy);
    await close(target);
  });
  const url = (token: string, path = '/') => `http://127.0.0.1:${proxyPort}/_qubicl/previews/${id}${path}?token=${token}`;
  const token = (value: string) => new URL(value).searchParams.get('token')!;
  const owner = await openStream(url(token(publication.url as string), '/stream'));
  const original = manager.share(id, 60);
  const oldToken = token(original.remoteUrl);
  const shared = await openStream(url(oldToken, '/stream'), true);
  const remoteHeaders = { 'x-qubicl-access-surface': 'external' };
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const request = get(url(oldToken), { headers: { ...remoteHeaders, connection: 'Upgrade', upgrade: 'websocket' } });
    request.once('upgrade', (_response, connection) => resolve(connection));
    request.once('response', response => { response.resume(); reject(new Error(`Upgrade received HTTP ${response.statusCode}`)); });
    request.once('error', reject);
  });
  const socketClosed = once(socket, 'close');
  socket.resume();
  const replacement = manager.share(id, 3600);
  await Promise.all([shared.closed, socketClosed]);
  assert.equal(shared.response.complete, false);
  assert.equal(owner.response.destroyed, false);
  assert.equal((await fetch(url(oldToken), { headers: remoteHeaders })).status, 401);
  assert.equal(await (await fetch(url(token(replacement.remoteUrl)), { headers: remoteHeaders })).text(), 'available');
  const next = await openStream(url(token(replacement.remoteUrl), '/stream'), true);
  manager.revokeShare(id);
  await next.closed;
  assert.equal(owner.response.destroyed, false);
  manager.unpublish(id);
  await owner.closed;
});

test('interrupted upstream HTTP responses close the downstream client; complete responses still finish', {timeout:10_000}, async(context)=>{
  const target=createServer((request,response)=>{
    if(request.url==='/complete') {response.end('complete');return;}
    response.writeHead(200,{'content-length':'1000'}); response.write('partial');
    setTimeout(()=>response.destroy(),25);
  });
  const port=await listen(target); const manager=new PreviewManager({listPorts:async()=>[{port,address:'loopback',protocol:'tcp'}]},'127.0.0.1',base,base);
  await manager.publish(port);
  const proxy=createServer((request,response)=>{manager.proxyPublishedPort(request,response,port,request.url!);});
  const proxyPort=await listen(proxy);
  context.after(async()=>{manager.clear(); await close(proxy); await close(target);});
  const result=await new Promise<{body:string;complete:boolean}>((resolve,reject)=>{
    const request=get(`http://127.0.0.1:${proxyPort}/broken`,response=>{
      let body=''; response.on('data',chunk=>{body+=chunk;}); response.on('error',()=>undefined);
      response.once('close',()=>resolve({body,complete:response.complete}));
    });
    request.on('error',reject);
    request.setTimeout(1500,()=>{request.destroy(); reject(new Error('downstream hung'));});
  });
  assert.equal(result.body,'partial'); assert.equal(result.complete,false);
  assert.equal(await (await fetch(`http://127.0.0.1:${proxyPort}/complete`)).text(),'complete');
});

test('a completed upstream remains revocable while its downstream response is buffered', { timeout: 10_000 }, async (context) => {
  const body = Buffer.alloc(16 * 1024 * 1024, 'x');
  const target = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  });
  const port = await listen(target);
  const manager = new PreviewManager({ listPorts: async () => [{ port, address: 'loopback', protocol: 'tcp' }] }, '127.0.0.1', base, base, 'https://remote.test/previews');
  const publication = await manager.publish(port);
  const id = publication.id as string;
  const internal = manager as unknown as Internal;
  const track = internal.trackConnections.bind(manager);
  let observedUpstreamClose!: (complete: boolean) => void;
  const upstreamClosed = new Promise<boolean>(resolve => { observedUpstreamClose = resolve; });
  internal.trackConnections = (publicationId, scope, ...connections) => {
    for (const connection of connections) {
      if (connection instanceof IncomingMessage) connection.once('close', () => observedUpstreamClose(connection.complete));
    }
    return track(publicationId, scope, ...connections);
  };
  let downstream: ServerResponse | undefined;
  // Allow the proxy to consume the finite upstream while a paused client
  // applies real socket backpressure to the buffered outgoing response.
  const proxy = createServer({ highWaterMark: body.length * 2 }, (request, response) => {
    downstream = response;
    manager.handle(request, response, new URL(request.url!, base));
  });
  const proxyPort = await listen(proxy);
  context.after(async () => { manager.clear(); await close(proxy); await close(target); });
  const share = manager.share(id, 60);
  const token = new URL(share.remoteUrl).searchParams.get('token')!;
  const client = await new Promise<IncomingMessage>((resolve, reject) => {
    get(`http://127.0.0.1:${proxyPort}/_qubicl/previews/${id}/?token=${token}`, {
      headers: { 'x-qubicl-access-surface': 'external' },
    }, response => {
      response.pause();
      response.on('error', () => undefined);
      resolve(response);
    }).once('error', reject);
  });
  const clientClosed = new Promise<void>(resolve => client.once('close', resolve));
  assert.equal(await upstreamClosed, true);
  assert.equal(downstream!.writableFinished, false);
  assert.ok(downstream!.writableLength > 0);
  manager.share(id, 3600);
  assert.equal(downstream!.destroyed, true);
  client.resume();
  await clientClosed;
  assert.equal(client.complete, false);
});
async function listen(server:Server):Promise<number>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return (server.address() as {port:number}).port;}
async function close(server:Server):Promise<void>{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}

async function openStream(url: string, remote = false): Promise<{ response: IncomingMessage; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: remote ? { 'x-qubicl-access-surface': 'external' } : {} }, response => {
      if (response.statusCode !== 200) {
        response.resume(); reject(new Error(`Stream received HTTP ${response.statusCode}`)); return;
      }
      const closed = new Promise<void>(done => response.once('close', done));
      response.on('error', () => undefined);
      response.once('data', () => resolve({ response, closed }));
    });
    request.once('error', reject);
  });
}
