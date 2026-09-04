import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserType, ElementHandle, Locator, Page } from 'playwright-core';
import { BrowserManager, browserViewportToDisplayPoint } from '@qubicl/control/browser';
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
  assert.deepEqual(await manager.navigate('https://example.test/start'), { url: 'https://example.test/start', title: 'Fake page' });
  assert.equal(manager.count(), 1);

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
  assert.deepEqual(semanticClick.result, { url: 'https://example.test/start', title: 'Fake page' });
  assert.deepEqual(semanticClick.pointerActions, [{ type: 'click', x: 74, y: 111, button: 1 }]);
  await manager.type('g1e1', 'typed', true, true);
  await manager.select('g1e2', 'Selected');
  await manager.press('Control+A', 'g1e1');
  await manager.scroll('down', 600);
  await manager.history('back');
  await manager.history('forward');
  await manager.history('reload');
  await manager.wait(0);
  assert.deepEqual(fake.locators[0]!.fills, ['', 'typed']);
  assert.deepEqual(fake.locators[0]!.presses, ['Enter', 'Control+A']);
  assert.deepEqual(fake.locators[1]!.selections, [{ label: 'Selected' }]);

  const screenshot = await manager.screenshot(false);
  assert.equal(screenshot.mimeType, 'image/png');
  assert.equal(Buffer.from(screenshot.data, 'base64').equals(PNG), true);
  assert.deepEqual(screenshot.viewport, { width: 1440, height: 900, deviceScaleFactor: 1 });

  for (let index = 0; index < 6; index += 1) await manager.newTab(`https://example.test/${index}`);
  const tabs = await manager.tabs();
  assert.equal(tabs.tabs.length, 5, 'old inactive tabs are discarded at the Terminal1 five-tab bound');
  await manager.useTab(0);
  await manager.closeTab(-1);
  assert.equal((await manager.tabs()).tabs.length, 4);
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
  assert.equal(original.clicks, 1);
  assert.deepEqual(original.fills, ['original only']);
  assert.deepEqual(original.presses, ['Enter']);
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

test('snapshot handles are released on truncation, refresh, navigation, and shutdown', async () => {
  const fake = new FakeBrowserRuntime(200, 'x'.repeat(80_000));
  fake.locators[0]!.visible = false;
  const manager = new BrowserManager(true, { browserType: fake.browserType, headless: true });
  try {
    const snapshot = await manager.snapshot() as { refs: Array<{ ref: string }> };
    assert.equal(fake.locators.filter((node) => node.disposals === 0).length, snapshot.refs.length);
    await manager.snapshot();
    assert.ok(fake.locators.every((node) => node.disposals >= 1));
    await manager.navigate('https://example.test/next');
    assert.ok(fake.locators.every((node) => node.disposals === 2));
    await assert.rejects(manager.click(snapshot.refs[0]!.ref, 'left'), { code: 'stale_browser_ref' });
    await manager.snapshot();
  } finally {
    await manager.shutdown();
  }
  assert.ok(fake.locators.every((node) => node.disposals === 3));
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
  assert.deepEqual(fake.launchOptions?.ignoreDefaultArgs, ['--disable-dev-shm-usage']);
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
  async evaluate<T>(callback: (element: HTMLElement) => T): Promise<T> {
    const name = this.index === 0 ? 'First control' : this.index === 1 ? 'Second control' : `Control ${this.index} ${'x'.repeat(240)}`;
    return callback({
      tagName: 'BUTTON', textContent: name, isConnected: this.connected,
      getAttribute: (attribute: string) => attribute === 'role' ? 'button' : null,
    } as unknown as HTMLElement);
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
  async setViewportSize(): Promise<void> {}
  async bringToFront(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
  async screenshot(): Promise<Buffer> { return PNG; }
  async goBack(): Promise<null> { this.urlValue = 'https://example.test/back'; return null; }
  async goForward(): Promise<null> { this.urlValue = 'https://example.test/forward'; return null; }
  async reload(): Promise<null> { return null; }
  mainFrame(): object { return this; }
  on(event: string, listener: EventListener): void { this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]); }
  once(event: string, listener: EventListener): void { this.on(event, listener); }
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
  async evaluate(_callback: unknown, argument?: { pointX?: number; pointY?: number; minimumMs?: number; maximumCharacters?: number; qubiclViewerMetrics?: boolean }): Promise<unknown> {
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
    on: (event: string, listener: EventListener): void => { this.contextListeners.set(event, [...this.contextListeners.get(event) ?? [], listener]); },
    close: async (): Promise<void> => {
      for (const page of [...this.pagesValue]) await page.close();
      for (const listener of this.contextListeners.get('close') ?? []) listener();
    },
  };

  private readonly browser = {
    contexts: () => [this.context],
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
