import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  QUBICL_BUILD,
  QUBICL_MODEL_INSTRUCTIONS,
  QUBICL_TRANSPARENT_LEASE_INSTRUCTION,
  isToolName,
  modelInputSchemaForTool,
  mcpToolResult,
  compactToolDefinitionBytes,
  toolDefinitions,
  toolTitle,
  toolNamesForProfile,
  type McpResultMode,
  type ToolName,
  type ToolProfile,
} from '@qubicl/core';
import type { LoadedState } from './state.js';

interface BridgeLease {
  id: string;
  generation: number;
  epoch: string;
}

interface BridgeOptions {
  profile?: ToolProfile;
  resultMode?: McpResultMode;
}

export function serveMcpBridge(state: LoadedState, computerName: string, options: BridgeOptions = {}): void {
  const computer = state.config.computers.find(({ name, id }) => name === computerName || id === computerName);
  if (!computer) throw new Error(`Computer ${computerName} was not found.`);
  const secret = state.secrets.computers[computer.id];
  if (!secret) throw new Error(`Secret material for ${computer.name} is missing.`);
  const endpoint = `http://127.0.0.1:${state.config.gateway.port}/computers/${computer.id}`;

  const bridges = new Set<TransparentLeaseBridge>();
  const releaseAll = async (): Promise<void> => {
    await Promise.all([...bridges].map((bridge) => bridge.release()));
  };
  const transport = new LeaseReleasingStdioTransport(releaseAll);
  serveStdio(async () => {
    const discovered = await discoverTools(endpoint, secret.token);
    const tools = toolNamesForProfile(discovered, options.profile ?? 'full', true);
    if (process.env.QUBICL_TOKEN_METRICS === '1') {
      console.error(JSON.stringify({
        event: 'qubicl_tool_catalog_bytes',
        computer: computer.name,
        profile: options.profile ?? 'full',
        bytes: compactToolDefinitionBytes(discovered, { leaseTransparent: true, profile: options.profile ?? 'full' }),
      }));
    }
    const bridge = new TransparentLeaseBridge(endpoint, secret.token);
    bridges.add(bridge);
    const server = new McpServer(
      { name: `qubicl-stdio-${computer.id}`, version: QUBICL_BUILD.version },
      { instructions: `${QUBICL_MODEL_INSTRUCTIONS}\n${QUBICL_TRANSPARENT_LEASE_INSTRUCTION}` },
    );
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the MCP protocol server exposes an onclose callback, not EventTarget
    server.server.onclose = () => {
      bridges.delete(bridge);
      void bridge.release();
    };
    for (const name of tools) {
      const definition = toolDefinitions[name];
      const title = toolTitle(name);
      const config: { title?: string; description: string; inputSchema: StandardSchemaWithJSON } = {
        ...(title ? { title } : {}),
        description: definition.description,
        inputSchema: modelInputSchemaForTool(name, true) as StandardSchemaWithJSON,
      };
      server.registerTool(
        name,
        config,
        async (input: unknown) => {
          try {
            const result = await bridge.call(name, input);
            return mcpToolResult(result.value, !result.ok, options.resultMode ?? 'text');
          } catch (error) {
            if (error instanceof BridgeResponseError) return mcpToolResult(error.value, true, options.resultMode ?? 'text');
            const value = { error: { code: 'bridge_error', message: error instanceof Error ? error.message : String(error) } };
            return mcpToolResult(value, true, options.resultMode ?? 'text');
          }
        },
      );
    }
    return server;
  }, { transport, onerror: (error) => console.error(error) });
}

/**
 * The upstream stdio transport does not treat stdin EOF as transport closure.
 * MCP clients normally close stdin first and then terminate a server which
 * stays alive, so transparent leases must be released before the bridge loses
 * its opportunity to make the final authenticated request.
 */
class LeaseReleasingStdioTransport extends StdioServerTransport {
  private closing: Promise<void> | undefined;

  constructor(private readonly beforeClose: () => Promise<void>) {
    super();
  }

  override async start(): Promise<void> {
    await super.start();
    process.stdin.once('end', this.onInputClosed);
    process.stdin.once('close', this.onInputClosed);
  }

  override close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private readonly onInputClosed = (): void => {
    void this.close();
  };

