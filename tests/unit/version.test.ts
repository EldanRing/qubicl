import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  numericVersion,
  QUBICL_BUILD,
  supportedNodeVersion,
  versionAtLeast,
} from '../../packages/core/dist/index.js';

const exec = promisify(execFile);

test('build metadata is exposed by the CLI', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  const { stdout } = await exec(process.execPath, ['packages/cli/dist/qubicl.mjs', '--version']);
  const version = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(stdout, new RegExp(`^qubicl ${version} \\([a-f0-9]{40}(?:-dirty)?\\)\\n$`));
});

test('support version parsing enforces declared floors and Node lines', () => {
  assert.deepEqual(numericVersion('Docker version 28.4.0, build abc'), [28, 4, 0]);
  assert.equal(versionAtLeast('v2.24.0', '2.24.0'), true);
  assert.equal(versionAtLeast('2.23.9', '2.24.0'), false);
  assert.equal(supportedNodeVersion('22.14.0'), true);
  assert.equal(supportedNodeVersion('22.13.1'), false);
  assert.equal(supportedNodeVersion('23.11.0'), false);
  assert.equal(supportedNodeVersion('24.0.0'), true);
  assert.equal(supportedNodeVersion('25.0.0'), false);
});

test('unbundled core uses neutral development metadata', () => {
  assert.equal(QUBICL_BUILD.version, 'development');
  assert.equal(QUBICL_BUILD.revision, 'development');
  assert.equal(QUBICL_BUILD.date, 'unknown');
});
