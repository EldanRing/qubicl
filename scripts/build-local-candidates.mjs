import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  IMAGE_NAMES,
  PLATFORMS,
  assertCatalogIdentity,
  assertTrivyReportPrivacy,
  assertTrivyScanBinding,
  canonicalJson,
  describeFiles,
  normalizeRepository,
  sha256,
  summarizeTrivyReports,
} from './candidate-evidence.mjs';
import { preserveFailedCandidate } from './candidate-lifecycle.mjs';
import { requiresClientConformance } from './client-conformance.mjs';
import {
  OCI_EFFICIENCY_REPORT_NAME,
  inspectOciEfficiencyArchives,
  serializeOciEfficiencyReport,
} from './oci-efficiency.mjs';
import { LOCAL_CANDIDATE_CONCURRENCY, runWithConcurrency } from './candidate-concurrency.mjs';
import { inspectOciArchive } from './oci-evidence.mjs';
import { createOciPlatformView } from './oci-platform-view.mjs';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const options = parseOptions(process.argv.slice(2));

if (options.help) {
  console.log(`Usage: node scripts/build-local-candidates.mjs [options]

Build unpublished release candidates entirely on the current host.

  --binary-only       Build only the native archive for this host
  --preview           Build an explicitly unsupported prerelease candidate whose
                      unfixed HIGH/CRITICAL findings are retained, not approved
  --initial           Build a stable pre-1.0 candidate that rejects secrets and
                      fix-available HIGH/CRITICAL findings while retaining other
                      unfixed distribution findings in the release evidence
  --skip-images       Skip multi-architecture OCI image archives
  --skip-scan         Skip local Trivy reports and policy enforcement
  --catalog PATH      Embed an already-generated exact release catalog
  --help              Show this help

A complete Linux x64 build creates five multi-architecture OCI archives first,
generates their digest/size catalog, then builds and tests the final CLI artifacts.
Binary-only and --skip-images builds require --catalog. Nothing is uploaded.`);
  process.exit(0);
}

if (process.env.QUBICL_CANDIDATE_ISOLATED !== '1') {
  await buildInIsolatedSource(process.argv.slice(2));
  process.exit(0);
}

const binaryOnly = options.binaryOnly;
assert(!(options.preview && options.initial), '--preview and --initial are mutually exclusive.');
const releaseTier = options.preview ? 'preview' : options.initial ? 'initial' : 'supported';
const buildImages = !binaryOnly && !options.skipImages;
const scanImages = buildImages && !options.skipScan;
const supportedTargets = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']);
const target = `${process.platform}-${process.arch}`;
assert(supportedTargets.has(target), `Native candidates are not supported on ${target}.`);
if (!binaryOnly && target !== 'linux-x64') throw new Error('Complete local candidates must be built on Linux x64; use --binary-only on this host.');
if (!buildImages && !options.catalog) throw new Error('--binary-only and --skip-images require --catalog PATH from an already-inspected five-image candidate set.');
if (buildImages && options.catalog) throw new Error('--catalog cannot be combined with a build that generates new image candidates.');

const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = workspace.version;
assert(releaseTier !== 'preview' || version.includes('-'), '--preview requires a prerelease package version.');
assert(releaseTier !== 'initial' || /^0\.[0-9]+\.[0-9]+$/.test(version), '--initial requires a stable pre-1.0 package version.');
const revision = process.env.QUBICL_CANDIDATE_REVISION ?? await capture('git', ['rev-parse', 'HEAD']);
const snapshotRevision = await capture('git', ['rev-parse', 'HEAD']);
assert(/^[a-f0-9]{40}$/u.test(revision) && revision === snapshotRevision,
  `Candidate revision must be the exact reviewed Git HEAD; expected ${snapshotRevision}, found ${revision}.`);
