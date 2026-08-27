import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  rmdirSync,
  writeSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import type { BoundedArchiveEntryIdentity, BoundedFileSystem, FileIdentity } from './bounded-files.js';
import { QubiclError } from './errors.js';
import { mapFileSystemError } from './file-errors.js';

// Node does not expose Linux O_TMPFILE. The ABI flag is __O_TMPFILE plus
// O_DIRECTORY; using it on the pinned directory creates no mutable pathname.
const LINUX_O_TMPFILE = 0o20000000 | constants.O_DIRECTORY;

export const OPEN_TERMINAL_ARCHIVE_LIMITS = Object.freeze({
  maximumPaths: 128,
  maximumEntries: 10_000,
  maximumMetadataBytes: 16 * 1024 * 1024,
  maximumFileBytes: 20 * 1024 * 1024,
  maximumInputBytes: 100 * 1024 * 1024,
  maximumOutputBytes: 100 * 1024 * 1024,
  maximumConcurrentArchives: 2,
  maximumReservedOutputBytes: 200 * 1024 * 1024,
  timeoutMs: 30_000,
  sendTimeoutMs: 120_000,
});

export interface OpenTerminalArchive {
  descriptor: number;
  size: number;
  identity: { dev: bigint; ino: bigint; size: bigint };
  cleanup(): Promise<void>;
}

export interface OpenTerminalArchiveHooks {
  afterDirectoryPinned?(directory: string): Promise<void> | void;
  afterOutputOpened?(descriptor: number): Promise<void> | void;
  signal?: AbortSignal;
}

interface PinnedTemporaryDirectory {
  path: string;
  descriptor: number;
  identity: { dev: bigint; ino: bigint };
}

interface ArchiveEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  expected: BoundedArchiveEntryIdentity;
}

