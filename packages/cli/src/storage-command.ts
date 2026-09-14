import { lstat, readFile, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_STORAGE_POLICY, StoragePolicySchema, type ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { stringOption } from './args.js';
import { operationOutput } from './operation-context.js';
import { loadState, saveState, statePaths, withStateLock, type StatePaths } from './state.js';

const MAX_ACCOUNTING_ENTRIES = 1_000_000;
const MAX_ACCOUNTING_MS = 15_000;

interface UsageResult { bytes: number; entries: number; complete: boolean; diagnostic?: string }

export async function storageCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'storage action');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  if (action === 'show') {
    const state = await loadState(paths);
    const computer = findComputer(state.config.computers, name);
    const policy = StoragePolicySchema.parse({ ...DEFAULT_STORAGE_POLICY, ...computer.storage });
    const userHome = join(paths.computers, computer.id, 'home', 'qubicl');
    const [home, cache, downloads, browserProfile, taskOutput, auditParts, backups, capacity] = await Promise.all([
      directoryUsage(userHome),
      directoryUsage(join(userHome, '.cache')),
      directoryUsage(join(userHome, 'Downloads')),
      directoryUsage(join(userHome, '.local', 'share', 'qubicl', 'browser-profile')),
      directoryUsage(join(userHome, '.qubicl-tasks')),
      Promise.all([
        join(paths.audits, computer.id),
        join(paths.audits, `${computer.id}.jsonl`),
        join(paths.audits, `${computer.id}.control.jsonl`),
        join(paths.audits, `${computer.id}.network.jsonl`),
        join(paths.computers, computer.id, 'audit.jsonl'),
        join(paths.computers, computer.id, 'audit.control.jsonl'),
        join(paths.computers, computer.id, 'audit.network.jsonl'),
      ].map(directoryUsage)),
      backupUsage(paths, computer.id),
      hostCapacity(paths),
    ]);
    const audit = aggregateUsage(auditParts);
    const warnings = [
      ...(policy.homeWarningBytes > 0 && home.bytes >= policy.homeWarningBytes ? [`home usage has reached the ${formatBytes(policy.homeWarningBytes)} warning threshold`] : []),
      ...(policy.backupWarningBytes > 0 && backups.bytes >= policy.backupWarningBytes ? [`backup usage has reached the ${formatBytes(policy.backupWarningBytes)} warning threshold`] : []),
      ...(!home.complete || !backups.complete ? ['one or more usage totals are partial; inspect the diagnostic before deleting data'] : []),
    ];
    operationOutput('log', JSON.stringify({
      computer: { id: computer.id, name: computer.name },
      accounting: { home, cache, downloads, browserProfile, retainedTaskOutput: taskOutput, audit, backups },
      hostFilesystem: capacity,
      thresholds: policy,
      enforcement: {
        home: 'warning-threshold; host filesystem and VM capacity remain the actual boundary',
        backups: 'warning-threshold; backup pruning remains an explicit reviewed operation',
        taskOutput: 'hard per-task and aggregate controller limits; see qubicl tasks show',
      },
      warnings,
    }, null, 2));
    return;
  }
  if (action === 'set') {
    await withStateLock(paths, async () => {
      const state = await loadState(paths);
      const computer = findComputer(state.config.computers, name);
      const effective = { ...DEFAULT_STORAGE_POLICY, ...computer.storage };
      const home = parseByteSize(stringOption(args, 'home-warning'), '--home-warning');
      const backup = parseByteSize(stringOption(args, 'backup-warning'), '--backup-warning');
      if (home === undefined && backup === undefined) throw new Error('Storage set requires --home-warning or --backup-warning. Use 0 to disable a warning.');
      computer.storage = StoragePolicySchema.parse({
        homeWarningBytes: home ?? effective.homeWarningBytes,
        backupWarningBytes: backup ?? effective.backupWarningBytes,
      });
      await saveState(state);
      operationOutput('log', JSON.stringify({ computer: computer.name, thresholds: computer.storage, applied: 'immediately; no runtime restart' }, null, 2));
    });
    return;
  }
  throw new Error(`Unknown storage action ${action}; use show or set.`);
}