const shortRevision = revision.slice(0, 12);
const created = process.env.QUBICL_CANDIDATE_CREATED ?? await capture('git', ['show', '-s', '--format=%cI', 'HEAD']);
const source = normalizeRepository(process.env.QUBICL_CANDIDATE_SOURCE ?? workspace.repository?.url);
const owner = new URL(source).pathname.split('/').find(Boolean)?.toLowerCase();
assert(owner, `Could not determine a repository owner from ${source}.`);
const outputRoot = resolve(process.env.QUBICL_CANDIDATE_OUTPUT_ROOT ?? join(root, 'release', 'candidates'));
const candidateRoot = join(outputRoot, `${version}-${shortRevision}`, target);
const staging = join(outputRoot, `.${version}-${shortRevision}-${target}.${process.pid}.tmp`);
const clean = await capture('git', ['status', '--porcelain']);
const toolVersions = { node: process.version, npm: await capture('npm', ['--version']) };
const scanBindings = [];
if (buildImages) {
  toolVersions.docker = await capture('docker', ['version', '--format', '{{.Server.Version}}']);
  toolVersions.buildx = await capture('docker', ['buildx', 'version']);
}
if (scanImages) toolVersions.trivy = await capture('trivy', ['--version']);

assert(clean === '', 'Local candidate assembly requires a clean Git worktree.');
await assertAbsent(candidateRoot, `Candidate output already exists at ${candidateRoot}.`);
await run(process.execPath, ['scripts/public-source.mjs', 'check']);

const metadataEnvironment = releaseEnvironment({
  QUBICL_BUILD_VERSION: version,
  QUBICL_BUILD_REVISION: revision,
  QUBICL_BUILD_DATE: created,
});

const imageSpecs = [
  { name: 'gateway', context: 'gateway' },
  { name: 'file-system', context: 'computer', preset: 'file-system' },
  { name: 'browser', context: 'computer', preset: 'browser' },
  { name: 'computer', context: 'computer', preset: 'computer' },
  { name: 'workstation', context: 'computer', preset: 'workstation' },
];

