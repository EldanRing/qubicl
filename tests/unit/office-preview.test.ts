import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OfficePreviewManager } from '../../packages/control/dist/office-preview.js';

async function fixture(context: TestContext, script: string, timeoutMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-office-limits-'));
  const executable = join(directory, 'converter');
  await writeFile(executable, `#!/bin/sh\n${script}\n`);
  await chmod(executable, 0o700);
  const manager = new OfficePreviewManager({ executable, temporaryRoot: directory, timeoutMs });
  context.after(async () => { await manager.cancelAll(); await rm(directory, { recursive: true, force: true }); });
  return { manager, directory };
}

test('Office conversion rejects failed, invalid, and oversized output and cleans private storage', async (context) => {
  for (const script of ['exit 1', 'printf invalid > document.pdf', 'head -c 20000001 /dev/zero > document.pdf']) {
    const { manager, directory } = await fixture(context, script);
    await assert.rejects(manager.convert(Buffer.from('doc'), '.docx'));
    assert.deepEqual(await readdir(directory), ['converter']);
  }
});

test('Office conversion timeout kills the process group and removes temporary data', async (context) => {
  const { manager, directory } = await fixture(context, 'sleep 30 & wait', 100);
  await assert.rejects(manager.convert(Buffer.from('doc'), '.pptx'), { code: 'preview_timeout' });
  assert.deepEqual(await readdir(directory), ['converter']);
});

test('Office conversion caps concurrency, supports disconnect cancellation, and fences pending work', async (context) => {
  const { manager, directory } = await fixture(context, 'sleep 30');
  const cancellation = new AbortController();
  const first = assert.rejects(manager.convert(Buffer.from('doc'), '.docx', cancellation.signal), { code: 'preview_cancelled' });
  const second = assert.rejects(manager.convert(Buffer.from('doc'), '.pptx'), { code: 'preview_cancelled' });
  await assert.rejects(manager.convert(Buffer.from('doc'), '.docx'), { code: 'preview_busy' });
  cancellation.abort();
  await manager.cancelAll();
  await Promise.all([first, second]);
  assert.deepEqual(await readdir(directory), ['converter']);
  await assert.rejects(manager.convert(Buffer.alloc(20_000_001), '.docx'), { code: 'file_too_large' });
});
