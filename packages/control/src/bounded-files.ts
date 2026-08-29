import { constants, type Stats } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readlink,
  readdir,
  rm,
  rmdir,
  symlink,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

// Node does not currently expose Linux O_PATH. Keeping the numeric ABI value
// local to this Linux-only runtime lets traversal work through execute-only
// directories without granting or requiring directory read access.
const LINUX_O_PATH = 0o10000000;
const TRAVERSAL_DIRECTORY_FLAGS = LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK prevents a named pipe or device from stalling the control plane
// before its opened type can be rejected. It has no effect on regular files.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_SYMLINKS = 40;
const COPY_BUFFER_BYTES = 128 * 1024;
const SPARSE_BLOCK_BYTES = 4096;
const MIN_CLONE_BYTES = 1024 * 1024;
const RENAME_NOREPLACE = 1;
const mutationQueues = new Map<string, Promise<void>>();
const cloneCapabilities = new Map<string, boolean>();
let defaultCapabilityProbe: Promise<void> | undefined;

export type BoundedFileOperation = 'list' | 'inspect' | 'read' | 'write' | 'edit' | 'copy' | 'move' | 'delete';

export interface BoundedFileHookEvent {
  operation: BoundedFileOperation;
  stage: 'parent-resolved' | 'destination-checked' | 'before-quarantine-cleanup' | 'before-parent-sync';
  path: string;
  source?: string;
  destination?: string;
}

export interface BoundedFileSystemHooks {
  beforeUse?(event: BoundedFileHookEvent): Promise<void> | void;
  capabilityProbe?(): Promise<void> | void;
}

export class BoundedPathError extends Error {
  constructor(readonly path: string) {
    super(`Path ${path} resolves outside the bounded root.`);
    this.name = 'BoundedPathError';
  }
}

export class BoundedFileSystemCapabilityError extends Error {
  readonly code = 'QUBICL_FS_CAPABILITY_UNAVAILABLE';

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'BoundedFileSystemCapabilityError';
  }
}

export type BoundedMutationOutcome = 'cleanup_incomplete' | 'durability_uncertain' | 'recovery_incomplete';

export class BoundedMutationOutcomeError extends Error {
  readonly code = 'QUBICL_FS_MUTATION_OUTCOME';

  constructor(
    readonly outcome: BoundedMutationOutcome,
    readonly path: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'BoundedMutationOutcomeError';
  }
}

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  size: bigint;
}

export interface BoundedReadResult {
  data: Buffer;
  info: Stats;
  identity: FileIdentity;
  namedIdentity: FileIdentity;
  resolvedPath: string;
}

export interface BoundedArchiveEntryIdentity {
  info: Stats;
  identity: FileIdentity;
  chainDigest: string;
  chainLength: number;
}

export interface BoundedArchiveWalkEntry {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
}

export interface BoundedArchiveWalkResult {
  entries: BoundedArchiveWalkEntry[];
  metadataBytes: number;
}

export interface BoundedArchiveReadOptions {
  expected: BoundedArchiveEntryIdentity;
  maximumBytes: number;
  deadline: number;
  signal?: AbortSignal;
  onChunk(chunk: Buffer): Promise<void> | void;
}

export interface BoundedListResult {
  entries: Array<{ name: string; type: 'directory' | 'file' | 'symlink' | 'other' }>;
  truncated: boolean;
  nextCursor?: number;
}

interface DirectoryResolution {
  handle: FileHandle;
  parts: string[];
  owned: boolean;
}

interface NamedResolution {
  parent: FileHandle;
  parentParts: string[];
  name: string;
  ownedParent: boolean;
}

interface OpenedResolution {
  handle: FileHandle;
  info: Stats;
  identity: FileIdentity;
  namedIdentity: FileIdentity;
  resolvedParts: string[];
}

interface SymlinkChainMember {
  parts: string[];
  identity: FileIdentity;
}

interface SymlinkTrace {
  requestedPath: string;
  members: SymlinkChainMember[];
}

interface FinalSymlinkResolution {
  referentPaths: string[][];
  members: SymlinkChainMember[];
}

interface RenamedEntry {
  parent: FileHandle;
  originalName: string;
  quarantineName: string;
}

interface QuarantinedEntry extends RenamedEntry {
  requestedPath: string;
  info: Stats;
  identity: FileIdentity;
}

/**
 * Linux runtime filesystem access rooted in one opened directory descriptor.
 *
 * Node does not expose openat(2). Linux's /proc/self/fd descriptor paths retain
 * the same anchoring property when every intermediate component is opened with
 * O_DIRECTORY|O_NOFOLLOW and every final file is opened with O_NOFOLLOW.
 */
export class BoundedFileSystem {
  readonly root: string;
  private capabilityPromise: Promise<void> | undefined;

  constructor(root: string, private readonly hooks: BoundedFileSystemHooks = {}) {
    this.root = resolve(root);
  }

  absolutePath(value: string): string {
    const candidate = isAbsolute(value) ? resolve(value) : resolve(this.root, value);
    this.relativeParts(candidate);
    return candidate;
  }

  async canonicalPath(value: string, followFinal = true): Promise<string> {
    const path = this.absolutePath(value);
    return this.withRoot(async (root) => {
      if (path === this.root) return this.root;
      if (followFinal) {
        const opened = await this.openExisting(root, path, 'inspect', false, true);
        try { return join(this.root, ...opened.resolvedParts); }
        finally { await opened.handle.close(); }
      }
      const named = await this.resolveParent(root, path, false);
      try {
        await lstat(this.childPath(named.parent, named.name));
        return join(this.root, ...named.parentParts, named.name);
      } finally {
        await closeOwned(named.parent, named.ownedParent);
      }
    });
  }

  async assertDestination(value: string): Promise<void> {
    const path = this.absolutePath(value);
    if (path === this.root) return;
    await this.withRoot(async (root) => {
      const parentParts = this.relativeParts(path).slice(0, -1);
      const resolved = await this.resolveDirectory(root, parentParts, false, true);
      await closeOwned(resolved.handle, resolved.owned);
    });
  }

  async info(value: string): Promise<Stats> {
    const path = this.absolutePath(value);
    return this.withRoot(async (root) => {
      if (path === this.root) return root.stat();
      const named = await this.resolveParent(root, path, false);
      try {
        await this.hook({ operation: 'inspect', stage: 'parent-resolved', path });
        return await lstat(this.childPath(named.parent, named.name));
      } finally {
        await closeOwned(named.parent, named.ownedParent);
      }
    });
  }

  async stat(value: string): Promise<Stats> {
    const path = this.absolutePath(value);
    return this.withRoot(async (root) => {
      const opened = await this.openExisting(root, path, 'inspect', false, true);
      try { return opened.info; }
      finally { await opened.handle.close(); }
    });
  }

  async isWritable(value: string): Promise<boolean> {
    const path = this.absolutePath(value);
    try {
      return await this.withRoot(async (root) => {
        const opened = await this.openExisting(root, path, 'inspect', false, true);
        try {
          await access(this.descriptorPath(opened.handle), constants.W_OK);
          return true;
        } finally {
          await opened.handle.close();
        }
      });
    } catch {
      return false;
    }
  }

  async readFile(value: string, maximumBytes?: number, operation: BoundedFileOperation = 'read'): Promise<BoundedReadResult> {
    const path = this.absolutePath(value);
    return this.withRoot(async (root) => {
      const opened = await this.openExisting(root, path, operation);
      try {
        if (!opened.info.isFile()) throw fileError('EISDIR', path);
        const data = await readBounded(opened.handle, maximumBytes);
        return {
          data,
          info: opened.info,
          identity: opened.identity,
          namedIdentity: opened.namedIdentity,
          resolvedPath: join(this.root, ...opened.resolvedParts),
        };
      } finally {
        await opened.handle.close();
      }
    });
  }

