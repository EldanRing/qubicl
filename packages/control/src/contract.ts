import { mcpToolResult, type ToolName } from '@qubicl/core';
import { errorPayload, QubiclError } from './errors.js';

export interface ToolCallExecutor {
  call(name: ToolName, input: unknown): Promise<unknown>;
}

export type ToolOutcome =
  | { ok: true; status: 200; value: unknown }
  | { ok: false; status: number; value: ReturnType<typeof errorPayload>; cause: unknown };

export async function invokeTool(executor: ToolCallExecutor, name: ToolName, input: unknown): Promise<ToolOutcome> {
  try {
    const outcome = { ok: true as const, status: 200 as const, value: await executor.call(name, input) };
    recordResultBytes(name, outcome.value, true);
    return outcome;
  } catch (error) {
    const outcome = {
      ok: false,
      status: error instanceof QubiclError ? error.status : 500,
      value: errorPayload(error),
      cause: error,
    } as const;
    recordResultBytes(name, outcome.value, false);
    return outcome;
  }
}

export function mcpResult(outcome: ToolOutcome): ReturnType<typeof mcpToolResult> {
  return mcpToolResult(outcome.value, !outcome.ok);
}

function recordResultBytes(name: ToolName, value: unknown, ok: boolean): void {
  if (process.env.QUBICL_TOKEN_METRICS !== '1') return;
  console.error(JSON.stringify({
    event: 'qubicl_tool_result_bytes',
    tool: name,
    ok,
    bytes: Buffer.byteLength(JSON.stringify(value)),
  }));
}
