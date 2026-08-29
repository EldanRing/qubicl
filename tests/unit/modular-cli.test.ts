import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { presetDefaults } from '@qubicl/core';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { initializeState, saveState, statePaths } from '../../packages/cli/dist/state.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/cli/dist/main.js', import.meta.url));

test('the modular CLI entrypoint covers local read-only daily-driver commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-modular-cli-'));
  const stateRoot = join(root, 'state');
  const output = join(root, 'qubicl.yaml');
  const env = { ...process.env, QUBICL_HOME: stateRoot };
  try {
    const state = await initializeState(statePaths(stateRoot));
    const computer = addConfiguredComputer(state, 'daily-driver', presetDefaults('workstation'));
    await saveState(state);

    assert.match((await run(['--version'], env)).stdout, /^qubicl \S+ \(\S+\)/u);
    assert.match((await run(['help'], env)).stdout, /gateway expose/u);

    const preference = JSON.parse((await run([
      'config', 'set', '--update-notifications', 'on',
    ], env)).stdout) as { localPreferences?: { updateNotifications?: boolean } };
    assert.equal(preference.localPreferences?.updateNotifications, true);
    const shown = JSON.parse((await run(['config', 'show'], env)).stdout) as {
      localPreferences?: { updateNotifications?: boolean };
    };
    assert.equal(shown.localPreferences?.updateNotifications, true);

    assert.match((await run(['network', 'show', computer.name], env)).stdout, /"profile": "developer"/u);
    assert.deepEqual(JSON.parse((await run(['secret', 'list', computer.name], env)).stdout), []);
    assert.match((await run(['ssh', 'status', computer.name], env)).stdout, /^disabled$/mu);
    assert.deepEqual(JSON.parse((await run(['backup', 'list', computer.name], env)).stdout), []);
    assert.equal((await run(['audit', 'show', computer.name], env)).stdout, '\n');

    const connection = JSON.parse((await run([
      'connect', computer.name, '--client', 'open-webui', '--transport', 'openapi',
    ], env)).stdout) as { id?: string; url?: string; auth_type?: string };
    assert.equal(connection.id, 'qubicl-daily-driver');
    assert.match(connection.url ?? '', /^http:\/\/host\.docker\.internal:/u);
    assert.equal(connection.auth_type, 'bearer');
    assert.match((await run(['token', 'show', computer.name], env)).stdout.trim(), /^qubicl_[A-Za-z0-9_-]+$/u);

    await run(['export', '--output', output], env);
    assert.match(await readFile(output, 'utf8'), /daily-driver/u);

    const cleanup = await runFailure(['cleanup'], env);
    assert.match(cleanup.stderr, /Cleanup requires --orphans and\/or --images/u);
    const invalidUpgrade = await runFailure(['upgrade', computer.name, '--yes'], env);
    assert.match(invalidUpgrade.stderr, /--yes is accepted only with qubicl upgrade --all/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the modular CLI entrypoint exercises bounded devcontainer and Git workflows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-modular-workflows-'));
  const stateRoot = join(root, 'state');
  const source = join(root, 'source');
  const devcontainer = join(root, 'devcontainer');
  const env = { ...process.env, QUBICL_HOME: stateRoot };
  try {
    await mkdir(join(devcontainer, '.devcontainer'), { recursive: true });
    await writeFile(join(devcontainer, '.devcontainer', 'devcontainer.json'), `{
      // Comments and trailing commas are accepted, but only bounded fields survive.
      "image": "example/qubicl-compatible:1",
      "containerEnv": { "PROJECT_MODE": "test" },
    }\n`);
    const inspected = JSON.parse((await run(['devcontainer', 'inspect', devcontainer], env)).stdout) as {
      image?: string;
      environment?: Record<string, string>;
    };
    assert.equal(inspected.image, 'example/qubicl-compatible:1');
    assert.deepEqual(inspected.environment, { PROJECT_MODE: 'test' });

    await writeFile(join(devcontainer, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      image: 'example/qubicl-compatible:1',
      privileged: true,
    }));
    assert.match((await runFailure(['devcontainer', 'inspect', devcontainer], env)).stderr, /Unsupported or unsafe devcontainer fields: privileged/u);

    await mkdir(source);
    await exec('git', ['init', '--initial-branch=main'], { cwd: source });
    await exec('git', ['config', 'user.email', 'qubicl-test@example.invalid'], { cwd: source });
    await exec('git', ['config', 'user.name', 'Qubicl Test'], { cwd: source });
    await writeFile(join(source, 'README.md'), 'initial\n');
    await exec('git', ['add', 'README.md'], { cwd: source });
    await exec('git', ['commit', '-m', 'initial'], { cwd: source });

    const state = await initializeState(statePaths(stateRoot));
    const computer = addConfiguredComputer(state, 'git-test', presetDefaults('file-system'));
    await mkdir(join(state.paths.computers, computer.id, 'home', 'qubicl'), { recursive: true, mode: 0o700 });
    await saveState(state);

    await run(['git', 'import', computer.name, source, '--directory', 'project'], env);
    const repository = join(state.paths.computers, computer.id, 'home', 'qubicl', 'project');
    await writeFile(join(repository, 'README.md'), 'initial\nchanged\n');
    assert.match((await run(['git', 'status', computer.name, '--repo', 'project'], env)).stdout, /M README\.md/u);
    assert.match((await run(['git', 'diff', computer.name, '--repo', 'project'], env)).stdout, /\+changed/u);
    const patch = join(root, 'change.patch');
    await run(['git', 'patch', computer.name, '--repo', 'project', '--output', patch], env);
    assert.match(await readFile(patch, 'utf8'), /\+changed/u);
    await run(['git', 'worktree', computer.name, 'feature/test', '--repo', 'project'], env);
    assert.equal((await readFile(join(state.paths.computers, computer.id, 'home', 'qubicl', 'worktrees', 'feature-test', 'README.md'), 'utf8')), 'initial\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return exec(process.execPath, [cli, ...args], { env });
}

async function runFailure(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return run(args, env).then(
    () => assert.fail(`Expected ${args.join(' ')} to fail.`),
    (error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  );
}
