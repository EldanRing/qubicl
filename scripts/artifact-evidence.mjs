import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { spdxPackageKeys } from './bundle-evidence.mjs';

const exec = promisify(execFile);
const SYSTEM_IMAGES = ['gateway', 'file-system', 'browser', 'computer', 'desktop', 'workstation'];
// These two identifiers are intentionally retained for v2 state migration and
// recovery of computers created by pre-release source builds. They are not
// packaged defaults: exact candidate catalog/default references are required
// below, while every other development system-image identifier remains banned.
const LEGACY_DEVELOPMENT_IMAGE_REFERENCES = new Set([
  'qubicl/computer:dev',
  'qubicl/workstation:dev',
]);

export async function inspectReleaseArchive(archive, expectedRoot) {
  const archiveStat = await import('node:fs/promises').then(({ lstat }) => lstat(archive));
  assert(archiveStat.isFile(), `${archive} must be a regular file.`);
  const names = archiveLines((await exec('tar', ['-tzf', archive], { maxBuffer: 30_000_000 })).stdout);
  assert(names.length > 0, `${archive} is empty.`);
  const normalized = names.map((name) => canonicalMemberName(name, expectedRoot));
  assert(new Set(normalized).size === normalized.length, `${basename(archive)} contains duplicate or aliased member paths.`);
  const verbose = archiveLines((await exec('tar', ['-tvzf', archive], { maxBuffer: 30_000_000 })).stdout);
  assert(verbose.length === names.length, `${basename(archive)} has ambiguous archive metadata.`);
  const entries = normalized.map((name, index) => {
    const type = verbose[index][0];
    assert(type === '-' || type === 'd', `${basename(archive)} contains a link or special entry at ${name}.`);
    return { name, type };
  });
  assert(entries.some((entry) => entry.name.startsWith(`${expectedRoot}/`) && entry.type === '-'), `${basename(archive)} has no regular files under ${expectedRoot}/.`);
  return entries;
}

export async function extractReleaseArchive(archive, destination, expectedRoot) {
  const entries = await inspectReleaseArchive(archive, expectedRoot);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(destination, { recursive: true });
  await exec('tar', ['-xzf', archive, '-C', destination], { maxBuffer: 30_000_000 });
  return entries;
}

export async function assertNpmArtifact({
  archive,
  root,
  entries,
  version,
  revision,
  source,
  expectedCatalogText,
  expectedSbomPath,
  expectedManifest,
  expectedReadme,
}) {
  const files = entries.filter((entry) => entry.type === '-' && entry.name.startsWith('package/'))
    .map((entry) => entry.name.slice('package/'.length))
    .sort();
  for (const required of [
    'package.json',
    'dist/qubicl.mjs',
    'dist/LICENSE',
    'dist/THIRD_PARTY_NOTICES.txt',
    'dist/SBOM.spdx.json',
    'dist/assets/image-catalog.json',
    'dist/assets/gateway/Dockerfile',
    'dist/assets/computer/Dockerfile',
  ]) assert(files.includes(required), `Packed npm candidate is missing ${required}.`);
  assert(files.every((path) => ['package.json', 'README.md', 'LICENSE'].includes(path) || path.startsWith('dist/')), 'Packed npm candidate has a file outside its canonical package/dist layout.');
  assert(files.every((path) => !/(^|\/)(?:src|tests?|secrets\.yaml)(?:\/|$)/.test(path)), 'Packed npm candidate contains source, tests, or a secrets file.');

  const manifest = await jsonFile(join(root, 'package.json'));
  assertNpmPublicationManifest(manifest, expectedManifest, { version });
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  assert(typeof expectedReadme === 'string' && expectedReadme.length > 0, 'A reviewed npm README is required.');
  assert(readme === expectedReadme, 'Packed npm README differs from the reviewed source package README.');

  const catalogText = await readFile(join(root, 'dist', 'assets', 'image-catalog.json'), 'utf8');
  assert(catalogText === expectedCatalogText, 'The staged npm archive embeds a different image catalog.');
  const catalog = JSON.parse(catalogText);
  const sbomPath = join(root, 'dist', 'SBOM.spdx.json');
  assert(await readFile(sbomPath, 'utf8') === await readFile(expectedSbomPath, 'utf8'), 'The staged npm archive embeds a different SPDX document.');
  await assertSbomEvidence(sbomPath, join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'), {
    version,
    revision,
    source,
    artifactKind: 'npm-application',
  });
  const cliPath = join(root, 'dist', 'qubicl.mjs');
  await assertCompiledCandidateRefs(cliPath, catalog, { version, revision, artifact: 'npm CLI bundle' });
  let installedCliPath;
  let installTemporary;
  try {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    installTemporary = await mkdtemp(join(tmpdir(), 'qubicl-npm-evidence-'));
    // Deliberately leave lifecycle scripts enabled. The manifest verifier below
    // forbids consumer install hooks, and this smoke test exercises the same npm
    // behavior a user receives rather than hiding an unexpected hook.
    await exec('npm', ['install', '--prefix', installTemporary, '--no-audit', '--no-fund', archive], { maxBuffer: 20_000_000 });
    installedCliPath = join(installTemporary, 'node_modules', '.bin', 'qubicl');
    const output = await exec(installedCliPath, ['--version']);
    assert(output.stdout.trim() === `qubicl ${version} (${revision})`, 'The staged npm CLI version or revision does not match the candidate.');
  } finally {
    if (installTemporary) {
      const { rm } = await import('node:fs/promises');
      await rm(installTemporary, { recursive: true, force: true });
    }
  }
  return { files: files.length, catalog };
}

