import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserType, ElementHandle, Locator, Page } from 'playwright-core';
import { BrowserManager, INTERACTIVE_BROWSER_IGNORED_DEFAULT_ARGS, browserViewportToDisplayPoint } from '@qubicl/control/browser';
import { ToolExecutor } from '@qubicl/control/executor';
import { LeaseManager } from '../../packages/control/dist/lease.js';
import { createInternalRunner } from '../../packages/control/dist/internal-runner.js';
import { RemoteBrowserManager } from '../../packages/control/dist/remote-runners.js';
import { verifyBrowserInputOwner } from '../../packages/control/dist/browser-ownership.js';
import { errorPayload, QubiclError } from '../../packages/control/dist/errors.js';
import type { ViewerPointerUpdate } from '@qubicl/control/viewer-actions';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDWQAAAABJRU5ErkJggg==', 'base64');
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

test('browser manager provides the Terminal1 semantic, tab, and screenshot-grounded surface', async (context) => {
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, {
    browserType: fake.browserType,
    endpoint: 'http://browser.test:9222',
    headless: true,
  });
  context.after(() => manager.shutdown());

  assert.equal(manager.count(), 0);
  const navigation = await manager.navigate('https://example.test/start');
  assert.deepEqual(navigation, { url: 'https://example.test/start', title: 'Fake page', actedOnTabId: navigation.actedOnTabId,
    activeTabId: navigation.actedOnTabId, openedTabs: [], openedTabsTruncated: false });
  assert.equal(manager.count(), 1);
  assert.deepEqual(await manager.health(), {
    state: 'attached',
    sandbox: 'required',
    profile: 'persistent',
    extensions: 'enabled',
    passwordStore: 'secret_service',
    publicExtraction: 'isolated_context',
    tabPolicy: { agentOpenLimit: 24, automaticEviction: false },
    engineVersion: '140.0.0.0',
    recentDiagnosticCount: 0,
  });

  const snapshot = await manager.snapshot() as {
    snapshot: string;
    refs: { ref: string; name: string }[];
    scroll: { x: number; y: number };
    truncated: { snapshot: boolean; refs: boolean };
  };
  assert.equal(snapshot.snapshot, '- document "Fake page"');
  assert.deepEqual(snapshot.refs.map(({ ref, name }) => ({ ref, name })), [
    { ref: 'g1e1', name: 'First control' },
    { ref: 'g1e2', name: 'Second control' },
  ]);
  assert.deepEqual(snapshot.scroll, { x: 4, y: 8 });
  assert.deepEqual(snapshot.truncated, { snapshot: false, refs: false });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 24_000);

  const semanticClick = await manager.clickWithViewerPointer('g1e1', 'left');
  assert.deepEqual(semanticClick.result, navigation);
  assert.deepEqual(semanticClick.pointerActions, [{ type: 'click', x: 74, y: 111, button: 1 }]);
  await manager.type('g1e1', 'typed', true, true);
  await manager.select('g1e2', 'Selected');
  await manager.press('Control+A', 'g1e1');
  await manager.scroll('down', 600);
  await manager.history('back');
  await manager.history('forward');
  await manager.history('reload');
  await manager.wait(0);
  assert.deepEqual(fake.locators[0]!.fills, ['typed']);
  assert.deepEqual(fake.locators[0]!.presses, ['Enter', 'Control+A']);
  assert.deepEqual(fake.locators[1]!.selections, [{ value: 'Selected' }]);

  const screenshot = await manager.screenshot(false);
  assert.equal(screenshot.mimeType, 'image/png');
  assert.equal(Buffer.from(screenshot.data, 'base64').equals(PNG), true);
  assert.deepEqual(screenshot.viewport, { width: 1440, height: 900, deviceScaleFactor: 1 });

  for (let index = 0; index < 6; index += 1) await manager.newTab(`https://example.test/${index}`);
  const tabs = await manager.tabs();
  assert.equal(tabs.tabs.length, 7, 'Qubicl does not silently discard inactive or human-created tabs');
  assert.equal(new Set(tabs.tabs.map(({ tabId }) => tabId)).size, tabs.tabs.length);
  const firstTabId = tabs.tabs[0]!.tabId;
  await manager.useTab(firstTabId);
  await manager.closeTab(-1);
  const afterClose = await manager.tabs();
  assert.equal(afterClose.tabs.length, 6);
  assert.equal(afterClose.tabs.some(({ tabId }) => tabId === firstTabId), false);
  assert.equal((await manager.reset()).url, 'about:blank');
  assert.equal(fake.newPageExistingPageCounts.every((count) => count > 0), true);

  await manager.snapshot();
  await manager.newTab();
  await assert.rejects(manager.click('g2e1', 'left'), /Unknown or stale browser element ref/);
  assert.deepEqual((await manager.inspectAt(10, 20)).point, { x: 10, y: 20 });

  const images = await Promise.all([
    manager.clickAt(10, 20, 'left'),
    manager.clickAt(10, 20, 'right', 2),
    manager.hoverAt(12, 22),
    manager.drag(1, 2, 30, 40),
    manager.scrollAt(50, 60, 2, 700),
    manager.typeFocused('focused'),
    manager.computer([
      { type: 'keypress', keys: ['Control', 'A'] },
      { type: 'wait', milliseconds: 0 },
      { type: 'screenshot' },
    ]),
  ]);
  assert.deepEqual(images.map(({ mimeType }) => mimeType), Array.from({ length: 7 }, () => 'image/png'));
  assert.ok(fake.mouseEvents.includes('click:right:2'));
  assert.ok(fake.mouseEvents.includes('wheel:2:700'));
  assert.ok(fake.keyboardEvents.includes('insert:focused'));

  const visual = await manager.computerWithViewerPointers([
    { type: 'click', x: 10, y: 20, button: 'right' },
    { type: 'move', x: 12, y: 22 },
    { type: 'drag', path: [{ x: 1, y: 2 }, { x: 30, y: 40 }] },
    { type: 'scroll', x: 50, y: 60, scroll_y: -700 },
    { type: 'type', text: 'not-published' },
  ]);
  assert.equal(visual.result.actionCount, 5);
  assert.deepEqual(visual.pointerActions, [
    { type: 'right_click', x: 24, y: 96, button: 3 },
    { type: 'move', x: 26, y: 98, button: 1 },
    { type: 'drag', toX: 44, toY: 116, button: 1 },
    { type: 'scroll', x: 64, y: 136, deltaY: -700 },
  ]);

  await assert.rejects(manager.navigate('file:///etc/passwd'), /HTTP or HTTPS/);
  await assert.rejects(manager.navigate('https://user:secret@example.test/'), /embedded credentials/);
});


