import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('reboot acceptance resolves the production custom-root runtime names', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'reboot-acceptance.mjs')).href);
  const config = { installationId: '01234567-89ab-cdef-0123-456789abcdef' };
  const computer = {
    id: 'fedcba98-7654-3210-fedc-ba9876543210',
    name: 'reboot-running',
    capabilities: ['viewer'],
  };
  assert.deepEqual(module.resolveRebootRuntimeNames(config, computer, '/tmp/qubicl-reboot'), {
    gateway: 'qubicl-0123456789abcdef0123-gateway',
    control: 'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98',
    executor: 'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98-executor',
    all: [
      'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98',
      'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98-executor',
      'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98-egress',
      'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98-session',
    ],
  });
});

test('reboot acceptance targets the unified computer for protocol 10', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts', 'reboot-acceptance.mjs')).href);
  const config = { installationId: '01234567-89ab-cdef-0123-456789abcdef' };
  const computer = {
    id: 'fedcba98-7654-3210-fedc-ba9876543210',
    name: 'reboot-running',
    capabilities: ['viewer'],
    controlProtocolVersion: 10,
  };
  assert.deepEqual(module.resolveRebootRuntimeNames(config, computer, '/tmp/qubicl-reboot'), {
    gateway: 'qubicl-0123456789abcdef0123-gateway',
    control: 'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98',
    executor: 'qubicl-0123456789abcdef0123-fedcba9876543210fedcba98',
    all: ['qubicl-0123456789abcdef0123-fedcba9876543210fedcba98'],
  });
});
