import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeTargets = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
]);
const identifier = '[0-9A-Za-z-]+';
const semanticVersion = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)'
  + '(?:-' + identifier + '(?:\\.' + identifier + ')*)?'
  + '(?:\\+' + identifier + '(?:\\.' + identifier + ')*)?';
const revision = '[a-f0-9]{7,40}';
const candidatePattern = new RegExp('^' + semanticVersion + '-' + revision + '$');
const stagingPattern = new RegExp(
  '^\\.' + semanticVersion + '-' + revision
  + '-(?:linux|darwin)-(?:x64|arm64)\\.[1-9][0-9]*\\.tmp$',
);
const failedPattern = new RegExp(
  '^\\.failed-' + semanticVersion + '-' + revision
  + '-(?:linux|darwin)-(?:x64|arm64)\\.[1-9][0-9]*$',
);
const packagePattern = /^qubicl-[0-9A-Za-z][0-9A-Za-z._-]*\.tgz$/;
const sbomPattern = /^qubicl(?:-[0-9A-Za-z][0-9A-Za-z._-]*)?\.spdx\.json$/;

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('clean:artifacts: ' + message);
  process.exitCode = 1;
});

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.confirm && options.targets.length === 0) {
    throw new Error('--confirm requires at least one explicit repo-relative target path.');
  }

  const requested = options.targets.length > 0
    ? options.targets.map(normalizeTarget)
    : await discoverTargets();
  assertUnique(requested);
  assertNonOverlapping(requested);

  await validateAll(requested);
  if (!options.confirm) {
    printResult('dry-run', requested);
    return;
  }

  // Validate the complete set again before the first mutation, then each path
  // immediately before removing it to narrow filesystem race opportunities.
  await validateAll(requested);
  for (const target of requested) {
    const validated = await validateTarget(target);
    await rm(validated.absolute, {
      recursive: validated.kind === 'directory',
      force: false,
    });
  }
  printResult('deleted', requested);
}

function parseOptions(args) {
  const options = { confirm: false, help: false, targets: [] };
  for (const argument of args) {
    if (argument === '--confirm') {
      if (options.confirm) throw new Error('--confirm may be specified only once.');
      options.confirm = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument.startsWith('-')) {
      throw new Error('Unknown option ' + argument + '.');
    } else {
      options.targets.push(argument);
    }
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/clean-artifacts.mjs [--confirm] [TARGET ...]',
    '',
    'List retained candidate, package, SBOM, and native artifacts by default.',
    'Explicit targets without --confirm are also a non-mutating dry run.',
    '',
    'Deletion requires --confirm and one or more explicit repo-relative targets.',
    'Only ignored, untracked artifact shapes are eligible. Ordinary clean/dist',
    'output is intentionally outside this command.',
  ].join('\n'));
}

function printResult(mode, targets) {
  console.log(JSON.stringify({ mode, targets }, null, 2));
}

async function discoverTargets() {
  const targets = [];
  for (const entry of await entries(root)) {
    if (packagePattern.test(entry.name) || sbomPattern.test(entry.name)) {
      targets.push(entry.name);
    }
  }

  for (const target of nativeTargets) {
    const artifact = 'release/qubicl-' + target;
    if (await exists(artifact)) targets.push(artifact);
  }

  for (const entry of await entries(resolve(root, 'release', 'candidates'))) {
    if (candidatePattern.test(entry.name) || stagingPattern.test(entry.name) || failedPattern.test(entry.name)) {
      targets.push('release/candidates/' + entry.name);
    }
  }
  return targets.sort();
}

async function entries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
}

async function exists(target) {
  try {
    await lstat(resolve(root, ...target.split('/')));
    return true;
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function normalizeTarget(target) {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Artifact targets must be non-empty repo-relative paths.');
  }
  if (target.includes('\\') || target.startsWith('/') || isAbsolute(target)) {
    throw new Error('Artifact targets must use repo-relative paths with forward slashes: ' + target);
  }
  const components = target.split('/');
  if (
    components.some((component) => component === '' || component === '.' || component === '..')
    || components.join('/') !== target
  ) {
    throw new Error('Artifact target is not a canonical repo-relative path: ' + target);
  }
  return target;
}

function classifyTarget(target) {
  const components = target.split('/');
  if (components.length === 1) {
    if (packagePattern.test(target) || sbomPattern.test(target)) return 'file';
    return undefined;
  }
  if (components[0] !== 'release') return undefined;
  if (
    components.length === 2
    && components[1].startsWith('qubicl-')
    && nativeTargets.has(components[1].slice('qubicl-'.length))
  ) {
    return 'directory';
  }
  if (components[1] !== 'candidates') return undefined;
  if (
    components.length === 3
    && (candidatePattern.test(components[2]) || stagingPattern.test(components[2]))
  ) {
    return 'directory';
  }
  if (
    components.length === 4
    && candidatePattern.test(components[2])
    && nativeTargets.has(components[3])
  ) {
    return 'directory';
  }
  return undefined;
}

function assertUnique(targets) {
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target)) throw new Error('Duplicate artifact target: ' + target);
    seen.add(target);
  }
}

function assertNonOverlapping(targets) {
  const ordered = [...targets].sort();
  for (let outer = 0; outer < ordered.length; outer += 1) {
    for (let inner = outer + 1; inner < ordered.length; inner += 1) {
      if (ordered[inner].startsWith(ordered[outer] + '/')) {
        throw new Error(
          'Artifact targets must not overlap: '
          + ordered[outer] + ' and ' + ordered[inner],
        );
      }
    }
  }
}

async function validateAll(targets) {
  return Promise.all(targets.map(validateTarget));
}

async function validateTarget(target) {
  const normalized = normalizeTarget(target);
  const kind = classifyTarget(normalized);
  if (!kind) {
    throw new Error('Target is not an allowlisted candidate, package, SBOM, or native artifact: ' + normalized);
  }

  const lexical = resolve(root, ...normalized.split('/'));
  assertContained(root, lexical, normalized);
  const inspected = await inspectPath(normalized);
  if (
    (kind === 'directory' && !inspected.stats.isDirectory())
    || (kind === 'file' && !inspected.stats.isFile())
  ) {
    throw new Error('Artifact target has the wrong filesystem type: ' + normalized);
  }

  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(inspected.absolute);
  assertContained(canonicalRoot, canonicalTarget, normalized);

  const tracked = await exec('git', ['ls-files', '--', normalized], { cwd: root });
  if (tracked.stdout.trim().length > 0) {
    throw new Error('Artifact target contains tracked repository content: ' + normalized);
  }
  if (!(await isIgnored(normalized))) {
    throw new Error('Artifact target is not ignored by Git: ' + normalized);
  }
  return { absolute: inspected.absolute, kind };
}

async function inspectPath(target) {
  let current = root;
  let stats;
  for (const component of target.split('/')) {
    current = resolve(current, component);
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        throw new Error('Artifact target does not exist: ' + target);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error('Artifact targets may not contain symlink path components: ' + target);
    }
  }
  return { absolute: current, stats };
}

function assertContained(parent, child, target) {
  const displacement = relative(parent, child);
  if (
    displacement === ''
    || displacement === '..'
    || displacement.startsWith('..' + sep)
    || isAbsolute(displacement)
  ) {
    throw new Error('Artifact target resolves outside the repository: ' + target);
  }
}

async function isIgnored(target) {
  try {
    await exec('git', ['check-ignore', '--quiet', '--', target], { cwd: root });
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 1) return false;
    throw error;
  }
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === 'object' && error.code === code);
}
