import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { buildComputerManifest, toolDefinitions } from '@qubicl/core';
import { validatePublicWebUrl } from '@qubicl/control/browser';
import { ToolExecutor } from '@qubicl/control/executor';
import { RuntimePolicy } from '@qubicl/control/policy';
import { createWebServer, LocalWebProvider } from '@qubicl/control/web';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

test('web tool schemas bound queries, result counts, extraction sizes, and rendering modes', () => {
  const lease = { id: 'a'.repeat(32), generation: 1, epoch: 'b'.repeat(16) };
  assert.equal(toolDefinitions.web_search.input.safeParse({ lease, query: 'Qubicl' }).success, true);
  assert.equal(toolDefinitions.web_search.input.safeParse({ lease, query: 'Qubicl', limit: 21 }).success, false);
  assert.equal(toolDefinitions.web_extract.input.safeParse({ lease, url: 'https://example.com/' }).success, true);
  assert.equal(toolDefinitions.web_extract.input.safeParse({ lease, url: 'file:///etc/passwd' }).success, false);
  assert.equal(toolDefinitions.web_extract.input.safeParse({ lease, url: 'https://example.com/', maxChars: 100_001 }).success, false);
  assert.equal(toolDefinitions.web_extract.input.safeParse({ lease, url: 'https://example.com/', render: 'sometimes' }).success, false);
});

test('web URL validation rejects credentials and non-public DNS destinations', async () => {
  assert.equal(await validatePublicWebUrl('https://example.com/path', PUBLIC_LOOKUP), 'https://example.com/path');
  await assert.rejects(validatePublicWebUrl('https://user:secret@example.com/', PUBLIC_LOOKUP), /credentials/);
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '2001:db8::1']) {
    const resolver = async () => [{ address, family: address.includes(':') ? 6 : 4 }];
    await assert.rejects(validatePublicWebUrl('https://example.com/', resolver), /non-public/);
  }
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(validatePublicWebUrl('https://example.com/', mixed), /non-public/, 'every DNS answer must be public');
  assert.equal(await validatePublicWebUrl('https://example.com/', async () => [{ address: '::ffff:93.184.216.34', family: 6 }]), 'https://example.com/');
  await assert.rejects(validatePublicWebUrl('https://example.com/', async () => [{ address: '::ffff:127.0.0.1', family: 6 }]), /non-public/);
});

test('isolated web service authenticates and delegates stable search/extract results', { concurrency: false }, async () => {
  const prior = process.env.QUBICL_RUNNER_KEY;
  process.env.QUBICL_RUNNER_KEY = 'w'.repeat(43);
  const provider = {
    search: async ({ query, limit }: { query: string; limit: number }) => ({ query, limit, provider: 'ddgs', results: [] }),
    extract: async ({ url }: { url: string }) => ({ finalUrl: url, contentType: 'text/html', extractionMethod: 'local-html', content: 'ok', truncated: false }),
    extractRendered: async ({ finalUrl }: { finalUrl: string }) => ({ finalUrl, contentType: 'text/html', extractionMethod: 'browser', content: 'rendered', truncated: false }),
  };
  const server = createWebServer(provider);
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/search`, { method: 'POST', body: '{}' })).status, 401);
    const searched = await fetch(`http://127.0.0.1:${port}/v1/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-qubicl-runner-key': 'w'.repeat(43) }, body: JSON.stringify({ query: 'test', limit: 5 }),
    });
    assert.deepEqual(await searched.json(), { query: 'test', limit: 5, provider: 'ddgs', results: [] });
    const rendered = await fetch(`http://127.0.0.1:${port}/v1/extract-rendered`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qubicl-runner-key': 'w'.repeat(43) },
      body: JSON.stringify({ finalUrl: 'https://example.com/', title: 'Rendered', contentType: 'text/html', html: '<main>rendered</main>', sourceTruncated: false, format: 'markdown', maxChars: 1000 }),
    });
    assert.deepEqual(await rendered.json(), { finalUrl: 'https://example.com/', contentType: 'text/html', extractionMethod: 'browser', content: 'rendered', truncated: false });
    const oversized = await fetch(`http://127.0.0.1:${port}/v1/extract-rendered`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qubicl-runner-key': 'w'.repeat(43) },
      body: JSON.stringify({ finalUrl: 'https://example.com/', title: '', contentType: 'text/html', html: 'x'.repeat(3_200_000), sourceTruncated: false, format: 'text', maxChars: 1000 }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
    if (prior === undefined) delete process.env.QUBICL_RUNNER_KEY; else process.env.QUBICL_RUNNER_KEY = prior;
  }
});

