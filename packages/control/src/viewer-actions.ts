import { randomBytes } from 'node:crypto';

const DISPLAY_WIDTH = 1440;
const DISPLAY_HEIGHT = 900;
const MAX_EVENTS = 32;

export type ViewerPointerKind = 'click' | 'double_click' | 'right_click' | 'drag' | 'scroll' | 'move';

export interface ViewerPointerAction {
  type: string;
  x?: number;
  y?: number;
  button?: number;
  toX?: number;
  toY?: number;
  deltaY?: number;
}

export type ViewerPointerUpdate =
  | { phase: 'intent'; actionId: string; generation: number; action: ViewerPointerAction }
  | { phase: 'confirm' | 'cancel'; actionId: string; generation: number };

export interface ViewerPointerState {
  kind: ViewerPointerKind;
  x: number;
  y: number;
  button: number;
  occurredAt: number;
}

export type ViewerPointerEvent =
  | (ViewerPointerState & { sequence: number; type: 'show'; pulse: boolean })
  | { sequence: number; type: 'hide'; occurredAt: number };

export interface ViewerPointerEvents {
  events: ViewerPointerEvent[];
  latestSequence: number;
  current: ViewerPointerState | null;
  display: { width: number; height: number };
}

interface Candidate extends Omit<ViewerPointerState, 'occurredAt'> {
  order: number;
}

interface PendingPointer {
  actionId: string;
  candidate: Candidate;
}

/**
 * Keeps a tiny in-memory cursor for authenticated viewers. Intent is shown
 * before dispatch, confirmation makes it durable for the current agent
 * control session, and cancellation restores the last confirmed position.
 * It deliberately records no text, keys, window titles, URLs, or audit data.
 */
export class ViewerPointerStore {
  private sequence = 0;
  private order = 0;
  private readonly events: ViewerPointerEvent[] = [];
  private readonly pending = new Map<string, PendingPointer>();
  private confirmed: Candidate | undefined;
  private displayed: Candidate | undefined;
  private current: ViewerPointerState | undefined;
  private readonly waiters = new Set<() => void>();

  record(action: ViewerPointerAction): ViewerPointerEvent | undefined {
    const started = this.begin(action);
    if (!started) return undefined;
    this.confirm(started.actionId);
    return started.event;
  }

  begin(action: ViewerPointerAction, actionId = randomBytes(18).toString('base64url')): { actionId: string; event: ViewerPointerEvent } | undefined {
    const point = pointerPoint(action);
    if (!point || !validActionId(actionId) || this.pending.has(actionId)) return undefined;
    const candidate: Candidate = {
      kind: point.kind,
      x: clamp(point.x, 0, DISPLAY_WIDTH - 1),
      y: clamp(point.y, 0, DISPLAY_HEIGHT - 1),
      button: point.button,
      order: ++this.order,
    };
    this.pending.set(actionId, { actionId, candidate });
    const event = this.show(candidate, ['click', 'double_click', 'right_click', 'drag'].includes(candidate.kind));
    return { actionId, event };
  }

  confirm(actionId: string): boolean {
    const pending = this.pending.get(actionId);
    if (!pending) return false;
    this.pending.delete(actionId);
    if (!this.confirmed || pending.candidate.order >= this.confirmed.order) this.confirmed = pending.candidate;
    this.reconcile();
    return true;
  }

  cancel(actionId: string): boolean {
    if (!this.pending.delete(actionId)) return false;
    this.reconcile();
    return true;
  }

  apply(update: ViewerPointerUpdate): boolean {
    if (update.phase === 'intent') return Boolean(this.begin(update.action, update.actionId));
    return update.phase === 'confirm' ? this.confirm(update.actionId) : this.cancel(update.actionId);
  }

  clear(): ViewerPointerEvent | undefined {
    const hadState = Boolean(this.displayed || this.confirmed || this.pending.size);
    this.pending.clear();
    this.confirmed = undefined;
    this.displayed = undefined;
    this.current = undefined;
    if (!hadState) return undefined;
    return this.emit({ sequence: ++this.sequence, type: 'hide', occurredAt: Date.now() });
  }

