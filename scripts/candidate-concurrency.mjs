import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const LOCAL_CANDIDATE_CONCURRENCY = 2;

const artifactPortRanges = Object.freeze({
  source: Object.freeze({ start: 32_000, end: 34_666 }),
  npm: Object.freeze({ start: 34_666, end: 37_333 }),
  binary: Object.freeze({ start: 37_333, end: 40_000 }),
});

export async function runWithConcurrency(items, operation, concurrency = LOCAL_CANDIDATE_CONCURRENCY) {
  assert(Array.isArray(items), 'Concurrent candidate work must be provided as an array.');
  assert(typeof operation === 'function', 'Concurrent candidate work requires an operation.');
  assert(Number.isSafeInteger(concurrency) && concurrency > 0, 'Candidate concurrency must be a positive safe integer.');

  const results = Array.from({ length: items.length });
  let nextIndex = 0;
  let failed = false;
  let firstError;

  const worker = async () => {
    while (!failed) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  ));
  if (failed) throw firstError;
  return results;
}

export function artifactAcceptanceIsolation(mode, seed) {
  const range = artifactPortRanges[mode];
  assert(range, `Artifact acceptance mode must be source, npm, or binary; received ${mode}.`);
  assert(typeof seed === 'string' && seed.length > 0, 'Artifact acceptance isolation requires a non-empty seed.');
  const suffix = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return {
    portStart: range.start,
    portEnd: range.end,
    imageNamespace: `qubicl/e2e-${mode}-${suffix}`,
  };
}
