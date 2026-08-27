import assert from 'node:assert/strict';
import { X509Certificate, createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import test from 'node:test';
import {
  Gateway,
  GatewayExposureError,
  loadGatewayExternalAccess,
} from '@qubicl/gateway/server';
import { RouteStore } from '@qubicl/gateway/routes';
import {
  GatewayExposureRuntimeSchema,
  gatewayExposureRuntimeId,
  hashToken,
  presetDefaults,
  type GatewayExposureRuntime,
} from '@qubicl/core';
import { createServer } from 'node:http';
import {
  TEST_GATEWAY_CERTIFICATE_PEM,
  TEST_GATEWAY_PRIVATE_KEY_PEM,
} from '../unit/gateway-test-fixtures.js';

const workstation = presetDefaults('workstation');
const id = '00000000-0000-4000-8000-000000000091';
const secondId = '00000000-0000-4000-8000-000000000092';

interface TlsMaterial {
  certificate: Buffer;
  privateKey: Buffer;
  runtime: GatewayExposureRuntime;
}

test('external gateway is TLS-only, origin-bound, token-isolated, bounded, and shares local state', async (context) => {
  const tls = await createTlsMaterial();
  const observed: Array<Record<string, string | string[] | undefined>> = [];
  const observedUpgrades: Array<Record<string, string | string[] | undefined>> = [];
  const backend = createServer((request, response) => {
    if (request.url !== '/_qubicl/gateway-epoch') observed.push({ ...request.headers });
    response.writeHead(200, {
      'content-type': 'application/json',
      ...(request.url?.startsWith('/_qubicl/previews/cookie')
        ? { 'set-cookie': [
          'qubicl_preview_fixture=secret; HttpOnly; SameSite=Strict; Path=/computers/',
          '__Host-qubicl_view=shadow; Domain=example.test; Secure; Path=/',
        ] }
        : {}),
    });
    response.end(JSON.stringify({ path: request.url }));
  });
  backend.on('upgrade', (request, socket) => {
    observedUpgrades.push({ ...request.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  context.after(() => backend.close());
  const backendPort = (backend.address() as AddressInfo).port;
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-external-gateway-'));
  const routesPath = join(directory, 'routes.json');
  await writeFile(routesPath, JSON.stringify({
    version: 2,
    generatedAt: new Date().toISOString(),
    routes: [runtimeRoute(backendPort), runtimeRoute(backendPort, secondId, 'second-token')],
  }));
  const gateway = new Gateway(new RouteStore(routesPath), 1_000, 25, {
    external: { ...tls, listenPort: 0 },
  });
  await gateway.start(0);
  context.after(() => gateway.close());
  const localPort = (gateway.server.address() as AddressInfo).port;
  const externalPort = (gateway.externalServer!.address() as AddressInfo).port;

  const localHealth = await fetch(`http://127.0.0.1:${localPort}/health`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(localHealth.routes, 2);
  assert.deepEqual(localHealth.external, {
    configured: true,
    ready: true,
    protocol: 'direct-tls-v1',
    configurationId: gatewayExposureRuntimeId(tls.runtime),
    port: 0,
  });

  const externalHealth = await externalRequest(tls, externalPort, '/health');
  assert.equal(externalHealth.status, 200);
  assert.deepEqual(JSON.parse(externalHealth.body), {
    status: 'ok',
    external: { configured: true, ready: true, protocol: 'direct-tls-v1' },
  });
  assert.doesNotMatch(externalHealth.body, /routes|viewerAuthentication/u);
  assert.match(await rawExternalRequest(tls, externalPort, 'https://%'), /^HTTP\/1\.1 400 /u);
  assert.equal((await externalRequest(tls, externalPort, '/health')).status, 200, 'a malformed request target cannot destabilize the listener');
  await assert.rejects(fetch(`http://127.0.0.1:${externalPort}/health`, { signal: AbortSignal.timeout(2_000) }));
  await assert.rejects(legacyTlsHandshake(tls, externalPort));

  const base = `/computers/${id}`;
  assert.equal((await externalRequest(tls, externalPort, `${base}/health`)).status, 401);
  assert.equal((await externalRequest(tls, externalPort, `${base}/health`, {
    headers: { authorization: 'Bearer token' },
  })).status, 200);
  assert.equal((await externalRequest(tls, externalPort, `${base}/openapi.json`, {
    headers: { authorization: 'Bearer other-computer-token' },
  })).status, 401);
  const rejectedStatuses: number[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    rejectedStatuses.push((await externalRequest(tls, externalPort, `${base}/openapi.json`, {
      headers: { authorization: 'Bearer invalid' },
    })).status);
  }
  assert.ok(rejectedStatuses.includes(429));
  assert.equal((await externalRequest(tls, externalPort, `${base}/openapi.json`, {
    headers: { authorization: 'Bearer token' },
  })).status, 200, 'valid per-computer authority remains usable after invalid-token throttling');

  const preflight = await externalRequest(tls, externalPort, `${base}/openapi.json`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://client.example.test',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://client.example.test');
  assert.equal((await externalRequest(tls, externalPort, `${base}/openapi.json`, {
    headers: { origin: 'https://evil.test', authorization: 'Bearer token' },
  })).status, 403);

  const proxied = await externalRequest(tls, externalPort, `${base}/openapi.json`, {
    headers: {
      authorization: 'Bearer token',
      forwarded: 'for=203.0.113.10;proto=https',
      'x-forwarded-for': '203.0.113.10',
      'x-real-ip': '203.0.113.10',
      'cf-connecting-ip': '203.0.113.10',
      'true-client-ip': '203.0.113.10',
      'x-client-ip': '203.0.113.10',
      connection: 'keep-alive, x-smuggled',
      'x-smuggled': 'must-not-reach-backend',
      'x-qubicl-internal-key': 'spoofed',
    },
  });
  assert.equal(proxied.status, 200);
  const headers = observed.at(-1)!;
  assert.equal(headers.forwarded, undefined);
  assert.equal(headers['x-forwarded-for'], undefined);
  assert.equal(headers['x-real-ip'], undefined);
  assert.equal(headers['cf-connecting-ip'], undefined);
  assert.equal(headers['true-client-ip'], undefined);
  assert.equal(headers['x-client-ip'], undefined);
  assert.equal(headers['x-smuggled'], undefined);
  assert.equal(headers.authorization, undefined);
  assert.notEqual(headers['x-qubicl-internal-key'], 'spoofed');

  assert.equal((await externalRequest(tls, externalPort, `${base}/operator/human-control/release`, {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  })).status, 403);
  assert.equal((await externalRequest(tls, externalPort, `${base}/openapi.json`, {
    headers: { authorization: 'Bearer token', 'content-length': `${16 * 1024 * 1024 + 1}` },
  })).status, 413);

  const wrongHost = await externalRequest(tls, externalPort, '/health', { host: 'other.test', servername: 'gateway.example.test' });
  assert.equal(wrongHost.status, 421);
  await assert.rejects(externalRequest(tls, externalPort, '/health', { servername: 'other.test' }));

  const ticket = await externalRequest(tls, externalPort, `${base}/view-ticket`, {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
  });
  const ticketPath = (JSON.parse(ticket.body) as { url: string }).url;
  const exchange = await externalRequest(tls, externalPort, ticketPath);
  assert.equal(exchange.status, 302);
  const cookie = `${exchange.headers['set-cookie']}`;
  assert.match(cookie, new RegExp(`^__Host-qubicl_view_${id}=`, 'u'));
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /Secure/u);
  assert.match(cookie, /SameSite=Strict/u);
  assert.match(cookie, /Path=\/(?:;|$)/u);
  assert.doesNotMatch(cookie, /Domain=/iu);
  assert.equal(exchange.headers['referrer-policy'], 'no-referrer');

  const viewerCookie = cookie.split(';')[0]!;
  const secondBase = `/computers/${secondId}`;
  const secondTicket = await externalRequest(tls, externalPort, `${secondBase}/view-ticket`, {
    method: 'POST',
    headers: { authorization: 'Bearer second-token' },
  });
  const secondTicketPath = (JSON.parse(secondTicket.body) as { url: string }).url;
  const secondExchange = await externalRequest(tls, externalPort, secondTicketPath);
  assert.equal(secondExchange.status, 302);
  const secondCookie = `${secondExchange.headers['set-cookie']}`.split(';')[0]!;
  assert.match(secondCookie, new RegExp(`^__Host-qubicl_view_${secondId}=`, 'u'));
  assert.equal((await externalRequest(tls, externalPort, `${base}/view/`, {
    headers: { cookie: `${viewerCookie}; ${secondCookie}` },
  })).status, 200);
  assert.equal((await externalRequest(tls, externalPort, `${secondBase}/view/`, {
    headers: { cookie: `${viewerCookie}; ${secondCookie}` },
  })).status, 200);
  const websocket = await externalWebSocket(
    tls,
    externalPort,
    id,
    `qubicl_view=shadow; ${viewerCookie}`,
    'https://gateway.example.test',
    { 'X-Real-IP': '203.0.113.10', 'CF-Connecting-IP': '203.0.113.10' },
  );
  assert.match(websocket, /^HTTP\/1\.1 101 /u);
  assert.equal(observedUpgrades.at(-1)?.['x-real-ip'], undefined);
  assert.equal(observedUpgrades.at(-1)?.['cf-connecting-ip'], undefined);
  const rejectedWebsocket = await externalWebSocket(tls, externalPort, id, viewerCookie, 'https://evil.test');
  assert.match(rejectedWebsocket, /^HTTP\/1\.1 403 /u);

  const previewHost = `preview-${id}.preview.example.test`;
  const preview = await externalRequest(tls, externalPort, `${base}/previews/publication/path`, {
    host: previewHost,
    servername: previewHost,
  });
  assert.equal(preview.status, 200);
  const previewExchange = await externalRequest(tls, externalPort, `${base}/previews/cookie?token=secret&answer=42`, {
    host: previewHost,
    servername: previewHost,
  });
  assert.equal(previewExchange.status, 302);
  assert.equal(previewExchange.headers.location, `${base}/previews/cookie?answer=42`);
  assert.equal(previewExchange.headers['cache-control'], 'no-store');
  assert.equal(previewExchange.headers['referrer-policy'], 'no-referrer');
  assert.match(`${previewExchange.headers['set-cookie']}`, /HttpOnly/u);
  assert.match(`${previewExchange.headers['set-cookie']}`, /Secure/u);
  assert.doesNotMatch(`${previewExchange.headers['set-cookie']}`, /(?:__Host-)?qubicl_view=/iu);
  assert.equal((await externalRequest(tls, externalPort, `${base}/previews/publication/path`)).status, 421);
  assert.equal((await externalRequest(tls, externalPort, '/computers/a/previews/publication/path')).status, 421);
  assert.equal((await externalRequest(tls, externalPort, '/health')).status, 200, 'a malformed preview route cannot destabilize the listener');
  assert.equal((await externalRequest(tls, externalPort, `${base}/openapi.json`, {
    host: previewHost,
    servername: previewHost,
    headers: { authorization: 'Bearer token' },
  })).status, 421);
});

test('external network denial and invalid exposure retain a healthy local listener', async (context) => {
  const tls = await createTlsMaterial({ allowedNetworks: ['10.0.0.0/8'] });
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-external-deny-'));
  const routesPath = join(directory, 'routes.json');
  await writeFile(routesPath, JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), routes: [] }));
  const denied = new Gateway(new RouteStore(routesPath), 1_000, 10_000, { external: { ...tls, listenPort: 0 } });
  await denied.start(0);
  context.after(() => denied.close());
  const deniedExternalPort = (denied.externalServer!.address() as AddressInfo).port;
  await assert.rejects(externalRequest(tls, deniedExternalPort, '/health'));
  const deniedLocalPort = (denied.server.address() as AddressInfo).port;
  assert.equal((await fetch(`http://127.0.0.1:${deniedLocalPort}/health`)).status, 200);

  const failedDirectory = await mkdtemp(join(tmpdir(), 'qubicl-external-failed-'));
  const failedRoutes = join(failedDirectory, 'routes.json');
  await writeFile(failedRoutes, JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), routes: [] }));
  const failed = new Gateway(new RouteStore(failedRoutes), 1_000, 10_000, { externalFailureCode: 'tls_material_mismatch' });
  await failed.start(0);
  context.after(() => failed.close());
  const failedLocalPort = (failed.server.address() as AddressInfo).port;
  const health = await fetch(`http://127.0.0.1:${failedLocalPort}/health`).then((response) => response.json()) as { external: unknown };
  assert.deepEqual(health.external, {
    configured: true,
    ready: false,
    protocol: 'direct-tls-v1',
    errorCode: 'tls_material_mismatch',
  });
});

