import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForDesktopObservation } from '../../packages/control/dist/desktop-observation.js';

test('desktop expected-state waits return early with the last sample and do not repeat completed reads', async () => {
  let probes = 0;
  const result = await waitForDesktopObservation({ state: 'window_closed', windowId: 42, timeoutMs: 2000 }, async () => {
    probes++;
    return { conditionMatched: probes === 2, windows: probes === 2 ? [] : [{ id: 42 }] };
  });
  assert.equal(probes, 2);
  assert.equal(result.wait.status, 'observed');
  assert.deepEqual(result.observation, { windows: [] });
  assert.ok(Number(result.wait.elapsedMs) < 1000, 'return on the observation, not the full deadline');
});

test('desktop wait deadline includes a stalled provider and leaves its single read unreplayed', async () => {
  let probes = 0;
  let finish: ((value: Record<string, unknown>) => void) | undefined;
  const result = await waitForDesktopObservation({ state: 'window_closed', windowId: 42, timeoutMs: 25 }, () => {
    probes++;
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(result.wait.status, 'not_observed_yet');
  assert.equal(result.wait.reason, 'deadline');
  assert.equal(probes, 1);
  assert.equal(result.observation, undefined);
  finish!({ conditionMatched: true, windows: [] });
  await Promise.resolve();
  assert.equal(result.wait.status, 'not_observed_yet', 'late provider completion must not rewrite the returned receipt');
});

test('desktop waits retain unmatched evidence and distinguish unreadable targets from deadlines', async () => {
  const expected = { state: 'value' as const, ref: 'a'.repeat(24) + 'e0', value: 3, timeoutMs: 20 };
  const timeout = await waitForDesktopObservation(expected, async () => ({ conditionMatched: false, element: { value: 2 } }));
  assert.equal(timeout.wait.status, 'not_observed_yet');
  assert.deepEqual(timeout.observation, { element: { value: 2 } });
  const missing = await waitForDesktopObservation(expected, async () => ({ conditionMatched: false, targetStatus: 'unavailable' }));
  assert.equal(missing.wait.reason, 'target_unavailable');
  const broken = await waitForDesktopObservation(expected, async () => { throw new Error('provider unavailable'); });
  assert.equal(broken.wait.status, 'not_observed_yet');
  assert.equal(broken.wait.reason, 'observation_unavailable');
});
