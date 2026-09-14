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
  const parsed = parseArgs(['--gateway-port', '4321', '--default-cpus=3', '--update-notifications', 'on', '--transport', 'stdio', '--profile', 'files', '--result-mode', 'text', '--verbose', '--no-clear', '--json']);
  assert.equal(parsed.options.get('gateway-port'), '4321');
  assert.equal(parsed.options.get('default-cpus'), '3');
  assert.equal(parsed.options.get('update-notifications'), 'on');
  assert.equal(parsed.options.get('transport'), 'stdio');
  assert.equal(parsed.options.get('profile'), 'files');
  assert.equal(parsed.options.get('result-mode'), 'text');
  assert.equal(parsed.options.get('verbose'), true);
  assert.equal(parsed.options.get('no-clear'), true);
  assert.equal(parsed.options.get('json'), true);
  assert.throws(() => parseArgs(['--show-secrets']), /Unknown option/);
});

test('argument parsing accepts explicit gateway exposure controls without treating values as flags', () => {
  const parsed = parseArgs([
    '--bind', '0.0.0.0',
    '--port', '443',
    '--hostname', 'gateway.example.test',
    '--cert', '/tmp/certificate.pem',
    '--key', '/tmp/private-key.pem',
    '--client-ca', '/tmp/client-ca.pem',
    '--allow-networks', '192.0.2.0/24,2001:db8::/32',
    '--trusted-origins', 'https://client.example.test',
    '--preview-domain', 'preview.example.test',
    '--access', 'remote',
    '--all-interfaces',
    '--allow-all-clients',
  ]);
  assert.equal(parsed.options.get('bind'), '0.0.0.0');
  assert.equal(parsed.options.get('port'), '443');
  assert.equal(parsed.options.get('hostname'), 'gateway.example.test');
  assert.equal(parsed.options.get('cert'), '/tmp/certificate.pem');
  assert.equal(parsed.options.get('key'), '/tmp/private-key.pem');
  assert.equal(parsed.options.get('client-ca'), '/tmp/client-ca.pem');
  assert.equal(parsed.options.get('allow-networks'), '192.0.2.0/24,2001:db8::/32');
  assert.equal(parsed.options.get('trusted-origins'), 'https://client.example.test');
  assert.equal(parsed.options.get('preview-domain'), 'preview.example.test');
  assert.equal(parsed.options.get('access'), 'remote');
  assert.equal(parsed.options.get('all-interfaces'), true);
  assert.equal(parsed.options.get('allow-all-clients'), true);
  assert.throws(() => parseArgs(['--all-interfaces=yes']), /does not take a value/);
  assert.throws(() => parseArgs(['--allow-all-clients=yes']), /does not take a value/);
});

test('skills enable supports both an import flag and a policy value', () => {
  assert.equal(parseArgs(['--enable', '--yes']).options.get('enable'), true);
  assert.equal(parseArgs(['--enable', 'plan']).options.get('enable'), 'plan');
  assert.equal(parseArgs(['--enable=plan']).options.get('enable'), 'plan');
});


test('dashboard foreground and isolated asset port options are parsed without consuming actions', () => {
  const parsed = parseArgs(['enable', '--foreground', '--asset-port', '4321']);
  assert.deepEqual(parsed.positionals, ['enable']);
  assert.equal(parsed.options.get('foreground'), true);
  assert.equal(parsed.options.get('asset-port'), '4321');
});

test('argument parsing accepts every value-bearing 0.6 management option', () => {
  const values = new Map([
    ['viewer-reconnect-grace', '30'], ['target-root', '/tmp/imported'],
    ['max-concurrent', '8'], ['max-lifetime', '3600'], ['max-output', '10000000'], ['retention', '7200'],
    ['home-warning', '20g'], ['backup-warning', '50g'],
    ['allow-cidrs', '10.0.0.0/24'], ['allow-tcp-ports', '3000,5432'], ['template', 'github'],
  ]);
  const parsed = parseArgs([...values].flatMap(([name, value]) => [`--${name}`, value]));
  assert.deepEqual(parsed.options, values);
});
