import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { lookup } from 'node:dns/promises';
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Dialog,
  Download,
  ElementHandle,
  Page,
} from 'playwright-core';
import { MODEL_TEXT_BUDGET_BYTES } from '@qubicl/core';
import { QubiclError } from './errors.js';
import { isGloballyRoutableIp } from './network-address.js';
import type { ViewerPointerAction, ViewerPointerUpdate } from './viewer-actions.js';

const DEFAULT_HOME = '/home/qubicl';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
const DEFAULT_MAX_AGENT_TABS = 24;
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_SCANNED_INTERACTIVE_ELEMENTS = 2_000;
const MAX_COMPUTER_ACTIONS = 20;
const MAX_COMPUTER_BATCH_MS = 30_000;
const MAX_DRAG_POINTS = 100;
const MAX_TEXT_LENGTH = 50_000;
const MAX_RENDERED_HTML_BYTES = 1_500_000;
const RENDER_NAVIGATION_TIMEOUT_MS = 23_000;
const RENDER_NETWORK_IDLE_TIMEOUT_MS = 3_000;
const RENDER_SETTLE_MINIMUM_MS = 1_500;
const RENDER_SETTLE_STABLE_MS = 750;
const RENDER_SETTLE_MAXIMUM_MS = 5_000;
const MAX_SCREENSHOT_PIXELS = 32_000_000;
const MAX_BROWSER_QUEUE_DEPTH = 32;
const MAX_BROWSER_DIAGNOSTICS = 200;
const MAX_UPLOAD_FILES = 16;
const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;

export const INTERACTIVE_BROWSER_IGNORED_DEFAULT_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--enable-unsafe-swiftshader',
  '--password-store=basic',
  '--unsafely-disable-devtools-self-xss-warnings',
  '--use-mock-keychain',
] as const;

export type BrowserMouseButton = 'left' | 'right' | 'middle';
export type BrowserComputerAction =
  | { type: 'screenshot' }
  | { type: 'click' | 'double_click' | 'move'; x: number; y: number; button?: BrowserMouseButton; keys?: string[] }
  | { type: 'drag'; path: { x: number; y: number }[]; button?: BrowserMouseButton; keys?: string[] }
  | { type: 'scroll'; x: number; y: number; scroll_x?: number; scroll_y?: number; keys?: string[] }
  | { type: 'keypress'; keys: string[] }
  | { type: 'type'; text: string }
  | { type: 'wait'; milliseconds?: number };

interface PageState {
  url: string;
  title: string;
}

interface TabState extends PageState {
  tabId: string;
  index: number;
  active: boolean;
}

interface BrowserImage extends PageState {
  data: string;
  mimeType: 'image/png';
  viewport: { width: number; height: number; deviceScaleFactor: 1 };
  geometryGeneration: number;
}

interface BrowserDownloadRecord {
  id: string;
  status: 'in-progress' | 'completed' | 'failed' | 'cancelled';
  suggestedFilename: string;
  path?: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface BrowserDialogRecord {
  id: string;
  type: string;
  message: string;
  defaultValue: string;
  openedAt: string;
}

export interface RenderedBrowserPage {
  finalUrl: string;
  title: string;
  contentType: string;
  html: string;
  sourceTruncated: boolean;
}

export interface BrowserViewerResult<T> {
  result: T;
  pointerActions: ViewerPointerAction[];
}

export interface BrowserWindowMetrics {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
}

export interface BrowserHealth {
  state: 'not_started' | 'attached' | 'managed';
  sandbox: 'required';
  profile: 'persistent';
  extensions: 'enabled';
  passwordStore: 'secret_service';
  publicExtraction: 'isolated_context';
  tabPolicy: { agentOpenLimit: number; automaticEviction: false };
  engineVersion?: string;
  recentDiagnosticCount: number;
  lastDiagnostic?: { at: string; type: 'console' | 'request-failed'; detail: string };
}

export interface BrowserManagerOptions {
  home?: string;
  endpoint?: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  browserType?: BrowserType;
  headless?: boolean;
  maxTabs?: number;
  now?: () => number;
  resolver?: WebResolver;
  publishViewerPointer?: (update: ViewerPointerUpdate) => Promise<void>;
}

export class BrowserManager {
  private readonly home: string;
  private readonly profileDirectory: string;
  private readonly downloadDirectory: string;
  private readonly endpoint: string;
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private browserTypePromise: Promise<BrowserType> | undefined;
  private readonly headless: boolean;
  private readonly maxTabs: number;
  private readonly now: () => number;
  private readonly resolver: WebResolver;
  private readonly publishViewerPointer: ((update: ViewerPointerUpdate) => Promise<void>) | undefined;
  private readonly pageLastActive = new Map<Page, number>();
  private readonly tabIds = new Map<Page, string>();
  private readonly trackedPages = new WeakSet<Page>();
  private contextPromise: Promise<BrowserContext> | undefined;
  private connectedBrowser: Browser | undefined;
  private activePage: Page | undefined;
  private references = new Map<string, ElementHandle<SVGElement | HTMLElement>>();
  private referenceGeneration = 0;
  private referenceEpoch = 0;
  private operationQueue = Promise.resolve<unknown>(undefined);
  private queuedOperations = 0;
  private launchState: BrowserHealth['state'] = 'not_started';
  private geometryGeneration = 1;
  private geometrySignature = '';
  private readonly downloads = new Map<string, BrowserDownloadRecord>();
  private readonly activeDownloads = new Map<string, Download>();
  private readonly dialogs = new Map<string, { record: BrowserDialogRecord; dialog: Dialog; page: Page }>();
  private readonly diagnostics: Array<{ at: string; type: 'console' | 'request-failed'; detail: string }> = [];

  constructor(private readonly enabled: boolean, options: BrowserManagerOptions = {}) {
    this.home = resolve(options.home ?? DEFAULT_HOME);
    this.profileDirectory = resolve(this.home, '.local/share/qubicl/browser-profile');
    this.downloadDirectory = resolve(this.home, 'Downloads');
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.executable = options.executable ?? '/usr/bin/chromium';
    this.environment = options.environment ?? process.env;
    if (options.browserType) this.browserTypePromise = Promise.resolve(options.browserType);
    this.headless = options.headless ?? false;
    this.maxTabs = options.maxTabs ?? DEFAULT_MAX_AGENT_TABS;
    if (!Number.isInteger(this.maxTabs) || this.maxTabs < 1 || this.maxTabs > 128) {
      throw new Error('maxTabs must be an integer from 1 to 128.');
    }
    this.now = options.now ?? Date.now;
    this.resolver = options.resolver ?? lookup as WebResolver;
    this.publishViewerPointer = options.publishViewerPointer;
  }

  count(): number {
    return this.contextPromise ? 1 : 0;
  }

  async health(): Promise<BrowserHealth> {
    const context = await this.contextPromise?.catch(() => undefined);
    const lastDiagnostic = this.diagnostics.at(-1);
    const engineVersion = context?.browser()?.version?.();
    return {
      state: this.launchState,
      sandbox: 'required',
      profile: 'persistent',
      extensions: 'enabled',
      passwordStore: 'secret_service',
      publicExtraction: 'isolated_context',
      tabPolicy: { agentOpenLimit: this.maxTabs, automaticEviction: false },
      ...(engineVersion ? { engineVersion } : {}),
      recentDiagnosticCount: this.diagnostics.length,
      ...(lastDiagnostic ? { lastDiagnostic: { ...lastDiagnostic } } : {}),
    };
  }

