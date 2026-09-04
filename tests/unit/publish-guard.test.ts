import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

test('npm publish guard executes its approval, version, tag, and provenance checks', () => {
  for (const [version, approval, tag, provenance, allowed] of [
    ['0.2.0', '0.2.0', 'latest', 'false', true],
    ['0.3.0-dev.1', '0.3.0-dev.1', 'dev', 'false', true],
    ['0.2.0', '', 'latest', 'false', false],
    ['', '', 'latest', 'false', false],
    ['0.2.0', '0.1.0', 'latest', 'false', false],
    ['0.2.0', '0.2.0', 'dev', 'false', false],
    ['0.3.0-dev.1', '0.3.0-dev.1', 'latest', 'false', false],
    ['0.2.0', '0.2.0', 'latest', 'true', false],
  ] as const) {
    const result = spawnSync(process.execPath, [resolve('scripts/guard-publish.mjs')], {
      encoding: 'utf8', env: { npm_package_version: version, QUBICL_ALLOW_NPM_PUBLISH: approval, npm_config_tag: tag, npm_config_provenance: provenance },
    });
    assert.equal(result.status, allowed ? 0 : 1, JSON.stringify({ version, approval, tag, provenance, stderr: result.stderr }));
  }
});
