import ignore, { type Ignore } from 'ignore';
import { createReadStream, fstatSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
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
import { BoundedPathError, type BoundedFileSystem, type FileIdentity } from './bounded-files.js';
import { OPEN_TERMINAL_ARCHIVE_LIMITS, type OpenTerminalArchive } from './open-terminal-archive.js';
import {
  INTERACTIVE_CONSENT_FILE_PREVIEW_CSP,
  STATIC_FILE_PREVIEW_CSP,
  hasExecutablePreviewContent,
  staticFilePreviewBundle,
} from './static-file-preview.js';

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
const MAX_COMPATIBILITY_PATH_BYTES = 4_096;
const MAX_ARCHIVE_PATH_BYTES = 64 * 1024;
const MAX_STATIC_PREVIEW_ASSETS = 128;
const MAX_STATIC_PREVIEW_ASSET_BYTES = 12_000_000;
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
  private fileGeneration = 0;
  private readonly matchCache = new Map<string, { expires: number; proof: string; matches: { results: Array<Record<string, unknown>>; truncated: boolean } }>();
  private lease: LeaseProof | undefined;
  private acquiringLease: Promise<LeaseProof> | undefined;

  constructor(
    private readonly executor: ToolExecutor,
    _enabledTools: readonly ToolName[],
    options: OpenTerminalCompatibilityOptions = {},
  ) {
    this.home = resolve(options.home ?? DEFAULT_HOME);
    if (this.home !== this.executor.files.root) {
      throw new Error('The Open Terminal home must match the bounded filesystem root.');
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      if (request.method !== 'GET') { this.matchCache.clear(); this.fileGeneration++; }
      await this.dispatch(request, response, url);
    } catch (error) {
      sendCompatibilityError(response, error instanceof BoundedPathError
        ? new QubiclError('path_outside_home', `Open Terminal compatibility is restricted to ${this.home}.`, 403)
        : error);
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
      this.requireTools('list_ports');
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
    if (request.method === 'GET' && path === '/execute') {
      this.requireTools('exec_command');
      const processes = await this.withLease(async (proof) => this.executor.compatibilityProcessList(proof));
      sendJson(response, 200, processes);
      return;
    }
    if (request.method === 'POST' && path === '/execute') {
      this.requireTools('exec_command');
      const body = await readJson(request);
      const command = stringField(body, 'command');
      rejectCompatibilityEnvironment(body.env);
      const requestedCwd = body.cwd === undefined ? this.cwdFor(request) : stringField(body, 'cwd');
      assertCompatibilityPath(requestedCwd, 'cwd');
      const cwd = await this.resolvePath(requestedCwd, request, true, { operation: 'inspect', path: requestedCwd });
      const info = await this.executor.files.info(cwd).catch((error: unknown) => {
        throw mapFileSystemError(error, { operation: 'inspect', path: cwd });
      });
      if (!info.isDirectory()) throw new QubiclError('not_a_directory', `${cwd} is not a directory.`, 400);
      const result = await this.withLease(async (proof) => this.executor.compatibilityProcessExecute(
        command,
        cwd,
        proof,
        {
          waitMs: boundedIntegerQuery(url, 'wait', 10, 0, 30) * 1_000,
          tail: boundedIntegerQuery(url, 'tail', 100, 1, 1_000),
        },
        compatibilitySessionId(request),
      ));
      sendJson(response, 200, result);
      return;
    }
    const executeStatus = path.match(/^\/execute\/([A-Za-z0-9_-]{16,64})\/status$/u);
    if (request.method === 'GET' && executeStatus) {
      this.requireTools('exec_command');
      const result = await this.withLease(async (proof) => this.executor.compatibilityProcessStatus(
        executeStatus[1]!,
        proof,
        {
          waitMs: boundedIntegerQuery(url, 'wait', 0, 0, 30) * 1_000,
          offset: boundedIntegerQuery(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
          ...(url.searchParams.has('tail') ? { tail: boundedIntegerQuery(url, 'tail', 100, 1, 1_000) } : {}),
        },
      ));
      sendJson(response, 200, result);
      return;
    }
    const executeInput = path.match(/^\/execute\/([A-Za-z0-9_-]{16,64})\/input$/u);
    if (request.method === 'POST' && executeInput) {
      this.requireTools('write_stdin');
      const body = await readJson(request);
      const result = await this.withLease(async (proof) => this.executor.compatibilityProcessInput(
        executeInput[1]!,
        stringValue(body.input, 'input'),
        proof,
      ));
      sendJson(response, 200, result);
      return;
    }
    const executeDelete = path.match(/^\/execute\/([A-Za-z0-9_-]{16,64})$/u);
    if (request.method === 'DELETE' && executeDelete) {
      this.requireTools('stop_process');
      const result = await this.withLease(async (proof) => this.executor.compatibilityProcessDelete(
        executeDelete[1]!,
        proof,
        booleanQuery(url, 'force', false),
      ));
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'GET' && path === '/files/cwd') {
      this.requireTools('list_files');
      const cwd = this.cwdFor(request);
      sendJson(response, 200, { cwd, home: this.home, root: { path: this.home, label: 'Home' } });
      return;
    }
    if (request.method === 'POST' && path === '/files/cwd') {
      this.requireTools('get_file_info');
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
      this.requireTools('list_files');
      const requested = url.searchParams.get('directory') ?? '.';
      const target = await this.resolvePath(requested, request, true, { operation: 'list', path: requested });
      const listing = await this.listCompatibilityFiles(target);
      const entries = await mapConcurrent(
        listing.entries.filter((entry) => ['file', 'directory'].includes(entry.type)),
        async (entry) => ({
          name: entry.name!,
          type: entry.type!,
          ...await compatibilityMetadata(this.executor.files, join(target, entry.name!)),
        }));
      sendJson(response, 200, { dir: target, entries, truncated: listing.truncated, writable: await this.executor.files.isWritable(target) });
      return;
    }
    if (request.method === 'GET' && path === '/files/search') {
      this.requireTools('list_files');
      const requested = url.searchParams.get('path') ?? '.';
      const target = await this.resolvePath(requested, request, true, { operation: 'list', path: requested });
      const limit = boundedIntegerQuery(url, 'limit', 20, 1, MAX_SEARCH_RESULTS);
      const type = enumQuery(url, 'type', ['file', 'directory', 'any'] as const, 'any');
      const showHidden = booleanQuery(url, 'show_hidden', false);
      const query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase();
      const listing = await this.listCompatibilityFiles(target, true, showHidden);
      const ranked = listing.entries
        .filter((entry): entry is { name: string; type: 'file' | 'directory' } => typeof entry.name === 'string'
          && ['file', 'directory'].includes(entry.type ?? '')
          && (type === 'any' || entry.type === type)
          && (showHidden || !hasHiddenSegment(entry.name)))
        .map((entry) => ({ entry, rank: filenameSearchRank(entry.name, query) }))
        .filter(({ rank }) => rank >= 0)
        .sort(compareRankedEntries);
      const results = await mapConcurrent(ranked.slice(0, limit), async ({ entry }) => ({
        path: join(target, entry.name),
        name: basename(entry.name),
        type: entry.type,
        ...await compatibilityMetadata(this.executor.files, join(target, entry.name)),
      }));
      sendJson(response, 200, { results, truncated: listing.truncated || ranked.length > limit });
      return;
    }
    if (request.method === 'GET' && path === '/files/matches') {
      this.requireTools('list_files', 'read_file');
      const query = requiredQuery(url, 'query').trim();
      if (!query) throw new QubiclError('invalid_arguments', 'Query parameter query must not be blank.', 400);
      const requested = url.searchParams.get('path') ?? '.';
      const target = await this.resolvePath(requested, request, true, { operation: 'list', path: requested });
      const showHidden = booleanQuery(url, 'show_hidden', false);
      const offset = boundedIntegerQuery(url, 'offset', 0, 0, 1_000_000);
      const limit = boundedIntegerQuery(url, 'limit', MATCH_PAGE_SIZE, 1, MATCH_PAGE_SIZE);
      const matches = await this.withLease(async (proof) => {
        const key = JSON.stringify([sessionKey(request), target, query, showHidden]);
        const now = Date.now();
        const generation = this.fileGeneration;
        for (const [id, cached] of this.matchCache) if (cached.expires <= now) this.matchCache.delete(id);
        const cached = offset > 0 ? this.matchCache.get(key) : undefined;
        const result = cached?.proof === JSON.stringify(proof) ? cached.matches : await this.matchCompatibilityFiles(target, query, showHidden);
        this.requireTools('list_files', 'read_file');
        this.executor.leases.verify(proof, true);
        if ((!cached || cached.proof !== JSON.stringify(proof)) && generation === this.fileGeneration) {
          if (this.matchCache.size >= 4) this.matchCache.delete(this.matchCache.keys().next().value!);
          this.matchCache.set(key, { expires: now + 15_000, proof: JSON.stringify(proof), matches: result });
        }
        return result;
      });
      const page = matches.results.slice(offset, offset + limit);
      sendJson(response, 200, {
        results: page,
        next_offset: offset + page.length < matches.results.length ? offset + page.length : null,
        truncated: matches.truncated,
      });
      return;
    }
    if (request.method === 'GET' && path === '/files/display') {
      this.requireTools('get_file_info');
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
      this.requireTools('read_file');
      const requested = requiredQuery(url, 'path');
      const target = await this.resolvePath(requested, request, true, { operation: 'read', path: requested });
      const result = await this.withLease((proof) => this.executor.compatibilityFileRead(target, proof));
      if (result.mimeType) {
        sendBytes(response, 200, result.data, result.mimeType, target);
        return;
      }
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.data); }
      catch { throw new QubiclError('unsupported_binary_file', 'This file cannot be edited as UTF-8 text. Download the original instead.', 415); }
      sendJson(response, 200, { path: target, total_lines: content.split('\n').length, content, truncated: false });
      return;
    }
    if (request.method === 'GET' && (path === '/files/view' || path.startsWith(FILE_SERVE_PREFIX))) {
      this.requireTools('read_file');
      const servedInline = path.startsWith(FILE_SERVE_PREFIX);
      const requested = path === '/files/view'
        ? requiredQuery(url, 'path')
        : servedFilePath(path);
      const target = await this.resolvePath(
        requested,
        request,
        true,
        { operation: 'read', path: requested },
        { followFinal: !servedInline },
      );
      const result = await this.withLease(async (proof) => {
        try {
          const read = await this.executor.files.readFile(target, MAX_UPLOAD_BYTES + 1);
          const info = read.info;
          if (!info.isFile()) throw new QubiclError('not_a_file', `${target} is not a regular file.`, 400);
          if (info.size > MAX_UPLOAD_BYTES || read.data.length > MAX_UPLOAD_BYTES) throw new QubiclError('file_too_large', `${target} exceeds the ${MAX_UPLOAD_BYTES}-byte download limit.`, 413);
          let staticPreview;
          let interactive = false;
          if (servedInline && requiresIsolatedPreview(target)) {
            if (!sameFileIdentity(read.identity, read.namedIdentity)) {
              throw new QubiclError('file_preview_symlink', 'Active previews cannot be opened through a symbolic link.', 400);
            }
            if (hasExecutablePreviewContent(target, read.data)) {
              interactive = true;
            }
            staticPreview = await buildStaticPreview(
              target,
              read.data,
              this.executor.files,
              interactive ? read.data : undefined,
            );
            if (staticPreview.length > MAX_UPLOAD_BYTES) {
              throw new QubiclError('file_preview_too_large', `The self-contained static preview exceeds ${MAX_UPLOAD_BYTES} bytes.`, 413);
            }
          }
          this.executor.leases.verify(proof, true);
          return { data: read.data, staticPreview, interactive };
        } catch (error) {
          if (error instanceof QubiclError) throw error;
          throw mapFileSystemError(error, { operation: 'read', path: target });
        }
      });
      const extension = extname(target).toLowerCase();
      if (path === '/files/view' && booleanQuery(url, 'preview', false) && (extension === '.docx' || extension === '.pptx')) {
        const cancellation = requestCancellation(request, response);
        try {
          const pdf = await this.withLease((proof) => this.executor.compatibilityOfficePreview(result.data, extension, proof, cancellation.signal));
          sendBytes(response, 200, pdf, 'application/pdf', `${target.slice(0, -extension.length)}.pdf`, 'inline');
        } finally { cancellation.cleanup(); }
        return;
      }
      if (result.staticPreview) {
        sendStaticPreview(response, target, result.staticPreview, result.interactive);
        return;
      }
      sendBytes(
        response,
        200,
        result.data,
        servedInline && requiresSourcePreview(target) ? 'text/plain; charset=utf-8' : mimeType(target),
        target,
        servedInline ? 'inline' : undefined,
      );
      return;
    }
    if (request.method === 'POST' && path === '/files/upload') {
      this.requireTools('write_file');
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
      this.requireTools('write_file');
      const body = await readJson(request);
      const requested = stringField(body, 'path');
      const target = await this.resolvePath(requested, request, false, { operation: 'write', path: requested });
      await this.withLease(async () => {
        try {
          await this.executor.files.mkdir(target, 0o755);
        } catch (error) {
          throw mapFileSystemError(error, { operation: 'write', path: target });
        }
      });
      sendJson(response, 200, { path: target });
      return;
    }
    if (request.method === 'DELETE' && path === '/files/delete') {
      this.requireTools('get_file_info', 'delete_path');
      const requested = requiredQuery(url, 'path');
      const target = await this.resolvePath(requested, request, true, { operation: 'delete', path: requested });
      if (target === this.home) throw new QubiclError('unsafe_delete', `Refusing to delete protected path ${this.home}.`, 400);
      const info = await this.callTool('get_file_info', { path: target }) as { type?: string };
      await this.callTool('delete_path', { path: target, recursive: info.type === 'directory' });
      sendJson(response, 200, { path: target, type: info.type ?? 'file' });
      return;
    }
    if (request.method === 'POST' && path === '/files/move') {
      this.requireTools('move_path');
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
      this.requireTools('list_files', 'read_file');
      const body = await readJson(request);
      const requested = stringArrayField(body, 'paths', 1, OPEN_TERMINAL_ARCHIVE_LIMITS.maximumPaths);
      let pathBytes = 0;
      for (const value of requested) {
        assertCompatibilityPath(value, 'paths');
        pathBytes += Buffer.byteLength(value, 'utf8');
        if (pathBytes > MAX_ARCHIVE_PATH_BYTES) {
          throw new QubiclError('invalid_arguments', `Archive paths exceed the ${MAX_ARCHIVE_PATH_BYTES}-byte aggregate limit.`, 400);
        }
      }
      const targets = await Promise.all(requested.map((value) => this.resolveArchivePath(value, request)));
      const cancellation = requestCancellation(request, response);
      let archive: OpenTerminalArchive | undefined;
      try {
        archive = await this.withLease(async (proof) => this.executor.compatibilityArchive(targets, proof, cancellation.signal));
        await sendArchive(response, archive, cancellation.signal);
      } finally {
        cancellation.cleanup();
        await archive?.cleanup();
      }
      return;
    }
    if (request.method === 'POST' && path.startsWith('/v1/tools/')) {
      const operation = path.slice('/v1/tools/'.length);
      const name = operation === 'run_command' ? 'exec_command' : operation === 'replace_file_content' ? 'edit_file' : operation;
      if (!isToolName(name) || !this.executor.enabledToolNames().includes(name) || ['acquire_lease', 'renew_lease', 'release_lease'].includes(name)) {
        throw new QubiclError('tool_not_found', `Tool ${name} is not available through Open Terminal compatibility.`, 404);
      }
      const input = await readJson(request);
      if (operation === 'replace_file_content') {
        const { path: filePath, old_text, new_text, ...extra } = input;
        if (Object.keys(extra).length) throw new QubiclError('invalid_arguments', 'Unexpected replacement parameters.', 400);
        input.path = filePath;
        input.edits = [{ oldText: old_text, newText: new_text }];
        delete input.old_text;
        delete input.new_text;
      }
      if (name === 'exec_command') {
        input.cwd = await this.resolvePath(typeof input.cwd === 'string' ? input.cwd : '.', request, true, { operation: 'inspect', path: String(input.cwd ?? '.') });
      }
      if (['list_files', 'read_file', 'write_file', 'edit_file', 'get_file_info', 'create_directory', 'delete_path', 'move_path', 'copy_path'].includes(name)) {
        for (const key of ['path', 'source', 'destination']) {
          if (typeof input[key] === 'string') input[key] = this.executor.files.absolutePath(resolve(this.cwdFor(request), input[key]));
        }
        if (name === 'list_files' && input.path === undefined) input.path = this.cwdFor(request);
      }
      const result = await this.callTool(name, input);
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
    this.requireTools(name);
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

  private async listCompatibilityFiles(target: string, recursive = false, showHidden = false) {
    const scopes = new Map<string, Ignore>();
    let ignoreBytes = 0;
    let incompleteIgnores = false;
    const listing = await this.withLease((proof) => this.executor.compatibilityFileList(target, proof, recursive, recursive ? {
      maximumDepth: 64,
      maximumVisited: 100_000,
      skipUnreadable: true,
      prepareDirectory: async (prefix) => {
        const path = join(target, prefix, '.gitignore');
        try {
          if (ignoreBytes >= 1_000_000) { incompleteIgnores = true; return; }
          const read = await this.executor.files.readFile(path, Math.min(64_000, 1_000_000 - ignoreBytes));
          ignoreBytes += read.data.length;
          if (read.data.length < read.info.size || read.data.length > 64_000) { incompleteIgnores = true; return; }
          scopes.set(prefix, ignore().add(read.data.toString('utf8')));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incompleteIgnores = true;
        }
      },
      include: (name, directory) => {
        if (!showHidden && hasHiddenSegment(name)) return false;
        let ignored = false;
        for (const [prefix, rules] of scopes) {
          if (prefix && !name.startsWith(`${prefix}${sep}`)) continue;
          const scoped = (prefix ? name.slice(prefix.length + 1) : name).split(sep).join('/') + (directory ? '/' : '');
          const result = rules.test(scoped);
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        return !ignored;
      },
    } : {}));
    return { ...listing, truncated: listing.truncated || incompleteIgnores };
  }

  private async matchCompatibilityFiles(target: string, query: string, showHidden: boolean): Promise<{
    results: Array<Record<string, unknown>>;
    truncated: boolean;
  }> {
    const lowered = query.toLocaleLowerCase();
    const listing = await this.listCompatibilityFiles(target, true, showHidden);
    const entries = listing.entries
      .filter((entry): entry is { name: string; type: 'file' | 'directory' } => typeof entry.name === 'string'
        && ['file', 'directory'].includes(entry.type ?? '')
        && (showHidden || !hasHiddenSegment(entry.name)))
      .sort((left, right) => left.name.localeCompare(right.name));
    const results: Array<Record<string, unknown> & { rank: number }> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let truncated = listing.truncated;
    for (const entry of entries) {
      const nameRank = searchRank(entry.name, lowered);
      const contentMatches: Array<{ line: number; column: number; text: string }> = [];
      const candidate = join(target, entry.name);
      if (entry.type === 'file' && scannedFiles < MAX_CONTENT_SEARCH_FILES && scannedBytes < MAX_CONTENT_SEARCH_BYTES) {
        const reservedBytes = Math.min(MAX_CONTENT_SEARCH_FILE_SIZE + 1, MAX_CONTENT_SEARCH_BYTES - scannedBytes);
        scannedFiles += 1;
        // Charge before reading: a failed read may already have consumed I/O.
        // BoundedFileSystem reads at most maximumBytes + one overflow byte.
        scannedBytes += reservedBytes;
        try {
          const read = await this.executor.files.readFile(candidate, reservedBytes - 1);
          scannedBytes -= reservedBytes - read.data.length;
          const info = read.info;
          if (info.isFile() && info.size <= MAX_CONTENT_SEARCH_FILE_SIZE
            && read.data.length <= MAX_CONTENT_SEARCH_FILE_SIZE && read.data.length >= info.size) {
            const content = decodeSearchText(read.data);
            if (content !== undefined) {
              for (const [index, line] of content.split(/\r?\n/u).entries()) {
                const column = line.toLocaleLowerCase().indexOf(lowered);
                if (column >= 0) contentMatches.push({ line: index + 1, column: column + 1, text: line.slice(0, 1000) });
                if (contentMatches.length >= MAX_CONTENT_MATCHES_PER_FILE) break;
              }
            }
          } else {
            truncated = true;
          }
        } catch {
          // Preserve the reservation when partial I/O before failure is unknown.
          truncated = true;
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

  private async withLease<T>(action: (proof: LeaseProof) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await this.ensureLease();
      let actionInvoked = false;
      try {
        this.executor.leases.verify(proof, true);
        actionInvoked = true;
        return await action(proof);
      } catch (error) {
        if (actionInvoked || !(error instanceof QubiclError) || error.code !== 'stale_lease' || attempt > 0) throw error;
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

  private requireTools(...names: ToolName[]): void {
    const enabled = new Set(this.executor.enabledToolNames());
    const unavailable = names.filter((name) => !enabled.has(name));
    if (unavailable.length) {
      throw new QubiclError(
        'capability_unsupported',
        `This Open Terminal compatibility route is unavailable because operator policy disables: ${unavailable.join(', ')}.`,
        404,
      );
    }
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
    options: { followFinal?: boolean } = {},
  ): Promise<string> {
    const candidate = resolve(isAbsolute(value) ? value : resolve(this.cwdFor(request), value));
    try {
      const bounded = this.executor.files.absolutePath(candidate);
      if (mustExist) {
        const followFinal = options.followFinal ?? (context.operation !== 'delete' && context.operation !== 'move');
        return await this.executor.files.canonicalPath(bounded, followFinal);
      }
      await this.executor.files.assertDestination(bounded);
      return bounded;
    } catch (error) {
      if (error instanceof BoundedPathError) {
        throw new QubiclError('path_outside_home', `Open Terminal compatibility is restricted to ${this.home}.`, 403);
      }
      throw mapFileSystemError(error, context);
    }
  }

  private async resolveArchivePath(value: string, request: IncomingMessage): Promise<string> {
    const candidate = resolve(isAbsolute(value) ? value : resolve(this.cwdFor(request), value));
    try {
      const bounded = this.executor.files.absolutePath(candidate);
      return await this.executor.files.canonicalPath(bounded, false);
    } catch (error) {
      if (error instanceof BoundedPathError) {
        throw new QubiclError('path_outside_home', `Open Terminal compatibility is restricted to ${this.home}.`, 403);
      }
      throw mapFileSystemError(error, { operation: 'inspect', path: value });
    }
  }

}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs && left.size === right.size;
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

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new QubiclError('invalid_arguments', `${name} must be a string.`, 400);
  return value;
}

function stringArrayField(value: Record<string, unknown>, name: string, minimum: number, maximum: number): string[] {
  const field = value[name];
  if (!Array.isArray(field) || field.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || field.length < minimum || field.length > maximum) {
    throw new QubiclError('invalid_arguments', `${name} must contain ${minimum} through ${maximum} non-empty strings.`, 400);
  }
  return field as string[];
}

function rejectCompatibilityEnvironment(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new QubiclError('invalid_arguments', 'env must be an object when provided.', 400);
  }
  if (Object.keys(value as Record<string, unknown>).length > 0) {
    throw new QubiclError('environment_unsupported', 'Per-command environment overrides are unavailable in Qubicl compatibility mode.', 400);
  }
}

function assertCompatibilityPath(value: string, name: string): void {
  if (value.length > MAX_COMPATIBILITY_PATH_BYTES || Buffer.byteLength(value, 'utf8') > MAX_COMPATIBILITY_PATH_BYTES) {
    throw new QubiclError('invalid_arguments', `${name} paths are limited to ${MAX_COMPATIBILITY_PATH_BYTES} UTF-8 bytes and code units.`, 400);
  }
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

async function compatibilityMetadata(files: BoundedFileSystem, path: string): Promise<{ size: number; modified: number; writable: boolean }> {
  const info = await files.stat(path);
  return { size: info.size, modified: info.mtimeMs / 1000, writable: await files.isWritable(path) };
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

function compatibilitySessionId(request: IncomingMessage): string | null {
  const value = request.headers['x-session-id'];
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
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

function sendBytes(
  response: ServerResponse,
  status: number,
  value: Buffer,
  contentType: string,
  path: string,
  disposition?: 'attachment' | 'inline',
): void {
  if (response.headersSent) return;
  const filename = path.split('/').pop() ?? 'file';
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': value.length,
    'content-disposition': `${disposition ?? (requiresAttachment(path) ? 'attachment' : 'inline')}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(value);
}

function sendStaticPreview(response: ServerResponse, path: string, body: Buffer, interactive: boolean): void {
  if (response.headersSent) return;
  const filename = basename(path);
  response.writeHead(200, {
    'content-type': mimeType(path),
    'content-length': body.length,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
    'content-security-policy': interactive ? INTERACTIVE_CONSENT_FILE_PREVIEW_CSP : STATIC_FILE_PREVIEW_CSP,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=()',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

async function sendArchive(response: ServerResponse, archive: OpenTerminalArchive, signal?: AbortSignal): Promise<void> {
  if (response.headersSent) return;
  if (signal?.aborted) throw new QubiclError('archive_cancelled', 'Archive transfer was cancelled because the client disconnected.', 499);
  const info = fstatSync(archive.descriptor, { bigint: true });
  if (!info.isFile() || info.nlink !== 0n || (info.mode & 0o222n) !== 0n
    || info.dev !== archive.identity.dev || info.ino !== archive.identity.ino
    || info.size !== archive.identity.size || info.size !== BigInt(archive.size)) {
    throw new QubiclError('archive_output_changed', 'The completed ZIP archive changed before it could be sent.', 500);
  }
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': archive.size,
    'content-disposition': "attachment; filename=\"archive.zip\"; filename*=UTF-8''archive.zip",
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  const transfer = new AbortController();
  const onAbort = (): void => transfer.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => transfer.abort(new Error('archive send timeout')), OPEN_TERMINAL_ARCHIVE_LIMITS.sendTimeoutMs);
  timeout.unref();
  try {
    await pipeline(createReadStream('', {
      fd: archive.descriptor,
      autoClose: false,
      start: 0,
      end: archive.size - 1,
    }), response, { signal: transfer.signal });
  } catch (error) {
    if (transfer.signal.aborted) {
      if (signal?.aborted) throw new QubiclError('archive_cancelled', 'Archive transfer was cancelled because the client disconnected.', 499);
      throw new QubiclError('archive_send_timeout', `Archive transfer exceeded ${OPEN_TERMINAL_ARCHIVE_LIMITS.sendTimeoutMs} milliseconds.`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function requestCancellation(request: IncomingMessage, response: ServerResponse): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error('file client disconnected'));
  const close = (): void => { if (!response.writableFinished) cancel(); };
  request.once('aborted', cancel);
  response.once('close', close);
  if (request.aborted || response.destroyed) cancel();
  return {
    signal: controller.signal,
    cleanup: () => {
      request.off('aborted', cancel);
      response.off('close', close);
    },
  };
}

function requiresAttachment(path: string): boolean {
  return ['.html', '.htm', '.js', '.mjs', '.ts', '.svg'].includes(extname(path).toLowerCase());
}

function requiresIsolatedPreview(path: string): boolean {
  return ['.html', '.htm', '.svg'].includes(extname(path).toLowerCase());
}

function requiresSourcePreview(path: string): boolean {
  return ['.js', '.mjs', '.ts'].includes(extname(path).toLowerCase());
}

async function buildStaticPreview(
  path: string,
  data: Buffer,
  files: BoundedFileSystem,
  interactiveSource?: Buffer,
): Promise<Buffer> {
  const root = dirname(path);
  let assets = 0;
  let assetBytes = 0;
  return staticFilePreviewBundle(path, data, async (relativePath) => {
    if (assets >= MAX_STATIC_PREVIEW_ASSETS) return undefined;
    const candidate = resolve(root, relativePath);
    if (!withinDirectory(root, candidate)) return undefined;
    const remaining = MAX_STATIC_PREVIEW_ASSET_BYTES - assetBytes;
    if (remaining <= 0) return undefined;
    assets += 1;
    try {
      const read = await files.readFile(candidate, Math.min(remaining + 1, MAX_UPLOAD_BYTES + 1));
      if (!read.info.isFile() || read.data.length > remaining || !withinDirectory(root, read.resolvedPath)) return undefined;
      assetBytes += read.data.length;
      return { data: read.data, mimeType: mimeType(candidate).split(';')[0]! };
    } catch {
      return undefined;
    }
  }, { ...(interactiveSource ? { interactiveSource } : {}) });
}

function withinDirectory(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
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

async function mapConcurrent<T, R>(values: readonly T[], action: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(16, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await action(values[index]!);
    }
  }));
  return results;
}
