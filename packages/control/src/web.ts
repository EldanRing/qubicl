import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { QubiclError, errorPayload } from './errors.js';

const MAX_REQUEST_BYTES = 16_384;
// JSON escaping can expand a 1.5 MB rendered DOM, so the authenticated
// transport envelope is larger while the provider independently enforces the
// actual rendered-HTML ceiling.
const MAX_RENDERED_REQUEST_BYTES = 3_200_000;
const MAX_PROVIDER_OUTPUT_BYTES = 2_000_000;
const PROVIDER_TIMEOUT_MS = 35_000;

export interface WebSearchInput { query: string; limit: number }
export interface WebExtractInput { url: string; format: 'markdown' | 'text'; maxChars: number }
export interface WebExtractRenderedInput {
  finalUrl: string;
  title: string;
  contentType: string;
  html: string;
  sourceTruncated: boolean;
  format: 'markdown' | 'text';
  maxChars: number;
}
export interface WebSearchProvider { search(input: WebSearchInput): Promise<Record<string, unknown>> }
export interface WebExtractProvider {
  extract(input: WebExtractInput): Promise<Record<string, unknown>>;
  extractRendered(input: WebExtractRenderedInput): Promise<Record<string, unknown>>;
}

export class LocalWebProvider implements WebSearchProvider, WebExtractProvider {
  constructor(
    private readonly executable = process.env.QUBICL_WEB_PYTHON ?? '/opt/qubicl/web-venv/bin/python',
    private readonly script = process.env.QUBICL_WEB_PROVIDER ?? '/opt/qubicl/web-provider.py',
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS,
  ) {}

  search(input: WebSearchInput): Promise<Record<string, unknown>> { return this.invoke('search', input); }
  extract(input: WebExtractInput): Promise<Record<string, unknown>> { return this.invoke('extract', input); }
  extractRendered(input: WebExtractRenderedInput): Promise<Record<string, unknown>> { return this.invoke('extract-rendered', input); }

  private invoke(operation: 'search' | 'extract' | 'extract-rendered', input: object): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [this.script, operation], {
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          HOME: '/tmp',
          LANG: 'C.UTF-8',
          QUBICL_NETWORK_POLICY: process.env.QUBICL_NETWORK_POLICY ?? '{"profile":"developer"}',
          ...(process.env.QUBICL_PROXY_URL ? { QUBICL_PROXY_URL: process.env.QUBICL_PROXY_URL } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), this.timeoutMs);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_PROVIDER_OUTPUT_BYTES) child.kill('SIGKILL');
        else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (Buffer.concat(stderr).length < 8192) stderr.push(chunk);
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        let value: { error?: { code?: string; message?: string }; [key: string]: unknown } | undefined;
        try { value = JSON.parse(Buffer.concat(stdout).toString('utf8')) as typeof value; } catch { /* handled below */ }
        if (code !== 0 || !value) {
          const reason = value?.error?.message ?? Buffer.concat(stderr).toString('utf8').trim() ?? '';
          const timedOut = signal === 'SIGKILL' && bytes <= MAX_PROVIDER_OUTPUT_BYTES;
          const status = value?.error ? providerStatus(value.error.code) : timedOut ? 504 : 502;
          reject(new QubiclError(
            value?.error?.code ?? (timedOut ? 'web_timeout' : bytes > MAX_PROVIDER_OUTPUT_BYTES ? 'web_response_too_large' : 'web_provider_failure'),
            value?.error?.message ?? (timedOut ? 'The web provider exceeded its time limit.' : reason || 'The local web provider failed.'),
            status,
          ));
          return;
        }
        if (value.error) {
          reject(new QubiclError(value.error.code ?? 'web_provider_failure', value.error.message ?? 'The local web provider failed.', providerStatus(value.error.code)));
          return;
        }
        try { resolve(validateProviderResult(operation, value)); } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}