test('configured client CA requires a validated TLS client certificate', async (context) => {
  const base = await createTlsMaterial();
  const tls: TlsMaterial = {
    ...base,
    runtime: GatewayExposureRuntimeSchema.parse({
      ...base.runtime,
      clientCertificateAuthoritySha256: sha256(base.certificate),
    }),
  };
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-external-mtls-'));
  const routesPath = join(directory, 'routes.json');
  await writeFile(routesPath, JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), routes: [] }));
  const gateway = new Gateway(new RouteStore(routesPath), 1_000, 10_000, {
    external: {
      ...tls,
      listenPort: 0,
      clientCertificateAuthority: tls.certificate,
    },
  });
  await gateway.start(0);
  context.after(() => gateway.close());
  const externalPort = (gateway.externalServer!.address() as AddressInfo).port;
  await assert.rejects(externalRequest(tls, externalPort, '/health'));
  assert.equal((await externalRequest(tls, externalPort, '/health', { clientCertificate: true })).status, 200);
});

test('gateway revalidates runtime TLS digests, key match, dates, hostname, and preview SAN', async () => {
  const tls = await createTlsMaterial();
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-external-material-'));
  const document = join(directory, 'gateway-exposure.json');
  const certificate = join(directory, 'certificate.pem');
  const privateKey = join(directory, 'private-key.pem');
  await writeFile(document, `${JSON.stringify(tls.runtime)}\n`, { mode: 0o600 });
  await writeFile(certificate, tls.certificate, { mode: 0o600 });
  await writeFile(privateKey, tls.privateKey, { mode: 0o600 });
  await chmod(privateKey, 0o600);
  const loaded = await loadGatewayExternalAccess({
    runtimeDocumentPath: document,
    certificatePath: certificate,
    privateKeyPath: privateKey,
    listenPort: 3216,
  });
  assert.equal(loaded.runtime.hostname, 'gateway.example.test');
  assert.equal(loaded.listenPort, 3216);

  await writeFile(document, `${JSON.stringify({ ...tls.runtime, privateKeySha256: `sha256:${'0'.repeat(64)}` })}\n`, { mode: 0o600 });
  await assert.rejects(
    loadGatewayExternalAccess({
      runtimeDocumentPath: document,
      certificatePath: certificate,
      privateKeyPath: privateKey,
      listenPort: 3216,
    }),
    (error: unknown) => error instanceof GatewayExposureError && error.code === 'tls_material_mismatch',
  );

  await writeFile(document, `${JSON.stringify(tls.runtime)}\n`, { mode: 0o600 });
  await assert.rejects(loadGatewayExternalAccess({
    runtimeDocumentPath: document,
    certificatePath: certificate,
    privateKeyPath: privateKey,
    listenPort: 3216,
    now: new Date(Date.parse(tls.runtime.certificateNotAfter) + 1),
  }), (error: unknown) => error instanceof GatewayExposureError && error.code === 'certificate_expired');
  await assert.rejects(loadGatewayExternalAccess({
    runtimeDocumentPath: document,
    certificatePath: certificate,
    privateKeyPath: privateKey,
    listenPort: 3216,
    now: new Date(Date.parse(tls.runtime.certificateNotBefore) - 1),
  }), (error: unknown) => error instanceof GatewayExposureError && error.code === 'certificate_not_yet_valid');

  await writeFile(document, `${JSON.stringify({ ...tls.runtime, hostname: 'other.example.test' })}\n`, { mode: 0o600 });
  await assert.rejects(loadGatewayExternalAccess({
    runtimeDocumentPath: document,
    certificatePath: certificate,
    privateKeyPath: privateKey,
    listenPort: 3216,
  }), (error: unknown) => error instanceof GatewayExposureError && error.code === 'certificate_hostname_mismatch');

  await writeFile(document, `${JSON.stringify({ ...tls.runtime, previewDomain: 'other-preview.example.test' })}\n`, { mode: 0o600 });
  await assert.rejects(loadGatewayExternalAccess({
    runtimeDocumentPath: document,
    certificatePath: certificate,
    privateKeyPath: privateKey,
    listenPort: 3216,
  }), (error: unknown) => error instanceof GatewayExposureError && error.code === 'certificate_preview_mismatch');

  const replacementKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
  const replacementKeyBuffer = Buffer.from(replacementKey);
  await writeFile(privateKey, replacementKeyBuffer, { mode: 0o600 });
  await writeFile(document, `${JSON.stringify({ ...tls.runtime, privateKeySha256: sha256(replacementKeyBuffer) })}\n`, { mode: 0o600 });
  await assert.rejects(loadGatewayExternalAccess({
    runtimeDocumentPath: document,
    certificatePath: certificate,
    privateKeyPath: privateKey,
    listenPort: 3216,
  }), (error: unknown) => error instanceof GatewayExposureError && error.code === 'tls_material_invalid');
});