test('snapshot refs retain node identity across insertion and reordering and reject replacements', async (context) => {
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  context.after(() => manager.shutdown());
  const original = fake.locators[0]!;
  await manager.snapshot();
  const inserted = new FakeLocator(2);
  fake.locators.unshift(inserted);
  await manager.click('g1e1', 'left');
  fake.locators.reverse();
  await manager.type('g1e1', 'original only', false, false);
  await manager.press('Enter', 'g1e1');
  assert.equal(original.clicks, 2);
  assert.deepEqual(original.fills, []);
  assert.ok(fake.keyboardEvents.includes('type:original only'));
  assert.deepEqual(original.presses, ['End', 'Enter']);
  assert.equal(inserted.clicks, 0);
  assert.deepEqual(inserted.fills, []);

  original.connected = false;
  fake.locators.splice(fake.locators.indexOf(original), 1, new FakeLocator(0));
  for (const action of [
    () => manager.click('g1e1', 'left'),
    () => manager.type('g1e1', 'must not type', false, false),
    () => manager.select('g1e1', 'must not select'),
    () => manager.press('Enter', 'g1e1'),
  ]) await assert.rejects(action(), { code: 'stale_browser_ref' });
  assert.equal(original.disposals, 1);
});

test('passive snapshots reuse live refs; retained handles expire only on eviction or document changes', async () => {
  const fake = new FakeBrowserRuntime(200, 'x'.repeat(80_000));
  fake.locators[0]!.visible = false;
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  try {
    const snapshot = await manager.snapshot() as { refs: Array<{ ref: string }> };
    assert.equal(fake.locators.filter((node) => node.disposals === 0).length, snapshot.refs.length);
    for (let index = 0; index < 40; index += 1) {
      const observed = await manager.snapshot() as { refs: Array<{ ref: string }> };
      assert.deepEqual(observed.refs.map(({ ref }) => ref), snapshot.refs.map(({ ref }) => ref));
    }
    await manager.click(snapshot.refs[0]!.ref, 'left');
    const original = fake.locators[1]!;
    assert.equal(original.clicks, 1);
    Object.assign(fake, { aria: '' });
    // Newly observed nodes eventually evict the oldest refs, without retaining
    // unbounded handles or breaking repeatedly observed unchanged controls.
    for (let page = 0; page < 33; page += 1) {
      fake.locators.splice(0, fake.locators.length, ...Array.from({ length: 200 }, () => new FakeLocator(0)));
      await manager.snapshot();
    }
    await assert.rejects(manager.click(snapshot.refs[0]!.ref, 'left'), { code: 'stale_browser_ref' });
    assert.equal(original.disposals, 1);
    const current = await manager.snapshot() as { refs: Array<{ ref: string }> };
    await manager.navigate('https://example.test/next');
    await assert.rejects(manager.click(current.refs[0]!.ref, 'left'), { code: 'stale_browser_ref' });
    const next = await manager.snapshot() as { refs: Array<{ ref: string }> };
    await manager.shutdown();
    await assert.rejects(manager.click(next.refs[0]!.ref, 'left'), { code: 'stale_browser_ref' });
  } finally {
    await manager.shutdown();
  }
});

test('browser viewport coordinates map through window chrome and display scale', () => {
  assert.deepEqual(browserViewportToDisplayPoint({ x: 25, y: 40 }, {
    screenX: 10,
    screenY: 20,
    outerWidth: 1_460,
    outerHeight: 980,
    innerWidth: 1_440,
    innerHeight: 900,
    devicePixelRatio: 2,
  }), { x: 90, y: 260 });
  assert.equal(browserViewportToDisplayPoint({ x: 1, y: 1 }, {
    screenX: 0,
    screenY: 0,
    outerWidth: 0,
    outerHeight: 0,
    innerWidth: 0,
    innerHeight: 0,
    devicePixelRatio: 1,
  }), undefined);
});

