import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserType, type Download } from 'playwright-core';
import { BrowserManager } from '@qubicl/control/browser';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;
test('live browser protects passwords, resize geometry, permission scope and dialog resolution', { skip: !executablePath, timeout: 30_000 }, async (context) => {
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  await browserContext.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<input type="password" value="FAKE-SECRET-ONLY"><button onclick="window.calls=(window.calls||0)+1; alert('alert')">Alert</button><button onclick="window.answer=confirm('confirm')">Confirm</button><button onclick="window.answer=prompt('prompt')">Prompt</button>` }));
  const page = await browserContext.newPage(); await page.goto('https://audit.test/');
  const manager = new BrowserManager(true, { browserType: { connectOverCDP: async () => browser } as unknown as BrowserType });
  context.after(() => manager.shutdown());
  const snapshot = await manager.snapshot() as { refs: Array<{name: string; ref: string}> };
  assert.ok(!JSON.stringify(snapshot).includes('FAKE-SECRET-ONLY'), JSON.stringify(snapshot));
  const image = await manager.screenshot(false);
  const resize = await manager.setViewport(800, 600);
  assert.ok(resize.geometryGeneration > image.geometryGeneration);
  await assert.rejects(manager.clickAt(10,10,'left',1,image.geometryGeneration), /geometry/i);
  await manager.permissions('https://audit.test', ['geolocation'], false);
  await manager.permissions('https://other.test', ['notifications'], false);
  await manager.permissions('https://audit.test', [], true);
  assert.equal(await page.evaluate(async () => (await navigator.permissions.query({name:'geolocation'})).state), 'prompt');
  const other = await browserContext.newPage(); await other.goto('https://other.test');
  assert.equal(await other.evaluate(async () => (await navigator.permissions.query({name:'notifications'})).state), 'granted');
  await other.close();
  for (const name of ['Alert','Confirm','Prompt']) {
    const current = await manager.snapshot() as typeof snapshot;
    const ref = current.refs.find(item => item.name === name)!.ref;
    await assert.rejects(manager.click(ref,'left'), {code:'browser_waiting_for_dialog'});
    const {dialogs} = await manager.listDialogs(); assert.equal(dialogs.length,1);
    await manager.respondDialog(dialogs[0]!.id, name === 'Confirm' ? 'dismiss' : 'accept', name === 'Prompt' ? 'typed' : undefined);
    await manager.snapshot();
  }
  assert.equal(await page.evaluate('window.calls'),1);
  assert.equal(await page.evaluate('window.answer'),'typed');
});

test('concurrent downloads retain unique bytes; cancellation failure and active history remain observable', async (context) => {
  const home = await mkdtemp(join(tmpdir(),'qubicl-download-audit-'));
  context.after(() => rm(home,{recursive:true,force:true}));
  const manager = new BrowserManager(true,{home});
  const internal = manager as unknown as {retainDownload(download: Download): Promise<void>};
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish=resolve; });
  const make = (contents:string, slow=false) => ({suggestedFilename:()=> 'report.csv',saveAs:async (path:string)=> {if(slow) await blocked; await writeFile(path,contents);},failure:async()=>null,cancel:async()=> {throw new Error('cancel failed');}} as unknown as Download);
  const pending = internal.retainDownload(make('long-running',true));
  await Promise.all(Array.from({length:201},(_,i)=>internal.retainDownload(make(String(i)))));
  const tracked = (await manager.listDownloads({ limit: 200 })).downloads;
  const active=[...(manager as unknown as { downloads: Map<string, { id: string; status: string }> }).downloads.values()].find(item=>item.status==='in-progress')!; assert.ok(active);
  await assert.rejects(manager.cancelDownload(active.id),/cancel failed/);
  assert.equal((await manager.listDownloads({ downloadId: active.id })).downloads[0]!.status,'in-progress');
  assert.equal((manager as unknown as { downloads: Map<string, unknown> }).downloads.size,201);
  const complete=tracked.filter(item=>item.status==='completed'); assert.ok(complete.length > 0 && complete.length <= 200);
  assert.equal(new Set(complete.map(item=>item.path)).size,complete.length);
  const contents=await Promise.all(complete.map(item=>readFile(item.path!,'utf8'))); assert.equal(new Set(contents).size,complete.length);
  finish(); await pending;
  assert.equal((await manager.listDownloads({ downloadId: active.id })).downloads[0]?.status,'completed');
});

test('a dialog cancels queued operations that have not started instead of dispatching them later', async () => {
  const manager = new BrowserManager(true);
  const internal = manager as unknown as { enqueue<T>(operation: () => Promise<T>): Promise<T>; dialogWaiters: Set<(id: string) => void> };
  let finish!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const first = internal.enqueue(async () => { firstStarted(); await blocked; return 'first'; });
  await started;
  let secondDispatches = 0;
  const second = internal.enqueue(async () => { secondDispatches += 1; return 'second'; });
  const firstRejected = assert.rejects(first, (error: { code?: string; details?: { dispatch?: string } }) => error.code === 'browser_waiting_for_dialog' && error.details?.dispatch === 'started');
  const secondRejected = assert.rejects(second, (error: { code?: string; details?: { dispatch?: string } }) => error.code === 'browser_waiting_for_dialog' && error.details?.dispatch === 'not-started');
  for (const notify of internal.dialogWaiters) notify('fixture-dialog');
  await Promise.all([firstRejected, secondRejected]);
  finish();
  await internal.enqueue(async () => undefined);
  assert.equal(secondDispatches, 0);
  const receipts = (await manager.listDialogs()).operations;
  assert.ok(receipts.some((item) => item.dispatch === 'started' && item.status === 'completed'));
  assert.ok(receipts.some((item) => item.dispatch === 'not-started' && item.status === 'interrupted'));
});
