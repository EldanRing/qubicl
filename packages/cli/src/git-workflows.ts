import { randomUUID } from 'node:crypto';
import { lstat, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, posix, resolve } from 'node:path';
import type { ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { flag, stringOption } from './args.js';
import { docker } from './docker.js';
import { computerContainerName } from './runtime.js';
import { loadState, type LoadedState } from './state.js';

const CAPTURE_LIMIT_BYTES = 32 * 1024 * 1024;

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}.`);
  return value;
}

function findComputer(state: LoadedState, name: string): ComputerConfig {
  const computer = state.config.computers.find((entry) => entry.name === name || entry.id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return computer;
}

function safeRelative(value: string, what: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || isAbsolute(value) || normalized.split('/').includes('..') || normalized.startsWith('-')
    || posix.normalize(normalized) !== normalized || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`${what} must be a normalized relative path without .. segments.`);
  }
  return normalized;
}

function guestPath(value: string): string {
  return posix.join('/home/qubicl', safeRelative(value, 'Repository path'));
}

function validateRef(value: string, what: string): string {
  if (!value || value.startsWith('-') || /[\s\0]/u.test(value)) throw new Error(`Invalid ${what}.`);
  return value;
}

function validateRemote(url: string): void {
  if (url.startsWith('-') || /[\r\n\0]/u.test(url)) throw new Error('Invalid Git remote URL.');
  if (/^https?:\/\//iu.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error('Do not embed credentials in a Git URL; authenticate inside the computer with gh, glab, a Git credential helper, or SSH.');
    return;
  }
  if (/^(?:git|ssh):\/\//iu.test(url) || /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/u.test(url)) return;
  throw new Error('Git remote must use HTTPS or SSH. Local paths belong to git import.');
}

async function requireRunning(state: LoadedState, computer: ComputerConfig): Promise<string> {
  const container = computerContainerName(state, computer);
  const status = await docker(['inspect', '--format', '{{.State.Status}}', container], {
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  }).catch(() => 'absent');
  if (status !== 'running') throw new Error(`Computer ${computer.name} must be running for guest Git workflows (current status: ${status}).`);
  return container;
}

async function guestCommand(
  container: string,
  command: string,
  args: readonly string[],
  options: { cwd?: string; inherit?: boolean; asRoot?: boolean; allowFailure?: boolean } = {},
): Promise<string> {
  return docker([
    'exec',
    '--user', options.asRoot ? 'root' : 'qubicl',
    '--workdir', options.cwd ?? '/home/qubicl',
    '--env', 'HOME=/home/qubicl',
    '--env', 'USER=qubicl',
    '--env', 'LOGNAME=qubicl',
    '--env', 'LANG=C.UTF-8',
    '--env', `GIT_TERMINAL_PROMPT=${process.stdin.isTTY ? '1' : '0'}`,
    ...(options.inherit ? ['--interactive'] : []),
    container,
    command,
    ...args,
  ], {
    ...(options.inherit === undefined ? {} : { inherit: options.inherit }),
    ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
    ...(options.inherit ? {} : { timeoutMs: 120_000 }),
    ...(options.inherit ? {} : { maxOutputBytes: CAPTURE_LIMIT_BYTES }),
  });
}

async function guestGit(container: string, args: readonly string[], cwd = '/home/qubicl', inherit = false): Promise<string> {
  return guestCommand(container, 'git', args, { cwd, inherit });
}

export async function gitCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'git action');
  const state = await loadState();
  const computer = findComputer(state, required(args.positionals[1], 'computer name'));
  const container = await requireRunning(state, computer);

  if (action === 'clone') {
    const url = required(args.positionals[2], 'remote URL'); validateRemote(url);
    const directory = safeRelative(stringOption(args, 'directory') ?? basename(url.replace(/\.git$/u, '')), 'Clone directory');
    const command = ['clone', '--no-tags'];
    const branch = stringOption(args, 'branch');
    if (branch) command.push('--branch', validateRef(branch, 'branch name'), '--single-branch');
    command.push('--', url, guestPath(directory));
    await guestGit(container, command, '/home/qubicl', true);
    console.log(`Cloned ${url} into ${guestPath(directory)}. Git and authentication ran inside ${computer.name}.`);
    return;
  }

  if (action === 'import') {
    const source = await realpath(required(args.positionals[2], 'local repository'));
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isDirectory()) throw new Error('Local repository must be a directory.');
    const directory = safeRelative(stringOption(args, 'directory') ?? basename(source), 'Import directory');
    const staging = `/tmp/qubicl-git-import-${randomUUID()}`;
    try {
      await docker(['cp', `${source}/.`, `${container}:${staging}`], { inherit: true });
      await guestCommand(container, 'chown', ['-R', 'qubicl:qubicl', '--', staging], { asRoot: true });
      await guestGit(container, [
        '-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks',
        ...(flag(args, 'read-only') ? ['--no-local'] : []), '--', staging, guestPath(directory),
      ], '/home/qubicl', true);
    } finally {
      await guestCommand(container, 'rm', ['-rf', '--', staging], { asRoot: true, allowFailure: true }).catch(() => undefined);
    }
    console.log(`Imported a detached clone into ${guestPath(directory)}; repository Git ran only inside ${computer.name}${flag(args, 'read-only') ? ' (read-only source mode)' : ''}.`);
    return;
  }

  const repository = guestPath(stringOption(args, 'repo') ?? '.');
  await guestGit(container, ['rev-parse', '--git-dir'], repository);
  if (action === 'status') { process.stdout.write(`${await guestGit(container, ['status', '--short', '--branch'], repository)}\n`); return; }
  if (action === 'diff') { process.stdout.write(`${await guestGit(container, ['diff', '--no-ext-diff', '--stat', '--patch'], repository)}\n`); return; }
  if (action === 'patch') {
    const output = required(stringOption(args, 'output'), '--output path');
    const patch = await guestGit(container, ['diff', '--no-ext-diff', '--binary', 'HEAD'], repository);
    await writeFile(output, `${patch}\n`, { mode: 0o600 });
    console.log(`Wrote ${Buffer.byteLength(patch)}-byte patch to ${resolve(output)}.`);
    return;
  }
  if (action === 'worktree') {
    const branch = validateRef(required(args.positionals[2], 'branch name'), 'branch name');
    await guestGit(container, ['check-ref-format', '--branch', branch], repository);
    const directory = safeRelative(stringOption(args, 'directory') ?? posix.join('worktrees', branch.replaceAll('/', '-')), 'Worktree directory');
    const target = guestPath(directory);
    await guestCommand(container, 'mkdir', ['-p', '--', posix.dirname(target)]);
    const exists = await guestGit(container, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repository).then(() => true, () => false);
    await guestGit(container, exists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target], repository, true);
    console.log(`Created worktree ${target} for ${branch}.`);
    return;
  }
  if (action === 'push') {
    if (!flag(args, 'yes')) throw new Error('Git push changes a remote and requires --yes.');
    const remote = validateRef(stringOption(args, 'remote') ?? 'origin', 'remote name');
    const branch = stringOption(args, 'branch') ?? (await guestGit(container, ['branch', '--show-current'], repository)).trim();
    if (!branch) throw new Error('Detached HEAD requires --branch.');
    validateRef(branch, 'branch name');
    await guestGit(container, ['push', '--', remote, branch], repository, true);
    console.log(`Pushed ${branch} to ${remote}; Git and authentication ran inside ${computer.name}.`);
    return;
  }
  throw new Error('Git action must be clone, import, status, diff, patch, worktree, or push.');
}
