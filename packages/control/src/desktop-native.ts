import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { desktopHelperEnvironment } from './environments.js';
import { QubiclError } from './errors.js';

export interface DesktopWindow {
  id: number; pid: number | null; title: string; className: string;
  geometry: { x: number; y: number; width: number; height: number };
  geometryToken: string; transientFor: number | null; modal: boolean; active: boolean;
}
export interface DesktopSnapshotInput {
  windowId: number; cursor?: string; ref?: string; limit?: number; maxBytes?: number; includeHidden?: boolean; textOffset?: number; textCursor?: string;
}
export interface DesktopElementAction {
  ref: string; action: 'invoke' | 'focus' | 'set_text'; actionName?: string; text?: string;
}
export type NativeDesktopMethod = 'windows' | 'snapshot' | 'act' | 'windowAction';
interface NativeOptions { script?: string; uid?: number; gid?: number; environment?: NodeJS.ProcessEnv }

/** A private, workload-user helper retains the actual AT-SPI objects behind refs. */
export class NativeDesktopManager {
  private child: ChildProcessWithoutNullStreams | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private inputTail: Promise<unknown> = Promise.resolve();
  private pending: { resolve(value: Record<string, unknown>): void; reject(error: Error): void } | undefined;
  constructor(private readonly options: NativeOptions = {}) {}
  interact<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.inputTail.then(operation);
    this.inputTail = next.catch(() => undefined);
    return next;
  }

  invoke(method: NativeDesktopMethod, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case 'windows': return this.windows(input.cursor as number | undefined);
      case 'snapshot': return this.snapshot(input as unknown as DesktopSnapshotInput);
      case 'act': return this.act(input as unknown as DesktopElementAction);
      case 'windowAction': return this.windowAction(input.windowId as number, input.action as 'focus' | 'close' | 'fit', input.geometryToken as string | undefined);
      default: throw new QubiclError('invalid_desktop_method', 'Unsupported desktop operation.', 400);
    }
  }

  windows(cursor = 0): Promise<Record<string, unknown>> { return this.request('windows', { cursor }); }
  snapshot(input: DesktopSnapshotInput): Promise<Record<string, unknown>> { return this.request('snapshot', input); }
  act(input: DesktopElementAction): Promise<Record<string, unknown>> { return this.interact(() => this.request('act', input)); }
  windowAction(windowId: number, action: 'focus' | 'close' | 'fit', geometryToken?: string): Promise<Record<string, unknown>> {
    return this.interact(() => this.request('window_action', { windowId, action, geometryToken }));
  }
  validate(input: Record<string, unknown>): Promise<Record<string, unknown>> { return this.request('validate', input); }
  clipboardStatus(): Promise<Record<string, unknown>> { return this.request('clipboard_status', {}); }
  async closeProcessWindows(pid: number): Promise<Record<string, unknown>> { return this.interact(() => this.request('close_process', { pid })); }
  shutdown(): void {
    const child = this.child;
    this.child = undefined;
    this.pending?.reject(new QubiclError('desktop_helper_stopped', 'Desktop helper stopped; refresh native references.', 503));
    this.pending = undefined;
    child?.kill();
  }
  private request(method: string, input: unknown): Promise<Record<string, unknown>> {
    const operation = this.tail.then(() => this.send(method, input));
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  private async send(method: string, input: unknown): Promise<Record<string, unknown>> {
    if (!this.child) this.start();
    const child = this.child!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new QubiclError('desktop_helper_timeout', 'Native desktop request timed out. Its effect is unknown; observe before retrying. References were invalidated.', 504));
        this.shutdown();
      }, 20_000);
      this.pending = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      child.stdin.write(`${JSON.stringify({ method, input })}\n`, (error) => {
        if (error) this.fail(child, error.message);
      });
    });
  }
  private start(): void {
    const environment = this.options.environment ?? process.env;
    const uid = this.options.uid ?? (process.getuid?.() === 0 && environment.QUBICL_HOST_UID ? Number(environment.QUBICL_HOST_UID) : undefined);
    const gid = this.options.gid ?? (uid !== undefined && environment.QUBICL_HOST_GID ? Number(environment.QUBICL_HOST_GID) : undefined);
    if (process.getuid?.() === 0 && (!Number.isInteger(uid) || uid === 0 || !Number.isInteger(gid))) {
      throw new QubiclError('desktop_identity_required', 'Native inspection requires the configured non-root workload identity.', 503);
    }
    const child = spawn('/usr/bin/python3', ['-I', '-u', this.options.script ?? '/opt/qubicl/desktop-helper.py'], {
      env: desktopHelperEnvironment(environment), stdio: ['pipe', 'pipe', 'pipe'],
      ...(uid === undefined ? {} : { uid, gid }),
    });
    this.child = child;
    let bytes = 0;
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 256_000) this.fail(child, 'Native helper exceeded its response budget.');
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (child !== this.child) return;
      bytes = 0;
      const pending = this.pending;
      this.pending = undefined;
      try {
        const value = JSON.parse(line) as { result?: Record<string, unknown>; error?: { code: string; message: string } };
        if (value.error) pending?.reject(new QubiclError(value.error.code, value.error.message, 409));
        else pending?.resolve(value.result ?? {});
      } catch { pending?.reject(new QubiclError('desktop_helper_error', 'Invalid desktop helper response.', 502)); this.shutdown(); }
    });
    child.stderr.resume();
    child.on('error', (error) => this.fail(child, error.message));
    child.on('exit', () => this.fail(child, 'Native helper exited; refresh native references.'));
  }
  private fail(child: ChildProcessWithoutNullStreams, message: string): void {
    if (child !== this.child) return;
    this.pending?.reject(new QubiclError('desktop_helper_unavailable', message, 503));
    this.pending = undefined;
    this.shutdown();
  }
}

export const nativeDesktop = new NativeDesktopManager();