test('browser batches stop after takeover during input and retain cleanup of held keys/buttons', async (context) => {
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  const executor = new ToolExecutor(undefined, { browser: manager });
  context.after(() => executor.shutdown());
  await manager.snapshot();
  const connection = await fake.browserType.connectOverCDP('http://fake');
  const page = connection.contexts()[0]!.pages()[0]!;
  const owner = executor.leases.acquire(60);
  context.mock.method(page.mouse, 'click', async () => {
    fake.mouseEvents.push('first-click');
    await executor.takeHumanControl();
  });
  await assert.rejects(executor.call('browser_computer', { lease: owner, actions: [
    { type: 'click', x: 10, y: 20 }, { type: 'type', text: 'must not arrive' },
  ] }), { code: 'action_result_uncertain' });
  assert.deepEqual(fake.mouseEvents, ['first-click']);
  assert.deepEqual(fake.keyboardEvents, []);

  executor.releaseHumanControl();
  const next = executor.leases.acquire(60);
  context.mock.method(page.mouse, 'down', async () => {
    fake.mouseEvents.push('down:left');
    await executor.takeHumanControl();
  });
  await assert.rejects(manager.withInputOwnership(next, () => { executor.leases.verifyInteractive(next); }, () => manager.computer([
    { type: 'drag', path: [{ x: 1, y: 2 }, { x: 3, y: 4 }], keys: ['Control'] },
  ])), { code: 'stale_lease' });
  assert.deepEqual(fake.mouseEvents, ['first-click', 'move:1:2', 'down:left', 'up:left']);
  assert.deepEqual(fake.keyboardEvents, ['down:Control', 'up:Control']);
});

test('ownership is rechecked after pointer publication and before queued semantic input', async (context) => {
  const leases = new LeaseManager();
  const owner = leases.acquire(60);
  let publicationStarted!: () => void;
  const published = new Promise<void>((resolve) => { publicationStarted = resolve; });
  let releasePublication!: () => void;
  const blocked = new Promise<void>((resolve) => { releasePublication = resolve; });
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, {
    browserType: fake.browserType,
    publishViewerPointer: async (update) => {
      if (update.phase === 'intent') { publicationStarted(); await blocked; }
    },
  });
  context.after(() => manager.shutdown());
  const snapshot = await manager.snapshot() as { refs: Array<{ ref: string }> };
  const guarded = <T>(operation: () => Promise<T>): Promise<T> => manager.withInputOwnership(owner, () => { leases.verifyInteractive(owner); }, operation);
  const first = guarded(() => manager.clickWithViewerPointer(snapshot.refs[0]!.ref, 'left', owner.generation));
  await published;
  const queued = guarded(() => manager.type(snapshot.refs[1]!.ref, 'stale input', true, true));
  const firstRejected = assert.rejects(first, { code: 'stale_lease' });
  const queuedRejected = assert.rejects(queued, { code: 'stale_lease' });
  await leases.release(owner);
  const current = leases.acquire(60);
  const currentWork = manager.withInputOwnership(current, () => { leases.verifyInteractive(current); }, () => manager.type(snapshot.refs[1]!.ref, 'current input', false, true));
  releasePublication();
  await Promise.all([firstRejected, queuedRejected, currentWork]);
  assert.equal(fake.locators[0]!.clicks, 0);
  assert.deepEqual(fake.locators[1]!.fills, ['current input']);
  assert.deepEqual(fake.locators[1]!.presses, []);
  await leases.release(current);
});

test('completed dialog, download, and permission changes remain accurately recorded when the lease ends during dispatch', async (context) => {
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  context.after(() => manager.shutdown());
  const leases = new LeaseManager();
  let owner = leases.acquire(60);
  const guarded = <T>(operation: () => Promise<T>): Promise<T> => manager.withInputOwnership(owner, () => { leases.verifyInteractive(owner); }, operation);
  await manager.snapshot();
  const connection = await fake.browserType.connectOverCDP('http://fake');
  const browserContext = connection.contexts()[0]!;
  Object.assign(browserContext, {
    grantPermissions: async () => { await leases.release(owner); },
    clearPermissions: async () => undefined,
  });
  await assert.rejects(guarded(() => manager.permissions('https://one.test', ['clipboard-read'], false)), { code: 'stale_lease' });
  assert.deepEqual((await manager.permissions('https://one.test', [], false)).permissions, ['clipboard-read']);
  // A rejected clear must not erase bookkeeping for the still-granted origin.
  await assert.rejects(guarded(() => manager.permissions('https://one.test', [], true)), { code: 'stale_lease' });
  assert.deepEqual((await manager.permissions('https://one.test', [], false)).permissions, ['clipboard-read']);

  owner = leases.acquire(60);
  const page = browserContext.pages()[0] as unknown as { listeners: Map<string, Array<(dialog: unknown) => void>> };
  for (const listener of page.listeners.get('dialog') ?? []) listener({
    type: () => 'alert', message: () => 'fixture', defaultValue: () => '',
    accept: async () => { await leases.release(owner); },
  });
  const dialog = (await manager.listDialogs()).dialogs[0]!;
  await assert.rejects(guarded(() => manager.respondDialog(dialog.id, 'accept')), { code: 'stale_lease' });
  assert.deepEqual((await manager.listDialogs()).dialogs, []);

  owner = leases.acquire(60);
  const downloads = manager as unknown as {
    downloads: Map<string, { id: string; status: string }>;
    activeDownloads: Map<string, { cancel(): Promise<void> }>;
  };
  downloads.downloads.set('active', { id: 'active', status: 'in-progress' });
  downloads.activeDownloads.set('active', { cancel: async () => { await leases.release(owner); } });
  await assert.rejects(guarded(() => manager.cancelDownload('active')), { code: 'stale_lease' });
  assert.equal((await manager.listDownloads()).downloads[0]!.status, 'cancelled');
});