try {
  await mkdir(staging, { recursive: true });
  const dependencyEvidencePath = process.env.QUBICL_DEPENDENCY_EVIDENCE_PATH;
  assert(dependencyEvidencePath, 'Isolated candidate construction requires dependency evidence.');
  const dependencyEvidenceName = 'dependency-evidence.json';
  await copyFile(dependencyEvidencePath, join(staging, dependencyEvidenceName));
  let catalogPath;
  let imageEfficiency;

  if (buildImages) {
    // This first build creates only the image contexts. Final npm/native bytes are
    // built once after the exact OCI catalog exists.
    await run('npm', ['run', 'build'], { env: metadataEnvironment });
    console.log(`Building image candidates with at most ${LOCAL_CANDIDATE_CONCURRENCY} concurrent jobs.`);
    await runWithConcurrency(imageSpecs, buildImageCandidate);
    if (scanImages) {
      console.log('Scanning image candidates serially against the shared local Trivy cache.');
      for (const spec of imageSpecs) await scanImageCandidate(spec);
    }
    if (requiresClientConformance(version)) {
      const archives = Object.fromEntries(imageSpecs.map(({ name }) => [name, join(staging, `qubicl-${name}.oci.tar`)]));
      const reportPath = join(staging, OCI_EFFICIENCY_REPORT_NAME);
      const report = await inspectOciEfficiencyArchives(archives);
      await writeFile(reportPath, serializeOciEfficiencyReport(report), { mode: 0o644 });
      imageEfficiency = { name: OCI_EFFICIENCY_REPORT_NAME, sha256: await sha256(reportPath) };
    }
    catalogPath = join(staging, 'image-catalog.json');
    await run(process.execPath, [
      'scripts/generate-image-catalog.mjs',
      '--directory', staging,
      '--output', catalogPath,
      '--version', version,
      '--revision', revision,
      '--source', source,
      '--owner', owner,
    ], { env: metadataEnvironment });
  } else {
    await run('npm', ['run', 'build:types'], { env: metadataEnvironment });
    catalogPath = join(staging, 'image-catalog.json');
    await copyFile(options.catalog, catalogPath);
  }

  const { ImageCatalogSchema } = await import('../packages/core/dist/index.js');
  const catalog = assertCatalogIdentity(ImageCatalogSchema.parse(JSON.parse(await readFile(catalogPath, 'utf8'))), {
    version,
    revision,
    source,
  });
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o644 });
  const finalEnvironment = releaseEnvironment({
    QUBICL_BUILD_VERSION: version,
    QUBICL_BUILD_REVISION: revision,
    QUBICL_BUILD_DATE: created,
    QUBICL_IMAGE_CATALOG_PATH: catalogPath,
    QUBICL_DEFAULT_GATEWAY_IMAGE: catalog.gateway.requested,
    QUBICL_DEFAULT_COMPUTER_IMAGE: catalog.presets.workstation.image.requested,
  });

  // No command after this build may rebuild either staged artifact.
  await run('npm', ['run', 'build:binary'], { env: finalEnvironment });

  const binaryArchive = `qubicl-${version}-${target}.tar.gz`;
  const nativeSbom = `qubicl-${version}-${target}.spdx.json`;
  await copyFile(join(root, 'release', `qubicl-${target}`, 'SBOM.spdx.json'), join(staging, nativeSbom));
  await run('tar', ['-C', join(root, 'release'), '-czf', join(staging, binaryArchive), `qubicl-${target}`], { env: finalEnvironment });

  let npmArchive;
  const npmSbom = 'qubicl-npm.spdx.json';
  if (!binaryOnly) {
    const packedOutput = await capture('npm', [
      'pack',
      '--workspace', 'packages/cli',
      '--pack-destination', staging,
      '--ignore-scripts',
      '--json',
    ], { env: finalEnvironment, trim: false, maxBuffer: 20_000_000 });
    const packed = JSON.parse(packedOutput);
    assert(Array.isArray(packed) && packed.length === 1 && typeof packed[0].filename === 'string', 'npm pack returned an unexpected report.');
    npmArchive = packed[0].filename;
    assert(npmArchive === `qubicl-cli-${version}.tgz`, `npm pack returned unexpected filename ${npmArchive}.`);
    await copyFile(join(root, 'packages', 'cli', 'dist', 'SBOM.spdx.json'), join(staging, npmSbom));
  }

  let security;
  if (scanImages) {
    const exceptionName = 'vulnerability-exceptions.json';
    const exceptionPath = join(staging, exceptionName);
    const applicabilityName = 'vulnerability-applicability.json';
    const applicabilityPath = join(staging, applicabilityName);
    await copyFile(join(root, 'security', exceptionName), exceptionPath);
    await copyFile(join(root, 'security', applicabilityName), applicabilityPath);
    const exceptions = JSON.parse(await readFile(exceptionPath, 'utf8'));
    const applicability = JSON.parse(await readFile(applicabilityPath, 'utf8'));
    const reportEntries = await Promise.all(IMAGE_NAMES.flatMap((image) => PLATFORMS.map(async (platform) => {
      const name = `trivy-${image}-${platform.replace('/', '-')}.json`;
      return { name, document: JSON.parse(await readFile(join(staging, name), 'utf8')) };
    })));
    security = summarizeTrivyReports(reportEntries, exceptions, {
      evaluatedAt: new Date().toISOString(),
      exceptionName,
      exceptionSha256: await sha256(exceptionPath),
      applicabilityDocument: applicability,
      applicabilityName,
      applicabilitySha256: await sha256(applicabilityPath),
      releaseTier,
    });
    await writeFile(join(staging, 'trivy-summary.json'), `${JSON.stringify(security, null, 2)}\n`, { mode: 0o644 });
    const trivyDetails = JSON.parse(await capture('trivy', ['--version', '--format', 'json']));
    const trivyDatabase = resolve(process.env.TRIVY_CACHE_DIR ?? join(homedir(), '.cache', 'trivy'), 'db', 'trivy.db');
    await writeFile(join(staging, 'trivy-bindings.json'), `${JSON.stringify({
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      scanner: {
        name: 'trivy',
        version: trivyDetails.Version,
        versionOutputSha256: createHash('sha256').update(toolVersions.trivy).digest('hex'),
        vulnerabilityDatabase: { ...trivyDetails.VulnerabilityDB, sha256: await sha256(trivyDatabase) },
        checkBundle: trivyDetails.CheckBundle,
      },
      scans: scanBindings.sort((left, right) => left.report.localeCompare(right.report)),
    }, null, 2)}\n`, { mode: 0o644 });
  }

  const preflightArgs = [
    'scripts/release-preflight.mjs',
    '--native-archive', join(staging, binaryArchive),
    '--native-sbom', join(staging, nativeSbom),
    '--catalog', catalogPath,
    '--expected-revision', revision,
    '--expected-source', source,
  ];
  if (npmArchive) preflightArgs.push('--npm-archive', join(staging, npmArchive), '--npm-sbom', join(staging, npmSbom));
  await run(process.execPath, preflightArgs, { env: finalEnvironment });

  if (buildImages) {
    for (const spec of imageSpecs) {
      await run('docker', ['image', 'load', '--input', join(staging, `qubicl-${spec.name}.oci.tar`), '--platform', 'linux/amd64']);
      const resolved = catalogImage(catalog, spec.name).platforms['linux/amd64'].resolved;
      await capture('docker', ['image', 'inspect', resolved]);
    }
    const acceptanceEnvironment = {
      ...finalEnvironment,
      QUBICL_E2E_SKIP_IMAGE_BUILD: '1',
    };
    const acceptanceJobs = [
      ['source', '--no-build'],
      ['npm', '--archive', join(staging, npmArchive)],
      ['binary', '--archive', join(staging, binaryArchive)],
    ];
    console.log(`Running exact artifact acceptance with at most ${LOCAL_CANDIDATE_CONCURRENCY} concurrent jobs.`);
    await runWithConcurrency(acceptanceJobs, (args) => run(
      process.execPath,
      ['scripts/test-artifact-e2e.mjs', ...args],
      { env: acceptanceEnvironment },
    ));
  }

  await assertSourceSnapshot('candidate manifest generation');
  const artifacts = await describeFiles(staging);
  const manifest = {
    schemaVersion: 5,
    version,
    revision,
    created,
    source,
    releaseTier,
    host: { platform: process.platform, architecture: process.arch, target },
    tools: toolVersions,
    dependencies: { name: dependencyEvidenceName, sha256: await sha256(join(staging, dependencyEvidenceName)) },
    modes: { binaryOnly, images: buildImages, scans: scanImages, exactArtifactAcceptance: buildImages },
    imageCatalog: { name: 'image-catalog.json', sha256: await sha256(catalogPath) },
    ...(imageEfficiency ? { imageEfficiency } : {}),
    ...(security ? { security } : {}),
    artifacts,
  };
  await writeFile(join(staging, 'candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  const checksumFiles = (await readdir(staging)).filter((name) => name !== 'SHA256SUMS').sort();
  const checksums = [];
  for (const name of checksumFiles) checksums.push(`${await sha256(join(staging, name))}  ${name}`);
  await writeFile(join(staging, 'SHA256SUMS'), `${checksums.join('\n')}\n`, { mode: 0o644 });

  await run(process.execPath, ['scripts/verify-candidate.mjs', staging], { env: finalEnvironment });
  await assertSourceSnapshot('final candidate rename');
  await mkdir(resolve(candidateRoot, '..'), { recursive: true });
  await rename(staging, candidateRoot);
  console.log(JSON.stringify({ ok: true, output: candidateRoot, ...manifest }, null, 2));
} catch (error) {
  try {
    const failedRoot = await preserveFailedCandidate(staging, { outputRoot, version, revision, target });
    console.error(`Preserved failed candidate staging at ${failedRoot}. From the unchanged reviewed revision, correct any external verification condition without changing these bytes, then use verification-only resume or explicitly clean that path.`);
  } catch (preserveError) {
    if (preserveError?.code !== 'ENOENT') {
      console.error(`Could not preserve failed candidate staging: ${preserveError instanceof Error ? preserveError.message : String(preserveError)}`);
    }
  }
  throw error;
}

async function buildImageCandidate(spec) {
  const archive = join(staging, `qubicl-${spec.name}.oci.tar`);
  const repository = `ghcr.io/${owner}/qubicl-${spec.name}:${version}`;
  const args = [
    'buildx', 'build',
    '--platform', 'linux/amd64,linux/arm64',
    '--output', `type=oci,dest=${archive},compression=gzip,compression-level=6,force-compression=true`,
    '--tag', repository,
    '--provenance', 'mode=max,version=v1',
    '--sbom=true',
    '--build-arg', `QUBICL_VERSION=${version}`,
    '--build-arg', `QUBICL_REVISION=${revision}`,
    '--build-arg', `QUBICL_CREATED=${created}`,
    '--build-arg', `QUBICL_SOURCE=${source}`,
  ];
  if (spec.preset) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', 'cli', 'dist', 'assets', 'computer', 'manifests', `${spec.preset}.json`), 'utf8'));
    args.push(
      '--target', spec.preset,
      '--build-arg', `QUBICL_CONTRACT_PRESET=${spec.preset}`,
      '--build-arg', `QUBICL_CONTRACT_COMPATIBILITY=${spec.preset}`,
      '--build-arg', `QUBICL_CONTRACT_CAPABILITIES=${manifest.capabilities.join(',')}`,
      '--build-arg', `QUBICL_MANIFEST_SHA256=${canonicalDigest(manifest)}`,
    );
  }
  args.push(join(root, 'packages', 'cli', 'dist', 'assets', spec.context));
  await run('docker', args, { env: metadataEnvironment });
  const inspectArgs = ['scripts/inspect-oci-candidate.mjs', archive, version, revision, source];
  if (spec.preset) inspectArgs.push(spec.preset, join(root, 'packages', 'cli', 'dist', 'assets', 'computer', 'manifests', `${spec.preset}.json`));
  await run(process.execPath, inspectArgs, { env: metadataEnvironment });
}

