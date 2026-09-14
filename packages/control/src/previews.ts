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
  createdAt: string;
}

interface PortPublication extends PublicationBase {
  kind: 'port';
  port: number;
  ownerTokenHash: string;
  share?: { tokenHash: string; expiresAt: string };
}

interface FilePublication extends PublicationBase {
  kind: 'file';
  tokenHash: string;
  expiresAt: string;
  root: string;
  entryPath: string;
  source: FilePreviewSource;
}

type Publication = PortPublication | FilePublication;
type PreviewConnectionScope = 'owner' | 'share' | 'management';

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

export interface ManagementPreviewSummary {
  id: string;
  kind: 'port' | 'file';
  status: 'published';
  createdAt: string;
  lifetime: 'while-listening' | 'expiring';
  expiresAt?: string;
  shareExpiresAt?: string;
  port?: number;
}

export interface ManagementPreviewTicket {
  path: string;
  expiresAt: string;
}

export type PreviewAccessSource = () => PreviewAccess;

const MAX_FILE_PREVIEW_BYTES = 20_000_000;
const MAX_FILE_PUBLICATIONS = 64;
const MAX_MANAGEMENT_TICKETS = 128;
const MAX_MANAGEMENT_SESSIONS = 256;
const MANAGEMENT_TICKET_TTL_MS = 60_000;
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
  private readonly managementTickets = new Map<string, { publicationId: string; access: 'local' | 'remote'; expiresAt: number }>();
  private readonly managementSessions = new Map<string, { publicationId: string; access: 'local' | 'remote'; expiresAt: number }>();
  private readonly activeConnections = new Map<string, Set<{ destroy(error?: Error): void }>>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly shareExpiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly portMonitor: NodeJS.Timeout;

  constructor(
    private readonly ports: PortSource,
    private readonly targetHost: string,
    private readonly publicBaseUrl: string,
    private readonly internalBaseUrl: string,
    private readonly remoteBaseUrl?: string,
    private readonly accessSource?: PreviewAccessSource,
  ) {
    this.portMonitor = setInterval(() => { void this.removeStoppedPortPublications(); }, 2_000);
    this.portMonitor.unref();
  }

  listPorts(): Promise<ListeningPort[]> { return this.ports.listPorts(); }

  async listPublishedPorts(): Promise<ListeningPort[]> {
    this.prune();
    const published = new Set([...this.publications.values()]
      .filter((publication): publication is PortPublication => publication.kind === 'port')
      .map(({ port }) => port));
    return (await this.ports.listPorts()).filter(({ port }) => published.has(port));
  }

  list(): Array<{ id: string; port: number; createdAt: string; lifetime: 'while-listening'; shareExpiresAt?: string; url: string; remoteUrl?: string }> {
    this.prune();
    const access = this.previewAccess();
    return [...this.publications.values()]
      .filter((publication): publication is PortPublication => publication.kind === 'port')
      .map((publication) => ({
        id: publication.id,
        port: publication.port,
        createdAt: publication.createdAt,
        lifetime: 'while-listening',
        ...(publication.share ? { shareExpiresAt: publication.share.expiresAt } : {}),
        url: this.externalPath(publication.id, access.publicBaseUrl),
        ...(access.remoteBaseUrl ? { remoteUrl: this.externalPath(publication.id, access.remoteBaseUrl) } : {}),
      }));
  }

  listForManagement(): ManagementPreviewSummary[] {
    this.prune();
    return [...this.publications.values()]
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
      .map((publication) => ({
        id: publication.id,
        kind: publication.kind,
        status: 'published',
        createdAt: publication.createdAt,
        lifetime: publication.kind === 'port' ? 'while-listening' : 'expiring',
        ...(publication.kind === 'file' ? { expiresAt: publication.expiresAt } : {}),
        ...(publication.kind === 'port' && publication.share ? { shareExpiresAt: publication.share.expiresAt } : {}),
        ...(publication.kind === 'port' ? { port: publication.port } : {}),
      }));
  }

  openForManagement(id: string, access: 'local' | 'remote'): ManagementPreviewTicket {
    this.prune();
    const publication = this.publications.get(id);
    if (!publication) throw new QubiclError('preview_not_found', `Published preview ${id} was not found.`, 404);
    const previewAccess = this.previewAccess();
    const base = access === 'local' ? previewAccess.publicBaseUrl : previewAccess.remoteBaseUrl;
    if (!base) throw new QubiclError('preview_not_exposed', 'Remote preview access is not configured.', 409);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(publicationDeadline(publication), Date.now() + MANAGEMENT_TICKET_TTL_MS);
    if (this.managementTickets.size >= MAX_MANAGEMENT_TICKETS) this.managementTickets.delete(this.managementTickets.keys().next().value!);
    this.managementTickets.set(digest(token), { publicationId: id, access, expiresAt });
    const suffix = publication.kind === 'file' ? publication.entryPath : '';
    const target = new URL(`${this.externalPath(id, base)}${suffix}`);
    target.searchParams.set('ticket', token);
    return { path: `${target.pathname}${target.search}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  revokeForManagement(id: string): { id: string; status: 'revoked' } {
    this.prune();
    if (!this.unpublish(id)) throw new QubiclError('preview_not_found', `Published preview ${id} was not found.`, 404);
    return { id, status: 'revoked' };
  }

  async publish(port: number, legacyShareExpiresInSeconds?: number): Promise<Record<string, unknown>> {
    const listener = (await this.ports.listPorts()).find((candidate) => candidate.port === port);
    if (!listener) throw new QubiclError('port_not_listening', `TCP port ${port} is not currently listening as the computer user.`, 409);
    const id = randomBytes(8).toString('hex');
    const ownerToken = randomBytes(32).toString('base64url');
    const now = new Date();
    const publication: PortPublication = {
      kind: 'port',
      id,
      port,
      ownerTokenHash: digest(ownerToken),
      createdAt: now.toISOString(),
    };
    this.publications.set(id, publication);
    const access = this.previewAccess();
    const legacyShare = legacyShareExpiresInSeconds !== undefined && access.remoteBaseUrl
      ? this.share(id, legacyShareExpiresInSeconds)
      : undefined;
    return {
      id,
      port,
      scope: 'host-loopback',
      authentication: 'unguessable-cookie',
      createdAt: publication.createdAt,
      lifetime: 'while-listening',
      url: `${this.externalPath(id, access.publicBaseUrl)}?token=${encodeURIComponent(ownerToken)}`,
      remoteSharingAvailable: Boolean(access.remoteBaseUrl),
      ...(legacyShare ? { remoteUrl: legacyShare.remoteUrl, shareExpiresAt: legacyShare.expiresAt } : {}),
      browserUrl: `${this.internalPath(id)}?token=${encodeURIComponent(ownerToken)}`,
    };
  }

  share(id: string, expiresInSeconds: number): { id: string; remoteUrl: string; createdAt: string; expiresAt: string } {
    this.prune();
    const publication = this.publications.get(id);
    if (!publication || publication.kind !== 'port') throw new QubiclError('preview_not_found', `Published port preview ${id} was not found.`, 404);
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86_400) {
      throw new QubiclError('invalid_arguments', 'Preview share lifetime must be between 60 and 86400 seconds.', 400);
    }
    const access = this.previewAccess();
    if (!access.remoteBaseUrl) throw new QubiclError('preview_not_exposed', 'Remote preview access is not configured.', 409);
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    publication.share = { tokenHash: digest(token), expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString() };
    this.scheduleShareExpiry(publication);
    return {
      id,
      createdAt: now.toISOString(),
      expiresAt: publication.share.expiresAt,
      remoteUrl: `${this.externalPath(id, access.remoteBaseUrl)}?token=${encodeURIComponent(token)}`,
    };
  }

  revokeShare(id: string): boolean {
    const publication = this.publications.get(id);
    if (!publication || publication.kind !== 'port' || !publication.share) return false;
    delete publication.share;
    this.clearShareExpiry(id);
    this.closeConnections(id, 'share');
    return true;
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
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const publication: FilePublication = {
      kind: 'file',
      id,
      root,
      entryPath: encodePreviewPath(relativePath),
      source,
      tokenHash: digest(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
    };
    this.publications.set(id, publication);
    this.scheduleExpiry(publication);
    const access = this.previewAccess();
    const suffix = publication.entryPath;
    return {
      id,
      createdAt: publication.createdAt,
      expiresAt: publication.expiresAt,
      url: `${this.externalPath(id, access.publicBaseUrl)}${suffix}?token=${encodeURIComponent(token)}`,
      ...(access.remoteBaseUrl
        ? { remoteUrl: `${this.externalPath(id, access.remoteBaseUrl)}${suffix}?token=${encodeURIComponent(token)}` }
        : {}),
    };
  }

  unpublish(id: string): boolean {
    const removed = this.publications.delete(id);
    if (removed) {
      this.clearManagementAccess(id);
      this.closeConnections(id);
      this.clearExpiry(id);
      this.clearShareExpiry(id);
    }
    return removed;
  }
  clear(): void {
    for (const id of [...this.publications.keys()]) this.unpublish(id);
    this.managementTickets.clear();
    this.managementSessions.clear();
  }

  handle(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    const match = url.pathname.match(/^\/_qubicl\/previews\/([A-Za-z0-9_-]{16})(\/.*)?$/u);
    if (!match) return false;
    this.prune();
    const publication = this.publications.get(match[1]!);
    const token = url.searchParams.get('token') ?? previewCookie(request, match[1]!);
    const managementToken = publication ? this.redeemManagementTicket(request, url, publication) : undefined;
    const connectionScope = publication && (managementToken
      ? 'management'
      : token ? this.validPreviewToken(request, publication, token) : undefined);
    if (!publication || !connectionScope) {
      json(response, 401, { error: { code: 'invalid_preview', message: 'This preview link is invalid, unpublished, or expired.' } });
      return true;
    }
    const settingCookie = managementToken ?? (url.searchParams.has('token') ? token : undefined);
    url.searchParams.delete('token');
    url.searchParams.delete('ticket');
    if (publication.kind === 'file') {
      void this.serveFile(
        request,
        response,
        publication,
        match[2] ?? '/',
        settingCookie,
      ).catch(() => json(response, 404, {
        error: { code: 'file_preview_unavailable', message: 'The isolated file preview is unavailable.' },
      }));
    } else {
      this.proxy(request, response, publication, `${match[2] ?? '/'}${url.search}`, connectionScope, settingCookie);
    }
    return true;
  }

  proxyPublishedPort(request: IncomingMessage, response: ServerResponse, port: number, targetPath: string): boolean {
    this.prune();
    const publication = [...this.publications.values()]
      .find((candidate): candidate is PortPublication => candidate.kind === 'port' && candidate.port === port);
    if (!publication) return false;
    this.proxy(request, response, publication, targetPath, 'owner');
    return true;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean {
    const match = url.pathname.match(/^\/_qubicl\/previews\/([A-Za-z0-9_-]{16})(\/.*)?$/u);
    if (!match) return false;
    this.prune();
    const publication = this.publications.get(match[1]!);
    const token = url.searchParams.get('token') ?? previewCookie(request, match[1]!);
    const connectionScope = publication && token ? this.validPreviewToken(request, publication, token) : undefined;
    if (!publication || !token || !connectionScope) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    if (publication.kind !== 'port') {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    url.searchParams.delete('token');
    const backend = connect(publication.port, this.targetHost);
    const release = this.trackConnections(publication.id, connectionScope, socket, backend);
    backend.once('connect', () => {
      const target = `${match[2] ?? '/'}${url.search}`;
      const lines = [`${request.method ?? 'GET'} ${target} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!;
        if (['host', 'cookie', 'authorization', 'x-qubicl-internal-key', 'x-qubicl-gateway-epoch', 'x-qubicl-access-surface', 'x-qubicl-preview-authorization', 'x-qubicl-preview-host', 'x-qubicl-preview-proto'].includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${request.rawHeaders[index + 1] ?? ''}`);
      }
      const cookies = applicationCookieHeader(request, publication.id);
      if (cookies) lines.push(`Cookie: ${cookies}`);
      const applicationAuthorization = request.headers['x-qubicl-preview-authorization'];
      if (typeof applicationAuthorization === 'string') lines.push(`Authorization: ${applicationAuthorization}`);
      const applicationHost = request.headers['x-qubicl-preview-host'];
      const applicationProto = request.headers['x-qubicl-preview-proto'];
      lines.push(`Host: ${typeof applicationHost === 'string' ? applicationHost : `${this.targetHost}:${publication.port}`}`);
      if (typeof applicationHost === 'string') lines.push(`X-Forwarded-Host: ${applicationHost}`);
      if (applicationProto === 'http' || applicationProto === 'https') lines.push(`X-Forwarded-Proto: ${applicationProto}`);
      lines.push('', '');
      backend.write(lines.join('\r\n'));
      if (head.length) backend.write(head);
      socket.pipe(backend).pipe(socket);
    });
    backend.on('error', () => socket.destroy());
    socket.on('error', () => backend.destroy());
    socket.on('close', () => { backend.destroy(); release(); });
    backend.on('close', release);
    return true;
  }

  private proxy(request: IncomingMessage, response: ServerResponse, publication: PortPublication, targetPath: string, scope: PreviewConnectionScope, cookieToken?: string): void {
    const headers = { ...request.headers };
    const applicationAuthorization = headers['x-qubicl-preview-authorization'];
    if (typeof applicationAuthorization === 'string') headers.authorization = applicationAuthorization;
    else delete headers.authorization;
    const applicationCookies = applicationCookieHeader(request, publication.id);
    if (applicationCookies) headers.cookie = applicationCookies;
    else delete headers.cookie;
    const applicationHost = headers['x-qubicl-preview-host'];
    const applicationProto = headers['x-qubicl-preview-proto'];
    if (typeof applicationHost === 'string') {
      headers.host = applicationHost;
      headers['x-forwarded-host'] = applicationHost;
    } else delete headers.host;
    if (applicationProto === 'http' || applicationProto === 'https') headers['x-forwarded-proto'] = applicationProto;
    delete headers['x-qubicl-internal-key'];
    delete headers['x-qubicl-gateway-epoch'];
    delete headers['x-qubicl-access-surface'];
    delete headers['x-qubicl-preview-authorization'];
    delete headers['x-qubicl-preview-host'];
    delete headers['x-qubicl-preview-proto'];
    const upstream = httpRequest({ hostname: this.targetHost, port: publication.port, method: request.method, path: targetPath, headers }, (incoming) => {
      const releaseResponse = this.trackConnections(publication.id, scope, incoming, response);
      const outgoingHeaders = { ...incoming.headers };
      const appCookies = safeApplicationCookies(incoming.headers['set-cookie'], publication.id);
      delete outgoingHeaders['set-cookie'];
      outgoingHeaders['cache-control'] ??= 'no-store';
      const previewCookie = cookieToken ? `qubicl_preview_${publication.id}=${cookieToken}; HttpOnly; SameSite=Strict; Path=${this.cookiePath(publication.id)}` : undefined;
      if (appCookies.length || previewCookie) outgoingHeaders['set-cookie'] = [...appCookies, ...(previewCookie ? [previewCookie] : [])];
      response.writeHead(incoming.statusCode ?? 502, outgoingHeaders);
      incoming.pipe(response);
      incoming.once('close', releaseResponse);
      response.once('close', releaseResponse);
      response.once('finish', releaseResponse);
    });
    const releaseRequest = this.trackConnections(publication.id, scope, upstream);
    upstream.once('close', releaseRequest);
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
  private externalPath(id: string, baseUrl = this.previewAccess().publicBaseUrl): string {
    const target = new URL(baseUrl);
    target.hostname = `${id}--${target.hostname}`;
    target.pathname = '/';
    target.search = '';
    target.hash = '';
    return target.href;
  }
  private internalPath(id: string): string { return `${this.internalBaseUrl.replace(/\/$/u, '')}/${id}/`; }
  private cookiePath(id: string): string {
    const value = this.externalPath(id);
    try { return new URL(value).pathname; } catch { return value.startsWith('/') ? value : '/'; }
  }
  private prune(): void {
    const now = Date.now();
    for (const [id, publication] of this.publications) {
      if (publication.kind === 'file' && Date.parse(publication.expiresAt) <= now) this.unpublish(id);
      else if (publication.kind === 'port' && publication.share && Date.parse(publication.share.expiresAt) <= now) this.revokeShare(id);
    }
    for (const [hash, ticket] of this.managementTickets) {
      if (ticket.expiresAt <= now || !this.publications.has(ticket.publicationId)) this.managementTickets.delete(hash);
    }
    for (const [hash, session] of this.managementSessions) {
      if (session.expiresAt <= now || !this.publications.has(session.publicationId)) this.managementSessions.delete(hash);
    }
  }

  private validPreviewToken(request: IncomingMessage, publication: Publication, token: string): PreviewConnectionScope | undefined {
    const access = request.headers['x-qubicl-access-surface'] === 'external' ? 'remote' : 'local';
    if (publication.kind === 'file' && constantDigestMatch(token, publication.tokenHash)) return access === 'remote' ? 'share' : 'owner';
    if (publication.kind === 'port') {
      if (access === 'local' && constantDigestMatch(token, publication.ownerTokenHash)) return 'owner';
      if (access === 'remote' && publication.share && Date.parse(publication.share.expiresAt) > Date.now()
        && constantDigestMatch(token, publication.share.tokenHash)) return 'share';
    }
    const session = this.managementSessions.get(digest(token));
    return session?.publicationId === publication.id && session.access === access && session.expiresAt > Date.now() ? 'management' : undefined;
  }

  private redeemManagementTicket(request: IncomingMessage, url: URL, publication: Publication): string | undefined {
    const token = url.searchParams.get('ticket');
    if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const hash = digest(token);
    const ticket = this.managementTickets.get(hash);
    if (!ticket || ticket.publicationId !== publication.id || ticket.expiresAt <= Date.now()
      || request.headers['x-qubicl-access-surface'] !== ticket.access) return undefined;
    this.managementTickets.delete(hash);
    const cookieToken = randomBytes(32).toString('base64url');
    if (this.managementSessions.size >= MAX_MANAGEMENT_SESSIONS) this.managementSessions.delete(this.managementSessions.keys().next().value!);
    this.managementSessions.set(digest(cookieToken), {
      publicationId: publication.id,
      access: ticket.access,
      expiresAt: publicationDeadline(publication),
    });
    return cookieToken;
  }

  private clearManagementAccess(publicationId: string): void {
    for (const [hash, ticket] of this.managementTickets) if (ticket.publicationId === publicationId) this.managementTickets.delete(hash);
    for (const [hash, session] of this.managementSessions) if (session.publicationId === publicationId) this.managementSessions.delete(hash);
  }

  private pruneFilePublications(): void {
    const files = [...this.publications.values()]
      .filter((publication): publication is FilePublication => publication.kind === 'file')
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    while (files.length >= MAX_FILE_PUBLICATIONS) {
      const oldest = files.shift();
      if (oldest) this.unpublish(oldest.id);
    }
  }

  private scheduleExpiry(publication: FilePublication): void {
    this.clearExpiry(publication.id);
    const timer = setTimeout(() => this.unpublish(publication.id), Math.max(1, Date.parse(publication.expiresAt) - Date.now() + 1));
    timer.unref();
    this.expiryTimers.set(publication.id, timer);
  }

  private clearExpiry(id: string): void {
    const timer = this.expiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(id);
  }

  private scheduleShareExpiry(publication: PortPublication): void {
    this.clearShareExpiry(publication.id);
    if (!publication.share) return;
    const timer = setTimeout(() => this.revokeShare(publication.id), Math.max(1, Date.parse(publication.share.expiresAt) - Date.now() + 1));
    timer.unref();
    this.shareExpiryTimers.set(publication.id, timer);
  }

  private clearShareExpiry(id: string): void {
    const timer = this.shareExpiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.shareExpiryTimers.delete(id);
  }

  private async removeStoppedPortPublications(): Promise<void> {
    const activePorts = new Set((await this.ports.listPorts().catch(() => [])).map(({ port }) => port));
    for (const publication of this.publications.values()) {
      if (publication.kind === 'port' && !activePorts.has(publication.port)) this.unpublish(publication.id);
    }
  }

  private trackConnections(id: string, scope: PreviewConnectionScope, ...connections: Array<{ destroy(error?: Error): void }>): () => void {
    const key = `${id}:${scope}`;
    const active = this.activeConnections.get(key) ?? new Set<{ destroy(error?: Error): void }>();
    for (const connection of connections) active.add(connection);
    this.activeConnections.set(key, active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const connection of connections) active.delete(connection);
      if (!active.size) this.activeConnections.delete(key);
    };
  }

  private closeConnections(id: string, scope?: PreviewConnectionScope): void {
    const keys = scope ? [`${id}:${scope}`] : [...this.activeConnections.keys()].filter((key) => key.startsWith(`${id}:`));
    for (const key of keys) {
      const active = this.activeConnections.get(key);
      this.activeConnections.delete(key);
      if (!active) continue;
      for (const connection of active) connection.destroy(new Error(scope === 'share' ? 'Preview share revoked.' : 'Preview publication revoked.'));
    }
  }
}

function publicationDeadline(publication: Publication): number {
  return publication.kind === 'file' ? Date.parse(publication.expiresAt) : Number.MAX_SAFE_INTEGER;
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

function applicationCookieHeader(request: IncomingMessage, id: string): string | undefined {
  const reserved = `qubicl_preview_${id}=`;
  const cookies = request.headers.cookie?.split(';').map((value) => value.trim())
    .filter((value) => value && !value.startsWith(reserved) && !value.startsWith('__Host-qubicl_') && !/^qubicl_view(?:_|=)/u.test(value));
  return cookies?.length ? cookies.join('; ') : undefined;
}

function safeApplicationCookies(values: string[] | undefined, publicationId: string): string[] {
  if (!values) return [];
  return values.flatMap((value) => {
    const [pair, ...attributes] = value.split(';');
    const separator = pair?.indexOf('=') ?? -1;
    const name = separator > 0 ? pair!.slice(0, separator).trim() : undefined;
    if (!name || name.toLowerCase() === `qubicl_preview_${publicationId}`.toLowerCase()
      || /^__host-qubicl_/iu.test(name) || /^qubicl_view(?:_|$)/iu.test(name)) return [];
    return [[
      pair!.trim(),
      ...attributes.map((attribute) => attribute.trim()).filter((attribute) => attribute && !/^domain=/iu.test(attribute)),
    ].join('; ')];
  });
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
