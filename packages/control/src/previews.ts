import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import type { ListeningPort } from './ports.js';
import { QubiclError } from './errors.js';
import { staticFilePreview } from './static-file-preview.js';

export interface PortSource { listPorts(): Promise<ListeningPort[]> }

interface PublicationBase {
  id: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

interface PortPublication extends PublicationBase {
  kind: 'port';
  port: number;
}

interface FilePublication extends PublicationBase {
  kind: 'file';
  root: string;
  source: FilePreviewSource;
}

type Publication = PortPublication | FilePublication;

export interface FilePreviewSource {
  canonicalPath(path: string, followFinal?: boolean): Promise<string>;
  readFile(path: string, maximumBytes?: number): Promise<{
    data: Buffer;
    info: { isFile(): boolean; size: number };
    resolvedPath: string;
  }>;
}

export interface FilePreviewPublication {
  id: string;
  createdAt: string;
  expiresAt: string;
  url: string;
  remoteUrl?: string;
}

export interface PreviewAccess {
  publicBaseUrl: string;
  remoteBaseUrl?: string;
}

export type PreviewAccessSource = () => PreviewAccess;

const MAX_FILE_PREVIEW_BYTES = 20_000_000;
const MAX_FILE_PUBLICATIONS = 64;
const FILE_PREVIEW_CSP = [
  'sandbox',
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "connect-src 'none'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ');

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
    const published = new Set([...this.publications.values()]
      .filter((publication): publication is PortPublication => publication.kind === 'port')
      .map(({ port }) => port));
    return (await this.ports.listPorts()).filter(({ port }) => published.has(port));
  }

