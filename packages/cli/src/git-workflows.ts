import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { ParsedArgs } from './args.js';
import { flag, stringOption } from './args.js';
import { loadState, type LoadedState } from './state.js';

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}.`);
  return value;
}

function computerHome(state: LoadedState, name: string): string {
  const computer = state.config.computers.find((entry) => entry.name === name || entry.id === name);
  if (!computer) throw new Error(`Computer ${name} was not found.`);
  return join(state.paths.computers, computer.id, 'home', 'qubicl');
}

function safeRelative(value: string, what: string): string {
  if (!value || isAbsolute(value) || value.split(/[\\/]/u).includes('..') || value.startsWith('-')) throw new Error(`${what} must be a relative path without .. segments.`);
  return value;
}

async function confinedExisting(root: string, value: string): Promise<string> {
  const candidate = resolve(root, safeRelative(value, 'Repository path'));
  const actual = await realpath(candidate);
  if (actual !== root && !actual.startsWith(`${root}/`)) throw new Error('Repository path escapes the computer home.');
  return actual;
}

async function confinedDestination(root: string, value: string): Promise<string> {
  const candidate = resolve(root, safeRelative(value, 'Destination path'));
  let ancestor = dirname(candidate);
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      if (actual !== root && !actual.startsWith(`${root}/`)) throw new Error('Destination path escapes the computer home through a symbolic link.');
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor || (ancestor !== root && !ancestor.startsWith(`${root}/`))) throw new Error('Destination path escapes the computer home.');
      ancestor = parent;
    }
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        GIT_TERMINAL_PROMPT: process.stdin.isTTY ? '1' : '0',
        ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
      },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`git ${args[0]} failed (${code ?? 'signal'}): ${stderr.trim()}`)));
  });
}

function validateRemote(url: string): void {
  if (url.startsWith('-') || /[\r\n\0]/u.test(url)) throw new Error('Invalid Git remote URL.');
  if (/^https?:\/\//iu.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error('Do not embed credentials in a Git URL; use the host credential helper, gh, glab, or SSH agent.');
    return;
  }
  if (/^(?:git|ssh):\/\//iu.test(url) || /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+$/u.test(url)) return;
  throw new Error('Git remote must use HTTPS or SSH. Local paths belong to git import.');
}

export async function gitCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'git action');
  const state = await loadState();
  const configuredHome = computerHome(state, required(args.positionals[1], 'computer name'));
  await mkdir(configuredHome, { recursive: true, mode: 0o700 });
  const home = await realpath(configuredHome);
  if (action === 'clone') {
    const url = required(args.positionals[2], 'remote URL'); validateRemote(url);
    const directory = safeRelative(stringOption(args, 'directory') ?? basename(url.replace(/\.git$/u, '')), 'Clone directory');
    const target = await confinedDestination(home, directory);
    try { await lstat(target); throw new Error(`Destination ${target} already exists.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const command = ['clone', '--no-tags'];
    const branch = stringOption(args, 'branch'); if (branch) command.push('--branch', branch, '--single-branch');
    command.push('--', url, target);
    await runGit(command, home);
    console.log(`Cloned ${url} into ${target}. Host credential helpers/SSH agent were used without copying credentials into the computer.`);
    return;
  }
  if (action === 'import') {
    const source = await realpath(required(args.positionals[2], 'local repository'));
    const sourceInfo = await lstat(source); if (!sourceInfo.isDirectory()) throw new Error('Local repository must be a directory.');
    await runGit(['-C', source, 'rev-parse', '--git-dir'], home);
    const directory = safeRelative(stringOption(args, 'directory') ?? basename(source), 'Import directory');
    const target = await confinedDestination(home, directory);
    await runGit(['clone', '--no-hardlinks', ...(flag(args, 'read-only') ? ['--no-local'] : []), '--', source, target], home);
    console.log(`Imported a detached clone into ${target}; the source tree was not mounted or exposed to the computer${flag(args, 'read-only') ? ' (read-only source mode)' : ''}.`);
    return;
  }
  const repository = await confinedExisting(home, stringOption(args, 'repo') ?? '.');
  await runGit(['rev-parse', '--git-dir'], repository);
  if (action === 'status') { process.stdout.write(await runGit(['status', '--short', '--branch'], repository)); return; }
  if (action === 'diff') { process.stdout.write(await runGit(['diff', '--no-ext-diff', '--stat', '--patch'], repository)); return; }
  if (action === 'patch') {
    const output = required(stringOption(args, 'output'), '--output path');
    const patch = await runGit(['diff', '--no-ext-diff', '--binary', 'HEAD'], repository);
    await writeFile(output, patch, { mode: 0o600 });
    console.log(`Wrote ${Buffer.byteLength(patch)}-byte patch to ${resolve(output)}.`);
    return;
  }
  if (action === 'worktree') {
    const branch = required(args.positionals[2], 'branch name');
    if (branch.startsWith('-') || /[\s\0]/u.test(branch)) throw new Error('Invalid branch name.');
    const directory = safeRelative(stringOption(args, 'directory') ?? join('worktrees', branch.replaceAll('/', '-')), 'Worktree directory');
    const target = await confinedDestination(home, directory);
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repository).then(() => true, () => false);
    await runGit(exists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target], repository);
    console.log(`Created worktree ${target} for ${branch}.`);
    return;
  }
  if (action === 'push') {
    if (!flag(args, 'yes')) throw new Error('Git push changes a remote and requires --yes.');
    const remote = stringOption(args, 'remote') ?? 'origin';
    const branch = stringOption(args, 'branch') ?? (await runGit(['branch', '--show-current'], repository)).trim();
    if (!branch) throw new Error('Detached HEAD requires --branch.');
    await runGit(['push', '--', remote, branch], repository);
    console.log(`Pushed ${branch} to ${remote} using host-side credentials; no credential was stored in the computer.`);
    return;
  }
  throw new Error('Git action must be clone, import, status, diff, patch, worktree, or push.');
}
