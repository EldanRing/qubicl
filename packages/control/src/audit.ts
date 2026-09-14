import { appendFile, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { contentTrustMetadata, type ToolName } from '@qubicl/core';

const MAX_BYTES = 10 * 1024 * 1024;
const RETAIN_BYTES = 6 * 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const chains = new Map<string, Promise<void>>();

export class AuditLog {
  constructor(private readonly path = process.env.QUBICL_AUDIT_PATH) {}

  record(event: Record<string, unknown>): void {
    if (!this.path) return;
    const safe = boundedEvent({ at: new Date().toISOString(), ...event });
    const prior = chains.get(this.path) ?? Promise.resolve();
    const chain = prior.then(async () => {
      const size = await stat(this.path!).then((info) => info.size, () => 0);
      if (size > MAX_BYTES) await compactStableFile(this.path!);
      await appendFile(this.path!, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    }).catch((error) => console.error(`Qubicl audit write failed: ${error instanceof Error ? error.message : String(error)}`));
    chains.set(this.path, chain);
  }

  async flush(): Promise<void> { if (this.path) await chains.get(this.path); }
}

export function toolAuditMetadata(name: ToolName, input: Record<string, unknown>): Record<string, unknown> {
  if (['write_file', 'edit_file', 'copy_path', 'move_path', 'delete_path'].includes(name)) {
    return { operation: 'filesystem-mutation' };
  }
  if (name === 'browser_navigate' || name === 'web_extract') return { destination: auditDestination(input.url) };
  if (name === 'web_search') return { provider: 'ddgs' };
  if (name === 'publish_port') return { port: input.port, expiresInSeconds: input.expiresInSeconds };
  if (name === 'unpublish_port') return { publicationId: input.publicationId };
  if (name === 'share_preview') return { publicationId: input.publicationId, expiresInSeconds: input.expiresInSeconds };
  if (name === 'revoke_preview_share') return { publicationId: input.publicationId };
  if (name === 'broker_request') return { credentialId: input.credentialId, method: input.method };
  if (name === 'exec_command') return { operation: 'process-start' };
  if (name === 'stop_process') return { operation: 'process-stop', processId: input.processId, signal: input.signal };
  if (name === 'open_desktop_application') return {
    application: boundedString(input.application),
    pathCount: Array.isArray(input.paths) ? Math.min(input.paths.length, 1_000) : 0,
  };
  return {};
}

async function compactStableFile(path: string): Promise<void> {
  const data = await readFile(path);
  const tail = data.subarray(Math.max(0, data.length - RETAIN_BYTES));
  const firstLine = tail.indexOf(0x0a);
  const retained = firstLine < 0 ? Buffer.alloc(0) : tail.subarray(firstLine + 1);
  // Keep the bind-mounted inode stable. All in-process writers share the path
  // chain above; failures surface through stderr instead of being treated as a
  // successful rotation.
  await truncate(path, 0);
  await writeFile(path, retained, { mode: 0o600 });
}

function boundedEvent(event: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitize(event, 0) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized) <= MAX_EVENT_BYTES) return sanitized;
  return {
    at: typeof sanitized.at === 'string' ? sanitized.at : new Date().toISOString(),
    type: boundedString(sanitized.type),
    tool: boundedString(sanitized.tool),
    status: boundedString(sanitized.status),
    code: boundedString(sanitized.code),
    metadataTruncated: true,
  };
}

function sanitize(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'invalid-number';
  if (typeof value === 'string') return value.slice(0, 512);
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitize(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, entry]) => [key.slice(0, 80), sanitize(entry, depth + 1)]));
  }
  return undefined;
}

function boundedString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 128) : 'invalid';
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