export function assertNpmPublicationManifest(manifest, expectedManifest, { version }) {
  assert(expectedManifest && typeof expectedManifest === 'object', 'A reviewed source npm manifest is required.');
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Packed npm manifest must be an object.');
  assert(manifest.name === 'qubicl-cli', 'Packed npm package name must be qubicl-cli.');
  assert(manifest.version === version, `Packed npm version ${manifest.version} does not match ${version}.`);
  assert(manifest.bin && Object.keys(manifest.bin).length === 1
    && manifest.bin.qubicl === 'dist/qubicl.mjs', 'Packed npm bin must map only qubicl to dist/qubicl.mjs.');

  const consumerHooks = ['preinstall', 'install', 'postinstall'];
  for (const hook of consumerHooks) {
    assert(manifest.scripts?.[hook] === undefined, `Packed npm manifest may not define consumer lifecycle script ${hook}.`);
  }
  for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    assert(manifest[field] === undefined, `Packed npm manifest may not define ${field}.`);
  }
  assert(manifest.config === undefined, 'Packed npm manifest may not define install configuration.');
  assert(canonicalJson(manifest) === canonicalJson(expectedManifest), 'Packed npm package.json differs from the reviewed source publication manifest.');
}

export async function assertNativeArtifact({
  root,
  entries,
  target,
  version,
  revision,
  source,
  nodeVersion,
  expectedCatalogText,
  expectedSbomPath,
  execute = true,
}) {
  const prefix = `qubicl-${target}/`;
  const files = entries.filter((entry) => entry.type === '-' && entry.name.startsWith(prefix))
    .map((entry) => entry.name.slice(prefix.length))
    .sort();
  for (const required of [
    'qubicl',
    'LICENSE',
    'NODE_LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.txt',
    'SBOM.spdx.json',
    'assets/image-catalog.json',
  ]) assert(files.includes(required), `Native candidate is missing ${required}.`);
  const nativeRoots = new Set(['qubicl', 'LICENSE', 'NODE_LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.txt', 'SBOM.spdx.json']);
  assert(files.every((path) => nativeRoots.has(path) || path.startsWith('assets/')), 'Native candidate has a file outside its canonical executable/evidence/assets layout.');

  const binary = join(root, 'qubicl');
  const binaryStat = await import('node:fs/promises').then(({ stat }) => stat(binary));
  assert(binaryStat.isFile() && (binaryStat.mode & 0o111) !== 0, 'Native qubicl must be a regular executable file.');
  await assertExecutableTarget(binary, target);
  for (const legalFile of ['LICENSE', 'NODE_LICENSE', 'README.md']) {
    const value = await readFile(join(root, legalFile));
    assert(value.length > 0, `Native ${legalFile} must not be empty.`);
  }

  const catalogText = await readFile(join(root, 'assets', 'image-catalog.json'), 'utf8');
  assert(catalogText === expectedCatalogText, 'The staged native archive embeds a different image catalog.');
  const catalog = JSON.parse(catalogText);
  const sbomPath = join(root, 'SBOM.spdx.json');
  assert(await readFile(sbomPath, 'utf8') === await readFile(expectedSbomPath, 'utf8'), 'The staged native archive embeds a different SPDX document.');
  await assertSbomEvidence(sbomPath, join(root, 'THIRD_PARTY_NOTICES.txt'), {
    version,
    revision,
    source,
    artifactKind: `native-${target}`,
    nativeNodeVersion: nodeVersion,
  });
  await assertCompiledCandidateRefs(binary, catalog, { version, revision, artifact: 'native SEA executable' });

  if (execute) {
    assert(currentTarget() === target, `Cannot execute ${target} candidate on ${currentTarget()}.`);
    const output = await exec(binary, ['--version']);
    assert(output.stdout.trim() === `qubicl ${version} (${revision})`, 'The staged native CLI version or revision does not match the candidate.');
  }
  return { files: files.length, catalog };
}

