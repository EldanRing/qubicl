import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OpenTerminalCompatibility } from '@qubicl/control/open-terminal';
import { ToolExecutor } from '@qubicl/control/executor';
import { PreviewManager } from '../../packages/control/dist/previews.js';
import type { BrowserManager } from '@qubicl/control/browser';
import { enabledToolNames, PRESET_DEFINITIONS } from '@qubicl/core';
import { BoundedFileSystem, type BoundedFileHookEvent } from '@qubicl/control/bounded-files';

test('Open Terminal compatibility provides native files through a transparent fenced lease', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-'));
  const previewTarget = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`published:${request.url}`);
  });
  await new Promise<void>((resolve) => previewTarget.listen(0, '127.0.0.1', resolve));
  const previewPort = (previewTarget.address() as { port: number }).port;
  const previews = new PreviewManager(
    { listPorts: async () => [{ port: previewPort, address: 'loopback', protocol: 'tcp', pid: process.pid, process: 'test-server' }] },
    '127.0.0.1',
    '/computers/test/previews',
    'http://gateway/computers/test/previews',
  );
  const browserPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XZRjCAAAAABJRU5ErkJggg==', 'base64');
  const browser = {
    count: () => 1,
    shutdown: async () => undefined,
    screenshot: async () => ({
      data: browserPng.toString('base64'),
      mimeType: 'image/png',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      url: 'https://example.test/',
      title: 'Example',
      fullPage: false,
    }),
  } as unknown as BrowserManager;
  const web = {
    search: async ({ query, limit }: { query: string; limit: number }) => ({ query, provider: 'ddgs', results: Array.from({ length: limit }, (_, index) => ({ title: `Result ${index + 1}`, url: `https://example.com/${index + 1}`, description: 'Keyless search result' })) }),
    extract: async ({ url }: { url: string }) => ({ finalUrl: url, contentType: 'text/html', extractionMethod: 'local-html', content: 'locally extracted', truncated: false }),
    extractRendered: async ({ finalUrl }: { finalUrl: string }) => ({ finalUrl, contentType: 'text/html', extractionMethod: 'browser', content: 'rendered', truncated: false }),
  };
  const executor = new ToolExecutor(undefined, { browser, web, durableRoot: home, previews });
  const enabled = enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities);
  const compatibility = new OpenTerminalCompatibility(executor, enabled, { home });
  const server = createServer(async (request, response) => {
    const handled = await compatibility.handle(request, response, new URL(request.url ?? '/', 'http://test.local'));
    if (!handled) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/open-terminal`;
  context.after(async () => {
    await compatibility.shutdown();
    await executor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => previewTarget.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  const config = await json(`${base}/api/config`) as { features: { terminal: boolean; notebooks: boolean; system: boolean }; home: string };
  assert.deepEqual(config.features, { terminal: false, notebooks: false, system: true });
  assert.equal(config.home, home);
  assert.equal(executor.leases.snapshot().controller, 'none', 'discovery must not seize control');

  const system = await json(`${base}/system`) as { prompt: string };
  assert.match(system.prompt, /host- or VM-derived/);
  assert.match(system.prompt, /effectiveResourceLimits/);

  const spec = await json(`${base}/openapi.json`) as {
    paths: Record<string, { post: { requestBody: { content: { 'application/json': { schema: { properties: Record<string, unknown> } } } } } }>;
  };
  assert.equal(Object.hasOwn(spec.paths, '/v1/tools/acquire_lease'), false);
  assert.equal(Object.hasOwn(spec.paths['/v1/tools/write_file']!.post.requestBody.content['application/json'].schema.properties, 'lease'), false);
  assert.equal(Object.hasOwn(spec.paths, '/v1/tools/web_search'), true);
  assert.equal(Object.hasOwn(spec.paths, '/v1/tools/web_extract'), true);
  assert.equal(Object.hasOwn(spec.paths, '/files/display'), true);

  assert.deepEqual(await json(`${base}/ports`), { ports: [] });
  const unpublishedProxy = await fetch(`${base}/proxy/${previewPort}/before`);
  assert.equal(unpublishedProxy.status, 404);
  assert.match(JSON.stringify(await unpublishedProxy.json()), /port_not_published/);
  const publication = await fetch(`${base}/v1/tools/publish_port`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: previewPort, expiresInSeconds: 300 }),
  });
  assert.equal(publication.status, 200);
  assert.deepEqual(await json(`${base}/ports`), {
    ports: [{ port: previewPort, address: 'loopback', protocol: 'tcp', pid: process.pid, process: 'test-server' }],
  });
  const publishedProxy = await fetch(`${base}/proxy/${previewPort}/hello?answer=42`);
  assert.equal(publishedProxy.status, 200);
  assert.equal(await publishedProxy.text(), 'published:/hello?answer=42');

  const search = await fetch(`${base}/v1/tools/web_search`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Qubicl', limit: 2 }),
  });
  assert.equal(search.status, 200);
  const searchResult = await search.json() as { results: unknown[]; contentTrust: { level: string; risk: string } };
  assert.equal(searchResult.results.length, 2);
  assert.deepEqual(searchResult.contentTrust, { level: 'untrusted', source: 'web', scanner: 'qubicl-content-security-v1', risk: 'no-known-patterns', findings: [] });

  const browserImage = await fetch(`${base}/v1/tools/browser_screenshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(browserImage.status, 200);
  assert.equal(browserImage.headers.get('content-type'), 'image/png');
  assert.equal(browserImage.headers.get('x-qubicl-content-trust'), 'untrusted');
  assert.equal(browserImage.headers.get('x-qubicl-content-source'), 'browser');
  assert.equal(browserImage.headers.get('x-qubicl-content-risk'), 'visual-unscanned');
  assert.equal(Buffer.from(await browserImage.arrayBuffer()).equals(browserPng), true);

  const imagePath = join(home, 'pixel.png');
  await writeFile(imagePath, browserPng);
  const fileImage = await fetch(`${base}/v1/tools/read_file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: imagePath }),
  });
  assert.equal(fileImage.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await fileImage.arrayBuffer()).equals(browserPng), true);

  const cwd = await json(`${base}/files/cwd`) as { cwd: string; root: { path: string; label: string } };
  assert.equal(cwd.cwd, home);
  assert.deepEqual(cwd.root, { path: home, label: 'Home' });

  assert.equal((await fetch(`${base}/files/mkdir`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'chat-one' },
    body: JSON.stringify({ path: 'documents' }),
  })).status, 200);
  assert.equal(executor.leases.snapshot().controller, 'agent');

  const form = new FormData();
  form.append('file', new Blob(['native file browser works\n'], { type: 'text/plain' }), 'note.txt');
  const upload = await fetch(`${base}/files/upload?directory=${encodeURIComponent(join(home, 'documents'))}`, {
    method: 'POST',
    headers: { 'x-session-id': 'chat-one' },
    body: form,
  });
  assert.equal(upload.status, 200);
  assert.deepEqual(await upload.json(), { path: join(home, 'documents', 'note.txt'), size: 26 });

  const listing = await json(`${base}/files/list?directory=${encodeURIComponent(join(home, 'documents'))}`) as {
    dir: string;
    entries: { name: string; type: string; size: number; modified: number; writable: boolean }[];
    writable: boolean;
  };
  assert.equal(listing.dir, join(home, 'documents'));
  assert.equal(listing.writable, true);
  assert.equal(listing.entries.length, 1);
  assert.deepEqual(
    { ...listing.entries[0], modified: typeof listing.entries[0]?.modified },
    { name: 'note.txt', type: 'file', size: 26, modified: 'number', writable: true },
  );

  await writeFile(join(home, 'documents', 'research-notes.md'), 'Primary needle appears here.\nA second line.\n');
  await writeFile(join(home, 'documents', '.hidden-note.md'), 'needle in hidden content\n');
  const setSessionCwd = await fetch(`${base}/files/cwd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'chat-one' },
    body: JSON.stringify({ path: join(home, 'documents') }),
  });
  assert.equal(setSessionCwd.status, 200);
  const fileSearchResponse = await fetch(`${base}/files/search?path=.&query=research&limit=5&type=file`, {
    headers: { 'x-session-id': 'chat-one' },
  });
  assert.equal(fileSearchResponse.status, 200);
  const fileSearch = await fileSearchResponse.json() as {
    results: Array<{ path: string; name: string; type: string }>;
  };
  assert.deepEqual(fileSearch.results.map(({ path, name, type }) => ({ path, name, type })), [{
    path: join(home, 'documents', 'research-notes.md'), name: 'research-notes.md', type: 'file',
  }]);
  const contentMatches = await json(`${base}/files/matches?path=${encodeURIComponent(join(home, 'documents'))}&query=needle&offset=0`) as {
    results: Array<{ relative_path: string; name_match: boolean; content_matches: Array<{ line: number; column: number; text: string }> }>;
    next_offset: number | null;
  };
  assert.equal(contentMatches.next_offset, null);
  assert.deepEqual(contentMatches.results, [{
    path: join(home, 'documents', 'research-notes.md'),
    relative_path: 'research-notes.md',
    name: 'research-notes.md',
    type: 'file',
    name_match: false,
    content_matches: [{ line: 1, column: 9, text: 'Primary needle appears here.' }],
  }]);

  const display = await json(`${base}/files/display?path=${encodeURIComponent(join(home, 'documents', 'note.txt'))}&inline=true&page=2`) as {
    path: string; full_path: string; name: string; mime_type: string; exists: boolean; page: number;
  };
  assert.deepEqual(display, {
    path: join(home, 'documents', 'note.txt'),
    full_path: join(home, 'documents', 'note.txt'),
    name: 'note.txt',
    mime_type: 'text/plain',
    exists: true,
    page: 2,
  });
  assert.deepEqual(await json(`${base}/files/display?path=${encodeURIComponent(join(home, 'documents', 'absent.txt'))}`), {
    path: join(home, 'documents', 'absent.txt'), exists: false,
  });

  const read = await json(`${base}/files/read?path=${encodeURIComponent(join(home, 'documents', 'note.txt'))}`) as {
    content: string;
    total_lines: number;
  };
  assert.equal(read.content, 'native file browser works\n');
  assert.equal(read.total_lines, 2);

  const view = await fetch(`${base}/files/view?path=${encodeURIComponent(join(home, 'documents', 'note.txt'))}`);
  assert.equal(view.status, 200);
  assert.match(view.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await view.text(), 'native file browser works\n');

  const served = await fetch(`${base}/files/serve/${join(home, 'documents', 'note.txt').slice(1)}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await served.text(), 'native file browser works\n');

  const servedOutside = await fetch(`${base}/files/serve/${tmpdir().slice(1)}`);
  assert.equal(servedOutside.status, 403);
  assert.match(JSON.stringify(await servedOutside.json()), /path_outside_home/);

  const toolWrite = await fetch(`${base}/v1/tools/write_file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'chat-one' },
    body: JSON.stringify({ path: join(home, 'agent.txt'), content: 'written without a caller lease', encoding: 'utf8', createParents: true }),
  });
  assert.equal(toolWrite.status, 200);
  assert.doesNotMatch(JSON.stringify(await toolWrite.json()), /stale_lease/);

  const move = await fetch(`${base}/files/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: join(home, 'agent.txt'), destination: join(home, 'moved.txt') }),
  });
  assert.equal(move.status, 200);

  const archive = await fetch(`${base}/files/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [join(home, 'moved.txt')] }),
  });
  assert.equal(archive.status, 501);
  assert.match(JSON.stringify(await archive.json()), /feature_unsupported/);

  const outside = await fetch(`${base}/files/list?directory=${encodeURIComponent(tmpdir())}`);
  assert.equal(outside.status, 403);
  assert.match(JSON.stringify(await outside.json()), /path_outside_home/);
  await symlink(tmpdir(), join(home, 'outside-link'));
  const linkedOutside = await fetch(`${base}/files/list?directory=${encodeURIComponent(join(home, 'outside-link'))}`);
  assert.equal(linkedOutside.status, 403);
  assert.match(JSON.stringify(await linkedOutside.json()), /path_outside_home/);
  const missing = await fetch(`${base}/files/list?directory=${encodeURIComponent(join(home, 'missing'))}`);
  assert.equal(missing.status, 404);
  assert.match(JSON.stringify(await missing.json()), /path_not_found/);

  await executor.takeHumanControl();
  const fenced = await fetch(`${base}/files/list?directory=${encodeURIComponent(home)}`);
  assert.equal(fenced.status, 409);
  assert.match(JSON.stringify(await fenced.json()), /human_control_active/);
  executor.releaseHumanControl();
  assert.equal((await fetch(`${base}/files/list?directory=${encodeURIComponent(home)}`)).status, 200);

  const remove = await fetch(`${base}/files/delete?path=${encodeURIComponent(join(home, 'documents'))}`, { method: 'DELETE' });
  assert.equal(remove.status, 200);
  const protectedHome = await fetch(`${base}/files/delete?path=${encodeURIComponent(home)}`, { method: 'DELETE' });
  assert.equal(protectedHome.status, 400);
  assert.match(JSON.stringify(await protectedHome.json()), /unsafe_delete/);
});

