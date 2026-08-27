import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBrokerTarget, redactCredentialText } from '../../packages/control/dist/egress.js';
import { isGloballyRoutableIp } from '../../packages/control/dist/network-address.js';

test('restricted egress accepts only globally routable IPv4 and IPv6 forms', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isGloballyRoutableIp(address), true, address);
  }
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1',
    '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '100::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:c0a8:1', '2002:7f00:1::1', '2001::1',
  ]) {
    assert.equal(isGloballyRoutableIp(address), false, address);
  }
});

test('credential broker scopes the canonical URL and rejects ambiguous paths', () => {
  assert.equal(
    canonicalBrokerTarget('https://api.example.com', '/v1/projects/one?view=full', '/v1/projects').toString(),
    'https://api.example.com/v1/projects/one?view=full',
  );
  for (const path of [
    '/v1/projects/../admin',
    '/v1/projects/%2e%2e/admin',
    '/v1/projects%2f..%2fadmin',
    '/v1/projects//admin',
    '/v1/projects\\..\\admin',
    '/v1/projects#fragment',
    '//attacker.example/path',
  ]) assert.throws(() => canonicalBrokerTarget('https://api.example.com', path, '/v1/projects'), /ambiguous|dot segment|change origin/);
  assert.throws(() => canonicalBrokerTarget('https://api.example.com', '/v1/projector', '/v1/projects'), /does not allow/);
  assert.throws(() => canonicalBrokerTarget('http://api.example.com', '/v1/projects', '/v1/projects'), /HTTPS/);
});

test('credential broker removes reflected exact secrets', () => {
  assert.equal(redactCredentialText('echo secret-value and secret-value', 'secret-value'), 'echo [REDACTED] and [REDACTED]');
});
