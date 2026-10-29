import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type BrowserType } from 'playwright-core';
import { BrowserManager } from '@qubicl/control/browser';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;

test('browser reading retains authenticated text, selects frames/subtrees and rejects navigation-stale cursors', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE to local Chromium or Chrome.', timeout: 30_000,
}, async (context) => {
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  await browserContext.addCookies([{ name: 'session', value: 'yes', domain: 'browser-read.test', path: '/' }]);
  await browserContext.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `
    <main id="report"></main><button id="action">Keep ref</button>
    <iframe srcdoc="<p>Frame text</p>"></iframe>
    <script>document.querySelector('main').textContent = document.cookie.includes('session=yes')
      ? 'Private report '.repeat(3000) + 'AUTHENTICATED TAIL' : 'Please sign in';</script>
  ` }));
  const page = await browserContext.newPage();
  await page.goto('https://browser-read.test/report');
  const manager = new BrowserManager(true, { browserType: { connectOverCDP: async () => browser } as unknown as BrowserType });
  context.after(() => manager.shutdown());
  const controls = await manager.snapshot() as { refs: Array<{ name: string; ref: string }> };
  const actionRef = controls.refs.find((item) => item.name === 'Keep ref')!.ref;
  type ReadPage = { content: string; documentId: string; nextCursor: string | null; matches: Array<{ excerpt: string }> };
  const first = await manager.read({ selector: '#report', maxBytes: 512 }) as ReadPage;
  await page.locator('#report').evaluate((element) => { element.textContent = 'Updated live text'; });
  let content = first.content;
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await manager.read({ cursor }) as ReadPage;
    assert.equal(next.documentId, first.documentId);
    content += next.content;
    cursor = next.nextCursor;
  }
  assert.equal(content, 'Private report '.repeat(3000) + 'AUTHENTICATED TAIL');
  assert.equal((await manager.read({ selector: '#report' }) as ReadPage).content, 'Updated live text');
  await manager.click(actionRef, 'left'); // Reading must not invalidate interactive refs.
  assert.equal((await manager.read({ frameIndex: 1 }) as ReadPage).content, 'Frame text');
  const found = await manager.read({ query: 'updated', selector: '#report' }) as ReadPage;
  assert.equal(found.matches.length, 1);
  await assert.rejects(manager.read({ cursor: first.nextCursor!, query: 'different' }), { code: 'browser_read_arguments' });
  await page.goto('https://browser-read.test/next');
  await assert.rejects(manager.read({ cursor: first.nextCursor! }), { code: 'stale_browser_read' });
});
