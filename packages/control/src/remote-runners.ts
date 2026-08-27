import type { DesktopApplicationName } from '@qubicl/core';
import type { DesktopApplicationRecord } from './desktop-applications.js';
import { QubiclError } from './errors.js';
import type { LeaseProof } from './lease.js';
import type { ProcessOutputMode, ProcessResult, StopSignal } from './processes.js';
import { BrowserManager, type BrowserComputerAction, type BrowserMouseButton } from './browser.js';
import type { WebExtractRenderedInput } from './web.js';
import type { ListeningPort } from './ports.js';
import type { EffectiveResourceLimits } from './resource-limits.js';

export interface RemoteProcessStatus {
  managedProcesses: number;
  effectiveResourceLimits: EffectiveResourceLimits;
}

export class RemoteProcessManager {
  constructor(private readonly baseUrl: string, private readonly key: string) {}

  exec(command: string, cwd: string, yieldTimeMs: number, maxOutputBytes: number, owner: LeaseProof, timeoutMs?: number, outputMode: ProcessOutputMode = 'combined'): Promise<ProcessResult> {
    return this.request('/v1/process/exec', { command, cwd, yieldTimeMs, maxOutputBytes, owner, timeoutMs, outputMode });
  }
  write(id: string, input: string, close: boolean, yieldTimeMs: number, owner: LeaseProof): Promise<ProcessResult> {
    return this.request('/v1/process/write', { id, input, close, yieldTimeMs, owner });
  }
  stop(id: string, owner: LeaseProof, signal: StopSignal = 'SIGTERM'): Promise<ProcessResult> {
    return this.request('/v1/process/stop', { id, owner, signal });
  }
  terminateOwner(owner: LeaseProof | undefined): Promise<{ terminatedManagedProcesses: number }> {
    return this.request('/v1/process/terminate-owner', { owner });
  }
  async count(): Promise<number> {
    return (await this.status()).managedProcesses;
  }
  status(): Promise<RemoteProcessStatus> { return this.request('/v1/status', undefined, 'GET'); }
  private request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    return runnerRequest(this.baseUrl, this.key, path, body, method);
  }
}

export class RemotePortManager {
  constructor(private readonly baseUrl: string, private readonly key: string) {}
  async listPorts(): Promise<ListeningPort[]> {
    return (await runnerRequest<{ ports: ListeningPort[] }>(this.baseUrl, this.key, '/v1/ports', undefined, 'GET')).ports;
  }
}

export class RemoteBrokerManager {
  constructor(private readonly baseUrl: string, private readonly key: string) {}
  request(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return runnerRequest(this.baseUrl, this.key, '/v1/broker/request', input, 'POST', 'x-qubicl-broker-key');
  }
}

export class RemoteWebManager {
  constructor(private readonly baseUrl: string, private readonly key: string) {}
  search(input: { query: string; limit: number }): Promise<Record<string, unknown>> {
    return runnerRequest(this.baseUrl, this.key, '/v1/search', input);
  }
  extract(input: { url: string; format: 'markdown' | 'text'; maxChars: number }): Promise<Record<string, unknown>> {
    return runnerRequest(this.baseUrl, this.key, '/v1/extract', input);
  }
  extractRendered(input: WebExtractRenderedInput): Promise<Record<string, unknown>> {
    return runnerRequest(this.baseUrl, this.key, '/v1/extract-rendered', input);
  }
}

export class RemoteDesktopApplicationManager {
  constructor(private readonly baseUrl: string, private readonly key: string) {}
  open(application: DesktopApplicationName, paths: readonly string[]): Promise<DesktopApplicationRecord> {
    return this.request('/v1/applications/open', { application, paths });
  }
  async list(): Promise<DesktopApplicationRecord[]> {
    return (await this.request<{ applications: DesktopApplicationRecord[] }>('/v1/applications', undefined, 'GET')).applications;
  }
  close(applicationId: string): Promise<{ applicationId: string; application: DesktopApplicationName; state: 'closed'; lifecycle: 'desktop_session'; forcedKill: boolean }> {
    return this.request('/v1/applications/close', { applicationId });
  }
  async count(): Promise<number> {
    return (await this.request<{ desktopApplications: number }>('/v1/status', undefined, 'GET')).desktopApplications;
  }
  async shutdown(): Promise<void> {}
  private request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    return runnerRequest(this.baseUrl, this.key, path, body, method);
  }
}

export class RemoteDesktopManager {
  constructor(private readonly baseUrl: string, private readonly key: string) {}
  screenshot(): Promise<Record<string, unknown>> {
    return runnerRequest(this.baseUrl, this.key, '/v1/desktop/screenshot', {});
  }
  control(action: Record<string, unknown>): Promise<Record<string, unknown>> {
    return runnerRequest(this.baseUrl, this.key, '/v1/desktop/control', { action });
  }
  readClipboard(): Promise<{ text: string; truncated?: boolean }> {
    return runnerRequest(this.baseUrl, this.key, '/v1/clipboard', undefined, 'GET');
  }
  writeClipboard(text: string): Promise<{ written: true }> {
    return runnerRequest(this.baseUrl, this.key, '/v1/clipboard', { text });
  }
}

