import assert from 'node:assert/strict';
import test from 'node:test';
import { parseViewerPointerUpdate, ViewerPointerStore } from '@qubicl/control/viewer-actions';

test('viewer pointer retains only bounded non-sensitive coordinates as persistent state', () => {
  const store = new ViewerPointerStore();
  assert.equal(store.record({ type: 'type' }), undefined);
  assert.equal(store.record({ type: 'keypress' }), undefined);
  assert.equal(store.record({ type: 'scroll', deltaY: 1 }), undefined);

  const click = store.record({ type: 'click', x: 50, y: 60, button: 1 });
  const drag = store.record({ type: 'drag', toX: 1_500, toY: -20 });
  const right = store.record({ type: 'right_click', x: 20, y: 30 });
  const move = store.record({ type: 'move', x: 40, y: 50 });

  assert.ok(click?.type === 'show');
  assert.deepEqual({ sequence: click.sequence, kind: click.kind, x: click.x, y: click.y, button: click.button, pulse: click.pulse }, {
    sequence: 1,
    kind: 'click',
    x: 50,
    y: 60,
    button: 1,
    pulse: true,
  });
  assert.ok(drag?.type === 'show');
  assert.deepEqual({ sequence: drag.sequence, kind: drag.kind, x: drag.x, y: drag.y, button: drag.button }, {
    sequence: 2,
    kind: 'drag',
    x: 1_439,
    y: 0,
    button: 1,
  });
  assert.ok(right?.type === 'show');
  assert.equal(right.button, 3);
  assert.ok(move?.type === 'show');
  assert.equal(move.kind, 'move');
  assert.equal(move.pulse, false);
  assert.deepEqual(store.since(4), {
    events: [],
    latestSequence: 4,
    current: { kind: 'move', x: 40, y: 50, button: 1, occurredAt: move.occurredAt },
    display: { width: 1_440, height: 900 },
  });
  assert.deepEqual(Object.keys(click).sort(), ['button', 'kind', 'occurredAt', 'pulse', 'sequence', 'type', 'x', 'y']);
});

test('intent appears before confirmation and cancellation restores the last confirmed position', () => {
  const store = new ViewerPointerStore();
  const confirmed = store.begin({ type: 'click', x: 10, y: 20 }, 'confirmed_pointer_1');
  assert.ok(confirmed);
  assert.equal(store.confirm(confirmed.actionId), true);

  const attempted = store.begin({ type: 'click', x: 300, y: 400 }, 'attempted_pointer_2');
  assert.ok(attempted?.event.type === 'show');
  assert.equal(store.since(0).current?.x, 300);
  assert.equal(store.cancel(attempted.actionId), true);

  const snapshot = store.since(attempted.event.sequence);
  assert.equal(snapshot.events.length, 1);
  const restored = snapshot.events[0];
  assert.ok(restored?.type === 'show');
  assert.equal(restored.x, 10);
  assert.equal(restored.y, 20);
  assert.equal(restored.pulse, false);
  assert.equal(snapshot.current?.x, 10);
});

test('clear hides persistent state and wakes a waiting viewer immediately', async () => {
  const store = new ViewerPointerStore();
  store.record({ type: 'click', x: 10, y: 20 });
  const waiting = store.waitSince(1, 5_000);
  const hidden = store.clear();
  assert.equal(hidden?.type, 'hide');
  const snapshot = await waiting;
  assert.equal(snapshot.latestSequence, 2);
  assert.equal(snapshot.current, null);
  assert.deepEqual(snapshot.events.map(({ type }) => type), ['hide']);
});

test('viewer pointer history is capped and sequence based', () => {
  const store = new ViewerPointerStore();
  for (let index = 0; index < 40; index += 1) store.record({ type: 'double_click', x: index, y: index });
  const snapshot = store.since(0);
  assert.equal(snapshot.latestSequence, 40);
  assert.equal(snapshot.events.length, 32);
  assert.equal(snapshot.events[0]?.sequence, 9);
  assert.equal(snapshot.events.at(-1)?.sequence, 40);
});

test('session pointer update parser accepts only bounded pointer lifecycle messages', () => {
  const intent = parseViewerPointerUpdate({
    phase: 'intent',
    actionId: 'browser_pointer_1234',
    generation: 7,
    action: { type: 'right_click', x: 120, y: 240, button: 3, text: 'must not survive' },
  });
  assert.deepEqual(intent, {
    phase: 'intent',
    actionId: 'browser_pointer_1234',
    generation: 7,
    action: { type: 'right_click', x: 120, y: 240, button: 3 },
  });
  assert.deepEqual(parseViewerPointerUpdate({ phase: 'confirm', actionId: 'browser_pointer_1234', generation: 7 }), {
    phase: 'confirm', actionId: 'browser_pointer_1234', generation: 7,
  });
  assert.equal(parseViewerPointerUpdate({ phase: 'intent', actionId: 'short', generation: 7, action: { type: 'click', x: 1, y: 2 } }), undefined);
  assert.equal(parseViewerPointerUpdate({ phase: 'intent', actionId: 'browser_pointer_1234', generation: 0, action: { type: 'click', x: 1, y: 2 } }), undefined);
  assert.equal(parseViewerPointerUpdate({ phase: 'intent', actionId: 'browser_pointer_1234', generation: 7, action: { type: 'type', text: 'secret' } }), undefined);
});
