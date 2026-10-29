import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { authorizeTarget, canonicalBrokerTarget, decodeBrokerResponse, type EgressNetworkPolicy } from '../../packages/control/dist/egress.js';

test('broker scopes the pathname independently from URL and escaped-slash query values', () => {
  for (const query of ['next=https://example.test/a/b', 'key=a%2Fb%5Cc%2E', 'next=%2F..%2Foutside', 'query=one//two', 'q=\\path']) {
    const path = `/v1/projects/one?${query}`;
    const target = canonicalBrokerTarget('https://api.example.test', path, '/v1/projects');
    assert.equal(target.pathname, '/v1/projects/one');
    assert.equal(target.search, `?${query}`);
  }
  for (const path of ['/v1/projects/../outside?q=ok', '/v1/projects/%2E%2e/outside?q=ok', '/v1/projects%2foutside', '/v1/projects\\outside', '//other.test/v1/projects', '/v1/pro\tjects', '/v1/projects?x=1#fragment']) {
    assert.throws(() => canonicalBrokerTarget('https://api.example.test', path, '/v1/projects'), /ambiguous|dot segment/);
  }
  assert.throws(() => canonicalBrokerTarget('https://api.example.test', '/v1/projects-extra?x=/v1/projects', '/v1/projects'), /does not allow/);
  assert.throws(() => canonicalBrokerTarget('https://api.example.test', '/v1/projects', '/v1/projects?scope=ignored'), /change origin/);
});

test('broker decodes bounded gzip, deflate, Brotli and stacked text before secret redaction', async () => {
  const secret = 'fixture-secret';
  const text = JSON.stringify({ title: 'café', reflected: secret });
  const expected = text.replace(secret, '[REDACTED]');
  for (const [encoding, data] of [
    ['gzip', gzipSync(text)], ['deflate', deflateSync(text)], ['br', brotliCompressSync(text)],
    ['gzip, br', brotliCompressSync(gzipSync(text))],
  ] as const) {
    const result = await decodeBrokerResponse({
      'content-type': 'application/problem+json', 'content-encoding': encoding,
      'content-length': String(data.length), 'set-cookie': [`secret=${secret}`],
      'x-reflected': secret, etag: 'old-representation', 'transfer-encoding': 'chunked',
    }, data, secret);
    assert.equal(result.bodyEncoding, 'utf8');
    assert.equal(result.body, expected);
    assert.equal(result.sourceContentEncoding, encoding);
    assert.equal(result.headers['content-length'], String(Buffer.byteLength(expected)));
    assert.equal(result.headers['content-encoding'], undefined);
    assert.equal(result.headers['transfer-encoding'], undefined);
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers['x-reflected'], '[REDACTED]');
  }
});

test('broker binary and invalid UTF-8 responses preserve non-secret bytes with truthful encoding', async () => {
  const data = Buffer.from([0xff, 0, 0x80, 0x41]);
  for (const contentType of ['application/octet-stream', 'application/json']) {
    const result = await decodeBrokerResponse({ 'content-type': contentType, 'content-encoding': 'gzip' }, gzipSync(data), 'unused-secret');
    assert.equal(result.bodyEncoding, 'base64');
    assert.deepEqual(Buffer.from(result.body, 'base64'), data);
  }
  const binary = Buffer.concat([data, Buffer.from('fixture-secret'), data]);
  const result = await decodeBrokerResponse({ 'content-type': 'application/octet-stream', 'content-encoding': 'br' }, brotliCompressSync(binary), 'fixture-secret');
  assert.deepEqual(Buffer.from(result.body, 'base64'), Buffer.concat([data, Buffer.from('[REDACTED]'), data]));
});

test('broker rejects corrupt, unsupported, oversized wire and expanded responses with bounded errors', async () => {
  const compressed = gzipSync('valid');
  for (const data of [Buffer.from('not gzip'), compressed.subarray(0, compressed.length - 4)]) {
    await assert.rejects(decodeBrokerResponse({ 'content-encoding': 'gzip' }, data, ''), { code: 'broker_invalid_encoding', status: 502 });
  }
  await assert.rejects(decodeBrokerResponse({ 'content-encoding': 'unknown-codec' }, Buffer.from('opaque'), ''), { code: 'broker_encoding_unsupported' });
  await assert.rejects(decodeBrokerResponse({}, Buffer.alloc(2_000_001), ''), { code: 'broker_response_too_large' });
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const) {
    await assert.rejects(decodeBrokerResponse({ 'content-encoding': encoding }, compress(Buffer.alloc(2_000_001, 'x')), ''), { code: 'broker_response_too_large' });
  }
});

test('IPv6 URL literals authorize without DNS and retain CIDR, port, deny and temporary scopes', async () => {
  const policy: EgressNetworkPolicy = { profile: 'custom', allowDomains: [], denyDomains: [], allowCidrs: ['::1/128'], allowTcpPorts: [8443], temporaryApprovals: [] };
  assert.deepEqual(await authorizeTarget(new URL('https://[::1]:8443/').hostname, 8443, policy), { address: '::1' });
  await assert.rejects(authorizeTarget('[::2]', 8443, policy), { code: 'network_policy_denied' });
  await assert.rejects(authorizeTarget('[::1]', 8444, policy), { code: 'network_policy_denied' });
  const denied = { ...policy, denyDomains: ['[::1]'] };
  await assert.rejects(authorizeTarget('::1', 8443, denied), { code: 'network_policy_denied' });
  await assert.rejects(authorizeTarget('[0:0:0:0:0:0:0:1]', 8443, denied), { code: 'network_policy_denied' });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(await authorizeTarget('[::1]', 8443, { ...denied, temporaryApprovals: [{ domain: '::1', expiresAt }] }), { address: '::1', expiresAt: Date.parse(expiresAt) });
  const web = { ...policy, profile: 'web-only' as const, allowCidrs: [], allowTcpPorts: [] };
  await assert.rejects(authorizeTarget('[::1]', 443, web), { code: 'network_policy_denied' });
  assert.deepEqual(await authorizeTarget('[2606:4700:4700::1111]', 443, web), { address: '2606:4700:4700::1111' });
});
