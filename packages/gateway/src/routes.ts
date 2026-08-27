import { readFile, stat, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { RuntimeRoutesSchema, type RuntimeRoute } from '@qubicl/core';

export class RouteStore {
  private routes = new Map<string, RuntimeRoute>();
  private watcher: FSWatcher | undefined;
  private reloadTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private lastRaw?: string;
  private lastFingerprint: string | undefined;

  constructor(readonly path: string, private readonly pollIntervalMs = 2_000) {}

  async start(): Promise<void> {
    await this.reload(true);
    try {
      this.watcher = watch(dirname(this.path), () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.reload(false), 30);
      });
      this.watcher.on('error', (error) => {
        console.error('Native runtime watch stopped; continuing with polling:', error);
        this.watcher?.close();
        this.watcher = undefined;
        this.startPolling();
      });
    } catch (error) {
      console.error('Native runtime watch unavailable; continuing with polling:', error);
      this.startPolling();
    }
  }

  get(id: string): RuntimeRoute | undefined {
    return this.routes.get(id);
  }

  list(): RuntimeRoute[] {
    return [...this.routes.values()];
  }

  close(): void {
    this.watcher?.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async reload(initial: boolean): Promise<void> {
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        readFile(this.path, 'utf8', (error, data) => error ? reject(error) : resolve(data));
      });
      const fingerprint = await this.fingerprint().catch(() => undefined);
      if (raw === this.lastRaw) {
        this.lastFingerprint = fingerprint;
        return;
      }
      this.lastRaw = raw;
      const parsed = RuntimeRoutesSchema.parse(JSON.parse(raw));
      this.routes = new Map(parsed.routes.map((route) => [route.id, route]));
      this.lastFingerprint = fingerprint;
      console.log(`Loaded ${this.routes.size} Qubicl route${this.routes.size === 1 ? '' : 's'}.`);
    } catch (error) {
      if (initial) throw error;
      console.error('Keeping prior routes after invalid runtime update:', error);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    try {
      const fingerprint = await this.fingerprint();
      if (fingerprint !== this.lastFingerprint) await this.reload(false);
    } catch (error) {
      console.error('Keeping prior routes after runtime polling error:', error);
    }
  }

  private fingerprint(): Promise<string> {
    return new Promise((resolve, reject) => {
      stat(this.path, (error, info) => error ? reject(error) : resolve(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`));
    });
  }
}