  async archiveIdentity(value: string, options: { deadline?: number; signal?: AbortSignal } = {}): Promise<BoundedArchiveEntryIdentity> {
    const path = this.absolutePath(value);
    return this.withRoot(async (root) => {
      const opened = await this.openNoSymlinks(root, path, 'inspect', options.deadline, options.signal);
      try {
        return {
          info: opened.info,
          identity: opened.identity,
          chainDigest: opened.chainDigest,
          chainLength: opened.chainLength,
        };
      } finally {
        await opened.handle.close();
      }
    });
  }

  async walkArchive(
    value: string,
    options: { maximumEntries: number; maximumMetadataBytes: number; deadline: number; signal?: AbortSignal },
  ): Promise<BoundedArchiveWalkResult> {
    const path = this.absolutePath(value);
    positiveSafeInteger(options.maximumEntries, 'maximumEntries');
    positiveSafeInteger(options.maximumMetadataBytes, 'maximumMetadataBytes');
    return this.withRoot(async (root) => {
      const opened = await this.openNoSymlinks(root, path, 'list', options.deadline, options.signal);
      try {
        if (!opened.info.isDirectory()) throw fileError('ENOTDIR', path);
        const entries: BoundedArchiveWalkEntry[] = [];
        let metadataBytes = 0;
        const visit = async (directory: FileHandle, prefix: string): Promise<void> => {
          assertBeforeArchiveDeadline(options.deadline, path, options.signal);
          const stream = await opendir(this.descriptorPath(directory));
          try {
            for (;;) {
              assertBeforeArchiveDeadline(options.deadline, path, options.signal);
              const entry = await stream.read();
              assertBeforeArchiveDeadline(options.deadline, path, options.signal);
              if (!entry) break;
              const entryPath = this.childPath(directory, entry.name);
              let info: Stats;
              try { info = await lstat(entryPath); }
              catch (error) {
                if (errnoCode(error) === 'ENOENT') continue;
                throw error;
              }
              const name = prefix ? join(prefix, entry.name) : entry.name;
              const type = entryType(info);
              if (entries.length >= options.maximumEntries) throw fileError('EFBIG', path);
              const entryMetadataBytes = Buffer.byteLength(name, 'utf8') + 128;
              if (metadataBytes + entryMetadataBytes > options.maximumMetadataBytes) throw fileError('EFBIG', path);
              entries.push({ name, type });
              metadataBytes += entryMetadataBytes;
              if (!info.isDirectory()) continue;
              const expected = await identityAt(entryPath);
              const child = await open(entryPath, READ_DIRECTORY_FLAGS);
              try {
                if (!sameIdentity(expected, await handleIdentity(child))) throw changedError(path);
                await visit(child, name);
              } finally {
                await child.close();
              }
            }
          } finally {
            await stream.close().catch(() => undefined);
          }
        };
        await visit(opened.handle, '');
        entries.sort((left, right) => left.name.localeCompare(right.name));
        return { entries, metadataBytes };
      } finally {
        await opened.handle.close();
      }
    });
  }