async function directoryUsage(root: string): Promise<UsageResult> {
  const started = Date.now();
  const pending = [root];
  let bytes = 0;
  let entries = 0;
  try {
    while (pending.length) {
      if (entries >= MAX_ACCOUNTING_ENTRIES || Date.now() - started > MAX_ACCOUNTING_MS) {
        return { bytes, entries, complete: false, diagnostic: `Accounting stopped at ${entries} entries or ${MAX_ACCOUNTING_MS / 1000} seconds.` };
      }
      const path = pending.pop()!;
      let info;
      try { info = await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return { bytes, entries, complete: false, diagnostic: `Could not inspect one path: ${(error as Error).message}` };
      }
      entries += 1;
      bytes += info.blocks > 0 ? info.blocks * 512 : info.size;
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      let children;
      try { children = await readdir(path); }
      catch (error) { return { bytes, entries, complete: false, diagnostic: `Could not read one directory: ${(error as Error).message}` }; }
      for (const child of children) pending.push(join(path, child));
    }
    return { bytes, entries, complete: true };
  } catch (error) {
    return { bytes, entries, complete: false, diagnostic: (error as Error).message };
  }
}

async function backupUsage(paths: StatePaths, computerId: string): Promise<UsageResult> {
  let entries;
  try { entries = await readdir(paths.backups, { withFileTypes: true }); }
  catch (error) { return { bytes: 0, entries: 0, complete: false, diagnostic: (error as Error).message }; }
  let bytes = 0;
  let count = 0;
  let complete = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(join(paths.backups, entry.name, 'manifest.json'), 'utf8')) as { source?: { id?: unknown } };
      if (manifest.source?.id !== computerId) continue;
      const usage = await directoryUsage(join(paths.backups, entry.name));
      bytes += usage.bytes;
      count += usage.entries;
      complete &&= usage.complete;
    } catch { complete = false; }
  }
  return { bytes, entries: count, complete, ...(!complete ? { diagnostic: 'One or more backup records could not be attributed or counted safely.' } : {}) };
}

function aggregateUsage(results: readonly UsageResult[]): UsageResult {
  const diagnostics = results.flatMap(({ diagnostic }) => diagnostic ? [diagnostic] : []);
  return {
    bytes: results.reduce((total, result) => total + result.bytes, 0),
    entries: results.reduce((total, result) => total + result.entries, 0),
    complete: results.every(({ complete }) => complete),
    ...(diagnostics.length ? { diagnostic: diagnostics.join(' ') } : {}),
  };
}

async function hostCapacity(paths: StatePaths): Promise<Record<string, unknown>> {
  try {
    const info = await statfs(paths.root);
    const blockSize = Number(info.bsize);
    return {
      filesystemBytes: Number(info.blocks) * blockSize,
      availableBytes: Number(info.bavail) * blockSize,
      scope: 'backing host or VM filesystem; shared with data outside this computer',
    };
  } catch (error) { return { unavailable: true, diagnostic: (error as Error).message }; }
}

function parseByteSize(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)([kmgt]?)(?:i?b)?$/iu.exec(value.trim());
  if (!match) throw new Error(`${option} must be bytes or a size such as 20g; use 0 to disable it.`);
  const multiplier = ({ '': 1, k: 1_000, m: 1_000_000, g: 1_000_000_000, t: 1_000_000_000_000 } as const)[match[2]!.toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result)) throw new Error(`${option} is too large.`);
  return result;
}

function findComputer(computers: ComputerConfig[], selector: string): ComputerConfig {
  const found = computers.find((computer) => computer.id === selector || computer.name === selector);
  if (!found) throw new Error(`Computer ${selector} was not found.`);
  return found;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.`);
  return value;
}

function formatBytes(bytes: number): string { return `${Math.round(bytes / 100_000_000) / 10} GB`; }