  listDownloads(): Promise<{ downloads: BrowserDownloadRecord[]; directory: string }> {
    return this.enqueue(async () => ({ downloads: [...this.downloads.values()].toReversed(), directory: this.downloadDirectory }));
  }

  cancelDownload(id: string): Promise<{ id: string; status: BrowserDownloadRecord['status'] }> {
    return this.enqueue(async () => {
      const record = this.downloads.get(id);
      if (!record) throw new QubiclError('browser_download_not_found', `Browser download ${id} was not found.`, 404);
      const download = this.activeDownloads.get(id);
      if (download) await download.cancel().catch(() => undefined);
      if (record.status === 'in-progress') {
        record.status = 'cancelled';
        record.completedAt = new Date().toISOString();
      }
      return { id, status: record.status };
    });
  }

  upload(ref: string, paths: string[]): Promise<PageState & { uploaded: string[] }> {
    return this.enqueue(async () => {
      if (paths.length < 1 || paths.length > MAX_UPLOAD_FILES) throw new QubiclError('browser_upload_invalid', `Choose 1 through ${MAX_UPLOAD_FILES} files.`, 400);
      const selected: string[] = [];
      for (const value of paths) {
        const named = resolve(this.home, value);
        const canonical = await realpath(named).catch(() => undefined);
        if (!canonical || !withinHome(this.home, canonical)) throw new QubiclError('browser_upload_outside_home', 'Browser uploads must be regular files inside the durable computer home.', 403);
        const info = await lstat(canonical);
        if (!info.isFile() || info.size > MAX_UPLOAD_FILE_BYTES) throw new QubiclError('browser_upload_invalid', `Upload files must be regular files no larger than ${MAX_UPLOAD_FILE_BYTES} bytes.`, 400);
        selected.push(canonical);
      }
      const page = await this.getPage();
      const locator = await this.referencedElement(ref);
      await locator.setInputFiles(selected);
      return { ...await pageState(page), uploaded: selected.map((path) => relative(this.home, path)) };
    });
  }

  listDialogs(): Promise<{ dialogs: BrowserDialogRecord[] }> {
    return this.enqueue(async () => ({ dialogs: [...this.dialogs.values()].map(({ record }) => ({ ...record })) }));
  }

  respondDialog(id: string, action: 'accept' | 'dismiss', promptText?: string): Promise<{ id: string; action: 'accepted' | 'dismissed' }> {
    return this.enqueue(async () => {
      const pending = this.dialogs.get(id);
      if (!pending) throw new QubiclError('browser_dialog_not_found', `Browser dialog ${id} is no longer pending.`, 404);
      this.dialogs.delete(id);
      if (action === 'accept') await pending.dialog.accept(promptText);
      else await pending.dialog.dismiss();
      return { id, action: action === 'accept' ? 'accepted' : 'dismissed' };
    });
  }

  permissions(origin: string, permissions: string[], clear: boolean): Promise<{ origin: string; permissions: string[]; cleared: boolean }> {
    return this.enqueue(async () => {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
        throw new QubiclError('browser_permission_invalid', 'Browser permission changes require an exact HTTP or HTTPS origin.', 400);
      }
      const allowed = new Set(['geolocation', 'notifications', 'clipboard-read', 'clipboard-write', 'camera', 'microphone']);
      if (permissions.some((permission) => !allowed.has(permission))) throw new QubiclError('browser_permission_invalid', 'Select a supported browser permission.', 400);
      const context = await this.getContext();
      if (clear) await context.clearPermissions();
      if (permissions.length) await context.grantPermissions(permissions, { origin });
      return { origin, permissions, cleared: clear };
    });
  }

  browserDiagnostics(): Promise<{ events: Array<{ at: string; type: 'console' | 'request-failed'; detail: string }> }> {
    return this.enqueue(async () => ({ events: this.diagnostics.slice(-MAX_BROWSER_DIAGNOSTICS) }));
  }

  setViewport(width: number, height: number): Promise<PageState & { viewport: { width: number; height: number; deviceScaleFactor: 1 }; geometryGeneration: number }> {
    return this.enqueue(async () => {
      const page = await this.getPage();
      await page.setViewportSize({ width, height });
      this.geometrySignature = '';
      const geometryGeneration = await this.updateGeometry(page);
      return { ...await pageState(page), viewport: { width, height, deviceScaleFactor: 1 }, geometryGeneration };
    });
  }

  navigate(url: string): Promise<PageState> {
    return this.enqueue(async () => {
      const page = await this.getPage();
      await page.goto(safeHttpUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      this.clearReferences();
      return pageState(page);
    });
  }

  renderForExtraction(url: string): Promise<RenderedBrowserPage> {
    return this.enqueue(async () => {
      if (!this.enabled) throw new QubiclError('capability_unsupported', 'Browser-rendered extraction requires a browser-capable computer preset.', 400);
      const initialUrl = await validatePublicWebUrl(url, this.resolver);
      const interactiveContext = await this.getContext();
      const browser = interactiveContext.browser();
      if (!browser) throw new QubiclError('browser_operation_failed', 'The browser cannot create an isolated extraction session.', 502);
      const context = await browser.newContext({
        viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
        deviceScaleFactor: 1,
        acceptDownloads: false,
        locale: 'en-US',
      });
      const page = await context.newPage();
      try {
        await page.route('**/*', async (route) => {
          const request = route.request();
          if (['image', 'media', 'font'].includes(request.resourceType())) return route.abort('blockedbyclient');
          try {
            await validatePublicWebUrl(request.url(), this.resolver);
            await route.continue();
          } catch {
            await route.abort('blockedbyclient');
          }
        });
        const response = await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: RENDER_NAVIGATION_TIMEOUT_MS });
        if (!response) throw new QubiclError('web_upstream_error', 'The browser received no main-document response.', 502);
        const finalUrl = await validatePublicWebUrl(page.url(), this.resolver);
        await page.waitForLoadState('networkidle', { timeout: RENDER_NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);
        await waitForRenderedContent(page);
        const rendered = await page.evaluate(({ maximumCharacters }) => {
          const clone = document.documentElement?.cloneNode(true) as HTMLElement | undefined;
          if (!clone) return { html: '', sourceTruncated: false };
          for (const node of clone.querySelectorAll('script')) {
            if ((node.getAttribute('type') ?? '').trim().toLowerCase() !== 'application/ld+json') node.remove();
          }
          for (const node of clone.querySelectorAll('style,noscript,template,svg,canvas,iframe,object,embed')) node.remove();
          const serialized = `<!doctype html>${clone.outerHTML}`;
          return { html: serialized.slice(0, maximumCharacters), sourceTruncated: serialized.length > maximumCharacters };
        }, { maximumCharacters: MAX_RENDERED_HTML_BYTES });
        const bounded = truncateUtf8Text(rendered.html, MAX_RENDERED_HTML_BYTES);
        return {
          finalUrl,
          title: (await page.title().catch(() => '')).slice(0, 512),
          contentType: response.headers()['content-type']?.split(';')[0] ?? 'text/html',
          html: bounded.text,
          sourceTruncated: rendered.sourceTruncated || bounded.truncated,
        };
      } finally {
        await context.close().catch(() => undefined);
      }
    });
  }

