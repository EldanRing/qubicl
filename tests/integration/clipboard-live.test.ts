import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import { ClipboardReader } from '../../packages/control/dist/clipboard.js';
import { nativeDesktop } from '../../packages/control/dist/desktop-native.js';

test('real X11 clipboard distinguishes image-only selection and reconstructs captured UTF-8 text', {
  skip: process.env.QUBICL_TEST_NATIVE_DESKTOP !== '1' && 'Run in a disposable guest with the updated helper.', timeout: 10_000,
}, async (context) => {
  let owner: ChildProcess | undefined;
  context.after(() => { owner?.kill(); nativeDesktop.shutdown(); });
  const provide = async (format: string, text: string): Promise<void> => {
    owner?.kill();
    owner = spawn('xclip', ['-selection', 'clipboard', '-in', '-target', format, '-quiet'], { stdio: ['pipe', 'ignore', 'ignore'] });
    owner.stdin!.end(text);
    await new Promise((resolve) => setTimeout(resolve, 80));
  };
  const reader = new ClipboardReader();
  await provide('image/png', 'synthetic image-only format');
  const unavailable = await reader.read();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.ownerAvailable, true);
  assert.equal(unavailable.reason, 'text_format_unavailable');
  const text = '\ufeff  Unicode 🧪\n'.repeat(4000) + 'END';
  await provide('UTF8_STRING', text);
  let part = await reader.read({ maxBytes: 16000 });
  let actual = part.text;
  assert.equal(part.status, 'text');
  await provide('UTF8_STRING', 'replacement');
  while (part.nextCursor) { part = await reader.read({ cursor: part.nextCursor }); actual += part.text; }
  assert.equal(actual, text);
  assert.equal(part.totalBytes, Buffer.byteLength(text));
  assert.equal(part.truncated, false);
});