export async function createOpenTerminalArchive(
  files: BoundedFileSystem,
  paths: readonly string[],
  hooks: OpenTerminalArchiveHooks = {},
): Promise<OpenTerminalArchive> {
  if (paths.length < 1 || paths.length > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumPaths) {
    throw new QubiclError('invalid_arguments', `Archive requests require 1 through ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumPaths} paths.`, 400);
  }
  const deadline = Date.now() + OPEN_TERMINAL_ARCHIVE_LIMITS.timeoutMs;
  const entries = await inventoryEntries(files, paths, deadline, hooks.signal);
  let directory: PinnedTemporaryDirectory | undefined = await createPinnedTemporaryDirectory();
  let descriptor: number | undefined;
  let createdIdentity: { dev: bigint; ino: bigint } | undefined;
  try {
    await hooks.afterDirectoryPinned?.(directory.path);
    assertArchiveActive(deadline, hooks.signal);
    descriptor = openUnnamedArchive(directory.descriptor);
    fchmodSync(descriptor, 0o400);
    const createdInfo = fstatSync(descriptor, { bigint: true });
    if (!createdInfo.isFile() || createdInfo.nlink !== 0n || (createdInfo.mode & 0o777n) !== 0o400n) {
      throw new Error('The ZIP output was not created as a private regular file.');
    }
    await hooks.afterOutputOpened?.(descriptor);
    assertArchiveActive(deadline, hooks.signal);
    createdIdentity = { dev: createdInfo.dev, ino: createdInfo.ino };
    cleanupPinnedTemporaryDirectory(directory);
    directory = undefined;
    let outputBytes = 0;
    let inputBytes = 0;
    let failure: Error | undefined;
    let finalSeen = false;
    const zip = new Zip((error, chunk, final) => {
      if (failure) return;
      if (hooks.signal?.aborted) {
        failure = archiveCancelled();
        return;
      }
      if (error) {
        failure = error;
        return;
      }
      if (!chunk) {
        failure = new Error('The ZIP encoder returned an empty output chunk.');
        return;
      }
      if (outputBytes + chunk.length > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumOutputBytes) {
        failure = new QubiclError('archive_too_large', `Archive output exceeds ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumOutputBytes} bytes.`, 413);
        return;
      }
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const written = writeSync(descriptor!, chunk, offset, chunk.length - offset);
          if (written < 1) throw new Error('The archive output file accepted a zero-byte write.');
          offset += written;
        }
        outputBytes += chunk.length;
        if (final) finalSeen = true;
      } catch (writeError) {
        failure = writeError as Error;
      }
    });
    for (const entry of entries) {
      assertArchiveActive(deadline, hooks.signal);
      const current = await archiveIdentity(files, entry.path, deadline, hooks.signal);
      if (!sameArchiveIdentity(current, entry.expected)) {
        throw new QubiclError('path_changed', `Path ${entry.path} changed while the archive was being created. Retry the operation.`, 409);
      }
      const stream = new ZipPassThrough(entry.name);
      stream.os = 3;
      stream.attrs = (entry.type === 'directory' ? 0o40700 : 0o100600) * 0x10000;
      zip.add(stream);
      if (entry.type === 'directory') {
        stream.push(new Uint8Array(), true);
        if (failure) throw failure;
        continue;
      }
      try {
        const expectedBytes = entry.expected.info.size;
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes) {
          throw new QubiclError('file_too_large', `${entry.path} exceeds the ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes}-byte archive limit.`, 413);
        }
        if (expectedBytes === 0) stream.push(new Uint8Array(), true);
        let streamedBytes = 0;
        await files.readArchiveFile(entry.path, {
          expected: entry.expected,
          maximumBytes: OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes,
          deadline,
          ...(hooks.signal ? { signal: hooks.signal } : {}),
          onChunk: (chunk) => {
            assertArchiveActive(deadline, hooks.signal);
            inputBytes += chunk.length;
            streamedBytes += chunk.length;
            if (inputBytes > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumInputBytes) {
              throw new QubiclError('archive_too_large', `Archive input exceeds ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumInputBytes} bytes.`, 413);
            }
            stream.push(chunk, streamedBytes === expectedBytes);
            if (failure) throw failure;
          },
        });
      } catch (error) {
        if (isAbort(error) || hooks.signal?.aborted) throw archiveCancelled();
        if (isErrno(error, 'EFBIG')) throw new QubiclError('file_too_large', `${entry.path} exceeds the ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes}-byte archive limit.`, 413);
        if (isErrno(error, 'ETIMEDOUT')) throw new QubiclError('archive_timeout', `Archive creation exceeded ${OPEN_TERMINAL_ARCHIVE_LIMITS.timeoutMs} milliseconds.`, 504);
        throw mapFileSystemError(error, { operation: 'read', path: entry.path });
      }
      assertArchiveActive(deadline, hooks.signal);
    }
    zip.end();
    if (failure) throw failure;
    if (!finalSeen) throw new Error('The ZIP encoder did not finish the archive.');
    assertArchiveActive(deadline, hooks.signal);
    const info = fstatSync(descriptor, { bigint: true });
    if (!info.isFile() || info.nlink !== 0n || (info.mode & 0o222n) !== 0n || info.size !== BigInt(outputBytes)
      || createdIdentity === undefined || info.dev !== createdIdentity.dev || info.ino !== createdIdentity.ino) {
      throw new Error('The completed ZIP output identity or size is invalid.');
    }
    const readDescriptor = openSync(descriptorPath(descriptor), constants.O_RDONLY);
    const readInfo = fstatSync(readDescriptor, { bigint: true });
    if (!readInfo.isFile() || readInfo.nlink !== 0n || (readInfo.mode & 0o222n) !== 0n
      || readInfo.dev !== info.dev || readInfo.ino !== info.ino || readInfo.size !== info.size) {
      closeSync(readDescriptor);
      throw new Error('The ZIP read descriptor does not match the completed output identity.');
    }
    closeSync(descriptor);
    descriptor = readDescriptor;
    let activeDescriptor: number | undefined = descriptor;
    descriptor = undefined;
    return {
      descriptor: activeDescriptor,
      size: outputBytes,
      identity: { dev: info.dev, ino: info.ino, size: info.size },
      cleanup: async () => {
        if (activeDescriptor !== undefined) {
          try { closeSync(activeDescriptor); } catch { /* best-effort */ }
          activeDescriptor = undefined;
        }
      },
    };
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best-effort */ }
    if (directory) cleanupPinnedTemporaryDirectory(directory);
    throw error;
  }
}

