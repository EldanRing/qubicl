import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      "containerEnv": { "PROJECT_MODE": "test", "LITERAL": "keep ,} and ,] exactly" },
    }\n`);
    const inspected = await exec(process.execPath, [cli, 'devcontainer', 'inspect', root], { env: { ...process.env, QUBICL_HOME: join(root, 'unused-state') } });
    const result = JSON.parse(inspected.stdout) as { image: string; environment: Record<string, string> };
    assert.equal(result.image, 'example/qubicl-compatible:1');
    assert.deepEqual(result.environment, { PROJECT_MODE: 'test', LITERAL: 'keep ,} and ,] exactly' });

    await writeFile(path, JSON.stringify({ image: 'example/qubicl-compatible:1', workspaceFolder: '/home/qubicl/../outside' }));
    const escapedWorkspace = await exec(process.execPath, [cli, 'devcontainer', 'inspect', root], { env: { ...process.env, QUBICL_HOME: join(root, 'unused-state') } })
      .then(() => undefined, (error) => error as { stderr: string });
    assert.match(escapedWorkspace?.stderr ?? '', /workspaceFolder/);

    await writeFile(path, JSON.stringify({ image: 'example/qubicl-compatible:1', privileged: true }));
    const rejected = await exec(process.execPath, [cli, 'devcontainer', 'inspect', root], { env: { ...process.env, QUBICL_HOME: join(root, 'unused-state') } })
      .then(() => undefined, (error) => error as { stderr: string });
    assert.match(rejected?.stderr ?? '', /Unsupported or unsafe devcontainer fields: privileged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Git workflows execute repository operations inside the computer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-git-workflow-'));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  try {
    await mkdir(join(source, '.git', 'hooks'), { recursive: true });
    const escapedMarker = join(root, 'host-command-ran');
    await writeFile(join(source, '.git', 'config'), `[core]\n\tfsmonitor = touch ${escapedMarker}\n`);
    await writeFile(join(source, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${escapedMarker}\n`);
    await chmod(join(source, '.git', 'hooks', 'post-checkout'), 0o755);
    await writeFile(join(source, 'README.md'), 'untrusted repository\n');

    const bin = join(root, 'bin');
    const dockerLog = join(root, 'docker.jsonl');
    await mkdir(bin);
    const fakeDocker = join(bin, 'docker');
    await writeFile(fakeDocker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QUBICL_TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') process.stdout.write('running\\n');
if (args[0] === 'exec' && args.includes('status')) process.stdout.write('## main\\n M README.md\\n');
if (args[0] === 'exec' && args.includes('diff')) process.stdout.write('diff --git a/README.md b/README.md\\n+changed\\n');
if (args[0] === 'exec' && args.includes('rev-parse')) process.stdout.write('.git\\n');
`, { mode: 0o755 });

    const state = await initializeState(statePaths(stateRoot));
    const computer = addConfiguredComputer(state, 'git-test');
    const computerDirectory = join(state.paths.computers, computer.id);
    await mkdir(join(computerDirectory, 'home', 'qubicl'), { recursive: true, mode: 0o700 });
    await saveMetadata(state.paths, computer);
    await saveState(state);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, QUBICL_HOME: stateRoot, QUBICL_TEST_DOCKER_LOG: dockerLog };

    await exec(process.execPath, [cli, 'git', 'import', computer.name, source, '--directory', 'project'], { env });
    const status = await exec(process.execPath, [cli, 'git', 'status', computer.name, '--repo', 'project'], { env });
    assert.match(status.stdout, /M README\.md/);
    const diff = await exec(process.execPath, [cli, 'git', 'diff', computer.name, '--repo', 'project'], { env });
    assert.match(diff.stdout, /\+changed/);
    const patch = join(root, 'change.patch');
    await exec(process.execPath, [cli, 'git', 'patch', computer.name, '--repo', 'project', '--output', patch], { env });
    assert.match(await readFile(patch, 'utf8'), /\+changed/);
    await assert.rejects(readFile(escapedMarker), /ENOENT/);
    const calls = (await readFile(dockerLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((call) => call[0] === 'cp' && call[1] === `${source}/.`));
    assert.ok(calls.filter((call) => call.includes('git')).every((call) => call[0] === 'exec'));
    assert.ok(calls.some((call) => call.includes('protocol.file.allow=always')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
