import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  link,
  mkdir,
  open,
  readlink,
  readdir,
  rm,
  symlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Parser, Unpack, type ReadEntry } from 'tar/raw';

export interface BackupArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxFilesystemEntries: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxPathBytes: number;
  maxPathDepth: number;
  maxPathTableBytes: number;
  maxLinkChain: number;
  maxLinkResolutionSteps: number;
  maxMetadataBytes: number;
  maxDecompressionRatio: number;
}

export const BACKUP_ARCHIVE_LIMITS: Readonly<BackupArchiveLimits> = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024 * 1024,
  maxEntries: 250_000,
  maxFilesystemEntries: 500_000,
  maxExpandedBytes: 128 * 1024 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024 * 1024,
  maxPathBytes: 4_096,
  maxPathDepth: 256,
  maxPathTableBytes: 64 * 1024 * 1024,
  maxLinkChain: 64,
  maxLinkResolutionSteps: 2_000_000,
  maxMetadataBytes: 1024 * 1024,
  maxDecompressionRatio: 1_000,
});

type ArchiveEntryKind = 'directory' | 'file' | 'hardlink' | 'symlink';

interface SafeArchiveEntry {
  name: string;
  kind: ArchiveEntryKind;
  size: number;
  mode: number;
  linkpath?: string;
  linkTarget?: string;
  resolvedHardlinkTarget?: string;
}

interface OpenedArchive {
  handle: FileHandle;
  size: number;
}

export interface SafeBackupArchivePlan {
  entries: ReadonlyMap<string, Readonly<SafeArchiveEntry>>;
  filesystemEntries: ReadonlyMap<string, ArchiveEntryKind>;
  expandedBytes: number;
  archiveSha256: string;
}

const allowedTypes = new Map<ReadEntry['type'], ArchiveEntryKind>([
  ['File', 'file'],
  ['OldFile', 'file'],
  ['Directory', 'directory'],
  ['Link', 'hardlink'],
  ['SymbolicLink', 'symlink'],
]);

export async function copyVerifiedBackupArchive(
  source: string,
  destination: string,
  expectedSha256: string,
  limits: Readonly<BackupArchiveLimits> = BACKUP_ARCHIVE_LIMITS,
): Promise<void> {
  const openedSource = await openArchive(source, limits, false);
  const sourceHandle = openedSource.handle;
  let destinationHandle: FileHandle | undefined;
  let destinationIdentity: { dev: number; ino: number } | undefined;
  let completed = false;
  const hash = createHash('sha256');
  let archiveBytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveBytes = checkedSum(archiveBytes, chunk.length);
      if (archiveBytes > limits.maxArchiveBytes) {
        callback(archiveError(`is larger than ${formatBytes(limits.maxArchiveBytes)}`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const created = await destinationHandle.stat();
    destinationIdentity = { dev: created.dev, ino: created.ino };
    let destinationOffset = 0;
    const writer = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const contents = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        writeAll(destinationHandle!, contents, destinationOffset)
          .then(() => {
            destinationOffset += contents.length;
            callback();
          }, callback);
      },
    });
    await pipeline(
      boundedArchiveReadStream(openedSource),
      hasher,
      writer,
    );
    if (destinationOffset !== openedSource.size) throw archiveError('changed size while it was being copied');
    await destinationHandle.sync();
    await destinationHandle.chmod(0o600);
    await assertSameRegularFile(destination, destinationHandle);
    const actual = hash.digest('hex');
    if (actual !== expectedSha256) {
      throw new Error(`Backup checksum mismatch: expected ${expectedSha256}, got ${actual}.`);
    }
    completed = true;
  } finally {
    try {
      await destinationHandle?.close();
    } finally {
      try {
        await sourceHandle.close();
      } finally {
        if (!completed && destinationIdentity) await removeFileIfSame(destination, destinationIdentity);
      }
    }
  }
}

async function writeAll(handle: FileHandle, contents: Buffer, start: number): Promise<void> {
  let offset = 0;
  while (offset < contents.length) {
    const { bytesWritten } = await handle.write(contents, offset, contents.length - offset, start + offset);
    if (bytesWritten <= 0) throw new Error('Backup archive copy made no write progress.');
    offset += bytesWritten;
  }
}

