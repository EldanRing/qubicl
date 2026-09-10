import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetManifest, AssetManifestEntry } from './types.js';

const applicationDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = process.env.QUBICL_DASHBOARD_PUBLIC ?? join(applicationDirectory, 'public');
const manifestPath = process.env.QUBICL_DASHBOARD_MANIFEST ?? join(applicationDirectory, 'asset-manifest.json');
const host = process.env.QUBICL_DASHBOARD_HOST ?? '0.0.0.0';
const requestedPort = parsePort(process.env.QUBICL_DASHBOARD_PORT ?? '3213');

const manifestBytes = await readFile(manifestPath);
const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')) as unknown);
const assets = await loadVerifiedPublicAssets(manifest.assets);

const server = createServer((request, response) => {
  const method = request.method ?? '';
  applySecurityHeaders(response);
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return sendText(response, 405, 'Method not allowed.\n', method === 'HEAD');
  }
  const pathname = request.url ? safePathname(request.url) : undefined;
  if (!pathname) return sendText(response, 400, 'Bad request.\n', method === 'HEAD');
  if (pathname === '/health') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    return sendBody(response, 200, Buffer.from('{"status":"ok"}\n'), method === 'HEAD');
  }
  if (pathname === '/asset-manifest.json') {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    return sendBody(response, 200, manifestBytes, method === 'HEAD');
  }
  const key = pathname === '/' ? manifest.entrypoint : pathname;
  const asset = assets.get(key);
  if (!asset) return sendText(response, 404, 'Not found.\n', method === 'HEAD');
  response.setHeader('Content-Type', asset.entry.contentType);
  response.setHeader('ETag', `"sha256-${asset.entry.sha256}"`);
  response.setHeader('Cache-Control', asset.entry.cache === 'immutable' ? 'public, max-age=31536000, immutable' : 'no-store');
  if (request.headers['if-none-match'] === `"sha256-${asset.entry.sha256}"`) {
    response.statusCode = 304;
    return response.end();
  }
  return sendBody(response, 200, asset.bytes, method === 'HEAD');
});

server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
server.listen(requestedPort, host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  process.stdout.write(`Qubicl dashboard static server listening on http://${host}:${port}\n`);
});

function parseManifest(value: unknown): AssetManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.entrypoint !== 'string' || !Array.isArray(value.assets)) throw new Error('Dashboard asset manifest is invalid.');
  const seen = new Set<string>();
  const assets = value.assets.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.path !== 'string'
      || !/^\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(candidate.path)
      || candidate.path.includes('..')
      || typeof candidate.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(candidate.sha256)
      || typeof candidate.bytes !== 'number'
      || !Number.isSafeInteger(candidate.bytes)
      || candidate.bytes < 0
      || typeof candidate.contentType !== 'string'
      || (candidate.cache !== 'no-store' && candidate.cache !== 'immutable')) throw new Error('Dashboard asset manifest contains an invalid entry.');
    if (seen.has(candidate.path)) throw new Error(`Dashboard asset manifest repeats ${candidate.path}.`);
    seen.add(candidate.path);
    return candidate as unknown as AssetManifestEntry;
  });
  if (value.entrypoint !== '/index.html' || !seen.has(value.entrypoint)) throw new Error('Dashboard asset manifest is incomplete.');
  return { schemaVersion: 1, entrypoint: value.entrypoint, assets };
}

async function loadVerifiedPublicAssets(entries: AssetManifestEntry[]): Promise<Map<string, { entry: AssetManifestEntry; bytes: Buffer }>> {
  const loaded = new Map<string, { entry: AssetManifestEntry; bytes: Buffer }>();
  for (const entry of entries) {
    const relative = entry.path.slice(1);
    const bytes = await readFile(join(publicDirectory, relative));
    if (bytes.byteLength !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`Dashboard asset ${entry.path} does not match its manifest.`);
    }
    loaded.set(entry.path, { entry, bytes });
  }
  return loaded;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

function safePathname(rawUrl: string): string | undefined {
  try {
    const pathname = new URL(rawUrl, 'http://dashboard.invalid').pathname;
    if (pathname.includes('\\') || pathname.includes('\0')) return undefined;
    return pathname;
  } catch { return undefined; }
}

function sendText(response: ServerResponse, status: number, value: string, head: boolean): void {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  sendBody(response, status, Buffer.from(value), head);
}

function sendBody(response: ServerResponse, status: number, body: Buffer, head: boolean): void {
  response.statusCode = status;
  response.setHeader('Content-Length', String(body.byteLength));
  response.end(head ? undefined : body);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('QUBICL_DASHBOARD_PORT must be a valid TCP port.');
  return port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
