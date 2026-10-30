import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { chromium, type BrowserType } from 'playwright-core';
import { BrowserManager } from '@qubicl/control/browser';
import { ToolExecutor } from '@qubicl/control/executor';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;
type Snapshot = { refs: Array<{ ref: string; name: string; value?: string; valueLength?: number; valueTruncated?: boolean }> };

test('delayed sequential dialogs retain one operation without an action deadline or replay', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE to a local Chromium or Chrome executable.', timeout: 30_000,
}, async (context) => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/landing' ? '<title>Landing</title>Arrived' : `<button onclick="window.clicks=(window.clicks||0)+1; window.first=prompt('First'); window.second=confirm('Second')">Dialogs</button><a href="/landing">Leave</a>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const manager = new BrowserManager(true, { browserType: { connectOverCDP: async () => browser } as unknown as BrowserType });
  const executor = new ToolExecutor(undefined, { browser: manager });
  context.after(() => executor.shutdown());
  const lease = executor.leases.acquire(60);
  const snapshot = await manager.snapshot() as Snapshot;
  const waiting = await executor.call('browser_click', { lease, ref: snapshot.refs.find(item => item.name === 'Dialogs')!.ref }) as { status: string; dialogId: string; operationId: string };
  assert.equal(waiting.status, 'awaiting_dialog');
  // Cross the former locator.click deadline with an intentionally unanswered prompt.
  await new Promise(resolve => setTimeout(resolve, 15_100));
  assert.equal((await manager.listDialogs()).operations.find(item => item.operationId === waiting.operationId)?.status, 'awaiting_dialog');
  await executor.call('browser_respond_dialog', { lease, dialogId: waiting.dialogId, action: 'accept', promptText: '' });
  const second = (await manager.listDialogs()).dialogs.find(item => item.type === 'confirm')!;
  assert.ok(second);
  assert.equal(second.operationId, waiting.operationId);
  const pending = (await manager.listDialogs()).operations.find(item => item.operationId === waiting.operationId)!;
  assert.equal(pending.status, 'awaiting_dialog');
  assert.equal(pending.dialogId, second.id);
  const resolved = await executor.call('browser_respond_dialog', { lease, dialogId: second.id, action: 'dismiss' }) as { operation: { status: string } };
  assert.equal(resolved.operation.status, 'completed');
  assert.deepEqual(await page.evaluate(() => {
    const state = window as unknown as { clicks: number; first: string; second: boolean };
    return { clicks: state.clicks, first: state.first, second: state.second };
  }), { clicks: 1, first: '', second: false });
  await page.evaluate(() => window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; }));
  const leaveSnapshot = await manager.snapshot() as Snapshot;
  const leave = await executor.call('browser_click', { lease, ref: leaveSnapshot.refs.find(item => item.name === 'Leave')!.ref }) as { status: string; dialogId: string };
  assert.equal(leave.status, 'awaiting_dialog');
  assert.equal((await manager.listDialogs()).dialogs[0]!.type, 'beforeunload');
  const accepted = await executor.call('browser_respond_dialog', { lease, dialogId: leave.dialogId, action: 'accept' }) as { operation: { status: string } };
  assert.equal(accepted.operation.status, 'completed');
  assert.ok(page.url().endsWith('/landing'));
});

