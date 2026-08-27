import { constants } from 'node:fs';
import { access, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildOpenTerminalOpenApi,
  isOpenTerminalImageTool,
  isToolName,
  QUBICL_MODEL_INSTRUCTIONS,
  toolDefinitions,
  type ToolName,
} from '@qubicl/core';
import { QubiclError } from './errors.js';
import type { ToolExecutor } from './executor.js';
import { mapFileSystemError, type FileErrorContext } from './file-errors.js';
import type { LeaseProof } from './lease.js';

const PREFIX = '/open-terminal';
const FILE_SERVE_PREFIX = '/files/serve/';
const DEFAULT_HOME = '/home/qubicl';
const LEASE_SECONDS = 600;
const MAX_UPLOAD_BYTES = 20_000_000;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 512_000;
const MAX_SESSION_CWDS = 256;
const SESSION_CWD_TTL_MS = 60 * 60 * 1000;
const MAX_SEARCH_RESULTS = 100;
const MATCH_PAGE_SIZE = 100;
const MAX_CONTENT_MATCHES_PER_FILE = 3;
const MAX_CONTENT_SEARCH_FILE_SIZE = 1_048_576;
const MAX_CONTENT_SEARCH_FILES = 500;
const MAX_CONTENT_SEARCH_BYTES = 25_000_000;
const PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

interface SessionCwd {
  path: string;
  touchedAt: number;
}

interface MultipartFile {
  filename: string;
  data: Buffer;
}

export interface OpenTerminalCompatibilityOptions {
  home?: string;
}

export class OpenTerminalCompatibility {
  private readonly home: string;
  private readonly sessionCwds = new Map<string, SessionCwd>();
  private lease: LeaseProof | undefined;
  private acquiringLease: Promise<LeaseProof> | undefined;