export class RemoteBrowserManager extends BrowserManager {
  private active = false;
  constructor(private readonly baseUrl: string, private readonly key: string) {
    super(false);
  }
  override count(): number { return this.active ? 1 : 0; }
  override navigate(url: string): ReturnType<BrowserManager['navigate']> { return this.invoke('navigate', [url]); }
  override snapshot(): ReturnType<BrowserManager['snapshot']> { return this.invoke('snapshot', []); }
  override screenshot(fullPage: boolean): ReturnType<BrowserManager['screenshot']> { return this.invoke('screenshot', [fullPage]); }
  override click(ref: string, button: 'left' | 'right'): ReturnType<BrowserManager['click']> { return this.invoke('click', [ref, button]); }
  override clickWithViewerPointer(ref: string, button: 'left' | 'right', generation?: number): ReturnType<BrowserManager['clickWithViewerPointer']> { return this.invoke('clickWithViewerPointer', [ref, button, generation]); }
  override type(ref: string, text: string, submit: boolean, clear: boolean): ReturnType<BrowserManager['type']> { return this.invoke('type', [ref, text, submit, clear]); }
  override select(ref: string, value: string): ReturnType<BrowserManager['select']> { return this.invoke('select', [ref, value]); }
  override press(key: string, ref?: string): ReturnType<BrowserManager['press']> { return this.invoke('press', [key, ref]); }
  override scroll(direction: 'up' | 'down', amount: number): ReturnType<BrowserManager['scroll']> { return this.invoke('scroll', [direction, amount]); }
  override history(action: 'back' | 'forward' | 'reload'): ReturnType<BrowserManager['history']> { return this.invoke('history', [action]); }
  override wait(milliseconds: number): ReturnType<BrowserManager['wait']> { return this.invoke('wait', [milliseconds]); }
  override tabs(): ReturnType<BrowserManager['tabs']> { return this.invoke('tabs', []); }
  override useTab(index: number): ReturnType<BrowserManager['useTab']> { return this.invoke('useTab', [index]); }
  override newTab(url?: string): ReturnType<BrowserManager['newTab']> { return this.invoke('newTab', [url]); }
  override closeTab(index: number): ReturnType<BrowserManager['closeTab']> { return this.invoke('closeTab', [index]); }
  override reset(): ReturnType<BrowserManager['reset']> { return this.invoke('reset', []); }
  override clickAt(x: number, y: number, button: BrowserMouseButton, clickCount = 1): ReturnType<BrowserManager['clickAt']> { return this.invoke('clickAt', [x, y, button, clickCount]); }
  override hoverAt(x: number, y: number): ReturnType<BrowserManager['hoverAt']> { return this.invoke('hoverAt', [x, y]); }
  override drag(startX: number, startY: number, endX: number, endY: number): ReturnType<BrowserManager['drag']> { return this.invoke('drag', [startX, startY, endX, endY]); }
  override scrollAt(x: number, y: number, scrollX: number, scrollY: number): ReturnType<BrowserManager['scrollAt']> { return this.invoke('scrollAt', [x, y, scrollX, scrollY]); }
  override typeFocused(text: string): ReturnType<BrowserManager['typeFocused']> { return this.invoke('typeFocused', [text]); }
  override inspectAt(x: number, y: number): ReturnType<BrowserManager['inspectAt']> { return this.invoke('inspectAt', [x, y]); }
  override computer(actions: BrowserComputerAction[]): ReturnType<BrowserManager['computer']> { return this.invoke('computer', [actions]); }
  override computerWithViewerPointers(actions: BrowserComputerAction[], generation?: number): ReturnType<BrowserManager['computerWithViewerPointers']> { return this.invoke('computerWithViewerPointers', [actions, generation]); }
  override renderForExtraction(url: string): ReturnType<BrowserManager['renderForExtraction']> { return this.invoke('renderForExtraction', [url]); }
  override async shutdown(): Promise<void> {
    if (!this.active) return;
    await this.invoke('shutdown', []);
    this.active = false;
  }
  private invoke<T>(method: string, args: unknown[]): Promise<T> {
    this.active = true;
    return runnerRequest<T>(this.baseUrl, this.key, '/v1/browser/invoke', { method, args });
  }
}

async function runnerRequest<T>(baseUrl: string, key: string, path: string, body?: unknown, method = 'POST', keyHeader = 'x-qubicl-runner-key'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      method,
      headers: { [keyHeader]: key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(35_000),
    });
  } catch (error) {
    const role = baseUrl.includes('executor') ? 'command'
      : baseUrl.includes('web') ? 'web'
        : baseUrl.includes('egress') ? 'egress'
          : 'desktop-session';
    throw new QubiclError('internal_runner_unavailable', `The isolated ${role} runner is unavailable: ${(error as Error).message}`, 503);
  }
  const value = await response.json().catch(() => undefined) as T | { error?: { code?: string; message?: string } } | undefined;
  if (!response.ok) {
    const payload = value as { error?: { code?: string; message?: string } } | undefined;
    throw new QubiclError(payload?.error?.code ?? 'internal_runner_error', payload?.error?.message ?? `Internal runner returned HTTP ${response.status}.`, response.status);
  }
  return value as T;
}
