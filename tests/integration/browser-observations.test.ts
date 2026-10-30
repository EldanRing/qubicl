import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type BrowserType } from 'playwright-core';
import { BrowserManager } from '@qubicl/control/browser';
import { ToolExecutor } from '@qubicl/control/executor';
import type { BrowserControl } from '../../packages/control/dist/browser-dom.js';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;
type Snapshot = { snapshot: string; refs: Array<BrowserControl & { ref: string }>; focus: Record<string, unknown>; selection: Record<string, unknown> };

test('live observations and input cover composed text, form state, modalities, scrolling and immediate feedback', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE to a local Chromium or Chrome executable.', timeout: 30_000,
}, async (context) => {
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  await page.setContent(`
    <style>body{margin:10px}input,textarea,select,button{display:block} #nested{height:60px;width:200px;overflow:auto} #wide{height:300px;width:600px}</style>
    <div id="host"><span>Slotted text once</span></div>
    <details><summary>More details</summary><button>Previously concealed</button><p>Hidden prose</p></details>
    <span id="name">Canonical name</span><input id="named" aria-labelledby="name" aria-label="Wrong name" value="Initial">
    <input id="locked" aria-label="Locked" readonly value="Keep this">
    <form><input id="email" aria-label="Email" type="email" required><button>Submit form</button></form>
    <input id="number" aria-label="Quantity" type="number" min="2" max="8" step="0.5" value="3">
    <textarea id="memo" aria-label="Memo"></textarea>
    <input id="secret" aria-label="Password" type="password" value="NEVER-EXPOSE">
    <select id="choices" aria-label="Ambiguous choices" multiple>
      <option value="first">Same</option><option value="second">Same</option><option value="third">second</option>
    </select>
    <input id="file" aria-label="Attachments" type="file" multiple accept="image/png,.txt">
    <div id="nested" aria-label="Nested region"><div id="wide">Scrollable content</div></div>
    <label><input id="check" type="checkbox" onchange="window.changes=(window.changes||0)+1">Subscribe</label>
    <button id="feedback" onclick="document.querySelector('#status').textContent='Saved briefly'; document.querySelector('#status').textContent=''; const toast=document.createElement('div'); toast.textContent='Plain toast'; document.body.append(toast); toast.remove()">Save briefly</button>
    <div id="status" role="status"></div>
    <button id="icon"><img alt="Icon name" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E"></button>
    <dialog id="modal"><button id="inside">Dialog action</button></dialog>
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<p>Shadow needle</p><slot></slot><label>Shadow input<input value="Shadow value"></label>';</script>
  `);
  await page.locator('#memo').fill('  first\nsecond\n\nlast  ');
  await page.locator('#file').setInputFiles([{ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]);
  const manager = new BrowserManager(true, { browserType: { connectOverCDP: async () => browser } as unknown as BrowserType });
  const executor = new ToolExecutor(undefined, { browser: manager });
  context.after(() => executor.shutdown());
  const lease = executor.leases.acquire(60);
  const observe = async (): Promise<Snapshot> => await executor.call('browser_snapshot', {}) as Snapshot;
  let snapshot = await observe();
  const control = (name: string): BrowserControl & { ref: string } => {
    const result = snapshot.refs.find((item) => item.name === name);
    assert.ok(result, `Expected ${name}; got ${snapshot.refs.map((item) => item.name).join(', ')}`);
    return result;
  };
  const read = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => await executor.call('browser_read', input) as Record<string, unknown>;

  const text = await read({});
  assert.match(text.content as string, /Shadow needle/u);
  assert.equal((text.content as string).split('Slotted text once').length - 1, 1);
  assert.ok(!(text.content as string).includes('Hidden prose'));
  assert.equal(((await read({ query: 'Shadow needle' })).matches as unknown[]).length, 1);
  assert.equal((await read({ mode: 'value', ref: control('Shadow input').ref })).content, 'Shadow value');
  assert.equal(control('More details').expanded, false);
  await executor.call('browser_click', { lease, ref: control('More details').ref });
  snapshot = await observe();
  assert.equal(control('More details').expanded, true);
  assert.ok(control('Previously concealed').actionable);
  assert.equal(control('Locked').readOnly, true);
  await assert.rejects(executor.call('browser_type', { lease, ref: control('Locked').ref, text: 'must not change' }), { code: 'browser_control_unavailable' });
  assert.equal(await page.locator('#locked').inputValue(), 'Keep this');
  const nativeMessage = await page.locator('#email').evaluate((node) => (node as HTMLInputElement).validationMessage);
  assert.ok(nativeMessage);
  assert.ok(snapshot.snapshot.includes(nativeMessage));
  assert.equal((control('Email').validation as { message: string }).message, nativeMessage);
  assert.deepEqual(control('Quantity').constraints, { min: '2', max: '8', step: '0.5' });
  assert.equal((await read({ mode: 'value', ref: control('Memo').ref })).content, '  first\nsecond\n\nlast  ');
  assert.ok(!JSON.stringify(snapshot).includes('NEVER-EXPOSE'));
  await assert.rejects(read({ mode: 'value', ref: control('Password').ref }), { code: 'browser_read_value_unavailable' });

  for (const [id, name] of [['named', 'Canonical name'], ['icon', 'Icon name']]) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    const box = (await page.locator(`#${id}`).boundingBox())!;
    const point = await manager.inspectAt(box.x + box.width / 2, box.y + box.height / 2) as { elements: Array<{ id: string; name: string }> };
    assert.equal(point.elements.find((element) => element.id === id)?.name, control(name!).name);
    assert.ok(snapshot.snapshot.includes(JSON.stringify(name)));
  }
  assert.deepEqual(control('Ambiguous choices').options?.map((option) => [option.label, option.value]), [['Same', 'first'], ['Same', 'second'], ['second', 'third']]);
  await executor.call('browser_select', { lease, ref: control('Ambiguous choices').ref, value: ['second'], by: 'value' });
  assert.deepEqual(await page.locator('#choices').evaluate((node) => [...(node as HTMLSelectElement).selectedOptions].map((option) => option.value)), ['second']);
  const file = control('Attachments');
  assert.equal(file.accept, 'image/png,.txt');
  assert.equal(file.multiple, true);
  assert.deepEqual((file.files as Array<Record<string, unknown>>).map(({ name, size, type }) => ({ name, size, type })), [{ name: 'note.txt', size: 5, type: 'text/plain' }]);
  assert.ok(!JSON.stringify(file).includes('fakepath'));
  const full = JSON.parse((await read({ ref: file.ref, mode: 'control' })).content as string) as BrowserControl;
  assert.equal(full.filesTotal, 1);
  await page.locator('#choices').evaluate((node) => {
    for (let index = 0; index < 30; index++) (node as HTMLSelectElement).add(new Option(`Extra ${index}`, `value-${index}`));
  });
  snapshot = await observe();
  assert.equal(control('Ambiguous choices').optionsTruncated, true);
  const inventory = JSON.parse((await read({ ref: control('Ambiguous choices').ref, mode: 'control' })).content as string) as BrowserControl;
  assert.equal(inventory.options?.length, 33);
  const exact = ' leading\n🧪 second\n'.repeat(100);
  await page.locator('#memo').fill(exact);
  let part = await read({ ref: control('Memo').ref, mode: 'value', maxBytes: 512 });
  let reconstructed = part.content as string;
  while (part.nextCursor) { part = await read({ cursor: part.nextCursor, maxBytes: 512 }); reconstructed += part.content; }
  assert.equal(reconstructed, exact);
  await page.locator('#memo').fill('  first\nsecond\n\nlast  ');

  await page.locator('#memo').evaluate((node) => { const field = node as HTMLTextAreaElement; field.focus(); field.setSelectionRange(2, 14, 'backward'); });
  snapshot = await observe();
  assert.equal(snapshot.focus.name, 'Memo');
  assert.deepEqual(snapshot.selection, { start: 2, end: 14, direction: 'backward', text: 'first\nsecond', textTruncated: false, offsetUnit: 'utf16' });
  assert.equal(control('Memo').focused, true);
  await page.locator('#secret').evaluate((node) => { (node as HTMLInputElement).focus(); (node as HTMLInputElement).select(); });
  const secretSnapshot = await observe();
  assert.deepEqual(secretSnapshot.selection, { redacted: true });
  assert.ok(!JSON.stringify(secretSnapshot).includes('NEVER-EXPOSE'));

  const region = control('Nested region');
  assert.equal((region.scroll as { canScrollY: boolean }).canScrollY, true);
  const scrolled = await executor.call('browser_scroll', { lease, ref: region.ref, direction: 'down', amount: 40, observe: true }) as { scroll: { y: number } };
  assert.equal(scrolled.scroll.y, 40);
  await executor.call('browser_scroll', { lease, ref: region.ref, direction: 'right', amount: 30 });
  assert.equal(await page.locator('#nested').evaluate((node) => node.scrollLeft), 30);
  for (const checked of [true, true, false, false]) {
    const result = await executor.call('browser_click', { lease, ref: control('Subscribe').ref, checked, observe: true }) as { checked: boolean };
    assert.equal(result.checked, checked);
    assert.equal(await page.locator('#check').isChecked(), checked);
  }
  assert.equal(await page.evaluate(() => (window as unknown as { changes: number }).changes), 2);
  const feedback = await executor.call('browser_click', { lease, ref: control('Save briefly').ref, observe: true }) as { observation: { feedback: string[]; text: string } };
  assert.ok(feedback.observation.feedback.includes('Saved briefly'));
  assert.ok(feedback.observation.feedback.includes('Plain toast'));
  assert.equal(await page.locator('#status').innerText(), '');

  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.srcdoc = '<button>Frame action</button>'; document.body.append(frame); });
  await page.frameLocator('iframe').getByRole('button').waitFor();
  await page.locator('#modal').evaluate((node) => (node as HTMLDialogElement).showModal());
  snapshot = await observe();
  assert.equal(control('Save briefly').blockedByModal, true);
  assert.equal(control('Save briefly').actionable, false);
  assert.equal(control('Dialog action').actionable, true);
  await assert.rejects(executor.call('browser_click', { lease, ref: control('Save briefly').ref }), { code: 'browser_control_unavailable' });
  const childSnapshot = await executor.call('browser_snapshot', { frameIndex: 1 }) as Snapshot;
  assert.equal(childSnapshot.refs[0]!.blockedByModal, true);
  await assert.rejects(executor.call('browser_click', { lease, ref: childSnapshot.refs[0]!.ref }), { code: 'browser_control_unavailable' });
  await page.locator('#modal').evaluate((node) => (node as HTMLDialogElement).close());
});
