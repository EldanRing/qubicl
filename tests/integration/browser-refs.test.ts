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
  assert.equal(await page.locator('#input').inputValue(), 'original only');

  // Navigation during snapshot collection must not restore refs from the old
  // document after the navigation event has invalidated them.
  context.mock.method(page, 'title', async () => {
    await page.goto('about:blank');
    return '';
  });
  await assert.rejects(manager.snapshot(), { code: 'stale_browser_ref' });
});
