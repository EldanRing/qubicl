import { randomBytes } from 'node:crypto';
import type { ElementHandle, Frame, Page } from 'playwright-core';
import { QubiclError } from './errors.js';

const MAX_DOCUMENT_BYTES = 8_000_000;
const MAX_RETAINED_BYTES = 16_000_000;
const RETENTION_MS = 5 * 60_000;

export interface BrowserReadInput {
  cursor?: string;
  maxBytes?: number;
  frameIndex?: number;
  selector?: string;
  ref?: string;
  query?: string;
  caseSensitive?: boolean;
}

interface ReadDocument {
  id: string;
  page: Page;
  frame: Frame;
  document: ElementHandle;
  text: string;
  bytes: number;
  capturedAt: number;
  url: string;
  title: string;
  frameIndex: number;
  query?: string;
  caseSensitive: boolean;
}

/** Captured text is immutable; navigation invalidates its document handle. */
export class BrowserReader {
  private readonly documents = new Map<string, ReadDocument>();
  constructor(private readonly now = Date.now) {}

  async read(page: Page, input: BrowserReadInput, rootRef?: ElementHandle): Promise<Record<string, unknown>> {
    await this.expire();
    let document: ReadDocument;
    let offset = 0;
    if (input.cursor) {
      if (input.frameIndex !== undefined || input.selector !== undefined || input.ref !== undefined
          || input.query !== undefined || input.caseSensitive !== undefined) {
        throw new QubiclError('browser_read_arguments', 'Continue with cursor and optional maxBytes only; start a new read to change its scope or query.');
      }
      const match = /^([a-f0-9]{24}):(\d{1,8})$/u.exec(input.cursor);
      const saved = match && this.documents.get(match[1]!);
      if (!saved) throw staleRead();
      document = saved;
      offset = Number(match![2]);
      if (document.page !== page || offset > document.text.length || !await this.connected(document)) {
        await this.remove(document.id);
        throw staleRead();
      }
    } else {
      if (input.ref && input.selector) throw new QubiclError('browser_read_arguments', 'Choose either ref or selector, not both.');
      const frameIndex = input.frameIndex ?? 0;
      const frame = page.frames()[frameIndex];
      if (!frame) throw new QubiclError('browser_frame_not_found', 'Requested browser frame was not found.', 404);
      if (rootRef && await rootRef.ownerFrame() !== frame) throw new QubiclError('browser_read_arguments', 'The ref belongs to a different frame.');
      const root = rootRef ?? await frame.$(input.selector ?? 'body');
      if (!root) throw new QubiclError('browser_read_target_not_found', 'The requested subtree was not found.', 404);
      const identity = await frame.$('html');
      if (!identity) {
        if (!rootRef) await root.dispose();
        throw staleRead();
      }
      try {
        const captured = await root.evaluate((element, maximumBytes) => {
          const text = (element as HTMLElement).innerText ?? element.textContent ?? '';
          const bytes = new TextEncoder().encode(text).length;
          return { text: bytes > maximumBytes ? null : text, bytes };
        }, MAX_DOCUMENT_BYTES);
        if (captured.text === null) {
          throw new QubiclError('browser_read_too_large', `This subtree exceeds ${MAX_DOCUMENT_BYTES} bytes. Select a smaller subtree; no partial document was retained.`, 413);
        }
        document = {
          id: randomBytes(12).toString('hex'), page, frame, document: identity,
          text: captured.text, bytes: captured.bytes, capturedAt: this.now(),
          url: frame.url().slice(0, 1024), title: (await page.title()).slice(0, 256), frameIndex,
          ...(input.query === undefined ? {} : { query: input.query }), caseSensitive: input.caseSensitive ?? false,
        };
        if (!await this.connected(document)) throw staleRead();
        while (this.documents.size >= 4 || this.retainedBytes() + document.bytes > MAX_RETAINED_BYTES) {
          await this.remove(this.documents.keys().next().value!);
        }
        this.documents.set(document.id, document);
      } catch (error) {
        await identity.dispose().catch(() => undefined);
        throw error;
      } finally {
        if (!rootRef) await root.dispose().catch(() => undefined);
      }
    }
    const result = readTextPage(document.text, offset, input.maxBytes ?? 12_000, document.query, document.caseSensitive);
    return {
      documentId: document.id, capturedAt: new Date(document.capturedAt).toISOString(),
      expiresAt: new Date(document.capturedAt + RETENTION_MS).toISOString(),
      url: document.url, title: document.title, frameIndex: document.frameIndex,
      source: 'authenticated_browser', consistency: 'captured_document',
      totalCharacters: document.text.length, offsetUnit: 'utf16', ...result,
      nextCursor: result.nextOffset === null ? null : `${document.id}:${result.nextOffset}`,
    };
  }

  async clear(): Promise<void> { await Promise.all([...this.documents.keys()].map((id) => this.remove(id))); }
  private retainedBytes(): number { return [...this.documents.values()].reduce((total, value) => total + value.bytes, 0); }
  private async connected(value: ReadDocument): Promise<boolean> {
    return !value.page.isClosed() && !value.frame.isDetached()
      && await value.document.evaluate((element) => element.isConnected).catch(() => false);
  }
  private async expire(): Promise<void> {
    for (const [id, value] of this.documents) if (this.now() - value.capturedAt >= RETENTION_MS) await this.remove(id);
  }
  private async remove(id: string): Promise<void> {
    const value = this.documents.get(id);
    this.documents.delete(id);
    await value?.document.dispose().catch(() => undefined);
  }
}

export function readTextPage(text: string, offset: number, maxBytes: number, query?: string, caseSensitive = false): {
  content?: string; matches?: Array<{ start: number; end: number; excerpt: string }>; nextOffset: number | null;
} {
  const budget = Math.max(512, Math.min(16_000, maxBytes));
  if (query === undefined) {
    const content = fitJsonText(text.slice(offset), budget);
    const nextOffset = offset + content.length;
    return { content, nextOffset: nextOffset < text.length ? nextOffset : null };
  }
  if (!query.length) throw new QubiclError('browser_read_arguments', 'Search query must not be empty.');
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), caseSensitive ? 'gu' : 'giu');
  expression.lastIndex = offset;
  const matches: Array<{ start: number; end: number; excerpt: string }> = [];
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    const excerpt = fitJsonText(text.slice(Math.max(0, start - 100), end + 160), Math.min(512, budget / 2));
    const record = { start, end, excerpt };
    if (matches.length >= 50 || Buffer.byteLength(JSON.stringify([...matches, record])) > budget) return { matches, nextOffset: start };
    matches.push(record);
  }
  return { matches, nextOffset: null };
}

function fitJsonText(text: string, budget: number): string {
  let lower = 0;
  let upper = Math.min(text.length, budget);
  let result = '';
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const end = middle > 0 && /[\uD800-\uDBFF]/u.test(text[middle - 1]!) ? middle - 1 : middle;
    const candidate = text.slice(0, end);
    if (Buffer.byteLength(JSON.stringify(candidate)) <= budget) { result = candidate; lower = middle + 1; }
    else upper = middle - 1;
  }
  return result;
}

function staleRead(): QubiclError {
  return new QubiclError('stale_browser_read', 'The captured document expired, navigated, closed, or belongs to another tab. Start a new browser_read.', 409);
}