async function scanImageCandidate(spec) {
  const archive = join(staging, `qubicl-${spec.name}.oci.tar`);
  const scanSourceName = `.scan-${spec.name}.source.oci`;
  const scanSource = join(staging, scanSourceName);
  const measured = await inspectOciArchive(archive, { requireAttestations: true });
  const archiveSha256 = await sha256(archive);
  await mkdir(scanSource);
  await run('tar', ['-xf', archive, '-C', scanSource], { env: metadataEnvironment });
  try {
    for (const [platform, platformName] of [['linux/amd64', 'linux-amd64'], ['linux/arm64', 'linux-arm64']]) {
      const scanName = `.scan-${spec.name}-${platformName}.oci`;
      const scanLayout = join(staging, scanName);
      const reportName = `trivy-${spec.name}-${platformName}.json`;
      const pendingReportName = `.${reportName}.${process.pid}.tmp`;
      const pendingReport = join(staging, pendingReportName);
      try {
        const platformIdentity = measured.platforms[platform];
        const platformView = await createOciPlatformView(scanSource, scanLayout, platform, {
          indexDigest: measured.indexDigest,
          manifestDigest: platformIdentity.digest,
          configDigest: platformIdentity.configDigest,
          layerDigests: platformIdentity.layerDigests,
          diffIds: platformIdentity.diffIds,
        });
        await run('trivy', [
          'image',
          '--input', scanName,
          '--scanners', 'vuln,secret',
          '--format', 'json',
          '--output', pendingReportName,
        ], { cwd: staging, env: metadataEnvironment });
        const document = JSON.parse(await readFile(pendingReport, 'utf8'));
        assertTrivyReportPrivacy(document, scanName);
        const reportSha256 = await sha256(pendingReport);
        const binding = {
          report: reportName,
          reportSha256,
          image: spec.name,
          platform,
          ociArchive: basename(archive),
          ociArchiveSha256: archiveSha256,
          indexDigest: measured.indexDigest,
          manifestDigest: platformIdentity.digest,
          configDigest: platformIdentity.configDigest,
          layerDigests: platformIdentity.layerDigests,
          diffIds: platformIdentity.diffIds,
          platformView: { input: scanName, ...platformView },
          reportIdentity: {
            schemaVersion: document.SchemaVersion,
            artifactType: document.ArtifactType,
            imageId: document.Metadata?.ImageID,
            diffIds: document.Metadata?.DiffIDs,
            imageConfig: {
              os: document.Metadata?.ImageConfig?.os,
              architecture: document.Metadata?.ImageConfig?.architecture,
              diffIds: document.Metadata?.ImageConfig?.rootfs?.diff_ids,
            },
          },
          options: { scanners: ['vuln', 'secret'], input: scanName },
        };
        assertTrivyScanBinding(binding, document, {
          reportName,
          reportSha256,
          archiveName: basename(archive),
          archiveSha256,
          image: spec.name,
          platform,
          measured,
          bindingSchemaVersion: 2,
        });
        await rename(pendingReport, join(staging, reportName));
        scanBindings.push(binding);
      } finally {
        await rm(scanLayout, { recursive: true, force: true });
        await rm(pendingReport, { force: true });
      }
    }
  } finally {
    await rm(scanSource, { recursive: true, force: true });
  }
}

