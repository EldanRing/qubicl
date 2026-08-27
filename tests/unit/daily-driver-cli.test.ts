import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { initializeState, saveMetadata, saveState, statePaths } from '../../packages/cli/dist/state.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/cli/dist/qubicl.mjs', import.meta.url));

test('devcontainer inspect accepts bounded JSONC and rejects privilege-bearing fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-devcontainer-'));
  try {
    const directory = join(root, '.devcontainer');
    await mkdir(directory);
    const path = join(directory, 'devcontainer.json');
    await writeFile(path, `{
      // Qubicl imports only the workload identity and literal environment.
      "image": "example/qubicl-compatible:1",
      "containerEnv": { "PROJECT_MODE": "test" },
    }\n`);
    const inspected = await exec(process.execPath, [cli, 'devcontainer', 'inspect', root], { env: { ...process.env, QUBICL_HOME: join(root, 'unused-state') } });
    const result = JSON.parse(inspected.stdout) as { image: string; environment: Record<string, string> };
    assert.equal(result.image, 'example/qubicl-compatible:1');
    assert.deepEqual(result.environment, { PROJECT_MODE: 'test' });

    await writeFile(path, JSON.stringify({ image: 'example/qubicl-compatible:1', privileged: true }));
    const rejected = await exec(process.execPath, [cli, 'devcontainer', 'inspect', root], { env: { ...process.env, QUBICL_HOME: join(root, 'unused-state') } })
      .then(() => undefined, (error) => error as { stderr: string });
    assert.match(rejected?.stderr ?? '', /Unsupported or unsafe devcontainer fields: privileged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host-side Git import, status, diff, and patch stay inside one durable home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-git-workflow-'));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  try {
    await mkdir(source);
    await exec('git', ['init', '--initial-branch=main'], { cwd: source });
    await exec('git', ['config', 'user.email', 'qubicl-test@example.invalid'], { cwd: source });
    await exec('git', ['config', 'user.name', 'Qubicl Test'], { cwd: source });
    await writeFile(join(source, 'README.md'), 'initial\n');
    await exec('git', ['add', 'README.md'], { cwd: source });
    await exec('git', ['commit', '-m', 'initial'], { cwd: source });

    const state = await initializeState(statePaths(stateRoot));
    const computer = addConfiguredComputer(state, 'git-test');
    const computerDirectory = join(state.paths.computers, computer.id);
    await mkdir(join(computerDirectory, 'home', 'qubicl'), { recursive: true, mode: 0o700 });
    await saveMetadata(state.paths, computer);
    await saveState(state);
    const env = { ...process.env, QUBICL_HOME: stateRoot };

    await exec(process.execPath, [cli, 'git', 'import', computer.name, source, '--directory', 'project'], { env });
    const repository = join(computerDirectory, 'home', 'qubicl', 'project');
    await writeFile(join(repository, 'README.md'), 'initial\nchanged\n');
    const status = await exec(process.execPath, [cli, 'git', 'status', computer.name, '--repo', 'project'], { env });
    assert.match(status.stdout, /M README\.md/);
    const diff = await exec(process.execPath, [cli, 'git', 'diff', computer.name, '--repo', 'project'], { env });
    assert.match(diff.stdout, /\+changed/);
    const patch = join(root, 'change.patch');
    await exec(process.execPath, [cli, 'git', 'patch', computer.name, '--repo', 'project', '--output', patch], { env });
    assert.match(await readFile(patch, 'utf8'), /\+changed/);

    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(computerDirectory, 'home', 'qubicl', 'escape'));
    const escaped = await exec(process.execPath, [cli, 'git', 'import', computer.name, source, '--directory', 'escape/imported'], { env })
      .then(() => undefined, (error) => error as { stderr?: string; message?: string });
    assert.match(escaped?.stderr || escaped?.message || '', /escapes the computer home through a symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
