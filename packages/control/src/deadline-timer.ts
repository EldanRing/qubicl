/** Node truncates delays above 2^31-1 to 1 ms. Preserve the actual deadline. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface DeadlineTimer {
  cancel(): void;
  unref(): DeadlineTimer;
}

export function deadlineTimer(callback: () => void, delayMs: number): DeadlineTimer {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new RangeError('Timer delay must be a non-negative safe integer.');
  const deadline = Date.now() + delayMs;
  let timer: NodeJS.Timeout;
  let cancelled = false;
  let unreferenced = false;
  const arm = (): void => {
    timer = setTimeout(() => {
      if (cancelled) return;
      if (Date.now() < deadline) arm();
      else { cancelled = true; callback(); }
    }, Math.max(1, Math.min(MAX_TIMER_DELAY_MS, deadline - Date.now())));
    if (unreferenced) timer.unref();
  };
  const handle: DeadlineTimer = {
    cancel() { cancelled = true; clearTimeout(timer); },
    unref() { unreferenced = true; timer.unref(); return handle; },
  };
  arm();
  return handle;
}
