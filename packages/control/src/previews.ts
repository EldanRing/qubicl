import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ListeningPort } from './ports.js';
import { QubiclError } from './errors.js';

export interface PortSource { listPorts(): Promise<ListeningPort[]> }

interface Publication {
  id: string;
  port: number;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface PreviewAccess {
  publicBaseUrl: string;
  remoteBaseUrl?: string;
}

export type PreviewAccessSource = () => PreviewAccess;

export class PreviewManager {
  private readonly publications = new Map<string, Publication>();

  constructor(
    private readonly ports: PortSource,
    private readonly targetHost: string,
    private readonly publicBaseUrl: string,
    private readonly internalBaseUrl: string,
    private readonly remoteBaseUrl?: string,
    private readonly accessSource?: PreviewAccessSource,
  ) {}

  listPorts(): Promise<ListeningPort[]> { return this.ports.listPorts(); }

  async listPublishedPorts(): Promise<ListeningPort[]> {
    this.prune();
    const published = new Set([...this.publications.values()].map(({ port }) => port));
    return (await this.ports.listPorts()).filter(({ port }) => published.has(port));
  }

  list(): Array<Omit<Publication, 'tokenHash'> & { url: string; remoteUrl?: string }> {
    this.prune();
    const access = this.previewAccess();
    return [...this.publications.values()].map((publication) => ({
      id: publication.id,
      port: publication.port,
      createdAt: publication.createdAt,
      expiresAt: publication.expiresAt,
      url: this.externalPath(publication.id, access.publicBaseUrl),
      ...(access.remoteBaseUrl ? { remoteUrl: this.remotePath(publication.id, access.remoteBaseUrl) } : {}),
    }));
  }

