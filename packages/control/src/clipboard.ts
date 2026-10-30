import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { desktopHelperEnvironment } from './environments.js';
import { nativeDesktop } from './desktop-native.js';
import { QubiclError } from './errors.js';
import { readTextPage } from './browser-reading.js';

export interface ClipboardReadInput { cursor?: string; maxBytes?: number; }
export interface ClipboardSource {
  text: string;
  status: 'text' | 'unavailable';
  ownerAvailable: boolean | null;
  formats: string[];
  format: string | null;
  formatsTruncated?: boolean;
}
export interface ClipboardReadResult extends ClipboardSource {
  truncated: boolean;
  captureId: string | null;
  nextCursor: string | null;
  totalBytes: number | null;
  totalCharacters: number | null;
  offset?: number;
  nextOffset?: number;
  offsetUnit?: 'utf16';
  capturedAt?: string;
  consistency?: 'captured_text';
  reason?: string;
}

/** Retain text once, so an owner change cannot splice different clipboards. */
export class ClipboardReader {
  private readonly captures = new Map<string, { source: ClipboardSource; bytes: number; created: number }>();
  constructor(private readonly source: () => Promise<ClipboardSource> = readClipboardSource, private readonly now = Date.now) {}

  async read(input: ClipboardReadInput = {}): Promise<ClipboardReadResult> {
    for (const [id, capture] of this.captures) if (this.now() - capture.created >= 300_000) this.captures.delete(id);
    let id: string, offset = 0;
    let capture: { source: ClipboardSource; bytes: number; created: number };
    if (input.cursor) {
      const match = /^([a-f0-9]{24}):(\d{1,8})$/u.exec(input.cursor);
      const retained = match && this.captures.get(match[1]!);
      if (!retained) throw new QubiclError('stale_clipboard_read', 'Clipboard capture expired or was evicted. Start a new read.', 409);
      id = match[1]!; offset = Number(match[2]); capture = retained;
      if (offset > capture.source.text.length || (offset > 0 && /[\uD800-\uDBFF]/u.test(capture.source.text[offset - 1]!))) {
        throw new QubiclError('invalid_clipboard_cursor', 'Cursor offset is outside the captured text or splits a Unicode character.');
      }
    } else {
      const source = await this.source();
      if (source.status === 'unavailable') return { ...source, truncated: false, captureId: null, nextCursor: null,
        totalBytes: null, totalCharacters: null, reason: source.ownerAvailable === false ? 'no_selection_owner' : 'text_format_unavailable' };
      const bytes = Buffer.byteLength(source.text);
      if (bytes > 8_000_000) throw new QubiclError('clipboard_too_large', 'Clipboard text exceeds the 8 MB capture bound. Save it as a file for file reading.', 413);
      while (this.captures.size >= 4 || [...this.captures.values()].reduce((sum, item) => sum + item.bytes, 0) + bytes > 16_000_000) {
        this.captures.delete(this.captures.keys().next().value!);
      }
      id = randomBytes(12).toString('hex'); capture = { source, bytes, created: this.now() };
      this.captures.set(id, capture);
    }
    const result = readTextPage(capture.source.text, offset, input.maxBytes ?? 16_000);
    const text = result.content!;
    return { ...capture.source, text, truncated: result.nextOffset !== null, captureId: id,
      nextCursor: result.nextOffset === null ? null : `${id}:${result.nextOffset}`, totalBytes: capture.bytes,
      totalCharacters: capture.source.text.length, offset, nextOffset: offset + text.length, offsetUnit: 'utf16',
      capturedAt: new Date(capture.created).toISOString(), consistency: 'captured_text' };
  }
}

async function xclip(target: string, maximumBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('xclip', ['-selection', 'clipboard', '-o', '-target', target], {
      env: desktopHelperEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0, stderr = '', failure: QubiclError | undefined;
    const timer = setTimeout(() => { failure = new QubiclError('clipboard_timeout', 'Clipboard owner did not finish its response.', 504); child.kill(); }, 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumBytes) { failure = new QubiclError('clipboard_too_large', 'Clipboard response exceeds its capture bound.', 413); child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 2048); });
    child.once('error', (error) => { clearTimeout(timer); reject(new QubiclError('clipboard_unavailable', error.message, 503)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(chunks));
      else if (code === 1 && /target .+ not available/iu.test(stderr)) resolve(null);
      else reject(new QubiclError('clipboard_read_failed', `xclip exited with code ${code}: ${stderr.trim().slice(0, 512)}`, 500));
    });
  });
}

export async function readClipboardSource(): Promise<ClipboardSource> {
  const status = await nativeDesktop.clipboardStatus().catch(() => undefined);
  const ownerAvailable = typeof status?.ownerAvailable === 'boolean' ? status.ownerAvailable : null;
  const unavailable: ClipboardSource = { status: 'unavailable', text: '', formats: [], format: null, ownerAvailable };
  if (ownerAvailable === false) return unavailable;
  const targets = await xclip('TARGETS', 64_000);
  if (!targets) return unavailable;
  const available = targets.toString('utf8').split(/[\r\n]+/u).map((format) => format.trim()).filter(Boolean);
  const formats: string[] = [];
  for (const candidate of available) {
    const item = candidate.slice(0, 128);
    if (formats.length >= 32 || Buffer.byteLength(JSON.stringify([...formats, item])) > 2048) break;
    formats.push(item);
  }
  const formatsTruncated = formats.length < available.length || available.some((format) => format.length > 128);
  for (const format of ['UTF8_STRING', 'text/plain;charset=utf-8', 'text/plain', 'STRING']) {
    if (!available.includes(format)) continue;
    const bytes = await xclip(format, 8_000_000);
    if (!bytes) continue; // Owner/targets may have changed during negotiation.
    let text: string;
    try { text = format === 'STRING' ? bytes.toString('latin1') : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new QubiclError('clipboard_encoding_invalid', 'The clipboard owner returned invalid bytes for its UTF-8 text format.', 422); }
    return { text, status: 'text', formats, formatsTruncated, format, ownerAvailable };
  }
  return { ...unavailable, formats, formatsTruncated };
}

export const clipboardReader = new ClipboardReader();
