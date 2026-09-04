import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BoundedFileSystem } from '@qubicl/control/bounded-files';
import { ToolExecutor } from '@qubicl/control/executor';
import { OpenTerminalCompatibility } from '@qubicl/control/open-terminal';

const BYTE_BUDGET = 25_000_000;
const FILE_LIMIT = 1_048_576;

interface Matches {
  truncated: boolean;
  results: Array<{ name: string; content_matches: Array<{ text: string }> }>;
}

test('content search charges oversized files and bounds real reads including overflow bytes', async (context) => {
  const fixture = await searchFixture(context, 1000);
  const large = join(fixture.home, 'large.bin');
  const handle = await open(large, 'w');
  await handle.truncate(2 * FILE_LIMIT);
  await handle.close();
  const read = fixture.files.readFile.bind(fixture.files);
  let attempts = 0;
  let bytes = 0;
  context.mock.method(fixture.files, 'readFile', async (_path: string, maximumBytes?: number) => {
    attempts += 1;
    const result = await read(large, maximumBytes);
    bytes += result.data.length;
    assert.ok(bytes <= BYTE_BUDGET, 'Every read, including its overflow byte, must fit the remaining budget');
    return result;
  });

  // A filename near the end must still be discoverable after content I/O stops.
  const result = await fixture.matches('item-0999');
  assert.equal(result.truncated, true);
  assert.equal(attempts, Math.ceil(BYTE_BUDGET / (FILE_LIMIT + 1)));
  assert.equal(bytes, BYTE_BUDGET);
  assert.deepEqual(result.results.map(({ name }) => name), ['item-0999']);
  assert.deepEqual(result.results[0]!.content_matches, []);
});

test('content search limits attempted files and refunds unused byte reservations', async (context) => {
  const fixture = await searchFixture(context, 600);
  const small = join(fixture.home, 'small.txt');
  await writeFile(small, 'needle');
  const read = fixture.files.readFile.bind(fixture.files);
  let attempts = 0;
  let bytes = 0;
  context.mock.method(fixture.files, 'readFile', async (_path: string, maximumBytes?: number) => {
    attempts += 1;
    const result = await read(small, maximumBytes);
    bytes += result.data.length;
    return result;
  });
  const result = await fixture.matches('needle');
  assert.equal(attempts, 500);
  assert.equal(bytes, 500 * Buffer.byteLength('needle'));
  assert.equal(result.truncated, true);
  assert.ok(result.results.every(({ content_matches }) => content_matches[0]?.text === 'needle'));
});

test('failed reads retain their byte reservations and report incomplete content search', async (context) => {
  const fixture = await searchFixture(context, 1000);
  let reserved = 0;
  let attempts = 0;
  context.mock.method(fixture.files, 'readFile', async (_path: string, maximumBytes?: number) => {
    attempts += 1;
    // A filesystem error can arrive after consuming some or all requested I/O.
    reserved += maximumBytes! + 1;
    throw new Error('read failed after partial I/O');
  });
  const result = await fixture.matches('item-0999');
  assert.equal(result.truncated, true);
  assert.equal(attempts, Math.ceil(BYTE_BUDGET / (FILE_LIMIT + 1)));
  assert.equal(reserved, BYTE_BUDGET);
  assert.deepEqual(result.results.map(({ name }) => name), ['item-0999']);
});

test('a complete small content search is not marked truncated', async (context) => {
  const fixture = await searchFixture(context, 2);
  const small = join(fixture.home, 'small.txt');
  await writeFile(small, 'needle');
  const read = fixture.files.readFile.bind(fixture.files);
  context.mock.method(fixture.files, 'readFile', (_path: string, maximumBytes?: number) => read(small, maximumBytes));
  const result = await fixture.matches('needle');
  assert.equal(result.truncated, false);
  assert.equal(result.results.length, 2);
});

test('content search rejects a file that grows past the per-file limit after stat', async (context) => {
  const fixture = await searchFixture(context, 1);
  const small = join(fixture.home, 'small.txt');
  await writeFile(small, 'needle');
  const read = fixture.files.readFile.bind(fixture.files);
  context.mock.method(fixture.files, 'readFile', async () => ({
    ...await read(small),
    data: Buffer.alloc(FILE_LIMIT + 1, 'x'),
  }));
  const result = await fixture.matches('needle');
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results, []);
});

