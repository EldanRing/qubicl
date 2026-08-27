import { lstat, mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const TARGET = /^(?:linux|darwin)-(?:x64|arm64)$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const FAILED_NAME = /^\.failed-([0-9A-Za-z.+-]+)-([a-f0-9]{12})-((?:linux|darwin)-(?:x64|arm64))\.([1-9][0-9]*)$/u;

export async function preserveFailedCandidate(staging, {
  outputRoot,
  version,
  revision,
  target,
  processId = process.pid,
}) {
  assert(typeof version === 'string' && /^[0-9A-Za-z.+-]+$/u.test(version), 'Failed candidate preservation requires a safe version.');
  assert(REVISION.test(revision), 'Failed candidate preservation requires the exact reviewed Git revision.');
  assert(TARGET.test(target), 'Failed candidate preservation requires a supported native target.');
  assert(Number.isInteger(processId) && processId > 0, 'Failed candidate preservation requires a valid process ID.');
  const destination = join(resolve(outputRoot), `.failed-${version}-${revision.slice(0, 12)}-${target}.${processId}`);
  await rename(staging, destination);
  return destination;
}

export async function resumeFailedCandidate(sourcePath, {
  candidatesRoot,
  root,
  verify,
}) {
  assert(typeof verify === 'function', 'Failed candidate resume requires the candidate verifier.');
  const rootDirectory = resolve(candidatesRoot);
  const source = resolve(sourcePath);
  const sourceRelative = relative(rootDirectory, source);
  assert(sourceRelative && sourceRelative !== '..' && !sourceRelative.startsWith(`..${sep}`) && !sourceRelative.includes(sep),
    'Failed candidate must be a direct child of release/candidates.');
  const nameMatch = FAILED_NAME.exec(basename(source));
  assert(nameMatch, 'Path is not a preserved failed candidate directory.');
  const sourceStat = await lstat(source);
  assert(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), 'Failed candidate path must be a real directory.');

  const verified = await verify(source, { root });
  const candidate = verified?.candidate;
  assert(candidate?.version === nameMatch[1]
    && candidate?.revision?.slice(0, 12) === nameMatch[2]
    && candidate?.host?.target === nameMatch[3],
  'Preserved failed candidate name does not match its verified release identity.');
  const destination = resolve(rootDirectory, `${candidate.version}-${candidate.revision.slice(0, 12)}`, candidate.host.target);
  assert(!(await exists(destination)), `Candidate output already exists at ${destination}.`);
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  return { verified, source, destination, verificationOnly: true };
}

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
