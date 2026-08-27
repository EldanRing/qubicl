import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const moduleUrl = pathToFileURL(join(root, 'scripts', 'client-conformance.mjs')).href;

test('version-1 client conformance requirements cover named apps and protocol surfaces', async () => {
  const { assertClientConformanceRequirements, loadClientConformanceRequirements } = await import(moduleUrl);
  const requirements = await loadClientConformanceRequirements();
  assert.deepEqual(requirements.clients.map(({ id }: { id: string }) => id), [
    'codex',
    'claude-code',
    'opencode',
    'openclaw',
    'hermes-agent',
    'open-webui',
    'claude-desktop',
    'cursor',
    'vscode',
  ]);
  assert.deepEqual(requirements.protocols.map(({ id }: { id: string }) => id), [
    'mcp-stdio',
    'mcp-http',
    'openapi',
    'open-terminal',
  ]);
  assert.deepEqual(requirements.surfaces, [
    'discovery',
    'mcp-stdio',
    'mcp-http',
    'openapi',
    'open-terminal',
    'result-modes',
    'screenshots',
    'files',
    'browser-control',
    'human-takeover',
  ]);
  const weakened = structuredClone(requirements);
  weakened.clients.find(({ id }: { id: string }) => id === 'codex')!.requiredSurfaces.pop();
  assert.throws(() => assertClientConformanceRequirements(weakened), /version-1 contract/);
});

test('v0.2 gating and exact client versions fail closed', async () => {
  const { exactClientVersion, requiresClientConformance } = await import(moduleUrl);
  assert.equal(requiresClientConformance('0.1.1'), false);
  assert.equal(requiresClientConformance('0.2.0-rc.1'), true);
  assert.equal(requiresClientConformance('1.0.0'), true);
  assert.throws(() => requiresClientConformance('v0.2'), /Semantic Versioning/);

  for (const value of ['Codex CLI 0.60.1', 'Claude Code 1.2.3 (build 456)', '2025-06-18']) {
    assert.equal(exactClientVersion(value), true, value);
  }
  for (const value of [
    'latest',
    '1.x',
    '>=1.2.3',
    '1.2.3 || 2.0.0',
    '1.2.3 - 1.3.0',
    'nightly-20260827',
    'unknown',
    ' 1.2.3',
  ]) {
    assert.equal(exactClientVersion(value), false, value);
  }
});
