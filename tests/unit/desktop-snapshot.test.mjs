import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('native snapshots prioritize visible controls and preserve bounded pagination and refs', () => {
  const result = spawnSync('python3', ['-I', '-B', 'tests/fixtures/desktop-snapshot.py'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
