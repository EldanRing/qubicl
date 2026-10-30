import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { chromium, type BrowserType } from 'playwright-core';
import { BrowserManager } from '@qubicl/control/browser';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;

test('real history observes ordinary, same-URL and incompletely loaded local pages', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE to a local Chromium or Chrome executable.', timeout: 20_000,
}, async (context) => {
  const held = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url === '/held.js') {
      held.add(response);
      response.on('close', () => held.delete(response));
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${request.url}</title><main>${request.url}</main>${request.url === '/slow' ? '<script src="/held.js"></script>' : ''}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { for (const response of held) response.destroy(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  const manager = new BrowserManager(true, { browserType: { connectOverCDP: async () => browser } as unknown as BrowserType });
  context.after(() => manager.shutdown());

  await page.goto(`${origin}/first`);
  await page.goto(`${origin}/second`);
  const back = await manager.history('back');
  assert.equal(back.url, `${origin}/first`);
  assert.equal(back.navigation.status, 'committed');
  assert.equal(back.loading.readyState, 'complete');
  assert.equal((await manager.history('forward')).url, `${origin}/second`);
  assert.equal((await manager.history('reload')).navigation.status, 'committed');
  await page.evaluate(() => {
    history.replaceState({ step: 0 }, '');
    history.pushState({ step: 1 }, '');
  });
  const sameUrl = await manager.history('back');
  assert.equal(sameUrl.url, `${origin}/second`);
  assert.equal(sameUrl.navigation.status, 'committed');
  assert.equal(await page.evaluate(() => history.state.step), 0);

  await page.goto(`${origin}/slow`, { waitUntil: 'commit' });
  await page.goto(`${origin}/after-slow`);
  const started = Date.now();
  const slow = await manager.history('back');
  assert.equal(slow.url, `${origin}/slow`);
  assert.equal(slow.navigation.status, 'committed');
  assert.equal(slow.loading.waitStatus, 'timed_out');
  assert.equal(slow.loading.readyState, 'loading');
  assert.equal(slow.observationComplete, true);
  assert.ok(Date.now() - started < 5_000, 'a committed page must not spend 30 seconds waiting for loading');
});
