#!/usr/bin/env node
import { lstat, mkdir, rename } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateDirectory } from './candidate-evidence.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const candidatesRoot = resolve(root, 'release', 'candidates');
const args = process.argv.slice(2);

if (args.length !== 1 || args[0] === '--help') {
  const usage = 'Usage: node scripts/resume-candidate.mjs FAILED_CANDIDATE_DIRECTORY';
  if (args[0] === '--help') {
    console.log(`${usage}\n\nVerify preserved failed staging without rebuilding, then promote it to the canonical candidate directory.`);
    process.exit(0);
  }
  throw new Error(usage);
}

const source = resolve(args[0]);
const sourceRelative = relative(candidatesRoot, source);
assert(sourceRelative && sourceRelative !== '..' && !sourceRelative.startsWith(`..${sep}`) && !sourceRelative.includes(sep), 'Failed candidate must be a direct child of release/candidates.');
assert(/^\.failed-[0-9A-Za-z.+-]+-[a-f0-9]{12}-(?:linux|darwin)-(?:x64|arm64)\.[1-9][0-9]*$/u.test(basename(source)), 'Path is not a preserved failed candidate directory.');
const sourceStat = await lstat(source);
assert(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), 'Failed candidate path must be a real directory.');

const verified = await verifyCandidateDirectory(source, { root });
const destination = resolve(
  candidatesRoot,
  `${verified.candidate.version}-${verified.candidate.revision.slice(0, 12)}`,
  verified.candidate.host.target,
);
assert(!(await exists(destination)), `Candidate output already exists at ${destination}.`);
await mkdir(dirname(destination), { recursive: true });
await rename(source, destination);
console.log(JSON.stringify({
  ok: true,
  resumed: source,
  output: destination,
  version: verified.candidate.version,
  revision: verified.candidate.revision,
  target: verified.candidate.host.target,
}, null, 2));

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