export async function inspectBackupArchive(
  archive: string,
  limits: Readonly<BackupArchiveLimits> = BACKUP_ARCHIVE_LIMITS,
): Promise<SafeBackupArchivePlan> {
  const entries = new Map<string, SafeArchiveEntry>();
  const entriesByCanonicalName = new Map<string, SafeArchiveEntry>();
  let expandedBytes = 0;
  let pathTableBytes = 0;

  const archiveSha256 = await parseArchive(archive, limits, {
    entry: (entry) => {
      const candidate = safeEntry(entry, limits);
      if (entries.has(candidate.name)) {
        throw archiveError(`contains duplicate or aliased path ${JSON.stringify(candidate.name)}`);
      }
      const collisionKey = unicodeCollisionKey(candidate.name);
      const collidingEntry = entriesByCanonicalName.get(collisionKey);
      if (collidingEntry !== undefined && collidingEntry.name !== candidate.name) {
        throw archiveError(`contains canonically equivalent paths ${JSON.stringify(collidingEntry.name)} and ${JSON.stringify(candidate.name)}`);
      }
      if (entries.size >= limits.maxEntries) {
        throw archiveError(`contains more than ${limits.maxEntries.toLocaleString('en-US')} entries`);
      }
      expandedBytes = checkedSum(expandedBytes, candidate.size);
      if (expandedBytes > limits.maxExpandedBytes) {
        throw archiveError(`expands beyond ${formatBytes(limits.maxExpandedBytes)}`);
      }
      pathTableBytes = checkedSum(
        pathTableBytes,
        Buffer.byteLength(candidate.name, 'utf8')
          + Buffer.byteLength(collisionKey, 'utf8')
          + Buffer.byteLength(candidate.linkpath ?? '', 'utf8'),
      );
      if (pathTableBytes > limits.maxPathTableBytes) {
        throw archiveError(`path metadata exceeds ${formatBytes(limits.maxPathTableBytes)}`);
      }
      entries.set(candidate.name, candidate);
      entriesByCanonicalName.set(collisionKey, candidate);
    },
    ignored: (entry) => {
      throw archiveError(`contains unsupported entry type ${entry.type} at ${JSON.stringify(entry.path)}`);
    },
  });

  const filesystemEntries = validateMetadataGraph(entries, entriesByCanonicalName, limits, pathTableBytes);
  return { entries, filesystemEntries, expandedBytes, archiveSha256 };
}

