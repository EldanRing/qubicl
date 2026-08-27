import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function buildMetadata(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const revision = process.env.QUBICL_BUILD_REVISION ?? await git(root, ['rev-parse', 'HEAD']) ?? 'unknown';
  const dirty = await git(root, ['status', '--porcelain']);
  const date = process.env.QUBICL_BUILD_DATE
    ?? sourceDate()
    ?? await git(root, ['show', '-s', '--format=%cI', 'HEAD'])
    ?? 'unknown';
  return {
    version: process.env.QUBICL_BUILD_VERSION ?? manifest.version,
    revision: dirty ? `${revision}-dirty` : revision,
    date,
  };
}

export function metadataDefines(metadata) {
  return {
    __QUBICL_BUILD_VERSION__: JSON.stringify(metadata.version),
    __QUBICL_BUILD_REVISION__: JSON.stringify(metadata.revision),
    __QUBICL_BUILD_DATE__: JSON.stringify(metadata.date),
  };
}

function sourceDate() {
  if (!process.env.SOURCE_DATE_EPOCH) return undefined;
  const seconds = Number(process.env.SOURCE_DATE_EPOCH);
  if (!Number.isFinite(seconds)) throw new Error('SOURCE_DATE_EPOCH must be a Unix timestamp.');
  return new Date(seconds * 1000).toISOString();
}

async function git(root, args) {
  try {
    return (await exec('git', args, { cwd: root })).stdout.trim();
  } catch {
    return undefined;
  }
}
