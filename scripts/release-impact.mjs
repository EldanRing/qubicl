#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

const artifactOrder = ['source', 'npm', 'native', 'gateway-image', 'dashboard-image', 'file-system-image', 'browser-image', 'computer-image', 'workstation-image'];
const checkOrder = ['docs-contracts', 'types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native', 'image-contracts', 'image-scans', 'client-conformance', 'platform-conformance', 'mobile-conformance'];

export function classifyReleaseImpact(files) {
  const normalized = [...new Set(files.map((file) => file.replaceAll('\\', '/').replace(/^\.\//u, '')).filter(Boolean))].sort();
  const artifacts = new Set(['source']);
  const checks = new Set(['docs-contracts']);
  const protocols = new Set();
  const platforms = new Set();
  const reasons = [];
  let profile = 'documentation';
  const raise = (next) => { const levels = ['documentation', 'npm-presentation', 'cli', 'runtime-component', 'full']; if (levels.indexOf(next) > levels.indexOf(profile)) profile = next; };
  const addComputerImages = () => ['file-system-image', 'browser-image', 'computer-image', 'workstation-image'].forEach((name) => artifacts.add(name));

  for (const file of normalized) {
    if (/^(package-lock\.json|package\.json|scripts\/(?:build|candidate|release|publish|sign|acceptance|artifact|bundle|oci|generate-image-catalog)|security\/)/u.test(file)) {
      raise('full'); artifacts.add('npm'); artifacts.add('native'); artifacts.add('gateway-image'); artifacts.add('dashboard-image'); addComputerImages();
      ['types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native', 'image-contracts', 'image-scans', 'client-conformance', 'platform-conformance'].forEach((name) => checks.add(name));
      reasons.push({ file, boundary: 'release-graph-or-shared-dependency' });
      continue;
    }
    if (/^(README\.md|packages\/cli\/README\.md|CHANGELOG\.md|SUPPORT\.md|docs\/|release-notes\/|\.github\/)/u.test(file)) {
      if (file === 'packages/cli/README.md') { raise('npm-presentation'); artifacts.add('npm'); checks.add('artifact-npm'); }
      reasons.push({ file, boundary: file === 'packages/cli/README.md' ? 'npm-presentation' : 'documentation' });
      continue;
    }
    if (file.startsWith('packages/dashboard/')) {
      raise('runtime-component'); artifacts.add('npm'); artifacts.add('native'); artifacts.add('dashboard-image');
      ['types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native', 'image-contracts', 'client-conformance'].forEach((name) => checks.add(name));
      protocols.add('dashboard'); reasons.push({ file, boundary: 'dashboard' }); continue;
    }
    if (file.startsWith('packages/gateway/') || file.startsWith('images/gateway/')) {
      raise('runtime-component'); artifacts.add('npm'); artifacts.add('native'); artifacts.add('gateway-image');
      ['types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native', 'image-contracts', 'image-scans', 'client-conformance'].forEach((name) => checks.add(name));
      ['mcp-http', 'openapi', 'open-terminal'].forEach((name) => protocols.add(name)); reasons.push({ file, boundary: 'gateway' }); continue;
    }
    if (file.startsWith('packages/control/') || file.startsWith('images/computer/') || file.startsWith('skills/')) {
      raise('runtime-component'); artifacts.add('npm'); artifacts.add('native'); addComputerImages();
      ['types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native', 'image-contracts', 'image-scans', 'client-conformance'].forEach((name) => checks.add(name));
      ['mcp-stdio', 'mcp-http', 'openapi', 'open-terminal'].forEach((name) => protocols.add(name)); reasons.push({ file, boundary: 'computer-runtime' }); continue;
    }
    if (file.startsWith('packages/core/')) {
      raise('full'); artifacts.add('npm'); artifacts.add('native'); artifacts.add('gateway-image'); artifacts.add('dashboard-image'); addComputerImages();
      ['types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native', 'image-contracts', 'image-scans', 'client-conformance', 'platform-conformance'].forEach((name) => checks.add(name));
      ['mcp-stdio', 'mcp-http', 'openapi', 'open-terminal', 'dashboard'].forEach((name) => protocols.add(name)); reasons.push({ file, boundary: 'shared-contract' }); continue;
    }
    if (file.startsWith('packages/cli/')) {
      raise('cli'); artifacts.add('npm'); artifacts.add('native');
      ['types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native'].forEach((name) => checks.add(name));
      if (/client-config|mcp|openapi|open-terminal/u.test(file)) ['mcp-stdio', 'mcp-http', 'openapi', 'open-terminal'].forEach((name) => protocols.add(name));
      reasons.push({ file, boundary: 'host-cli' }); continue;
    }
    if (file.startsWith('tests/')) { checks.add('unit'); reasons.push({ file, boundary: 'test-only' }); continue; }
    raise('full'); artifacts.add('npm'); artifacts.add('native'); artifacts.add('gateway-image'); artifacts.add('dashboard-image'); addComputerImages();
    ['types', 'lint', 'unit', 'focused-integration', 'artifact-npm', 'artifact-native', 'image-contracts', 'image-scans', 'client-conformance', 'platform-conformance'].forEach((name) => checks.add(name));
    reasons.push({ file, boundary: 'unclassified-fail-closed' });
  }
  if (protocols.has('dashboard')) checks.add('mobile-conformance');
  if (checks.has('platform-conformance')) ['linux-x64', 'linux-arm64', 'darwin-arm64', 'wsl-x64'].forEach((name) => platforms.add(name));
  return {
    schemaVersion: 1,
    profile,
    changedFiles: normalized,
    affectedArtifacts: artifactOrder.filter((name) => artifacts.has(name)),
    requiredChecks: checkOrder.filter((name) => checks.has(name)),
    affectedProtocols: [...protocols].sort(),
    affectedPlatforms: [...platforms].sort(),
    evidenceReuse: {
      allowed: profile !== 'full',
      rule: 'Reuse only evidence whose source inputs, artifact SHA-256, dependency lock, tool version, platform identity, and external trust/advisory freshness are unchanged.',
      missingCoverageIsPass: false,
    },
    reasons,
  };
}

export function validateReleaseImpact(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !Array.isArray(value.changedFiles)) throw new Error('Release impact document is invalid.');
  const expected = classifyReleaseImpact(value.changedFiles);
  for (const field of ['profile', 'affectedArtifacts', 'requiredChecks', 'affectedProtocols', 'affectedPlatforms']) {
    if (JSON.stringify(value[field]) !== JSON.stringify(expected[field])) throw new Error(`Release impact ${field} understates or differs from the fail-closed classifier.`);
  }
  if (value.evidenceReuse?.missingCoverageIsPass !== false) throw new Error('Release impact must state that missing coverage is not a pass.');
  return value;
}

export function requiresReleaseImpact(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(`${version}`);
  if (!match) throw new Error(`Release version ${version ?? 'unknown'} is not valid Semantic Versioning.`);
  return Number(match[1]) > 0 || Number(match[2]) >= 6;
}

export async function verifyReleaseImpactDocument(path, { revision, repositoryRoot = root } = {}) {
  const document = validateReleaseImpact(JSON.parse(await readFile(resolve(path), 'utf8')));
  if (!revision || !/^[a-f0-9]{40}$/u.test(revision)) throw new Error('Release impact verification requires the exact candidate revision.');
  if (!/^[a-f0-9]{40}$/u.test(document.baseRevision ?? '') || document.revision !== revision) throw new Error('Release impact does not bind exact base and candidate revisions.');
  try { await exec('git', ['merge-base', '--is-ancestor', document.baseRevision, revision], { cwd: repositoryRoot }); }
  catch { throw new Error('Release impact base is not an ancestor of the candidate revision.'); }
  const changedFiles = (await exec('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', document.baseRevision, revision, '--'], { cwd: repositoryRoot, maxBuffer: 10_000_000 })).stdout.split(/\r?\n/u).filter(Boolean).sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify(document.changedFiles)) throw new Error('Release impact changed files do not match the exact Git revision range.');
  return document;
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/release-impact.mjs --base REV [--output FILE]\n       node scripts/release-impact.mjs --files FILE.json [--output FILE]\n\nClassify changed source into exact artifacts, checks, protocols, and platforms. Unknown paths fail closed to a full release.');
    return;
  }
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const fileInput = option('--files');
  const baseInput = option('--base');
  if (!baseInput && !fileInput) throw new Error('--base REV is required so release impact cannot silently describe an empty HEAD-to-HEAD range.');
  const revision = await exec('git', ['rev-parse', 'HEAD'], { cwd: root }).then(({ stdout }) => stdout.trim());
  const base = baseInput ? await exec('git', ['rev-parse', `${baseInput}^{commit}`], { cwd: root }).then(({ stdout }) => stdout.trim()) : undefined;
  const files = fileInput
    ? JSON.parse(await readFile(resolve(fileInput), 'utf8'))
    : (await exec('git', ['diff', '--name-only', '--diff-filter=ACMRTUXB', base, revision, '--'], { cwd: root, maxBuffer: 10_000_000 })).stdout.split(/\r?\n/u).filter(Boolean);
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) throw new Error('--files must name a JSON array of repository-relative paths.');
  const plan = classifyReleaseImpact(files);
  const document = { ...plan, generatedAt: new Date().toISOString(), ...(base ? { baseRevision: base } : {}), revision };
  validateReleaseImpact(document);
  const output = option('--output');
  if (output) await writeFile(resolve(output), `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  else console.log(JSON.stringify(document, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main(process.argv.slice(2));
