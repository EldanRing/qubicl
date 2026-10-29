import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type BrowserType } from 'playwright-core';
import { BrowserManager } from '@qubicl/control/browser';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;

test('real browser refs survive sibling changes and reject replaced DOM nodes', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE to a local Chromium or Chrome executable.',
  timeout: 30_000,
}, async (context) => {
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  await browserContext.route('**/*', (route) => route.abort());
  const page = await browserContext.newPage();
  await page.setContent(`
    <button id="original" onclick="document.body.dataset.clicked=this.id">Original</button>
    <input id="input" aria-label="Input" onkeydown="document.body.dataset.keyTarget=this.id">
    <select id="choice" aria-label="Choice"><option>A</option><option>B</option></select>
    <iframe srcdoc="&lt;button onclick=&quot;document.body.dataset.clicked='frame'&quot;&gt;Frame control&lt;/button&gt;"></iframe>
  `);
  // Use the real browser/context without opening a debugging listener or
  // connecting to an operator's persistent browser profile.
  const manager = new BrowserManager(true, {
    browserType: { connectOverCDP: async () => browser } as unknown as BrowserType,
  });
  context.after(() => manager.shutdown());
  const snapshot = await manager.snapshot() as { refs: Array<{ ref: string; name: string }> };
  const ref = (name: string): string => {
    const entry = snapshot.refs.find((entry) => entry.name === name);
    assert.ok(entry, `Snapshot must expose ${name}`);
    return entry.ref;
  };

  const childFrame = page.frames()[1]!;
  await childFrame.locator('button').waitFor();
  const framed = await manager.snapshot(0, 200, 1) as { refs: Array<{ ref: string }> };
  assert.ok(framed.refs[0]);
  assert.ok(!snapshot.refs.some(({ ref }) => ref === framed.refs[0]!.ref));
  for (let capture = 0; capture < 40; capture += 1) {
    const observed = await manager.snapshot() as { refs: Array<{ ref: string }> };
    assert.deepEqual(observed.refs.map(({ ref }) => ref), snapshot.refs.map(({ ref }) => ref));
  }
  await manager.click(framed.refs[0]!.ref, 'left');
  assert.equal(await childFrame.locator('body').getAttribute('data-clicked'), 'frame');
  await childFrame.goto('about:blank');
  await assert.rejects(manager.click(framed.refs[0]!.ref, 'left'), { code: 'stale_browser_ref' });
  // Navigating a child invalidates only its own refs, while main-frame refs
  // continue to identify the exact same nodes through passive observations.
  await manager.click(ref('Original'), 'left');

  await page.evaluate(() => {
    const button = document.querySelector('#original')!;
    const inserted = button.cloneNode(true) as HTMLElement;
    inserted.id = 'inserted';
    button.before(inserted);
    document.body.append(button);
    const input = document.querySelector('#input')!;
    const otherInput = input.cloneNode(true) as HTMLElement;
    otherInput.id = 'other-input';
    input.before(otherInput);
    document.body.prepend(document.querySelector('#choice')!);
  });
  await manager.click(ref('Original'), 'left');
  await manager.type(ref('Input'), 'original only', false, true);
  await manager.press('End', ref('Input'));
  await manager.select(ref('Choice'), 'B');
  assert.equal(await page.locator('body').getAttribute('data-clicked'), 'original');
  assert.equal(await page.locator('body').getAttribute('data-key-target'), 'input');
  assert.equal(await page.locator('#input').inputValue(), 'original only');
  assert.equal(await page.locator('#other-input').inputValue(), '');
  assert.equal(await page.locator('#choice').inputValue(), 'B');

  await manager.type(ref('Input'), ' appended', false, false);
  assert.equal(await page.locator('#input').inputValue(), 'original only appended');

  await page.evaluate(() => {
    for (const id of ['original', 'input', 'choice']) {
      const element = document.getElementById(id)!;
      element.replaceWith(element.cloneNode(true));
    }
    delete document.body.dataset.clicked;
    delete document.body.dataset.keyTarget;
  });
  for (const action of [
    () => manager.click(ref('Original'), 'left'),
    () => manager.type(ref('Input'), 'replacement must stay untouched', false, true),
    () => manager.press('Enter', ref('Input')),
    () => manager.select(ref('Choice'), 'A'),
  ]) await assert.rejects(action(), { code: 'stale_browser_ref' });
  assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
  assert.equal(await page.locator('body').getAttribute('data-key-target'), null);
  assert.equal(await page.locator('#input').inputValue(), 'original only appended');

  // Navigation during snapshot collection must not restore refs from the old
  // document after the navigation event has invalidated them.
  context.mock.method(page, 'title', async () => {
    await page.goto('about:blank');
    return '';
  });
  await assert.rejects(manager.snapshot(), { code: 'stale_browser_ref' });
});