  snapshot(cursor = 0, limit = MAX_INTERACTIVE_ELEMENTS, frameIndex = 0): Promise<Record<string, unknown>> {
    return this.enqueue(async () => {
      const page = await this.getPage();
      const frames = browserFrames(page);
      const frame = frames[frameIndex];
      if (!frame) throw new QubiclError('browser_frame_not_found', `Browser frame index ${frameIndex} was not found. Refresh browser_snapshot and retry.`, 404);
      const selector = [
        'a[href]',
        'button',
        'input:not([type=hidden])',
        'textarea',
        'select',
        '[contenteditable=true]',
        '[role=button]',
        '[role=link]',
        '[role=checkbox]',
        '[role=radio]',
        '[role=tab]',
        '[role=menuitem]',
        '[role=option]',
      ].join(',');
      this.clearReferences();
      const epoch = this.referenceEpoch;
      const candidates = frame.locator(selector);
      const totalCandidates = await candidates.count();
      const count = Math.min(Math.max(0, totalCandidates - cursor), MAX_SCANNED_INTERACTIVE_ELEMENTS);
      const generation = ++this.referenceGeneration;
      const handles = new Set<ElementHandle<SVGElement | HTMLElement>>();
      try {
        const candidatesWithDetails: Array<{ locator: ElementHandle<SVGElement | HTMLElement>; details: { tag: string; role: string; name: string; type: string; disabled: boolean } }> = [];
        // Bound concurrent protocol requests while preserving DOM candidate order.
        for (let start = 0; start < count; start += 16) {
          const batch = await Promise.all(Array.from({ length: Math.min(16, count - start) }, async (_, offset) => {
            const index = cursor + start + offset;
            // A model ref names this exact node, not a selector that can resolve to
            // a different node after the page changes. Query without waiting for a
            // vanished positional candidate to reappear.
            const locator = await frame.$(`${selector} >> nth=${index}`).catch(() => null);
            if (!locator) return undefined;
            handles.add(locator);
            if (!await locator.isVisible().catch(() => false)) return undefined;
            const details = await locator.evaluate((element) => {
              const clean = (value: string | null | undefined): string => (value ?? '').trim().replace(/\s+/g, ' ');
              const text = clean(element.textContent);
              const input = element as HTMLInputElement;
              const labelledBy = clean(element.getAttribute('aria-labelledby'))
                .split(' ')
                .filter(Boolean)
                .map((id) => clean(element.ownerDocument?.getElementById(id)?.textContent))
                .filter(Boolean)
                .join(' ');
              const labels = [...(input.labels ?? [])].map((label) => clean(label.textContent)).filter(Boolean).join(' ');
              const name = [
                clean(element.getAttribute('aria-label')),
                labelledBy,
                labels,
                clean(element.getAttribute('title')),
                clean(element.getAttribute('placeholder')),
                text,
                clean(input.value),
              ].find(Boolean) ?? '';
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute('role') ?? '',
                name,
                type: element.getAttribute('type') ?? '',
                disabled: Boolean(input.disabled) || element.getAttribute('aria-disabled') === 'true',
              };
            }).catch(() => undefined);
            return details ? { locator, details } : undefined;
          }));
          for (const candidate of batch) if (candidate) candidatesWithDetails.push(candidate);
        }
        const aria = await frame.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
        const scroll = await page.evaluate(() => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) }))
          .catch(() => ({ x: 0, y: 0 }));
        const state = await pageState(page);
        const viewportSize = browserViewportSize(page);
        const boundedSnapshot = truncateUtf8Text(aria, Math.floor(MODEL_TEXT_BUDGET_BYTES / 2));
        const base = {
          url: truncateUtf8Text(state.url, 2048).text,
          title: truncateUtf8Text(state.title, 512).text,
          viewport: { ...viewportSize, deviceScaleFactor: 1 },
          geometryGeneration: await this.updateGeometry(page),
          scroll,
          generation,
          frame: { index: frameIndex, url: truncateUtf8Text(frame.url(), 2048).text },
          frames: frames.slice(0, 64).map((item, index) => ({ index, url: truncateUtf8Text(item.url(), 2048).text, main: item === page.mainFrame() })),
          snapshot: boundedSnapshot.text,
          scan: {
            totalCandidates,
            cursor,
            scannedCandidates: count,
            resultLimit: limit,
            scanLimitReached: totalCandidates > cursor + count,
            nextCursor: totalCandidates > cursor + count ? cursor + count : null,
          },
        };
        const references = new Map<string, ElementHandle<SVGElement | HTMLElement>>();
        const refs: Record<string, unknown>[] = [];
        for (const candidate of candidatesWithDetails.slice(0, limit)) {
          const ref = `g${generation}e${refs.length + 1}`;
          const record = {
            ref,
            role: candidate.details.role || candidate.details.tag,
            name: candidate.details.name.slice(0, 160),
            ...(candidate.details.type ? { type: candidate.details.type } : {}),
            ...(candidate.details.disabled ? { disabled: true } : {}),
          };
          const prospective = {
            ...base,
            refs: [...refs, record],
            truncated: { snapshot: boundedSnapshot.truncated, refs: false },
          };
          if (Buffer.byteLength(JSON.stringify(prospective)) > MODEL_TEXT_BUDGET_BYTES) break;
          refs.push(record);
          references.set(ref, candidate.locator);
        }
        if (epoch !== this.referenceEpoch) {
          throw new QubiclError('stale_browser_ref', 'The browser changed during the snapshot; call browser_snapshot again.', 409);
        }
        this.references = references;
        for (const handle of references.values()) handles.delete(handle);
        return {
          ...base,
          refs,
          truncated: {
            snapshot: boundedSnapshot.truncated,
            refs: refs.length < candidatesWithDetails.length || totalCandidates > cursor + count,
          },
        };
      } finally {
        await Promise.all([...handles].map((handle) => handle.dispose().catch(() => undefined)));
      }
    });
  }

  screenshot(fullPage: boolean): Promise<BrowserImage & { fullPage: boolean }> {
    return this.enqueue(async () => {
      const page = await this.getPage();
      await assertScreenshotBudget(page, fullPage);
      const image = await page.screenshot({ type: 'png', fullPage, animations: 'disabled', timeout: 30_000 });
      return { ...await pageState(page), ...await this.imageResult(page, image), fullPage };
    });
  }

  async click(ref: string, button: 'left' | 'right'): Promise<PageState> {
    return (await this.clickWithViewerPointer(ref, button)).result;
  }

  clickWithViewerPointer(ref: string, button: 'left' | 'right', generation?: number): Promise<BrowserViewerResult<PageState>> {
    return this.enqueue(async () => {
      const page = await this.getPage();
      const locator = await this.referencedElement(ref);
      // Playwright clicks scroll refs into view. Do that explicitly before
      // sampling the box so the viewer receipt describes the actual target.
      await locator.scrollIntoViewIfNeeded({ timeout: 15_000 });
      const box = await locator.boundingBox().catch(() => null);
      const pointer = box
        ? await browserViewerPointer(page, {
            type: button === 'right' ? 'right_click' : 'click',
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
            button: browserButtonNumber(button),
          })
        : undefined;
      const publication = pointer ? await this.beginViewerPointer(pointer, generation) : undefined;
      try {
        await locator.click({ button, timeout: 15_000 });
        if (publication) await this.finishViewerPointer(publication, generation!, 'confirm');
      } catch (error) {
        if (publication) await this.finishViewerPointer(publication, generation!, 'cancel');
        throw error;
      }
      await this.enforceTabLimit(await this.getContext(), this.activePage);
      return { result: await pageState(page), pointerActions: pointer && !publication ? [pointer] : [] };
    });
  }

  type(ref: string, text: string, submit: boolean, clear: boolean): Promise<PageState> {
    return this.act(async (page) => {
      const locator = await this.referencedElement(ref);
      if (clear) {
        await locator.fill(text).catch(async () => {
          await locator.click();
          await page.keyboard.press('ControlOrMeta+A');
          await page.keyboard.type(text);
        });
      } else {
        await locator.click();
        await locator.press('End').catch(() => undefined);
        await page.keyboard.type(text);
      }
      if (submit) await locator.press('Enter');
      return page;
    });
  }

  select(ref: string, value: string): Promise<PageState> {
    return this.act(async (page) => {
      const locator = await this.referencedElement(ref);
      await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
      return page;
    });
  }

  press(key: string, ref?: string): Promise<PageState> {
    return this.act(async (page) => {
      if (ref) await (await this.referencedElement(ref)).press(key);
      else await page.keyboard.press(key);
      return page;
    });
  }

  scroll(direction: 'up' | 'down', amount: number): Promise<PageState> {
    return this.act(async (page) => {
      await page.mouse.wheel(0, direction === 'up' ? -amount : amount);
      return page;
    });
  }

  history(action: 'back' | 'forward' | 'reload'): Promise<PageState> {
    return this.act(async (page) => {
      if (action === 'back') {
        const response = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!response) throw new QubiclError('browser_no_history', 'This tab has no earlier history entry.', 409);
      }
      if (action === 'forward') {
        const response = await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!response) throw new QubiclError('browser_no_history', 'This tab has no later history entry.', 409);
      }
      if (action === 'reload') {
        const response = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (!response) throw new QubiclError('browser_navigation_failed', 'The reload completed without a main-document response.', 502);
      }
      this.clearReferences();
      return page;
    });
  }

  wait(milliseconds: number): Promise<PageState> {
    return this.act(async (page) => {
      await page.waitForTimeout(milliseconds);
      return page;
    }, 0);
  }

  tabs(): Promise<{ tabs: TabState[]; limit: number; overLimit: boolean }> {
    return this.enqueue(async () => {
      const tabs = await this.listTabs();
      return { tabs, limit: this.maxTabs, overLimit: tabs.length > this.maxTabs };
    });
  }

  useTab(target: number | string): Promise<PageState> {
    return this.enqueue(async () => {
      const pages = (await this.getContext()).pages();
      const page = this.requireTab(pages, target);
      await page.bringToFront();
      this.setActivePage(page);
      return pageState(page);
    });
  }

  newTab(url?: string): Promise<PageState> {
    return this.enqueue(async () => {
      const context = await this.getContext();
      if (context.pages().length >= this.maxTabs) {
        throw new QubiclError('browser_tab_limit', `The browser already has ${context.pages().length} tabs, which reaches this computer's configured limit of ${this.maxTabs}. Close a tab or raise browser.maxTabs before an agent opens another.`, 429);
      }
      const page = await context.newPage();
      await this.preparePage(context, page);
      this.setActivePage(page);
      if (url) await page.goto(safeHttpUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.enforceTabLimit(context, page);
      return pageState(page);
    });
  }

  closeTab(target: number | string): Promise<{ tabs: TabState[] }> {
    return this.enqueue(async () => {
      const context = await this.getContext();
      const pages = context.pages();
      const resolvedTarget = target === -1 ? Math.max(0, pages.indexOf(this.activePage ?? pages.at(-1)!)) : target;
      const page = this.requireTab(pages, resolvedTarget);
      const wasActive = page === this.activePage;
      await page.close();
      this.pageLastActive.delete(page);
      if (!context.pages().length) this.setActivePage(await context.newPage());
      else if (wasActive) this.setActivePage(context.pages().at(-1));
      this.clearReferences();
      return { tabs: await this.listTabs() };
    });
  }

  reset(): Promise<PageState> {
    return this.enqueue(async () => {
      const context = await this.getContext();
      // Keep one target alive while resetting. Chromium may tear down or reject
      // Target.createTarget after its final page is closed, especially over CDP.
      const previousPages = context.pages();
      const page = await context.newPage();
      await this.preparePage(context, page);
      this.setActivePage(page);
      for (const previous of previousPages) await previous.close().catch(() => undefined);
      return pageState(page);
    });
  }

  clickAt(x: number, y: number, button: BrowserMouseButton, clickCount = 1, geometryGeneration?: number): Promise<BrowserImage & { actionCount: 1 }> {
    return this.computerWithViewerPointers([{ type: clickCount === 2 ? 'double_click' : 'click', x, y, button }], undefined, geometryGeneration).then(({ result }) => result as BrowserImage & { actionCount: 1 });
  }

  hoverAt(x: number, y: number, geometryGeneration?: number): Promise<BrowserImage & { actionCount: 1 }> {
    return this.computerWithViewerPointers([{ type: 'move', x, y }], undefined, geometryGeneration).then(({ result }) => result as BrowserImage & { actionCount: 1 });
  }

  drag(startX: number, startY: number, endX: number, endY: number): Promise<BrowserImage & { actionCount: 1 }> {
    return this.computer([{ type: 'drag', path: [{ x: startX, y: startY }, { x: endX, y: endY }] }]) as Promise<BrowserImage & { actionCount: 1 }>;
  }

  scrollAt(x: number, y: number, scrollX: number, scrollY: number): Promise<BrowserImage & { actionCount: 1 }> {
    return this.computer([{ type: 'scroll', x, y, scroll_x: scrollX, scroll_y: scrollY }]) as Promise<BrowserImage & { actionCount: 1 }>;
  }

  typeFocused(text: string): Promise<BrowserImage & { actionCount: 1 }> {
    return this.computer([{ type: 'type', text }]) as Promise<BrowserImage & { actionCount: 1 }>;
  }

  inspectAt(x: number, y: number, geometryGeneration?: number): Promise<Record<string, unknown>> {
    return this.enqueue(async () => {
      const page = await this.getPage();
      await this.assertGeometry(page, geometryGeneration);
      const elements = await page.evaluate(({ pointX, pointY }) => document.elementsFromPoint(pointX, pointY).slice(0, 12).map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 240);
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          classes: Array.from(element.classList).slice(0, 12),
          role: element.getAttribute('role') ?? '',
          name: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? text,
          cursor: style.cursor,
          box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      }), { pointX: x, pointY: y });
      const size = browserViewportSize(page);
      return { ...await pageState(page), viewport: { ...size, deviceScaleFactor: 1 }, geometryGeneration: await this.updateGeometry(page), point: { x, y }, elements };
    });
  }

  async computer(actions: BrowserComputerAction[]): Promise<BrowserImage & { actionCount: number }> {
    return (await this.computerWithViewerPointers(actions)).result;
  }

  computerWithViewerPointers(actions: BrowserComputerAction[], generation?: number, geometryGeneration?: number): Promise<BrowserViewerResult<BrowserImage & { actionCount: number }>> {
    return this.enqueue(async () => {
      if (actions.length < 1 || actions.length > MAX_COMPUTER_ACTIONS) {
        throw new QubiclError('browser_actions_invalid', `Browser computer actions must contain 1 through ${MAX_COMPUTER_ACTIONS} entries.`, 400);
      }
      const requestedWaitMs = actions.reduce((total, action) => total + (action.type === 'wait' ? action.milliseconds ?? 2_000 : 0), 0);
      const estimatedDurationMs = requestedWaitMs + actions.length * 400;
      if (estimatedDurationMs > MAX_COMPUTER_BATCH_MS) {
        throw new QubiclError('browser_batch_too_long', `Browser action batches are limited to ${MAX_COMPUTER_BATCH_MS} milliseconds. Split this batch into smaller calls.`, 400);
      }
      let page = await this.getPage();
      await this.assertGeometry(page, geometryGeneration);
      const pointerActions: ViewerPointerAction[] = [];
      for (const action of actions) {
        const pointer = await browserViewerPointerForAction(page, action);
        const publication = pointer ? await this.beginViewerPointer(pointer, generation) : undefined;
        try {
          await runComputerAction(page, action);
          if (publication) await this.finishViewerPointer(publication, generation!, 'confirm');
        } catch (error) {
          if (publication) await this.finishViewerPointer(publication, generation!, 'cancel');
          throw error;
        }
        if (pointer && !publication) pointerActions.push(pointer);
        await page.waitForTimeout(100);
        page = await this.getPage();
      }
      await page.waitForTimeout(300);
      await this.enforceTabLimit(await this.getContext(), this.activePage);
      page = await this.getPage();
      const image = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 30_000 });
      return {
        result: { ...await pageState(page), ...await this.imageResult(page, image), actionCount: actions.length },
        pointerActions,
      };
    });
  }

  async shutdown(): Promise<void> {
    const context = this.contextPromise ? await this.contextPromise.catch(() => undefined) : undefined;
    this.contextPromise = undefined;
    this.clearReferences();
    this.activePage = undefined;
    this.pageLastActive.clear();
    this.tabIds.clear();
    if (context) await context.close().catch(() => undefined);
    if (this.connectedBrowser) await this.connectedBrowser.close().catch(() => undefined);
    this.connectedBrowser = undefined;
  }

  private async beginViewerPointer(action: ViewerPointerAction, generation: number | undefined): Promise<string | undefined> {
    if (!this.publishViewerPointer || !Number.isSafeInteger(generation) || generation! < 1) return undefined;
    const actionId = randomBytes(18).toString('base64url');
    try {
      await this.publishViewerPointer({ phase: 'intent', actionId, generation: generation!, action });
      return actionId;
    } catch {
      // Viewer telemetry is best-effort and must not make input fail.
      return undefined;
    }
  }

  private async finishViewerPointer(actionId: string, generation: number, phase: 'confirm' | 'cancel'): Promise<void> {
    try {
      await this.publishViewerPointer?.({ phase, actionId, generation });
    } catch {
      // The session is still cleared at every lease/control boundary.
    }
  }

  private act(operation: (page: Page) => Promise<Page>, settleMilliseconds = 0): Promise<PageState> {
    return this.enqueue(async () => {
      const page = await operation(await this.getPage());
      if (settleMilliseconds) await page.waitForTimeout(settleMilliseconds);
      await this.enforceTabLimit(await this.getContext(), this.activePage);
      return pageState(page);
    });
  }

  private clearReferences(): void {
    this.referenceEpoch += 1;
    for (const handle of this.references.values()) void handle.dispose().catch(() => undefined);
    this.references.clear();
  }

  private async referencedElement(ref: string): Promise<ElementHandle<SVGElement | HTMLElement>> {
    const handle = this.references.get(ref);
    if (!handle || !await handle.evaluate((element) => element.isConnected).catch(() => false)) {
      this.references.delete(ref);
      if (handle) await handle.dispose().catch(() => undefined);
      throw new QubiclError('stale_browser_ref', 'Unknown or stale browser element ref; call browser_snapshot again.', 409);
    }
    return handle;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queuedOperations >= MAX_BROWSER_QUEUE_DEPTH) {
      return Promise.reject(new QubiclError('browser_queue_full', `The browser already has ${MAX_BROWSER_QUEUE_DEPTH} queued operations. Wait for current work or take control to cancel it.`, 429));
    }
    this.queuedOperations += 1;
    const execute = async (): Promise<T> => {
      if (!this.enabled) throw new QubiclError('browser_unsupported', 'This computer does not provide the browser capability.', 404);
      try {
        return await operation();
      } catch (error) {
        if (error instanceof QubiclError) throw error;
        throw new QubiclError('browser_operation_failed', error instanceof Error ? error.message : String(error), 502);
      }
    };
    const next = this.operationQueue.then(execute, execute).finally(() => { this.queuedOperations -= 1; });
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private async updateGeometry(page: Page): Promise<number> {
    const size = browserViewportSize(page);
    const ratio = await page.evaluate(() => window.devicePixelRatio).catch(() => 1);
    const signature = `${size.width}x${size.height}@${ratio}`;
    if (this.geometrySignature && this.geometrySignature !== signature) this.geometryGeneration += 1;
    this.geometrySignature = signature;
    return this.geometryGeneration;
  }

  private async assertGeometry(page: Page, expected: number | undefined): Promise<void> {
    const current = await this.updateGeometry(page);
    if (expected !== undefined && expected !== current) {
      throw new QubiclError('stale_browser_geometry', `Browser geometry generation ${expected} is stale; capture a new browser screenshot (current generation ${current}).`, 409);
    }
  }

  private async imageResult(page: Page, image: Buffer): Promise<Pick<BrowserImage, 'data' | 'mimeType' | 'viewport' | 'geometryGeneration'>> {
    if (image.length > 20_000_000) throw new QubiclError('browser_image_too_large', 'Browser screenshot exceeds the 20 MB result limit.', 413);
    const size = browserViewportSize(page);
    return {
      data: image.toString('base64'),
      mimeType: 'image/png',
      viewport: { ...size, deviceScaleFactor: 1 },
      geometryGeneration: await this.updateGeometry(page),
    };
  }

  private async getContext(): Promise<BrowserContext> {
    this.contextPromise ??= this.initializeContext().catch((error) => {
      this.contextPromise = undefined;
      throw error;
    });
    return this.contextPromise;
  }

  private async initializeContext(): Promise<BrowserContext> {
    const browserType = await this.getBrowserType();
    let context: BrowserContext | undefined;
    if (process.env.QUBICL_STARTUP_PROFILE === 'browser') {
      for (let attempt = 0; attempt < 20 && !context; attempt += 1) {
        context = await this.connectExisting(browserType).catch(() => undefined);
        if (!context) await delay(100);
      }
    } else {
      context = await this.connectExisting(browserType).catch(() => undefined);
    }
    if (!context) {
      await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
      await mkdir(this.downloadDirectory, { recursive: true, mode: 0o700 });
      await removeProfileLocks(this.profileDirectory);
      context = await browserType.launchPersistentContext(this.profileDirectory, {
        headless: this.headless,
        executablePath: this.executable,
        viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
        deviceScaleFactor: 1,
        acceptDownloads: true,
        downloadsPath: this.downloadDirectory,
        chromiumSandbox: true,
        ignoreDefaultArgs: [...INTERACTIVE_BROWSER_IGNORED_DEFAULT_ARGS, '--disable-dev-shm-usage'],
        locale: 'en-US',
        env: desktopEnvironment(this.home, this.environment),
        ...(browserProxy(this.environment.QUBICL_PROXY_URL) ? { proxy: browserProxy(this.environment.QUBICL_PROXY_URL)! } : {}),
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--window-position=0,0',
          `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
          '--password-store=gnome-libsecret',
        ],
      });
      this.launchState = 'managed';
    }
    context.setDefaultTimeout(15_000);
    context.on('close', () => this.clearContext(context));
    context.on('page', (page) => {
      void this.preparePage(context, page).then(() => {
        this.setActivePage(page);
        return this.enqueue(async () => this.enforceTabLimit(context, page));
      }).catch((error) => console.error(`Qubicl browser page setup failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    for (const page of context.pages()) await this.preparePage(context, page);
    const initial = context.pages().at(-1) ?? await context.newPage();
    await this.preparePage(context, initial);
    this.setActivePage(initial);
    await this.enforceTabLimit(context, initial);
    return context;
  }

  private async getBrowserType(): Promise<BrowserType> {
    this.browserTypePromise ??= import('playwright-core').then(({ chromium }) => chromium);
    return this.browserTypePromise;
  }

  private async connectExisting(browserType: BrowserType): Promise<BrowserContext | undefined> {
    const browser = await browserType.connectOverCDP(this.endpoint, { timeout: 1000 });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      return undefined;
    }
    this.connectedBrowser = browser;
    this.launchState = 'attached';
    browser.on('disconnected', () => {
      if (this.connectedBrowser === browser) this.connectedBrowser = undefined;
    });
    return context;
  }

  private async preparePage(context: BrowserContext, page: Page): Promise<void> {
    if (this.trackedPages.has(page)) return;
    this.trackedPages.add(page);
    this.tabId(page);
    this.touchPage(page);
    await page.setViewportSize({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }).catch(() => undefined);
    page.on('download', (download) => { void this.retainDownload(download); });
    page.on('dialog', (dialog) => {
      if (this.dialogs.size >= 32) {
        void dialog.dismiss().catch(() => undefined);
        return;
      }
      const id = randomBytes(12).toString('base64url');
      this.dialogs.set(id, {
        record: {
          id,
          type: dialog.type(),
          message: dialog.message().slice(0, 2_000),
          defaultValue: dialog.defaultValue().slice(0, 2_000),
          openedAt: new Date().toISOString(),
        },
        dialog,
        page,
      });
    });
    page.on('console', (message) => this.addDiagnostic('console', `${message.type()}: ${message.text()}`));
    page.on('requestfailed', (request) => this.addDiagnostic('request-failed', `${request.method()} ${diagnosticUrl(request.url())}: ${request.failure()?.errorText ?? 'failed'}`));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && page === this.activePage) this.clearReferences();
    });
    page.once('close', () => {
      this.pageLastActive.delete(page);
      this.tabIds.delete(page);
      for (const [id, pending] of this.dialogs) if (pending.page === page) this.dialogs.delete(id);
      if (this.activePage !== page) return;
      this.activePage = undefined;
      const replacement = context.pages().findLast((candidate) => !candidate.isClosed());
      if (replacement) this.setActivePage(replacement);
    });
  }

  private addDiagnostic(type: 'console' | 'request-failed', detail: string): void {
    this.diagnostics.push({ at: new Date().toISOString(), type, detail: detail.replace(/[\r\n]+/gu, ' ').slice(0, 1_000) });
    if (this.diagnostics.length > MAX_BROWSER_DIAGNOSTICS) this.diagnostics.splice(0, this.diagnostics.length - MAX_BROWSER_DIAGNOSTICS);
  }

  private async retainDownload(download: Download): Promise<void> {
    const id = randomBytes(12).toString('base64url');
    const suggestedFilename = safeDownloadFilename(download.suggestedFilename());
    const record: BrowserDownloadRecord = { id, status: 'in-progress', suggestedFilename, startedAt: new Date().toISOString() };
    this.downloads.set(id, record);
    this.activeDownloads.set(id, download);
    while (this.downloads.size > 200) this.downloads.delete(this.downloads.keys().next().value!);
    try {
      await mkdir(this.downloadDirectory, { recursive: true, mode: 0o700 });
      const path = await availableDownloadPath(this.downloadDirectory, suggestedFilename);
      await download.saveAs(path);
      const failure = await download.failure();
      if (record.status === 'cancelled') return;
      if (failure) {
        record.status = 'failed';
        record.error = failure.slice(0, 500);
      } else {
        record.status = 'completed';
        record.path = path;
      }
    } catch (error) {
      if (record.status !== 'cancelled') {
        record.status = 'failed';
        record.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      }
    } finally {
      record.completedAt ??= new Date().toISOString();
      this.activeDownloads.delete(id);
    }
  }

  private async getPage(): Promise<Page> {
    const context = await this.getContext();
    if (this.activePage && !this.activePage.isClosed()) {
      this.touchPage(this.activePage);
      return this.activePage;
    }
    const page = context.pages().findLast((candidate) => !candidate.isClosed()) ?? await context.newPage();
    await this.preparePage(context, page);
    this.setActivePage(page);
    return page;
  }

  private setActivePage(page: Page | undefined): void {
    if (!page) return;
    const now = this.now();
    if (this.activePage && this.activePage !== page && !this.activePage.isClosed()) this.touchPage(this.activePage, now);
    this.activePage = page;
    this.touchPage(page, now);
    this.clearReferences();
  }

  private touchPage(page: Page, now = this.now()): void {
    if (!page.isClosed()) this.pageLastActive.set(page, now);
  }

  private async enforceTabLimit(context: BrowserContext, preferredPage = this.activePage): Promise<void> {
    const pages = context.pages().filter((page) => !page.isClosed());
    if (!this.activePage || this.activePage.isClosed()) {
      const replacement = preferredPage && !preferredPage.isClosed() ? preferredPage : pages.at(-1);
      if (replacement) this.setActivePage(replacement);
    }
  }

  private async listTabs(): Promise<TabState[]> {
    const context = await this.getContext();
    await this.enforceTabLimit(context, this.activePage);
    return Promise.all(context.pages().map(async (page, index) => ({
      tabId: this.tabId(page),
      index,
      active: page === this.activePage,
      ...await pageState(page),
    })));
  }

  private tabId(page: Page): string {
    let id = this.tabIds.get(page);
    if (!id) {
      id = randomBytes(12).toString('base64url');
      this.tabIds.set(page, id);
    }
    return id;
  }

  private requireTab(pages: Page[], target: number | string): Page {
    if (typeof target === 'number') return requirePageIndex(pages, target);
    const page = pages.find((candidate) => this.tabId(candidate) === target);
    if (!page) throw new QubiclError('browser_tab_not_found', `Browser tab ${target} was not found. Refresh browser_tabs and retry.`, 404);
    return page;
  }

  private clearContext(context: BrowserContext): void {
    void this.contextPromise?.then((current) => {
      if (current === context) this.contextPromise = undefined;
    }).catch(() => undefined);
    this.clearReferences();
    this.activePage = undefined;
    this.pageLastActive.clear();
    this.tabIds.clear();
  }
}

