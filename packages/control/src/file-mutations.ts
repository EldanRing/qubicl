import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const mutationQueues = new Map<string, Promise<void>>();

export async function withFileMutation<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  const queued = current.then(() => undefined, () => undefined);
  mutationQueues.set(path, queued);
  try {
    return await current;
  } finally {
    if (mutationQueues.get(path) === queued) mutationQueues.delete(path);
  }
}

export async function atomicReplaceFile(path: string, data: Uint8Array, createParents: boolean): Promise<void> {
  const directory = dirname(path);
  if (createParents) await mkdir(directory, { recursive: true });
  let mode = 0o644;
  try { mode = (await lstat(path)).mode & 0o7777; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.qubicl-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, mode);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