async function createTlsMaterial(
  overrides: Partial<Pick<GatewayExposureRuntime, 'allowedNetworks' | 'trustedOrigins' | 'previewDomain'>> = {},
): Promise<TlsMaterial> {
  const certificate = Buffer.from(TEST_GATEWAY_CERTIFICATE_PEM, 'utf8');
  const privateKey = Buffer.from(TEST_GATEWAY_PRIVATE_KEY_PEM, 'utf8');
  const leaf = new X509Certificate(certificate);
  const fingerprint = leaf.fingerprint256.replaceAll(':', '').toLowerCase();
  const runtime = GatewayExposureRuntimeSchema.parse({
    version: 1,
    protocol: 'direct-tls-v1',
    hostname: 'gateway.example.test',
    port: 443,
    allowedNetworks: overrides.allowedNetworks ?? ['127.0.0.0/8'],
    trustedOrigins: overrides.trustedOrigins ?? ['https://gateway.example.test', 'https://client.example.test'],
    previewDomain: overrides.previewDomain ?? 'preview.example.test',
    certificateSha256: sha256(certificate),
    privateKeySha256: sha256(privateKey),
    certificateFingerprint256: `sha256:${fingerprint}`,
    certificateNotBefore: new Date(leaf.validFrom).toISOString(),
    certificateNotAfter: new Date(leaf.validTo).toISOString(),
  });
  return { certificate, privateKey, runtime };
}