test('remote browser input proves current ownership through the authenticated control/session round trip', { timeout: 10_000 }, async (context) => {
  const key = 'browser-session-test-key-0123456789';
  let leases = new LeaseManager();
  let checks = 0;
  const control = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/_qubicl/session/input-ownership');
      const owner = await browserRequestJson(request);
      verifyBrowserInputOwner(request.headers['x-qubicl-pointer-key'], key, owner, leases);
      checks += 1;
      response.end(JSON.stringify({ authorized: true }));
    } catch (error) {
      response.writeHead(error instanceof QubiclError ? error.status : 500);
      response.end(JSON.stringify(errorPayload(error)));
    }
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => control.close(() => resolve())));
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  const environment = {
    QUBICL_RUNTIME_ROLE: 'session', QUBICL_RUNNER_KEY: key, QUBICL_HOST_UID: String(process.getuid!()),
    QUBICL_HOST_GID: String(process.getgid!()), QUBICL_COMPATIBILITY: 'browser',
    QUBICL_POINTER_URL: `${controlUrl}/_qubicl/session/pointer`,
  };
  const saved = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
  Object.assign(process.env, environment);
  let session: ReturnType<typeof createInternalRunner>;
  try { session = createInternalRunner({ browser: manager }); }
  finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  await new Promise<void>((resolve) => session.server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    try { await executor.shutdown(); }
    finally {
      await session.shutdown();
      await new Promise<void>((resolve) => session.server.close(() => resolve()));
    }
  });
  const remote = new RemoteBrowserManager(`http://127.0.0.1:${(session.server.address() as AddressInfo).port}`, key);
  const executor = new ToolExecutor(undefined, { browser: remote });
  leases = executor.leases;
  const owner = executor.leases.acquire(60);
  await remote.snapshot(); // Passive requests need no owner proof.
  const connection = await fake.browserType.connectOverCDP('http://fake');
  const page = connection.contexts()[0]!.pages()[0]!;
  context.mock.method(page.keyboard, 'insertText', async (value: string) => {
    fake.keyboardEvents.push(`insert:${value}`);
    await executor.takeHumanControl();
  });
  await assert.rejects(executor.call('browser_computer', { lease: owner, actions: [
    { type: 'type', text: 'first' }, { type: 'type', text: 'second' },
  ] }), { code: 'action_result_uncertain' });
  assert.deepEqual(fake.keyboardEvents, ['insert:first']);
  assert.ok(checks >= 1);
  await assert.rejects(remote.typeFocused('unowned'), { code: 'stale_lease' });
  const denied = await fetch(`${controlUrl}/_qubicl/session/input-ownership`, {
    method: 'POST', headers: { 'x-qubicl-pointer-key': 'wrong-key' }, body: JSON.stringify(owner),
  });
  assert.equal(denied.status, 401);
  await denied.arrayBuffer();
});

async function browserRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

test('browser pointer intent is published before dispatch and confirmed before slow result work', async (context) => {
  const fake = new FakeBrowserRuntime();
  const updates: ViewerPointerUpdate[] = [];
  let releaseIntent: (() => void) | undefined;
  const intentGate = new Promise<void>((resolve) => { releaseIntent = resolve; });
  const manager = new BrowserManager(true, {
    browserType: fake.browserType,
    endpoint: 'http://browser.test:9222',
    headless: true,
    publishViewerPointer: async (update) => {
      updates.push(update);
      if (update.phase === 'intent') await intentGate;
    },
  });
  context.after(() => manager.shutdown());

  const operation = manager.computerWithViewerPointers([{ type: 'click', x: 10, y: 20 }], 7);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates[0]?.phase, 'intent');
  assert.equal(fake.mouseEvents.some((event) => event.startsWith('click:')), false);

  releaseIntent?.();
  const result = await operation;
  assert.equal(fake.mouseEvents.some((event) => event.startsWith('click:')), true);
  assert.deepEqual(updates.map(({ phase }) => phase), ['intent', 'confirm']);
  assert.equal(updates.every(({ generation }) => generation === 7), true);
  assert.deepEqual(result.pointerActions, []);
});

test('browser manager fails closed when the image contract omits browser capability', async () => {
  const manager = new BrowserManager(false);
  await assert.rejects(manager.tabs(), /does not provide the browser capability/);
  await manager.shutdown();
});

