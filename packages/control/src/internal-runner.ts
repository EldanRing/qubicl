import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { browserForCompatibility, type DesktopApplicationName, type Preset } from '@qubicl/core';
import { DesktopApplicationManager } from './desktop-applications.js';
import { errorPayload, QubiclError } from './errors.js';
import type { LeaseProof } from './lease.js';
import { ProcessManager, type ProcessOutputMode, type StopSignal } from './processes.js';
import { BrowserManager } from './browser.js';
import { discoverListeningPorts } from './ports.js';
import { readEffectiveResourceLimits } from './resource-limits.js';
import { controlDesktop, readClipboard, takeScreenshot, writeClipboard, type ControlAction } from './executor.js';
import type { ViewerPointerUpdate } from './viewer-actions.js';

const MAX_BODY_BYTES = 25_000_000;

export interface InternalRunner {
  server: ReturnType<typeof createServer>;
  shutdown(): Promise<void>;
}

export function createInternalRunner(): InternalRunner {
  const role = process.env.QUBICL_RUNTIME_ROLE;
  const key = process.env.QUBICL_RUNNER_KEY;
  if (role !== 'executor' && role !== 'session') throw new Error('Internal runner role must be executor or session.');
  if (!key || key.length < 32) throw new Error('QUBICL_RUNNER_KEY is required.');
  const uid = requiredIdentity('QUBICL_HOST_UID');
  const gid = requiredIdentity('QUBICL_HOST_GID');
  const processes = role === 'executor' ? new ProcessManager({
    spawnUid: uid,
    spawnGid: gid,
    ...(process.env.QUBICL_EXECUTOR_FENCE_UID === '0' ? {} : { fenceUid: uid }),
  }) : undefined;
  const applications = role === 'session'
    ? new DesktopApplicationManager(requiredCompatibility(), { spawnUid: uid, spawnGid: gid })
    : undefined;
  const pointerPublisher = role === 'session' ? configuredViewerPointerPublisher() : undefined;
  const browser = role === 'session'
    ? new BrowserManager(browserForCompatibility(requiredCompatibility()), {
      executable: process.env.QUBICL_BROWSER_EXECUTABLE ?? '/usr/local/bin/qubicl-chromium',
      environment: process.env,
      ...(pointerPublisher ? { publishViewerPointer: pointerPublisher } : {}),
    })
    : undefined;

  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health') {
        send(response, 200, { status: 'ok', role });
        return;
      }
      if (!authenticated(request, key)) throw new QubiclError('unauthorized', 'Invalid internal runner credential.', 401);
      const body = await readJson(request);
      if (role === 'executor') {
        await handleExecutor(processes!, request, response, body);
        return;
      }
      await handleSession(applications!, browser!, request, response, body);
    } catch (error) {
      send(response, error instanceof QubiclError ? error.status : 500, errorPayload(error));
    }
  });
  return {
    server,
    shutdown: async () => {
      if (processes) await processes.terminateOwner(undefined);
      if (applications) await applications.shutdown();
      if (browser) await browser.shutdown();
    },
  };
}

function configuredViewerPointerPublisher(): ((update: ViewerPointerUpdate) => Promise<void>) | undefined {
  const url = process.env.QUBICL_POINTER_URL;
  const key = process.env.QUBICL_RUNNER_KEY;
  if (!url) return undefined;
  if (!key || key.length < 32) throw new Error('QUBICL_POINTER_URL requires QUBICL_RUNNER_KEY.');
  return async (update) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qubicl-pointer-key': key },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) throw new Error(`Pointer receiver returned HTTP ${response.status}.`);
    await response.arrayBuffer();
  };
}

async function handleExecutor(
  processes: ProcessManager,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  switch (`${request.method} ${request.url}`) {
    case 'GET /v1/status':
      send(response, 200, {
        managedProcesses: processes.count(),
        effectiveResourceLimits: await readEffectiveResourceLimits(),
      });
      return;
    case 'POST /v1/process/exec':
      send(response, 200, await processes.exec(
        string(body.command, 'command'),
        string(body.cwd, 'cwd'),
        number(body.yieldTimeMs, 'yieldTimeMs'),
        number(body.maxOutputBytes, 'maxOutputBytes'),
        proof(body.owner),
        optionalNumber(body.timeoutMs, 'timeoutMs'),
        body.outputMode === 'split' ? 'split' : 'combined' as ProcessOutputMode,
      ));
      return;
    case 'POST /v1/process/write':
      send(response, 200, await processes.write(string(body.id, 'id'), string(body.input, 'input'), Boolean(body.close), number(body.yieldTimeMs, 'yieldTimeMs'), proof(body.owner)));
      return;
    case 'POST /v1/process/stop':
      send(response, 200, await processes.stop(string(body.id, 'id'), proof(body.owner), stopSignal(body.signal)));
      return;
    case 'POST /v1/process/compatibility-execute':
      send(response, 200, await processes.executeCompatibility(
        string(body.command, 'command'),
        string(body.cwd, 'cwd'),
        proof(body.owner),
        compatibilityStatusOptions(body.options),
        nullableString(body.sessionId, 'sessionId'),
      ));
      return;
    case 'POST /v1/process/compatibility-list':
      send(response, 200, processes.listCompatibility(proof(body.owner)));
      return;
    case 'POST /v1/process/compatibility-status':
      send(response, 200, await processes.statusCompatibility(
        string(body.id, 'id'),
        proof(body.owner),
        compatibilityStatusOptions(body.options),
      ));
      return;
    case 'POST /v1/process/compatibility-input':
      send(response, 200, await processes.inputCompatibility(string(body.id, 'id'), string(body.input, 'input'), proof(body.owner)));
      return;
    case 'POST /v1/process/compatibility-delete':
      send(response, 200, await processes.deleteCompatibility(string(body.id, 'id'), proof(body.owner), Boolean(body.force)));
      return;
    case 'POST /v1/process/terminate-owner':
      send(response, 200, await processes.terminateOwner(body.owner === undefined ? undefined : proof(body.owner)));
      return;
    case 'GET /v1/ports':
      send(response, 200, { ports: await discoverListeningPorts(requiredIdentity('QUBICL_HOST_UID')) });
      return;
    default:
      throw new QubiclError('not_found', 'Internal runner route not found.', 404);
  }
}

