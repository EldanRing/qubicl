import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildOpenApi, isToolName, modelInputSchemaForTool, QUBICL_BUILD, QUBICL_MODEL_INSTRUCTIONS, toolDefinitions, toolTitle } from '@qubicl/core';
import { ToolExecutor } from './executor.js';
import { errorPayload, QubiclError } from './errors.js';
import { invokeTool, mcpResult } from './contract.js';
import { loadComputerManifest } from './image-manifest.js';
import { OpenTerminalCompatibility } from './open-terminal.js';
import { parseViewerPointerUpdate } from './viewer-actions.js';

const loadedManifest = loadComputerManifest();
const executor = new ToolExecutor(loadedManifest);
await executor.policy.load();
const expectedInternalKey = process.env.QUBICL_INTERNAL_KEY;
if (!expectedInternalKey) throw new Error('QUBICL_INTERNAL_KEY is required.');
const expectedPointerKey = process.env.QUBICL_SESSION_KEY;
const openTerminal = new OpenTerminalCompatibility(executor, executor.enabledToolNames());

export async function shutdownControlService(): Promise<void> {
  await openTerminal.shutdown();
  await executor.shutdown();
}

const mcp = createMcpHandler(() => {
  const server = new McpServer(
    { name: `qubicl-${executor.computerId}`, version: QUBICL_BUILD.version },
    { instructions: QUBICL_MODEL_INSTRUCTIONS },
  );
  for (const name of executor.enabledToolNames()) {
    const definition = toolDefinitions[name];
    const title = toolTitle(name);
    const config: { title?: string; description: string; inputSchema: StandardSchemaWithJSON } = {
      ...(title ? { title } : {}),
      description: definition.description,
      inputSchema: modelInputSchemaForTool(name) as StandardSchemaWithJSON,
    };
    server.registerTool(
      name,
      config,
      async (input: unknown) => {
        const outcome = await invokeTool(executor, name, input);
        if (!outcome.ok && outcome.status === 500) console.error(outcome.cause);
        return mcpResult(outcome);
      },
    );
  }
  return server;
});
const handleMcp = toNodeHandler(mcp, { onerror: (error) => console.error(error) });

export const controlServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://control.internal');
    if (url.pathname === '/health') {
      json(response, 200, {
        status: 'ok',
        id: executor.computerId,
        name: executor.computerName,
        preset: loadedManifest.manifest.preset,
        compatibility: loadedManifest.manifest.compatibility,
        capabilities: loadedManifest.manifest.capabilities,
        tools: executor.enabledToolNames(),
        manifestSha256: loadedManifest.sha256,
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/_qubicl/session/pointer') {
      if (!authenticatedPointerPublisher(request)) {
        json(response, 401, { error: { code: 'unauthorized', message: 'Invalid desktop-session pointer credential.' } });
        return;
      }
      const update = parseViewerPointerUpdate(await readJson(request));
      if (!update) throw new QubiclError('invalid_arguments', 'The viewer pointer update is invalid.', 400);
      json(response, 202, { accepted: executor.applyViewerPointerUpdate(update) });
      return;
    }
    if (!authenticated(request)) {
      json(response, 401, { error: { code: 'unauthorized', message: 'Invalid internal gateway credential.' } });
      return;
    }
    const gatewayEpoch = request.headers['x-qubicl-gateway-epoch'];
    if (typeof gatewayEpoch !== 'string') {
      json(response, 401, { error: { code: 'gateway_epoch_required', message: 'The gateway epoch header is required.' } });
      return;
    }
    await executor.observeGatewayEpoch(gatewayEpoch);
    if (executor.previews.handle(request, response, url)) return;
    if (await openTerminal.handle(request, response, url)) return;
    if (request.method === 'POST' && url.pathname === '/_qubicl/gateway-epoch') {
      json(response, 200, { synchronized: true, epoch: executor.leases.epoch });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/_qubicl/operator/policy/reload') {
      json(response, 200, await executor.reloadPolicy());
      return;
    }
    if (url.pathname === '/mcp') {
      await handleMcp(request as never, response as never);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/openapi.json') {
      json(response, 200, buildOpenApi(executor.computerId, executor.enabledToolNames()));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/_qubicl/view/actions') {
      const after = viewerSequence(url.searchParams.get('after'));
      response.setHeader('cache-control', 'no-store');
      json(response, 200, url.searchParams.get('wait') === '1'
        ? await executor.viewerPointers.waitSince(after)
        : executor.viewerPointers.since(after));
      return;
    }
    if (request.method === 'POST' && url.pathname.startsWith('/v1/tools/')) {
      const name = url.pathname.slice('/v1/tools/'.length);
      if (!isToolName(name) || !executor.enabledToolNames().includes(name)) throw new QubiclError('tool_not_found', `Tool ${name} is not available for this computer's operator policy or capability contract.`, 404);
      const outcome = await invokeTool(executor, name, await readJson(request));
      if (!outcome.ok && outcome.status === 500) console.error(outcome.cause);
      json(response, outcome.status, outcome.value);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/_qubicl/human/take') {
      json(response, 200, await executor.takeHumanControl());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/_qubicl/human/release') {
      json(response, 200, executor.releaseHumanControl());
      return;
    }
    json(response, 404, { error: { code: 'not_found', message: 'Route not found.' } });
  } catch (error) {
    const status = error instanceof QubiclError ? error.status : 500;
    if (status === 500) console.error(error);
    json(response, status, errorPayload(error));
  }
});

controlServer.on('upgrade', (request, socket, head) => {
  void handleUpgrade(request, socket, head);
});

async function handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://control.internal');
    const gatewayEpoch = request.headers['x-qubicl-gateway-epoch'];
    if (!authenticated(request) || typeof gatewayEpoch !== 'string') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // Reset gateway-scoped preview capabilities before checking the upgrade
    // token. HTTP and WebSocket entrypoints must observe an epoch transition
    // through the same ordered fence.
    await executor.observeGatewayEpoch(gatewayEpoch);
    if (!executor.previews.handleUpgrade(request, socket, head, url)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  } catch (error) {
    console.error(error);
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
}

function authenticated(request: IncomingMessage): boolean {
  const received = request.headers['x-qubicl-internal-key'];
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expectedInternalKey!);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticatedPointerPublisher(request: IncomingMessage): boolean {
  if (!expectedPointerKey) return false;
  const received = request.headers['x-qubicl-pointer-key'];
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expectedPointerKey);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 25_000_000) throw new QubiclError('request_too_large', 'Request body exceeds 25 MB.', 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new QubiclError('invalid_json', 'Request body must be valid JSON.'); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function viewerSequence(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d{1,16}$/u.test(value)) throw new QubiclError('invalid_arguments', 'Viewer action sequence must be a non-negative safe integer.');
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) throw new QubiclError('invalid_arguments', 'Viewer action sequence must be a non-negative safe integer.');
  return sequence;
}
