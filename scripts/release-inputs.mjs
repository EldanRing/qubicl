import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const RELEASE_IMAGES = ['gateway', 'dashboard', 'file-system', 'browser', 'computer', 'workstation'];
export const IMAGE_INPUTS_NAME = 'image-inputs.json';
const computers = RELEASE_IMAGES.slice(2);

// This is a build-input map, separate from the release-wide acceptance map.
// Unknown paths deliberately affect every image. Keep build helpers here even
// when changing them might produce identical output: equivalence is not assumed.
export function imageInputsForPath(path) {
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

export async function imageInputIdentities(root, revision) {
  assert(/^[a-f0-9]{40}$/u.test(revision), 'Image inputs require an exact Git commit.');
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
    version: workspace.version,
    type: workspace.type,
    license: workspace.license,
    repository: workspace.repository,
    packageManager: workspace.packageManager,
    workspaces: workspace.workspaces,
    engines: workspace.engines,
    devEngines: workspace.devEngines,
    dependencies: workspace.dependencies,
    devDependencies: workspace.devDependencies,
    optionalDependencies: workspace.optionalDependencies,
    peerDependencies: workspace.peerDependencies,
    overrides: workspace.overrides,
    imageBuildScripts: Object.fromEntries(['build', 'build:types', 'images:build']
      .filter((name) => workspace.scripts?.[name] !== undefined)
      .map((name) => [name, workspace.scripts[name]])),
  });
  return Object.fromEntries(RELEASE_IMAGES.map((image) => [image, createHash('sha256')
    .update(`package.json\0${semanticWorkspace}\0`)
    .update(entries.filter(({ path }) => imageInputsForPath(path).includes(image)).map(({ entry }) => entry).join('\0'))
    .digest('hex')]));
}

export async function verifyImageInputs(document, candidate, root) {
  assert(document?.schemaVersion === 1 && document.revision === candidate.revision && document.version === candidate.version,
    'Image input evidence does not bind the candidate.');
  assert(JSON.stringify(Object.keys(document.images ?? {}).sort()) === JSON.stringify([...RELEASE_IMAGES].sort()),
    'Image input evidence requires exactly six images.');
  const current = await imageInputIdentities(root, candidate.revision);
  const origins = new Map([[candidate.revision, current]]);
  for (const name of RELEASE_IMAGES) {
    const entry = document.images[name];
    assert(entry?.version === candidate.version && /^[a-f0-9]{40}$/u.test(entry?.revision ?? ''),
      `${name} image reuse requires the same release version and an exact source commit.`);
    assert(/^[a-f0-9]{64}$/u.test(entry?.inputSha256 ?? '') && entry.inputSha256 === current[name],
      `${name} image build inputs changed.`);
    assert(typeof entry.node === 'string' && typeof entry.npm === 'string' && typeof entry.docker === 'string' && typeof entry.buildx === 'string',
      `${name} image lacks its original build toolchain.`);
    if (!origins.has(entry.revision)) {
      await exec('git', ['merge-base', '--is-ancestor', entry.revision, candidate.revision], { cwd: root });
      const workspace = JSON.parse((await exec('git', ['show', `${entry.revision}:package.json`], { cwd: root })).stdout);
      assert(workspace.version === entry.version, `${name} image origin has a different release version.`);
      origins.set(entry.revision, await imageInputIdentities(root, entry.revision));
    }
    assert(origins.get(entry.revision)[name] === entry.inputSha256, `${name} image origin does not reproduce its build-input identity.`);
  }
  return document;
}

export function selectImageActions({ current, previous, version, revision, tools, scansFresh }) {
  const images = {};
  for (const name of RELEASE_IMAGES) {
    const old = previous?.images?.[name];
    const reusable = old?.version === version && old.inputSha256 === current[name];
    images[name] = {
      action: reusable ? 'reuse' : 'build',
      scan: reusable && scansFresh ? 'reuse' : 'scan',
      reason: reusable ? 'unchanged versioned image inputs' : 'new or changed versioned image inputs',
      origin: reusable ? old : { version, revision, inputSha256: current[name], ...tools },
    };
  }
  return images;
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
