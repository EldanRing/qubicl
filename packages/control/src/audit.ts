import { appendFile, rename, stat } from 'node:fs/promises';
import { contentTrustMetadata, type ToolName } from '@qubicl/core';

const MAX_BYTES = 10 * 1024 * 1024;

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly path = process.env.QUBICL_AUDIT_PATH) {}

  record(event: Record<string, unknown>): void {
    if (!this.path) return;
    const safe = { at: new Date().toISOString(), ...event };
    this.chain = this.chain.then(async () => {
      const size = await stat(this.path!).then((info) => info.size, () => 0);
      if (size > MAX_BYTES) await rename(this.path!, `${this.path}.1`).catch(() => undefined);
      await appendFile(this.path!, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    }).catch((error) => console.error(`Qubicl audit write failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async flush(): Promise<void> { await this.chain; }
}

export function toolAuditMetadata(name: ToolName, input: Record<string, unknown>): Record<string, unknown> {
  if (['write_file', 'edit_file', 'copy_path', 'move_path', 'delete_path'].includes(name)) {
    return { path: input.path ?? input.source, ...(input.destination ? { destination: input.destination } : {}) };
  }
  if (name === 'browser_navigate' || name === 'web_extract') return { destination: auditDestination(input.url) };
  if (name === 'web_search') return { provider: 'ddgs' };
  if (name === 'publish_port') return { port: input.port, expiresInSeconds: input.expiresInSeconds };
  if (name === 'unpublish_port') return { publicationId: input.publicationId };
  if (name === 'broker_request') return { credentialId: input.credentialId, method: input.method };
  if (name === 'exec_command') return { operation: 'process-start' };
  if (name === 'stop_process') return { operation: 'process-stop', processId: input.processId, signal: input.signal };
  if (name === 'open_desktop_application') return { application: input.application, paths: input.paths };
  return {};
}

export function contentAuditMetadata(value: unknown): Record<string, unknown> {
  const trust = contentTrustMetadata(value);
  if (!trust) return {};
  return {
    contentTrust: trust.level,
    contentSource: trust.source,
    contentRisk: trust.risk,
    ...(trust.findings.length ? { contentFindings: trust.findings } : {}),
  };
}

function auditDestination(value: unknown): string {
  if (typeof value !== 'string') return 'invalid';
  try {
    const url = new URL(value);
    // The origin is enough to audit where a browser was sent. Paths, queries,
    // fragments, usernames, and passwords can contain model content or secrets.
    return url.origin === 'null' ? url.protocol : url.origin;
  } catch {
    return 'invalid';
  }
}