  constructor(
    private readonly executor: ToolExecutor,
    _enabledTools: readonly ToolName[],
    options: OpenTerminalCompatibilityOptions = {},
  ) {
    this.home = resolve(options.home ?? DEFAULT_HOME);
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      await this.dispatch(request, response, url);
    } catch (error) {
      sendCompatibilityError(response, error);
    }
    return true;
  }

  async shutdown(): Promise<void> {
    const proof = this.lease;
    this.lease = undefined;
    if (!proof) return;
    try {
      await this.executor.call('release_lease', { lease: proof });
    } catch {
      // A human takeover, expiry, or gateway epoch change may already have
      // fenced this compatibility lease.
    }
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.slice(PREFIX.length) || '/';
    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && path === '/api/config') {
      sendJson(response, 200, {
        features: { terminal: false, notebooks: false, system: true },
        compatibility: 'qubicl-open-terminal-v1',
        home: this.home,
      });
      return;
    }
    if (request.method === 'GET' && path === '/system') {
      sendJson(response, 200, {
        prompt: [
          QUBICL_MODEL_INSTRUCTIONS,
          `This Open Terminal connection's native file API is confined to ${this.home}.`,
          'Prefer browser_snapshot and ref-based browser actions. For targets without refs, use a viewport screenshot and coordinate actions, then inspect the updated result.',
        ].join('\n'),
      });
      return;
    }
    if (request.method === 'GET' && path === '/openapi.json') {
      sendJson(response, 200, buildOpenTerminalOpenApi(this.executor.computerId, this.executor.enabledToolNames()));
      return;
    }
    if (request.method === 'GET' && path === '/ports') {
      const result = await this.callTool('list_ports', {}) as { ports?: unknown[] };
      const published = new Set((await this.executor.previews.listPublishedPorts()).map(({ port }) => port));
      const ports = (result.ports ?? []).filter((entry) => isListeningPort(entry) && published.has(entry.port));
      sendJson(response, 200, { ports });
      return;
    }
    if (PROXY_METHODS.has(request.method ?? '') && path.startsWith('/proxy/')) {
      const match = path.match(/^\/proxy\/(\d+)(\/.*)?$/u);
      const port = match ? Number.parseInt(match[1]!, 10) : 0;
      if (!match || port < 1 || port > 65_535) throw new QubiclError('invalid_arguments', 'A valid published TCP port is required.', 400);
      const proxied = await this.withLease(async () => this.executor.previews.proxyPublishedPort(
        request,
        response,
        port,
        `${match[2] ?? '/'}${url.search}`,
      ));
      if (!proxied) throw new QubiclError('port_not_published', `TCP port ${port} is not currently published by Qubicl.`, 404);
      return;
    }
    if (request.method === 'GET' && path === '/files/cwd') {
      const cwd = this.cwdFor(request);
      sendJson(response, 200, { cwd, home: this.home, root: { path: this.home, label: 'Home' } });
      return;
    }
    if (request.method === 'POST' && path === '/files/cwd') {
      const body = await readJson(request);
      const requested = stringField(body, 'path');
      const target = await this.resolvePath(requested, request, true, { operation: 'inspect', path: requested });
      const info = await this.callTool('get_file_info', { path: target }) as { type?: string };
      if (info.type !== 'directory') throw new QubiclError('not_a_directory', `${target} is not a directory.`, 400);
      this.setCwd(request, target);
      sendJson(response, 200, { cwd: target });
      return;
    }
    if (request.method === 'GET' && path === '/files/list') {
      const requested = url.searchParams.get('directory') ?? '.';
      const target = await this.resolvePath(requested, request, true, { operation: 'list', path: requested });
      const entries = await Promise.all((await this.listCompatibilityFiles(target))
        .filter((entry) => typeof entry.name === 'string' && ['file', 'directory'].includes(entry.type ?? ''))
        .map(async (entry) => ({
          name: entry.name!,
          type: entry.type!,
          ...await compatibilityMetadata(join(target, entry.name!)),
        })));
      sendJson(response, 200, { dir: target, entries, writable: await isWritable(target) });
      return;
    }
    if (request.method === 'GET' && path === '/files/search') {
      const requested = url.searchParams.get('path') ?? '.';
      const target = await this.resolvePath(requested, request, true, { operation: 'list', path: requested });
      const limit = boundedIntegerQuery(url, 'limit', 20, 1, MAX_SEARCH_RESULTS);
      const type = enumQuery(url, 'type', ['file', 'directory', 'any'] as const, 'any');
      const showHidden = booleanQuery(url, 'show_hidden', false);
      const query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase();
      const ranked = (await this.listCompatibilityFiles(target, true))
        .filter((entry): entry is { name: string; type: string } => typeof entry.name === 'string'
          && ['file', 'directory'].includes(entry.type ?? '')
          && (type === 'any' || entry.type === type)
          && (showHidden || !hasHiddenSegment(entry.name)))
        .map((entry) => ({ entry, rank: filenameSearchRank(entry.name, query) }))
        .filter(({ rank }) => rank >= 0)
        .sort(compareRankedEntries)
        .slice(0, limit);
      const results = await Promise.all(ranked.map(async ({ entry }) => ({
        path: join(target, entry.name),
        name: basename(entry.name),
        type: entry.type,
        ...await compatibilityMetadata(join(target, entry.name)),
      })));
      sendJson(response, 200, { results });
      return;
    }
    if (request.method === 'GET' && path === '/files/matches') {
      const query = requiredQuery(url, 'query').trim();
      if (!query) throw new QubiclError('invalid_arguments', 'Query parameter query must not be blank.', 400);
      const requested = url.searchParams.get('path') ?? '.';
      const target = await this.resolvePath(requested, request, true, { operation: 'list', path: requested });
      const showHidden = booleanQuery(url, 'show_hidden', false);
      const offset = boundedIntegerQuery(url, 'offset', 0, 0, 1_000_000);
      const limit = boundedIntegerQuery(url, 'limit', MATCH_PAGE_SIZE, 1, MATCH_PAGE_SIZE);
      const matches = await this.matchCompatibilityFiles(target, query, showHidden);
      const page = matches.results.slice(offset, offset + limit);
      sendJson(response, 200, {
        results: page,
        next_offset: offset + page.length < matches.results.length ? offset + page.length : null,
        truncated: matches.truncated,
      });
      return;
    }
    if (request.method === 'GET' && path === '/files/display') {
      const requested = requiredQuery(url, 'path');
      const candidate = await this.resolvePath(requested, request, false, { operation: 'read', path: requested });
      let target: string;
      try {
        target = await this.resolvePath(requested, request, true, { operation: 'read', path: requested });
      } catch (error) {
        if (error instanceof QubiclError && error.code === 'path_not_found') {
          sendJson(response, 200, { path: candidate, exists: false });
          return;
        }
        throw error;
      }
      const info = await this.callTool('get_file_info', { path: target }) as { type?: string };
      sendJson(response, 200, {
        path: target,
        full_path: target,
        name: basename(target),
        mime_type: mimeType(target).split(';')[0],
        exists: info.type === 'file',
        ...(url.searchParams.has('page') ? { page: boundedIntegerQuery(url, 'page', 1, 1, 1_000_000) } : {}),
      });
      return;
    }
    if (request.method === 'GET' && path === '/files/read') {
      const requested = requiredQuery(url, 'path');
      const target = await this.resolvePath(requested, request, true, { operation: 'read', path: requested });
      const result = await this.callTool('read_file', {
        path: target,
        offset: 1,
        limit: 10_000,
        encoding: 'auto',
        maxBytes: MAX_UPLOAD_BYTES,
      }) as Record<string, unknown>;
      if (typeof result.data === 'string' && typeof result.mimeType === 'string') {
        sendBytes(response, 200, Buffer.from(result.data, 'base64'), result.mimeType, target);
        return;
      }
      sendJson(response, 200, {
        path: target,
        total_lines: result.totalLines ?? null,
        content: result.content ?? '',
        truncated: result.truncated ?? false,
      });
      return;
    }
    if (request.method === 'GET' && (path === '/files/view' || path.startsWith(FILE_SERVE_PREFIX))) {
      const requested = path === '/files/view'
        ? requiredQuery(url, 'path')
        : servedFilePath(path);
      const target = await this.resolvePath(requested, request, true, { operation: 'read', path: requested });
      const data = await this.withLease(async () => {
        try {
          const info = await stat(target);
          if (!info.isFile()) throw new QubiclError('not_a_file', `${target} is not a regular file.`, 400);
          if (info.size > MAX_UPLOAD_BYTES) throw new QubiclError('file_too_large', `${target} exceeds the ${MAX_UPLOAD_BYTES}-byte download limit.`, 413);
          return await readFile(target);
        } catch (error) {
          if (error instanceof QubiclError) throw error;
          throw mapFileSystemError(error, { operation: 'read', path: target });
        }
      });
      sendBytes(response, 200, data, mimeType(target), target);
      return;
    }
    if (request.method === 'POST' && path === '/files/upload') {
      const requestedDirectory = url.searchParams.get('directory') ?? '.';
      const directory = await this.resolvePath(requestedDirectory, request, true, { operation: 'inspect', path: requestedDirectory });
      const info = await this.callTool('get_file_info', { path: directory }) as { type?: string };
      if (info.type !== 'directory') throw new QubiclError('not_a_directory', `${directory} is not a directory.`, 400);
      const uploaded = await readMultipartFile(request);
      const requestedTarget = resolve(directory, uploaded.filename);
      const target = await this.resolvePath(requestedTarget, request, false, { operation: 'write', path: requestedTarget });
      await this.callTool('write_file', {
        path: target,
        content: uploaded.data.toString('base64'),
        encoding: 'base64',
        createParents: true,
      });
      sendJson(response, 200, { path: target, size: uploaded.data.length });
      return;
    }
    if (request.method === 'POST' && path === '/files/mkdir') {
      const body = await readJson(request);
      const requested = stringField(body, 'path');
      const target = await this.resolvePath(requested, request, false, { operation: 'write', path: requested });
      await this.withLease(async () => {
        try {
          await mkdir(target, { recursive: true, mode: 0o755 });
        } catch (error) {
          throw mapFileSystemError(error, { operation: 'write', path: target });
        }
      });
      sendJson(response, 200, { path: target });
      return;
    }
    if (request.method === 'DELETE' && path === '/files/delete') {
      const requested = requiredQuery(url, 'path');
      const target = await this.resolvePath(requested, request, true, { operation: 'delete', path: requested });
      if (target === this.home) throw new QubiclError('unsafe_delete', `Refusing to delete protected path ${this.home}.`, 400);
      const info = await this.callTool('get_file_info', { path: target }) as { type?: string };
      await this.callTool('delete_path', { path: target, recursive: info.type === 'directory' });
      sendJson(response, 200, { path: target, type: info.type ?? 'file' });
      return;
    }
    if (request.method === 'POST' && path === '/files/move') {
      const body = await readJson(request);
      const requestedSource = stringField(body, 'source');
      const requestedDestination = stringField(body, 'destination');
      const context = { operation: 'move', source: requestedSource, destination: requestedDestination } as const;
      const source = await this.resolvePath(requestedSource, request, true, context);
      const destination = await this.resolvePath(requestedDestination, request, false, context);
      await this.callTool('move_path', { source, destination, overwrite: false });
      sendJson(response, 200, { source, destination });
      return;
    }
    if (request.method === 'POST' && path === '/files/archive') {
      throw new QubiclError(
        'feature_unsupported',
        'Multi-file archive downloads are not available in Qubicl Open Terminal compatibility v1; download files individually.',
        501,
      );
    }
    if (request.method === 'POST' && path.startsWith('/v1/tools/')) {
      const name = path.slice('/v1/tools/'.length);
      if (!isToolName(name) || !this.executor.enabledToolNames().includes(name) || ['acquire_lease', 'renew_lease', 'release_lease'].includes(name)) {
        throw new QubiclError('tool_not_found', `Tool ${name} is not available through Open Terminal compatibility.`, 404);
      }
      const result = await this.callTool(name, await readJson(request));
      if (isOpenTerminalImageTool(name) || isImageResult(result)) {
        sendToolImage(response, result);
        return;
      }
      sendJson(response, 200, result);
      return;
    }
    throw new QubiclError('not_found', 'Open Terminal compatibility route not found.', 404);
  }

  private async callTool(name: ToolName, rawInput: unknown): Promise<unknown> {
    const input = objectInput(rawInput);
    if (!toolDefinitions[name].lease) return this.executor.call(name, input);
    const { lease: _ignored, ...withoutLease } = input;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await this.ensureLease();
      try {
        return await this.executor.call(name, { ...withoutLease, lease: proof });
      } catch (error) {
        if (!(error instanceof QubiclError) || error.code !== 'stale_lease' || attempt > 0) throw error;
        if (sameProof(this.lease, proof)) this.lease = undefined;
      }
    }
    throw new QubiclError('stale_lease', 'The Open Terminal compatibility lease could not be renewed.', 409);
  }

  private async listCompatibilityFiles(target: string, recursive = false): Promise<Array<{ name?: string; type?: string }>> {
    const entries: Array<{ name?: string; type?: string }> = [];
    let cursor = 0;
    while (entries.length < 10_000) {
      const listing = await this.callTool('list_files', {
        path: target,
        recursive,
        cursor,
        maxEntries: 1000,
      }) as { entries?: Array<{ name?: string; type?: string }>; nextCursor?: number };
      entries.push(...(listing.entries ?? []));
      if (listing.nextCursor === undefined) return entries;
      if (listing.nextCursor <= cursor) throw new QubiclError('invalid_file_result', 'Qubicl returned an invalid directory cursor.', 500);
      cursor = listing.nextCursor;
    }
    throw new QubiclError('too_many_entries', 'Directory listing exceeds the 10,000-entry Open Terminal compatibility limit.', 413);
  }

  private async matchCompatibilityFiles(target: string, query: string, showHidden: boolean): Promise<{
    results: Array<Record<string, unknown>>;
    truncated: boolean;
  }> {
    const lowered = query.toLocaleLowerCase();
    const entries = (await this.listCompatibilityFiles(target, true))
      .filter((entry): entry is { name: string; type: string } => typeof entry.name === 'string'
        && ['file', 'directory'].includes(entry.type ?? '')
        && (showHidden || !hasHiddenSegment(entry.name)))
      .sort((left, right) => left.name.localeCompare(right.name));
    const results: Array<Record<string, unknown> & { rank: number }> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = false;
    for (const entry of entries) {
      const nameRank = searchRank(entry.name, lowered);
      const contentMatches: Array<{ line: number; column: number; text: string }> = [];
      const candidate = join(target, entry.name);
      if (entry.type === 'file' && scannedFiles < MAX_CONTENT_SEARCH_FILES && scannedBytes < MAX_CONTENT_SEARCH_BYTES) {
        try {
          const info = await stat(candidate);
          if (info.isFile() && info.size <= MAX_CONTENT_SEARCH_FILE_SIZE && scannedBytes + info.size <= MAX_CONTENT_SEARCH_BYTES) {
            scannedFiles += 1;
            scannedBytes += info.size;
            const data = await readFile(candidate);
            const content = decodeSearchText(data);
            if (content !== undefined) {
              for (const [index, line] of content.split(/\r?\n/u).entries()) {
                const column = line.toLocaleLowerCase().indexOf(lowered);
                if (column >= 0) contentMatches.push({ line: index + 1, column: column + 1, text: line.slice(0, 1000) });
                if (contentMatches.length >= MAX_CONTENT_MATCHES_PER_FILE) break;
              }
            }
          }
        } catch {
          // Concurrently removed and unreadable files are omitted from content matching.
        }
      } else if (entry.type === 'file') {
        truncated = true;
      }
      if (nameRank < 0 && contentMatches.length === 0) continue;
      results.push({
        path: candidate,
        relative_path: entry.name,
        name: basename(entry.name),
        type: entry.type,
        name_match: nameRank >= 0,
        content_matches: contentMatches,
        rank: nameRank >= 0 ? nameRank : 4,
      });
    }
    results.sort((left, right) => left.rank - right.rank
      || String(left.relative_path).length - String(right.relative_path).length
      || String(left.relative_path).localeCompare(String(right.relative_path)));
    return { results: results.map(({ rank: _rank, ...result }) => result), truncated };
  }

  private async withLease<T>(action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await this.ensureLease();
      try {
        this.executor.leases.verify(proof, true);
        return await action();
      } catch (error) {
        if (!(error instanceof QubiclError) || error.code !== 'stale_lease' || attempt > 0) throw error;
        if (sameProof(this.lease, proof)) this.lease = undefined;
      }
    }
    throw new QubiclError('stale_lease', 'The Open Terminal compatibility lease could not be renewed.', 409);
  }

  private async ensureLease(): Promise<LeaseProof> {
    if (this.lease) return this.lease;
    this.acquiringLease ??= this.executor.call('acquire_lease', { durationSeconds: LEASE_SECONDS })
      .then((value) => {
        const record = objectInput(value);
        const proof = {
          id: stringField(record, 'id'),
          generation: numberField(record, 'generation'),
          epoch: stringField(record, 'epoch'),
        };
        this.lease = proof;
        return proof;
      })
      .finally(() => {
        this.acquiringLease = undefined;
      });
    return this.acquiringLease;
  }

  private cwdFor(request: IncomingMessage): string {
    this.pruneSessionCwds();
    const key = sessionKey(request);
    const found = this.sessionCwds.get(key);
    if (!found) return this.home;
    found.touchedAt = Date.now();
    return found.path;
  }

  private setCwd(request: IncomingMessage, path: string): void {
    this.pruneSessionCwds();
    const key = sessionKey(request);
    if (!this.sessionCwds.has(key) && this.sessionCwds.size >= MAX_SESSION_CWDS) {
      const oldest = [...this.sessionCwds.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (oldest) this.sessionCwds.delete(oldest[0]);
    }
    this.sessionCwds.set(key, { path, touchedAt: Date.now() });
  }

  private pruneSessionCwds(): void {
    const cutoff = Date.now() - SESSION_CWD_TTL_MS;
    for (const [key, value] of this.sessionCwds) {
      if (value.touchedAt < cutoff) this.sessionCwds.delete(key);
    }
  }

  private async resolvePath(
    value: string,
    request: IncomingMessage,
    mustExist: boolean,
    context: FileErrorContext,
  ): Promise<string> {
    const candidate = resolve(isAbsolute(value) ? value : resolve(this.cwdFor(request), value));
    requireInsideHome(this.home, candidate);
    if (mustExist) {
      try {
        const canonical = await realpath(candidate);
        requireInsideHome(this.home, canonical);
        return canonical;
      } catch (error) {
        throw mapFileSystemError(error, context);
      }
    }
    let existing = candidate;
    while (true) {
      try {
        const canonical = await realpath(existing);
        requireInsideHome(this.home, canonical);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw mapFileSystemError(error, context);
        const parent = dirname(existing);
        if (parent === existing) throw mapFileSystemError(error, context);
        existing = parent;
      }
    }
  }

}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QubiclError('invalid_arguments', 'Request body must be a JSON object.', 400);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== 'string' || field.length === 0) throw new QubiclError('invalid_arguments', `${name} must be a non-empty string.`, 400);
  return field;
}

