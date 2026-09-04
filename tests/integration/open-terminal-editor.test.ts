import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ToolExecutor } from '@qubicl/control/executor';
import { OpenTerminalCompatibility } from '@qubicl/control/open-terminal';
import { OfficePreviewManager } from '../../packages/control/dist/office-preview.js';
import { buildOpenApi, buildOpenTerminalOpenApi } from '@qubicl/core';

async function fixture(context: TestContext, officePreviews?: OfficePreviewManager) {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-editor-'));
  const executor = new ToolExecutor(undefined, { durableRoot: home, ...(officePreviews ? { officePreviews } : {}) });
  const compatibility = new OpenTerminalCompatibility(executor, executor.enabledToolNames(), { home });
  const server = createServer(async (request, response) => {
    if (!await compatibility.handle(request, response, new URL(request.url!, 'http://local'))) response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await compatibility.shutdown();
    await executor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/open-terminal`;
  const post = (path: string, body: unknown, session = 'one') => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': session }, body: JSON.stringify(body),
  });
  return { home, executor, base, post };
}

test('native editor round trips complete long, multiline, Unicode, BOM and CRLF files', async (context) => {
  const { home, base } = await fixture(context);
  for (const content of ['x'.repeat(100_000), 'x\n'.repeat(10_001), '\uFEFF' + 'é😀\r\n'.repeat(10_001), '']) {
    await writeFile(join(home, 'document.txt'), content);
    const response = await fetch(`${base}/files/read?path=document.txt`);
    assert.equal(response.status, 200);
    const result = await response.json() as { content: string; truncated: boolean };
    assert.equal(result.content, content);
    assert.equal(result.truncated, false);
    // Follow the native editor's full-replacement save contract.
    const form = new FormData();
    form.append('file', new Blob([result.content], { type: 'text/plain' }), 'document.txt');
    const saved = await fetch(`${base}/files/upload?directory=${encodeURIComponent(home)}`, { method: 'POST', body: form });
    assert.equal(saved.status, 200);
    assert.deepEqual(await readFile(join(home, 'document.txt')), Buffer.from(content));
  }
});

test('native editor rejects oversized and invalid UTF-8 input; model reads report a clipped long line', async (context) => {
  const { home, base, post } = await fixture(context);
  const file = await open(join(home, 'large.txt'), 'w');
  await file.truncate(20_000_001);
  await file.close();
  assert.equal((await fetch(`${base}/files/read?path=large.txt`)).status, 413);
  await writeFile(join(home, 'binary'), Buffer.from([0xff, 0xfe]));
  assert.equal((await fetch(`${base}/files/read?path=binary`)).status, 415);
  await writeFile(join(home, 'long.txt'), 'x'.repeat(100_000));
  const model = await (await post('/v1/tools/read_file', { path: 'long.txt' })).json() as { content: string; truncated: boolean; nextOffset?: number; note: string };
  assert.equal(Buffer.byteLength(model.content), 24_000);
  assert.equal(model.truncated, true);
  assert.equal(model.nextOffset, undefined);
  assert.match(model.note, /truncated/);
});

test('Open WebUI projected commands and file edits follow each chat folder while MCP names remain stable', async (context) => {
  const { home, base, post } = await fixture(context);
  for (const session of ['one', 'two']) {
    await mkdir(join(home, session));
    assert.equal((await post('/files/cwd', { path: session }, session)).status, 200);
    assert.equal((await post('/v1/tools/write_file', { path: 'note.txt', content: session }, session)).status, 200);
  }
  assert.equal((await post('/v1/tools/replace_file_content', { path: 'note.txt', old_text: 'one', new_text: 'changed' })).status, 200);
  assert.equal(await readFile(join(home, 'one/note.txt'), 'utf8'), 'changed');
  assert.equal(await readFile(join(home, 'two/note.txt'), 'utf8'), 'two');
  const response = await post('/v1/tools/run_command', { command: 'pwd', yieldTimeMs: 1000 }, 'two');
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(await response.json()), new RegExp(join(home, 'two')));
  const native = await fetch(`${base}/files/read?path=note.txt`, { headers: { 'x-session-id': 'one' } });
  assert.equal((await native.json() as { content: string }).content, 'changed');
  assert.equal((await post('/v1/tools/write_file', { path: '../../escape.txt', content: 'no' })).status, 403);
  const generic = buildOpenApi('test') as { paths: Record<string, unknown> };
  const projected = buildOpenTerminalOpenApi('test') as { paths: Record<string, { post: { operationId: string } }> };
  assert.ok(generic.paths['/v1/tools/exec_command']);
  assert.ok(generic.paths['/v1/tools/edit_file']);
  assert.equal(projected.paths['/v1/tools/run_command']?.post.operationId, 'run_command');
  assert.equal(projected.paths['/execute']?.post, undefined);
  assert.equal(projected.paths['/v1/tools/replace_file_content']?.post.operationId, 'replace_file_content');
});

test('Office preview route returns PDF and preserves original downloads', async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-office-test-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const converter = join(temporary, 'converter');
  await writeFile(converter, '#!/bin/sh\nprintf "%s" "%PDF-1.4 test" > document.pdf\n');
  await chmod(converter, 0o700);
  const previews = new OfficePreviewManager({ executable: converter, temporaryRoot: temporary });
  const { home, base } = await fixture(context, previews);
  await writeFile(join(home, 'slides.pptx'), 'original Office bytes');
  const preview = await fetch(`${base}/files/view?path=slides.pptx&preview=true`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'application/pdf');
  assert.equal(await preview.text(), '%PDF-1.4 test');
  const original = await fetch(`${base}/files/view?path=slides.pptx`);
  assert.equal(await original.text(), 'original Office bytes');
  assert.deepEqual(await readdir(temporary), ['converter']);
});

test('native editor does not return file bytes after an in-flight human takeover', async (context) => {
  const { home, executor, base } = await fixture(context);
  await writeFile(join(home, 'note.txt'), 'private content');
  const read = executor.files.readFile.bind(executor.files);
  context.mock.method(executor.files, 'readFile', async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    await executor.leases.takeHumanControl();
    return result;
  });
  const response = await fetch(`${base}/files/read?path=note.txt`);
  assert.equal(response.status, 409);
  assert.doesNotMatch(await response.text(), /private content/);
});

test('human takeover cancels an active Office conversion before it can return a PDF', async (context) => {
  const previews = new OfficePreviewManager();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fake = context.mock.method(previews, 'convert', async (_data: Buffer, _extension: '.docx' | '.pptx', signal?: AbortSignal) => {
    entered();
    await new Promise<void>((resolve) => { context.mock.method(previews, 'cancelAll', async () => { resolve(); }); });
    assert.equal(signal?.aborted, false);
    return Buffer.from('%PDF-1.4');
  });
  const { home, executor, base } = await fixture(context, previews);
  await writeFile(join(home, 'note.docx'), 'doc');
  const request = fetch(`${base}/files/view?path=note.docx&preview=true`);
  await started;
  await executor.leases.takeHumanControl();
  const response = await request;
  assert.equal(response.status, 409);
  assert.equal(fake.mock.callCount(), 1);
});