  list(): Array<Omit<PortPublication, 'kind' | 'tokenHash'> & { url: string; remoteUrl?: string }> {
    this.prune();
    const access = this.previewAccess();
    return [...this.publications.values()]
      .filter((publication): publication is PortPublication => publication.kind === 'port')
      .map((publication) => ({
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
    const publication: PortPublication = {
      kind: 'port',
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

  async publishFile(
    path: string,
    expiresInSeconds: number,
    source: FilePreviewSource,
  ): Promise<FilePreviewPublication> {
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3600) {
      throw new QubiclError('invalid_arguments', 'File preview lifetime must be between 1 and 3600 seconds.', 400);
    }
    const namedPath = await source.canonicalPath(path, false);
    const canonicalPath = await source.canonicalPath(namedPath, true);
    if (canonicalPath !== namedPath) {
      throw new QubiclError('file_preview_symlink', 'Active previews cannot be opened through a symbolic link.', 400);
    }
    const root = await source.canonicalPath(dirname(namedPath), true);
    const relativePath = relative(root, namedPath);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === '..' || resolve(root, relativePath) !== namedPath) {
      throw new QubiclError('invalid_preview_path', 'The selected file cannot be scoped to an isolated preview directory.', 400);
    }
    this.prune();
    this.pruneFilePublications();
    const id = randomBytes(12).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const publication: FilePublication = {
      kind: 'file',
      id,
      root,
      source,
      tokenHash: digest(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    };
    this.publications.set(id, publication);
    const access = this.previewAccess();
    const suffix = encodePreviewPath(relativePath);
    return {
      id,
      createdAt: publication.createdAt,
      expiresAt: publication.expiresAt,
      url: `${this.externalPath(id, access.publicBaseUrl)}${suffix}?token=${encodeURIComponent(token)}`,
      ...(access.remoteBaseUrl
        ? { remoteUrl: `${this.remotePath(id, access.remoteBaseUrl)}${suffix}?token=${encodeURIComponent(token)}` }
        : {}),
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
    if (publication.kind === 'file') {
      void this.serveFile(
        request,
        response,
        publication,
        match[2] ?? '/',
        settingCookie ? token : undefined,
      ).catch(() => json(response, 404, {
        error: { code: 'file_preview_unavailable', message: 'The isolated file preview is unavailable.' },
      }));
    } else {
      this.proxy(request, response, publication, `${match[2] ?? '/'}${url.search}`, settingCookie ? token : undefined);
    }
    return true;
  }

  proxyPublishedPort(request: IncomingMessage, response: ServerResponse, port: number, targetPath: string): boolean {
    this.prune();
    const publication = [...this.publications.values()]
      .find((candidate): candidate is PortPublication => candidate.kind === 'port' && candidate.port === port);
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
    if (publication.kind !== 'port') {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
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

  private proxy(request: IncomingMessage, response: ServerResponse, publication: PortPublication, targetPath: string, cookieToken?: string): void {
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

  private async serveFile(
    request: IncomingMessage,
    response: ServerResponse,
    publication: FilePublication,
    encodedPath: string,
    cookieToken?: string,
  ): Promise<void> {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      response.setHeader('allow', 'GET, HEAD');
      json(response, 405, { error: { code: 'method_not_allowed', message: 'Isolated file previews support GET and HEAD only.' } });
      return;
    }
    const parts = decodePreviewPath(encodedPath);
    if (!parts.length) {
      json(response, 404, { error: { code: 'file_preview_not_found', message: 'The isolated file preview path is incomplete.' } });
      return;
    }
    const requestedPath = resolve(publication.root, ...parts);
    if (!within(publication.root, requestedPath)) {
      json(response, 403, { error: { code: 'file_preview_scope', message: 'The isolated file preview cannot leave its selected directory.' } });
      return;
    }
    let read: Awaited<ReturnType<FilePreviewSource['readFile']>>;
    try {
      read = await publication.source.readFile(requestedPath, MAX_FILE_PREVIEW_BYTES + 1);
    } catch {
      json(response, 404, { error: { code: 'file_preview_not_found', message: 'The isolated file preview file was not found.' } });
      return;
    }
    if (!read.info.isFile()) {
      json(response, 404, { error: { code: 'file_preview_not_found', message: 'The isolated file preview path is not a regular file.' } });
      return;
    }
    if (!within(publication.root, read.resolvedPath)) {
      json(response, 403, { error: { code: 'file_preview_scope', message: 'The isolated file preview cannot follow a link outside its selected directory.' } });
      return;
    }
    if (read.info.size > MAX_FILE_PREVIEW_BYTES || read.data.length > MAX_FILE_PREVIEW_BYTES) {
      json(response, 413, { error: { code: 'file_preview_too_large', message: `Isolated preview files are limited to ${MAX_FILE_PREVIEW_BYTES} bytes.` } });
      return;
    }
    const filename = parts.at(-1) ?? 'file';
    const body = staticFilePreview(filename, read.data);
    if (body.length > MAX_FILE_PREVIEW_BYTES) {
      json(response, 413, { error: { code: 'file_preview_too_large', message: `The static preview output exceeds ${MAX_FILE_PREVIEW_BYTES} bytes.` } });
      return;
    }
    const headers: Record<string, string | string[]> = {
      'content-type': previewMimeType(filename),
      'content-length': `${body.length}`,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
      'content-security-policy': FILE_PREVIEW_CSP,
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=()',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    if (cookieToken) {
      headers['set-cookie'] = [`qubicl_preview_${publication.id}=${cookieToken}; HttpOnly; SameSite=Strict; Path=${this.cookiePath(publication.id)}`];
    }
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
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

  private pruneFilePublications(): void {
    const files = [...this.publications.values()]
      .filter((publication): publication is FilePublication => publication.kind === 'file')
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    while (files.length >= MAX_FILE_PUBLICATIONS) {
      const oldest = files.shift();
      if (oldest) this.publications.delete(oldest.id);
    }
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

function encodePreviewPath(path: string): string {
  return path.split(sep).map((part) => encodeURIComponent(part)).join('/');
}

function decodePreviewPath(path: string): string[] {
  if (!path.startsWith('/')) throw new Error('Invalid preview path.');
  return path.slice(1).split('/').filter(Boolean).map((part) => {
    const decoded = decodeURIComponent(part);
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      throw new Error('Invalid preview path component.');
    }
    return decoded;
  });
}

function within(root: string, path: string): boolean {
  const result = relative(root, path);
  return result === '' || (result !== '..' && !result.startsWith(`..${sep}`));
}

function previewMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
    case '.htm': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.mp3': return 'audio/mpeg';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.pdf': return 'application/pdf';
    case '.xml': return 'application/xml; charset=utf-8';
    default: return 'application/octet-stream';
  }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}
