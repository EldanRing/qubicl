import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertDashboardPasswordVerifier, type DashboardPasswordVerifier } from './auth.js';

const MAX_DASHBOARD_DOCUMENT_BYTES = 256 * 1024;

export interface DashboardStoragePaths {
  directory: string;
  auth: string;
}

export interface DashboardAuthDocument {
  schemaVersion: 1;
  password: DashboardPasswordVerifier;
  updatedAt: string;
}

export function dashboardStoragePaths(stateRoot: string): DashboardStoragePaths {
  const directory = join(stateRoot, 'dashboard');
  return { directory, auth: join(directory, 'auth.json') };
}

export async function initializeDashboardStorage(paths: DashboardStoragePaths): Promise<void> {
  await ensurePrivateDirectory(dirname(paths.directory));
  try {
    await mkdir(paths.directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  await assertPrivateDirectory(paths.directory);
}

export async function loadDashboardAuthDocument(paths: DashboardStoragePaths): Promise<DashboardAuthDocument | undefined> {
  await assertPrivateDirectory(paths.directory);
  let value: unknown;
  try {
    value = await readProtectedJson(paths.auth);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
  assertDashboardAuthDocument(value);
  return value;
}

export async function saveDashboardAuthDocument(paths: DashboardStoragePaths, document: DashboardAuthDocument): Promise<void> {
  assertDashboardAuthDocument(document);
  await assertPrivateDirectory(paths.directory);
  await writeProtectedJson(paths.auth, document);
}

export async function readProtectedJson(path: string): Promise<unknown> {
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    await assertPrivateFileHandle(handle, path);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_DASHBOARD_DOCUMENT_BYTES) throw new Error(`Dashboard document ${path} exceeds the size limit.`);
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error(`Dashboard document ${path} is not valid JSON.`);
    }
  } finally {
    await handle.close();
  }
}

export async function writeProtectedJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await assertPrivateDirectory(directory);
  await assertReplaceablePrivateFile(path);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new Error(`Dashboard document ${path} must contain a JSON value.`);
  const body = `${serialized}\n`;
  if (Buffer.byteLength(body) > MAX_DASHBOARD_DOCUMENT_BYTES) throw new Error(`Dashboard document ${path} exceeds the size limit.`);
  const temporary = join(directory, `.${randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    await assertPrivateFileHandle(handle, temporary);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(directory);
    await assertPrivateFile(path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function assertDashboardAuthDocument(value: unknown): asserts value is DashboardAuthDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dashboard authentication document is invalid.');
  const document = value as Partial<DashboardAuthDocument>;
  if (document.schemaVersion !== 1 || typeof document.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(document.updatedAt))) {
    throw new Error('Dashboard authentication document is invalid.');
  }
  assertDashboardPasswordVerifier(document.password);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const found = await lstat(path);
  if (!found.isDirectory() || found.isSymbolicLink()) throw new Error(`Dashboard storage path ${path} is not a real directory.`);
  assertOwnedByCurrentUser(found.uid, path);
  if ((found.mode & 0o777) !== 0o700) throw new Error(`Dashboard storage directory ${path} must use mode 0700.`);
}

async function assertReplaceablePrivateFile(path: string): Promise<void> {
  try {
    await assertPrivateFile(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function assertPrivateFile(path: string): Promise<void> {
  const found = await lstat(path);
  if (!found.isFile() || found.isSymbolicLink() || found.nlink !== 1) throw new Error(`Dashboard document ${path} is not a regular private file.`);
  assertOwnedByCurrentUser(found.uid, path);
  if ((found.mode & 0o777) !== 0o600) throw new Error(`Dashboard document ${path} must use mode 0600.`);
}

async function assertPrivateFileHandle(handle: Awaited<ReturnType<typeof open>>, path: string): Promise<void> {
  const found = await handle.stat();
  if (!found.isFile() || found.nlink !== 1) throw new Error(`Dashboard document ${path} is not a regular private file.`);
  assertOwnedByCurrentUser(found.uid, path);
  if ((found.mode & 0o777) !== 0o600) throw new Error(`Dashboard document ${path} must use mode 0600.`);
}

function assertOwnedByCurrentUser(uid: number, path: string): void {
  const expected = process.getuid?.();
  if (expected === undefined || expected === 0) throw new Error('Dashboard storage requires a normal host user.');
  if (uid !== expected) throw new Error(`Dashboard storage path ${path} is not owned by the current user.`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | directoryFlag() | noFollowFlag());
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function noFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function directoryFlag(): number {
  return typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
