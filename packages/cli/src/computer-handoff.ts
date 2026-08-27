import type { ComputerConfig } from '@qubicl/core';

export function buildComputerConnectionResult(gatewayPort: number, computer: ComputerConfig, running: boolean) {
  const base = `http://127.0.0.1:${gatewayPort}/computers/${computer.id}`;
  return {
    name: computer.name,
    id: computer.id,
    preset: computer.preset,
    compatibility: computer.compatibility,
    capabilities: computer.capabilities,
    image: computer.image,
    cpus: computer.cpus,
    memory: computer.memory,
    running,
    mcp: `${base}/mcp`,
    openapi: `${base}/openapi.json`,
    ...(computer.capabilities.includes('viewer') ? { view: `${base}/view` } : {}),
    stdio: `qubicl mcp ${computer.name}`,
    tokenCommand: `qubicl token show ${computer.name}`,
  };
}

export type ComputerConnectionResult = ReturnType<typeof buildComputerConnectionResult>;

export function printComputerHandoff(result: ComputerConnectionResult, write: (message: string) => void): void {
  write(`Computer: ${result.name} (${result.id})${result.running ? ' is healthy' : ' is configured but stopped'}.`);
  write(`Preferred token-free stdio bridge: ${result.stdio}`);
  if (result.view) write(`Viewer: ${result.view}`);
  write(`Client adapter: qubicl connect ${result.name} --client codex (other adapters are available)`);
}
