import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();

test('release sets require one exact candidate for every supported native target', async () => {
  const { assertReleaseSetShape } = await import(pathToFileURL(join(root, 'scripts', 'release-set.mjs')).href);
  const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
  const document = {
    schemaVersion: 1,
    createdAt: '2026-08-23T12:00:00.000Z',
    version: '1.0.0',
    revision: 'a'.repeat(40),
    source: 'https://github.com/example/qubicl',
    imageCatalogSha256: 'b'.repeat(64),
    completeTarget: 'linux-x64',
    members: targets.map((target, index) => ({
      target, directory: target, candidateJsonSha256: 'c'.repeat(64), checksumsSha256: 'd'.repeat(64),
      nativeArchive: { name: `qubicl-1.0.0-${target}.tar.gz`, bytes: 1, sha256: 'e'.repeat(64) },
      nativeSbom: { name: `qubicl-1.0.0-${target}.spdx.json`, bytes: 1, sha256: 'f'.repeat(64) },
      complete: index === 0,
    })),
  };
  assert.doesNotThrow(() => assertReleaseSetShape(document));
  assert.throws(() => assertReleaseSetShape({ ...document, members: document.members.slice(1) }), /exactly four/);
  assert.throws(() => assertReleaseSetShape({ ...document, completeTarget: 'linux-arm64' }), /exactly one complete target/);
});