function numberField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (typeof field !== 'number' || !Number.isInteger(field)) throw new QubiclError('invalid_arguments', `${name} must be an integer.`, 500);
  return field;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new QubiclError('invalid_arguments', `Query parameter ${name} is required.`, 400);
  return value;
}

function boundedIntegerQuery(url: URL, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new QubiclError('invalid_arguments', `Query parameter ${name} must be an integer from ${minimum} through ${maximum}.`, 400);
  }
  return value;
}

function booleanQuery(url: URL, name: string, fallback: boolean): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new QubiclError('invalid_arguments', `Query parameter ${name} must be true or false.`, 400);
}

function enumQuery<const T extends readonly string[]>(url: URL, name: string, allowed: T, fallback: T[number]): T[number] {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (allowed.includes(raw)) return raw as T[number];
  throw new QubiclError('invalid_arguments', `Query parameter ${name} must be one of: ${allowed.join(', ')}.`, 400);
}

function hasHiddenSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

function searchRank(path: string, query: string): number {
  if (!query) return 3;
  const relativePath = path.toLocaleLowerCase();
  const name = basename(path).toLocaleLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return relativePath.includes(query) ? 3 : -1;
}

function filenameSearchRank(path: string, query: string): number {
  if (!query) return 2;
  const name = basename(path).toLocaleLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  return name.includes(query) ? 2 : -1;
}

