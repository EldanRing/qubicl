import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions } from '../../packages/cli/dist/update-command.js';

test('update version comparison handles stable and prerelease versions', () => {
  assert.equal(compareVersions('0.6.0', '0.5.1') > 0, true);
  assert.equal(compareVersions('0.6.0', '0.6.0'), 0);
  assert.equal(compareVersions('0.6.0-beta.1', '0.6.0') < 0, true);
  assert.equal(compareVersions('1.0.0', '0.99.99') > 0, true);
});
