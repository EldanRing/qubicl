import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CORE_SKILL_IDS, defaultCatalogSkillsForCompatibility, defaultConfig, defaultSecrets, presetDefaults } from '@qubicl/core';
import { buildComputerConnectionResult, printComputerHandoff } from '../../packages/cli/dist/computer-handoff.js';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { statePaths } from '../../packages/cli/dist/state.js';

function computerFor(preset: 'file-system' | 'browser' | 'computer' | 'workstation') {
  const state = { paths: statePaths('/home/test/.qubicl'), config: defaultConfig(), secrets: defaultSecrets() };
  return addConfiguredComputer(state, 'research', presetDefaults(preset));
}

test('new computers use preset-aware catalog skill defaults', () => {
  for (const preset of ['file-system', 'browser', 'computer', 'workstation'] as const) assert.deepEqual(computerFor(preset).skillPolicy?.enabledCatalogSkills, defaultCatalogSkillsForCompatibility(preset), preset);
  assert.deepEqual(computerFor('workstation').skillPolicy?.enabledCatalogSkills, [...CORE_SKILL_IDS]);
});

test('new computers persist a readable collision-safe Docker runtime name', () => {
  const created = computerFor('workstation');
  assert.match(created.runtimeName ?? '', /^qubicl-research-[a-f0-9]{8}-[a-f0-9]{8}$/);
});

test('the primary installation persists the literal computer name as its runtime name', () => {
  const state = { paths: statePaths(join(homedir(), '.qubicl')), config: defaultConfig(), secrets: defaultSecrets() };
  const created = addConfiguredComputer(state, 'openwebui-qubicl', presetDefaults('workstation'));
  assert.equal(created.runtimeName, 'openwebui-qubicl');
  assert.throws(() => addConfiguredComputer(state, 'gateway', presetDefaults('workstation')), /reserved by the primary Qubicl runtime/);
});

test('computer create handoff is concise, human-oriented, and uses plain URLs', () => {
  const result = buildComputerConnectionResult(4321, computerFor('workstation'), true);
  const output: string[] = [];
  printComputerHandoff(result, (line) => output.push(line));

  assert.deepEqual(output, [
    `Computer: research (${result.id}) is healthy.`,
    'Preferred token-free stdio bridge: qubicl mcp research',
    `Viewer: http://127.0.0.1:4321/computers/${result.id}/view`,
    'Client adapter: qubicl connect research --client codex (other adapters are available)',
  ]);
  assert.doesNotMatch(output.join('\n'), /"(?:capabilities|image|cpus|memory)"/);
});

test('computer create JSON result stays structured and contains literal terminal URLs', () => {
  const result = buildComputerConnectionResult(4321, computerFor('file-system'), false);
  const encoded = JSON.stringify(result);

  assert.equal(result.running, false);
  assert.equal(result.mcp, `http://127.0.0.1:4321/computers/${result.id}/mcp`);
  assert.equal(result.openapi, `http://127.0.0.1:4321/computers/${result.id}/openapi.json`);
  assert.equal('view' in result, false);
  assert.doesNotMatch(encoded, /\]\(http/);
});
