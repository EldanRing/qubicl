import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditCommand } from '../../packages/cli/dist/audit-log.js';
import { parseArgs } from '../../packages/cli/dist/args.js';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { initializeState, saveMetadata, saveState, statePaths } from '../../packages/cli/dist/state.js';

test('audit prune retains the requested tail and --keep 0 empties a disposable audit stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-audit-test-'));
  const previous = process.env.QUBICL_HOME;
  process.env.QUBICL_HOME = root;
  try {
    const state = await initializeState(statePaths(root));
    const computer = addConfiguredComputer(state, 'audit-test');
    computer.controlProtocolVersion = 10;
    await saveMetadata(state.paths, computer);
    await saveState(state);
    await mkdir(state.paths.audits, { recursive: true });
    const path = join(state.paths.audits, `${computer.id}.jsonl`);
    const events = ['{"event":1}', '{"event":2}', '{"event":3}'];
    await writeFile(path, `${events.join('\n')}\n`);
    await auditCommand(parseArgs(['prune', computer.name, '--keep', '2', '--yes']));
    assert.equal(await readFile(path, 'utf8'), `${events.slice(1).join('\n')}\n`);
    await auditCommand(parseArgs(['prune', computer.name, '--keep', '0', '--yes']));
    assert.equal(await readFile(path, 'utf8'), '');
  } finally {
    if (previous === undefined) delete process.env.QUBICL_HOME;
    else process.env.QUBICL_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
