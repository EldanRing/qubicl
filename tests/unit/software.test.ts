import assert from 'node:assert/strict';
import test from 'node:test';
import { SoftwareRecipeSchema } from '@qubicl/core';
import { softwareDockerfile } from '../../packages/cli/dist/software.js';
import { workloadEnvironment } from '../../packages/control/dist/environments.js';

test('system package recipes require immutable bases and reject command injection', () => {
  const base = `sha256:${'a'.repeat(64)}`;
  const recipe = { baseImage: 'example/base:1', aptPackages: ['jq', 'ripgrep=14.1.1-1'] };
  assert.match(softwareDockerfile(base, recipe), /apt-get install -y --no-install-recommends jq ripgrep=14\.1\.1-1/);
  assert.throws(() => softwareDockerfile('example/base:latest', recipe), /immutable/);
  for (const packageName of ['jq; touch /host', '-oAPT::Update::Pre-Invoke=evil', 'jq\nRUN evil', '../package.deb']) {
    assert.equal(SoftwareRecipeSchema.safeParse({ ...recipe, aptPackages: [packageName] }).success, false);
  }
});

test('workload packages use durable locations without inheriting host credentials', () => {
  const env = workloadEnvironment({ PATH: '/host/bin', AWS_SECRET_ACCESS_KEY: 'secret', QUBICL_INTERNAL_KEY: 'private' }, '/home/test');
  assert.equal(env.npm_config_prefix, '/home/test/.local');
  assert.equal(env.VIRTUAL_ENV, '/home/test/.local/share/qubicl/python/current');
  assert(env.PATH?.includes(`${env.VIRTUAL_ENV}/bin`));
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.QUBICL_INTERNAL_KEY, undefined);
});
