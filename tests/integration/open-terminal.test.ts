import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { OpenTerminalCompatibility } from '@qubicl/control/open-terminal';
import { ToolExecutor } from '@qubicl/control/executor';
import { PreviewManager } from '../../packages/control/dist/previews.js';
import { QubiclError } from '../../packages/control/dist/errors.js';
import type { BrowserManager } from '@qubicl/control/browser';
import { enabledToolNames, PRESET_DEFINITIONS } from '@qubicl/core';
import { BoundedFileSystem, type BoundedFileHookEvent } from '@qubicl/control/bounded-files';
import { unzipSync } from 'fflate';
import { createOpenTerminalArchive } from '../../packages/control/dist/open-terminal-archive.js';
import { RemoteProcessManager } from '../../packages/control/dist/remote-runners.js';

const execFileAsync = promisify(execFile);

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
    'http://preview-test.localhost/computers/test/previews',
    'http://gateway/computers/test/previews',
    'https://preview-test.example.test/computers/test/previews',
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
    const requestUrl = new URL(request.url ?? '/', 'http://test.local');
    if (executor.previews.handle(request, response, requestUrl)) return;
    const handled = await compatibility.handle(request, response, requestUrl);
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
  assert.equal(Object.hasOwn(spec.paths, '/execute'), true);
  assert.equal(Object.hasOwn(spec.paths, '/execute/{id}/status'), true);
  assert.equal(Object.hasOwn(spec.paths, '/execute/{id}/input'), true);
  assert.equal(Object.hasOwn(spec.paths, '/execute/{id}'), true);
  assert.equal(Object.hasOwn(spec.paths, '/files/archive'), true);

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
  assert.match(served.headers.get('content-disposition') ?? '', /^inline;/);
  assert.equal(await served.text(), 'native file browser works\n');

  await writeFile(join(home, 'documents', 'preview.css'), 'body { color: rgb(1, 2, 3); }\n');
  await writeFile(join(home, 'documents', 'preview.png'), browserPng);
  await writeFile(join(home, 'documents', 'preview.js'), 'document.body.dataset.relativeScript = "loaded";\n');
  for (const [name, content, contentType, mode] of [
    ['active.html', '<meta http-equiv="refresh" content="0;url=https://example.invalid"><link rel="stylesheet" href="preview.css"><img src="preview.png"><a href="https://example.invalid">link</a><form action="https://example.invalid"><button>submit</button></form><script src="preview.js"></script><script>fetch("research-notes.md").then((response) => response.text()).then((value) => location = `https://example.invalid/${value}`)</script>', /^text\/html/, 'isolated'],
    ['active.js', 'window.top.location="https://example.invalid"', /^(?:text|application)\/javascript/, 'source'],
    ['active.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><a href="https://example.invalid"><text>label</text></a><animate attributeName="href" to="https://example.invalid"><circle cx="2" cy="2" r="1" /></svg>', /^image\/svg\+xml/, 'isolated'],
  ] as const) {
    const activePath = join(home, 'documents', name);
    await writeFile(activePath, content);
    const activeResponse = await fetch(`${base}/files/view?path=${encodeURIComponent(activePath)}`);
    assert.match(activeResponse.headers.get('content-disposition') ?? '', /^attachment;/, name);
    assert.match(activeResponse.headers.get('content-type') ?? '', contentType, name);
    const inlineResponse = await fetch(`${base}/files/serve/${activePath.slice(1)}`);
    assert.equal(inlineResponse.status, 200, name);
    assert.match(inlineResponse.headers.get('content-disposition') ?? '', /^inline;/, name);
    const inlineBody = await inlineResponse.text();
    if (mode === 'source') {
      assert.match(inlineResponse.headers.get('content-type') ?? '', /^text\/plain/, name);
      assert.equal(inlineBody, content, name);
    } else {
      const policy = inlineResponse.headers.get('content-security-policy') ?? '';
      assert.match(inlineResponse.headers.get('content-type') ?? '', contentType, name);
      if (name === 'active.html') {
        assert.match(policy, /(?:^|; )sandbox allow-scripts(?:;|$)/u);
        assert.doesNotMatch(policy, /allow-same-origin|allow-forms|allow-popups|allow-downloads|allow-top-navigation/u);
        assert.match(policy, /script-src [^;]*'unsafe-inline'[^;]*https:/u);
        assert.match(policy, /connect-src [^;]*https:[^;]*wss:/u);
        assert.match(policy, /form-action 'none'/u);
        assert.match(inlineBody, /data-qubicl-interactive-preview="true"/u);
        assert.match(inlineBody, /Trusted content only/u);
        assert.match(inlineBody, /<button id="qubicl-run-interactive"[^>]*>Run interactive preview<\/button>/u);
        assert.match(inlineBody, /title="Safe static file preview" sandbox=""/u);
        assert.match(inlineBody, /setTimeout\(expire,300000\)/u);
        assert.doesNotMatch(inlineBody, /href=|\/files\/interactive\/|\.localhost|preview-test/u);
        const encoded = inlineBody.match(/id="qubicl-interactive-source" data-source="([A-Za-z0-9+/=]+)"/u)?.[1];
        assert.ok(encoded, 'scripted HTML must embed its exact trusted snapshot without another authenticated navigation');
        const trusted = Buffer.from(encoded, 'base64').toString('utf8');
        assert.match(trusted, /Content-Security-Policy/u);
        assert.match(trusted, /<script src="preview\.js"><\/script>/u);
        assert.match(trusted, /fetch\("research-notes\.md"\)/u);
      } else {
        assert.match(policy, /(?:^|; )sandbox(?:;|$)/, name);
        assert.match(policy, /connect-src 'none'/, name);
        assert.match(policy, /script-src 'none'/, name);
        assert.match(policy, /img-src data:/, name);
        assert.doesNotMatch(policy, /'self'/, name);
        assert.doesNotMatch(inlineBody, /<iframe|preview-test|\.localhost|allow-scripts|allow-same-origin|allow-downloads/u, name);
        assert.doesNotMatch(inlineBody, /<script|<meta|href="https:\/\/example\.invalid|action=/iu, name);
        assert.match(inlineBody, /<text>label<\/text>/u);
        assert.doesNotMatch(inlineBody, /<animate|href="https:\/\/example\.invalid/iu);
      }
    }
  }
  await writeFile(join(home, 'outside-preview.css'), 'body { color: secret-outside-scope; }');
  await symlink('../outside-preview.css', join(home, 'documents', 'escaped.css'));
  await writeFile(join(home, 'documents', 'asset-scope.html'), '<link rel="stylesheet" href="escaped.css"><p>safe document</p>');
  const escapedScope = await fetch(`${base}/files/serve/${join(home, 'documents', 'asset-scope.html').slice(1)}`);
  assert.equal(escapedScope.status, 200);
  const escapedBody = await escapedScope.text();
  assert.match(escapedBody, /<p>safe document<\/p>/u);
  assert.doesNotMatch(escapedBody, /secret-outside-scope|<link/iu);
  await rm(join(home, 'documents', 'escaped.css'));
  await mkdir(join(home, 'private-preview'));
  await writeFile(join(home, 'private-preview', 'target.html'), '<p>private target</p>');
  await symlink('../private-preview/target.html', join(home, 'documents', 'linked-preview.html'));
  const linkedPreview = await fetch(`${base}/files/serve/${join(home, 'documents', 'linked-preview.html').slice(1)}`);
  assert.equal(linkedPreview.status, 400);
  assert.match(await linkedPreview.text(), /file_preview_symlink/);
  const linkedDownload = await fetch(`${base}/files/view?path=${encodeURIComponent(join(home, 'documents', 'linked-preview.html'))}`);
  assert.equal(linkedDownload.status, 200);
  assert.match(linkedDownload.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(await linkedDownload.text(), '<p>private target</p>');
  await rm(join(home, 'documents', 'linked-preview.html'));
  const remoteCompatible = await fetch(`${base}/files/serve/${join(home, 'documents', 'active.html').slice(1)}`, {
    headers: { 'x-qubicl-access-surface': 'external' },
  });
  assert.equal(remoteCompatible.status, 200);
  assert.match(remoteCompatible.headers.get('content-security-policy') ?? '', /(?:^|; )sandbox allow-scripts(?:;|$)/);
  assert.doesNotMatch(await remoteCompatible.text(), /preview-test|\.localhost/iu);
  const nativeImage = await fetch(`${base}/files/view?path=${encodeURIComponent(imagePath)}`);
  assert.match(nativeImage.headers.get('content-disposition') ?? '', /^inline;/);
  assert.equal(nativeImage.headers.get('content-type'), 'image/png');

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
    body: JSON.stringify({ paths: [join(home, 'moved.txt'), join(home, 'documents')] }),
  });
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get('content-type'), 'application/zip');
  assert.equal(
    archive.headers.get('content-disposition'),
    "attachment; filename=\"archive.zip\"; filename*=UTF-8''archive.zip",
  );
  const archived = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.equal(Buffer.from(archived['moved.txt']!).toString('utf8'), 'written without a caller lease');
  assert.equal(Buffer.from(archived['documents/note.txt']!).toString('utf8'), 'native file browser works\n');

  const startedResponse = await fetch(`${base}/execute?wait=0&tail=100`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'chat-one' },
    body: JSON.stringify({
      command: `${JSON.stringify(process.execPath)} -e "process.stdin.on('data', value => { console.log('echo:' + value.toString().trim()); process.exit(0); });"`,
      cwd: home,
      env: {},
    }),
  });
  assert.equal(startedResponse.status, 200);
  const startedProcess = await startedResponse.json() as { id: string; status: string; session_id: string | null; log_path: null };
  assert.equal(startedProcess.status, 'running');
  assert.equal(startedProcess.session_id, 'chat-one');
  assert.equal(startedProcess.log_path, null);
  const listedProcesses = await json(`${base}/execute`) as Array<{ id: string }>;
  assert.equal(listedProcesses.some(({ id }) => id === startedProcess.id), true);
  const inputResponse = await fetch(`${base}/execute/${startedProcess.id}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hello\n' }),
  });
  assert.deepEqual(await inputResponse.json(), { status: 'ok' });
  let attached = await json(`${base}/execute/${startedProcess.id}/status?wait=2&offset=0`) as {
    status: string; output: Array<{ type: string; data: string }>; next_offset: number;
  };
  const attachedOutput = [...attached.output];
  while (attached.status === 'running') {
    attached = await json(`${base}/execute/${startedProcess.id}/status?wait=2&offset=${attached.next_offset}`) as typeof attached;
    attachedOutput.push(...attached.output);
  }
  assert.equal(attached.status, 'done');
  assert.match(attachedOutput.map(({ data }) => data).join(''), /echo:hello/);
  assert.ok(attached.next_offset > 0);
  const removedProcess = await fetch(`${base}/execute/${startedProcess.id}?force=true`, { method: 'DELETE' });
  assert.deepEqual(await removedProcess.json(), { status: 'killed' });
  const environmentRejected = await fetch(`${base}/execute?wait=0`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'true', env: { SECRET: 'blocked' } }),
  });
  assert.equal(environmentRejected.status, 400);
  assert.doesNotMatch(await environmentRejected.text(), /blocked/);

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

  const archiveSource = join(home, 'archive-source.txt');
  const displacedArchiveSource = join(home, 'archive-source-pinned.txt');
  await writeFile(archiveSource, 'inventory identity');
  const temporaryArchivesBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('qubicl-open-terminal-archive-')));
  assertHook = arm(
    (event) => event.operation === 'read' && event.stage === 'parent-resolved' && event.path === archiveSource,
    async () => { await rename(archiveSource, displacedArchiveSource); await writeFile(archiveSource, 'replacement identity'); },
  );
  const swappedArchive = await fetch(`${base}/files/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [archiveSource] }),
  });
  assert.equal(swappedArchive.status, 409);
  assert.match(await swappedArchive.text(), /path_changed/);
  assertHook();
  assert.deepEqual(
    new Set((await readdir(tmpdir())).filter((name) => name.startsWith('qubicl-open-terminal-archive-'))),
    temporaryArchivesBefore,
  );

  await symlink('archive-source-pinned.txt', join(home, 'archive-link'));
  const linkedArchive = await fetch(`${base}/files/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [join(home, 'archive-link')] }),
  });
  assert.equal(linkedArchive.status, 400);
  assert.match(await linkedArchive.text(), /path_invalid|archive_entry_invalid/);

  const fifo = join(home, 'archive-fifo');
  await execFileAsync('/usr/bin/mkfifo', [fifo]);
  const fifoStartedAt = Date.now();
  const fifoArchive = await fetch(`${base}/files/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [fifo] }),
  });
  assert.equal(fifoArchive.status, 400);
  assert.ok(Date.now() - fifoStartedAt < 1_000, 'FIFO inventory must not block the archive deadline');

  const oversizedCwd = await fetch(`${base}/execute?wait=0`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'true', cwd: 'a'.repeat(4_097) }),
  });
  assert.equal(oversizedCwd.status, 400);
  const oversizedArchivePath = await fetch(`${base}/files/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['😀'.repeat(1_025)] }),
  });
  assert.equal(oversizedArchivePath.status, 400);
});

test('Open Terminal process aliases recheck live policy inside ToolExecutor and audit metadata without command or input content', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-policy-'));
  const work = join(home, 'work');
  await mkdir(work);
  const auditPath = join(home, 'audit.jsonl');
  let execEnabled = true;
  let readEnabled = true;
  let disableOnInspect = true;
  let disableReadOnArchive = false;
  const maximumTools = enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities);
  const policy = {
    enabledTools: () => maximumTools.filter((name) => (name !== 'exec_command' || execEnabled) && (name !== 'read_file' || readEnabled)),
    isToolEnabled: (name: string) => (name !== 'exec_command' || execEnabled) && (name !== 'read_file' || readEnabled),
    enabledCatalogSkills: () => [],
    expectedSkillRegistrySha256: () => undefined,
    snapshot: () => ({ revision: 'test-live-policy' }),
  };
  const files = new BoundedFileSystem(home, {
    beforeUse: (event) => {
      if (disableReadOnArchive && event.operation === 'read') {
        disableReadOnArchive = false;
        readEnabled = false;
      }
      if (disableOnInspect && event.operation === 'inspect') {
        disableOnInspect = false;
        execEnabled = false;
      }
    },
  });
  const previousAuditPath = process.env.QUBICL_AUDIT_PATH;
  process.env.QUBICL_AUDIT_PATH = auditPath;
  const executor = new ToolExecutor(undefined, { durableRoot: home, files, policy: policy as never });
  if (previousAuditPath === undefined) delete process.env.QUBICL_AUDIT_PATH;
  else process.env.QUBICL_AUDIT_PATH = previousAuditPath;
  const compatibility = new OpenTerminalCompatibility(executor, maximumTools, { home });
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
    await rm(home, { recursive: true, force: true });
  });

  const secretCommand = 'printf OPEN_TERMINAL_AUDIT_SECRET';
  const raced = await fetch(`${base}/execute?wait=0`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: secretCommand, cwd: work }),
  });
  assert.equal(raced.status, 404);
  assert.match(await raced.text(), /capability_unsupported/);

  execEnabled = true;
  const started = await fetch(`${base}/execute?wait=0`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'cat >/dev/null', cwd: work }),
  });
  assert.equal(started.status, 200);
  const processId = (await started.json() as { id: string }).id;
  assert.equal((await fetch(`${base}/execute`)).status, 200);
  assert.equal((await fetch(`${base}/execute/${processId}/status?wait=0&offset=0`)).status, 200);
  assert.equal((await fetch(`${base}/execute/${processId}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'AUDIT_INPUT_SECRET' }),
  })).status, 200);
  assert.equal((await fetch(`${base}/execute/${processId}?force=true`, { method: 'DELETE' })).status, 200);

  const archiveAuditPath = join(work, 'archive-audit.txt');
  await writeFile(archiveAuditPath, 'archive audit content');
  disableReadOnArchive = true;
  const racedArchive = await fetch(`${base}/files/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [archiveAuditPath] }),
  });
  assert.equal(racedArchive.status, 404);
  assert.match(await racedArchive.text(), /disabled while the compatibility operation was in progress/u);
  readEnabled = true;
  const auditedArchive = await fetch(`${base}/files/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [archiveAuditPath] }),
  });
  assert.equal(auditedArchive.status, 200);
  await auditedArchive.arrayBuffer();

  await executor.audit.flush();
  const auditText = await readFile(auditPath, 'utf8');
  assert.doesNotMatch(auditText, /OPEN_TERMINAL_AUDIT_SECRET|AUDIT_INPUT_SECRET|cat >\/dev\/null/);
  const events = auditText.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'process-start'
    && event.status === 'error' && event.code === 'capability_unsupported'), true);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'process-start' && event.status === 'ok'), true);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'process-list' && event.status === 'ok'), true);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'process-attach' && event.status === 'ok'), true);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'process-input' && event.status === 'ok'), true);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'process-stop' && event.status === 'ok'), true);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'archive-read'
    && event.status === 'ok' && event.pathCount === 1), true);
  assert.equal(events.some((event) => event.compatibility === 'open-terminal' && event.operation === 'archive-read'
    && event.status === 'error' && event.code === 'capability_unsupported'), true);
});

