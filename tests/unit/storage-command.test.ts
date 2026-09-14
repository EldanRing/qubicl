import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { storageCommand } from '../../packages/cli/dist/storage-command.js';
import { initializeState, saveState, statePaths } from '../../packages/cli/dist/state.js';

test('storage thresholds persist and reporting includes current audit and attributed backup bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-storage-'));
  const previous = process.env.QUBICL_HOME;
  const output: string[] = [];
  const originalLog = console.log;
  process.env.QUBICL_HOME = root;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
  try {
    const state = await initializeState(statePaths(root));
    const computer = addConfiguredComputer(state, 'storage-test');
    await saveState(state);
    const home = join(state.paths.computers, computer.id, 'home', 'qubicl');
    await mkdir(join(home, 'Downloads'), { recursive: true });
    await writeFile(join(home, 'Downloads', 'result.txt'), 'durable result\n');
    await writeFile(join(state.paths.audits, `${computer.id}.control.jsonl`), '{"event":"tool"}\n');
    await writeFile(join(state.paths.audits, `${computer.id}.network.jsonl`), '{"event":"egress"}\n');
    const backup = join(state.paths.backups, 'storage-test-backup');
    await mkdir(backup);
    await writeFile(join(backup, 'manifest.json'), JSON.stringify({ source: { id: computer.id } }));
    await writeFile(join(backup, 'home.tar'), 'backup bytes\n');

    await storageCommand({
      positionals: ['set', computer.name],
      options: new Map([['home-warning', '1k'], ['backup-warning', '1k']]),
    });
    const persisted = YAML.parse(await readFile(state.paths.config, 'utf8')) as { computers: Array<{ storage?: Record<string, number> }> };
    assert.deepEqual(persisted.computers[0]?.storage, { homeWarningBytes: 1_000, backupWarningBytes: 1_000 });

    await storageCommand({ positionals: ['show', computer.name], options: new Map() });
    const report = JSON.parse(output.at(-1)!) as {
      accounting: { home: { bytes: number }; audit: { bytes: number; complete: boolean }; backups: { bytes: number } };
      warnings: string[];
    };
    assert.ok(report.accounting.home.bytes > 0);
    assert.ok(report.accounting.audit.bytes > 0);
    assert.equal(report.accounting.audit.complete, true);
    assert.ok(report.accounting.backups.bytes > 0);
    assert.ok(report.warnings.some((warning) => warning.includes('home usage')));
    assert.ok(report.warnings.some((warning) => warning.includes('backup usage')));

    await assert.rejects(storageCommand({ positionals: ['set', computer.name], options: new Map() }), /requires --home-warning or --backup-warning/u);
    await assert.rejects(storageCommand({ positionals: ['set', computer.name], options: new Map([['home-warning', 'huge']]) }), /must be bytes or a size/u);
    await assert.rejects(storageCommand({ positionals: ['remove', computer.name], options: new Map() }), /Unknown storage action/u);
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.QUBICL_HOME;
    else process.env.QUBICL_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
