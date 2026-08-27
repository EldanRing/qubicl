import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const moduleUrl = pathToFileURL(join(root, 'scripts', 'candidate-lifecycle.mjs')).href;
const revision = 'a'.repeat(40);

test('failed candidate preservation keeps the staging bytes under an exact release identity', async () => {
  const { preserveFailedCandidate } = await import(moduleUrl);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-failed-preserve-'));
  try {
    const outputRoot = join(temporary, 'candidates');
    const staging = join(outputRoot, '.candidate.tmp');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'sentinel'), 'reviewed candidate bytes\n');
    const before = await sha256(join(staging, 'sentinel'));
    const preserved = await preserveFailedCandidate(staging, {
      outputRoot,
      version: '0.2.0-rc.1',
      revision,
      target: 'linux-x64',
      processId: 42,
    });
    assert.equal(basename(preserved), `.failed-0.2.0-rc.1-${revision.slice(0, 12)}-linux-x64.42`);
    await assert.rejects(lstat(staging), { code: 'ENOENT' });
    assert.equal(await sha256(join(preserved, 'sentinel')), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('verification-only resume verifies once and promotes unchanged bytes without build or acceptance hooks', async () => {
  const { resumeFailedCandidate } = await import(moduleUrl);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-failed-resume-'));
  try {
    const candidatesRoot = join(temporary, 'candidates');
    const source = join(candidatesRoot, `.failed-0.2.0-${revision.slice(0, 12)}-linux-x64.43`);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'sentinel'), 'accepted candidate bytes\n');
    const before = await sha256(join(source, 'sentinel'));
    let verifications = 0;
    const result = await resumeFailedCandidate(source, {
      candidatesRoot,
      root: '/reviewed/source',
      verify: async (path: string, options: { root: string }) => {
        verifications += 1;
        assert.equal(path, source);
        assert.deepEqual(options, { root: '/reviewed/source' });
        return { candidate: { version: '0.2.0', revision, host: { target: 'linux-x64' } } };
      },
    });
    assert.equal(verifications, 1);
    assert.equal(result.verificationOnly, true);
    assert.equal(result.destination, join(candidatesRoot, `0.2.0-${revision.slice(0, 12)}`, 'linux-x64'));
    await assert.rejects(lstat(source), { code: 'ENOENT' });
    assert.equal(await sha256(join(result.destination, 'sentinel')), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('verification-only resume leaves failed staging preserved when verification fails', async () => {
  const { resumeFailedCandidate } = await import(moduleUrl);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-failed-resume-reject-'));
  try {
    const candidatesRoot = join(temporary, 'candidates');
    const source = join(candidatesRoot, `.failed-0.2.0-${revision.slice(0, 12)}-linux-x64.44`);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'sentinel'), 'still preserved\n');
    await assert.rejects(resumeFailedCandidate(source, {
      candidatesRoot,
      root: '/reviewed/source',
      verify: async () => { throw new Error('candidate verification failed'); },
    }), /candidate verification failed/);
    assert.equal(await readFile(join(source, 'sentinel'), 'utf8'), 'still preserved\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