test('a delayed compatibility start is fenced again when policy reload revokes its lease in flight', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-delayed-policy-'));
  let execEnabled = true;
  let actionEntered!: () => void;
  let releaseAction!: () => void;
  const entered = new Promise<void>((resolve) => { actionEntered = resolve; });
  const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
  const terminatedOwners: Array<{ id: string; generation: number; epoch: string }> = [];
  const processes = {
    exec: async () => { throw new Error('not used'); },
    write: async () => { throw new Error('not used'); },
    stop: async () => { throw new Error('not used'); },
    executeCompatibility: async (_command: string, cwd: string, owner: { id: string; generation: number; epoch: string }) => {
      actionEntered();
      await actionGate;
      return {
        id: 'delayed-process', command: 'redacted', status: 'running' as const, exit_code: null, log_path: null,
        cwd, session_id: null, started_at: Date.now() / 1000, finished_at: null,
        output: [], truncated: false, next_offset: 0,
        owner,
      };
    },
    listCompatibility: () => [],
    statusCompatibility: async () => { throw new Error('not used'); },
    inputCompatibility: async () => { throw new Error('not used'); },
    deleteCompatibility: async () => { throw new Error('not used'); },
    terminateOwner: async (owner: { id: string; generation: number; epoch: string } | undefined) => {
      if (owner) terminatedOwners.push({ id: owner.id, generation: owner.generation, epoch: owner.epoch });
      return { terminatedManagedProcesses: owner ? 1 : 0 };
    },
    count: () => 0,
  };
  const maximumTools = enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities);
  const policy = {
    enabledTools: () => maximumTools.filter((name) => name !== 'exec_command' || execEnabled),
    isToolEnabled: (name: string) => name !== 'exec_command' || execEnabled,
    enabledCatalogSkills: () => [],
    expectedSkillRegistrySha256: () => undefined,
    snapshot: () => ({ revision: execEnabled ? 'before' : 'after' }),
    load: async () => {
      execEnabled = false;
      return { changed: true, revision: 'after' };
    },
  };
  const executor = new ToolExecutor(undefined, { durableRoot: home, processes: processes as never, policy: policy as never });
  context.after(async () => {
    releaseAction();
    await executor.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  const lease = executor.leases.acquire(60);
  const pending = executor.compatibilityProcessExecute('true', home, lease, {}, null);
  await entered;
  await executor.reloadPolicy();
  assert.equal(terminatedOwners.length, 1, 'policy revocation fences the prior owner before the delayed start returns');
  releaseAction();
  await assert.rejects(pending, /disabled while the compatibility operation was in progress/u);
  assert.equal(terminatedOwners.length, 2, 'the post-action check fences work created after revocation');
  for (const owner of terminatedOwners) {
    assert.deepEqual(owner, { id: lease.id, generation: lease.generation, epoch: lease.epoch });
  }
});

