#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.md'], { cwd: root, maxBuffer: 10_000_000 });
const files = [...new Set(stdout.split(/\r?\n/u).filter(Boolean))].sort();
const documents = new Map(await Promise.all(files.map(async (name) => [name, await readFile(resolve(root, name), 'utf8')])));
const errors = [];
let localLinks = 0;
let headingLinks = 0;

for (const [name, contents] of documents) {
  for (const match of contents.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*)?\)/gu)) {
    let target = match[1];
    let repositoryRootRelative = false;
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (/^(?:https?:|mailto:|data:)/iu.test(target)) {
      const prefix = 'https://github.com/EldanRing/qubicl/blob/main/';
      if (!target.startsWith(prefix)) continue;
      target = target.slice(prefix.length);
      repositoryRootRelative = true;
    }
    const [pathPart, fragment] = target.split('#', 2);
    const decoded = decodeURIComponent(pathPart || '');
    const targetPath = decoded
      ? resolve(decoded.startsWith('/') || repositoryRootRelative ? root : dirname(resolve(root, name)), decoded.replace(/^\//u, ''))
      : resolve(root, name);
    if (relative(root, targetPath).startsWith('..')) {
      errors.push(`${name}: local link escapes the repository: ${target}`);
      continue;
    }
    try { await stat(targetPath); }
    catch { errors.push(`${name}: missing local link target ${target}`); continue; }
    localLinks += 1;
    if (fragment && targetPath.endsWith('.md')) {
      const targetName = relative(root, targetPath);
      const targetContents = documents.get(targetName) ?? await readFile(targetPath, 'utf8');
      const slugs = headingSlugs(targetContents);
      if (!slugs.has(decodeURIComponent(fragment).toLowerCase())) errors.push(`${name}: missing heading #${fragment} in ${targetName}`);
      headingLinks += 1;
    }
  }
}

const commandSource = await readFile(resolve(root, 'packages/cli/src/commands.ts'), 'utf8');
const rules = /const invocationRules:[\s\S]*?= \{([\s\S]*?)\n\};/u.exec(commandSource)?.[1] ?? '';
const commands = new Set([...rules.matchAll(/^\s{2}([a-z][a-z-]*): \{/gmu)].map((match) => match[1]));
for (const [name, contents] of documents) {
  if (name === 'CHANGELOG.md' || name.startsWith('release-notes/')) continue;
  for (const match of contents.matchAll(/`qubicl\s+([a-z][a-z-]*)\b[^`]*`|^\s*(?:\$\s*)?qubicl\s+([a-z][a-z-]*)\b/gmu)) {
    const command = match[1] ?? match[2];
    if (!commands.has(command)) errors.push(`${name}: documented command qubicl ${command} has no invocation rule`);
  }
}

for (const name of ['README.md', 'packages/cli/README.md']) {
  const text = documents.get(name)?.toLowerCase() ?? '';
  for (const claim of ['named client credential', 'interactive terminal', 'retained task', 'installation export']) {
    if (!text.includes(claim)) errors.push(`${name}: missing 0.6 product claim containing ${JSON.stringify(claim)}`);
  }
}

const currentDocs = [...documents].filter(([name]) => !name.startsWith('release-notes/') && name !== 'CHANGELOG.md' && !name.startsWith('docs/decisions/'));
const staleClaims = [
  ['non-PTY managed process', 'the current terminal documentation still declares PTY unavailable'],
  ['encrypted backups remain CLI-only', 'the dashboard guide still excludes encrypted backup operations'],
  ['reload requires login', 'the dashboard guide still claims same-tab refresh loses login'],
  ['accepted and in implementation', 'the public product status still calls the implemented 0.6 design pending'],
];
for (const [needle, message] of staleClaims) {
  for (const [name, contents] of currentDocs) if (contents.toLowerCase().includes(needle.toLowerCase())) errors.push(`${name}: ${message}`);
}

if (errors.length) throw new Error(`Documentation contract check failed:\n- ${errors.join('\n- ')}`);
console.log(JSON.stringify({ ok: true, markdownFiles: files.length, localLinks, headingLinks, documentedCommands: commands.size }, null, 2));

function headingSlugs(contents) {
  const counts = new Map();
  const result = new Set();
  for (const match of contents.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
    const base = match[1].trim().toLowerCase().replace(/[`*_~]/gu, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/gu, '-').replace(/-+/gu, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  return result;
}
