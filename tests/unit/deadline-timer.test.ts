import assert from 'node:assert/strict';
import test from 'node:test';
import { deadlineTimer } from '../../packages/control/dist/deadline-timer.js';

test('deadline timers honor 30 days across native timer chunks and cancellation', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  let fired = 0;
  const cancelled = deadlineTimer(() => { fired += 10; }, thirtyDays).unref();
  deadlineTimer(() => { fired += 1; }, thirtyDays).unref();
  context.mock.timers.tick(2_147_483_647);
  assert.equal(fired, 0);
  cancelled.cancel();
  context.mock.timers.tick(thirtyDays - 2_147_483_647 - 1);
  assert.equal(fired, 0);
  context.mock.timers.tick(1);
  assert.equal(fired, 1);
  context.mock.timers.tick(thirtyDays);
  assert.equal(fired, 1);
});