test('ambiguous remote execute and stdin responses fence the owner without replay', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-ambiguous-runner-'));
  let executeCalls = 0;
  let inputCalls = 0;
  let fenced = 0;
  const processes = {
    exec: async () => { throw new Error('not used'); },
    write: async () => { throw new Error('not used'); },
    stop: async () => { throw new Error('not used'); },
    executeCompatibility: async () => {
      executeCalls += 1;
      throw new QubiclError('internal_runner_ambiguous', 'response lost after start', 503);
    },
    listCompatibility: () => [],
    statusCompatibility: async () => { throw new Error('not used'); },
    inputCompatibility: async () => {
      inputCalls += 1;
      throw new QubiclError('internal_runner_ambiguous', 'response lost after input', 503);
    },
    deleteCompatibility: async () => { throw new Error('not used'); },
    terminateOwner: async () => { fenced += 1; return { terminatedManagedProcesses: 1 }; },
    count: () => 0,
  };
  const executor = new ToolExecutor(undefined, { durableRoot: home, processes: processes as never });
  context.after(async () => {
    await executor.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  const executeLease = executor.leases.acquire(60);
  await assert.rejects(executor.compatibilityProcessExecute('true', home, executeLease, {}, null), /response lost after start/u);
  assert.throws(() => executor.leases.verify(executeLease), /stale/u);
  const inputLease = executor.leases.acquire(60);
  await assert.rejects(executor.compatibilityProcessInput('abcdefghijklmnop', 'one input', inputLease), /response lost after input/u);
  assert.throws(() => executor.leases.verify(inputLease), /stale/u);
  assert.equal(executeCalls, 1);
  assert.equal(inputCalls, 1);
  assert.equal(fenced, 2);
});

test('an invalid remote fence acknowledgement leaves ambiguous process work fail closed', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-invalid-fence-'));
  let executeCalls = 0;
  let fenceCalls = 0;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/process/compatibility-execute') {
      executeCalls += 1;
      response.end('{}');
      return;
    }
    if (request.url === '/v1/process/terminate-owner') {
      fenceCalls += 1;
      response.end('{}');
      return;
    }
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;
  const remote = new RemoteProcessManager(`http://127.0.0.1:${port}`, 'test-key');
  const executor = new ToolExecutor(undefined, { durableRoot: home, processes: remote });
  const lease = executor.leases.acquire(60);

  await assert.rejects(
    executor.compatibilityProcessExecute('true', home, lease, {}, null),
    (error: unknown) => error instanceof QubiclError && error.code === 'process_fencing_failed',
  );
  assert.throws(() => executor.leases.verify(lease), /stale/u);
  assert.throws(
    () => executor.leases.acquire(60),
    (error: unknown) => error instanceof QubiclError && error.code === 'lease_transition',
  );
  assert.equal(executeCalls, 1);
  assert.equal(fenceCalls, 1);
});

