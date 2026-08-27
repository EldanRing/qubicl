import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spdxPackageKeys } from './bundle-evidence.mjs';
import { assertCatalogIdentity, normalizeRepository } from './candidate-evidence.mjs';
import {
  assertNativeArtifact,
  assertNpmArtifact,
  extractReleaseArchive,
} from './artifact-evidence.mjs';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const options = parseOptions(process.argv.slice(2));
const allowDirty = process.env.QUBICL_PREFLIGHT_ALLOW_DIRTY === '1';
const temporary = await mkdtemp(join(tmpdir(), 'qubicl-release-preflight-'));

try {
  const workspace = await jsonFile(join(root, 'package.json'));
  assert(workspace.packageManager === 'npm@10.9.3', 'The release npm version must remain pinned.');
  const manifests = await Promise.all((await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => jsonFile(join(root, 'packages', entry.name, 'package.json'))));
  assert(manifests.every(({ version }) => version === workspace.version), 'Every workspace package version must match the root version.');
  const cliManifest = manifests.find(({ name }) => name === 'qubicl-cli');
  assert(cliManifest, 'The qubicl-cli package manifest is missing.');
  assert(typeof cliManifest.author === 'string' && !cliManifest.author.includes('@'), 'The release package author must not contain a personal email address.');
  assert(cliManifest.publishConfig?.access === 'public', 'The release package must use explicit public access.');
  assert(cliManifest.publishConfig?.provenance !== true, 'Hosted npm provenance is incompatible with the local-only release policy.');
  assert(workspace.version.includes('-dev.') ? cliManifest.publishConfig?.tag === 'dev' : cliManifest.publishConfig?.tag === 'latest', 'The npm distribution tag must match the version stability.');
  if (/^0\.[0-9]+\.[0-9]+$/.test(workspace.version)) {
    assert((await stat(join(root, 'release-notes', `v${workspace.version}.md`))).isFile(), `release-notes/v${workspace.version}.md is required for an initial release.`);
  }

  for (const file of [
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
    'SECURITY.md',
    'SUPPORT.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'RELEASING.md',
    'VERIFYING.md',
    'ROADMAP.md',
    'docs/architecture.md',
    'docs/clients.md',
    'docs/custom-images.md',
    'docs/development.md',
    'docs/persistence.md',
    'docs/security-model.md',
    'docs/troubleshooting.md',
    'security/README.md',
    'skills/PROVENANCE.md',
  ]) {
    assert((await stat(join(root, file))).isFile(), `${file} is required.`);
  }

  const status = (await exec('git', ['status', '--porcelain'], { cwd: root })).stdout.trim();
  if (!allowDirty) assert(status === '', 'Release preflight requires a clean Git worktree.');
  const secretScan = await exec('git', ['grep', '-I', '-n', '-E', 'qubicl_[A-Za-z0-9_-]{43,}'], { cwd: root }).then(
    ({ stdout }) => stdout.trim(),
    (error) => error.code === 1 ? '' : Promise.reject(error),
  );
  assert(secretScan === '', `A bearer-token-shaped value appears in tracked source:\n${secretScan}`);

  const source = normalizeRepository(workspace.repository?.url);
  let expectedCatalogText;
  let expectedCatalog;
  if (options.catalog) {
    expectedCatalogText = await readFile(options.catalog, 'utf8');
    expectedCatalog = assertCatalogIdentity(JSON.parse(expectedCatalogText), {
      version: workspace.version,
      revision: options.expectedRevision,
      source: options.expectedSource ?? source,
    });
  }

  const npmArchive = options.npmArchive ?? await packDevelopmentArtifact(temporary);
  let npmResult;
  if (npmArchive) {
    const npmExtract = join(temporary, 'npm-extract');
    const npmEntries = await extractReleaseArchive(npmArchive, npmExtract, 'package');
    const packageRoot = join(npmExtract, 'package');
    const files = npmEntries.filter((entry) => entry.type === '-' && entry.name.startsWith('package/'))
      .map((entry) => entry.name.slice('package/'.length));
    for (const required of [
      'package.json',
      'dist/qubicl.mjs',
      'dist/LICENSE',
      'dist/THIRD_PARTY_NOTICES.txt',
      'dist/SBOM.spdx.json',
      'dist/assets/image-catalog.json',
      'dist/assets/gateway/Dockerfile',
      'dist/assets/computer/Dockerfile',
    ]) {
      assert(files.includes(required), `Packed npm candidate is missing ${required}.`);
    }
    // Reject Qubicl's package-level source/tests and secrets while permitting
    // reviewed skill resources that legitimately contain a nested
    // tests directory under dist/assets/computer/skills.
    assert(files.every((path) => !/^(?:src|tests)(?:\/|$)/.test(path) && !/(^|\/)secrets\.yaml$/.test(path)), 'Packed npm candidate contains Qubicl source/tests or a secrets file.');

    const installRoot = join(temporary, 'install');
    await exec('npm', ['install', '--prefix', installRoot, '--no-audit', '--no-fund', npmArchive], { cwd: root, maxBuffer: 20_000_000 });
    const installedRoot = join(installRoot, 'node_modules', 'qubicl-cli');
    const installedCli = join(installRoot, 'node_modules', '.bin', 'qubicl');
    const help = await exec(installedCli, ['help'], { cwd: temporary });
    assert(help.stdout.includes('private Docker computers'), 'The packed CLI help smoke test failed.');
    const catalogText = await readFile(join(installedRoot, 'dist', 'assets', 'image-catalog.json'), 'utf8');
    const catalog = JSON.parse(catalogText);
    assert(catalog.releaseVersion === workspace.version, 'The packed image catalog version does not match the workspace.');
    if (expectedCatalogText) {
      assert(catalogText === expectedCatalogText, 'The staged npm archive embeds a different image catalog.');
      assertCatalogIdentity(catalog, {
        version: workspace.version,
        revision: options.expectedRevision,
        source: options.expectedSource ?? source,
      });
    }
    const revision = options.expectedRevision ?? catalog.revision;
    const version = await exec(installedCli, ['--version'], { cwd: temporary });
    assert(version.stdout.trim() === `qubicl ${workspace.version} (${revision})`, 'The staged npm CLI version or revision does not match the candidate.');

    const sbomPath = join(installedRoot, 'dist', 'SBOM.spdx.json');
    if (options.npmSbom) assert(await readFile(sbomPath, 'utf8') === await readFile(options.npmSbom, 'utf8'), 'The staged npm archive embeds a different SPDX document.');
    await assertSbomMatchesNotices(sbomPath, join(installedRoot, 'dist', 'THIRD_PARTY_NOTICES.txt'));
    if (options.npmArchive) {
      await assertNpmArtifact({
        archive: npmArchive,
        root: packageRoot,
        entries: npmEntries,
        version: workspace.version,
        revision: options.expectedRevision,
        source: options.expectedSource ?? source,
        expectedCatalogText,
        expectedSbomPath: options.npmSbom,
        expectedManifest: cliManifest,
      });
    }
    npmResult = { files: files.length, catalog: catalog.development ? 'development' : 'exact-release' };
  }

  let nativeResult;
  if (options.nativeArchive || options.requireBinary) {
    const target = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
    let directory;
    let nativeEntries;
    if (options.nativeArchive) {
      const nativeExtract = join(temporary, 'native-extract');
      nativeEntries = await extractReleaseArchive(options.nativeArchive, nativeExtract, `qubicl-${target}`);
      directory = join(nativeExtract, `qubicl-${target}`);
    } else {
      directory = join(root, 'release', `qubicl-${target}`);
    }
    for (const file of ['qubicl', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'NODE_LICENSE', 'SBOM.spdx.json', 'assets/image-catalog.json']) {
      assert((await stat(join(directory, file))).isFile(), `Native candidate is missing ${file}.`);
    }
    const nativeCatalogText = await readFile(join(directory, 'assets', 'image-catalog.json'), 'utf8');
    const nativeCatalog = JSON.parse(nativeCatalogText);
    if (expectedCatalogText) {
      assert(nativeCatalogText === expectedCatalogText, 'The staged native archive embeds a different image catalog.');
      assertCatalogIdentity(nativeCatalog, {
        version: workspace.version,
        revision: options.expectedRevision,
        source: options.expectedSource ?? source,
      });
    }
    if (options.nativeSbom) assert(await readFile(join(directory, 'SBOM.spdx.json'), 'utf8') === await readFile(options.nativeSbom, 'utf8'), 'The staged native archive embeds a different SPDX document.');
    await assertSbomMatchesNotices(join(directory, 'SBOM.spdx.json'), join(directory, 'THIRD_PARTY_NOTICES.txt'), { native: true });
    const revision = options.expectedRevision ?? nativeCatalog.revision;
    const nativeVersion = await exec(join(directory, 'qubicl'), ['--version']);
    assert(nativeVersion.stdout.trim() === `qubicl ${workspace.version} (${revision})`, 'The staged native CLI version or revision does not match the candidate.');
    if (options.nativeArchive) {
      await assertNativeArtifact({
        archive: options.nativeArchive,
        root: directory,
        entries: nativeEntries,
        target,
        version: workspace.version,
        revision: options.expectedRevision,
        source: options.expectedSource ?? source,
        nodeVersion: process.versions.node,
        expectedCatalogText,
        expectedSbomPath: options.nativeSbom,
      });
    }
    nativeResult = target;
  }

  assert(npmResult || nativeResult, 'Release preflight received no artifact to inspect.');
  if (expectedCatalog) assert(expectedCatalog.development === false, 'Exact artifact preflight requires a release catalog.');
  console.log(JSON.stringify({
    ok: true,
    version: workspace.version,
    package: cliManifest.name,
    cleanWorktree: status === '',
    exactStagedArtifacts: Boolean(options.npmArchive || options.nativeArchive),
    ...(npmResult ? { packedFiles: npmResult.files, installSmoke: true, imageCatalog: npmResult.catalog } : {}),
    ...(nativeResult ? { binary: nativeResult } : {}),
  }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function packDevelopmentArtifact(destination) {
  if (options.nativeArchive && !options.npmArchive) return undefined;
  const packed = await exec('npm', ['pack', '--workspace', 'packages/cli', '--pack-destination', destination, '--json'], {
    cwd: root,
    maxBuffer: 20_000_000,
  });
  const jsonStart = packed.stdout.indexOf('[');
  assert(jsonStart >= 0, 'npm pack did not return a JSON report.');
  const report = JSON.parse(packed.stdout.slice(jsonStart));
  assert(Array.isArray(report) && report.length === 1 && typeof report[0].filename === 'string', 'npm pack returned an unexpected report.');
  return join(destination, basename(report[0].filename));
}

async function assertSbomMatchesNotices(sbomPath, noticePath, { native = false } = {}) {
  const document = await jsonFile(sbomPath);
  assert(document.spdxVersion === 'SPDX-2.3', 'Artifact SBOM must use SPDX 2.3.');
  const noticeKeys = thirdPartyNoticeKeys(await readFile(noticePath, 'utf8'));
  const sbomKeys = spdxPackageKeys(document);
  const expected = native
    ? [...noticeKeys, ...sbomKeys.filter((key) => key.startsWith('node@'))].sort()
    : noticeKeys;
  assert(JSON.stringify(sbomKeys) === JSON.stringify(expected), 'Artifact SBOM components do not match THIRD_PARTY_NOTICES.txt.');
  assert(sbomKeys.some((key) => key.startsWith('@modelcontextprotocol/node@')), 'Artifact SBOM omits @modelcontextprotocol/node.');
  assert(sbomKeys.some((key) => key.startsWith('@hono/node-server@')), 'Artifact SBOM omits @hono/node-server.');
  assert(!sbomKeys.some((key) => key.startsWith('@modelcontextprotocol/client@')), 'Artifact SBOM includes test-only @modelcontextprotocol/client.');
}

function thirdPartyNoticeKeys(contents) {
  const lines = contents.split(/\r?\n/);
  const keys = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index + 1].startsWith('Declared license:')) keys.push(lines[index]);
  }
  return keys.sort();
}

