import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '../../packages/cli/dist/args.js';

test('argument parsing supports explicit option termination', () => {
  const parsed = parseArgs(['--dry-run', '--', '--literal']);
  assert.equal(parsed.options.get('dry-run'), true);
  assert.deepEqual(parsed.positionals, ['--literal']);
});

test('argument parsing rejects ambiguous and unknown options', () => {
  assert.throws(() => parseArgs(['--dry-run', '--dry-run']), /provided more than once/);
  assert.throws(() => parseArgs(['--dry-run=yes']), /does not take a value/);
  assert.throws(() => parseArgs(['--surprise']), /Unknown option/);
  assert.throws(() => parseArgs(['--image']), /requires a value/);
});

test('argument parsing accepts configuration, connection, setup display, and JSON options', () => {
  const parsed = parseArgs(['--gateway-port', '4321', '--default-cpus=3', '--transport', 'stdio', '--profile', 'files', '--result-mode', 'text', '--verbose', '--no-clear', '--json']);
  assert.equal(parsed.options.get('gateway-port'), '4321');
  assert.equal(parsed.options.get('default-cpus'), '3');
  assert.equal(parsed.options.get('transport'), 'stdio');
  assert.equal(parsed.options.get('profile'), 'files');
  assert.equal(parsed.options.get('result-mode'), 'text');
  assert.equal(parsed.options.get('verbose'), true);
  assert.equal(parsed.options.get('no-clear'), true);
  assert.equal(parsed.options.get('json'), true);
  assert.throws(() => parseArgs(['--show-secrets']), /Unknown option/);
});

test('skills enable supports both an import flag and a policy value', () => {
  assert.equal(parseArgs(['--enable', '--yes']).options.get('enable'), true);
  assert.equal(parseArgs(['--enable', 'plan']).options.get('enable'), 'plan');
  assert.equal(parseArgs(['--enable=plan']).options.get('enable'), 'plan');
});