test('a late ambiguous start re-fences its exact expired owner and keeps a failed fence closed', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-late-ambiguous-'));
  let executeCalls = 0;
  const fencedOwners: Array<{ id: string; generation: number; epoch: string }> = [];
  let actionEntered!: () => void;
  let releaseAction!: () => void;
  const entered = new Promise<void>((resolve) => { actionEntered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseAction = resolve; });
  const processes = {
    exec: async () => { throw new Error('not used'); },
    write: async () => { throw new Error('not used'); },
    stop: async () => { throw new Error('not used'); },
    executeCompatibility: async () => {
      executeCalls += 1;
      actionEntered();
      await gate;
      throw new QubiclError('internal_runner_ambiguous', 'late response lost after start', 503);
    },
    listCompatibility: () => [],
    statusCompatibility: async () => { throw new Error('not used'); },
    inputCompatibility: async () => { throw new Error('not used'); },
    deleteCompatibility: async () => { throw new Error('not used'); },
    terminateOwner: async (owner: { id: string; generation: number; epoch: string } | undefined) => {
      if (owner) fencedOwners.push({ id: owner.id, generation: owner.generation, epoch: owner.epoch });
      if (fencedOwners.length === 2) throw new Error('second exact fence could not be confirmed');
      return { terminatedManagedProcesses: owner ? 1 : 0 };
    },
    count: () => 0,
  };
  const executor = new ToolExecutor(undefined, { durableRoot: home, processes: processes as never });
  context.after(async () => {
    releaseAction();
    await executor.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  const lease = executor.leases.acquire(60);
  const pending = executor.compatibilityProcessExecute('true', home, lease, {}, null);
  await entered;
  await executor.leases.revokeAgentControl();
  releaseAction();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof QubiclError && error.code === 'process_fencing_failed',
  );
  assert.deepEqual(fencedOwners, [
    { id: lease.id, generation: lease.generation, epoch: lease.epoch },
    { id: lease.id, generation: lease.generation, epoch: lease.epoch },
  ]);
  assert.equal(executeCalls, 1);
  assert.throws(() => executor.leases.verify(lease), /stale/u);
  assert.throws(
    () => executor.leases.acquire(60),
    (error: unknown) => error instanceof QubiclError && error.code === 'lease_transition',
  );
});