  private async closeOnce(): Promise<void> {
    process.stdin.off('end', this.onInputClosed);
    process.stdin.off('close', this.onInputClosed);
    await this.beforeClose();
    await super.close();
  }
}

export class TransparentLeaseBridge {
  private lease: BridgeLease | undefined;
  private acquiring: Promise<BridgeLease> | undefined;

  constructor(private readonly endpoint: string, private readonly token: string) {}

  async call(name: ToolName, rawInput: unknown): Promise<{ ok: boolean; value: Record<string, unknown> }> {
    const input = objectInput(rawInput);
    if (!toolDefinitions[name].lease) return this.post(name, input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proof = await this.ensureLease();
      const result = await this.post(name, { ...input, lease: proof });
      if (result.ok || errorCode(result.value) !== 'stale_lease' || attempt > 0) return result;
      if (sameProof(this.lease, proof)) this.lease = undefined;
    }
    return { ok: false, value: { error: { code: 'stale_lease', message: 'The MCP connection could not refresh exclusive control.' } } };
  }

  async release(): Promise<void> {
    const proof = this.lease;
    this.lease = undefined;
    if (!proof) return;
    await this.post('release_lease', { lease: proof }).catch(() => undefined);
  }

  private async ensureLease(): Promise<BridgeLease> {
    if (this.lease) return this.lease;
    this.acquiring ??= this.post('acquire_lease', { durationSeconds: 600 })
      .then((result) => {
        if (!result.ok) throw new BridgeResponseError(result.value);
        const proof = leaseFrom(result.value);
        this.lease = proof;
        return proof;
      })
      .finally(() => {
        this.acquiring = undefined;
      });
    return this.acquiring;
  }

  private async post(name: ToolName, input: Record<string, unknown>): Promise<{ ok: boolean; value: Record<string, unknown> }> {
    const response = await fetch(`${this.endpoint}/v1/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const value = objectInput(await response.json());
    return { ok: response.ok, value };
  }
}

async function discoverTools(endpoint: string, token: string): Promise<ToolName[]> {
  const response = await fetch(`${endpoint}/openapi.json`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not discover the computer tool contract: gateway returned HTTP ${response.status}.`);
  return toolNamesFromOpenApi(await response.json());
}

export function toolNamesFromOpenApi(value: unknown): ToolName[] {
  if (!value || typeof value !== 'object') throw new Error('Computer returned an invalid OpenAPI tool contract.');
  const document = value as { paths?: unknown };
  if (!document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    throw new Error('Computer OpenAPI contract has no valid paths object.');
  }
  const names: ToolName[] = [];
  for (const path of Object.values(document.paths as Record<string, { post?: { operationId?: unknown } }>)) {
    const name = path.post?.operationId;
    if (typeof name !== 'string' || !isToolName(name)) throw new Error(`Computer advertised an unknown tool operation ${JSON.stringify(name)}.`);
    if (names.includes(name)) throw new Error(`Computer advertised tool ${name} more than once.`);
    names.push(name);
  }
  if (!names.length) throw new Error('Computer advertised no callable tools.');
  return names;
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function leaseFrom(value: Record<string, unknown>): BridgeLease {
  if (typeof value.id !== 'string' || typeof value.generation !== 'number' || typeof value.epoch !== 'string') {
    throw new Error('The computer returned an invalid lease response.');
  }
  return { id: value.id, generation: value.generation, epoch: value.epoch };
}

function sameProof(left: BridgeLease | undefined, right: BridgeLease): boolean {
  return left?.id === right.id && left.generation === right.generation && left.epoch === right.epoch;
}

function errorCode(value: Record<string, unknown>): string | undefined {
  const error = value.error;
  return error && typeof error === 'object' && typeof (error as Record<string, unknown>).code === 'string'
    ? (error as Record<string, unknown>).code as string
    : undefined;
}

function errorMessage(value: Record<string, unknown>): string {
  const error = value.error;
  return error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
    ? (error as Record<string, unknown>).message as string
    : 'The Qubicl computer rejected exclusive control.';
}

class BridgeResponseError extends Error {
  constructor(readonly value: Record<string, unknown>) {
    super(errorMessage(value));
  }
}
