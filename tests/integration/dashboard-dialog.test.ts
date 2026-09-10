import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const executablePath = process.env.QUBICL_TEST_BROWSER_EXECUTABLE;

test('dashboard plan cancellation closes without validation or execution on desktop and phone', {
  skip: !executablePath && 'Set QUBICL_TEST_BROWSER_EXECUTABLE to a local Chromium or Chrome executable.',
}, async () => {
  const bundle = await build({
    entryPoints: ['packages/dashboard/src/app.ts'], bundle: true, write: false,
    platform: 'browser', format: 'esm', loader: { '.css': 'empty' },
  });
  const browser = await chromium.launch({ executablePath: executablePath!, headless: true, chromiumSandbox: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      let sensitive = false;
      let executions = 0;
      let plans = 0;
      await page.route('https://dashboard.test/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="app"></div><script type="module" src="/app.js"></script>' });
        if (path === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0]!.text });
        let value: unknown;
        if (path === '/api/v1/session') value = { authenticated: true, csrfToken: 'fixture' };
        else if (path === '/api/v1/snapshot') value = {
          initialized: true, docker: { available: true }, gateway: { status: 'running' },
          computers: [{ id: '12345678-1234-4234-8234-123456789012', name: 'example', preset: 'browser', status: 'running', cpus: 2, memory: '4g' }],
          trash: [], operations: [], release: '0.5.0',
        };
        else if (path === '/api/v1/plans') {
          plans += 1;
          value = { id: 'plan-fixture', operation: 'computers.stop', expiresAt: new Date(Date.now() + 300000).toISOString(), effects: ['Stop computers.'], preserved: [], warnings: [], requiresInterruption: true, requiresReauthentication: sensitive };
        } else if (path.endsWith('/execute')) { executions += 1; value = {}; }
        else return route.fulfill({ status: 404, body: '{}' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      });
      await page.goto('https://dashboard.test/');
      for (const requiresPassword of [false, true]) {
        sensitive = requiresPassword;
        for (const name of ['Cancel', 'Close plan']) {
          await page.getByRole('button', { name: 'Stop all', exact: true }).click();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor({ state: 'visible' });
          if (sensitive) assert.equal(await dialog.locator('#reauth-password').inputValue(), '');
          await dialog.getByRole('button', { name, exact: true }).click();
          await dialog.waitFor({ state: 'hidden' });
          await page.waitForFunction(() => document.querySelector('#plan-dialog')?.innerHTML === '');
        }
      }
      assert.equal(plans, 4);
      assert.equal(executions, 0);
      await page.close();
    }
  } finally { await browser.close(); }
});