function runtimeRoute(port: number, routeId = id, token = 'token') {
  return {
    id: routeId,
    name: 'external',
    host: '127.0.0.1',
    controlPort: port,
    viewPort: port,
    controlViewPort: port,
    preset: workstation.preset,
    compatibility: workstation.compatibility,
    capabilities: workstation.capabilities,
    manifestSha256: workstation.image.manifestSha256!,
    tokenHash: hashToken(token),
    internalKey: 'internal-key-that-is-definitely-long-enough',
  };
}

function sha256(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

interface ExternalRequestOptions {
  method?: string;
  host?: string;
  servername?: string;
  headers?: Record<string, string>;
  body?: string;
  clientCertificate?: boolean;
}

function externalRequest(
  tls: TlsMaterial,
  port: number,
  path: string,
  options: ExternalRequestOptions = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const host = options.host ?? 'gateway.example.test';
  const servername = options.servername ?? host;
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      servername,
      ca: tls.certificate,
      rejectUnauthorized: true,
      agent: false,
      ...(options.clientCertificate ? { cert: tls.certificate, key: tls.privateKey } : {}),
      headers: { host, ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', (error) => reject(new Error(`External request ${servername} ${host} ${path} failed: ${error.message}`, { cause: error })));
    request.end(options.body);
  });
}