function compareRankedEntries(
  left: { entry: { name: string }; rank: number },
  right: { entry: { name: string }; rank: number },
): number {
  return left.rank - right.rank
    || left.entry.name.length - right.entry.name.length
    || left.entry.name.localeCompare(right.entry.name);
}

function decodeSearchText(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

async function compatibilityMetadata(path: string): Promise<{ size: number; modified: number; writable: boolean }> {
  const info = await stat(path);
  return { size: info.size, modified: info.mtimeMs / 1000, writable: await isWritable(path) };
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isListeningPort(value: unknown): value is { port: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.port === 'number';
}

function servedFilePath(path: string): string {
  const encoded = path.slice(FILE_SERVE_PREFIX.length);
  if (!encoded) throw new QubiclError('invalid_arguments', 'A file path is required.', 400);
  try {
    return `/${decodeURIComponent(encoded)}`;
  } catch {
    throw new QubiclError('invalid_arguments', 'The file preview path is not valid URL encoding.', 400);
  }
}

function sessionKey(request: IncomingMessage): string {
  const value = request.headers['x-session-id'];
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : 'default';
}

function requireInsideHome(home: string, path: string): void {
  const nested = relative(home, path);
  if (nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))) return;
  throw new QubiclError('path_outside_home', `Open Terminal compatibility is restricted to ${home}.`, 403);
}