test('supported acceptance rejects fake, self-reviewed, incomplete, and changed evidence', async () => {
  const { validateAcceptanceEvidence } = await import(pathToFileURL(join(root, 'scripts', 'acceptance-evidence.mjs')).href);
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-acceptance-'));
  try {
    const reportPath = join(directory, 'result.json');
    await writeFile(reportPath, '{"passed":true}\n');
    const reference = { path: 'result.json', sha256: createHash('sha256').update(await readFile(reportPath)).digest('hex') };
    const result = { passed: true, version: '1.2.3', testedAt: '2026-08-23T12:30:00.000Z', testedBy: 'platform-operator', evidence: reference };
    const review = (reviewedBy: string) => ({ passed: true, reviewedAt: '2026-08-23T12:35:00.000Z', reviewedBy, evidence: reference });
    const platforms: Array<Record<string, unknown>> = ['linux-x64', 'linux-arm64', 'macos-intel', 'macos-apple-silicon'].map((id) => ({
      id, ...result, minimumVersionsPassed: true, restartPassed: true, physicalRebootPassed: true,
      osVersion: '13.1', architecture: 'x64-1', node: '22.23.2', dockerEngine: '28.4.0', dockerCompose: '2.39.2', dockerDesktop: null,
    }));
    platforms.push({
      id: 'windows-wsl2-x64', ...result,
      minimumVersionsPassed: true, restartPassed: true, physicalRebootPassed: true,
      osVersion: 'Windows 11 10.0.26200.8875', windowsBuild: '10.0.26200.8875', architecture: 'x64-1',
      wslVersion: '2.7.12.0', wslKernel: '6.18.33.2', distribution: 'Ubuntu 24.04',
      node: '22.22.2', dockerEngine: '29.7.2', dockerCompose: '5.4.0', dockerDesktop: '4.50.0',
      wslShutdownPassed: true, windowsHostRebootPassed: true, linuxFilesystemPassed: true,
      windowsBackedStateRejected: true, windowsLocalhostPassed: true, windowsStdioPassed: true,
      viewerHandoffPassed: true,
    });
    const evidence = {
      schemaVersion: 3,
      releaseSet: { sha256: '1'.repeat(64), signatureFingerprint: 'SHA256:test', version: '1.0.0', revision: 'a'.repeat(40) },
      owner: 'release-owner',
      approvedBy: 'final-approver',
      approvedAt: '2026-08-23T12:45:00.000Z',
      clients: ['codex', 'claude-code', 'claude-desktop', 'cursor', 'vscode', 'open-webui', 'mcp-stdio', 'mcp-http', 'openapi'].map((id) => ({ id, ...result })),
      platforms,
      workflows: Object.fromEntries(['upgrade', 'backupRestoreInterruption', 'restart', 'physicalReboot', 'fullTopologyPerformance', 'multipleComputers', 'sustainedDogfooding'].map((id) => [id, result])),
      securityReview: { ...review('security-reviewer'), topics: Object.fromEntries(['processBoundary', 'internalAuthentication', 'browserSurface', 'filesystemRaces', 'networkReconciliation', 'releaseIntegrity'].map((topic) => [topic, true])) },
      vulnerabilityReview: review('vulnerability-reviewer'),
      privacyReview: review('privacy-reviewer'),
    };
    const context = {
      releaseSet: { createdAt: '2026-08-23T12:00:00.000Z', version: '1.0.0', revision: 'a'.repeat(40) },
      releaseSetSha256: '1'.repeat(64), evidenceDirectory: directory, signatureFingerprint: 'SHA256:test', now: '2026-08-23T13:00:00.000Z',
    };
    await assert.doesNotReject(validateAcceptanceEvidence(evidence, context));
    const fake = structuredClone(evidence); fake.clients[0]!.version = 'x';
    await assert.rejects(validateAcceptanceEvidence(fake, context), /real client/);
    const selfReviewed = structuredClone(evidence); selfReviewed.securityReview.reviewedBy = evidence.owner;
    await assert.rejects(validateAcceptanceEvidence(selfReviewed, context), /must differ/);
    const incomplete = structuredClone(evidence); delete incomplete.workflows.physicalReboot;
    await assert.rejects(validateAcceptanceEvidence(incomplete, context), /physicalReboot/);
    const incompleteWsl = structuredClone(evidence); incompleteWsl.platforms[4]!.windowsStdioPassed = false;
    await assert.rejects(validateAcceptanceEvidence(incompleteWsl, context), /windowsStdioPassed/);
    await writeFile(reportPath, '{"passed":false}\n');
    await assert.rejects(validateAcceptanceEvidence(evidence, context), /hash does not match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Trivy bindings reject reports detached from exact OCI identities', async () => {
  const { assertTrivyScanBinding } = await import(pathToFileURL(join(root, 'scripts', 'candidate-evidence.mjs')).href);
  const platform = {
    digest: `sha256:${'1'.repeat(64)}`,
    configDigest: `sha256:${'2'.repeat(64)}`,
    layerDigests: [`sha256:${'3'.repeat(64)}`],
    diffIds: [`sha256:${'4'.repeat(64)}`],
  };
  const report = { SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: platform.configDigest, DiffIDs: platform.diffIds } };
  const expected = {
    reportName: 'trivy-gateway-linux-amd64.json', reportSha256: '5'.repeat(64), archiveName: 'qubicl-gateway.oci.tar', archiveSha256: '6'.repeat(64),
    image: 'gateway', platform: 'linux/amd64', measured: { indexDigest: `sha256:${'7'.repeat(64)}`, platforms: { 'linux/amd64': platform } },
  };
  const binding = {
    report: expected.reportName, reportSha256: expected.reportSha256, image: expected.image, platform: expected.platform,
    ociArchive: expected.archiveName, ociArchiveSha256: expected.archiveSha256, indexDigest: expected.measured.indexDigest,
    manifestDigest: platform.digest, configDigest: platform.configDigest, layerDigests: platform.layerDigests, diffIds: platform.diffIds,
    reportIdentity: { schemaVersion: 2, artifactType: 'container_image', imageId: platform.configDigest, diffIds: platform.diffIds },
    options: { scanners: ['vuln', 'secret'], input: '.scan-gateway.oci' },
  };
  assert.doesNotThrow(() => assertTrivyScanBinding(binding, report, expected));
  assert.throws(() => assertTrivyScanBinding({ ...binding, ociArchiveSha256: '8'.repeat(64) }, report, expected), /exact OCI archive/);
  assert.throws(() => assertTrivyScanBinding(binding, { ...report, Metadata: { ...report.Metadata, ImageID: `sha256:${'9'.repeat(64)}` } }, expected), /ImageID/);
});

test('Trivy scanner evidence requires an identified scanner and a fresh exact database', async () => {
  const { assertTrivyScannerIdentity } = await import(pathToFileURL(join(root, 'scripts', 'candidate-evidence.mjs')).href);
  const bindings = {
    schemaVersion: 1,
    createdAt: '2026-08-23T12:00:00.000Z',
    scanner: {
      name: 'trivy',
      version: '0.66.0',
      versionOutputSha256: '1'.repeat(64),
      vulnerabilityDatabase: {
        Version: 2,
        UpdatedAt: '2026-08-23T11:00:00.000Z',
        DownloadedAt: '2026-08-23T11:05:00.000Z',
        NextUpdate: '2026-08-23T17:00:00.000Z',
        sha256: '2'.repeat(64),
      },
      checkBundle: {
        Digest: `sha256:${'3'.repeat(64)}`,
        DownloadedAt: '2026-08-23T11:05:00.000Z',
      },
    },
  };
  assert.doesNotThrow(() => assertTrivyScannerIdentity(bindings, '2026-08-23T13:00:00.000Z'));
  const stale = structuredClone(bindings);
  stale.scanner.vulnerabilityDatabase.UpdatedAt = '2026-08-20T11:00:00.000Z';
  assert.throws(() => assertTrivyScannerIdentity(stale, '2026-08-23T13:00:00.000Z'), /stale/);
  const unidentified = structuredClone(bindings);
  unidentified.scanner.vulnerabilityDatabase.sha256 = 'unknown';
  assert.throws(() => assertTrivyScannerIdentity(unidentified, '2026-08-23T13:00:00.000Z'), /database identity/);
});