  since(after: number): ViewerPointerEvents {
    const sequence = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    return {
      events: this.events.filter((event) => event.sequence > sequence),
      latestSequence: this.sequence,
      current: this.current ? { ...this.current } : null,
      display: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
    };
  }

  async waitSince(after: number, timeoutMs = 20_000): Promise<ViewerPointerEvents> {
    const sequence = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    if (sequence !== this.sequence) return this.since(sequence);
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, Math.min(timeoutMs, 25_000)));
      timer.unref();
      this.waiters.add(done);
    });
    return this.since(sequence);
  }

  private reconcile(): void {
    let next = this.confirmed;
    for (const { candidate } of this.pending.values()) {
      if (!next || candidate.order > next.order) next = candidate;
    }
    if (next?.order === this.displayed?.order) return;
    if (next) {
      this.show(next, false);
      return;
    }
    if (!this.displayed) return;
    this.displayed = undefined;
    this.current = undefined;
    this.emit({ sequence: ++this.sequence, type: 'hide', occurredAt: Date.now() });
  }

  private show(candidate: Candidate, pulse: boolean): ViewerPointerEvent {
    this.displayed = candidate;
    const state: ViewerPointerState = {
      kind: candidate.kind,
      x: candidate.x,
      y: candidate.y,
      button: candidate.button,
      occurredAt: Date.now(),
    };
    this.current = state;
    return this.emit({ ...state, sequence: ++this.sequence, type: 'show', pulse });
  }

  private emit<T extends ViewerPointerEvent>(event: T): T {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const wake of [...this.waiters]) wake();
    return event;
  }
}

export function parseViewerPointerUpdate(value: unknown): ViewerPointerUpdate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!validActionId(candidate.actionId) || !Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 1) return undefined;
  if (candidate.phase === 'confirm' || candidate.phase === 'cancel') {
    return { phase: candidate.phase, actionId: candidate.actionId as string, generation: candidate.generation as number };
  }
  if (candidate.phase !== 'intent' || !candidate.action || typeof candidate.action !== 'object' || Array.isArray(candidate.action)) return undefined;
  const action = candidate.action as Record<string, unknown>;
  const x = numberOrUndefined(action.x);
  const y = numberOrUndefined(action.y);
  const button = numberOrUndefined(action.button);
  const toX = numberOrUndefined(action.toX);
  const toY = numberOrUndefined(action.toY);
  const deltaY = numberOrUndefined(action.deltaY);
  const parsed: ViewerPointerAction = {
    type: typeof action.type === 'string' ? action.type : '',
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(button === undefined ? {} : { button }),
    ...(toX === undefined ? {} : { toX }),
    ...(toY === undefined ? {} : { toY }),
    ...(deltaY === undefined ? {} : { deltaY }),
  };
  if (!pointerPoint(parsed)) return undefined;
  return { phase: 'intent', actionId: candidate.actionId as string, generation: candidate.generation as number, action: parsed };
}

function pointerPoint(action: ViewerPointerAction): { kind: ViewerPointerKind; x: number; y: number; button: number } | undefined {
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'move':
      return validPoint(action.x, action.y, action.type, action.button ?? 1);
    case 'right_click':
      return validPoint(action.x, action.y, 'right_click', 3);
    case 'drag':
      return validPoint(action.toX, action.toY, 'drag', action.button ?? 1);
    case 'scroll':
      return validPoint(action.x, action.y, 'scroll', (action.deltaY ?? 0) < 0 ? 4 : 5);
    default:
      return undefined;
  }
}

function validPoint(x: number | undefined, y: number | undefined, kind: ViewerPointerKind, button: number): { kind: ViewerPointerKind; x: number; y: number; button: number } | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isSafeInteger(button) || button < 0 || button > 8) return undefined;
  return { kind, x: x!, y: y!, button };
}

function validActionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