function sameProof(left: LeaseProof | undefined, right: LeaseProof): boolean {
  return left?.id === right.id && left.generation === right.generation && left.epoch === right.epoch;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, MAX_REQUEST_BYTES);
  if (!body.length) return {};
  try {
    return objectInput(JSON.parse(body.toString('utf8')));
  } catch (error) {
    if (error instanceof QubiclError) throw error;
    throw new QubiclError('invalid_json', 'Request body must be valid JSON.', 400);
  }
}

async function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) throw new QubiclError('request_too_large', `Request body exceeds ${maximum} bytes.`, 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readMultipartFile(request: IncomingMessage): Promise<MultipartFile> {
  const contentType = request.headers['content-type'];
  const match = typeof contentType === 'string'
    ? contentType.match(/^multipart\/form-data\s*;.*\bboundary=(?:"([^"]+)"|([^;\s]+))/i)
    : undefined;
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200) throw new QubiclError('invalid_multipart', 'A valid multipart boundary is required.', 400);
  const body = await readBody(request, MAX_REQUEST_BYTES);
  const delimiter = Buffer.from(`--${boundary}`);
  const partEnd = Buffer.from(`\r\n--${boundary}`);
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) cursor += 2;
    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headersEnd < 0 || headersEnd - cursor > 16_384) break;
    const headers = body.subarray(cursor, headersEnd).toString('utf8');
    const end = body.indexOf(partEnd, headersEnd + 4);
    if (end < 0) break;
    const disposition = headers.match(/^content-disposition:\s*form-data;([^\r\n]+)$/im)?.[1] ?? '';
    const name = disposition.match(/\bname="([^"]+)"/i)?.[1];
    const filename = disposition.match(/\bfilename="([^"]*)"/i)?.[1];
    if (name === 'file' && filename) {
      const safeName = filename.replaceAll('\\', '/').split('/').pop()?.replaceAll('\0', '') ?? '';
      if (!safeName || safeName === '.' || safeName === '..') throw new QubiclError('invalid_filename', 'Uploaded filename is invalid.', 400);
      const data = body.subarray(headersEnd + 4, end);
      if (data.length > MAX_UPLOAD_BYTES) throw new QubiclError('file_too_large', `Uploaded files are limited to ${MAX_UPLOAD_BYTES} bytes.`, 413);
      return { filename: safeName, data };
    }
    cursor = end + 2;
  }
  throw new QubiclError('invalid_multipart', 'Multipart request must contain one file field.', 400);
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json';
    case '.html':
    case '.htm': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
    case '.ts': return 'text/javascript; charset=utf-8';
    case '.md':
    case '.txt':
    case '.csv':
    case '.log': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