test('remote process aliases reject invalid success bodies as ambiguous only for non-idempotent operations', async (context) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(request.url?.includes('compatibility-execute') ? '{}' : '{invalid');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const remote = new RemoteProcessManager(`http://127.0.0.1:${port}`, 'test-key');
  await assert.rejects(
    remote.executeCompatibility('true', '/tmp', { id: 'lease', generation: 1, epoch: 'epoch' }),
    (error: unknown) => error instanceof QubiclError && error.code === 'internal_runner_ambiguous',
  );
  await assert.rejects(
    remote.statusCompatibility('abcdefghijklmnop', { id: 'lease', generation: 1, epoch: 'epoch' }),
    (error: unknown) => error instanceof QubiclError && error.code === 'internal_runner_invalid_response',
  );
});

test('Open Terminal never replays execute or stdin after a post-action stale lease', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-no-replay-'));
  let executeCalls = 0;
  let inputCalls = 0;
  let executeEntered!: () => void;
  let releaseExecute!: () => void;
  let inputEntered!: () => void;
  let releaseInput!: () => void;
  const executeStarted = new Promise<void>((resolve) => { executeEntered = resolve; });
  const executeGate = new Promise<void>((resolve) => { releaseExecute = resolve; });
  const inputStarted = new Promise<void>((resolve) => { inputEntered = resolve; });
  const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
  const processes = {
    exec: async () => { throw new Error('not used'); },
    write: async () => { throw new Error('not used'); },
    stop: async () => { throw new Error('not used'); },
    executeCompatibility: async (command: string, cwd: string) => {
      executeCalls += 1;
      if (executeCalls === 1) {
        executeEntered();
        await executeGate;
      }
      return {
        id: 'abcdefghijklmnop', command, status: 'running' as const, exit_code: null, log_path: null,
        cwd, session_id: null, started_at: Date.now() / 1000, finished_at: null,
        output: [], truncated: false, next_offset: 0,
      };
    },
    listCompatibility: () => [],
    statusCompatibility: async () => { throw new Error('not used'); },
    inputCompatibility: async () => {
      inputCalls += 1;
      if (inputCalls === 1) {
        inputEntered();
        await inputGate;
      }
      return { status: 'ok' as const };
    },
    deleteCompatibility: async () => { throw new Error('not used'); },
    terminateOwner: async () => ({ terminatedManagedProcesses: 1 }),
    count: () => 0,
  };
  const executor = new ToolExecutor(undefined, { durableRoot: home, processes: processes as never });
  const compatibility = new OpenTerminalCompatibility(
    executor,
    enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities),
    { home },
  );
  const server = createServer(async (request, response) => {
    const handled = await compatibility.handle(request, response, new URL(request.url ?? '/', 'http://test.local'));
    if (!handled) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/open-terminal`;
  context.after(async () => {
    releaseExecute();
    releaseInput();
    await compatibility.shutdown();
    await executor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  const executing = fetch(`${base}/execute?wait=0`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'true', cwd: home }),
  });
  await executeStarted;
  await executor.leases.revokeAgentControl();
  releaseExecute();
  const executeResponse = await executing;
  assert.equal(executeResponse.status, 409);
  assert.match(await executeResponse.text(), /stale_lease/u);
  assert.equal(executeCalls, 1);

  const writing = fetch(`${base}/execute/abcdefghijklmnop/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'one write only' }),
  });
  await inputStarted;
  await executor.leases.revokeAgentControl();
  releaseInput();
  const inputResponse = await writing;
  assert.equal(inputResponse.status, 409);
  assert.match(await inputResponse.text(), /stale_lease/u);
  assert.equal(inputCalls, 1);
});

