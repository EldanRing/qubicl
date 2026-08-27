import assert from 'node:assert/strict';
import test from 'node:test';
import { presetDefaults, type ComputerConfig } from '../../packages/core/dist/index.js';
import { upgradedComputer } from '../../packages/cli/dist/upgrade.js';

test('upgrading replaces only the image contract and preserves durable operator settings', () => {
  const current: ComputerConfig = {
    id: '00000000-0000-4000-8000-000000000110',
    name: 'open-webui-qubicl',
    runtimeName: 'open-webui-qubicl',
    createdAt: '2026-08-20T12:00:00.000Z',
    network: { profile: 'custom', allowDomains: ['example.com'], denyDomains: ['blocked.test'], temporaryApprovals: [] },
    ssh: {
      enabled: true,
      port: 22222,
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestOnlyKey qubicl-test',
      fingerprint: 'SHA256:test-fingerprint',
    },
    environment: { PROJECT_MODE: 'test' },
    ...presetDefaults('file-system'),
    cpus: 3,
    memory: '6g',
  };
  const target = presetDefaults('workstation');
  const upgraded = upgradedComputer(current, target);

  assert.equal(upgraded.id, current.id);
  assert.equal(upgraded.name, current.name);
  assert.equal(upgraded.runtimeName, current.runtimeName);
  assert.equal(upgraded.createdAt, current.createdAt);
  assert.deepEqual(upgraded.network, current.network);
  assert.deepEqual(upgraded.ssh, current.ssh);
  assert.deepEqual(upgraded.environment, current.environment);
  assert.equal(upgraded.cpus, 3);
  assert.equal(upgraded.memory, '6g');
  assert.equal(upgraded.preset, 'workstation');
  assert.deepEqual(upgraded.image, target.image);
  assert.deepEqual(upgraded.capabilities, target.capabilities);
});
