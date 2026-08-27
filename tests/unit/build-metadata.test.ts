import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = process.cwd();
const buildMetadataModule = pathToFileURL(join(root, 'scripts/build-metadata.mjs')).href;

test('build metadata distinguishes ignored output from untracked source', async (context) => {
  const repository = await mkdtemp(join(tmpdir(), 'qubicl-build-metadata-'));
  context.after(() => rm(repository, { recursive: true, force: true }));

  await writeFile(join(repository, 'package.json'), '{"version":"0.0.0-test"}\n');
  await writeFile(join(repository, '.gitignore'), 'generated/\n');
  await exec('git', ['init'], { cwd: repository });
  await exec('git', ['config', 'user.name', 'Qubicl Test'], { cwd: repository });
  await exec('git', ['config', 'user.email', 'qubicl-test@example.invalid'], { cwd: repository });
  await exec('git', ['add', 'package.json', '.gitignore'], { cwd: repository });
  await exec('git', ['commit', '-m', 'baseline'], { cwd: repository });

  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
  assert.equal((await metadataFor(repository)).revision, revision);

  await mkdir(join(repository, 'generated'));
  await writeFile(join(repository, 'generated', 'output.txt'), 'ignored output\n');
  assert.equal((await metadataFor(repository)).revision, revision);

  await writeFile(join(repository, 'source.ts'), 'export {};\n');
  assert.equal((await metadataFor(repository)).revision, revision + '-dirty');
});

async function metadataFor(repository: string): Promise<{ version: string; revision: string; date: string }> {
  const environment = { ...process.env };
  for (const name of [
    'QUBICL_BUILD_VERSION',
    'QUBICL_BUILD_REVISION',
    'QUBICL_BUILD_DATE',
    'SOURCE_DATE_EPOCH',
  ]) delete environment[name];
  const expression = 'import { buildMetadata } from '
    + JSON.stringify(buildMetadataModule)
    + '; process.stdout.write(JSON.stringify(await buildMetadata(process.argv[1])));';
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', expression, repository], {
    cwd: root,
    env: environment,
  });
  return JSON.parse(stdout) as { version: string; revision: string; date: string };
}