async function createPinnedTemporaryDirectory(): Promise<PinnedTemporaryDirectory> {
  const path = await mkdtemp(join(tmpdir(), 'qubicl-open-terminal-archive-'));
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fchmodSync(descriptor, 0o700);
    const info = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
      || (info.mode & 0o077n) !== 0n || info.dev !== named.dev || info.ino !== named.ino) {
      throw new Error('The private ZIP output directory changed while it was being pinned.');
    }
    return { path, descriptor, identity: { dev: info.dev, ino: info.ino } };
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* best-effort */ }
    try { rmdirSync(path); } catch { /* never remove an ambiguous or non-empty substitution */ }
    throw error;
  }
}

function cleanupPinnedTemporaryDirectory(directory: PinnedTemporaryDirectory): void {
  try {
    const info = fstatSync(directory.descriptor, { bigint: true });
    const named = lstatSync(directory.path, { bigint: true });
    if (!info.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
      || info.dev !== directory.identity.dev || info.ino !== directory.identity.ino
      || named.dev !== directory.identity.dev || named.ino !== directory.identity.ino
      || readdirSync(descriptorPath(directory.descriptor)).length !== 0) return;
    rmdirSync(directory.path);
  } catch {
    // Never recursively remove a changed, unavailable, or non-empty path.
  } finally {
    try { closeSync(directory.descriptor); } catch { /* best-effort */ }
  }
}

function openUnnamedArchive(directoryDescriptor: number): number {
  if (process.platform !== 'linux') {
    throw new QubiclError('archive_capability_unavailable', 'Secure archive output requires Linux unnamed temporary-file support.', 501);
  }
  try {
    return openSync(descriptorPath(directoryDescriptor), LINUX_O_TMPFILE | constants.O_RDWR, 0o400);
  } catch (error) {
    if (['EOPNOTSUPP', 'EINVAL', 'EISDIR', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new QubiclError('archive_capability_unavailable', 'The host filesystem does not support secure unnamed archive output.', 501);
    }
    throw error;
  }
}

function descriptorPath(descriptor: number): string {
  return process.platform === 'linux' ? `/proc/self/fd/${descriptor}` : `/dev/fd/${descriptor}`;
}

async function inventoryEntries(
  files: BoundedFileSystem,
  paths: readonly string[],
  deadline: number,
  signal?: AbortSignal,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  const topNames = new Set<string>();
  let metadataBytes = 0;
  for (const path of paths) {
    assertArchiveActive(deadline, signal);
    const name = safeArchiveName(basename(path));
    if (topNames.has(name)) throw new QubiclError('archive_name_conflict', `Multiple requested paths would use the archive name ${name}.`, 400);
    topNames.add(name);
    const expected = await archiveIdentity(files, path, deadline, signal);
    const info = expected.info;
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new QubiclError('archive_entry_invalid', `${path} is not a regular file or directory. Symbolic links and special files are not archived.`, 400);
    }
    if (info.isFile()) {
      if (info.size > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes) {
        throw new QubiclError('file_too_large', `${path} exceeds the ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes}-byte archive limit.`, 413);
      }
      metadataBytes = pushEntry(entries, { path, name, type: 'file', expected }, metadataBytes);
      continue;
    }
    metadataBytes = pushEntry(entries, { path, name: `${name}/`, type: 'directory', expected }, metadataBytes);
    const remainingMetadata = OPEN_TERMINAL_ARCHIVE_LIMITS.maximumMetadataBytes - metadataBytes;
    if (remainingMetadata < 1) throw archiveMetadataLimit();
    let listing;
    try {
      listing = await files.walkArchive(path, {
        maximumEntries: Math.max(1, OPEN_TERMINAL_ARCHIVE_LIMITS.maximumEntries - entries.length),
        maximumMetadataBytes: remainingMetadata,
        deadline,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbort(error) || signal?.aborted) throw archiveCancelled();
      if (isErrno(error, 'EFBIG')) throw archiveMetadataLimit();
      if (isErrno(error, 'ETIMEDOUT')) throw archiveTimeout();
      throw mapFileSystemError(error, { operation: 'list', path });
    }
    metadataBytes += listing.metadataBytes;
    for (const entry of listing.entries) {
      assertArchiveActive(deadline, signal);
      const relative = safeRelativeName(entry.name);
      if (entry.type === 'symlink' || entry.type === 'other') {
        throw new QubiclError('archive_entry_invalid', `${join(path, entry.name)} is not a regular file or directory. Symbolic links and special files are not archived.`, 400);
      }
      const entryPath = join(path, entry.name);
      const entryExpected = await archiveIdentity(files, entryPath, deadline, signal);
      const expectedType = entryExpected.info.isFile() ? 'file' : entryExpected.info.isDirectory() ? 'directory' : 'other';
      if (expectedType !== entry.type) {
        throw new QubiclError('path_changed', `Path ${entryPath} changed while the archive was being inventoried. Retry the operation.`, 409);
      }
      if (entryExpected.info.isFile() && entryExpected.info.size > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes) {
        throw new QubiclError('file_too_large', `${entryPath} exceeds the ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumFileBytes}-byte archive limit.`, 413);
      }
      metadataBytes = pushEntry(entries, {
        path: entryPath,
        name: `${name}/${relative}${entry.type === 'directory' ? '/' : ''}`,
        type: entry.type,
        expected: entryExpected,
      }, metadataBytes);
    }
  }
  return entries;
}

function sameArchiveIdentity(left: BoundedArchiveEntryIdentity, right: BoundedArchiveEntryIdentity): boolean {
  return sameFileIdentity(left.identity, right.identity)
    && left.chainLength === right.chainLength
    && left.chainDigest === right.chainDigest;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs && left.size === right.size;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function pushEntry(entries: ArchiveEntry[], entry: ArchiveEntry, metadataBytes: number): number {
  if (entries.length >= OPEN_TERMINAL_ARCHIVE_LIMITS.maximumEntries) {
    throw new QubiclError('too_many_entries', `Archive input exceeds ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumEntries} entries.`, 413);
  }
  const nextMetadataBytes = metadataBytes
    + Buffer.byteLength(entry.path, 'utf8')
    + Buffer.byteLength(entry.name, 'utf8')
    + 256;
  if (nextMetadataBytes > OPEN_TERMINAL_ARCHIVE_LIMITS.maximumMetadataBytes) throw archiveMetadataLimit();
  entries.push(entry);
  return nextMetadataBytes;
}

function safeArchiveName(value: string): string {
  if (!value || value === '.' || value === '..' || hasUnsafeArchiveNameCharacter(value, true)) {
    throw new QubiclError('archive_entry_invalid', 'Archive paths contain a filename that cannot be represented safely.', 400);
  }
  return value;
}

function safeRelativeName(value: string): string {
  const normalized = sep === '/' ? value : value.split(sep).join('/');
  const parts = normalized.split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || hasUnsafeArchiveNameCharacter(part, false))) {
    throw new QubiclError('archive_entry_invalid', 'Archive paths contain a filename that cannot be represented safely.', 400);
  }
  return parts.join('/');
}