  async publish(port: number, expiresInSeconds: number): Promise<Record<string, unknown>> {
    const listener = (await this.ports.listPorts()).find((candidate) => candidate.port === port);
    if (!listener) throw new QubiclError('port_not_listening', `TCP port ${port} is not currently listening as the computer user.`, 409);
    const id = randomBytes(12).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const publication: Publication = {
      id,
      port,
      tokenHash: digest(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    };
    this.publications.set(id, publication);
    const access = this.previewAccess();
    return {
      id,
      port,
      scope: 'host-loopback',
      authentication: 'unguessable-cookie',
      createdAt: publication.createdAt,
      expiresAt: publication.expiresAt,
      url: `${this.externalPath(id, access.publicBaseUrl)}?token=${encodeURIComponent(token)}`,
      ...(access.remoteBaseUrl ? { remoteUrl: `${this.remotePath(id, access.remoteBaseUrl)}?token=${encodeURIComponent(token)}` } : {}),
      browserUrl: `${this.internalPath(id)}?token=${encodeURIComponent(token)}`,
    };
  }

  unpublish(id: string): boolean { return this.publications.delete(id); }
  clear(): void { this.publications.clear(); }

  handle(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    const match = url.pathname.match(/^\/_qubicl\/previews\/([A-Za-z0-9_-]{16})(\/.*)?$/u);
    if (!match) return false;
    this.prune();
    const publication = this.publications.get(match[1]!);
    const token = url.searchParams.get('token') ?? previewCookie(request, match[1]!);
    if (!publication || !token || !constantDigestMatch(token, publication.tokenHash)) {
      json(response, 401, { error: { code: 'invalid_preview', message: 'This preview link is invalid, unpublished, or expired.' } });
      return true;
    }
    const settingCookie = url.searchParams.has('token');
    if (settingCookie) url.searchParams.delete('token');
    this.proxy(request, response, publication, `${match[2] ?? '/'}${url.search}`, settingCookie ? token : undefined);
    return true;
  }

  proxyPublishedPort(request: IncomingMessage, response: ServerResponse, port: number, targetPath: string): boolean {
    this.prune();
    const publication = [...this.publications.values()].find((candidate) => candidate.port === port);
    if (!publication) return false;
    this.proxy(request, response, publication, targetPath);
    return true;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
    const match = url.pathname.match(/^\/_qubicl\/previews\/([A-Za-z0-9_-]{16})(\/.*)?$/u);
    if (!match) return false;
    this.prune();
    const publication = this.publications.get(match[1]!);
    const token = url.searchParams.get('token') ?? previewCookie(request, match[1]!);
    if (!publication || !token || !constantDigestMatch(token, publication.tokenHash)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    url.searchParams.delete('token');
    const backend = connect(publication.port, this.targetHost);
    backend.once('connect', () => {
      const target = `${match[2] ?? '/'}${url.search}`;
      const lines = [`${request.method ?? 'GET'} ${target} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!;
        if (['host', 'cookie', 'authorization', 'x-qubicl-internal-key', 'x-qubicl-gateway-epoch'].includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${request.rawHeaders[index + 1] ?? ''}`);
      }
      lines.push(`Host: ${this.targetHost}:${publication.port}`, '', '');
      backend.write(lines.join('\r\n'));
      if (head.length) backend.write(head);
      socket.pipe(backend).pipe(socket);
    });
    backend.on('error', () => socket.destroy());
    socket.on('error', () => backend.destroy());
    socket.on('close', () => backend.destroy());
    return true;
  }

  private proxy(request: IncomingMessage, response: ServerResponse, publication: Publication, targetPath: string, cookieToken?: string): void {
    const headers = { ...request.headers };
    delete headers.authorization;
    delete headers.cookie;
    delete headers.host;
    delete headers['x-qubicl-internal-key'];
    delete headers['x-qubicl-gateway-epoch'];
    const upstream = httpRequest({ hostname: this.targetHost, port: publication.port, method: request.method, path: targetPath, headers }, (incoming) => {
      const outgoingHeaders = { ...incoming.headers };
      delete outgoingHeaders['set-cookie'];
      outgoingHeaders['cache-control'] ??= 'no-store';
      if (cookieToken) outgoingHeaders['set-cookie'] = [`qubicl_preview_${publication.id}=${cookieToken}; HttpOnly; SameSite=Strict; Path=${this.cookiePath(publication.id)}`];
      response.writeHead(incoming.statusCode ?? 502, outgoingHeaders);
      incoming.pipe(response);
    });
    upstream.on('error', (error) => json(response, 502, { error: { code: 'preview_unavailable', message: `Published port ${publication.port} is unavailable: ${error.message}` } }));
    request.pipe(upstream);
  }

  private previewAccess(): PreviewAccess {
    return this.accessSource?.() ?? {
      publicBaseUrl: this.publicBaseUrl,
      ...(this.remoteBaseUrl ? { remoteBaseUrl: this.remoteBaseUrl } : {}),
    };
  }
  private externalPath(id: string, baseUrl = this.previewAccess().publicBaseUrl): string { return `${baseUrl.replace(/\/$/u, '')}/${id}/`; }
  private internalPath(id: string): string { return `${this.internalBaseUrl.replace(/\/$/u, '')}/${id}/`; }
  private remotePath(id: string, baseUrl: string): string { return `${baseUrl.replace(/\/$/u, '')}/${id}/`; }
  private cookiePath(id: string): string {
    const value = this.externalPath(id);
    try { return new URL(value).pathname; } catch { return value.startsWith('/') ? value : '/'; }
  }
  private prune(): void {
    const now = Date.now();
    for (const [id, publication] of this.publications) if (Date.parse(publication.expiresAt) <= now) this.publications.delete(id);
  }
}

export function previewAccessFileSource(path: string): PreviewAccessSource {
  return () => readPreviewAccessFile(path);
}

function readPreviewAccessFile(path: string): PreviewAccess {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 16_384n || (Number(before.mode) & 0o077) !== 0) {
      throw new Error('must be a private regular file no larger than 16384 bytes');
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error('changed while it was read');
      offset += bytesRead;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error('changed while it was read');
    }
    const parsed = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    const expectedKeys = ['publicBaseUrl', ...(parsed.remoteBaseUrl === undefined ? [] : ['remoteBaseUrl']), 'version'].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || parsed.version !== 1) throw new Error('has an unsupported shape');
    const publicBaseUrl = exactPreviewBase(parsed.publicBaseUrl, 'http:');
    const remoteBaseUrl = parsed.remoteBaseUrl === undefined ? undefined : exactPreviewBase(parsed.remoteBaseUrl, 'https:');
    return { publicBaseUrl, ...(remoteBaseUrl ? { remoteBaseUrl } : {}) };
  } catch (error) {
    throw new Error(`Qubicl preview access document ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exactPreviewBase(value: unknown, protocol: 'http:' | 'https:'): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error(`must contain a bounded ${protocol.slice(0, -1).toUpperCase()} preview base URL`);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('contains an invalid preview base URL'); }
  if (parsed.protocol !== protocol || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.origin + parsed.pathname !== value || !parsed.pathname.endsWith('/previews')) {
    throw new Error(`must contain an exact ${protocol.slice(0, -1).toUpperCase()} preview base URL`);
  }
  return value;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function constantDigestMatch(value: string, expected: string): boolean {
  const actual = Buffer.from(digest(value), 'hex'); const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function previewCookie(request: IncomingMessage, id: string): string | undefined {
  const prefix = `qubicl_preview_${id}=`;
  return request.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}
