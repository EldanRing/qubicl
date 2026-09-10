import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { ComputerConfigSchema, parseComputerMetadataDocument } from '@qubicl/core';
import { statePaths } from '../state.js';

export interface DashboardBackup {
  id: string; name: string; sourceId: string; createdAt: string;
  encrypted: boolean; consistency: 'live' | 'quiesced' | 'stopped'; sha256: string;
}
async function boundedFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 131072 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Unsafe management metadata.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  if (entries.length > 10000) throw new Error('Metadata inventory exceeds the dashboard limit; use the host CLI.');
  return entries.filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(entry.name)).map(({ name }) => name);
}
export async function dashboardBackups(root: string): Promise<DashboardBackup[]> {
  const base = statePaths(root).backups;
  const result: DashboardBackup[] = [];
  for (const id of await directories(base)) {
    // State migration evidence is retained beside home backups, with manifest.yaml.
    if (/-v[1-3]-to-v[2-4]-[a-f0-9-]{36}$/u.test(id)) continue;
    const value = JSON.parse(await boundedFile(join(base, id, 'manifest.json'))) as Record<string, unknown>;
    const source = ComputerConfigSchema.parse(value.source);
    if (value.version !== 1 || value.id !== id || typeof value.name !== 'string' || value.name.length > 256
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.encrypted !== 'boolean' || !['live', 'quiesced', 'stopped'].includes(String(value.consistency))
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error('Invalid backup metadata; inspect it with the host CLI.');
    result.push({ id, name: value.name, sourceId: source.id, createdAt: value.createdAt, encrypted: value.encrypted,
      consistency: value.consistency as DashboardBackup['consistency'], sha256: value.sha256 });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
export async function dashboardTrash(root: string): Promise<Array<{ id: string; name: string }>> {
  const base = statePaths(root).trash;
  const result: Array<{ id: string; name: string }> = [];
  for (const id of await directories(base)) {
    const { metadata } = parseComputerMetadataDocument(YAML.parse(await boundedFile(join(base, id, 'metadata.yaml'))));
    if (id !== metadata.id) throw new Error('Trash metadata identity differs from its directory.');
    result.push({ id, name: metadata.name });
  }
  return result;
}