test('local provider reports normalized upstream, rate-limit, malformed, and timeout failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-web-provider-'));
  try {
    const script = join(directory, 'provider.mjs');
    await writeFile(script, `
process.stdin.resume();
const operation = process.argv[2];
if (operation === 'search') process.stdout.write(JSON.stringify({query:'q',provider:'ddgs',results:[{title:'T',url:'https://example.com',description:'D'}]}));
else process.stdout.write(JSON.stringify({finalUrl:'https://example.com',contentType:'text/plain',extractionMethod:'local-text',content:'body',truncated:false}));
`);
    const provider = new LocalWebProvider(process.execPath, script, 1000);
    assert.equal(((await provider.search({ query: 'q', limit: 1 })).results as unknown[]).length, 1);
    assert.equal((await provider.extract({ url: 'https://example.com', format: 'text', maxChars: 100 })).content, 'body');
    assert.equal((await provider.extractRendered({ finalUrl: 'https://example.com', title: '', contentType: 'text/html', html: '<p>body</p>', sourceTruncated: false, format: 'text', maxChars: 100 })).content, 'body');

    await writeFile(script, `process.stdin.resume();process.stdout.write(JSON.stringify({error:{code:'web_rate_limited',message:'limited'}}));`);
    await assert.rejects(new LocalWebProvider(process.execPath, script, 1000).search({ query: 'q', limit: 1 }), (error: Error & { status?: number }) => error.status === 429);
    await writeFile(script, `process.stdin.resume();process.stdout.write(JSON.stringify({error:{code:'network_policy_denied',message:'offline'}}));process.exitCode=2;`);
    await assert.rejects(new LocalWebProvider(process.execPath, script, 1000).search({ query: 'q', limit: 1 }), (error: Error & { status?: number }) => error.status === 403);
    await writeFile(script, `process.stdin.resume();process.stdout.write('{}');`);
    await assert.rejects(new LocalWebProvider(process.execPath, script, 1000).search({ query: 'q', limit: 1 }), /malformed/);
    await writeFile(script, `setTimeout(()=>process.stdout.write('{}'),1000);`);
    await assert.rejects(new LocalWebProvider(process.execPath, script, 20).search({ query: 'q', limit: 1 }), /time limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('executor exposes native web tools, supports browser fallback, and fails closed after policy disablement', async () => {
  const web = {
    search: async ({ query, limit }: { query: string; limit: number }) => ({ query, provider: 'ddgs', results: Array.from({ length: limit }, () => ({ title: 'T', url: 'https://example.com', description: 'D' })) }),
    extract: async ({ url }: { url: string }) => ({ finalUrl: url, contentType: 'text/html', extractionMethod: 'local-html', content: '', truncated: false, browserRecommended: true }),
    extractRendered: async ({ finalUrl, html }: { finalUrl: string; html: string }) => ({ finalUrl, contentType: 'text/html', extractionMethod: 'browser', content: html.includes('rendered') ? 'rendered' : '', truncated: false }),
  };
  const browser = { count: () => 1, renderForExtraction: async () => ({ finalUrl: 'https://example.com/app', title: 'App', contentType: 'text/html', html: '<main>rendered</main>', sourceTruncated: false }), shutdown: async () => undefined };
  const executor = new ToolExecutor(undefined, { web, browser: browser as never });
  const lease = executor.leases.acquire(60);
  const search = await executor.call('web_search', { lease, query: 'q', limit: 2 }) as { results: unknown[]; contentTrust: { level: string; risk: string } };
  assert.equal(search.results.length, 2);
  assert.deepEqual(search.contentTrust, { level: 'untrusted', source: 'web', scanner: 'qubicl-content-security-v1', risk: 'no-known-patterns', findings: [] });
  const extraction = await executor.call('web_extract', { lease, url: 'https://example.com/app', render: 'auto' }) as { extractionMethod: string; contentTrust: { level: string } };
  assert.equal(extraction.extractionMethod, 'browser');
  assert.equal(extraction.contentTrust.level, 'untrusted');
  await executor.shutdown();

  const directory = await mkdtemp(join(tmpdir(), 'qubicl-web-policy-'));
  try {
    const manifest = buildComputerManifest('file-system', 'test', 'test');
    const policyPath = join(directory, 'policy.json');
    const tools = manifest.tools.filter((name) => name !== 'web_search');
    await writeFile(policyPath, JSON.stringify({ version: 1, revision: 'disabled', tools, catalogSkills: [], skillRegistrySha256: 'not-initialized' }));
    const policy = new RuntimePolicy(manifest, policyPath);
    await policy.load();
    const denied = new ToolExecutor({ manifest, sha256: '0'.repeat(64) }, { policy, web });
    const deniedLease = denied.leases.acquire(60);
    await assert.rejects(denied.call('web_search', { lease: deniedLease, query: 'q' }), /disabled/);
    await assert.rejects(denied.call('web_extract', { lease: deniedLease, url: 'https://example.com', render: 'browser' }), /Browser-rendered extraction requires/);
    await denied.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
