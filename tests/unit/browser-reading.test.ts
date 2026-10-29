import assert from 'node:assert/strict';
import test from 'node:test';
import { readTextPage } from '@qubicl/control/browser-reading';

test('browser text pages reconstruct long Unicode content without losing its tail', () => {
  const text = 'Heading\n"quoted" 🦆 İ漢字\n'.repeat(1800) + 'THE END';
  let offset = 0;
  let reconstructed = '';
  do {
    const page = readTextPage(text, offset, 512);
    assert.ok(Buffer.byteLength(JSON.stringify(page.content)) <= 512);
    assert.ok(page.content!.length > 0);
    assert.ok(!page.content!.includes('�'));
    reconstructed += page.content;
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset < text.length);
  assert.equal(reconstructed, text);
});

test('literal browser search paginates results and preserves Unicode match offsets', () => {
  const text = 'İ prefix 🦆 Needle [a.*] needle '.repeat(100);
  const positions: number[] = [];
  let offset = 0;
  do {
    const result = readTextPage(text, offset, 512, 'needle');
    for (const match of result.matches!) {
      positions.push(match.start);
      assert.equal(text.slice(match.start, match.end).toLowerCase(), 'needle');
    }
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  } while (offset < text.length);
  assert.equal(positions.length, 200);
  assert.equal(new Set(positions).size, 200);
  assert.equal(readTextPage(text, 0, 16_000, '[a.*]').matches![0]!.start, text.indexOf('[a.*]'));
  assert.equal(readTextPage('Needle needle', 0, 512, 'needle', true).matches!.length, 1);
  assert.equal(readTextPage(text, 0, 512, 'absent').nextOffset, null);
});