test('browser manager launches Chromium with its Linux sandbox and dedicated shared memory', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-browser-sandbox-'));
  const fake = new FakeBrowserRuntime(2, '- document "Fake page"', '<html><body>Rendered</body></html>', false);
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true, home });
  context.after(async () => {
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  });

  await manager.navigate('https://example.test/sandboxed');
  assert.equal(fake.launchOptions?.chromiumSandbox, true);
  assert.deepEqual(fake.launchOptions?.ignoreDefaultArgs, [...INTERACTIVE_BROWSER_IGNORED_DEFAULT_ARGS, '--disable-dev-shm-usage']);
  const args = fake.launchOptions?.args as string[];
  assert.equal(args.includes('--no-sandbox'), false);
  assert.equal(args.includes('--disable-dev-shm-usage'), false);
});

test('browser snapshots enforce one aggregate model-text budget', async (context) => {
  const fake = new FakeBrowserRuntime(200, 'x'.repeat(80_000));
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  context.after(() => manager.shutdown());
  const snapshot = await manager.snapshot() as { truncated: { snapshot: boolean; refs: boolean } };
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 24_000);
  assert.equal(snapshot.truncated.snapshot, true);
  assert.equal(snapshot.truncated.refs, true);
});

test('browser extraction waits for rendered content and returns only bounded sanitized DOM', async (context) => {
  const renderedHtml = '<!doctype html><html><head><title>Live market</title><script type="application/ld+json">{"offers":{"price":"42.50"}}</script></head><body><main><p>Rendered article content</p><div data-price="42.50"></div></main></body></html>';
  const fake = new FakeBrowserRuntime(0, '', renderedHtml);
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true, resolver: PUBLIC_LOOKUP });
  context.after(() => manager.shutdown());

  const rendered = await manager.renderForExtraction('https://example.test/live');
  assert.equal(rendered.finalUrl, 'https://example.test/live');
  assert.equal(rendered.title, 'Fake page');
  assert.equal(rendered.contentType, 'text/html');
  assert.equal(rendered.html, renderedHtml);
  assert.equal(rendered.sourceTruncated, false);
  assert.equal(fake.settleEvaluations, 1);
});

type EventListener = (...values: unknown[]) => void;

test('history separates navigation from load timeouts and accepts response-less same-URL transitions', async (context) => {
  const fake = new FakeBrowserRuntime();
  const connection = await fake.browserType.connectOverCDP('http://fake');
  const page = connection.contexts()[0]!.pages()[0]! as unknown as FakePage;
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  context.after(() => manager.shutdown());
  let calls = 0;
  context.mock.method(page, 'goBack', async (options: { waitUntil: string; timeout: number }) => {
    calls++;
    assert.equal(options.waitUntil, 'commit');
    assert.ok(options.timeout <= 5_000);
    page.emit('framenavigated', page);
    return null;
  });
  context.mock.method(page, 'waitForLoadState', async (_state: string, options: { timeout: number }) => {
    assert.ok(options.timeout <= 1_000);
    throw Object.assign(new Error('No load event'), { name: 'TimeoutError' });
  });
  const result = await manager.history('back');
  assert.deepEqual(result.navigation, { action: 'back', status: 'committed', waitTimedOut: false });
  assert.deepEqual(result.loading, { waitUntil: 'domcontentloaded', waitStatus: 'timed_out', readyState: 'complete' });
  assert.equal(result.url, 'about:blank');
  assert.equal(result.title, 'Fake page');
  assert.equal(result.observationComplete, true);
  assert.equal(calls, 1, 'an incomplete wait must not repeat a history action');
});

test('history distinguishes missing entries, uncertain commit waits and non-timeout failures', async (context) => {
  const fake = new FakeBrowserRuntime();
  const connection = await fake.browserType.connectOverCDP('http://fake');
  const page = connection.contexts()[0]!.pages()[0]! as unknown as FakePage;
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  context.after(() => manager.shutdown());
  context.mock.method(page, 'goBack', async () => null);
  await assert.rejects(manager.history('back'), { code: 'browser_no_history' });
  const load = context.mock.method(page, 'waitForLoadState', async () => {});
  const forward = context.mock.method(page, 'goForward', async () => {
    throw Object.assign(new Error('Commit timeout'), { name: 'TimeoutError' });
  });
  const result = await manager.history('forward');
  assert.deepEqual(result.navigation, { action: 'forward', status: 'not_observed', waitTimedOut: true });
  assert.equal(result.loading.waitStatus, 'not_waited');
  assert.equal(load.mock.callCount(), 0);
  assert.equal(forward.mock.callCount(), 1);
  context.mock.method(page, 'reload', async () => { throw new Error('Target closed'); });
  await assert.rejects(manager.history('reload'), /Target closed/);
});

test('history retains navigation evidence when its commit wait times out and observation fails', async (context) => {
  const fake = new FakeBrowserRuntime();
  const connection = await fake.browserType.connectOverCDP('http://fake');
  const page = connection.contexts()[0]!.pages()[0]! as unknown as FakePage;
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  context.after(() => manager.shutdown());
  context.mock.method(page, 'goBack', async () => {
    page.urlValue = 'https://example.test/observed';
    page.emit('framenavigated', page);
    throw Object.assign(new Error('Commit timeout'), { name: 'TimeoutError' });
  });
  context.mock.method(page, 'evaluate', async () => { throw new Error('Execution context destroyed'); });
  const result = await manager.history('back');
  assert.equal(result.navigation.status, 'committed');
  assert.equal(result.navigation.waitTimedOut, true);
  assert.equal(result.url, 'https://example.test/observed');
  assert.equal(result.observationComplete, false);
  assert.equal(result.loading.readyState, 'unavailable');
});

