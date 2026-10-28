import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posix } from 'node:path';

const exec = promisify(execFile);
export const RELEASE_IMAGES = ['gateway', 'dashboard', 'file-system', 'browser', 'computer', 'workstation'];
export const IMAGE_INPUTS_NAME = 'image-inputs.json';
const computers = RELEASE_IMAGES.slice(2);
const workspaceNames = new Set(['@qubicl/core', '@qubicl/control', '@qubicl/gateway', '@qubicl/dashboard', '@qubicl/cli']);

// This is a build-input map, separate from the release-wide acceptance map.
// Unknown paths deliberately affect every image. Keep build helpers here even
// when changing them might produce identical output: equivalence is not assumed.
export function imageInputsForPath(path, schemaVersion = 1) {
  if (schemaVersion >= 2) {
    if (path === 'images/computer/libreoffice-registrymodifications.xcu') return ['workstation'];
    if (/^images\/computer\/(?:skills-requirements\.txt|SKILLS_THIRD_PARTY_NOTICES\.txt)$/u.test(path)) return ['computer', 'workstation'];
    if (/^images\/computer\/(?:browser-skills-requirements\.txt|BROWSER_SKILLS_THIRD_PARTY_NOTICES\.txt|chromium-wrapper\.sh|qubicl_viewer_auth\.py|x11vnc-relay\.sh)$/u.test(path)) return computers.slice(1);
  }
  if (/^(?:packages\/core\/|package-lock\.json$|tsconfig[^/]*\.json$|LICENSE$)/u.test(path)) return RELEASE_IMAGES;
  if (path === 'package.json') return [];
  if (/^(?:packages\/gateway\/|images\/gateway\/)/u.test(path)) return ['gateway'];
  if (/^(?:packages\/dashboard\/|images\/dashboard\/)/u.test(path)) return ['dashboard'];
  if (/^(?:packages\/control\/|images\/computer\/|skills\/)/u.test(path)) return computers;
  if (path.startsWith('packages/cli/assets/')) return computers;
  if (path.startsWith('packages/cli/')) return [];
  if (path === 'scripts/build-local-candidates.mjs') return [];
  if (/^scripts\/(?:build(?:-|\.)|bundle-evidence|licenses|verify-skill-catalog)/u.test(path)) return RELEASE_IMAGES;
  if (/^(?:tests\/|docs\/|release-notes\/|conformance\/|security\/|\.github\/)/u.test(path)
    || /(?:\.md|\.txt)$/u.test(path)
    || /^(?:\.gitignore|\.gitleaks\.toml|\.oxlintrc\.json|PUBLIC_HISTORY_POLICY\.json)$/u.test(path)) return [];
  if (/^scripts\/(?:release-|candidate-|build-local-candidates\.|generate-image-catalog\.|inspect-oci-candidate\.|verify-candidate\.|resume-candidate\.|sign-candidate\.|publish-candidate\.|acceptance-|artifact-evidence\.|evidence-signature\.|oci-|client-conformance\.|platform-support\.|remote-access-conformance\.|test-|performance\.|token-audit\.|docs-contracts\.|public-source\.|scan-secrets\.|reboot-acceptance\.|clean)/u.test(path)) return [];
  return RELEASE_IMAGES;
}

// Diagnostics may use dirty host-only code, but must not pair changed runtime
// inputs with older immutable images. Include staged, unstaged and new files.
export async function uncommittedImageInputs(root) {
  const results = await Promise.all([
    exec('git', ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'], { cwd: root, maxBuffer: 20_000_000 }),
    exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 20_000_000 }),
  ]);
  return [...new Set(results.flatMap(({ stdout }) => stdout.split('\0').filter(Boolean)))]
    .filter((path) => path === 'package.json' || imageInputsForPath(path, 2).length > 0).sort();
}

export async function imageInputIdentities(root, revision, schemaVersion = 1) {
  assert(/^[a-f0-9]{40}$/u.test(revision), 'Image inputs require an exact Git commit.');
  assert([1, 2].includes(schemaVersion), 'Unknown image input schema.');
  const [{ stdout }, { stdout: packageText }] = await Promise.all([
    exec('git', ['ls-tree', '-r', '-z', revision], { cwd: root, maxBuffer: 20_000_000 }),
    exec('git', ['show', `${revision}:package.json`], { cwd: root, maxBuffer: 2_000_000 }),
  ]);
  const entries = stdout.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    assert(tab > 0, 'Invalid Git tree entry.');
    return { entry, path: entry.slice(tab + 1) };
  });
  const workspace = JSON.parse(packageText);
  const semanticWorkspace = canonicalJson({
    name: workspace.name,
    ...(schemaVersion === 1 ? { version: workspace.version } : {}),
    type: workspace.type,
    license: workspace.license,
    repository: workspace.repository,
    packageManager: workspace.packageManager,
    workspaces: workspace.workspaces,
    engines: workspace.engines,
    devEngines: workspace.devEngines,
    dependencies: workspace.dependencies,
    devDependencies: schemaVersion === 1 ? workspace.devDependencies
      : Object.fromEntries(Object.entries(workspace.devDependencies ?? {}).filter(([name]) => ['esbuild', 'typescript'].includes(name))),
    optionalDependencies: workspace.optionalDependencies,
    peerDependencies: workspace.peerDependencies,
    overrides: workspace.overrides,
    imageBuildScripts: Object.fromEntries(['build', 'build:types', 'images:build']
      .filter((name) => workspace.scripts?.[name] !== undefined)
      .map((name) => [name, workspace.scripts[name]])),
  });
  const normalized = new Map();
  if (schemaVersion >= 2) {
    for (const { path } of entries.filter(({ path }) => /^(?:packages\/[^/]+\/package\.json|package-lock\.json)$/u.test(path))) {
      const document = JSON.parse((await exec('git', ['show', `${revision}:${path}`], { cwd: root, maxBuffer: 20_000_000 })).stdout);
      normalized.set(path, document);
    }
  }
  return Object.fromEntries(RELEASE_IMAGES.map((image) => [image, createHash('sha256')
    .update(`package.json\0${semanticWorkspace}\0`)
    .update(entries.filter(({ path }) => imageInputsForPath(path, schemaVersion).includes(image)).map(({ entry, path }) => {
      if (!normalized.has(path)) return entry;
      const value = path === 'package-lock.json' ? imageLockInputs(normalized.get(path), image) : withoutReleaseVersion(normalized.get(path));
      return `${path}\0${canonicalJson(value)}`;
    }).join('\0'))
    .digest('hex')]));
}