async function searchFixture(context: TestContext, count?: number): Promise<{
  home: string;
  files: BoundedFileSystem;
  base: string;
  matches: (query: string, extra?: string) => Promise<Matches>;
}> {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-search-budget-'));
  const files = new BoundedFileSystem(home);
  const entries = Array.from({ length: count ?? 0 }, (_, index) => ({
    name: `item-${String(index).padStart(4, '0')}`, type: 'file' as const,
  }));
  // Simulate a large directory while keeping real bounded file reads and the
  // public HTTP route, tool policy, and lease path under test.
  if (count !== undefined) context.mock.method(files, 'list', async (_path: string, _recursive: boolean, cursor: number, maxEntries: number) => {
    const page = entries.slice(cursor, cursor + maxEntries);
    const truncated = cursor + page.length < entries.length;
    return { entries: page, truncated, ...(truncated ? { nextCursor: cursor + page.length } : {}) };
  });
  const executor = new ToolExecutor(undefined, { durableRoot: home, files });
  const compatibility = new OpenTerminalCompatibility(executor, executor.enabledToolNames(), { home });
  const server = createServer((request, response) => {
    void compatibility.handle(request, response, new URL(request.url!, 'http://localhost'));
  });
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await compatibility.shutdown();
    await executor.shutdown();
    await rm(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    home,
    files,
    base: `http://127.0.0.1:${address.port}/open-terminal`,
    matches: async (query, extra = '') => {
      const response = await fetch(`http://127.0.0.1:${address.port}/open-terminal/files/matches?query=${encodeURIComponent(query)}${extra}`);
      assert.equal(response.status, 200);
      return response.json() as Promise<Matches>;
    },
  };
}


test('search prunes hidden and Git-ignored directories and honors nested re-inclusions', async (context) => {
  const { home, files, base, matches } = await searchFixture(context);
  for (const directory of ['node_modules', '.hidden', 'src']) await mkdir(join(home, directory));
  await writeFile(join(home, '.gitignore'), 'node_modules/\n*.log\n');
  await writeFile(join(home, 'src/.gitignore'), '!keep.log\n');
  for (const path of ['node_modules/needle.js', '.hidden/needle.txt', 'drop.log', 'src/drop.log', 'src/keep.log', 'src/needle.ts']) await writeFile(join(home, path), 'needle');
  const read = files.readFile.bind(files);
  const paths: string[] = [];
  context.mock.method(files, 'readFile', async (path: string, maximum?: number) => {
    paths.push(path);
    return read(path, maximum);
  });
  const result = await matches('needle');
  assert.deepEqual(result.results.map(({ name }) => name).sort(), ['keep.log', 'needle.ts']);
  assert.ok(!paths.some((path) => path.includes('node_modules/') || path.includes('.hidden/')));
  const visible = await fetch(`${base}/files/search?query=needle&show_hidden=true`);
  const body = await visible.json() as Matches;
  assert.deepEqual(body.results.map(({ name }) => name).sort(), ['needle.ts', 'needle.txt']);
});

test('search returns partial results at enumeration limits using one listing pass', async (context) => {
  const { home, files, base } = await searchFixture(context, 10_005);
  await writeFile(join(home, 'item-0000'), 'result');
  const original = files.list.bind(files);
  let calls = 0;
  context.mock.method(files, 'list', async (...args: Parameters<typeof files.list>) => {
    calls++;
    return original(...args);
  });
  const response = await fetch(`${base}/files/search?query=item-0000`);
  assert.equal(response.status, 200);
  const result = await response.json() as Matches;
  assert.equal(result.truncated, true);
  assert.equal(result.results[0]?.name, 'item-0000');
  assert.equal(calls, 1);
});

test('content search reuses paged results and invalidates them on adapter writes', async (context) => {
  const { home, files, base, matches } = await searchFixture(context);
  await Promise.all(Array.from({ length: 120 }, (_, index) => writeFile(join(home, `file-${index}.txt`), 'needle')));
  const read = files.readFile.bind(files);
  let reads = 0;
  context.mock.method(files, 'readFile', async (...args: Parameters<typeof files.readFile>) => { reads++; return read(...args); });
  assert.equal((await matches('needle')).results.length, 100);
  const firstReads = reads;
  assert.equal((await matches('needle', '&offset=100')).results.length, 20);
  assert.equal(reads, firstReads, 'The second page must not reread the tree or file contents');
  const mutation = await fetch(`${base}/v1/tools/write_file`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'extra.txt', content: 'needle' }),
  });
  assert.equal(mutation.status, 200);
  assert.equal((await matches('needle', '&offset=100')).results.length, 21);
  assert.ok(reads > firstReads);
});