async function assertScreenshotBudget(page: Page, fullPage: boolean): Promise<void> {
  if (!fullPage) return;
  const dimensions = await page.evaluate((_marker) => ({
    width: Math.max(document.documentElement?.scrollWidth ?? 0, document.body?.scrollWidth ?? 0, window.innerWidth),
    height: Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0, window.innerHeight),
  }), { qubiclScreenshotDimensions: true }).catch(() => ({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }));
  const width = Number(dimensions.width);
  const height = Number(dimensions.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > MAX_SCREENSHOT_PIXELS) {
    throw new QubiclError(
      'browser_screenshot_too_large',
      `Full-page capture is limited to ${MAX_SCREENSHOT_PIXELS} CSS pixels. Capture the visible viewport or scroll and capture sections instead.`,
      413,
    );
  }
}

function browserFrames(page: Page): ReturnType<Page['frames']> {
  const frames = (page as Page & { frames?: Page['frames'] }).frames;
  return typeof frames === 'function' ? frames.call(page) : [page.mainFrame()];
}

function browserViewportSize(page: Page): { width: number; height: number } {
  const viewportSize = (page as Page & { viewportSize?: Page['viewportSize'] }).viewportSize;
  return (typeof viewportSize === 'function' ? viewportSize.call(page) : undefined)
    ?? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
}

