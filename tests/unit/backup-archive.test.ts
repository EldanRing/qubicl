import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { lstat, mkdir, mkdtemp, open, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Header, type HeaderData } from 'tar';
import {
  BACKUP_ARCHIVE_LIMITS,
  copyVerifiedBackupArchive,
  extractInspectedBackupArchive,
  inspectBackupArchive,
  type BackupArchiveLimits,
} from '../../packages/cli/dist/safe-backup-archive.js';

interface ArchiveEntry extends HeaderData {
  body?: string | Buffer;
}

test('valid Qubicl-home archives preserve files and confined link chains independent of entry ordering', async () => {
  const fixture = await archiveFixture([
    { path: './', type: 'Directory', mode: 0o700 },
    { path: './qubicl/hard-before', type: 'Link', linkpath: './qubicl/hard-chain', mode: 0o755 },
    { path: './qubicl/hard-chain', type: 'Link', linkpath: './qubicl/file.txt', mode: 0o755 },
    { path: './qubicl/chain-a', type: 'SymbolicLink', linkpath: 'chain-b' },
    { path: './qubicl/chain-b', type: 'SymbolicLink', linkpath: 'file.txt' },
    { path: './qubicl/links/nested', type: 'SymbolicLink', linkpath: '../file.txt' },
    { path: './qubicl/expand', type: 'SymbolicLink', linkpath: 'nested/deeper' },
    { path: './qubicl/confined-after-expansion', type: 'SymbolicLink', linkpath: 'expand/../../../qubicl/file.txt' },
    { path: './qubicl/nested/deeper/keep', type: 'File', body: 'keep\n' },
    { path: './qubicl/file.txt', type: 'File', body: 'durable\n', mode: 0o755 },
    { path: './qubicl/', type: 'Directory', mode: 0o700 },
  ]);
  try {
    const destination = join(fixture.root, 'extracted');
    await mkdir(destination, { mode: 0o700 });
    const plan = await inspectBackupArchive(fixture.archive);
    await extractInspectedBackupArchive(fixture.archive, destination, plan);

    assert.equal(await readFile(join(destination, 'qubicl/file.txt'), 'utf8'), 'durable\n');
    assert.equal(await readlink(join(destination, 'qubicl/chain-a')), 'chain-b');
    assert.equal(await readlink(join(destination, 'qubicl/chain-b')), 'file.txt');
    assert.equal(await readlink(join(destination, 'qubicl/links/nested')), '../file.txt');
    assert.equal(await readFile(join(destination, 'qubicl/confined-after-expansion'), 'utf8'), 'durable\n');
    const [file, firstHardlink, chainedHardlink] = await Promise.all([
      stat(join(destination, 'qubicl/file.txt')),
      stat(join(destination, 'qubicl/hard-before')),
      stat(join(destination, 'qubicl/hard-chain')),
    ]);
    assert.equal(firstHardlink.ino, file.ino);
    assert.equal(chainedHardlink.ino, file.ino);
    assert.equal((await lstat(join(destination, 'qubicl/chain-a'))).isSymbolicLink(), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('archive inspection rejects traversal, aliases, collisions, unsafe links, cycles, and special entries', async (context) => {
  const cases: Array<{ name: string; entries: ArchiveEntry[]; pattern: RegExp }> = [
    { name: 'parent traversal', entries: [{ path: '../escape', type: 'File', body: 'x' }], pattern: /traversal path/ },
    { name: 'absolute path', entries: [{ path: '/escape', type: 'File', body: 'x' }], pattern: /absolute path/ },
    {
      name: 'canonical duplicate',
      entries: [{ path: './same', type: 'File', body: 'x' }, { path: 'same', type: 'File', body: 'y' }],
      pattern: /duplicate or aliased path/,
    },
    {
      name: 'Unicode canonical collision',
      entries: [{ path: 'caf\u00e9', type: 'File', body: 'x' }, { path: 'cafe\u0301', type: 'File', body: 'y' }],
      pattern: /canonically equivalent paths/,
    },
    {
      name: 'Unicode canonical collision in implicit ancestors',
      entries: [{ path: 'caf\u00e9/one', type: 'File', body: 'x' }, { path: 'cafe\u0301/two', type: 'File', body: 'y' }],
      pattern: /canonically equivalent filesystem paths/,
    },
    {
      name: 'file ancestor after child',
      entries: [{ path: 'parent/child', type: 'File', body: 'x' }, { path: 'parent', type: 'File', body: 'y' }],
      pattern: /beneath non-directory/,
    },
    {
      name: 'symlink ancestor before child',
      entries: [{ path: 'parent', type: 'SymbolicLink', linkpath: 'target' }, { path: 'parent/child', type: 'File', body: 'x' }],
      pattern: /beneath non-directory/,
    },
    { name: 'symlink traversal', entries: [{ path: 'link', type: 'SymbolicLink', linkpath: '../escape' }], pattern: /escapes the archive root/ },
    { name: 'absolute symlink', entries: [{ path: 'link', type: 'SymbolicLink', linkpath: '/outside' }], pattern: /targets an absolute path/ },
    { name: 'hardlink traversal', entries: [{ path: 'link', type: 'Link', linkpath: '../outside' }], pattern: /traversal path/ },
    {
      name: 'missing hardlink target',
      entries: [{ path: 'link', type: 'Link', linkpath: 'missing' }],
      pattern: /targets missing member/,
    },
    {
      name: 'directory hardlink target',
      entries: [{ path: 'directory', type: 'Directory' }, { path: 'link', type: 'Link', linkpath: 'directory' }],
      pattern: /does not resolve to a regular file/,
    },
    {
      name: 'hardlink cycle',
      entries: [{ path: 'one', type: 'Link', linkpath: 'two' }, { path: 'two', type: 'Link', linkpath: 'one' }],
      pattern: /hardlink cycle/,
    },
    {
      name: 'symlink cycle',
      entries: [{ path: 'one', type: 'SymbolicLink', linkpath: 'two' }, { path: 'two', type: 'SymbolicLink', linkpath: 'one' }],
      pattern: /symlink cycle/,
    },
    {
      name: 'symlink subpath cycle',
      entries: [{ path: 'one', type: 'SymbolicLink', linkpath: 'two/child' }, { path: 'two', type: 'SymbolicLink', linkpath: 'one/child' }],
      pattern: /symlink cycle/,
    },
    {
      name: 'symlink self-cycle hidden behind a parent component',
      entries: [{ path: 'self', type: 'SymbolicLink', linkpath: 'self/..' }],
      pattern: /symlink cycle/,
    },
    {
      name: 'composed symlink traversal processed before later parent components',
      entries: [
        { path: 'dir/a', type: 'SymbolicLink', linkpath: '..' },
        { path: 'escape-link', type: 'SymbolicLink', linkpath: 'dir/a/../outside.txt' },
      ],
      pattern: /escapes the archive root/,
    },
    {
      name: 'Unicode-equivalent symlink prefix on normalization-insensitive filesystems',
      entries: [
        { path: 'dir/caf\u00e9', type: 'SymbolicLink', linkpath: '..' },
        { path: 'escape-link', type: 'SymbolicLink', linkpath: 'dir/cafe\u0301/../outside.txt' },
      ],
      pattern: /escapes the archive root/,
    },
    { name: 'FIFO', entries: [{ path: 'pipe', type: 'FIFO' }], pattern: /unsupported entry type FIFO/ },
    { name: 'character device', entries: [{ path: 'device', type: 'CharacterDevice' }], pattern: /unsupported entry type CharacterDevice/ },
    { name: 'block device', entries: [{ path: 'device', type: 'BlockDevice' }], pattern: /unsupported entry type BlockDevice/ },
    { name: 'contiguous file', entries: [{ path: 'contiguous', type: 'ContiguousFile' }], pattern: /unsupported entry type ContiguousFile/ },
    { name: 'GNU dump directory', entries: [{ path: 'dump', type: 'GNUDumpDir' }], pattern: /unsupported entry type GNUDumpDir/ },
    { name: 'unknown vendor entry', entries: [{ path: 'vendor', type: 'SolarisACL' }], pattern: /unsupported entry type SolarisACL/ },
    { name: 'sparse file', entries: [{ path: 'sparse', type: 'SparseFile' }], pattern: /unsupported entry type SparseFile/ },
    {
      name: 'PAX sparse metadata',
      entries: [
        { path: 'PaxHeaders/sparse', type: 'ExtendedHeader', body: paxRecord('GNU.sparse.realsize', '1048576') },
        { path: 'sparse', type: 'File', body: 'x' },
      ],
      pattern: /unsupported sparse-file metadata/,
    },
    { name: 'set-ID mode', entries: [{ path: 'set-id', type: 'File', mode: 0o6755, body: 'x' }], pattern: /set-user-ID or set-group-ID/ },
  ];

  for (const fixtureCase of cases) {
    await context.test(fixtureCase.name, async () => {
      const fixture = await archiveFixture(fixtureCase.entries);
      try {
        await assert.rejects(inspectBackupArchive(fixture.archive), fixtureCase.pattern);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('archive budgets reject oversized metadata before extraction', async () => {
  const fixture = await archiveFixture([
    { path: 'first', type: 'File', body: '1234' },
    { path: 'second', type: 'File', body: '5' },
  ]);
  const nestedFixture = await archiveFixture([{ path: 'aa/b', type: 'File', body: 'x' }]);
  try {
    const archiveBytes = (await stat(fixture.archive)).size;
    await assert.rejects(inspectBackupArchive(fixture.archive, limits({ maxArchiveBytes: archiveBytes - 1 })), /is larger than/);
    await assert.rejects(inspectBackupArchive(fixture.archive, limits({ maxFileBytes: 3 })), /file .* larger than/);
    await assert.rejects(inspectBackupArchive(fixture.archive, limits({ maxEntries: 1 })), /more than 1 entries/);
    await assert.rejects(inspectBackupArchive(fixture.archive, limits({ maxExpandedBytes: 4 })), /expands beyond/);
    await assert.rejects(inspectBackupArchive(fixture.archive, limits({ maxPathTableBytes: 3 })), /path metadata exceeds/);
    await assert.rejects(inspectBackupArchive(fixture.archive, limits({ maxFilesystemEntries: 1 })), /filesystem graph contains more than 1/);
    await assert.rejects(
      inspectBackupArchive(nestedFixture.archive, limits({ maxPathTableBytes: 12 })),
      /path metadata exceeds/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(nestedFixture.root, { recursive: true, force: true });
  }
});

test('extraction repeats the inspected metadata filter and rejects a changed archive', async () => {
  const inspected = await archiveFixture([{ path: 'value', type: 'File', body: 'x' }]);
  const changed = await archiveFixture([{ path: 'value', type: 'Directory' }]);
  const changedBody = await archiveFixture([{ path: 'value', type: 'File', body: 'y' }]);
  try {
    const plan = await inspectBackupArchive(inspected.archive);
    const destination = join(inspected.root, 'destination');
    await mkdir(destination, { mode: 0o700 });
    await assert.rejects(extractInspectedBackupArchive(changed.archive, destination, plan), /changed between inspection and extraction/);
    assert.deepEqual(await readFileNames(destination), []);

    const bodyDestination = join(inspected.root, 'body-destination');
    await mkdir(bodyDestination, { mode: 0o700 });
    await assert.rejects(
      extractInspectedBackupArchive(changedBody.archive, bodyDestination, plan),
      /changed between inspection and extraction/,
    );
  } finally {
    await rm(inspected.root, { recursive: true, force: true });
    await rm(changed.root, { recursive: true, force: true });
    await rm(changedBody.root, { recursive: true, force: true });
  }
});

test('verified archive copy is exclusive, checksum-bound, and refuses symlink sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-backup-copy-'));
  try {
    const source = join(root, 'source.tar.gz');
    const contents = Buffer.from('archive bytes');
    await writeFile(source, contents, { mode: 0o600 });
    const digest = createHash('sha256').update(contents).digest('hex');
    const copied = join(root, 'copied.tar.gz');
    await copyVerifiedBackupArchive(source, copied, digest);
    assert.deepEqual(await readFile(copied), contents);
    assert.equal((await stat(copied)).mode & 0o777, 0o600);

    const mismatch = join(root, 'mismatch.tar.gz');
    await assert.rejects(copyVerifiedBackupArchive(source, mismatch, '0'.repeat(64)), /checksum mismatch/);
    await assert.rejects(lstat(mismatch), { code: 'ENOENT' });

    const existing = join(root, 'existing.tar.gz');
    await writeFile(existing, 'preserve me', { mode: 0o600 });
    await assert.rejects(copyVerifiedBackupArchive(source, existing, digest), { code: 'EEXIST' });
    assert.equal(await readFile(existing, 'utf8'), 'preserve me');

    const sourceLink = join(root, 'source-link.tar.gz');
    await symlink(source, sourceLink);
    await assert.rejects(copyVerifiedBackupArchive(sourceLink, join(root, 'link-copy.tar.gz'), digest), /not a symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive source FIFOs are rejected without waiting for a writer', { timeout: 3_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-backup-fifo-'));
  try {
    const fifo = join(root, 'archive.tar.gz');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const rescue = setTimeout(() => {
      void open(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
        .then(async (handle) => { await handle.close(); })
        .catch(() => undefined);
    }, 750);
    const startedAt = Date.now();
    try {
      await assert.rejects(
        copyVerifiedBackupArchive(fifo, join(root, 'copied.tar.gz'), '0'.repeat(64)),
        /must be a regular file/,
      );
      assert.ok(Date.now() - startedAt < 500, 'FIFO rejection waited for a writer');
    } finally {
      clearTimeout(rescue);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function archiveFixture(entries: ArchiveEntry[]): Promise<{ root: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-safe-archive-'));
  const archive = join(root, 'home.tar.gz');
  await writeFile(archive, gzipSync(encodeTar(entries)), { mode: 0o600 });
  return { root, archive };
}

function encodeTar(entries: ArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const specification of entries) {
    const body = Buffer.isBuffer(specification.body)
      ? specification.body
      : Buffer.from(specification.body ?? '', 'utf8');
    const { body: _body, ...metadata } = specification;
    const header = new Header({
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      mtime: new Date('2026-01-01T00:00:00Z'),
      ...metadata,
      size: body.length,
    });
    header.encode();
    assert.ok(header.block);
    blocks.push(header.block, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function limits(overrides: Partial<BackupArchiveLimits>): BackupArchiveLimits {
  return { ...BACKUP_ARCHIVE_LIMITS, ...overrides };
}

function paxRecord(key: string, value: string): string {
  const payload = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(payload, 'utf8') + 1;
  while (Buffer.byteLength(`${length}${payload}`, 'utf8') !== length) {
    length = Buffer.byteLength(`${length}${payload}`, 'utf8');
  }
  return `${length}${payload}`;
}

async function readFileNames(path: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(path);
}