test('Open Terminal direct file routes stay descriptor-anchored during deterministic pathname swaps', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-races-'));
  const home = join(directory, 'home');
  const outside = join(directory, 'outside');
  await Promise.all([mkdir(home), mkdir(outside)]);
  let pendingHook: ((event: BoundedFileHookEvent) => Promise<void>) | undefined;
  const files = new BoundedFileSystem(home, {
    beforeUse: async (event) => pendingHook?.(event),
  });
  const executor = new ToolExecutor(undefined, { durableRoot: home, files });
  const compatibility = new OpenTerminalCompatibility(executor, enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities), { home });
  const server = createServer(async (request, response) => {
    const handled = await compatibility.handle(request, response, new URL(request.url ?? '/', 'http://test.local'));
    if (!handled) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/open-terminal`;
  context.after(async () => {
    await compatibility.shutdown();
    await executor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  const arm = (
    match: (event: BoundedFileHookEvent) => boolean,
    action: () => Promise<void>,
  ): (() => void) => {
    let used = false;
    pendingHook = async (event) => {
      if (used || !match(event)) return;
      used = true;
      await action();
    };
    return () => {
      assert.equal(used, true, 'the deterministic Open Terminal race hook must run');
      pendingHook = undefined;
    };
  };

  const viewParent = join(home, 'view-parent');
  const displacedViewParent = join(home, 'view-parent-pinned');
  await mkdir(viewParent);
  await writeFile(join(viewParent, 'note.txt'), 'inside view');
  await writeFile(join(outside, 'note.txt'), 'outside view');
  let assertHook = arm(
    (event) => event.operation === 'read' && event.stage === 'parent-resolved' && event.path.endsWith('/note.txt'),
    async () => { await rename(viewParent, displacedViewParent); await symlink(outside, viewParent); },
  );
  const view = await fetch(`${base}/files/view?path=${encodeURIComponent(join(viewParent, 'note.txt'))}`);
  assert.equal(view.status, 200);
  assert.equal(await view.text(), 'inside view');
  assertHook();
  assert.equal(await readFile(join(outside, 'note.txt'), 'utf8'), 'outside view');

  const matchParent = join(home, 'match-parent');
  const displacedMatchParent = join(home, 'match-parent-pinned');
  await mkdir(matchParent);
  await writeFile(join(matchParent, 'inside.txt'), 'inside needle');
  await mkdir(join(outside, 'match-parent'));
  await writeFile(join(outside, 'match-parent', 'inside.txt'), 'outside needle');
  assertHook = arm(
    (event) => event.operation === 'read' && event.stage === 'parent-resolved' && event.path.endsWith('/inside.txt'),
    async () => { await rename(matchParent, displacedMatchParent); await symlink(join(outside, 'match-parent'), matchParent); },
  );
  const matches = await fetch(`${base}/files/matches?path=${encodeURIComponent(matchParent)}&query=needle`);
  assert.equal(matches.status, 200);
  const matchResult = await matches.json() as { results: Array<{ content_matches: Array<{ text: string }> }> };
  assert.deepEqual(matchResult.results.flatMap(({ content_matches }) => content_matches.map(({ text }) => text)), ['inside needle']);
  assertHook();

  const searchParent = join(home, 'search-parent');
  const displacedSearchParent = join(home, 'search-parent-pinned');
  await mkdir(searchParent);
  await writeFile(join(searchParent, 'alpha.txt'), 'inside');
  await mkdir(join(outside, 'search-parent'));
  await writeFile(join(outside, 'search-parent', 'alpha.txt'), 'outside metadata');
  assertHook = arm(
    (event) => event.operation === 'inspect' && event.stage === 'parent-resolved'
      && event.path === join(searchParent, 'alpha.txt'),
    async () => { await rename(searchParent, displacedSearchParent); await symlink(join(outside, 'search-parent'), searchParent); },
  );
  const search = await fetch(`${base}/files/search?path=${encodeURIComponent(searchParent)}&query=alpha`);
  assert.equal(search.status, 200);
  const searchResult = await search.json() as { results: Array<{ name: string; size: number }> };
  assert.deepEqual(searchResult.results.map(({ name, size }) => ({ name, size })), [{ name: 'alpha.txt', size: 6 }]);
  assertHook();
  assert.equal(await readFile(join(outside, 'search-parent', 'alpha.txt'), 'utf8'), 'outside metadata');

  const mkdirParent = join(home, 'mkdir-parent');
  const displacedMkdirParent = join(home, 'mkdir-parent-pinned');
  await mkdir(mkdirParent);
  await mkdir(join(outside, 'mkdir-parent'));
  assertHook = arm(
    (event) => event.operation === 'write' && event.stage === 'parent-resolved' && event.path.endsWith('/created'),
    async () => { await rename(mkdirParent, displacedMkdirParent); await symlink(join(outside, 'mkdir-parent'), mkdirParent); },
  );
  const created = await fetch(`${base}/files/mkdir`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: join(mkdirParent, 'created') }),
  });
  assert.equal(created.status, 200);
  assertHook();
  assert.equal((await lstat(join(displacedMkdirParent, 'created'))).isDirectory(), true);
  await assert.rejects(lstat(join(outside, 'mkdir-parent', 'created')), { code: 'ENOENT' });

  const uploadParent = join(home, 'upload-parent');
  const displacedUploadParent = join(home, 'upload-parent-pinned');
  await mkdir(uploadParent);
  await mkdir(join(outside, 'upload-parent'));
  assertHook = arm(
    (event) => event.operation === 'write' && event.stage === 'parent-resolved' && event.path.endsWith('/upload.txt'),
    async () => { await rename(uploadParent, displacedUploadParent); await symlink(join(outside, 'upload-parent'), uploadParent); },
  );
  const form = new FormData();
  form.append('file', new Blob(['inside upload'], { type: 'text/plain' }), 'upload.txt');
  const upload = await fetch(`${base}/files/upload?directory=${encodeURIComponent(uploadParent)}`, { method: 'POST', body: form });
  assert.equal(upload.status, 200);
  assertHook();
  assert.equal(await readFile(join(displacedUploadParent, 'upload.txt'), 'utf8'), 'inside upload');
  await assert.rejects(lstat(join(outside, 'upload-parent', 'upload.txt')), { code: 'ENOENT' });
});

async function json(url: string): Promise<unknown> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
  return response.json();
}