function sendBytes(response: ServerResponse, status: number, value: Buffer, contentType: string, path: string): void {
  if (response.headersSent) return;
  const filename = path.split('/').pop() ?? 'file';
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': value.length,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(value);
}

function sendToolImage(response: ServerResponse, value: unknown): void {
  const record = objectInput(value);
  if (!isImageResult(record)) {
    throw new QubiclError('invalid_tool_image', 'Qubicl did not return a supported tool image.', 500);
  }
  let image: Buffer;
  try {
    image = Buffer.from(record.data, 'base64');
  } catch {
    throw new QubiclError('invalid_tool_image', 'Qubicl returned invalid tool image data.', 500);
  }
  if (!validImageBytes(image, record.mimeType) || image.length > MAX_UPLOAD_BYTES) {
    throw new QubiclError('invalid_tool_image', 'Qubicl returned invalid or oversized image data.', 500);
  }
  response.writeHead(200, {
    'content-type': record.mimeType,
    'content-length': image.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(typeof record.url === 'string' ? { 'x-browser-url': encodeURIComponent(record.url).slice(0, 4000) } : {}),
    ...(typeof record.title === 'string' ? { 'x-browser-title': encodeURIComponent(record.title).slice(0, 1000) } : {}),
    ...contentTrustHeaders(record.contentTrust),
  });
  response.end(image);
}

function contentTrustHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const trust = value as Record<string, unknown>;
  if (trust.level !== 'untrusted' || typeof trust.source !== 'string' || typeof trust.risk !== 'string') return {};
  return {
    'x-qubicl-content-trust': 'untrusted',
    'x-qubicl-content-source': trust.source.slice(0, 80),
    'x-qubicl-content-risk': trust.risk.slice(0, 80),
    ...(Array.isArray(trust.findings) && trust.findings.every((finding) => typeof finding === 'string')
      ? { 'x-qubicl-content-findings': trust.findings.join(',').slice(0, 1000) }
      : {}),
  };
}

function isImageResult(value: unknown): value is { data: string; mimeType: string; url?: string; title?: string; contentTrust?: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.data === 'string'
    && typeof record.mimeType === 'string'
    && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(record.mimeType);
}

function validImageBytes(value: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  if (mimeType === 'image/gif') return value.length >= 6 && ['GIF87a', 'GIF89a'].includes(value.subarray(0, 6).toString('ascii'));
  return value.length >= 12 && value.subarray(0, 4).toString('ascii') === 'RIFF' && value.subarray(8, 12).toString('ascii') === 'WEBP';
}

function sendCompatibilityError(response: ServerResponse, error: unknown): void {
  if (error instanceof QubiclError) {
    sendJson(response, error.status, { detail: error.message, code: error.code });
    return;
  }
  console.error(error);
  sendJson(response, 500, { detail: 'The Qubicl computer encountered an internal error.', code: 'internal_error' });
}
