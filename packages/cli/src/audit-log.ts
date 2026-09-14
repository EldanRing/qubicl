import { appendFile, lstat, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ParsedArgs } from './args.js';
import { flag, numberOption, stringOption } from './args.js';
import { loadState, statePaths, type LoadedState } from './state.js';

function computerAudits(state: LoadedState, name: string): string[] {
  const computer = state.config.computers.find((entry) => entry.name === name || entry.id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return (computer.controlProtocolVersion ?? 0) >= 10
    ? [
      join(state.paths.audits, `${computer.id}.control.jsonl`),
      join(state.paths.audits, `${computer.id}.network.jsonl`),
      join(state.paths.audits, `${computer.id}.jsonl`),
    ]
    : [
      join(state.paths.computers, computer.id, 'audit.control.jsonl'),
      join(state.paths.computers, computer.id, 'audit.network.jsonl'),
      join(state.paths.computers, computer.id, 'audit.jsonl'),
    ];
}

async function lines(path: string): Promise<string[]> {
  const current = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  return current.split('\n').filter(Boolean);
}

interface AuditRecord { line: string; path: string; at: string; sequence: number }
async function records(paths: readonly string[]): Promise<AuditRecord[]> {
  const groups = await Promise.all(paths.map(async (path, sourceIndex) => (await lines(path)).map((line, lineIndex) => {
    let at = '';
    try { const value = JSON.parse(line) as { at?: unknown }; if (typeof value.at === 'string') at = value.at; } catch { /* retain malformed records for operator review */ }
    return { line, path, at, sequence: sourceIndex * 1_000_000_000 + lineIndex };
  })));
  return groups.flat().sort((left, right) => left.at.localeCompare(right.at) || left.sequence - right.sequence);
}

export async function recordCliAudit(command: string | undefined, status: 'ok' | 'error', positionals: readonly string[] = []): Promise<void> {
  if (!command || ['help', 'version'].includes(command)) return;
  const paths = statePaths();
  try {
    const info = await lstat(paths.root); if (!info.isDirectory()) return;
    const path = join(paths.root, 'operator-audit.jsonl');
    const size = await stat(path).then((value) => value.size, () => 0);
    if (size > 10 * 1024 * 1024) {
      const data = await readFile(path);
      const tail = data.subarray(Math.max(0, data.length - 6 * 1024 * 1024));
      const firstLine = tail.indexOf(0x0a);
      await truncate(path, 0);
      if (firstLine >= 0) await appendFile(path, tail.subarray(firstLine + 1), { mode: 0o600 });
    }
    await appendFile(path, `${JSON.stringify({
      at: new Date().toISOString(), type: 'lifecycle', command, status,
      ...(positionals[0] ? { action: positionals[0].slice(0, 128) } : {}),
      ...(positionals[1] ? { target: positionals[1].slice(0, 128) } : {}),
    })}\n`, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Auditing must never hide the original CLI result, but a missing audit
    // record is itself operator-relevant state and must not fail silently.
    console.error(`qubicl: warning: could not record the local operator audit event: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function auditCommand(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0];
  const name = args.positionals[1];
  if (!action || !name) throw new Error('Usage: qubicl audit show|export|prune COMPUTER.');
  const state = await loadState();
  const paths = computerAudits(state, name);
  if (action === 'show') {
    const keep = numberOption(args, 'keep') ?? 200;
    if (!Number.isInteger(keep) || keep < 1 || keep > 10_000) throw new Error('--keep must be an integer from 1 through 10000.');
    console.log((await records(paths)).slice(-keep).map(({ line }) => line).join('\n'));
    return;
  }
  if (action === 'export') {
    const output = stringOption(args, 'output'); if (!output) throw new Error('Audit export requires --output.');
    const content = (await records(paths)).map(({ line }) => line);
    await writeFile(output, content.length ? `${content.join('\n')}\n` : '', { mode: 0o600 });
    console.log(`Exported the private audit stream to ${resolve(output)}.`); return;
  }
  if (action === 'prune') {
    if (!flag(args, 'yes')) throw new Error('Audit pruning requires --yes.');
    const keep = numberOption(args, 'keep') ?? 1000;
    if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep must be a non-negative integer.');
    const all = await records(paths);
    const retained = keep === 0 ? [] : all.slice(-keep);
    const existingSources = new Set(all.map(({ path }) => path));
    if (!existingSources.size) existingSources.add(paths[0]!);
    for (const path of existingSources) {
      const selected = retained.filter((record) => record.path === path).map(({ line }) => line);
      await truncate(path, 0).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      if (selected.length) await appendFile(path, `${selected.join('\n')}\n`, { mode: 0o600 });
    }
    console.log(`Retained ${retained.length} audit events for ${name}.`); return;
  }
  throw new Error('Audit action must be show, export, or prune.');
}