class FakeLocator {
  readonly fills: string[] = [];
  readonly presses: string[] = [];
  readonly selections: unknown[] = [];
  connected = true;
  visible = true;
  clicks = 0;
  disposals = 0;

  constructor(private readonly index: number) {}

  async isVisible(): Promise<boolean> { return this.visible; }
  async dispose(): Promise<void> { this.disposals += 1; }
  async evaluate<T, A>(callback: (element: HTMLElement, argument?: A) => T, argument?: A): Promise<T> {
    const name = this.index === 0 ? 'First control' : this.index === 1 ? 'Second control' : `Control ${this.index} ${'x'.repeat(240)}`;
    return callback({
      tagName: 'BUTTON', textContent: name, isConnected: this.connected,
      getAttribute: (attribute: string) => attribute === 'role' ? 'button' : null,
    } as unknown as HTMLElement, argument!);
  }
  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    return { x: 10 + this.index, y: 20, width: 100, height: 30 };
  }
  async scrollIntoViewIfNeeded(): Promise<void> {}
  async click(): Promise<void> { this.clicks += 1; }
  async fill(value: string): Promise<void> { this.fills.push(value); }
  async press(value: string): Promise<void> { this.presses.push(value); }
  async selectOption(value: unknown): Promise<void> { this.selections.push(value); }
}

class FakePage {
  urlValue = 'about:blank';
  private closed = false;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(
    readonly runtime: FakeBrowserRuntime,
    private readonly onClose: (page: FakePage) => void,
  ) {}

  readonly keyboard = {
    type: async (text: string): Promise<void> => { this.runtime.keyboardEvents.push(`type:${text}`); },
    press: async (key: string): Promise<void> => { this.runtime.keyboardEvents.push(`press:${key}`); },
    insertText: async (text: string): Promise<void> => { this.runtime.keyboardEvents.push(`insert:${text}`); },
    down: async (key: string): Promise<void> => { this.runtime.keyboardEvents.push(`down:${key}`); },
    up: async (key: string): Promise<void> => { this.runtime.keyboardEvents.push(`up:${key}`); },
  };

  readonly mouse = {
    move: async (x: number, y: number): Promise<void> => { this.runtime.mouseEvents.push(`move:${x}:${y}`); },
    click: async (_x: number, _y: number, options: { button?: string; clickCount?: number }): Promise<void> => {
      this.runtime.mouseEvents.push(`click:${options.button ?? 'left'}:${options.clickCount ?? 1}`);
    },
    down: async (options: { button?: string }): Promise<void> => { this.runtime.mouseEvents.push(`down:${options.button ?? 'left'}`); },
    up: async (options: { button?: string }): Promise<void> => { this.runtime.mouseEvents.push(`up:${options.button ?? 'left'}`); },
    wheel: async (x: number, y: number): Promise<void> => { this.runtime.mouseEvents.push(`wheel:${x}:${y}`); },
  };

  isClosed(): boolean { return this.closed; }
  url(): string { return this.urlValue; }
  async title(): Promise<string> { return 'Fake page'; }
  async goto(url: string): Promise<{ headers(): Record<string, string> }> {
    this.urlValue = url;
    return { headers: () => ({ 'content-type': 'text/html; charset=utf-8' }) };
  }
  async route(): Promise<void> {}
  async waitForLoadState(): Promise<void> {}
  async waitForEvent(): Promise<void> {}
  async setViewportSize(): Promise<void> {}
  async bringToFront(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
  async screenshot(): Promise<Buffer> { return PNG; }
  async goBack(): Promise<unknown> { this.urlValue = 'https://example.test/back'; return {}; }
  async goForward(): Promise<unknown> { this.urlValue = 'https://example.test/forward'; return {}; }
  async reload(): Promise<unknown> { return {}; }
  mainFrame(): object { return this; }
  on(event: string, listener: EventListener): void { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); }
  once(event: string, listener: EventListener): void { this.on(event, listener); }
  off(event: string, listener: EventListener): void { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry !== listener)); }
  emit(event: string, ...values: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...values); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
    for (const listener of this.listeners.get('close') ?? []) listener();
  }
  async $(selector: string): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
    const index = Number(selector.split(' >> nth=')[1]);
    return this.runtime.locators[index] as unknown as ElementHandle<SVGElement | HTMLElement> ?? null;
  }
  locator(selector: string): Locator {
    if (selector === 'input[type=password]') return { count: async () => 0 } as unknown as Locator;
    if (selector === 'body') {
      return { ariaSnapshot: async () => this.runtime.aria } as unknown as Locator;
    }
    return {
      count: async () => this.runtime.locators.length,
      // Locators resolve the current node on every use, unlike element handles.
      nth: (index: number) => new Proxy({}, {
        get: (_target, property) => {
          const current = this.runtime.locators[index]!;
          const member = Reflect.get(current, property) as unknown;
          return typeof member === 'function' ? member.bind(current) : member;
        },
      }) as Locator,
    } as unknown as Locator;
  }
  async evaluate(_callback: unknown, argument?: { pointX?: number; pointY?: number; minimumMs?: number; maximumCharacters?: number; qubiclViewerMetrics?: boolean; qubiclScreenshotDimensions?: boolean; observed?: FakeLocator[]; retained?: Array<{ ref: string; node: FakeLocator }> }): Promise<unknown> {
    if (String(_callback).includes('document.readyState')) return { url: this.urlValue, title: 'Fake page', readyState: 'complete' };
    if (argument?.observed && argument.retained) {
      const byNode = new Map(argument.retained.map(({ ref, node }) => [node, ref]));
      return argument.observed.map((node) => byNode.get(node) ?? null);
    }
    if (argument && typeof argument.pointX === 'number') {
      return [{ tag: 'button', id: 'target', classes: ['primary'], role: 'button', name: 'Target', cursor: 'pointer', box: { x: 0, y: 0, width: 20, height: 20 } }];
    }
    if (argument && typeof argument.minimumMs === 'number') {
      this.runtime.settleEvaluations += 1;
      return undefined;
    }
    if (argument && typeof argument.maximumCharacters === 'number') {
      return {
        html: this.runtime.renderedHtml.slice(0, argument.maximumCharacters),
        sourceTruncated: this.runtime.renderedHtml.length > argument.maximumCharacters,
      };
    }
    if (argument?.qubiclViewerMetrics) {
      return {
        screenX: 4,
        screenY: 6,
        outerWidth: 1_460,
        outerHeight: 980,
        innerWidth: 1_440,
        innerHeight: 900,
        devicePixelRatio: 1,
      };
    }
    if (argument?.qubiclScreenshotDimensions) return { width: 1_440, height: 900 };
    return { x: 4, y: 8 };
  }
}