export function createWebServer(provider: WebSearchProvider & WebExtractProvider = new LocalWebProvider()): ReturnType<typeof createServer> {
  const key = process.env.QUBICL_RUNNER_KEY;
  if (!key || key.length < 32) throw new Error('QUBICL_RUNNER_KEY is required for the web service.');
  return createServer(async (request, response) => {
    try {
      if (request.url === '/health') return send(response, 200, { status: 'ok', role: 'web' });
      if (!authenticated(request, key)) throw new QubiclError('unauthorized', 'Invalid internal web-service credential.', 401);
      const body = await readBody(request, request.url === '/v1/extract-rendered' ? MAX_RENDERED_REQUEST_BYTES : MAX_REQUEST_BYTES);
      if (request.method === 'POST' && request.url === '/v1/search') return send(response, 200, await provider.search({ query: requiredString(body.query, 'query'), limit: requiredNumber(body.limit, 'limit') }));
      if (request.method === 'POST' && request.url === '/v1/extract') return send(response, 200, await provider.extract({ url: requiredString(body.url, 'url'), format: body.format === 'text' ? 'text' : 'markdown', maxChars: requiredNumber(body.maxChars, 'maxChars') }));
      if (request.method === 'POST' && request.url === '/v1/extract-rendered') return send(response, 200, await provider.extractRendered({
        finalUrl: requiredString(body.finalUrl, 'finalUrl'),
        title: requiredString(body.title, 'title'),
        contentType: requiredString(body.contentType, 'contentType'),
        html: requiredString(body.html, 'html'),
        sourceTruncated: requiredBoolean(body.sourceTruncated, 'sourceTruncated'),
        format: body.format === 'text' ? 'text' : 'markdown',
        maxChars: requiredNumber(body.maxChars, 'maxChars'),
      }));
      throw new QubiclError('not_found', 'Internal web-service route not found.', 404);
    } catch (error) {
      send(response, error instanceof QubiclError ? error.status : 500, errorPayload(error));
    }
  });
}

function authenticated(request: IncomingMessage, expected: string): boolean {
  const value = request.headers['x-qubicl-runner-key'];
  if (typeof value !== 'string') return false;
  const left = Buffer.from(value); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maximumBytes) throw new QubiclError('request_too_large', 'Web-service request is too large.', 413);
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QubiclError('invalid_arguments', 'Web-service request must be an object.');
  return value as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}
function requiredString(value: unknown, name: string): string { if (typeof value !== 'string') throw new QubiclError('invalid_arguments', `${name} must be a string.`); return value; }
function requiredNumber(value: unknown, name: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new QubiclError('invalid_arguments', `${name} must be a number.`); return value; }
function requiredBoolean(value: unknown, name: string): boolean { if (typeof value !== 'boolean') throw new QubiclError('invalid_arguments', `${name} must be a boolean.`); return value; }
function providerStatus(code: string | undefined): number {
  if (code === 'web_invalid_url') return 400;
  if (code === 'network_policy_denied' || code?.startsWith('web_private')) return 403;
  if (code === 'web_unsupported_content_type') return 415;
  if (code === 'web_rate_limited') return 429;
  if (code === 'web_timeout') return 504;
  return 502;
}

function validateProviderResult(operation: 'search' | 'extract' | 'extract-rendered', value: Record<string, unknown>): Record<string, unknown> {
  if (operation === 'search') {
    if (typeof value.query !== 'string' || value.provider !== 'ddgs' || !Array.isArray(value.results)
      || value.results.some((entry) => !entry || typeof entry !== 'object'
        || typeof (entry as Record<string, unknown>).title !== 'string'
        || typeof (entry as Record<string, unknown>).url !== 'string'
        || typeof (entry as Record<string, unknown>).description !== 'string')) {
      throw new QubiclError('web_provider_malformed', 'DDGS returned a malformed response.', 502);
    }
    return value;
  }
  if (typeof value.finalUrl !== 'string' || typeof value.contentType !== 'string'
    || typeof value.extractionMethod !== 'string' || typeof value.content !== 'string'
    || typeof value.truncated !== 'boolean') {
    throw new QubiclError('web_provider_malformed', 'The local extractor returned a malformed response.', 502);
  }
  return value;
}
