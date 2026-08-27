import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_CATALOG,
  defaultConfig,
  defaultSecrets,
  presetDefaults,
  type ComputerConfig,
  type ImageIdentity,
  type Preset,
} from '@qubicl/core';
import { developmentImageMismatchError, ensureRuntimeImages, retainedComputerStartAction } from '../../packages/cli/dist/docker.js';
import { statePaths } from '../../packages/cli/dist/state.js';

test('development preset manifest mismatch names the source image recovery command', () => {
  const requested = IMAGE_CATALOG.presets.workstation.image.requested;
  const mismatch = new Error(
    `Image ${requested} manifest digest ${'1'.repeat(64)} does not match expected ${'2'.repeat(64)}.`,
  );
  const result = developmentImageMismatchError(mismatch, requested, IMAGE_CATALOG);
  assert.notEqual(result, mismatch);
  assert.match(result.message, /local development image is stale/);
  assert.match(result.message, /npm run images:build/);
  assert.match(result.message, /rerun qubicl setup/);
  assert.equal(result.cause, mismatch);
});

test('development image recovery is not added to unrelated or release errors', () => {
  const requested = IMAGE_CATALOG.presets.workstation.image.requested;
  const unrelated = new Error(`Image ${requested} does not contain a valid Qubicl computer contract.`);
  assert.equal(developmentImageMismatchError(unrelated, requested, IMAGE_CATALOG), unrelated);

  const mismatch = new Error(
    `Image ${requested} manifest digest ${'1'.repeat(64)} does not match expected ${'2'.repeat(64)}.`,
  );
  const releaseCatalog = structuredClone(IMAGE_CATALOG);
  releaseCatalog.development = false;
  assert.equal(developmentImageMismatchError(mismatch, requested, releaseCatalog), mismatch);
});

test('ensuring images for one new computer ignores unrelated configured computer pins', async () => {
  const state = {
    paths: statePaths('/tmp/qubicl-image-selection-test'),
    config: defaultConfig(),
    secrets: defaultSecrets(),
  };
  const unrelated = computer('00000000-0000-4000-8000-000000000401', 'unrelated');
  unrelated.image = {
    ...unrelated.image,
    resolved: `qubicl/workstation@sha256:${'1'.repeat(64)}`,
  };
  const selected = computer('00000000-0000-4000-8000-000000000402', 'selected');
  state.config.computers.push(unrelated, selected);
  const ensured: Array<{ identity: ImageIdentity; kind: 'gateway' | 'computer'; compatibility?: Preset; offline: boolean }> = [];

  await ensureRuntimeImages(state, [selected], true, async (identity, kind, compatibility, offline) => {
    ensured.push({ identity, kind, ...(compatibility ? { compatibility } : {}), offline });
  });

  assert.deepEqual(ensured.map(({ identity, kind }) => [kind, identity]), [
    ['gateway', state.config.gateway.image],
    ['computer', selected.image],
  ]);
  assert.equal(ensured.some(({ identity }) => identity === unrelated.image), false);
  assert.equal(ensured.every(({ offline }) => offline), true);
});

test('retained stopped computers start without requiring image recreation', () => {
  assert.equal(retainedComputerStartAction('absent'), 'create');
  assert.equal(retainedComputerStartAction('exited'), 'start');
  assert.equal(retainedComputerStartAction('created'), 'start');
  assert.equal(retainedComputerStartAction('paused'), 'unpause');
  assert.equal(retainedComputerStartAction('running'), 'none');
  assert.equal(retainedComputerStartAction('restarting'), 'none');
});

function computer(id: string, name: string): ComputerConfig {
  return { id, name, createdAt: '2026-08-20T12:00:00.000Z', ...presetDefaults('workstation') };
}