class FakeBrowserRuntime {
  readonly locators: FakeLocator[];
  readonly keyboardEvents: string[] = [];
  readonly mouseEvents: string[] = [];
  readonly newPageExistingPageCounts: number[] = [];
  settleEvaluations = 0;
  private pagesValue: FakePage[] = [];
  private readonly contextListeners = new Map<string, EventListener[]>();
  private readonly browserListeners = new Map<string, EventListener[]>();

  launchOptions?: Record<string, unknown>;

  constructor(
    locatorCount = 2,
    readonly aria = '- document "Fake page"',
    readonly renderedHtml = '<!doctype html><html><body><main>Rendered</main></body></html>',
    private readonly connectExisting = true,
  ) {
    this.locators = Array.from({ length: locatorCount }, (_, index) => new FakeLocator(index));
    this.pagesValue.push(this.makePage());
  }

  private makePage(): FakePage {
    return new FakePage(this, (page) => { this.pagesValue = this.pagesValue.filter((candidate) => candidate !== page); });
  }

  private readonly context = {
    pages: (): Page[] => this.pagesValue as unknown as Page[],
    newPage: async (): Promise<Page> => {
      this.newPageExistingPageCounts.push(this.pagesValue.length);
      const page = this.makePage();
      this.pagesValue.push(page);
      return page as unknown as Page;
    },
    setDefaultTimeout: (): void => {},
    browser: () => this.browser,
    on: (event: string, listener: EventListener): void => { this.contextListeners.set(event, [...this.contextListeners.get(event) ?? [], listener]); },
    close: async (): Promise<void> => {
      for (const page of [...this.pagesValue]) await page.close();
      for (const listener of this.contextListeners.get('close') ?? []) listener();
    },
  };

  private readonly browser = {
    version: () => '140.0.0.0',
    contexts: () => [this.context],
    newContext: async () => {
      let pages: FakePage[] = [];
      const context = {
        pages: (): Page[] => pages as unknown as Page[],
        newPage: async (): Promise<Page> => {
          const page = new FakePage(this, (closed) => { pages = pages.filter((candidate) => candidate !== closed); });
          pages.push(page);
          return page as unknown as Page;
        },
        close: async (): Promise<void> => {
          for (const page of [...pages]) await page.close();
        },
      };
      return context;
    },
    on: (event: string, listener: EventListener): void => { this.browserListeners.set(event, [...this.browserListeners.get(event) ?? [], listener]); },
    close: async (): Promise<void> => {
      for (const listener of this.browserListeners.get('disconnected') ?? []) listener();
    },
  };

  readonly browserType = {
    connectOverCDP: async () => {
      if (!this.connectExisting) throw new Error('no existing browser');
      return this.browser;
    },
    launchPersistentContext: async (_directory: string, options: Record<string, unknown>) => {
      this.launchOptions = options;
      return this.context;
    },
  } as unknown as BrowserType;
}

test('snapshot inspection overlaps protocol waits with at most sixteen candidates in flight', async (context) => {
  const fake = new FakeBrowserRuntime();
  fake.locators.splice(0, fake.locators.length, ...Array.from({ length: 80 }, (_, index) => new FakeLocator(index)));
  let active = 0;
  let peak = 0;
  for (const locator of fake.locators) context.mock.method(locator, 'isVisible', async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return true;
  });
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  context.after(() => manager.shutdown());
  const result = await manager.snapshot() as { refs: Array<{ ref: string }> };
  assert.equal(peak, 16);
  assert.equal(active, 0);
  assert.equal(result.refs.length, 80);
  assert.equal(result.refs[0]?.ref, 'g1e1');
  assert.equal(result.refs[79]?.ref, 'g1e80');
});