test('live popup, editor, selection, diagnostics and dialog workflows return actionable results', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE to a local Chromium or Chrome executable.', timeout: 25_000,
}, async (context) => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/failed')) { response.destroy(); return; }
    if (request.url === '/frame') { response.end('<p>Frame content</p>'); return; }
    response.setHeader('content-type', 'text/html');
    response.end(request.url?.startsWith('/child') ? '<title>Child</title><input aria-label="Child input">' : `
      <title>Parent</title><iframe src="/frame"></iframe>
      <a target="_blank" href="/child">Open child</a>
      <div id="rich" role="textbox" contenteditable="true" aria-label="Rich editor">Initial<br>Second line</div>
      <div contenteditable="plaintext-only" aria-label="Plain editor">Plain content</div>
      <input type="password" aria-label="Password" value="FAKE-PASSWORD">
      <select id="multi" multiple aria-label="Choices"><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select>
      <select id="single" aria-label="One choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <button onclick="window.promptClicks=(window.promptClicks||0)+1; document.body.dataset.answer=prompt('Your answer','initial')">Prompt</button>
    `);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  await page.goto(`${origin}/parent?token=TOP-SECRET#token=FRAGMENT-SECRET`);
  await page.evaluate(() => { document.title = 'Parent TOP-SECRET FRAGMENT-SECRET'; });
  let now = Date.parse('2026-10-30T12:00:00Z');
  const manager = new BrowserManager(true, { now: () => now, browserType: { connectOverCDP: async () => browser } as unknown as BrowserType });
  const executor = new ToolExecutor(undefined, { browser: manager });
  context.after(() => executor.shutdown());
  const lease = executor.leases.acquire(60);
  const snapshot = await manager.snapshot() as Snapshot;
  const ref = (name: string, source = snapshot): string => {
    const entry = source.refs.find((item) => item.name === name);
    assert.ok(entry, `Expected ${name} in snapshot`);
    return entry.ref;
  };
  assert.equal(snapshot.refs.find((item) => item.name === 'Rich editor')?.value, 'Initial\nSecond line');
  assert.equal(snapshot.refs.find((item) => item.name === 'Plain editor')?.value, 'Plain content');
  assert.ok(!JSON.stringify(snapshot).includes('FAKE-PASSWORD'));
  const parentId = (await manager.tabs()).tabs[0]!.tabId;
  for (const observed of [snapshot, await manager.tabs(), await manager.read({}), await manager.read({ frameIndex: 1 })]) {
    assert.ok(!JSON.stringify(observed).includes('TOP-SECRET'));
    assert.ok(!JSON.stringify(observed).includes('FRAGMENT-SECRET'));
  }

  const popup = await executor.call('browser_click', { lease, ref: ref('Open child') }) as {
    actedOnTabId: string; activeTabId: string; openedTabs: Array<{ tabId: string; url: string }>; url: string;
  };
  assert.equal(popup.actedOnTabId, parentId);
  assert.equal(popup.activeTabId, parentId);
  assert.equal(new URL(popup.url).pathname, '/parent');
  assert.ok(!popup.url.includes('TOP-SECRET'));
  assert.equal(new URL(popup.url).searchParams.get('token'), '[redacted]');
  assert.equal(popup.openedTabs.length, 1);
  assert.equal(popup.openedTabs[0]!.url, `${origin}/child`);
  assert.equal((await manager.tabs()).tabs.find((tab) => tab.active)?.tabId, parentId);
  // Existing parent refs remain usable after a popup; subsequent input stays there.
  await executor.call('browser_type', { lease, ref: ref('Rich editor'), text: 'Updated rich content' });
  assert.equal(await page.locator('#rich').innerText(), 'Updated rich content');
  const updated = await manager.snapshot() as Snapshot;
  assert.equal(updated.refs.find((item) => item.name === 'Rich editor')?.value, 'Updated rich content');
  await executor.call('browser_select', { lease, ref: ref('Choices', updated), value: ['Alpha', 'c'] });
  assert.deepEqual(await page.locator('#multi').evaluate((node) => [...(node as HTMLSelectElement).selectedOptions].map((option) => option.value)), ['a', 'c']);
  await executor.call('browser_select', { lease, ref: ref('Choices', updated), value: [] });
  assert.equal(await page.locator('#multi').evaluate((node) => (node as HTMLSelectElement).selectedOptions.length), 0);
  await assert.rejects(executor.call('browser_select', { lease, ref: ref('One choice', updated), value: ['a', 'b'] }), { code: 'browser_select_not_multiple' });
  assert.equal(await page.locator('#single').inputValue(), 'a');
  await page.locator('#rich').evaluate((node) => { node.textContent = '🧪'.repeat(2000); });
  const long = await manager.snapshot() as Snapshot;
  const editor = long.refs.find((item) => item.name === 'Rich editor')!;
  assert.equal(editor.valueLength, 4000);
  assert.equal(editor.valueTruncated, true);
  assert.ok(editor.value && editor.value.length <= 1500 && !editor.value.includes('\ufffd'));
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 24_000);

  await page.evaluate(() => console.log('Parent https://user:URL-SECRET@example.test/path?token=QUERY-SECRET#FRAGMENT-SECRET'));
  const child = browserContext.pages().find((candidate) => candidate !== page)!;
  now += 1000;
  await child.evaluate(() => console.log('Child diagnostic'));
  now += 1000;
  await page.evaluate(() => fetch('/failed?token=REQUEST-SECRET').catch(() => undefined));
  const events = await manager.browserDiagnostics();
  assert.ok(events.events.some((event) => event.tabId === popup.openedTabs[0]!.tabId && event.detail.includes('Child diagnostic')));
  const filtered = await manager.browserDiagnostics({ tabId: parentId, since: '2026-10-30T12:00:02Z', until: '2026-10-30T12:00:02Z', type: 'request-failed' });
  assert.ok(filtered.events.length > 0);
  assert.ok(filtered.events.every((event) => event.source.url === `${origin}/failed` && event.pageUrl === `${origin}/parent`));
  for (const secret of ['TOP-SECRET', 'PRIVATE', 'URL-SECRET', 'QUERY-SECRET', 'FRAGMENT-SECRET', 'REQUEST-SECRET']) assert.ok(!JSON.stringify(events).includes(secret), secret);
  assert.throws(() => manager.browserDiagnostics({ since: '2026-10-31T00:00:00Z', until: '2026-10-30T00:00:00Z' }), { code: 'browser_diagnostics_invalid_range' });
  assert.equal((await manager.browserDiagnostics({ limit: 1 })).events.length, 1);

  const waiting = await executor.call('browser_click', { lease, ref: ref('Prompt', long) }) as { status: string; dialogId: string; operationId: string; dispatch: string; dialog: { tabId: string; operationId: string } };
  assert.equal(waiting.status, 'awaiting_dialog');
  assert.equal(waiting.dispatch, 'started');
  assert.equal(waiting.dialog.tabId, parentId);
  assert.equal(waiting.dialog.operationId, waiting.operationId);
  const answered = await executor.call('browser_respond_dialog', { lease, dialogId: waiting.dialogId, action: 'accept', promptText: 'Handled' }) as { operation: { operationId: string; status: string } };
  assert.equal(answered.operation.operationId, waiting.operationId);
  assert.equal(answered.operation.status, 'completed');
  assert.equal(await page.locator('body').getAttribute('data-answer'), 'Handled');
  assert.equal(await page.evaluate(() => (window as unknown as { promptClicks: number }).promptClicks), 1);
  const dialogs = await manager.listDialogs();
  assert.equal(dialogs.dialogs.length, 0);
  assert.equal(dialogs.operations.find((operation) => operation.operationId === waiting.operationId)?.status, 'completed');
  await manager.useTab(popup.openedTabs[0]!.tabId);
  assert.equal((await manager.tabs()).tabs.find((tab) => tab.active)?.tabId, popup.openedTabs[0]!.tabId);
});
