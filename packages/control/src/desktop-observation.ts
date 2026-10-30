import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';
import type { DesktopWaitFor } from './desktop-native.js';
import { QubiclError } from './errors.js';

/** Observe after dispatch. A deadline never retries or reclassifies that input. */
export async function waitForDesktopObservation(
  expected: DesktopWaitFor,
  read: () => Promise<Record<string, unknown>>,
): Promise<{ wait: Record<string, unknown>; observation?: Record<string, unknown> }> {
  const started = performance.now();
  const deadline = started + expected.timeoutMs;
  let observation: Record<string, unknown> | undefined;
  const receipt = (status: 'observed' | 'not_observed_yet', extra: Record<string, unknown> = {}) => ({
    wait: { state: expected.state, status, timeoutMs: expected.timeoutMs,
      elapsedMs: Math.round(performance.now() - started), ...extra },
    ...(observation ? { observation } : {}),
  });
  while (performance.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A slow/busy accessibility provider must not extend the requested wait.
      // Its pending read may finish later; it performs no input and is not retried.
      const sampled = await Promise.race([
        read(),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - performance.now())); }),
      ]);
      if (!sampled || performance.now() > deadline) break;
      const { conditionMatched, ...state } = sampled;
      observation = state;
      if (conditionMatched === true) return receipt('observed');
      if (state.targetStatus === 'unavailable') return receipt('not_observed_yet', { reason: 'target_unavailable' });
    } catch (error) {
      return receipt('not_observed_yet', { reason: 'observation_unavailable',
        error: { code: error instanceof QubiclError ? error.code : 'desktop_observation_failed', message: String((error as Error).message).slice(0, 512) } });
    } finally { clearTimeout(timer); }
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  }
  return receipt('not_observed_yet', { reason: 'deadline', note: 'The expected state was not observed by the deadline. Input was already dispatched and was not replayed.' });
}