  async readArchiveFile(value: string, options: BoundedArchiveReadOptions): Promise<number> {
    const path = this.absolutePath(value);
    if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0) throw new TypeError('maximumBytes must be a non-negative safe integer.');
    return this.withRoot(async (root) => {
      const opened = await this.openNoSymlinks(root, path, 'read', options.deadline, options.signal);
      try {
        if (!opened.info.isFile()) throw fileError('EISDIR', path);
        if (opened.chainLength !== options.expected.chainLength
          || opened.chainDigest !== options.expected.chainDigest
          || !sameIdentity(opened.identity, options.expected.identity)) {
          throw changedError(path);
        }
        if (!Number.isSafeInteger(opened.info.size) || opened.info.size < 0 || opened.info.size > options.maximumBytes) {
          throw fileError('EFBIG', path);
        }
        let position = 0;
        while (position < opened.info.size) {
          assertBeforeArchiveDeadline(options.deadline, path, options.signal);
          const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, opened.info.size - position));
          const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) throw changedError(path);
          position += bytesRead;
          await options.onChunk(buffer.subarray(0, bytesRead));
        }
        const after = await handleIdentity(opened.handle);
        if (!sameIdentity(after, options.expected.identity)) throw changedError(path);
        return position;
      } finally {
        await opened.handle.close();
      }
    });
  }

  async list(value: string, recursive: boolean, cursor: number, maxEntries: number, maximumEntryBytes = Number.POSITIVE_INFINITY): Promise<BoundedListResult> {
    const path = this.absolutePath(value);
    return this.withRoot(async (root) => {
      const opened = await this.openExisting(root, path, 'list', true);
      try {
        if (!opened.info.isDirectory()) throw fileError('ENOTDIR', path);
        const results: BoundedListResult['entries'] = [];
        let resultBytes = 0;
        let position = 0;
        let truncated = false;
        const visit = async (directory: FileHandle, prefix: string): Promise<boolean> => {
          const entries = (await readdir(this.descriptorPath(directory), { withFileTypes: true }))
            .sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            const entryPath = this.childPath(directory, entry.name);
            let info: Stats;
            try { info = await lstat(entryPath); }
            catch (error) {
              if (errnoCode(error) === 'ENOENT') continue;
              throw error;
            }
            const name = prefix ? join(prefix, entry.name) : entry.name;
            const type = entryType(info);
            if (position >= cursor) {
              if (results.length >= maxEntries) {
                truncated = true;
                return true;
              }
              const result = { name, type };
              const entryBytes = Buffer.byteLength(JSON.stringify(result)) + (results.length ? 1 : 0);
              if (results.length && resultBytes + entryBytes > maximumEntryBytes) {
                truncated = true;
                return true;
              }
              results.push(result);
              resultBytes += entryBytes;
            }
            position += 1;
            if (recursive && info.isDirectory()) {
              let child: FileHandle;
              try { child = await open(entryPath, READ_DIRECTORY_FLAGS); }
              catch (error) {
                if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(errnoCode(error) ?? '')) continue;
                throw error;
              }
              try {
                if (await visit(child, name)) return true;
              } finally {
                await child.close();
              }
            }
          }
          return false;
        };
        await visit(opened.handle, '');
        return {
          entries: results,
          truncated,
          ...(truncated ? { nextCursor: cursor + results.length } : {}),
        };
      } finally {
        await opened.handle.close();
      }
    });
  }

  async writeFile(
    value: string,
    data: Uint8Array,
    options: { createParents: boolean; operation?: 'write' | 'edit'; expectedIdentity?: FileIdentity; expectedNamedIdentity?: FileIdentity },
  ): Promise<void> {
    const path = this.absolutePath(value);
    if (path === this.root) throw fileError('EISDIR', path);
    await this.withMutation(async (root) => {
      const named = await this.resolveParent(root, path, options.createParents);
      try {
        const operation = options.operation ?? 'write';
        await this.hook({ operation, stage: 'parent-resolved', path });
        const destinationPath = this.childPath(named.parent, named.name);
        let destinationInfo: Stats | undefined;
        try { destinationInfo = await lstat(destinationPath); }
        catch (error) { if (errnoCode(error) !== 'ENOENT') throw error; }
        if (destinationInfo?.isDirectory()) throw fileError('EISDIR', path);
        if (options.expectedNamedIdentity) {
          if (!destinationInfo || !sameIdentity(await identityAt(destinationPath), options.expectedNamedIdentity)) {
            throw changedError(path);
          }
          if (options.expectedIdentity) {
            const current = await this.openExisting(root, path, operation);
            try {
              if (!sameIdentity(current.identity, options.expectedIdentity)) throw changedError(path);
            } finally {
              await current.handle.close();
            }
          }
        }
        const mode = destinationInfo?.isFile() ? destinationInfo.mode & 0o7777 : 0o644;
        const temporary = `.qubicl-write-${process.pid}-${randomBytes(12).toString('hex')}`;
        const temporaryPath = this.childPath(named.parent, temporary);
        const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
        let staged = true;
        let operationError: unknown;
        try {
          await handle.writeFile(data);
          await handle.chmod(mode);
          await handle.sync();
          await handle.close();
          await this.hook({ operation, stage: 'destination-checked', path });
          if (options.expectedNamedIdentity) {
            const currentNamedIdentity = await identityAt(destinationPath).catch(() => undefined);
            if (!currentNamedIdentity || !sameIdentity(currentNamedIdentity, options.expectedNamedIdentity)) {
              throw changedError(path);
            }
          }
          if (options.expectedIdentity) {
            await this.assertOpenedIdentity(root, path, options.expectedIdentity, operation, path);
          }
          let quarantined: QuarantinedEntry | undefined;
          try {
            quarantined = await this.quarantineNamedEntry(
              named.parent,
              named.name,
              path,
              options.expectedNamedIdentity,
              options.expectedNamedIdentity !== undefined,
            );
            if (quarantined?.info.isDirectory()) throw fileError('EISDIR', path);
            if (quarantined && options.expectedIdentity) {
              await this.assertOpenedIdentity(
                root,
                join(this.root, ...named.parentParts, quarantined.quarantineName),
                options.expectedIdentity,
                operation,
                path,
                false,
              );
            }
            await renameWithFlags(named.parent, temporary, named.parent, named.name, RENAME_NOREPLACE);
            staged = false;
          } catch (error) {
            if (quarantined) await this.recoverEntries([quarantined], path);
            throw error;
          }
          await this.finalizeCommit(operation, path, [named.parent], quarantined ? [quarantined] : []);
        } catch (error) {
          operationError = error;
        }
        await handle.close().catch(() => undefined);
        if (staged) {
          try { await removeNamedEntryIfExists(named.parent, temporary, true); }
          catch (error) {
            throw new BoundedMutationOutcomeError(
              'recovery_incomplete',
              path,
              `The write to ${path} did not commit, and its staged file could not be removed. Inspect the parent directory before retrying.`,
              { cause: error },
            );
          }
        }
        if (operationError) throw operationError;
      } finally {
        await closeOwned(named.parent, named.ownedParent);
      }
    });
  }

  async mkdir(value: string, mode = 0o755): Promise<void> {
    const path = this.absolutePath(value);
    if (path === this.root) return;
    await this.withMutation(async (root) => {
      const named = await this.resolveParent(root, path, true);
      try {
        await this.hook({ operation: 'write', stage: 'parent-resolved', path });
        const target = this.childPath(named.parent, named.name);
        try {
          const info = await lstat(target);
          if (info.isDirectory()) return;
          if (!info.isSymbolicLink()) throw fileError('EEXIST', path);
          const opened = await this.openExisting(root, path, 'write', false, true);
          try {
            if (!opened.info.isDirectory()) throw fileError('EEXIST', path);
            return;
          } finally {
            await opened.handle.close();
          }
        } catch (error) {
          if (errnoCode(error) !== 'ENOENT') throw error;
          await mkdir(target, { mode });
          const opened = await open(target, TRAVERSAL_DIRECTORY_FLAGS);
          await opened.close();
          await this.finalizeCommit('write', path, [named.parent], []);
        }
      } finally {
        await closeOwned(named.parent, named.ownedParent);
      }
    });
  }

  async copy(sourceValue: string, destinationValue: string, overwrite: boolean): Promise<void> {
    const source = this.absolutePath(sourceValue);
    const destination = this.absolutePath(destinationValue);
    if (source === this.root || destination === this.root) throw fileError('EINVAL', destination);
    await this.withMutation(async (root) => {
      const sourceNamed = await this.resolveParent(root, source, false);
      let sourceHandle: FileHandle | undefined;
      let destinationNamed: NamedResolution | undefined;
      try {
        const sourcePath = this.childPath(sourceNamed.parent, sourceNamed.name);
        sourceHandle = await atReportedPath(source, () => open(sourcePath, LINUX_O_PATH | constants.O_NOFOLLOW));
        const sourceInfo = await sourceHandle.stat();
        const sourceIdentity = await handleIdentity(sourceHandle);
        const sourceReferents = sourceInfo.isSymbolicLink()
          ? await this.assertSafeFinalSymlink(root, source, sourceNamed)
          : undefined;
        destinationNamed = await atReportedPath(destination, () => this.resolveParent(root, destination, true));
        this.requireNonOverlapping(sourceNamed, destinationNamed, sourceInfo, source, destination);
        const destinationParts = [...destinationNamed.parentParts, destinationNamed.name];
        if (sourceReferents?.referentPaths.some((parts) => sameParts(parts, destinationParts))) {
          throw fileError('ERR_FS_CP_EINVAL', destination, `Destination ${destination} is the referent of ${source}.`);
        }
        await this.hook({ operation: 'copy', stage: 'parent-resolved', path: destination, source, destination });
        const staging = `.qubicl-copy-${process.pid}-${randomBytes(12).toString('hex')}`;
        let quarantined: QuarantinedEntry | undefined;
        let committed = false;
        let composite: string | undefined;
        let operationError: unknown;
        try {
          await this.copyEntry(
            sourceNamed.parent,
            sourceNamed.name,
            destinationNamed.parent,
            staging,
            source,
            destination,
            sourceIdentity,
            false,
          );
          const stagedInfo = await lstat(this.childPath(destinationNamed.parent, staging));
          await this.hook({ operation: 'copy', stage: 'destination-checked', path: destination, source, destination });
          if (sourceReferents) {
            await this.assertFinalSymlinkResolutionUnchanged(root, source, sourceNamed, sourceReferents);
          }
          if (!overwrite) {
            await renameWithFlags(destinationNamed.parent, staging, destinationNamed.parent, destinationNamed.name, RENAME_NOREPLACE);
            committed = true;
          } else {
            quarantined = await this.quarantineNamedEntry(destinationNamed.parent, destinationNamed.name, destination);
            if (quarantined && stagedInfo.isDirectory() !== quarantined.info.isDirectory()) {
              throw fileError(stagedInfo.isDirectory() ? 'ERR_FS_CP_DIR_TO_NON_DIR' : 'ERR_FS_CP_NON_DIR_TO_DIR', destination);
            }
            if (quarantined?.info.isDirectory() && stagedInfo.isDirectory()) {
              composite = `.qubicl-copy-merged-${process.pid}-${randomBytes(12).toString('hex')}`;
              await this.copyEntry(
                destinationNamed.parent,
                quarantined.quarantineName,
                destinationNamed.parent,
                composite,
                destination,
                destination,
                quarantined.identity,
                true,
              );
              const stagedDirectory = await open(this.childPath(destinationNamed.parent, staging), READ_DIRECTORY_FLAGS);
              try {
                const compositeDirectory = await open(this.childPath(destinationNamed.parent, composite), READ_DIRECTORY_FLAGS);
                try { await this.mergeDirectories(stagedDirectory, compositeDirectory); }
                finally { await compositeDirectory.close(); }
              } finally {
                await stagedDirectory.close();
              }
              await renameWithFlags(destinationNamed.parent, composite, destinationNamed.parent, destinationNamed.name, RENAME_NOREPLACE);
              composite = undefined;
            } else {
              await renameWithFlags(destinationNamed.parent, staging, destinationNamed.parent, destinationNamed.name, RENAME_NOREPLACE);
            }
            committed = true;
          }
        } catch (error) {
          try {
            if (!committed && quarantined) await this.recoverEntries([quarantined], destination);
            operationError = withReportedPath(error, destination);
          } catch (recoveryError) {
            operationError = recoveryError;
          }
        }
        const cleanupFailures: unknown[] = [];
        try { await removeNamedEntryIfExists(destinationNamed.parent, staging, true); }
        catch (error) { cleanupFailures.push(error); }
        if (composite) {
          try { await removeNamedEntryIfExists(destinationNamed.parent, composite, true); }
          catch (error) { cleanupFailures.push(error); }
        }
        if (cleanupFailures.length) {
          throw new BoundedMutationOutcomeError(
            'recovery_incomplete',
            destination,
            `The copy to ${destination} did not fully clean its staged entries. Inspect the destination parent before retrying.`,
            { cause: cleanupFailures[0] },
          );
        }
        if (operationError) throw operationError;
        await this.finalizeCommit('copy', destination, [destinationNamed.parent], quarantined ? [quarantined] : []);
      } finally {
        await sourceHandle?.close().catch(() => undefined);
        await closeOwned(sourceNamed.parent, sourceNamed.ownedParent);
        if (destinationNamed) await closeOwned(destinationNamed.parent, destinationNamed.ownedParent);
      }
    });
  }

  async move(sourceValue: string, destinationValue: string, overwrite: boolean): Promise<void> {
    const source = this.absolutePath(sourceValue);
    const destination = this.absolutePath(destinationValue);
    if (source === this.root || destination === this.root) throw fileError('EINVAL', destination);
    await this.withMutation(async (root) => {
      const sourceNamed = await this.resolveParent(root, source, false);
      let sourceHandle: FileHandle | undefined;
      let destinationNamed: NamedResolution | undefined;
      try {
        const sourcePath = this.childPath(sourceNamed.parent, sourceNamed.name);
        sourceHandle = await atReportedPath(source, () => open(sourcePath, LINUX_O_PATH | constants.O_NOFOLLOW));
        const sourceInfo = await sourceHandle.stat();
        const sourceIdentity = await handleIdentity(sourceHandle);
        destinationNamed = await atReportedPath(destination, () => this.resolveParent(root, destination, true));
        this.requireNonOverlapping(sourceNamed, destinationNamed, sourceInfo, source, destination);
        const sourceReferents = sourceInfo.isSymbolicLink()
          ? await this.tryFinalSymlinkReferent(root, source, sourceNamed)
          : undefined;
        if (sourceReferents) {
          const destinationParts = [...destinationNamed.parentParts, destinationNamed.name];
          if (sourceReferents.referentPaths.some((parts) => sameParts(parts, destinationParts))) {
            throw fileError('ERR_FS_CP_EINVAL', destination, `Destination ${destination} is the referent of ${source}.`);
          }
        }
        await this.hook({ operation: 'move', stage: 'parent-resolved', path: destination, source, destination });
        await this.hook({ operation: 'move', stage: 'destination-checked', path: destination, source, destination });
        if (sourceInfo.isSymbolicLink()) {
          await this.assertFinalSymlinkResolutionUnchanged(root, source, sourceNamed, sourceReferents);
        }
        const quarantinedSource = await atReportedPath(source, () => this.quarantineNamedEntry(
          sourceNamed.parent,
          sourceNamed.name,
          source,
          sourceIdentity,
          true,
        ));
        if (!quarantinedSource) throw changedError(source);
        let quarantinedDestination: QuarantinedEntry | undefined;
        let committed = false;
        try {
          if (overwrite) {
            quarantinedDestination = await atReportedPath(destination, () => this.quarantineNamedEntry(
              destinationNamed!.parent,
              destinationNamed!.name,
              destination,
            ));
          }
          if (!sameIdentity(
            await identityAt(this.childPath(sourceNamed.parent, quarantinedSource.quarantineName)),
            quarantinedSource.identity,
          )) {
            throw new BoundedMutationOutcomeError(
              'recovery_incomplete',
              source,
              `The quarantined source for ${source} changed before the move committed. Inspect the source and destination before retrying.`,
            );
          }
          await atReportedPath(destination, () => renameWithFlags(
            sourceNamed.parent,
            quarantinedSource.quarantineName,
            destinationNamed!.parent,
            destinationNamed!.name,
            RENAME_NOREPLACE,
          ));
          committed = true;
        } catch (error) {
          const recover = [quarantinedDestination, quarantinedSource].filter((entry): entry is QuarantinedEntry => entry !== undefined);
          if (!committed) await this.recoverEntries(recover, source);
          throw error;
        }
        await this.finalizeCommit(
          'move',
          destination,
          [sourceNamed.parent, destinationNamed.parent],
          quarantinedDestination ? [quarantinedDestination] : [],
        );
      } finally {
        await sourceHandle?.close().catch(() => undefined);
        await closeOwned(sourceNamed.parent, sourceNamed.ownedParent);
        if (destinationNamed) await closeOwned(destinationNamed.parent, destinationNamed.ownedParent);
      }
    });
  }

  async remove(value: string, recursive: boolean): Promise<void> {
    const path = this.absolutePath(value);
    if (path === this.root) throw fileError('EPERM', path);
    await this.withMutation(async (root) => {
      const named = await this.resolveParent(root, path, false);
      try {
        const target = this.childPath(named.parent, named.name);
        const sourceHandle = await atReportedPath(path, () => open(target, LINUX_O_PATH | constants.O_NOFOLLOW));
        try {
          const info = await sourceHandle.stat();
          const identity = await handleIdentity(sourceHandle);
          if (info.isDirectory() && !recursive) throw fileError('ERR_FS_EISDIR', path);
          await this.hook({ operation: 'delete', stage: 'parent-resolved', path });
          const quarantined = await this.quarantineNamedEntry(named.parent, named.name, path, identity, true);
          if (!quarantined) throw changedError(path);
          let cleanupStarted = false;
          try {
            await this.hook({ operation: 'delete', stage: 'before-quarantine-cleanup', path });
            cleanupStarted = true;
            if (!sameIdentity(await identityAt(this.childPath(named.parent, quarantined.quarantineName)), quarantined.identity)) {
              throw changedError(path);
            }
            await removeNamedEntry(named.parent, quarantined.quarantineName, recursive);
          } catch (error) {
            await this.recoverEntries([quarantined], path);
            if (cleanupStarted && recursive && quarantined.info.isDirectory()) {
              throw new BoundedMutationOutcomeError(
                'recovery_incomplete',
                path,
                `Deletion of ${path} failed after recursive cleanup began; the remaining entry was restored, but some contents may already be removed.`,
                { cause: error },
              );
            }
            throw error;
          }
          await this.syncCommittedParents('delete', path, [named.parent]);
        } finally {
          await sourceHandle.close();
        }
      } finally {
        await closeOwned(named.parent, named.ownedParent);
      }
    });
  }

  private async withRoot<T>(action: (root: FileHandle) => Promise<T>): Promise<T> {
    await this.ensureCapabilities();
    const root = await open(this.root, TRAVERSAL_DIRECTORY_FLAGS);
    try { return await action(root); }
    finally { await root.close(); }
  }

  private async withMutation<T>(action: (root: FileHandle) => Promise<T>): Promise<T> {
    return serializeMutation(this.root, () => this.withRoot(action));
  }

  private async ensureCapabilities(): Promise<void> {
    this.capabilityPromise ??= Promise.resolve().then(async () => {
      if (this.hooks.capabilityProbe) {
        try { await this.hooks.capabilityProbe(); }
        catch (error) {
          if (error instanceof BoundedFileSystemCapabilityError) throw error;
          throw new BoundedFileSystemCapabilityError(`The bounded filesystem runtime probe failed: ${errorMessage(error)}`, { cause: error });
        }
      }
      defaultCapabilityProbe ??= probeLinuxCapabilities().catch((error: unknown) => {
        if (error instanceof BoundedFileSystemCapabilityError) throw error;
        throw new BoundedFileSystemCapabilityError(`The bounded filesystem runtime probe failed: ${errorMessage(error)}`, { cause: error });
      });
      await defaultCapabilityProbe;
    });
    await this.capabilityPromise;
  }

  private async openExisting(
    root: FileHandle,
    path: string,
    operation: BoundedFileOperation,
    directory = false,
    pathOnly = false,
    trace?: SymlinkTrace,
  ): Promise<OpenedResolution> {
    if (path === this.root) {
      // This path intentionally follows the procfs magic link for the already
      // opened root descriptor. O_NOFOLLOW is applied to all user-controlled
      // child names, never to this trusted descriptor duplication.
      const handle = await open(
        this.descriptorPath(root),
        pathOnly || !directory ? LINUX_O_PATH | constants.O_DIRECTORY : constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        const [info, identity] = await Promise.all([handle.stat(), handleIdentity(handle)]);
        return { handle, info, identity, namedIdentity: identity, resolvedParts: [] };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
    let queue = this.relativeParts(path);
    let symlinks = 0;
    let requestedNamedIdentity: FileIdentity | undefined;
    for (;;) {
      if (!queue.length) {
        await this.hook({ operation, stage: 'parent-resolved', path });
        const flags = pathOnly || !directory
          ? LINUX_O_PATH | constants.O_DIRECTORY
          : constants.O_RDONLY | constants.O_DIRECTORY;
        const handle = await open(this.descriptorPath(root), flags);
        try {
          const [info, identity] = await Promise.all([handle.stat(), handleIdentity(handle)]);
          return {
            handle,
            info,
            identity,
            namedIdentity: requestedNamedIdentity ?? identity,
            resolvedParts: [],
          };
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
      }
      const finalName = queue.at(-1)!;
      const parentParts = queue.slice(0, -1);
      const parent = await this.resolveDirectory(root, parentParts, false, false, 0o755, trace);
      try {
        const entryPath = this.childPath(parent.handle, finalName);
        const namedIdentity = await identityAt(entryPath);
        requestedNamedIdentity ??= namedIdentity;
        const info = await lstat(entryPath);
        if (info.isSymbolicLink()) {
          if (++symlinks > MAX_SYMLINKS) throw fileError('ELOOP', path);
          const target = await readlink(entryPath);
          if (trace) {
            const after = await identityAt(entryPath);
            if (!sameIdentity(namedIdentity, after)) throw changedError(trace.requestedPath);
            trace.members.push({ parts: [...parent.parts, finalName], identity: namedIdentity });
          }
          queue = this.linkTargetParts(parent.parts, target, path);
          continue;
        }
        await this.hook({ operation, stage: 'parent-resolved', path });
        const handle = await open(entryPath, pathOnly ? LINUX_O_PATH | constants.O_NOFOLLOW : directory ? READ_DIRECTORY_FLAGS : READ_FLAGS);
        try {
          const [openedInfo, identity] = await Promise.all([handle.stat(), handleIdentity(handle)]);
          if (trace && !sameIdentity(namedIdentity, identity)) throw changedError(trace.requestedPath);
          return {
            handle,
            info: openedInfo,
            identity,
            namedIdentity: requestedNamedIdentity,
            resolvedParts: [...parent.parts, finalName],
          };
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
      } finally {
        await closeOwned(parent.handle, parent.owned);
      }
    }
  }

  private async openNoSymlinks(
    root: FileHandle,
    path: string,
    operation: BoundedFileOperation,
    deadline?: number,
    signal?: AbortSignal,
  ): Promise<OpenedResolution & { chainDigest: string; chainLength: number }> {
    const parts = this.relativeParts(path);
    let current = root;
    let owned = false;
    assertBeforeArchiveDeadline(deadline, path, signal);
    const chain = createHash('sha256');
    let chainLength = 0;
    updateIdentityDigest(chain, await handleIdentity(root));
    chainLength += 1;
    if (!parts.length) {
      assertBeforeArchiveDeadline(deadline, path, signal);
      const handle = await open(this.descriptorPath(root), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        const [info, identity] = await Promise.all([handle.stat(), handleIdentity(handle)]);
        assertBeforeArchiveDeadline(deadline, path, signal);
        return {
          handle,
          info,
          identity,
          namedIdentity: identity,
          resolvedParts: [],
          chainDigest: chain.digest('hex'),
          chainLength,
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
    try {
      for (const [index, name] of parts.entries()) {
        assertBeforeArchiveDeadline(deadline, path, signal);
        const entryPath = this.childPath(current, name);
        const info = await lstat(entryPath);
        if (info.isSymbolicLink()) throw fileError('ELOOP', path);
        const namedIdentity = await identityAt(entryPath);
        const final = index === parts.length - 1;
        if (!final && !info.isDirectory()) throw fileError('ENOTDIR', path);
        if (final) await this.hook({ operation, stage: 'parent-resolved', path });
        assertBeforeArchiveDeadline(deadline, path, signal);
        const flags = final && operation === 'inspect'
          ? LINUX_O_PATH | constants.O_NOFOLLOW
          : info.isDirectory() ? READ_DIRECTORY_FLAGS : READ_FLAGS;
        const next = await open(entryPath, flags);
        try {
          const [openedInfo, identity] = await Promise.all([next.stat(), handleIdentity(next)]);
          assertBeforeArchiveDeadline(deadline, path, signal);
          if (!sameIdentity(namedIdentity, identity)) throw changedError(path);
          updateIdentityDigest(chain, identity);
          chainLength += 1;
          if (final) {
            await closeOwned(current, owned);
            owned = false;
            return {
              handle: next,
              info: openedInfo,
              identity,
              namedIdentity,
              resolvedParts: parts,
              chainDigest: chain.digest('hex'),
              chainLength,
            };
          }
          await closeOwned(current, owned);
          current = next;
          owned = true;
        } catch (error) {
          await next.close().catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      await closeOwned(current, owned).catch(() => undefined);
      throw error;
    }
    throw fileError('ENOENT', path);
  }

  private async resolveParent(root: FileHandle, path: string, createParents: boolean): Promise<NamedResolution> {
    const parts = this.relativeParts(path);
    const name = parts.pop();
    if (!name) throw fileError('EISDIR', path);
    const parent = await this.resolveDirectory(root, parts, createParents, false);
    return { parent: parent.handle, parentParts: parent.parts, name, ownedParent: parent.owned };
  }

  private async resolveDirectory(
    root: FileHandle,
    initialParts: string[],
    createMissing: boolean,
    allowMissingTail: boolean,
    mode = 0o755,
    trace?: SymlinkTrace,
  ): Promise<DirectoryResolution> {
    let parts = [...initialParts];
    let resolvedParts: string[] = [];
    let current = root;
    let owned = false;
    let symlinks = 0;
    try {
      while (parts.length) {
        const name = parts.shift()!;
        const entryPath = this.childPath(current, name);
        let info: Stats;
        try { info = await lstat(entryPath); }
        catch (error) {
          if (errnoCode(error) !== 'ENOENT') throw error;
          if (allowMissingTail) {
            await closeOwned(current, owned);
            owned = false;
            return { handle: root, parts: [...resolvedParts, name, ...parts], owned: false };
          }
          if (!createMissing) throw error;
          await mkdir(entryPath, { mode });
          info = await lstat(entryPath);
        }
        if (info.isSymbolicLink()) {
          if (++symlinks > MAX_SYMLINKS) throw fileError('ELOOP', join(this.root, ...initialParts));
          const before = trace ? await identityAt(entryPath) : undefined;
          const target = await readlink(entryPath);
          if (trace && before) {
            const after = await identityAt(entryPath);
            if (!sameIdentity(before, after)) throw changedError(trace.requestedPath);
            trace.members.push({ parts: [...resolvedParts, name], identity: before });
          }
          const remaining = parts;
          parts = [...this.linkTargetParts(resolvedParts, target, join(this.root, ...initialParts)), ...remaining];
          resolvedParts = [];
          await closeOwned(current, owned);
          current = root;
          owned = false;
          continue;
        }
        if (!info.isDirectory()) throw fileError('ENOTDIR', join(this.root, ...resolvedParts, name));
        const next = await open(entryPath, TRAVERSAL_DIRECTORY_FLAGS);
        await closeOwned(current, owned);
        current = next;
        owned = true;
        resolvedParts.push(name);
      }
      return { handle: current, parts: resolvedParts, owned };
    } catch (error) {
      await closeOwned(current, owned).catch(() => undefined);
      throw error;
    }
  }

  private linkTargetParts(parentParts: string[], target: string, requestedPath: string): string[] {
    const candidate = isAbsolute(target)
      ? resolve(target)
      : resolve(this.root, ...parentParts, target);
    try { return this.relativeParts(candidate); }
    catch (error) {
      if (error instanceof BoundedPathError) throw new BoundedPathError(requestedPath);
      throw error;
    }
  }

  private relativeParts(path: string): string[] {
    const nested = relative(this.root, path);
    if (nested === '') return [];
    if (nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested)) throw new BoundedPathError(path);
    return nested.split(sep).filter((part) => part !== '');
  }

  private descriptorPath(handle: FileHandle): string {
    return process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : `/dev/fd/${handle.fd}`;
  }

  private childPath(parent: FileHandle, name: string): string {
    return `${this.descriptorPath(parent)}/${name}`;
  }

  private async assertSafeFinalSymlink(root: FileHandle, path: string, named: NamedResolution): Promise<FinalSymlinkResolution> {
    const linkPath = this.childPath(named.parent, named.name);
    const before = await identityAt(linkPath);
    const target = await readlink(linkPath);
    const targetPath = join(this.root, ...this.linkTargetParts(named.parentParts, target, path));
    const trace: SymlinkTrace = {
      requestedPath: path,
      members: [{ parts: [...named.parentParts, named.name], identity: before }],
    };
    const opened = await this.openExisting(root, targetPath, 'copy', false, true, trace);
    try {
      const after = await identityAt(linkPath);
      if (!sameIdentity(before, after)) throw changedError(path);
      return {
        referentPaths: [...trace.members.slice(1).map(({ parts }) => parts), opened.resolvedParts],
        members: trace.members,
      };
    } finally {
      await opened.handle.close();
    }
  }

  private async tryFinalSymlinkReferent(root: FileHandle, path: string, named: NamedResolution): Promise<FinalSymlinkResolution | undefined> {
    try { return await this.assertSafeFinalSymlink(root, path, named); }
    catch { return undefined; }
  }

  private async assertFinalSymlinkResolutionUnchanged(
    root: FileHandle,
    path: string,
    named: NamedResolution,
    expected: FinalSymlinkResolution | undefined,
  ): Promise<void> {
    const current = await this.tryFinalSymlinkReferent(root, path, named);
    if (!sameFinalSymlinkResolution(current, expected)) throw changedError(path);
  }

  private async assertOpenedIdentity(
    root: FileHandle,
    path: string,
    expected: FileIdentity,
    operation: BoundedFileOperation,
    reportedPath: string,
    exact = true,
  ): Promise<void> {
    const opened = await this.openExisting(root, path, operation, false, true);
    try {
      if (!(exact ? sameIdentity(opened.identity, expected) : sameRenamedIdentity(opened.identity, expected))) {
        throw changedError(reportedPath);
      }
    } finally {
      await opened.handle.close();
    }
  }

  private requireNonOverlapping(
    source: NamedResolution,
    destination: NamedResolution,
    sourceInfo: Stats,
    sourcePath: string,
    destinationPath: string,
  ): void {
    const sourceParts = [...source.parentParts, source.name];
    const destinationParts = [...destination.parentParts, destination.name];
    if (sameParts(sourceParts, destinationParts)) {
      throw fileError('ERR_FS_CP_EINVAL', destinationPath, `Destination ${destinationPath} overlaps ${sourcePath}.`);
    }
    if (!sourceInfo.isDirectory()) return;
    if (startsWithParts(destinationParts, sourceParts) || startsWithParts(sourceParts, destinationParts)) {
      throw fileError('ERR_FS_CP_EINVAL', destinationPath, `Destination ${destinationPath} overlaps ${sourcePath}.`);
    }
  }

  private async copyEntry(
    sourceParent: FileHandle,
    sourceName: string,
    destinationParent: FileHandle,
    destinationName: string,
    logicalSourcePath: string,
    logicalDestinationPath: string,
    expectedIdentity: FileIdentity | undefined,
    verbatimSymlinks: boolean,
  ): Promise<void> {
    const sourcePath = this.childPath(sourceParent, sourceName);
    const destinationPath = this.childPath(destinationParent, destinationName);
    const info = await atReportedPath(logicalSourcePath, () => lstat(sourcePath));
    if (info.isSymbolicLink()) {
      const before = await identityAt(sourcePath);
      if (expectedIdentity && !sameIdentity(before, expectedIdentity)) throw changedError(logicalSourcePath);
      const target = await readlink(sourcePath);
      const after = await identityAt(sourcePath);
      if (!sameIdentity(before, after)) throw changedError(logicalSourcePath);
      await atReportedPath(logicalDestinationPath, () => symlink(
        verbatimSymlinks || isAbsolute(target) ? target : resolve(dirname(logicalSourcePath), target),
        destinationPath,
      ));
      return;
    }
    if (info.isDirectory()) {
      const source = await atReportedPath(logicalSourcePath, () => open(sourcePath, READ_DIRECTORY_FLAGS));
      try {
        const openedIdentity = await handleIdentity(source);
        if (expectedIdentity && !sameIdentity(openedIdentity, expectedIdentity)) throw changedError(logicalSourcePath);
        const openedInfo = await source.stat();
        await atReportedPath(logicalDestinationPath, () => mkdir(destinationPath, { mode: openedInfo.mode & 0o7777 }));
        const destination = await atReportedPath(logicalDestinationPath, () => open(destinationPath, READ_DIRECTORY_FLAGS));
        try {
          const entries = (await readdir(this.descriptorPath(source), { withFileTypes: true }))
            .sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            await this.copyEntry(
              source,
              entry.name,
              destination,
              entry.name,
              join(logicalSourcePath, entry.name),
              join(logicalDestinationPath, entry.name),
              undefined,
              verbatimSymlinks,
            );
          }
          await atReportedPath(logicalDestinationPath, () => chmod(this.descriptorPath(destination), openedInfo.mode & 0o7777));
          await atReportedPath(logicalDestinationPath, () => destination.sync());
        } finally {
          await destination.close();
        }
      } finally {
        await source.close();
      }
      return;
    }
    if (!info.isFile()) throw fileError('EINVAL', logicalSourcePath);
    const source = await atReportedPath(logicalSourcePath, () => open(sourcePath, READ_FLAGS));
    try {
      const openedInfo = await source.stat();
      if (!openedInfo.isFile()) throw changedError(logicalSourcePath);
      const openedIdentity = await handleIdentity(source);
      if (expectedIdentity && !sameIdentity(openedIdentity, expectedIdentity)) throw changedError(logicalSourcePath);
      const destination = await atReportedPath(logicalDestinationPath, () => open(
        destinationPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        openedInfo.mode & 0o7777,
      ));
      try {
        const cloned = openedInfo.size >= MIN_CLONE_BYTES
          && await atReportedPath(logicalDestinationPath, () => tryCloneFile(source, destination));
        if (!cloned) {
          try {
            if (openedInfo.blocks * 512 < openedInfo.size) {
              await copySparseFile(source, destination, openedInfo.size);
            } else {
              await copyFile(this.descriptorPath(source), this.descriptorPath(destination), constants.COPYFILE_FICLONE);
            }
          } catch (error) {
            const destinationCodes = ['EDQUOT', 'ENOSPC', 'EROFS'];
            throw withReportedPath(error, destinationCodes.includes(errnoCode(error) ?? '') ? logicalDestinationPath : logicalSourcePath);
          }
        }
        await atReportedPath(logicalDestinationPath, () => destination.chmod(openedInfo.mode & 0o7777));
        await atReportedPath(logicalDestinationPath, () => destination.sync());
      } finally {
        await destination.close();
      }
    } finally {
      await source.close();
    }
  }

  private async mergeDirectories(source: FileHandle, destination: FileHandle): Promise<void> {
    const entries = (await readdir(this.descriptorPath(source), { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = this.childPath(source, entry.name);
      const sourceInfo = await lstat(sourcePath);
      let destinationInfo: Stats | undefined;
      try { destinationInfo = await lstat(this.childPath(destination, entry.name)); }
      catch (error) { if (errnoCode(error) !== 'ENOENT') throw error; }
      if (sourceInfo.isDirectory() && destinationInfo?.isDirectory()) {
        const sourceChild = await open(sourcePath, READ_DIRECTORY_FLAGS);
        try {
          const destinationChild = await open(this.childPath(destination, entry.name), READ_DIRECTORY_FLAGS);
          try { await this.mergeDirectories(sourceChild, destinationChild); }
          finally { await destinationChild.close(); }
        } finally {
          await sourceChild.close();
        }
        await removeNamedEntry(source, entry.name, true);
        continue;
      }
      if (destinationInfo && sourceInfo.isDirectory() !== destinationInfo.isDirectory()) {
        throw fileError(sourceInfo.isDirectory() ? 'ERR_FS_CP_DIR_TO_NON_DIR' : 'ERR_FS_CP_NON_DIR_TO_DIR', this.childPath(destination, entry.name));
      }
      const quarantined = destinationInfo
        ? await this.quarantineNamedEntry(destination, entry.name, this.childPath(destination, entry.name))
        : undefined;
      try {
        await renameWithFlags(source, entry.name, destination, entry.name, RENAME_NOREPLACE);
      } catch (error) {
        if (quarantined) await this.recoverEntries([quarantined], quarantined.requestedPath);
        throw error;
      }
      if (quarantined) await removeNamedEntry(destination, quarantined.quarantineName, true);
    }
    await destination.sync();
  }

  private async quarantineNamedEntry(
    parent: FileHandle,
    name: string,
    requestedPath: string,
    expectedIdentity?: FileIdentity,
    required = false,
  ): Promise<QuarantinedEntry | undefined> {
    const quarantineName = `.qubicl-quarantine-${process.pid}-${randomBytes(12).toString('hex')}`;
    try {
      await renameWithFlags(parent, name, parent, quarantineName, RENAME_NOREPLACE);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        if (required) throw expectedIdentity ? changedError(requestedPath) : fileError('ENOENT', requestedPath);
        return undefined;
      }
      throw error;
    }
    try {
      const quarantinePath = this.childPath(parent, quarantineName);
      const entry: QuarantinedEntry = {
        parent,
        originalName: name,
        quarantineName,
        requestedPath,
        info: await lstat(quarantinePath),
        identity: await identityAt(quarantinePath),
      };
      if (expectedIdentity && !sameRenamedIdentity(entry.identity, expectedIdentity)) {
        await this.recoverEntries([entry], requestedPath);
        throw changedError(requestedPath);
      }
      return entry;
    } catch (error) {
      if (error instanceof BoundedMutationOutcomeError || errnoCode(error) === 'ESTALE') throw error;
      const raw = {
        parent,
        originalName: name,
        quarantineName,
      };
      await this.recoverEntries([raw], requestedPath);
      throw error;
    }
  }

  private async recoverEntries(entries: RenamedEntry[], path: string): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of entries) {
      try {
        await renameWithFlags(entry.parent, entry.quarantineName, entry.parent, entry.originalName, RENAME_NOREPLACE);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new BoundedMutationOutcomeError(
        'recovery_incomplete',
        path,
        `Filesystem state changed while operating on ${path}, and the original named entries could not all be restored. Inspect the path before retrying.`,
        { cause: failures[0] },
      );
    }
    try {
      const synced = new Set<number>();
      for (const entry of entries) {
        if (synced.has(entry.parent.fd)) continue;
        synced.add(entry.parent.fd);
        await syncDirectory(entry.parent);
      }
    } catch (error) {
      throw new BoundedMutationOutcomeError(
        'recovery_incomplete',
        path,
        `Filesystem state was restored after the failed operation on ${path}, but recovery durability could not be confirmed. Inspect the path before retrying.`,
        { cause: error },
      );
    }
  }

  private async finalizeCommit(
    operation: BoundedFileOperation,
    path: string,
    parents: FileHandle[],
    quarantines: QuarantinedEntry[],
  ): Promise<void> {
    let cleanupError: unknown;
    for (const entry of quarantines) {
      try {
        await this.hook({ operation, stage: 'before-quarantine-cleanup', path });
        if (!sameIdentity(await identityAt(this.childPath(entry.parent, entry.quarantineName)), entry.identity)) {
          throw changedError(entry.requestedPath);
        }
        await removeNamedEntry(entry.parent, entry.quarantineName, true);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    await this.syncCommittedParents(operation, path, parents);
    if (cleanupError) {
      throw new BoundedMutationOutcomeError(
        'cleanup_incomplete',
        path,
        `The operation committed at ${path}, but cleanup of a quarantined prior entry was incomplete. Inspect the path before retrying.`,
        { cause: cleanupError },
      );
    }
  }

  private async syncCommittedParents(operation: BoundedFileOperation, path: string, parents: FileHandle[]): Promise<void> {
    try {
      await this.hook({ operation, stage: 'before-parent-sync', path });
      const synced = new Set<number>();
      for (const parent of parents) {
        if (synced.has(parent.fd)) continue;
        synced.add(parent.fd);
        await syncDirectory(parent);
      }
    } catch (error) {
      throw new BoundedMutationOutcomeError(
        'durability_uncertain',
        path,
        `The operation committed at ${path}, but filesystem durability could not be confirmed. Inspect the path before retrying.`,
        { cause: error },
      );
    }
  }

  private async hook(event: BoundedFileHookEvent): Promise<void> {
    await this.hooks.beforeUse?.(event);
  }
}

async function serializeMutation<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(root) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  const queued = current.then(() => undefined, () => undefined);
  mutationQueues.set(root, queued);
  try {
    return await current;
  } finally {
    if (mutationQueues.get(root) === queued) mutationQueues.delete(root);
  }
}

async function probeLinuxCapabilities(): Promise<void> {
  if (process.platform !== 'linux') {
    throw new BoundedFileSystemCapabilityError('Secure bounded filesystem operations require the Linux computer runtime.');
  }
  try { await access('/proc/self/fd', constants.X_OK); }
  catch (error) {
    throw new BoundedFileSystemCapabilityError('Secure bounded filesystem operations require an accessible /proc/self/fd.', { cause: error });
  }
  try { await access('/usr/bin/python3', constants.X_OK); }
  catch (error) {
    throw new BoundedFileSystemCapabilityError('Secure bounded filesystem operations require the computer image Python helper at /usr/bin/python3.', { cause: error });
  }

  const directory = await mkdtemp(join(tmpdir(), 'qubicl-bounded-probe-'));
  let parent: FileHandle | undefined;
  try {
    for (const name of ['source', 'destination']) {
      const handle = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.close();
    }
    parent = await open(directory, TRAVERSAL_DIRECTORY_FLAGS);
    await lstat(descriptorChildPath(parent, 'source'));
    let refusedReplacement = false;
    try {
      await renameWithFlags(parent, 'source', parent, 'destination', RENAME_NOREPLACE);
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') refusedReplacement = true;
      else throw error;
    }
    if (!refusedReplacement) {
      throw new Error('renameat2 RENAME_NOREPLACE replaced an existing entry during the capability probe.');
    }
    await unlink(descriptorChildPath(parent, 'destination'));
    await renameWithFlags(parent, 'source', parent, 'destination', RENAME_NOREPLACE);
    await lstat(descriptorChildPath(parent, 'destination'));
  } catch (error) {
    if (error instanceof BoundedFileSystemCapabilityError) throw error;
    throw new BoundedFileSystemCapabilityError(
      `Secure bounded filesystem operations require descriptor-relative renameat2 RENAME_NOREPLACE support: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    await parent?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

async function syncDirectory(parent: FileHandle): Promise<void> {
  const handle = await open(descriptorPath(parent), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function readBounded(handle: FileHandle, maximumBytes?: number): Promise<Buffer> {
  if (maximumBytes === undefined) return handle.readFile();
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  while (total <= maximumBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    position += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

async function tryCloneFile(source: FileHandle, destination: FileHandle): Promise<boolean> {
  const [sourceInfo, destinationInfo] = await Promise.all([source.stat(), destination.stat()]);
  const capabilityKey = `${sourceInfo.dev}:${destinationInfo.dev}`;
  if (cloneCapabilities.get(capabilityKey) === false) return false;
  const script = [
    'import fcntl, sys',
    'try:',
    '    fcntl.ioctl(4, 0x40049409, 3)',
    'except OSError as error:',
    '    print(error.errno, file=sys.stderr)',
    '    raise SystemExit(1)',
  ].join('\n');
  let result: Awaited<ReturnType<typeof runHelper>>;
  try {
    result = await runHelper('/usr/bin/python3', ['-c', script], source.fd, destination.fd);
  } catch (error) {
    throw new BoundedFileSystemCapabilityError(
      `The descriptor-relative file clone helper could not start: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (result.code === 0) {
    cloneCapabilities.set(capabilityKey, true);
    return true;
  }
  const errno = Number.parseInt(result.stderr.trim(), 10);
  if ([18, 22, 25, 38, 95].includes(errno)) {
    cloneCapabilities.set(capabilityKey, false);
    return false;
  }
  if (!Number.isFinite(errno)) {
    throw new BoundedFileSystemCapabilityError('The descriptor-relative file clone helper returned an invalid result.');
  }
  throw fileError(errnoName(errno), descriptorPath(destination));
}

async function copySparseFile(source: FileHandle, destination: FileHandle, size: number): Promise<void> {
  let position = 0;
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, size - position));
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    for (let offset = 0; offset < bytesRead; offset += SPARSE_BLOCK_BYTES) {
      const block = buffer.subarray(offset, Math.min(bytesRead, offset + SPARSE_BLOCK_BYTES));
      if (block.every((byte) => byte === 0)) continue;
      let written = 0;
      while (written < block.length) {
        const result = await destination.write(block, written, block.length - written, position + offset + written);
        if (!result.bytesWritten) throw fileError('EIO', descriptorPath(destination));
        written += result.bytesWritten;
      }
    }
    position += bytesRead;
  }
  await destination.truncate(size);
}

async function removeNamedEntry(parent: FileHandle, name: string, recursive: boolean): Promise<void> {
  const path = descriptorChildPath(parent, name);
  const info = await lstat(path);
  if (!info.isDirectory()) {
    await unlink(path);
    return;
  }
  if (!recursive) throw fileError('ERR_FS_EISDIR', path);
  const directory = await open(path, READ_DIRECTORY_FLAGS);
  try {
    const entries = await readdir(descriptorPath(directory), { withFileTypes: true });
    for (const entry of entries) await removeNamedEntry(directory, entry.name, true);
  } finally {
    await directory.close();
  }
  await rmdir(path);
}

async function removeNamedEntryIfExists(parent: FileHandle, name: string, recursive: boolean): Promise<void> {
  try { await removeNamedEntry(parent, name, recursive); }
  catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
}

async function renameWithFlags(
  sourceParent: FileHandle,
  sourceName: string,
  destinationParent: FileHandle,
  destinationName: string,
  flags: number,
): Promise<void> {
  if (process.platform !== 'linux') {
    throw fileError('ENOSYS', descriptorChildPath(destinationParent, destinationName), 'Atomic bounded renames require Linux renameat2 support.');
  }
  const script = [
    'import ctypes, os, sys',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'fn = libc.renameat2',
    'fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
    'result = fn(3, os.fsencode(sys.argv[1]), 4, os.fsencode(sys.argv[2]), int(sys.argv[3]))',
    'if result != 0:',
    '    value = ctypes.get_errno()',
    '    print(value, file=sys.stderr)',
    '    raise SystemExit(1)',
  ].join('\n');
  let result: Awaited<ReturnType<typeof runHelper>>;
  try {
    result = await runHelper('/usr/bin/python3', ['-c', script, sourceName, destinationName, String(flags)], sourceParent.fd, destinationParent.fd);
  } catch (error) {
    throw new BoundedFileSystemCapabilityError(
      `The descriptor-relative rename helper could not start: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (result.code === 0) return;
  const errno = Number.parseInt(result.stderr.trim(), 10);
  if ([22, 38, 95].includes(errno) || !Number.isFinite(errno)) {
    throw new BoundedFileSystemCapabilityError(
      `Descriptor-relative renameat2 RENAME_NOREPLACE is unavailable for the bounded filesystem${Number.isFinite(errno) ? ` (errno ${errno})` : ''}.`,
    );
  }
  throw fileError(errnoName(errno), descriptorChildPath(destinationParent, destinationName));
}

async function runHelper(command: string, args: string[], sourceFd: number, destinationFd: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1', PYTHONPATH: '' },
      stdio: ['ignore', 'ignore', 'pipe', sourceFd, destinationFd],
    });
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

function errnoName(value: number): string {
  return new Map<number, string>([
    [1, 'EPERM'],
    [2, 'ENOENT'],
    [5, 'EIO'],
    [13, 'EACCES'],
    [17, 'EEXIST'],
    [18, 'EXDEV'],
    [20, 'ENOTDIR'],
    [21, 'EISDIR'],
    [22, 'EINVAL'],
    [28, 'ENOSPC'],
    [30, 'EROFS'],
    [38, 'ENOSYS'],
    [39, 'ENOTEMPTY'],
    [40, 'ELOOP'],
    [95, 'EOPNOTSUPP'],
    [122, 'EDQUOT'],
  ]).get(value) ?? 'EIO';
}

async function handleIdentity(handle: FileHandle): Promise<FileIdentity> {
  const info = await handle.stat({ bigint: true });
  return { dev: info.dev, ino: info.ino, ctimeNs: info.ctimeNs, size: info.size };
}

async function identityAt(path: string): Promise<FileIdentity> {
  const info = await lstat(path, { bigint: true });
  return { dev: info.dev, ino: info.ino, ctimeNs: info.ctimeNs, size: info.size };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs && left.size === right.size;
}

function updateIdentityDigest(hash: ReturnType<typeof createHash>, identity: FileIdentity): void {
  hash.update(identity.dev.toString(10));
  hash.update('\0');
  hash.update(identity.ino.toString(10));
  hash.update('\0');
  hash.update(identity.ctimeNs.toString(10));
  hash.update('\0');
  hash.update(identity.size.toString(10));
  hash.update('\n');
}

function assertBeforeArchiveDeadline(deadline: number | undefined, path: string, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (deadline !== undefined && Date.now() > deadline) throw fileError('ETIMEDOUT', path);
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
}

function sameObjectIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRenamedIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameObjectIdentity(left, right) && left.size === right.size;
}

function startsWithParts(value: string[], prefix: string[]): boolean {
  return prefix.length <= value.length && prefix.every((part, index) => value[index] === part);
}

function sameParts(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => right[index] === part);
}

function sameFinalSymlinkResolution(
  left: FinalSymlinkResolution | undefined,
  right: FinalSymlinkResolution | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.referentPaths.length === right.referentPaths.length
    && left.referentPaths.every((parts, index) => sameParts(parts, right.referentPaths[index]!))
    && left.members.length === right.members.length
    && left.members.every((member, index) => {
      const other = right.members[index]!;
      return sameParts(member.parts, other.parts) && sameIdentity(member.identity, other.identity);
    });
}

function entryType(info: Stats): 'directory' | 'file' | 'symlink' | 'other' {
  return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other';
}

async function closeOwned(handle: FileHandle, owned: boolean): Promise<void> {
  if (owned) await handle.close();
}

async function atReportedPath<T>(path: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw setReportedPath(error, path, true); }
}

function withReportedPath(error: unknown, path: string): unknown {
  return setReportedPath(error, path, false);
}

function setReportedPath(error: unknown, path: string, force: boolean): unknown {
  if (
    typeof error === 'object'
    && error !== null
    && !(error instanceof BoundedPathError)
    && !(error instanceof BoundedFileSystemCapabilityError)
    && !(error instanceof BoundedMutationOutcomeError)
    && 'code' in error
    && typeof error.code === 'string'
  ) {
    const reported = 'path' in error && typeof error.path === 'string' ? error.path : undefined;
    if (force || !reported || reported.startsWith('/proc/self/fd/') || reported.startsWith('/dev/fd/')) {
      (error as NodeJS.ErrnoException).path = path;
    }
  }
  return error;
}

function descriptorPath(handle: FileHandle): string {
  return process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : `/dev/fd/${handle.fd}`;
}

function descriptorChildPath(parent: FileHandle, name: string): string {
  return `${descriptorPath(parent)}/${name}`;
}

function fileError(code: string, path: string, message = `${code}: ${path}`): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  error.path = path;
  return error;
}

function changedError(path: string): NodeJS.ErrnoException {
  return fileError('ESTALE', path, `Path ${path} changed while the operation was in progress.`);
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