test('completed archive output is served from an unlinked verified descriptor and cleanup closes it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-output-descriptor-'));
  try {
    const source = join(home, 'source.txt');
    await writeFile(source, 'descriptor-bound archive');
    const archive = await createOpenTerminalArchive(new BoundedFileSystem(home), [source]);
    const descriptorPath = `/proc/self/fd/${archive.descriptor}`;
    try {
      assert.match(await readlink(descriptorPath), / \(deleted\)$/u);
      assert.equal(Number((await stat(descriptorPath, { bigint: true })).mode & 0o777n), 0o400);
      const parentDescriptorPath = `/proc/${process.pid}/fd/${archive.descriptor}`;
      const probe = await execFileAsync(process.execPath, ['-e', [
        "const {openSync}=require('node:fs');",
        "try { openSync(process.argv[1], 'r+'); process.stdout.write('opened'); }",
        "catch (error) { process.stdout.write(error.code ?? error.name); }",
      ].join(''), parentDescriptorPath]);
      assert.match(probe.stdout, /EACCES|EPERM/u);
      await writeFile(join(home, 'archive.zip'), 'replacement bytes');
      const contents = unzipSync(new Uint8Array(await readFile(descriptorPath)));
      assert.equal(Buffer.from(contents['source.txt']!).toString('utf8'), 'descriptor-bound archive');
    } finally {
      await archive.cleanup();
    }
    await assert.rejects(lstat(descriptorPath), { code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('archive inventory streams wide trees and retains compact ancestry evidence within hard budgets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-inventory-bounds-'));
  try {
    const wide = join(home, 'wide');
    await mkdir(wide);
    await Promise.all(Array.from({ length: 12 }, (_, index) => writeFile(join(wide, `${index}.txt`), 'x')));
    const files = new BoundedFileSystem(home);
    await assert.rejects(
      files.walkArchive(wide, { maximumEntries: 4, maximumMetadataBytes: 64 * 1024, deadline: Date.now() + 5_000 }),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'EFBIG',
    );

    let deep = join(home, 'deep');
    await mkdir(deep);
    for (let index = 0; index < 32; index += 1) {
      deep = join(deep, `d${index}`);
      await mkdir(deep);
    }
    const leaf = join(deep, 'leaf.txt');
    await writeFile(leaf, 'compact identity');
    const identity = await files.archiveIdentity(leaf, { deadline: Date.now() + 5_000 });
    assert.ok(identity.chainLength > 32);
    assert.match(identity.chainDigest, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(identity, 'chain'), false);
    await assert.rejects(
      files.archiveIdentity(leaf, { deadline: Date.now() - 1 }),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
    );
    await assert.rejects(
      files.walkArchive(home, { maximumEntries: 100, maximumMetadataBytes: 128, deadline: Date.now() + 5_000 }),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === 'EFBIG',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('archive reservations bound concurrency and release after cancellation and cleanup', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-archive-reservations-'));
  const source = join(home, 'source.txt');
  await writeFile(source, 'reserved archive');
  let entered = 0;
  let bothEntered!: () => void;
  let release!: () => void;
  const enteredGate = new Promise<void>((resolve) => { bothEntered = resolve; });
  const creationGate = new Promise<void>((resolve) => { release = resolve; });
  const factory: typeof createOpenTerminalArchive = async (files, paths, hooks) => {
    entered += 1;
    if (entered === 2) bothEntered();
    await creationGate;
    return createOpenTerminalArchive(files, paths, hooks);
  };
  const executor = new ToolExecutor(undefined, { durableRoot: home, archiveFactory: factory });
  context.after(async () => {
    release();
    await executor.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  const lease = executor.leases.acquire(60);
  const firstPending = executor.compatibilityArchive([source], lease);
  const secondPending = executor.compatibilityArchive([source], lease);
  await enteredGate;
  await assert.rejects(executor.compatibilityArchive([source], lease), /active archive downloads/u);
  release();
  const [first, second] = await Promise.all([firstPending, secondPending]);
  await first.cleanup();
  await second.cleanup();

  const controller = new AbortController();
  let cancelNext = true;
  const temporaryArchivesBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith('qubicl-open-terminal-archive-')));
  const cancellingExecutor = new ToolExecutor(undefined, {
    durableRoot: home,
    archiveFactory: (files, paths, hooks) => createOpenTerminalArchive(files, paths, cancelNext ? {
      ...hooks,
      afterOutputOpened: () => { cancelNext = false; controller.abort(); },
    } : hooks),
  });
  context.after(async () => cancellingExecutor.shutdown());
  const cancellingLease = cancellingExecutor.leases.acquire(60);
  await assert.rejects(
    cancellingExecutor.compatibilityArchive([source], cancellingLease, controller.signal),
    /cancelled because the client disconnected/u,
  );
  assert.deepEqual(
    new Set((await readdir(tmpdir())).filter((name) => name.startsWith('qubicl-open-terminal-archive-'))),
    temporaryArchivesBefore,
  );
  const afterCancellation = await cancellingExecutor.compatibilityArchive([source], cancellingLease);
  await afterCancellation.cleanup();
  const recovered = await executor.compatibilityArchive([source], lease);
  await recovered.cleanup();
});

test('an aborted archive HTTP request cancels creation and releases its reservation', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-archive-http-abort-'));
  const source = join(home, 'source.txt');
  await writeFile(source, 'archive after abort');
  let calls = 0;
  let entered!: () => void;
  let observedAbort!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
  const executor = new ToolExecutor(undefined, {
    durableRoot: home,
    archiveFactory: async (files, paths, hooks) => {
      calls += 1;
      if (calls > 1) return createOpenTerminalArchive(files, paths, hooks);
      entered();
      return new Promise<never>((_resolve, reject) => {
        const signal = hooks?.signal;
        if (!signal) return reject(new Error('missing archive cancellation signal'));
        const cancel = (): void => {
          observedAbort();
          reject(new QubiclError('archive_cancelled', 'archive request aborted', 499));
        };
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    },
  });
  const compatibility = new OpenTerminalCompatibility(
    executor,
    enabledToolNames(PRESET_DEFINITIONS.workstation.capabilities),
    { home },
  );
  const server = createServer(async (request, response) => {
    const handled = await compatibility.handle(request, response, new URL(request.url ?? '/', 'http://test.local'));
    if (!handled) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  context.after(async () => {
    await compatibility.shutdown();
    await executor.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/open-terminal/files/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: [source] }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(request, /abort/u);
  await aborted;

  const retry = await fetch(`http://127.0.0.1:${port}/open-terminal/files/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [source] }),
  });
  assert.equal(retry.status, 200);
  assert.equal(Buffer.from(unzipSync(new Uint8Array(await retry.arrayBuffer()))['source.txt']!).toString('utf8'), 'archive after abort');
});

test('archive temp-directory substitution cannot redirect output or recursively delete the replacement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-output-directory-'));
  const source = join(home, 'source.txt');
  await writeFile(source, 'pinned archive directory');
  let displacedDirectory = '';
  let replacementDirectory = '';
  try {
    const archive = await createOpenTerminalArchive(new BoundedFileSystem(home), [source], {
      afterDirectoryPinned: async (directory) => {
        replacementDirectory = directory;
        displacedDirectory = `${directory}.displaced`;
        await rename(directory, displacedDirectory);
        await mkdir(replacementDirectory);
        await writeFile(join(replacementDirectory, 'sentinel.txt'), 'replacement must survive');
      },
    });
    try {
      const contents = unzipSync(new Uint8Array(await readFile(`/proc/self/fd/${archive.descriptor}`)));
      assert.equal(Buffer.from(contents['source.txt']!).toString('utf8'), 'pinned archive directory');
    } finally {
      await archive.cleanup();
    }
    assert.equal(await readFile(join(replacementDirectory, 'sentinel.txt'), 'utf8'), 'replacement must survive');
    assert.deepEqual(await readdir(displacedDirectory), [], 'the descriptor-pinned original directory contains no persisted ZIP');
  } finally {
    await rm(home, { recursive: true, force: true });
    if (replacementDirectory) await rm(replacementDirectory, { recursive: true, force: true });
    if (displacedDirectory) await rm(displacedDirectory, { recursive: true, force: true });
  }
});

async function json(url: string): Promise<unknown> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
  return response.json();
}
