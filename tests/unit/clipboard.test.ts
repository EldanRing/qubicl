import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipboardReader, type ClipboardSource } from '../../packages/control/dist/clipboard.js';

test('clipboard pages retain exact captured Unicode across owner changes and expire', async () => {
  const original = '\ufeff beginning\n🧪'.repeat(200) + 'END';
  let current = original, reads = 0, now = 0;
  const reader = new ClipboardReader(async () => { reads++; return { text: current, status: 'text', ownerAvailable: true, formats: ['UTF8_STRING'], format: 'UTF8_STRING' }; }, () => now);
  let page = await reader.read({ maxBytes: 512 });
  const cursor = page.nextCursor!;
  let actual = page.text;
  current = 'New owner';
  while (page.nextCursor) { page = await reader.read({ cursor: page.nextCursor, maxBytes: 512 }); actual += page.text; }
  assert.equal(actual, original);
  assert.equal(page.totalBytes, Buffer.byteLength(original));
  assert.equal(page.totalCharacters, original.length);
  assert.equal(page.offsetUnit, 'utf16');
  assert.equal(reads, 1);
  now = 300_001;
  await assert.rejects(reader.read({ cursor }), { code: 'stale_clipboard_read' });
});

test('unavailable clipboard formats are distinct from known empty text; real failures propagate', async () => {
  let source: ClipboardSource = { status: 'unavailable', text: '', ownerAvailable: true, formats: ['image/png'], format: null };
  const reader = new ClipboardReader(async () => source);
  assert.equal((await reader.read()).reason, 'text_format_unavailable');
  source = { ...source, ownerAvailable: false };
  assert.equal((await reader.read()).reason, 'no_selection_owner');
  source = { ...source, status: 'text', format: 'UTF8_STRING', ownerAvailable: true };
  const empty = await reader.read();
  assert.equal(empty.status, 'text');
  assert.equal(empty.totalCharacters, 0);
  assert.equal(empty.reason, undefined);
  await assert.rejects(new ClipboardReader(async () => { throw new Error('display permission denied'); }).read(), /display permission denied/u);
});