function catalogImage(catalog, name) {
  return name === 'gateway' ? catalog.gateway : catalog.presets[name].image;
}

function canonicalDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function releaseEnvironment(overrides) {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'DOCKER_CONFIG',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  const environment = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}

async function capture(command, args, options = {}) {
  const { trim = true, ...execOptions } = options;
  const result = await exec(command, args, { cwd: root, encoding: 'utf8', ...execOptions });
  return trim ? result.stdout.trim() : result.stdout;
}

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}`)));
  });
}

async function assertAbsent(path, message) {
  try {
    await stat(path);
    throw new Error(message);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function assertSourceSnapshot(stage) {
  const currentRevision = await capture('git', ['rev-parse', 'HEAD']);
  const currentStatus = await capture('git', ['status', '--porcelain']);
  assert(currentRevision === snapshotRevision, `Isolated Git HEAD changed during ${stage}; expected ${snapshotRevision}, found ${currentRevision}.`);
  assert(currentStatus === '', `Git worktree changed during ${stage}; candidate identity is no longer immutable.`);
}

async function buildInIsolatedSource(args) {
  const childArgs = [...args];
  const catalogIndex = childArgs.indexOf('--catalog');
  if (catalogIndex >= 0) childArgs[catalogIndex + 1] = options.catalog;
  const status = await capture('git', ['status', '--porcelain']);
  assert(status === '', 'Local candidate assembly requires a clean Git worktree.');
  await run(process.execPath, ['scripts/public-source.mjs', 'check']);
  const revision = await capture('git', ['rev-parse', 'HEAD']);
  const created = await capture('git', ['show', '-s', '--format=%cI', 'HEAD']);
  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const source = normalizeRepository(workspace.repository?.url);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-candidate-source-'));
  const sourceRoot = join(temporary, 'source');
  const archive = join(temporary, 'source.tar');
  const bundle = join(temporary, 'source.bundle');
  const dependencyEvidence = join(temporary, 'dependency-evidence.json');
  try {
    await run('git', ['archive', '--format=tar', '--output', archive, revision]);
    // Preserve the reviewed commit object itself in the isolated checkout. A
    // synthetic commit has different identity even when its tree is identical,
    // which prevents the final evidence verifier from reproducing `git archive`
    // for the reviewed revision. The bundle contains only objects reachable from
    // HEAD and never copies local reflogs, unreachable objects, or other refs.
    await run('git', ['bundle', 'create', bundle, 'HEAD']);
    await run('git', ['clone', '--quiet', '--no-checkout', bundle, sourceRoot]);
    await run('git', ['checkout', '--quiet', '--detach', revision], { cwd: sourceRoot });
    assert(await capture('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot }) === revision, 'Isolated source checkout lost the reviewed commit identity.');
    const isolatedArchive = join(temporary, 'isolated-source.tar');
    await run('git', ['archive', '--format=tar', '--output', isolatedArchive, revision], { cwd: sourceRoot });
    assert(await sha256(isolatedArchive) === await sha256(archive), 'Isolated source archive does not reproduce the reviewed commit bytes.');
    await run('npm', ['ci'], { cwd: sourceRoot });
    assert(await capture('git', ['status', '--porcelain'], { cwd: sourceRoot }) === '', 'npm ci modified the isolated reviewed source tree.');
    const [inventoryText, auditText, signaturesText, registry] = await Promise.all([
      capture('npm', ['ls', '--all', '--json'], { cwd: sourceRoot, maxBuffer: 100_000_000, trim: false }),
      capture('npm', ['audit', '--audit-level=high', '--json'], { cwd: sourceRoot, maxBuffer: 100_000_000, trim: false }),
      capture('npm', ['audit', 'signatures', '--json'], { cwd: sourceRoot, maxBuffer: 100_000_000, trim: false }),
      capture('npm', ['config', 'get', 'registry'], { cwd: sourceRoot }),
    ]);
    const lockfileSha256 = await sha256(join(sourceRoot, 'package-lock.json'));
    await writeFile(dependencyEvidence, `${JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: { revision, archiveSha256: await sha256(archive), clean: true },
      install: { command: ['npm', 'ci'], npm: await capture('npm', ['--version'], { cwd: sourceRoot }), registry, lockfileSha256 },
      inventory: JSON.parse(inventoryText),
      audit: JSON.parse(auditText),
      signatures: JSON.parse(signaturesText),
    }, null, 2)}\n`, { mode: 0o600 });
    await run(process.execPath, ['scripts/build-local-candidates.mjs', ...childArgs], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        QUBICL_CANDIDATE_ISOLATED: '1',
        QUBICL_CANDIDATE_REVISION: revision,
        QUBICL_CANDIDATE_CREATED: created,
        QUBICL_CANDIDATE_SOURCE: source,
        QUBICL_CANDIDATE_OUTPUT_ROOT: join(root, 'release', 'candidates'),
        QUBICL_DEPENDENCY_EVIDENCE_PATH: dependencyEvidence,
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseOptions(args) {
  const parsed = { binaryOnly: false, preview: false, initial: false, skipImages: false, skipScan: false, help: false, catalog: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--binary-only') parsed.binaryOnly = true;
    else if (option === '--preview') parsed.preview = true;
    else if (option === '--initial') parsed.initial = true;
    else if (option === '--skip-images') parsed.skipImages = true;
    else if (option === '--skip-scan') parsed.skipScan = true;
    else if (option === '--help') parsed.help = true;
    else if (option === '--catalog') {
      const value = args[index + 1];
      assert(value, '--catalog requires a path.');
      parsed.catalog = resolve(value);
      index += 1;
    } else throw new Error(`Unknown option ${option}.`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