function externalWebSocket(
  tls: TlsMaterial,
  port: number,
  computerId: string,
  cookie: string,
  origin: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: 'gateway.example.test',
      ca: tls.certificate,
      rejectUnauthorized: true,
    });
    let response = '';
    socket.once('secureConnect', () => socket.write([
      `GET /computers/${computerId}/view/websockify HTTP/1.1`,
      'Host: gateway.example.test',
      `Origin: ${origin}`,
      `Cookie: ${cookie}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n')));
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('error', reject);
    socket.once('close', () => {
      if (!response.includes('\r\n\r\n')) reject(new Error('External WebSocket closed before its HTTP response.'));
    });
  });
}

function rawExternalRequest(tls: TlsMaterial, port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: 'gateway.example.test',
      ca: tls.certificate,
      rejectUnauthorized: true,
    });
    let response = '';
    socket.once('secureConnect', () => socket.write([
      `GET ${target} HTTP/1.1`,
      'Host: gateway.example.test',
      'Connection: close',
      '',
      '',
    ].join('\r\n')));
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
  });
}

function legacyTlsHandshake(tls: TlsMaterial, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      servername: 'gateway.example.test',
      ca: tls.certificate,
      rejectUnauthorized: true,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.1',
    });
    socket.once('secureConnect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}
