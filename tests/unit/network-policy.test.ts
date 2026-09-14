import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { NetworkPolicy } from '@qubicl/core';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { explainNetworkPolicy, networkCommand } from '../../packages/cli/dist/network-policy.js';
import { initializeState, saveState, statePaths } from '../../packages/cli/dist/state.js';

const policy = (overrides: Partial<NetworkPolicy>): NetworkPolicy => ({
  profile: 'custom',
  allowDomains: [],
  denyDomains: [],
  allowCidrs: [],
  allowTcpPorts: [],
  temporaryApprovals: [],
  ...overrides,
});

test('network explanations cover profiles, wildcard rules, denials, and temporary overrides', () => {
  assert.equal(explainNetworkPolicy(policy({ profile: 'developer' }), 'https://example.com').allowedByNamedRules, true);
  assert.equal(explainNetworkPolicy(policy({ profile: 'offline' }), 'example.com:443').allowedByNamedRules, false);
  assert.equal(explainNetworkPolicy(policy({ profile: 'web-only' }), 'example.com:25').allowedByNamedRules, false);
  assert.equal(explainNetworkPolicy(policy({ profile: 'web-only' }), 'http://example.com').allowedByNamedRules, true);

  const wildcard = policy({ allowDomains: ['*.example.com'], denyDomains: ['blocked.example.com'] });
  assert.equal(explainNetworkPolicy(wildcard, 'https://api.example.com').allowedByNamedRules, true);
  assert.equal(explainNetworkPolicy(wildcard, 'https://example.com').allowedByNamedRules, false);
  assert.equal(explainNetworkPolicy(wildcard, 'https://blocked.example.com').allowedByNamedRules, false);

  const temporary = policy({
    denyDomains: ['blocked.example.com'],
    temporaryApprovals: [{ domain: 'blocked.example.com', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
  });
  assert.equal(explainNetworkPolicy(temporary, 'https://blocked.example.com').allowedByNamedRules, true);
});

test('network explanations evaluate literal IPv4 and IPv6 CIDR rules', () => {
  const restricted = policy({ allowCidrs: ['10.42.0.0/16', '2001:db8::/32'], allowTcpPorts: [5432] });
  const ipv4 = explainNetworkPolicy(restricted, '10.42.1.9:5432');
  assert.equal(ipv4.allowedByNamedRules, true);
  assert.match(String(ipv4.reason), /CIDR allow rule/u);
  assert.equal(explainNetworkPolicy(restricted, '10.43.1.9:5432').allowedByNamedRules, false);
  assert.equal(explainNetworkPolicy(restricted, '[2001:db8::5]:5432').allowedByNamedRules, true);
  assert.equal(explainNetworkPolicy(restricted, '10.42.1.9:22').allowedByNamedRules, false);
  assert.throws(() => explainNetworkPolicy(restricted, 'example.com'), /valid port/u);
});

test('read-only network commands show configured policy and explain a target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-network-policy-'));
  const previous = process.env.QUBICL_HOME;
  const output: string[] = [];
  const originalLog = console.log;
  process.env.QUBICL_HOME = root;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
  try {
    const state = await initializeState(statePaths(root));
    const computer = addConfiguredComputer(state, 'network-test');
    computer.network = policy({ allowDomains: ['api.example.com'] });
    await saveState(state);

    await networkCommand({ positionals: ['show', computer.name], options: new Map() });
    assert.equal((JSON.parse(output.at(-1)!) as NetworkPolicy).profile, 'custom');
    await networkCommand({ positionals: ['explain', computer.id, 'https://api.example.com'], options: new Map() });
    assert.equal((JSON.parse(output.at(-1)!) as { allowedByNamedRules: boolean }).allowedByNamedRules, true);
    await assert.rejects(networkCommand({ positionals: ['show', 'missing'], options: new Map() }), /was not found/u);
    await assert.rejects(networkCommand({ positionals: ['unknown', computer.name], options: new Map() }), /Unknown network action/u);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.QUBICL_HOME;
    else process.env.QUBICL_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