export async function verifyImageInputs(document, candidate, root) {
  assert([1, 2].includes(document?.schemaVersion) && document.revision === candidate.revision && document.version === candidate.version,
    'Image input evidence does not bind the candidate.');
  assert(JSON.stringify(Object.keys(document.images ?? {}).sort()) === JSON.stringify([...RELEASE_IMAGES].sort()),
    'Image input evidence requires exactly six images.');
  const current = await imageInputIdentities(root, candidate.revision, document.schemaVersion);
  const origins = new Map([[candidate.revision, current]]);
  const versions = new Map([[candidate.revision, candidate.version]]);
  for (const name of RELEASE_IMAGES) {
    const entry = document.images[name];
    assert(typeof entry?.version === 'string' && (document.schemaVersion >= 2 || entry.version === candidate.version) && /^[a-f0-9]{40}$/u.test(entry?.revision ?? ''),
      `${name} image reuse requires an exact version and source commit.`);
    assert(/^[a-f0-9]{64}$/u.test(entry?.inputSha256 ?? '') && entry.inputSha256 === current[name],
      `${name} image build inputs changed.`);
    assert(typeof entry.node === 'string' && typeof entry.npm === 'string' && typeof entry.docker === 'string' && typeof entry.buildx === 'string',
      `${name} image lacks its original build toolchain.`);
    if (!origins.has(entry.revision)) {
      await exec('git', ['merge-base', '--is-ancestor', entry.revision, candidate.revision], { cwd: root });
      const workspace = JSON.parse((await exec('git', ['show', `${entry.revision}:package.json`], { cwd: root })).stdout);
      versions.set(entry.revision, workspace.version);
      origins.set(entry.revision, await imageInputIdentities(root, entry.revision, document.schemaVersion));
    }
    assert(entry.version === versions.get(entry.revision), `${name} image version differs from its origin.`);
    assert(origins.get(entry.revision)[name] === entry.inputSha256, `${name} image origin does not reproduce its build-input identity.`);
  }
  return document;
}

export function selectImageActions({ current, previous, version, revision, tools, scansFresh }) {
  const images = {};
  for (const name of RELEASE_IMAGES) {
    const old = previous?.images?.[name];
    const reusable = old && (previous.schemaVersion >= 2 || old.version === version) && old.inputSha256 === current[name];
    images[name] = {
      action: reusable ? 'reuse' : 'build',
      scan: reusable && (typeof scansFresh === 'object' ? scansFresh[name] : scansFresh) ? 'reuse' : 'scan',
      reason: reusable ? 'unchanged image inputs; retain original version and provenance' : 'new or changed image inputs',
      origin: reusable ? old : { version, revision, inputSha256: current[name], ...tools },
    };
  }
  return images;
}

// A release version describes the CLI/catalog, not the installed runtime bytes.
// Workspace dependency versions move together and are represented by their
// source inputs. External dependency versions and integrity remain significant.
export function withoutReleaseVersion(value) {
  const result = structuredClone(value);
  delete result.version;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(result[field] ?? {})) if (workspaceNames.has(name)) result[field][name] = 'workspace';
  }
  return result;
}

function imageLockInputs(lock, image) {
  if (!lock.packages) return withoutReleaseVersion(lock);
  const packages = lock.packages;
  const selected = new Map();
  const visit = (path) => {
    if (selected.has(path)) return;
    const item = packages[path];
    assert(item, `Lockfile lacks runtime dependency ${path}.`);
    selected.set(path, path.startsWith('packages/') || path === '' ? withoutReleaseVersion(item) : item);
    if (item.link) { visit(item.resolved); return; }
    for (const name of new Set([...Object.keys(item.dependencies ?? {}), ...Object.keys(item.optionalDependencies ?? {}), ...Object.keys(item.peerDependencies ?? {})])) {
      let directory = path;
      let found;
      while (true) {
        const candidate = posix.join(directory, 'node_modules', name);
        if (packages[candidate]) { found = candidate; break; }
        if (!directory || directory === '.') break;
        directory = posix.dirname(directory);
        if (directory === '.') directory = '';
      }
      if (found) visit(found);
      else assert(item.optionalDependencies?.[name] || item.peerDependencies?.[name], `Lockfile lacks ${name} required by ${path}.`);
    }
  };
  const member = image === 'gateway' || image === 'dashboard' ? image : 'control';
  for (const path of [`packages/${member}`, 'packages/core']) if (packages[path]) visit(path);
  // These tools produce the bundled runtime; test-only tooling is not an image input.
  for (const name of ['esbuild', 'typescript']) if (packages[`node_modules/${name}`]) visit(`node_modules/${name}`);
  return { lockfileVersion: lock.lockfileVersion, packages: Object.fromEntries([...selected].sort(([a], [b]) => a.localeCompare(b))) };
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