async function handleSession(
  applications: DesktopApplicationManager,
  browser: BrowserManager,
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  switch (`${request.method} ${request.url}`) {
    case 'GET /v1/status':
      send(response, 200, { desktopApplications: applications.count() });
      return;
    case 'GET /v1/applications':
      send(response, 200, { applications: applications.list() });
      return;
    case 'POST /v1/applications/open':
      send(response, 200, await applications.open(string(body.application, 'application') as DesktopApplicationName, stringArray(body.paths, 'paths')));
      return;
    case 'POST /v1/applications/close':
      send(response, 200, await applications.close(string(body.applicationId, 'applicationId')));
      return;
    case 'POST /v1/browser/invoke': {
      const method = browserMethod(body.method);
      const args = array(body.args, 'args');
      const callable = browser[method] as (...values: unknown[]) => Promise<unknown>;
      send(response, 200, await callable.apply(browser, args));
      return;
    }
    case 'POST /v1/desktop/screenshot':
      send(response, 200, await takeScreenshot());
      return;
    case 'POST /v1/desktop/control':
      send(response, 200, await controlDesktop(object(body.action, 'action') as unknown as ControlAction));
      return;
    case 'GET /v1/clipboard':
      send(response, 200, await readClipboard());
      return;
    case 'POST /v1/clipboard':
      await writeClipboard(string(body.text, 'text'));
      send(response, 200, { written: true });
      return;
    default:
      throw new QubiclError('not_found', 'Internal runner route not found.', 404);
  }
}

function authenticated(request: IncomingMessage, expected: string): boolean {
  const value = request.headers['x-qubicl-runner-key'];
  if (typeof value !== 'string') return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method === 'GET') return {};
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new QubiclError('request_too_large', 'Internal runner request is too large.', 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QubiclError('invalid_arguments', 'Internal runner body must be an object.');
  return value as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const data = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  response.end(data);
}

function requiredIdentity(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requiredCompatibility(): Preset {
  const value = process.env.QUBICL_COMPATIBILITY;
  if (!['file-system', 'browser', 'computer', 'workstation'].includes(value ?? '')) throw new Error('QUBICL_COMPATIBILITY is invalid.');
  return value as Preset;
}

const BROWSER_METHODS = [
  'navigate', 'snapshot', 'screenshot', 'click', 'clickWithViewerPointer', 'type', 'select', 'press', 'scroll', 'history', 'wait',
  'tabs', 'useTab', 'newTab', 'closeTab', 'reset', 'clickAt', 'hoverAt', 'drag', 'scrollAt', 'typeFocused',
  'inspectAt', 'computer', 'computerWithViewerPointers', 'shutdown',
  'renderForExtraction',
] as const;
type BrowserMethod = typeof BROWSER_METHODS[number];

function browserMethod(value: unknown): BrowserMethod {
  if (typeof value === 'string' && (BROWSER_METHODS as readonly string[]).includes(value)) return value as BrowserMethod;
  throw new QubiclError('invalid_arguments', 'browser method is invalid.');
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new QubiclError('invalid_arguments', `${name} must be a string.`);
  return value;
}
function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new QubiclError('invalid_arguments', `${name} must be an array of strings.`);
  return value;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new QubiclError('invalid_arguments', `${name} must be an array.`);
  return value;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QubiclError('invalid_arguments', `${name} must be an object.`);
  return value as Record<string, unknown>;
}
function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new QubiclError('invalid_arguments', `${name} must be a number.`);
  return value;
}
function optionalNumber(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : number(value, name);
}
function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, name);
}
function compatibilityStatusOptions(value: unknown): { waitMs?: number; offset?: number; tail?: number } {
  if (value === undefined) return {};
  const candidate = object(value, 'options');
  return {
    ...(candidate.waitMs === undefined ? {} : { waitMs: number(candidate.waitMs, 'options.waitMs') }),
    ...(candidate.offset === undefined ? {} : { offset: number(candidate.offset, 'options.offset') }),
    ...(candidate.tail === undefined ? {} : { tail: number(candidate.tail, 'options.tail') }),
  };
}
function proof(value: unknown): LeaseProof {
  if (!value || typeof value !== 'object') throw new QubiclError('invalid_arguments', 'owner must be a lease proof.');
  const candidate = value as Record<string, unknown>;
  return { id: string(candidate.id, 'owner.id'), generation: number(candidate.generation, 'owner.generation'), epoch: string(candidate.epoch, 'owner.epoch') };
}
function stopSignal(value: unknown): StopSignal {
  if (value === 'SIGTERM' || value === 'SIGINT' || value === 'SIGHUP') return value;
  throw new QubiclError('invalid_arguments', 'signal is invalid.');
}