export async function extractInspectedBackupArchive(
  archive: string,
  destination: string,
  plan: SafeBackupArchivePlan,
  limits: Readonly<BackupArchiveLimits> = BACKUP_ARCHIVE_LIMITS,
): Promise<void> {
  const destinationHandle = await openEmptyDestination(destination);
  const seen = new Set<string>();
  let failure: Error | undefined;
  let unpack: Unpack;
  const reject = (error: unknown): false => {
    failure ??= archiveError(error instanceof Error ? error.message : String(error));
    return false;
  };

  try {
    unpack = new Unpack({
      cwd: destination,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      keep: true,
      unlink: false,
      chmod: false,
      umask: 0o077,
      dmode: 0o700,
      fmode: 0o600,
      maxDepth: limits.maxPathDepth,
      maxMetaEntrySize: limits.maxMetadataBytes,
      maxDecompressionRatio: limits.maxDecompressionRatio,
      filter: (_path, rawEntry) => {
        if (!('type' in rawEntry)) return reject('received a non-archive extraction entry');
        try {
          const observed = safeEntry(rawEntry, limits);
          const expected = plan.entries.get(observed.name);
          if (!expected || !sameEntry(expected, observed)) {
            return reject(`changed between inspection and extraction at ${JSON.stringify(observed.name)}`);
          }
          if (seen.has(observed.name)) return reject(`repeated path ${JSON.stringify(observed.name)} during extraction`);
          seen.add(observed.name);
          return observed.name !== '' && (observed.kind === 'file' || observed.kind === 'directory');
        } catch (error) {
          return reject(error);
        }
      },
    });

    unpack.on('ignoredEntry', (entry: ReadEntry) => {
      if (failure) {
        unpack.abort(failure);
        return;
      }
      try {
        const observed = safeEntry(entry, limits);
        const expected = plan.entries.get(observed.name);
        const deliberatelySkipped = expected
          && sameEntry(expected, observed)
          && seen.has(observed.name)
          && (observed.name === '' || observed.kind === 'hardlink' || observed.kind === 'symlink');
        if (!deliberatelySkipped) throw archiveError(`contains unsupported ignored entry at ${JSON.stringify(entry.path)}`);
      } catch (error) {
        failure = error instanceof Error ? error : archiveError(String(error));
        unpack.abort(failure);
      }
    });
    unpack.on('meta', (metadata: string) => {
      if (sparseMetadata(metadata)) {
        failure = archiveError('contains unsupported sparse-file metadata');
        unpack.abort(failure);
      }
    });

    const archiveSha256 = await pipeArchive(archive, unpack, limits);
    if (failure) throw failure;
    if (archiveSha256 !== plan.archiveSha256) {
      throw archiveError('changed between inspection and extraction');
    }
    if (seen.size !== plan.entries.size || [...plan.entries.keys()].some((name) => !seen.has(name))) {
      throw archiveError('changed between inspection and extraction');
    }

    await materializeValidatedLinks(destination, plan);
    await verifyExtractedTree(destination, plan);
    await assertSameDirectory(destination, destinationHandle);
  } finally {
    await destinationHandle.close();
  }
}

async function parseArchive(
  archive: string,
  limits: Readonly<BackupArchiveLimits>,
  handlers: { entry(entry: ReadEntry): void; ignored(entry: ReadEntry): void },
): Promise<string> {
  let failure: Error | undefined;
  const parser = new Parser({
    strict: true,
    maxMetaEntrySize: limits.maxMetadataBytes,
    maxDecompressionRatio: limits.maxDecompressionRatio,
  });
  parser.on('entry', (entry: ReadEntry) => {
    try {
      handlers.entry(entry);
    } catch (error) {
      failure = error instanceof Error ? error : archiveError(String(error));
      parser.abort(failure);
    } finally {
      entry.resume();
    }
  });
  parser.on('ignoredEntry', (entry: ReadEntry) => {
    try {
      handlers.ignored(entry);
    } catch (error) {
      failure = error instanceof Error ? error : archiveError(String(error));
      parser.abort(failure);
    }
  });
  parser.on('meta', (metadata: string) => {
    if (sparseMetadata(metadata)) {
      failure = archiveError('contains unsupported sparse-file metadata');
      parser.abort(failure);
    }
  });
  try {
    const archiveSha256 = await pipeArchive(archive, parser, limits);
    if (failure) throw failure;
    return archiveSha256;
  } catch (error) {
    throw failure ?? archiveError(error instanceof Error ? error.message : String(error));
  }
}

