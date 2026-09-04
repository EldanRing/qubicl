import { appendFile, copyFile, lstat, readFile, rename, stat, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ParsedArgs } from './args.js';
import { flag, numberOption, stringOption } from './args.js';
import { loadState, statePaths, type LoadedState } from './state.js';

function computerAudit(state: LoadedState, name: string): string {
  const computer = state.config.computers.find((entry) => entry.name === name || entry.id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return (computer.controlProtocolVersion ?? 0) >= 10
    ? join(state.paths.audits, `${computer.id}.jsonl`)
    : join(state.paths.computers, computer.id, 'audit.jsonl');
}

async function lines(path: string): Promise<string[]> {
  const current = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  return current.split('\n').filter(Boolean);
}

export async function recordCliAudit(command: string | undefined, status: 'ok' | 'error', positionals: readonly string[] = []): Promise<void> {
  if (!command || ['help', 'version'].includes(command)) return;
  const paths = statePaths();
  try {
    const info = await lstat(paths.root); if (!info.isDirectory()) return;
    const path = join(paths.root, 'operator-audit.jsonl');
    const size = await stat(path).then((value) => value.size, () => 0);
    if (size > 10 * 1024 * 1024) await rename(path, `${path}.1`).catch(() => undefined);
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
  const path = computerAudit(state, name);
  if (action === 'show') {
    const keep = numberOption(args, 'keep') ?? 200;
    if (!Number.isInteger(keep) || keep < 1 || keep > 10_000) throw new Error('--keep must be an integer from 1 through 10000.');
    console.log((await lines(path)).slice(-keep).join('\n'));
    return;
  }
  if (action === 'export') {
    const output = stringOption(args, 'output'); if (!output) throw new Error('Audit export requires --output.');
    await copyFile(path, output); console.log(`Exported the private audit stream to ${resolve(output)}.`); return;
  }
  if (action === 'prune') {
    if (!flag(args, 'yes')) throw new Error('Audit pruning requires --yes.');
    const keep = numberOption(args, 'keep') ?? 1000;
    if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep must be a non-negative integer.');
    const retained = keep === 0 ? [] : (await lines(path)).slice(-keep);
    await truncate(path, 0); await appendFile(path, retained.length ? `${retained.join('\n')}\n` : '', { mode: 0o600 });
    console.log(`Retained ${retained.length} audit events for ${name}.`); return;
  }
  throw new Error('Audit action must be show, export, or prune.');
}