function hasUnsafeArchiveNameCharacter(value: string, rejectSlash: boolean): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20 || character === '\\' || (rejectSlash && character === '/')) return true;
  }
  return false;
}

async function archiveIdentity(
  files: BoundedFileSystem,
  path: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<BoundedArchiveEntryIdentity> {
  assertArchiveActive(deadline, signal);
  try {
    const identity = await files.archiveIdentity(path, { deadline, ...(signal ? { signal } : {}) });
    assertArchiveActive(deadline, signal);
    return identity;
  } catch (error) {
    if (isAbort(error) || signal?.aborted) throw archiveCancelled();
    if (isErrno(error, 'ETIMEDOUT')) throw archiveTimeout();
    throw mapFileSystemError(error, { operation: 'inspect', path });
  }
}

function assertArchiveActive(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw archiveCancelled();
  if (Date.now() > deadline) throw archiveTimeout();
}

function archiveCancelled(): QubiclError {
  return new QubiclError('archive_cancelled', 'Archive creation was cancelled because the client disconnected.', 499);
}

function archiveTimeout(): QubiclError {
  return new QubiclError('archive_timeout', `Archive creation exceeded ${OPEN_TERMINAL_ARCHIVE_LIMITS.timeoutMs} milliseconds.`, 504);
}

function archiveMetadataLimit(): QubiclError {
  return new QubiclError(
    'archive_too_large',
    `Archive inventory exceeds the ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumEntries}-entry or ${OPEN_TERMINAL_ARCHIVE_LIMITS.maximumMetadataBytes}-byte metadata limit.`,
    413,
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