async function waitForRenderedContent(page: Page): Promise<void> {
  await page.evaluate(async ({ minimumMs, stableMs, maximumMs }) => {
    const root = document.querySelector('article,main') ?? document.body ?? document.documentElement;
    if (!root) return;
    const signature = (): string => {
      const text = (root.textContent ?? '').slice(0, 200_000);
      let hash = 2_166_136_261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
      }
      const signals = [...root.querySelectorAll('[itemprop],[data-price],[aria-label],[aria-busy]')]
        .slice(0, 200)
        .map((node) => `${node.getAttribute('itemprop') ?? ''}|${node.getAttribute('data-price') ?? ''}|${node.getAttribute('aria-label') ?? ''}|${node.getAttribute('aria-busy') ?? ''}`)
        .join('\n');
      return `${text.length}:${hash >>> 0}:${signals}`;
    };
    const pending = (): boolean => {
      const selector = [
        '[aria-busy="true"]',
        '[data-loading="true"]',
        '[class*="skeleton" i]',
        '[class*="loading" i]',
        '[itemprop="price"]:empty',
        '[data-price=""]',
        '[class*="ticker" i]:empty',
      ].join(',');
      return Boolean(root.querySelector(selector));
    };
    await new Promise<void>((resolvePromise) => {
      const started = performance.now();
      let lastChanged = started;
      let previous = signature();
      const interval = window.setInterval(() => {
        const now = performance.now();
        const current = signature();
        if (current !== previous) {
          previous = current;
          lastChanged = now;
        }
        const elapsed = now - started;
        if ((elapsed >= minimumMs && now - lastChanged >= stableMs && !pending()) || elapsed >= maximumMs) {
          window.clearInterval(interval);
          resolvePromise();
        }
      }, 250);
    });
  }, {
    minimumMs: RENDER_SETTLE_MINIMUM_MS,
    stableMs: RENDER_SETTLE_STABLE_MS,
    maximumMs: RENDER_SETTLE_MAXIMUM_MS,
  });
}

type WebResolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

export async function validatePublicWebUrl(value: string, resolver: WebResolver = lookup as WebResolver): Promise<string> {
  let url: URL;
  try { url = new URL(value); } catch { throw new QubiclError('web_invalid_url', 'A complete HTTP or HTTPS URL is required.', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new QubiclError('web_invalid_url', 'Only complete HTTP and HTTPS URLs are allowed.', 400);
  if (url.username || url.password) throw new QubiclError('web_invalid_url', 'Embedded URL credentials are not allowed.', 400);
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await resolver(url.hostname, { all: true, verbatim: true }); } catch (error) { throw new QubiclError('web_dns_failure', `Could not resolve web destination: ${(error as Error).message}`, 502); }
  if (!addresses.length || addresses.some(({ address }) => !isGloballyRoutableIp(address))) {
    throw new QubiclError('web_private_destination', 'Loopback, private, link-local, metadata, reserved, and other non-public destinations are blocked.', 403);
  }
  return url.toString();
}

function browserProxy(value: string | undefined): { server: string; username?: string; password?: string } | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !url.hostname || !url.port) return undefined;
    return {
      server: url.origin,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
  } catch {
    return undefined;
  }
}

async function browserViewerPointerForAction(page: Page, action: BrowserComputerAction): Promise<ViewerPointerAction | undefined> {
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'move':
      return browserViewerPointer(page, {
        type: action.type === 'click' && action.button === 'right' ? 'right_click' : action.type,
        x: action.x,
        y: action.y,
        button: browserButtonNumber(action.button ?? 'left'),
      });
    case 'drag': {
      const endpoint = action.path.at(-1);
      return endpoint
        ? browserViewerPointer(page, {
            type: 'drag',
            toX: endpoint.x,
            toY: endpoint.y,
            button: browserButtonNumber(action.button ?? 'left'),
          })
        : undefined;
    }
    case 'scroll':
      return browserViewerPointer(page, {
        type: 'scroll',
        x: action.x,
        y: action.y,
        deltaY: action.scroll_y ?? 0,
      });
    default:
      return undefined;
  }
}

