#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const allowedEmailDomains = new Set([
  'example.invalid',
  'example.test',
  'example.com',
  'example.org',
  'example.net',
  'users.noreply.github.com',
  'qubicl.local',
  'qubicl.org',
]);
const binaryExtensions = new Set([
  '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.otf', '.pdf', '.png', '.tar',
  '.ttf', '.wasm', '.webp', '.woff', '.woff2', '.zip',
]);

export function scanPublicText(path, contents) {
  const findings = scanPublicEmails(path, contents);
  for (const pattern of [
    { expression: /\/home\/(?!qubicl(?:\/|\b)|user(?:\/|\b)|builder(?:\/|\b)|test(?:\/|\b)|someone-else(?:\/|\b))[A-Za-z0-9._-]+/gu, label: 'host user path' },
    { expression: /\/Users\/(?!user(?:\/|\b)|builder(?:\/|\b))[A-Za-z0-9._-]+/gu, label: 'macOS user path' },
    { expression: /\b[A-Za-z0-9._-]+-pc(?:-ubuntu)?\b/giu, label: 'private hostname' },
    { expression: /\.codex\/attachments\//gu, label: 'private attachment path' },
  ]) {
    for (const match of contents.matchAll(pattern.expression)) findings.push(`${path}: ${pattern.label} ${match[0]}`);
  }
  return findings;
}

export function scanPublicEmails(path, contents) {
  const findings = [];
  const emailPattern = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/giu;
  for (const match of contents.matchAll(emailPattern)) {
    const domain = match[1].toLowerCase();
    if (!allowedEmailDomains.has(domain) && !domain.endsWith('.invalid') && !domain.endsWith('.test')) {
      findings.push(`${path}: personal email-like value ${match[0]}`);
    }
  }
  return findings;
}

export async function checkPublicSource({ allowDirty = false } = {}) {
  const status = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout.trim();
  if (!allowDirty && status) throw new Error('Public-source preflight requires a clean Git worktree.');
  const tracked = (await exec('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer', maxBuffer: 50_000_000 })).stdout
    .toString('utf8').split('\0').filter(Boolean);
  const untracked = allowDirty
    ? (await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer', maxBuffer: 50_000_000 })).stdout.toString('utf8').split('\0').filter(Boolean)
    : [];
  const sourceFiles = [...new Set([...tracked, ...untracked])].sort();
  const firstParty = sourceFiles.filter((path) => !path.startsWith('third_party/'));
  const historyIdentities = (await exec('git', [
    'log', '--format=%H%x09%an%x09%ae%x09%cn%x09%ce', '--all',
  ], { cwd: root, maxBuffer: 10_000_000 })).stdout;
  const findings = scanPublicEmails('reachable Git identity', historyIdentities);
  for (const path of firstParty) {
    let contents;
    try {
      contents = await readFile(resolve(root, path));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    findings.push(...(binaryExtensions.has(extname(path).toLowerCase())
      ? scanPublicEmails(path, contents.toString('latin1'))
      : scanPublicText(path, contents.toString('utf8'))));
  }
  const workflows = sourceFiles.filter((path) => path.startsWith('.github/workflows/'));
  if (workflows.length > 0) findings.push(`Hosted workflow files are not allowed: ${workflows.join(', ')}`);
  const cli = JSON.parse(await readFile(resolve(root, 'packages/cli/package.json'), 'utf8'));
  if (typeof cli.author !== 'string' || cli.author.includes('@')) findings.push('packages/cli/package.json: author must not contain a personal email address.');
  if (findings.length > 0) throw new Error(`Public-source privacy check failed:\n- ${findings.join('\n- ')}`);
  return { files: sourceFiles.length, firstPartyFiles: firstParty.length, clean: status.length === 0 };
}

async function exportPublicSource(destination) {
  const checked = await checkPublicSource();
  const target = resolve(destination);
  if (!isAbsolute(target) || target === root || relative(root, target).split(sep)[0] !== '..') {
    throw new Error('Export destination must be an absolute path outside the repository.');
  }
  await stat(target).then(
    () => { throw new Error(`Export destination already exists: ${target}`); },
    (error) => { if (error?.code !== 'ENOENT') throw error; },
  );
  await mkdir(target, { recursive: true, mode: 0o755 });
  await archiveTo(target);
  return { ...checked, destination: target };
}

function archiveTo(destination) {
  return new Promise((resolvePromise, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('tar', ['-x', '-C', destination], { cwd: root, stdio: [archive.stdout, 'ignore', 'pipe'] });
    let archiveError = '';
    let extractError = '';
    archive.stderr.on('data', (chunk) => { archiveError += chunk; });
    extract.stderr.on('data', (chunk) => { extractError += chunk; });
    let archiveCode;
    let extractCode;
    const finish = () => {
      if (archiveCode === undefined || extractCode === undefined) return;
      if (archiveCode !== 0 || extractCode !== 0) reject(new Error(`Public export failed: git archive=${archiveCode} ${archiveError.trim()} tar=${extractCode} ${extractError.trim()}`));
      else resolvePromise();
    };
    archive.once('error', reject);
    extract.once('error', reject);
    archive.once('exit', (code) => { archiveCode = code; finish(); });
    extract.once('exit', (code) => { extractCode = code; finish(); });
  });
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === '--help' || !command) {
    console.log(`Usage:
  node scripts/public-source.mjs check [--allow-dirty]
  node scripts/public-source.mjs export --destination /absolute/path

Check the tracked public snapshot for first-party personal data and prohibited
hosted workflows. Export copies only the committed tree and never includes Git
history, ignored files, local state, candidates, or build output.`);
    return;
  }
  if (command === 'check') {
    const unknown = rest.filter((value) => value !== '--allow-dirty');
    if (unknown.length > 0) throw new Error(`Unknown option ${unknown[0]}.`);
    console.log(JSON.stringify({ ok: true, ...(await checkPublicSource({ allowDirty: rest.includes('--allow-dirty') })) }, null, 2));
    return;
  }
  if (command === 'export') {
    const index = rest.indexOf('--destination');
    const destination = index >= 0 ? rest[index + 1] : undefined;
    if (!destination || rest.length !== 2) throw new Error('export requires exactly --destination /absolute/path.');
    const result = await exportPublicSource(destination);
    console.log(JSON.stringify({
      ok: true,
      ...result,
      next: [
        `cd ${result.destination}`,
        'git init --initial-branch=main',
        'git -c user.name="Qubicl Maintainers" -c user.email="contact@qubicl.org" add .',
        'git -c user.name="Qubicl Maintainers" -c user.email="contact@qubicl.org" commit -m "Initial public release"',
      ],
    }, null, 2));
    return;
  }
  throw new Error(`Unknown command ${command}.`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main(process.argv.slice(2));