export async function assertSbomEvidence(sbomPath, noticePath, {
  version,
  revision,
  source,
  artifactKind,
  nativeNodeVersion,
}) {
  const document = await jsonFile(sbomPath);
  assert(document.spdxVersion === 'SPDX-2.3', 'Artifact SBOM must use SPDX 2.3.');
  assert(document.name === `qubicl-cli-${version}-${artifactKind}`, 'Artifact SBOM document name does not match its artifact kind.');
  const expectedNamespace = `${normalizeSource(source)}/spdx/qubicl-cli/${encodeURIComponent(version)}/${encodeURIComponent(revision)}/${encodeURIComponent(artifactKind)}`;
  assert(document.documentNamespace === expectedNamespace, 'Artifact SBOM namespace does not bind source, revision, version, and artifact kind.');
  assert(Array.isArray(document.documentDescribes) && document.documentDescribes.length === 1, 'Artifact SBOM must describe exactly one root package.');
  const rootPackage = (document.packages ?? []).find((entry) => entry.SPDXID === document.documentDescribes[0]);
  assert(rootPackage?.name === 'qubicl-cli' && rootPackage.versionInfo === version, 'Artifact SBOM root package name/version is invalid.');

  const noticeKeys = thirdPartyNoticeKeys(await readFile(noticePath, 'utf8'));
  const componentKeys = spdxPackageKeys(document);
  const expected = nativeNodeVersion ? [...noticeKeys, `node@${nativeNodeVersion}`].sort() : noticeKeys;
  assert(equalArrays(componentKeys, expected), 'Artifact SBOM components do not match THIRD_PARTY_NOTICES.txt.');
  assert(componentKeys.some((key) => key.startsWith('@modelcontextprotocol/node@')), 'Artifact SBOM omits @modelcontextprotocol/node.');
  assert(componentKeys.some((key) => key.startsWith('@hono/node-server@')), 'Artifact SBOM omits @hono/node-server.');
  assert(!componentKeys.some((key) => key.startsWith('@modelcontextprotocol/client@')), 'Artifact SBOM includes test-only @modelcontextprotocol/client.');
}

export async function assertCompiledCandidateRefs(path, catalog, { version, revision, artifact }) {
  const contents = await readFile(path);
  const required = new Set([version, revision]);
  for (const preset of Object.values(catalog.presets ?? {})) required.add(preset.manifestSha256);
  for (const image of [catalog.gateway, ...Object.values(catalog.presets ?? {}).map((preset) => preset.image)]) {
    required.add(image.requested);
    required.add(image.indexDigest);
    for (const variant of Object.values(image.platforms ?? {})) {
      required.add(variant.resolved);
      required.add(variant.digest);
    }
  }
  for (const value of required) {
    assert(contents.includes(Buffer.from(value)), `${artifact} does not embed candidate catalog value ${value}.`);
  }
  const text = contents.toString('latin1');
  for (const image of SYSTEM_IMAGES) {
    for (const reference of [`qubicl/${image}:dev`, `qubicl-${image}:dev`]) {
      if (LEGACY_DEVELOPMENT_IMAGE_REFERENCES.has(reference)) continue;
      assert(!text.includes(reference), `${artifact} embeds a development system-image reference for ${image}.`);
    }
  }
}

async function assertExecutableTarget(path, target) {
  const header = (await readFile(path)).subarray(0, 32);
  const [platform, architecture] = target.split('-');
  if (platform === 'linux') {
    assert(header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${path} is not an ELF executable.`);
    assert(header[4] === 2 && header[5] === 1, `${path} must be a little-endian 64-bit ELF executable.`);
    const machines = { x64: 62, arm64: 183 };
    assert(header.readUInt16LE(18) === machines[architecture], `${path} ELF architecture does not match ${target}.`);
    return;
  }
  assert(platform === 'darwin', `Unsupported native target ${target}.`);
  assert(header.readUInt32LE(0) === 0xfeedfacf, `${path} is not a little-endian 64-bit Mach-O executable.`);
  const cpuTypes = { x64: 0x01000007, arm64: 0x0100000c };
  assert(header.readUInt32LE(4) === cpuTypes[architecture], `${path} Mach-O architecture does not match ${target}.`);
}

function canonicalMemberName(raw, expectedRoot) {
  assert(typeof raw === 'string' && raw.length > 0, 'Archive contains an empty member name.');
  assert([...raw].every((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127), `Archive member contains a control character: ${JSON.stringify(raw)}.`);
  assert(!raw.includes('\\') && !raw.startsWith('./') && !raw.includes('//'), `Archive member is not canonical POSIX syntax: ${raw}.`);
  const withoutSlash = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  assert(withoutSlash.length > 0 && !isAbsolute(withoutSlash) && !win32.isAbsolute(withoutSlash), `Archive member is absolute: ${raw}.`);
  const parts = withoutSlash.split('/');
  assert(parts.every((part) => part && part !== '.' && part !== '..'), `Archive member has an unsafe component: ${raw}.`);
  assert(withoutSlash === expectedRoot || withoutSlash.startsWith(`${expectedRoot}/`), `Archive member is outside ${expectedRoot}/: ${raw}.`);
  return withoutSlash;
}

function archiveLines(output) {
  const trimmed = output.trimEnd();
  return trimmed ? trimmed.split('\n') : [];
}

function thirdPartyNoticeKeys(contents) {
  const lines = contents.split(/\r?\n/);
  const keys = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index + 1].startsWith('Declared license:')) keys.push(lines[index]);
  }
  return keys.sort();
}

function currentTarget() {
  return `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
}

function normalizeSource(source) {
  assert(typeof source === 'string' && source.length > 0, 'Artifact source is required.');
  return source.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function equalArrays(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
