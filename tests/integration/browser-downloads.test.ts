import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { chromium, type BrowserType } from 'playwright-core';
import { BrowserManager } from '@qubicl/control/browser';
import { ToolExecutor } from '@qubicl/control/executor';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;
test('real download receipts correlate progress, exact artifacts and intentional cancellation', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE.', timeout: 20_000,
}, async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-download-workflow-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const payload = Buffer.alloc(4 * 1024 * 1024, 'q');
  const transfers: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (!request.url?.startsWith('/file')) { response.end('<a href="/file?token=SECRET">Download</a>'); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length, 'content-disposition': 'attachment; filename="same.bin"' });
    // Hold the response open until the test explicitly completes or cancels it.
    transfers.push(response);
    response.write(payload.subarray(0, 256 * 1024));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext({ acceptDownloads: true });
  const page = await browserContext.newPage();
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await page.goto(url);
  const manager = new BrowserManager(true, { home, browserType: { connectOverCDP: async () => browser } as unknown as BrowserType });
  const executor = new ToolExecutor(undefined, { browser: manager });
  context.after(() => executor.shutdown());
  const lease = executor.leases.acquire(60);
  const snapshot = await manager.snapshot() as { refs: Array<{ ref: string }> };
  const click = async (): Promise<{ operationId: string; actedOnTabId: string; downloadStartedIds: string[] }> => await executor.call('browser_click', { lease, ref: snapshot.refs[0]!.ref }) as never;
  const progressOf = async (downloadId: string) => {
    const deadline = Date.now() + 5000;
    do {
      const observed = await manager.listDownloads({ downloadId, waitMs: 50 });
      if (observed.downloads[0]!.receivedBytes! > 0) return observed;
    } while (Date.now() < deadline);
    assert.fail('No download progress observed while the fixture response was held open');
  };
  const first = await click();
  assert.equal(first.downloadStartedIds.length, 1);
  const id = first.downloadStartedIds[0]!;
  const progress = await progressOf(id);
  assert.equal(progress.waitTimedOut, true);
  assert.equal(progress.downloads[0]!.status, 'in-progress');
  assert.ok(progress.downloads[0]!.receivedBytes! > 0);
  assert.equal(progress.downloads[0]!.totalBytes, payload.length);
  transfers[0]!.end(payload.subarray(256 * 1024));
  const completed = (await manager.listDownloads({ downloadId: id, waitMs: 5000 })).downloads[0]!;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.tabId, first.actedOnTabId);
  assert.equal(completed.operationId, first.operationId);
  assert.equal(completed.sourceUrl, `${url}/file`);
  assert.ok(!JSON.stringify(completed).includes('SECRET'));
  assert.equal(completed.sizeBytes, payload.length);
  assert.equal(completed.mimeType, 'application/octet-stream');
  assert.equal(completed.sha256, createHash('sha256').update(payload).digest('hex'));
  assert.deepEqual(await readFile(completed.path!), payload);
  assert.equal((await manager.cancelDownload(id)).status, 'completed');
  const second = await click();
  const partial = (await progressOf(second.downloadStartedIds[0]!)).downloads[0]!;
  assert.ok(partial.receivedBytes! > 0);
  const finishing = manager.listDownloads({ downloadId: second.downloadStartedIds[0]!, waitMs: 5000 });
  const cancelled = await manager.cancelDownload(second.downloadStartedIds[0]!);
  assert.equal(cancelled.status, 'cancelled');
  const terminal = (await finishing).downloads[0]!;
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.error, undefined);
  assert.ok(terminal.receivedBytes! >= partial.receivedBytes!, 'Cancellation retains the observed partial transfer count');
  assert.equal((await manager.listDownloads({ operationId: first.operationId })).downloads.length, 1);
});