async function browserViewerPointer(page: Page, action: ViewerPointerAction): Promise<ViewerPointerAction | undefined> {
  const sourceX = action.type === 'drag' ? action.toX : action.x;
  const sourceY = action.type === 'drag' ? action.toY : action.y;
  if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY)) return undefined;
  try {
    const metrics = await page.evaluate(() => ({
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    }), { qubiclViewerMetrics: true }) as BrowserWindowMetrics;
    const point = browserViewportToDisplayPoint({ x: sourceX!, y: sourceY! }, metrics);
    if (!point) return undefined;
    return action.type === 'drag'
      ? { ...action, toX: point.x, toY: point.y }
      : { ...action, x: point.x, y: point.y };
  } catch {
    // Pointer telemetry is a viewer convenience and must never make an
    // otherwise valid browser action fail when a page is navigating/closing.
    return undefined;
  }
}

export function browserViewportToDisplayPoint(
  point: { x: number; y: number },
  metrics: BrowserWindowMetrics,
): { x: number; y: number } | undefined {
  const values = [
    point.x, point.y, metrics.screenX, metrics.screenY, metrics.outerWidth,
    metrics.outerHeight, metrics.innerWidth, metrics.innerHeight, metrics.devicePixelRatio,
  ];
  if (values.some((value) => !Number.isFinite(value)) || metrics.innerWidth <= 0 || metrics.innerHeight <= 0 || metrics.devicePixelRatio <= 0) return undefined;
  const sideInset = Math.max(0, (metrics.outerWidth - metrics.innerWidth) / 2);
  const topInset = Math.max(0, metrics.outerHeight - metrics.innerHeight - sideInset);
  return {
    x: (metrics.screenX + sideInset + point.x) * metrics.devicePixelRatio,
    y: (metrics.screenY + topInset + point.y) * metrics.devicePixelRatio,
  };
}

