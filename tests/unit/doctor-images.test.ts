import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_CATALOG,
  defaultConfig,
  imageIdentity,
  presetDefaults,
  type ComputerConfig,
} from '@qubicl/core';
import { doctorImageChecks } from '../../packages/cli/dist/doctor-images.js';

const OLD_COMPUTER_ID = '00000000-0000-4000-8000-000000000456';

test('doctor accepts an inspectable retained content ID after a development tag rebuild', async () => {
  const config = developmentConfig();
  const oldComputer = config.computers[0]!;
  const inspected: string[] = [];
  const checks = await doctorImageChecks(config, async (reference) => {
    inspected.push(reference);
    return reference === oldComputer.image.contentId
      || reference === config.gateway.image.resolved
      || reference === config.defaults.image.resolved;
  }, async () => ({ status: 'running' }));

  const retained = checks.find(({ detail }) => detail.includes(oldComputer.image.resolved));
  assert.equal(retained?.status, 'ok');
  assert.match(retained?.detail ?? '', new RegExp(`retained exact content ${oldComputer.image.contentId}`));
  assert.ok(inspected.includes(oldComputer.image.contentId!));
  assert.ok(!inspected.includes(oldComputer.image.resolved), 'an inspectable content ID does not fall back to the vanished repository digest');
});

test('doctor warns accurately when only a running development container is retained', async () => {
  const config = developmentConfig();
  const oldComputer = config.computers[0]!;
  const checks = await doctorImageChecks(config, async (reference) => (
    reference === config.gateway.image.resolved || reference === config.defaults.image.resolved
  ), async () => ({ status: 'running' }));

  const retained = checks.find(({ detail }) => detail.includes(oldComputer.image.resolved));
  assert.equal(retained?.status, 'warning');
  assert.match(retained?.detail ?? '', /not available as a reusable local image/);
  assert.match(retained?.detail ?? '', /mcp-test is running from its retained container/);
  assert.doesNotMatch(retained?.detail ?? '', /will obtain/);
  assert.match(retained?.repair ?? '', /durable \/home/);
  assert.match(retained?.repair ?? '', /exact source revision image/);
});

test('doctor preserves resolved-reference availability semantics for custom images', async () => {
  const config = developmentConfig();
  const custom = imageIdentity('example/custom:latest', `example/custom@sha256:${'7'.repeat(64)}`, '8'.repeat(64));
  custom.contentId = `sha256:${'9'.repeat(64)}`;
  config.defaults = {
    ...presetDefaults('workstation'),
    preset: 'custom',
    image: custom,
  };
  config.computers = [];
  const inspected: string[] = [];
  const checks = await doctorImageChecks(config, async (reference) => {
    inspected.push(reference);
    return reference !== custom.resolved;
  }, async () => ({ status: 'absent' }));

  const customCheck = checks.find(({ detail }) => detail.includes(custom.resolved));
  assert.equal(customCheck?.status, 'warning');
  assert.deepEqual(inspected.filter((reference) => reference === custom.contentId), []);
  assert.match(customCheck?.detail ?? '', /will obtain it when needed/);
});

function developmentConfig() {
  const config = defaultConfig();
  const old = {
    id: OLD_COMPUTER_ID,
    name: 'mcp-test',
    createdAt: new Date().toISOString(),
    ...presetDefaults('workstation'),
  } satisfies ComputerConfig;
  old.image = {
    ...old.image,
    requested: IMAGE_CATALOG.presets.workstation.image.requested,
    resolved: `qubicl/workstation@sha256:${'4'.repeat(64)}`,
    contentId: `sha256:${'5'.repeat(64)}`,
  };
  config.computers.push(old);
  return config;
}
