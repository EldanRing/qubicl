import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sourceRoot = process.cwd();
const sourceCleaner = join(sourceRoot, 'scripts', 'clean-artifacts.mjs');
const candidateRoot = 'release/candidates/0.1.0-dev.1-abcdef123456';
const candidateTarget = candidateRoot + '/linux-x64';
const nativeTarget = 'release/qubicl-linux-x64';
const packageTarget = 'qubicl-0.1.0-dev.1.tgz';
const sbomTarget = 'qubicl-npm.spdx.json';
const distTarget = 'packages/cli/dist/qubicl.mjs';

test('artifact cleanup lists and dry-runs only retained artifact shapes', async (context) => {
  const repository = await createFixture(context);

  const listed = parseResult((await runCleaner(repository, [])).stdout);
  assert.equal(listed.mode, 'dry-run');
  assert.deepEqual(listed.targets, [
    packageTarget,
    sbomTarget,
    candidateRoot,
    nativeTarget,
  ].sort());

  const explicit = parseResult((await runCleaner(repository, [candidateTarget])).stdout);
  assert.deepEqual(explicit, { mode: 'dry-run', targets: [candidateTarget] });

  for (const target of [packageTarget, sbomTarget, candidateTarget, nativeTarget, distTarget]) {
    await access(join(repository, target));
  }
});

test('artifact cleanup requires explicit safe targets before deletion', async (context) => {
  const repository = await createFixture(context);
  const outside = await mkdtemp(join(tmpdir(), 'qubicl-clean-artifacts-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = join(outside, 'sentinel.txt');
  await writeFile(sentinel, 'outside\n');

  await assert.rejects(runCleaner(repository, ['--confirm']), /--confirm requires/);
  await assert.rejects(
    runCleaner(repository, ['--confirm', 'packages/cli/dist']),
    /not an allowlisted/,
  );
  await assert.rejects(
    runCleaner(repository, ['--confirm', '../outside']),
    /canonical repo-relative/,
  );
  await assert.rejects(
    runCleaner(repository, ['--confirm', outside]),
    /repo-relative paths/,
  );
  await assert.rejects(
    runCleaner(repository, ['--confirm', candidateRoot, candidateTarget]),
    /must not overlap/,
  );

  const linkedTarget = 'release/candidates/0.1.0-dev.1-deadbeef';
  await symlink(outside, join(repository, linkedTarget), 'dir');
  await assert.rejects(
    runCleaner(repository, ['--confirm', linkedTarget]),
    /symlink path components/,
  );

  const trackedTarget = 'qubicl-tracked.tgz';
  await writeFile(join(repository, trackedTarget), 'tracked\n');
  await exec('git', ['add', '--force', trackedTarget], { cwd: repository });
  await assert.rejects(
    runCleaner(repository, ['--confirm', trackedTarget]),
    /tracked repository content/,
  );

  const deleted = parseResult(
    (await runCleaner(repository, ['--confirm', packageTarget])).stdout,
  );
  assert.deepEqual(deleted, { mode: 'deleted', targets: [packageTarget] });
  await assert.rejects(access(join(repository, packageTarget)), { code: 'ENOENT' });

  for (const target of [trackedTarget, sbomTarget, candidateTarget, nativeTarget, distTarget]) {
    await access(join(repository, target));
  }
  assert.equal(await readFile(sentinel, 'utf8'), 'outside\n');
});

async function createFixture(context: TestContext): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'qubicl-clean-artifacts-'));
  context.after(() => rm(repository, { recursive: true, force: true }));
  await mkdir(join(repository, 'scripts'), { recursive: true });
  await writeFile(
    join(repository, 'scripts', 'clean-artifacts.mjs'),
    await readFile(sourceCleaner),
  );
  await writeFile(
    join(repository, '.gitignore'),
    ['release/', '*.tgz', '*.spdx.json', 'packages/*/dist/', ''].join('\n'),
  );
  await exec('git', ['init', '--quiet'], { cwd: repository });
  await exec('git', ['add', '.gitignore', 'scripts/clean-artifacts.mjs'], {
    cwd: repository,
  });

  await mkdir(join(repository, candidateTarget), { recursive: true });
  await writeFile(join(repository, candidateTarget, 'candidate.json'), '{}\n');
  await mkdir(join(repository, nativeTarget), { recursive: true });
  await writeFile(join(repository, nativeTarget, 'qubicl'), 'native\n');
  await mkdir(join(repository, 'packages/cli/dist'), { recursive: true });
  await writeFile(join(repository, distTarget), 'ordinary build output\n');
  await writeFile(join(repository, packageTarget), 'package\n');
  await writeFile(join(repository, sbomTarget), '{}\n');
  return repository;
}

async function runCleaner(repository: string, args: string[]) {
  return exec(
    process.execPath,
    [join(repository, 'scripts', 'clean-artifacts.mjs'), ...args],
    { cwd: repository },
  );
}

function parseResult(stdout: string): { mode: string; targets: string[] } {
  return JSON.parse(stdout) as { mode: string; targets: string[] };
}