function browserButtonNumber(button: BrowserMouseButton): number {
  if (button === 'right') return 3;
  if (button === 'middle') return 2;
  return 1;
}

async function runComputerAction(page: Page, action: BrowserComputerAction): Promise<void> {
  switch (action.type) {
    case 'screenshot': return;
    case 'click':
    case 'double_click':
    case 'move':
      await withModifiers(page, action.keys, async () => {
        if (action.type === 'move') await page.mouse.move(action.x, action.y);
        else await page.mouse.click(action.x, action.y, { button: action.button ?? 'left', clickCount: action.type === 'double_click' ? 2 : 1 });
      });
      return;
    case 'drag':
      if (action.path.length < 2 || action.path.length > MAX_DRAG_POINTS) throw new QubiclError('browser_actions_invalid', `Drag paths must contain 2 through ${MAX_DRAG_POINTS} points.`, 400);
      await withModifiers(page, action.keys, async () => {
        const first = action.path[0]!;
        await page.mouse.move(first.x, first.y);
        await page.mouse.down({ button: action.button ?? 'left' });
        try {
          for (const point of action.path.slice(1)) await page.mouse.move(point.x, point.y, { steps: 4 });
        } finally {
          await page.mouse.up({ button: action.button ?? 'left' }).catch(() => undefined);
        }
      });
      return;
    case 'scroll':
      await withModifiers(page, action.keys, async () => {
        await page.mouse.move(action.x, action.y);
        await page.mouse.wheel(action.scroll_x ?? 0, action.scroll_y ?? 600);
      });
      return;
    case 'keypress':
      await computerKeypress(page, action.keys);
      return;
    case 'type':
      if (action.text.length > MAX_TEXT_LENGTH) throw new QubiclError('browser_actions_invalid', `Browser text is limited to ${MAX_TEXT_LENGTH} characters.`, 400);
      await page.keyboard.insertText(action.text);
      return;
    case 'wait':
      await page.waitForTimeout(action.milliseconds ?? 2000);
  }
}

async function withModifiers(page: Page, values: string[] | undefined, operation: () => Promise<void>): Promise<void> {
  const modifiers = [...new Set((values ?? []).map(normalizedKey))];
  if (modifiers.some((key) => !MODIFIER_KEYS.has(key))) {
    throw new QubiclError('browser_actions_invalid', 'Mouse action keys may contain only Control, Meta, Alt, and Shift.', 400);
  }
  for (const key of modifiers) await page.keyboard.down(key);
  try {
    await operation();
  } finally {
    for (const key of modifiers.toReversed()) await page.keyboard.up(key).catch(() => undefined);
  }
}

async function computerKeypress(page: Page, values: string[]): Promise<void> {
  const keys = values.map(normalizedKey);
  const leadingModifiers = keys.slice(0, -1);
  if (keys.length > 1 && leadingModifiers.every((key) => MODIFIER_KEYS.has(key))) {
    for (const key of leadingModifiers) await page.keyboard.down(key);
    try {
      await page.keyboard.press(keys.at(-1)!);
    } finally {
      for (const key of leadingModifiers.toReversed()) await page.keyboard.up(key).catch(() => undefined);
    }
    return;
  }
  for (const key of keys) await page.keyboard.press(key);
}

const KEY_ALIASES = new Map([
  ['CTRL', 'Control'],
  ['CONTROL', 'Control'],
  ['CMD', 'Meta'],
  ['COMMAND', 'Meta'],
  ['META', 'Meta'],
  ['ALT', 'Alt'],
  ['OPTION', 'Alt'],
  ['SHIFT', 'Shift'],
  ['ENTER', 'Enter'],
  ['RETURN', 'Enter'],
  ['TAB', 'Tab'],
  ['ESC', 'Escape'],
  ['ESCAPE', 'Escape'],
  ['BACKSPACE', 'Backspace'],
  ['DELETE', 'Delete'],
  ['SPACE', 'Space'],
  ['ARROWUP', 'ArrowUp'],
  ['ARROWDOWN', 'ArrowDown'],
  ['ARROWLEFT', 'ArrowLeft'],
  ['ARROWRIGHT', 'ArrowRight'],
  ['HOME', 'Home'],
  ['END', 'End'],
  ['PAGEUP', 'PageUp'],
  ['PAGEDOWN', 'PageDown'],
]);
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift']);

function normalizedKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 40) throw new QubiclError('browser_actions_invalid', 'Each browser key must be a non-empty key name of at most 40 characters.', 400);
  return KEY_ALIASES.get(key.toUpperCase()) ?? key;
}

function safeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QubiclError('browser_url_invalid', 'Browser URL must be a complete HTTP or HTTPS URL.', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new QubiclError('browser_url_invalid', 'Browser URL must be HTTP or HTTPS and cannot contain embedded credentials.', 400);
  }
  return url.href;
}

function requirePageIndex(pages: Page[], index: number): Page {
  if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
    throw new QubiclError('browser_tab_not_found', `Browser tab index ${index} was not found.`, 404);
  }
  return pages[index]!;
}

async function pageState(page: Page): Promise<PageState> {
  return { url: page.url().slice(0, 8192), title: (await page.title().catch(() => '')).slice(0, 512) };
}

function truncateUtf8Text(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const data = Buffer.from(value, 'utf8');
  if (data.length <= maximumBytes) return { text: value, truncated: false };
  let end = maximumBytes;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end -= 1;
  return { text: data.subarray(0, end).toString('utf8'), truncated: true };
}

function withinHome(home: string, path: string): boolean {
  const value = relative(home, path);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`));
}

function safeDownloadFilename(value: string): string {
  const name = [...basename(value)].map((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 || codePoint === 127 || character === '/' || character === '\\' ? '_' : character;
  }).join('').trim().slice(0, 180);
  return name && name !== '.' && name !== '..' ? name : 'download';
}

async function availableDownloadPath(directory: string, filename: string): Promise<string> {
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length) || 'download';
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = join(directory, index === 0 ? filename : `${stem} (${index})${extension}`);
    try { await lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new QubiclError('browser_download_collision', 'Could not choose an unused durable download filename.', 409);
}

function diagnosticUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`.slice(0, 1_000); }
  catch { return 'invalid-url'; }
}

async function removeProfileLocks(profileDirectory: string): Promise<void> {
  for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    await rm(resolve(profileDirectory, name), { force: true, recursive: true }).catch(() => undefined);
  }
}

function desktopEnvironment(home: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const display = typeof source.DISPLAY === 'string' && /^:[0-9]+(?:\.[0-9]+)?$/.test(source.DISPLAY) ? source.DISPLAY : ':0';
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USER: 'qubicl',
    LOGNAME: 'qubicl',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    DISPLAY: display,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    XDG_CONFIG_HOME: resolve(home, '.config'),
    XDG_DATA_HOME: resolve(home, '.local/share'),
    XDG_CACHE_HOME: resolve(home, '.cache'),
  };
  const proxy = source.QUBICL_PROXY_URL;
  if (typeof proxy === 'string' && /^http:\/\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+@[A-Za-z0-9_.-]+:\d{1,5}$/.test(proxy)) {
    environment.HTTP_PROXY = proxy;
    environment.HTTPS_PROXY = proxy;
  }
  return environment;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