async function pipeArchive(
  archive: string,
  parser: Parser,
  limits: Readonly<BackupArchiveLimits>,
): Promise<string> {
  const openedArchive = await openArchive(archive, limits, true);
  const handle = openedArchive.handle;
  const hash = createHash('sha256');
  let archiveBytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveBytes = checkedSum(archiveBytes, chunk.length);
      if (archiveBytes > limits.maxArchiveBytes) {
        callback(archiveError(`is larger than ${formatBytes(limits.maxArchiveBytes)}`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(boundedArchiveReadStream(openedArchive), verifier, parser);
    if (archiveBytes !== openedArchive.size) throw archiveError('changed size while it was being read');
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function openArchive(
  path: string,
  limits: Readonly<BackupArchiveLimits>,
  requireGzip: boolean,
): Promise<OpenedArchive> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw archiveError('must be a regular file, not a symbolic link');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw archiveError('must be a regular file');
    if (info.size > limits.maxArchiveBytes) throw archiveError(`is larger than ${formatBytes(limits.maxArchiveBytes)}`);
    if (requireGzip) {
      const magic = Buffer.alloc(2);
      const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
      if (bytesRead !== magic.length || magic[0] !== 0x1f || magic[1] !== 0x8b) {
        throw archiveError('is not in the expected gzip-compressed tar format');
      }
    }
    return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function boundedArchiveReadStream(archive: OpenedArchive): Readable {
  return archive.size === 0
    ? Readable.from([])
    : archive.handle.createReadStream({ autoClose: false, start: 0, end: archive.size - 1 });
}

function safeEntry(entry: ReadEntry, limits: Readonly<BackupArchiveLimits>): SafeArchiveEntry {
  const kind = allowedTypes.get(entry.type);
  if (!kind) throw archiveError(`contains unsupported entry type ${entry.type} at ${JSON.stringify(entry.path)}`);
  const name = canonicalArchivePath(entry.path, limits, true);
  if (name === '' && kind !== 'directory') throw archiveError('uses the archive root for a non-directory entry');
  const size = checkedSize(entry.size, `entry ${JSON.stringify(name)}`);
  if (kind !== 'file' && size !== 0) throw archiveError(`${kind} ${JSON.stringify(name)} has unexpected body data`);
  if (kind === 'file' && size > limits.maxFileBytes) {
    throw archiveError(`file ${JSON.stringify(name)} is larger than ${formatBytes(limits.maxFileBytes)}`);
  }
  const mode = entry.mode ?? (kind === 'directory' ? 0o755 : 0o644);
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) {
    throw archiveError(`entry ${JSON.stringify(name)} has an invalid permission mode`);
  }
  if ((mode & 0o6000) !== 0) throw archiveError(`entry ${JSON.stringify(name)} requests set-user-ID or set-group-ID permissions`);
  if (kind !== 'directory' && entry.path.endsWith('/')) {
    throw archiveError(`non-directory entry ${JSON.stringify(name)} has a directory-style path`);
  }

  if (kind === 'symlink') {
    const linkpath = requiredLinkpath(entry, name, limits);
    return { name, kind, size, mode, linkpath };
  }
  if (kind === 'hardlink') {
    const linkpath = requiredLinkpath(entry, name, limits);
    return { name, kind, size, mode, linkpath, linkTarget: canonicalArchivePath(linkpath, limits, false) };
  }
  if (entry.linkpath) throw archiveError(`non-link entry ${JSON.stringify(name)} has a link target`);
  return { name, kind, size, mode };
}

function requiredLinkpath(entry: ReadEntry, name: string, limits: Readonly<BackupArchiveLimits>): string {
  if (!entry.linkpath) throw archiveError(`link ${JSON.stringify(name)} has no target`);
  if (Buffer.byteLength(entry.linkpath, 'utf8') > limits.maxPathBytes) {
    throw archiveError(`link target for ${JSON.stringify(name)} is longer than ${limits.maxPathBytes} bytes`);
  }
  if (entry.linkpath.includes('\\')) throw archiveError(`link ${JSON.stringify(name)} uses an ambiguous backslash target`);
  if (posix.isAbsolute(entry.linkpath) || windowsAbsolute(entry.linkpath)) {
    throw archiveError(`link ${JSON.stringify(name)} targets an absolute path`);
  }
  return entry.linkpath;
}

function canonicalArchivePath(raw: string, limits: Readonly<BackupArchiveLimits>, allowRoot: boolean): string {
  if (!raw || raw.includes('\0')) throw archiveError(`contains invalid empty or NUL path ${JSON.stringify(raw)}`);
  if (Buffer.byteLength(raw, 'utf8') > limits.maxPathBytes) {
    throw archiveError(`contains a path longer than ${limits.maxPathBytes} bytes`);
  }
  if (raw.includes('\\')) throw archiveError(`contains ambiguous backslash path ${JSON.stringify(raw)}`);
  if (posix.isAbsolute(raw) || windowsAbsolute(raw)) throw archiveError(`contains absolute path ${JSON.stringify(raw)}`);
  const components: string[] = [];
  for (const component of raw.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') throw archiveError(`contains traversal path ${JSON.stringify(raw)}`);
    components.push(component);
  }
  if (components.length > limits.maxPathDepth) {
    throw archiveError(`contains a path deeper than ${limits.maxPathDepth} components`);
  }
  const canonical = components.join('/');
  if (!canonical && !allowRoot) throw archiveError(`link target ${JSON.stringify(raw)} resolves to the archive root`);
  return canonical;
}

function validateMetadataGraph(
  entries: Map<string, SafeArchiveEntry>,
  entriesByCanonicalName: ReadonlyMap<string, SafeArchiveEntry>,
  limits: Readonly<BackupArchiveLimits>,
  initialPathTableBytes: number,
): ReadonlyMap<string, ArchiveEntryKind> {
  const root = entries.get('');
  if (root && root.kind !== 'directory') throw archiveError('uses the archive root for a non-directory entry');
  const filesystemEntries = new Map<string, ArchiveEntryKind>();
  const filesystemCanonicalNames = new Map<string, string>();
  let pathTableBytes = initialPathTableBytes;
  let linkResolutionSteps = 0;
  const linkStep = (): void => {
    linkResolutionSteps += 1;
    if (linkResolutionSteps > limits.maxLinkResolutionSteps) {
      throw archiveError(`link graph exceeds the ${limits.maxLinkResolutionSteps.toLocaleString('en-US')} step validation budget`);
    }
  };
  const addFilesystemEntry = (name: string, kind: ArchiveEntryKind, implicit: boolean): void => {
    const collisionKey = unicodeCollisionKey(name);
    const explicitCollision = entriesByCanonicalName.get(collisionKey);
    const graphCollision = filesystemCanonicalNames.get(collisionKey);
    const collidingName = explicitCollision && explicitCollision.name !== name
      ? explicitCollision.name
      : graphCollision !== undefined && graphCollision !== name
        ? graphCollision
        : undefined;
    if (collidingName !== undefined) {
      throw archiveError(`contains canonically equivalent filesystem paths ${JSON.stringify(collidingName)} and ${JSON.stringify(name)}`);
    }
    if (!filesystemEntries.has(name)) {
      if (filesystemEntries.size >= limits.maxFilesystemEntries) {
        throw archiveError(`filesystem graph contains more than ${limits.maxFilesystemEntries.toLocaleString('en-US')} explicit and implicit entries`);
      }
      pathTableBytes = checkedSum(
        pathTableBytes,
        (implicit ? Buffer.byteLength(name, 'utf8') : 0) + Buffer.byteLength(collisionKey, 'utf8'),
      );
      if (pathTableBytes > limits.maxPathTableBytes) {
        throw archiveError(`path metadata exceeds ${formatBytes(limits.maxPathTableBytes)}`);
      }
    }
    filesystemEntries.set(name, kind);
    filesystemCanonicalNames.set(collisionKey, name);
  };

  for (const entry of entries.values()) {
    if (entry.name) addFilesystemEntry(entry.name, entry.kind, false);
    const components = entry.name.split('/').filter(Boolean);
    for (let index = 1; index < components.length; index += 1) {
      const ancestor = components.slice(0, index).join('/');
      const declared = entriesByCanonicalName.get(unicodeCollisionKey(ancestor));
      if (declared && declared.kind !== 'directory') {
        throw archiveError(`places ${JSON.stringify(entry.name)} beneath non-directory ${JSON.stringify(ancestor)}`);
      }
      addFilesystemEntry(ancestor, 'directory', !entries.has(ancestor));
    }
  }

  for (const entry of entries.values()) {
    if (entry.kind === 'hardlink') {
      entry.resolvedHardlinkTarget = resolveHardlink(entry, entriesByCanonicalName, limits, linkStep);
    }
  }
  for (const entry of entries.values()) {
    if (entry.kind === 'symlink') assertConfinedAcyclicSymlink(entry, entriesByCanonicalName, limits, linkStep);
  }
  return filesystemEntries;
}

function resolveHardlink(
  entry: SafeArchiveEntry,
  entriesByCanonicalName: ReadonlyMap<string, SafeArchiveEntry>,
  limits: Readonly<BackupArchiveLimits>,
  linkStep: () => void,
): string {
  let target = entry.linkTarget!;
  const visited = new Set([unicodeCollisionKey(entry.name)]);
  while (true) {
    linkStep();
    if (visited.size > limits.maxLinkChain) throw archiveError(`hardlink chain from ${JSON.stringify(entry.name)} is too deep`);
    const targetKey = unicodeCollisionKey(target);
    if (visited.has(targetKey)) throw archiveError(`hardlink cycle includes ${JSON.stringify(target)}`);
    visited.add(targetKey);
    const candidate = entriesByCanonicalName.get(targetKey);
    if (!candidate) throw archiveError(`hardlink ${JSON.stringify(entry.name)} targets missing member ${JSON.stringify(target)}`);
    if (candidate.kind === 'file') return candidate.name;
    if (candidate.kind !== 'hardlink') {
      throw archiveError(`hardlink ${JSON.stringify(entry.name)} does not resolve to a regular file`);
    }
    target = candidate.linkTarget!;
  }
}

function assertConfinedAcyclicSymlink(
  entry: SafeArchiveEntry,
  entriesByCanonicalName: ReadonlyMap<string, SafeArchiveEntry>,
  limits: Readonly<BackupArchiveLimits>,
  linkStep: () => void,
): void {
  const resolved = dirnameArchivePath(entry.name).split('/').filter(Boolean);
  let resolvedBytes = Buffer.byteLength(resolved.join('/'), 'utf8');
  let pending = entry.linkpath!.split('/');
  let pendingIndex = 0;
  const followed = new Set([unicodeCollisionKey(entry.name)]);

  while (pendingIndex < pending.length) {
    linkStep();
    const component = pending[pendingIndex++]!;
    if (!component || component === '.') continue;
    if (component === '..') {
      if (!resolved.length) throw archiveError(`symlink ${JSON.stringify(entry.name)} escapes the archive root`);
      const removed = resolved.pop()!;
      resolvedBytes -= Buffer.byteLength(removed, 'utf8') + (resolved.length ? 1 : 0);
      continue;
    }

    resolvedBytes += Buffer.byteLength(component, 'utf8') + (resolved.length ? 1 : 0);
    resolved.push(component);
    if (resolved.length > limits.maxPathDepth) {
      throw archiveError(`symlink chain from ${JSON.stringify(entry.name)} is too deep`);
    }
    if (resolvedBytes > limits.maxPathBytes) {
      throw archiveError(`symlink chain from ${JSON.stringify(entry.name)} resolves to a path longer than ${limits.maxPathBytes} bytes`);
    }

    const prefix = resolved.join('/');
    const prefixKey = unicodeCollisionKey(prefix);
    const candidate = entriesByCanonicalName.get(prefixKey);
    if (candidate?.kind !== 'symlink') continue;
    if (followed.has(prefixKey)) throw archiveError(`symlink cycle includes ${JSON.stringify(prefix)}`);
    if (followed.size >= limits.maxLinkChain) {
      throw archiveError(`symlink chain from ${JSON.stringify(entry.name)} is too deep`);
    }
    followed.add(prefixKey);
    const removed = resolved.pop()!;
    resolvedBytes -= Buffer.byteLength(removed, 'utf8') + (resolved.length ? 1 : 0);
    pending = [...candidate.linkpath!.split('/'), ...pending.slice(pendingIndex)];
    pendingIndex = 0;
  }
}

async function materializeValidatedLinks(root: string, plan: SafeBackupArchivePlan): Promise<void> {
  const directories = [...plan.filesystemEntries]
    .filter(([, kind]) => kind === 'directory')
    .map(([name]) => name)
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  for (const name of directories) {
    const path = resolve(root, ...name.split('/'));
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw archiveError(`expected ${JSON.stringify(name)} to be a real directory`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(path, { recursive: false, mode: 0o700 });
    }
  }
  for (const entry of plan.entries.values()) {
    if (entry.kind !== 'hardlink') continue;
    const source = resolve(root, ...entry.resolvedHardlinkTarget!.split('/'));
    const destination = resolve(root, ...entry.name.split('/'));
    await assertRegularFile(source);
    await link(source, destination);
  }
  for (const entry of plan.entries.values()) {
    if (entry.kind !== 'symlink') continue;
    await symlink(entry.linkpath!, resolve(root, ...entry.name.split('/')));
  }
}

async function verifyExtractedTree(root: string, plan: SafeBackupArchivePlan): Promise<void> {
  const seen = new Set<string>();
  const identities = new Map<string, { dev: number; ino: number }>();
  await walkDirectory(root, '', plan, seen, identities);
  if (seen.size !== plan.filesystemEntries.size || [...plan.filesystemEntries.keys()].some((name) => !seen.has(name))) {
    throw archiveError('staged filesystem does not exactly match the inspected archive graph');
  }
  for (const entry of plan.entries.values()) {
    if (entry.kind !== 'hardlink') continue;
    const actual = identities.get(entry.name);
    const target = identities.get(entry.resolvedHardlinkTarget!);
    if (!actual || !target || actual.dev !== target.dev || actual.ino !== target.ino) {
      throw archiveError(`hardlink ${JSON.stringify(entry.name)} is not linked to its validated regular-file target`);
    }
  }
}

async function walkDirectory(
  root: string,
  relativeDirectory: string,
  plan: SafeBackupArchivePlan,
  seen: Set<string>,
  identities: Map<string, { dev: number; ino: number }>,
): Promise<void> {
  const path = relativeDirectory ? join(root, ...relativeDirectory.split('/')) : root;
  const directoryHandle = await openNoFollowDirectory(path);
  try {
    const before = await directoryHandle.stat();
    const pathnameBefore = await lstat(path);
    if (
      !before.isDirectory()
      || !pathnameBefore.isDirectory()
      || pathnameBefore.isSymbolicLink()
      || pathnameBefore.dev !== before.dev
      || pathnameBefore.ino !== before.ino
    ) throw archiveError(`directory ${JSON.stringify(relativeDirectory || '.')} changed before verification`);
    for (const dirent of await readdir(path, { withFileTypes: true })) {
      const name = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
      const expectedKind = plan.filesystemEntries.get(name);
      if (!expectedKind) throw archiveError(`extraction created unexpected path ${JSON.stringify(name)}`);
      if (seen.has(name)) throw archiveError(`extraction produced duplicate path ${JSON.stringify(name)}`);
      seen.add(name);
      const child = join(path, dirent.name);
      const info = await lstat(child);
      if (expectedKind === 'directory') {
        if (!info.isDirectory() || info.isSymbolicLink()) throw archiveError(`expected ${JSON.stringify(name)} to be a real directory`);
        await walkDirectory(root, name, plan, seen, identities);
        continue;
      }
      if (expectedKind === 'symlink') {
        if (!info.isSymbolicLink()) throw archiveError(`expected ${JSON.stringify(name)} to be a symbolic link`);
        const expected = plan.entries.get(name)!;
        if (await readlink(child) !== expected.linkpath) throw archiveError(`symlink ${JSON.stringify(name)} changed target during extraction`);
        const after = await lstat(child);
        if (after.dev !== info.dev || after.ino !== info.ino || !after.isSymbolicLink()) {
          throw archiveError(`symlink ${JSON.stringify(name)} changed during verification`);
        }
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw archiveError(`expected ${JSON.stringify(name)} to be a regular file`);
      const handle = await openNoFollowFile(child);
      try {
        const descriptor = await handle.stat();
        if (!descriptor.isFile() || descriptor.dev !== info.dev || descriptor.ino !== info.ino) {
          throw archiveError(`file ${JSON.stringify(name)} changed during verification`);
        }
        const archiveEntry = plan.entries.get(name)!;
        const expectedSize = archiveEntry.kind === 'hardlink'
          ? plan.entries.get(archiveEntry.resolvedHardlinkTarget!)!.size
          : archiveEntry.size;
        if (descriptor.size !== expectedSize) throw archiveError(`file ${JSON.stringify(name)} has an unexpected extracted size`);
        const pathnameAfter = await lstat(child);
        if (
          !pathnameAfter.isFile()
          || pathnameAfter.isSymbolicLink()
          || pathnameAfter.dev !== descriptor.dev
          || pathnameAfter.ino !== descriptor.ino
        ) throw archiveError(`file ${JSON.stringify(name)} changed during verification`);
        identities.set(name, { dev: descriptor.dev, ino: descriptor.ino });
      } finally {
        await handle.close();
      }
    }
    const after = await directoryHandle.stat();
    const pathnameAfter = await lstat(path);
    if (
      !after.isDirectory()
      || !pathnameAfter.isDirectory()
      || pathnameAfter.isSymbolicLink()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || pathnameAfter.dev !== after.dev
      || pathnameAfter.ino !== after.ino
    ) {
      throw archiveError(`directory ${JSON.stringify(relativeDirectory || '.')} changed during verification`);
    }
  } finally {
    await directoryHandle.close();
  }
}

async function openEmptyDestination(path: string): Promise<FileHandle> {
  const handle = await openNoFollowDirectory(path);
  try {
    await assertSameDirectory(path, handle);
    if ((await readdir(path)).length) throw archiveError('private extraction destination is not empty');
    await handle.chmod(0o700);
    await assertSameDirectory(path, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertSameRegularFile(path: string, handle: FileHandle): Promise<void> {
  const [descriptor, pathname] = await Promise.all([handle.stat(), lstat(path)]);
  if (!descriptor.isFile() || !pathname.isFile() || pathname.isSymbolicLink() || descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino) {
    throw archiveError(`regular file ${JSON.stringify(path)} changed while it was in use`);
  }
}

async function removeFileIfSame(path: string, identity: { dev: number; ino: number }): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
      await rm(path, { force: false });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertSameDirectory(path: string, handle: FileHandle): Promise<void> {
  const [descriptor, pathname] = await Promise.all([handle.stat(), lstat(path)]);
  if (!pathname.isDirectory() || pathname.isSymbolicLink() || descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino) {
    throw archiveError('private extraction destination changed while it was in use');
  }
}

async function openNoFollowDirectory(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw archiveError(`refused symbolic-link directory ${JSON.stringify(path)}`);
    throw error;
  }
}

async function openNoFollowFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw archiveError(`refused symbolic-link file ${JSON.stringify(path)}`);
    throw error;
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const handle = await openNoFollowFile(path);
  try {
    if (!(await handle.stat()).isFile()) throw archiveError(`hardlink target ${JSON.stringify(path)} is not a regular file`);
  } finally {
    await handle.close();
  }
}

function sameEntry(expected: Readonly<SafeArchiveEntry>, observed: Readonly<SafeArchiveEntry>): boolean {
  return expected.name === observed.name
    && expected.kind === observed.kind
    && expected.size === observed.size
    && expected.mode === observed.mode
    && expected.linkpath === observed.linkpath
    && expected.linkTarget === observed.linkTarget;
}

function sparseMetadata(metadata: string): boolean {
  return /(?:GNU\.sparse(?:\.|=)|SCHILY\.(?:realsize|sparse)(?:\.|=)|SCHILY\.filetype=sparse|SUN\.holesdata=)/u.test(metadata);
}

function windowsAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith('//') || path.startsWith('\\\\');
}

function unicodeCollisionKey(path: string): string {
  return path.split('/').map((component) => component.normalize('NFC')).join('/');
}

function dirnameArchivePath(path: string): string {
  const directory = posix.dirname(path);
  return directory === '.' ? '' : directory;
}

function checkedSize(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw archiveError(`${label} has an invalid size`);
  return value;
}

function checkedSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw archiveError('declares an unsafe total expanded size');
  return result;
}

function archiveError(message: string): Error {
  return message.startsWith('Backup archive ') ? new Error(message) : new Error(`Backup archive ${message}.`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) {
    const mebibytes = bytes / (1024 * 1024);
    return `${Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)} MiB`;
  }
  const gibibytes = bytes / (1024 * 1024 * 1024);
  return `${Number.isInteger(gibibytes) ? gibibytes : gibibytes.toFixed(1)} GiB`;
}