test('snapshot continuation reaches omitted controls through limits and hidden candidates', async () => {
  for (const [count, limit, hidden, expected] of [[300, 200, 0, 200], [2500, 200, 0, 200], [30, 10, 0, 10], [30, 10, 5, 15], [2500, 200, 2500, 2000]]) {
    const fake = new FakeBrowserRuntime(count!, '');
    // Short labels isolate count pagination from the independent byte budget.
    for (const [index, node] of fake.locators.entries()) {
      node.visible = index >= hidden!;
      node.evaluate = async (callback) => callback({ tagName: 'BUTTON', textContent: `Button ${index}`, getAttribute: () => null } as unknown as HTMLElement);
    }
    const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
    try {
      const first = await manager.snapshot(0, limit) as { scan: { nextCursor: number }; refs: Array<{ name: string }> };
      assert.equal(first.scan.nextCursor, expected);
      if (hidden! < count!) {
        const second = await manager.snapshot(first.scan.nextCursor, limit) as { refs: Array<{ name: string }> };
        assert.equal(second.refs[0]?.name, `Button ${expected}`);
      }
    } finally { await manager.shutdown(); }
  }
});

test('byte-limited snapshots continue at the first omitted control', async () => {
  const fake = new FakeBrowserRuntime(200, 'x'.repeat(80_000));
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  try {
    const first = await manager.snapshot() as { refs: unknown[]; scan: { nextCursor: number } };
    assert.ok(first.refs.length > 0 && first.refs.length < 200);
    assert.equal(first.scan.nextCursor, first.refs.length);
    const next = await manager.snapshot(first.scan.nextCursor) as { refs: Array<{ name: string }> };
    assert.ok(next.refs[0]?.name.startsWith(`Control ${first.refs.length} `));
  } finally { await manager.shutdown(); }
});

test('frame metadata shares the aggregate snapshot budget with text and refs', async () => {
  const fake = new FakeBrowserRuntime(1, 'x'.repeat(80_000));
  const connection = await fake.browserType.connectOverCDP('http://fake');
  const page = connection.contexts()[0]!.pages()[0]! as unknown as FakePage;
  Object.assign(page, { frames: () => Array.from({ length: 64 }, () => page) });
  page.urlValue = 'https://example.test/' + 'a'.repeat(2020);
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  try {
    const snapshot = await manager.snapshot() as { refs: unknown[] };
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 24_000);
    assert.equal(snapshot.refs.length, 1);
  } finally { await manager.shutdown(); }
});


test('JSON escaping and Unicode stay inside the snapshot response budget', async () => {
  const fake = new FakeBrowserRuntime(1, '\n"\\🦆'.repeat(10_000));
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  try {
    const snapshot = await manager.snapshot() as { refs: unknown[]; snapshot: string };
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 24_000);
    assert.equal(snapshot.refs.length, 1);
    assert.ok(!snapshot.snapshot.includes('�'));
  } finally { await manager.shutdown(); }
});

test('failed modifier setup releases keys and failed fill does not repeat input', async (context) => {
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  context.after(() => manager.shutdown());
  await manager.snapshot();
  const page = await (manager as unknown as { getPage(): Promise<Page> }).getPage();
  page.keyboard.down = async (key) => { fake.keyboardEvents.push(`down:${key}`); if (key === 'Alt') throw new Error('key failure'); };
  for (const action of [{ type: 'click' as const, x: 10, y: 10, keys: ['Control', 'Alt'] }, { type: 'keypress' as const, keys: ['Control', 'Alt', 'A'] }]) {
    fake.keyboardEvents.length = 0;
    await assert.rejects(manager.computer([action]), /key failure/);
    assert.ok(fake.keyboardEvents.includes('up:Control'));
    assert.ok(fake.keyboardEvents.includes('up:Alt'));
  }
  fake.locators[0]!.fill = async () => { throw new Error('fill uncertain'); };
  await assert.rejects(manager.type('g1e1', 'value', false, true), /fill uncertain/);
  assert.equal(fake.locators[0]!.clicks, 0);
});

test('tab reset reports close failures', async (context) => {
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  context.after(() => manager.shutdown());
  await manager.snapshot();
  const page = await (manager as unknown as { getPage(): Promise<Page> }).getPage();
  page.close = async () => { throw new Error('close failed'); };
  const reset = await manager.reset();
  assert.equal(reset.resetComplete, false);
  assert.equal(reset.failedToClose.length, 1);
});

test('pending dialogs are never automatically dismissed by history limits', async (context) => {
  const fake = new FakeBrowserRuntime();
  const manager = new BrowserManager(true, { browserType: fake.browserType });
  context.after(() => manager.shutdown());
  await manager.snapshot();
  const page = await (manager as unknown as { getPage(): Promise<{listeners: Map<string, Array<(dialog: unknown) => void>>}> }).getPage();
  let dismisses = 0;
  for (let index = 0; index < 33; index += 1) {
    for (const listener of page.listeners.get('dialog') ?? []) listener({type:()=> 'alert', message:()=> 'fixture', defaultValue:()=> '', dismiss:async()=> {dismisses += 1;}});
  }
  assert.equal((await manager.listDialogs()).dialogs.length,33);
  assert.equal(dismisses,0);
});
