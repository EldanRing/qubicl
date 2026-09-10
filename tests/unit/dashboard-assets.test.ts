import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { VerifiedDashboardAssetLoader } from '../../packages/cli/dist/dashboard/assets.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');

interface ManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
  cache: 'no-store' | 'immutable';
}

interface Manifest { schemaVersion: number; entrypoint: string; assets: ManifestEntry[] }

test('dashboard asset loader clears trust only for an explicitly supplied digest', () => {
  const loader = new VerifiedDashboardAssetLoader({ endpoint: 'http://127.0.0.1:3213', expectedManifestSha256: 'a'.repeat(64) });
  assert.equal(loader.updateExpectedManifestSha256('b'.repeat(64)), true);
  assert.equal(loader.updateExpectedManifestSha256('b'.repeat(64)), false);
  assert.throws(() => loader.updateExpectedManifestSha256('not-a-digest'));
});

test('dashboard build emits a complete content-addressed static set', async () => {
  const output = join(tmpdir(), `qubicl-dashboard-assets-${process.pid}-${Date.now()}`);
  try {
    await run(process.execPath, ['scripts/build-dashboard.mjs', '--out-dir', output]);
    const manifestBytes = await readFile(join(output, 'asset-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.entrypoint, '/index.html');
    assert.deepEqual(manifest.assets.map(({ path }) => path), [...manifest.assets.map(({ path }) => path)].sort());
    assert.ok(manifest.assets.some(({ path }) => /^\/assets\/app-[A-Z0-9]+\.js$/.test(path)));
    assert.ok(manifest.assets.some(({ path }) => /^\/assets\/app-[A-Z0-9]+\.css$/.test(path)));
    assert.ok(manifest.assets.some(({ path }) => path === '/assets/qubicl-mark.svg'));
    assert.ok(manifest.assets.some(({ path }) => path === '/index.html'));
    assert.equal(manifest.assets.some(({ path }) => path === '/server.mjs'), false);
    const browserMetafile = JSON.parse(await readFile(join(output, 'browser-metafile.json'), 'utf8')) as { inputs?: unknown; outputs?: unknown };
    const serverMetafile = JSON.parse(await readFile(join(output, 'server-metafile.json'), 'utf8')) as { inputs?: unknown; outputs?: unknown };
    assert.ok(browserMetafile.inputs && browserMetafile.outputs);
    assert.ok(serverMetafile.inputs && serverMetafile.outputs);

    for (const asset of manifest.assets) {
      const bytes = await readFile(join(output, 'public', asset.path));
      assert.equal(bytes.byteLength, asset.bytes, asset.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.path);
      assert.equal(asset.cache, asset.path.startsWith('/assets/') ? 'immutable' : 'no-store', asset.path);
    }

    const html = await readFile(join(output, 'public/index.html'), 'utf8');
    assert.match(html, /<script type="module" src="\/assets\/app-[A-Z0-9]+\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/app-[A-Z0-9]+\.css">/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('dashboard static server exposes only manifest assets through GET and HEAD', async () => {
  const output = join(tmpdir(), `qubicl-dashboard-server-${process.pid}-${Date.now()}`);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await run(process.execPath, ['scripts/build-dashboard.mjs', '--out-dir', output]);
    child = spawn(process.execPath, [join(output, 'server.mjs')], {
      cwd: repositoryRoot,
      env: { ...process.env, QUBICL_DASHBOARD_HOST: '127.0.0.1', QUBICL_DASHBOARD_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = await firstLine(child);
    const match = line.match(/127\.0\.0\.1:(\d+)/);
    assert.ok(match);
    const origin = `http://127.0.0.1:${match[1]}`;

    const index = await fetch(`${origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(index.headers.get('cache-control'), 'no-store');
    assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');

    const manifestBytes = await readFile(join(output, 'asset-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
    const script = manifest.assets.find(({ path }) => path.endsWith('.js'));
    assert.ok(script);
    const scriptResponse = await fetch(`${origin}${script.path}`, { method: 'HEAD' });
    assert.equal(scriptResponse.status, 200);
    assert.equal(scriptResponse.headers.get('content-length'), String(script.bytes));
    assert.match(scriptResponse.headers.get('cache-control') ?? '', /immutable/);
    assert.equal(await scriptResponse.text(), '');

    const health = await fetch(`${origin}/health`);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const servedManifest = await fetch(`${origin}/asset-manifest.json`);
    assert.equal(servedManifest.status, 200);
    assert.deepEqual(await servedManifest.json(), manifest);
    const loader = new VerifiedDashboardAssetLoader({
      endpoint: origin,
      expectedManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    });
    assert.match((await loader.load('/')).contentType, /^text\/html/);
    assert.equal((await loader.load(script.path)).bytes.byteLength, script.bytes);
    await assert.rejects(loader.load('/server.mjs'), /not found/i);
    assert.equal((await fetch(`${origin}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    const post = await fetch(`${origin}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  } finally {
    child?.kill('SIGTERM');
    await rm(output, { recursive: true, force: true });
  }
});

test('dashboard image is an unprivileged static-only runtime', async () => {
  const dockerfile = await readFile(join(repositoryRoot, 'images/dashboard/Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:22-alpine@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^COPY --chown=node:node server\.mjs asset-manifest\.json \/app\/$/m);
  assert.match(dockerfile, /^ARG QUBICL_ASSET_MANIFEST_SHA256=unknown$/m);
  assert.match(dockerfile, /dev\.qubicl\.asset-manifest-sha256="\$QUBICL_ASSET_MANIFEST_SHA256"/);
  assert.match(dockerfile, /^EXPOSE 3213$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*127\.0\.0\.1:3213\/health/m);
  assert.match(dockerfile, /^ENTRYPOINT \["node", "\/app\/server\.mjs"\]$/m);
  assert.doesNotMatch(dockerfile, /(?:TOKEN|PASSWORD|SECRET|KEY)=/);
  assert.equal((await stat(join(repositoryRoot, 'images/dashboard/Dockerfile'))).isFile(), true);
});

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}: ${output}`)));
  });
}

async function firstLine(child: ReturnType<typeof spawn>): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Dashboard server did not start: ${output}`)), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timeout);
        resolvePromise(output.slice(0, newline));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timeout); reject(new Error(`Dashboard server exited with ${code}: ${output}`)); } });
  });
}