function parseOptions(args) {
  const parsed = {
    requireBinary: false,
    npmArchive: undefined,
    nativeArchive: undefined,
    catalog: undefined,
    npmSbom: undefined,
    nativeSbom: undefined,
    expectedRevision: undefined,
    expectedSource: undefined,
  };
  const valueOptions = new Map([
    ['--npm-archive', 'npmArchive'],
    ['--native-archive', 'nativeArchive'],
    ['--catalog', 'catalog'],
    ['--npm-sbom', 'npmSbom'],
    ['--native-sbom', 'nativeSbom'],
    ['--expected-revision', 'expectedRevision'],
    ['--expected-source', 'expectedSource'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--require-binary') {
      parsed.requireBinary = true;
      continue;
    }
    const key = valueOptions.get(option);
    assert(key, `Unknown release-preflight option ${option}.`);
    assert(args[index + 1], `${option} requires a value.`);
    parsed[key] = key.startsWith('expected') ? args[index + 1] : resolve(args[index + 1]);
    index += 1;
  }
  const exact = Boolean(parsed.npmArchive || parsed.nativeArchive);
  if (exact) {
    assert(parsed.catalog && parsed.expectedRevision && parsed.expectedSource, 'Exact artifact preflight requires --catalog, --expected-revision, and --expected-source.');
    assert(!parsed.npmArchive || parsed.npmSbom, '--npm-archive requires --npm-sbom.');
    assert(!parsed.nativeArchive || parsed.nativeSbom, '--native-archive requires --native-sbom.');
  }
  return parsed;
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
