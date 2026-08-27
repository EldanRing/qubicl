import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('v0.1 schema-3 acceptance remains verifiable and rejects fake or incomplete evidence', async () => {
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
      releaseSet: { sha256: '1'.repeat(64), signatureFingerprint: 'SHA256:test', version: '0.1.0', revision: 'a'.repeat(40) },
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
      releaseSet: { createdAt: '2026-08-23T12:00:00.000Z', version: '0.1.0', revision: 'a'.repeat(40) },
      releaseSetSha256: '1'.repeat(64), evidenceDirectory: directory, signatureFingerprint: 'SHA256:test', now: '2026-08-23T13:00:00.000Z',
    };
    await assert.doesNotReject(validateAcceptanceEvidence(evidence, context));
    const v02 = structuredClone(evidence);
    v02.releaseSet.version = '0.2.0';
    await assert.rejects(validateAcceptanceEvidence(v02, {
      ...context,
      releaseSet: { ...context.releaseSet, version: '0.2.0' },
    }), /schemaVersion 4 is required/);
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

test('v0.2 schema-4 acceptance binds exact client surfaces and platform facts to reviewed matrices', async () => {
  const acceptance = await import(pathToFileURL(join(root, 'scripts', 'acceptance-evidence.mjs')).href);
  const conformance = await import(pathToFileURL(join(root, 'scripts', 'client-conformance.mjs')).href);
  const platformSupport = await import(pathToFileURL(join(root, 'scripts', 'platform-support.mjs')).href);
  const remoteAccess = await import(pathToFileURL(join(root, 'scripts', 'remote-access-conformance.mjs')).href);
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-conformance-acceptance-'));
  try {
    const reportPath = join(directory, 'conformance-results.json');
    await writeFile(reportPath, '{"passed":true,"source":"synthetic unit-test fixture"}\n');
    const reference = { path: 'conformance-results.json', sha256: await sha256(reportPath) };
    const requirements = await conformance.loadClientConformanceRequirements();
    const requirementsPath = join(directory, conformance.CLIENT_CONFORMANCE_REQUIREMENTS_NAME);
    await copyFile(conformance.CLIENT_CONFORMANCE_REQUIREMENTS_PATH, requirementsPath);
    const platformRequirements = await platformSupport.loadPlatformSupportRequirements();
    const platformRequirementsPath = join(directory, platformSupport.PLATFORM_SUPPORT_REQUIREMENTS_NAME);
    await copyFile(platformSupport.PLATFORM_SUPPORT_REQUIREMENTS_PATH, platformRequirementsPath);
    const remoteRequirements = await remoteAccess.loadRemoteAccessRequirements();
    const remoteRequirementsPath = join(directory, remoteAccess.REMOTE_ACCESS_REQUIREMENTS_NAME);
    await copyFile(remoteAccess.REMOTE_ACCESS_REQUIREMENTS_PATH, remoteRequirementsPath);
    const checked = {
      passed: true,
      testedAt: '2026-08-23T12:30:00.000Z',
      testedBy: 'fixture-operator',
      evidence: reference,
    };
    const rows = (profiles: Array<{ id: string; transport: string; requiredSurfaces: string[] }>) => profiles.map((profile) => ({
      id: profile.id,
      version: `${profile.id} 1.2.3`,
      transport: profile.transport,
      preset: requirements.requiredPreset,
      ...checked,
      surfaces: Object.fromEntries(profile.requiredSurfaces.map((surface) => [surface, { ...checked }])),
    }));
    const platformResult = { ...checked, version: 'candidate 0.2.0' };
    const platformVersions: Record<string, Record<string, string | null>> = {
      'linux-x64': {
        osVersion: 'Ubuntu 24.04.3 LTS', node: '22.23.2', dockerEngine: '28.4.0',
        dockerCompose: '2.39.2', dockerDesktop: null,
      },
      'linux-arm64': {
        osVersion: 'Ubuntu 24.04.3 LTS', node: '22.23.2', dockerEngine: '28.4.0',
        dockerCompose: '2.39.2', dockerDesktop: null,
      },
      'macos-intel': {
        osVersion: 'macOS 15.6.1 (24G90)', node: '22.23.2', dockerEngine: '28.4.0',
        dockerCompose: '2.39.2', dockerDesktop: '4.50.0',
      },
      'macos-apple-silicon': {
        osVersion: 'macOS 15.6.1 (24G90)', node: '22.23.2', dockerEngine: '28.4.0',
        dockerCompose: '2.39.2', dockerDesktop: '4.50.0',
      },
      'windows-wsl2-x64': {
        osVersion: 'Windows 11 10.0.26200.8875', windowsBuild: '10.0.26200.8875',
        wslVersion: '2.7.12.0', wslKernel: '6.18.33.2', distribution: 'Ubuntu 24.04.3 LTS',
        node: '22.22.2', dockerEngine: '29.7.2', dockerCompose: '5.4.0', dockerDesktop: '4.50.0',
      },
    };
    const platforms: Array<Record<string, any>> = platformRequirements.acceptancePlatforms.map((profile: {
      id: string;
      requiredValues: Record<string, string>;
      requiredChecks: string[];
    }) => ({
      id: profile.id,
      ...platformResult,
      ...profile.requiredValues,
      ...platformVersions[profile.id],
      ...Object.fromEntries(profile.requiredChecks.map((check) => [check, true])),
    }));
    const remoteRows = remoteRequirements.profiles.map((profile: {
      id: string;
      platformId: string;
      networkPath: string;
      clientPath: string;
      allowedPeerAddressBehaviors: string[];
    }, index: number) => ({
      id: profile.id,
      platformId: profile.platformId,
      protocol: remoteRequirements.protocol,
      preset: remoteRequirements.requiredPreset,
      networkPath: profile.networkPath,
      clientPath: profile.clientPath,
      peerAddressBehavior: profile.allowedPeerAddressBehaviors.at(-1),
      sourceAddressFamily: 'ipv4',
      observedAddressFamily: 'ipv4',
      sourceAddressScope: 'non-loopback',
      observedAddressScope: 'non-loopback',
      peerAddressComparison: index === 0 ? 'same' : 'different',
      hostname: 'gateway.example.test',
      externalPort: 8443,
      tlsProtocol: 'TLSv1.3',
      certificateFingerprint256: `sha256:${'9'.repeat(64)}`,
      clientVersions: Object.fromEntries(remoteRequirements.requiredClientVersionFields.map((field: string) => [field, `${field} 1.2.3`])),
      checks: Object.fromEntries(remoteRequirements.requiredChecks.map((check: string) => [check, true])),
      surfaces: Object.fromEntries(remoteRequirements.requiredSurfaces.map((surface: string) => [surface, { ...checked }])),
      ...checked,
    }));
    const review = (reviewedBy: string) => ({
      passed: true,
      reviewedAt: '2026-08-23T12:35:00.000Z',
      reviewedBy,
      evidence: reference,
    });
    const evidence = {
      schemaVersion: 4,
      releaseSet: {
        sha256: '1'.repeat(64),
        signatureFingerprint: 'SHA256:test',
        version: '0.2.0',
        revision: 'a'.repeat(40),
      },
      conformance: {
        schemaVersion: 1,
        requirements: {
          path: conformance.CLIENT_CONFORMANCE_REQUIREMENTS_NAME,
          sha256: await sha256(requirementsPath),
        },
      },
      platformConformance: {
        schemaVersion: 1,
        requirements: {
          path: platformSupport.PLATFORM_SUPPORT_REQUIREMENTS_NAME,
          sha256: await sha256(platformRequirementsPath),
        },
      },
      remoteAccessConformance: {
        schemaVersion: 1,
        requirements: {
          path: remoteAccess.REMOTE_ACCESS_REQUIREMENTS_NAME,
          sha256: await sha256(remoteRequirementsPath),
        },
      },
      owner: 'release-owner',
      approvedBy: 'final-approver',
      approvedAt: '2026-08-23T12:45:00.000Z',
      clients: rows(requirements.clients),
      protocols: rows(requirements.protocols),
      platforms,
      remoteAccess: remoteRows,
      workflows: Object.fromEntries(['upgrade', 'backupRestoreInterruption', 'restart', 'physicalReboot', 'fullTopologyPerformance', 'multipleComputers', 'sustainedDogfooding', 'remoteGateway'].map((id) => [id, platformResult])),
      securityReview: {
        ...review('security-reviewer'),
        topics: Object.fromEntries(['processBoundary', 'internalAuthentication', 'browserSurface', 'filesystemRaces', 'networkReconciliation', 'releaseIntegrity', 'remoteExposure'].map((topic) => [topic, true])),
      },
      vulnerabilityReview: review('vulnerability-reviewer'),
      privacyReview: review('privacy-reviewer'),
    };
    const context = {
      releaseSet: { createdAt: '2026-08-23T12:00:00.000Z', version: '0.2.0', revision: 'a'.repeat(40) },
      releaseSetSha256: '1'.repeat(64),
      evidenceDirectory: directory,
      signatureFingerprint: 'SHA256:test',
      now: '2026-08-23T13:00:00.000Z',
    };
    const summary = await acceptance.validateAcceptanceEvidence(evidence, context);
    assert.deepEqual(summary, {
      schemaVersion: 4,
      clients: requirements.clients.length,
      protocols: requirements.protocols.length,
      surfaces: [...requirements.clients, ...requirements.protocols]
        .reduce((count, profile) => count + profile.requiredSurfaces.length, 0),
      platforms: 5,
      remoteProfiles: remoteRequirements.profiles.length,
      remoteSurfaces: remoteRequirements.profiles.length * remoteRequirements.requiredSurfaces.length,
      workflows: 8,
    });
    assert.deepEqual(
      acceptance.acceptanceEvidenceFiles(evidence, directory).sort(),
      [requirementsPath, platformRequirementsPath, remoteRequirementsPath, reportPath].sort(),
    );

    const missingClient = structuredClone(evidence);
    missingClient.clients = missingClient.clients.filter(({ id }) => id !== 'opencode');
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingClient, context), /exactly 9 client rows/);
    const floatingVersion = structuredClone(evidence);
    floatingVersion.clients[0]!.version = 'latest';
    await assert.rejects(acceptance.validateAcceptanceEvidence(floatingVersion, context), /exact installed version/);
    const missingSurface = structuredClone(evidence);
    delete missingSurface.clients[0]!.surfaces.files;
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingSurface, context), /applicable conformance surfaces/);
    const nonApplicableSurface = structuredClone(evidence);
    nonApplicableSurface.clients[0]!.surfaces['mcp-http'] = { ...checked };
    await assert.rejects(acceptance.validateAcceptanceEvidence(nonApplicableSurface, context), /applicable conformance surfaces/);
    const failedSurface = structuredClone(evidence);
    failedSurface.clients[0]!.surfaces.discovery!.passed = false;
    await assert.rejects(acceptance.validateAcceptanceEvidence(failedSurface, context), /surface discovery did not pass/);
    const preFreeze = structuredClone(evidence);
    preFreeze.clients[0]!.surfaces.discovery!.testedAt = '2026-08-23T11:59:59.000Z';
    await assert.rejects(acceptance.validateAcceptanceEvidence(preFreeze, context), /surface discovery predates the release set/);
    const detachedSurface = structuredClone(evidence);
    detachedSurface.clients[0]!.surfaces.discovery!.evidence.sha256 = '9'.repeat(64);
    await assert.rejects(acceptance.validateAcceptanceEvidence(detachedSurface, context), /evidence file hash does not match/);
    const missingPlatformContract: Partial<typeof evidence> = structuredClone(evidence);
    delete missingPlatformContract.platformConformance;
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingPlatformContract, context), /platform-support-v1\.json/);
    const wrongArchitecture = structuredClone(evidence);
    wrongArchitecture.platforms[0]!.architecture = 'arm64';
    await assert.rejects(acceptance.validateAcceptanceEvidence(wrongArchitecture, context), /architecture as x64/);
    const floatingHostVersion = structuredClone(evidence);
    floatingHostVersion.platforms[0]!.osVersion = 'latest';
    await assert.rejects(acceptance.validateAcceptanceEvidence(floatingHostVersion, context), /exact osVersion/);
    const wrongDistribution = structuredClone(evidence);
    wrongDistribution.platforms[4]!.distribution = 'Debian 13.1';
    await assert.rejects(acceptance.validateAcceptanceEvidence(wrongDistribution, context), /identify Ubuntu 24\.04/);
    const missingDesktopRestart = structuredClone(evidence);
    missingDesktopRestart.platforms[2]!.dockerDesktopRestartPassed = false;
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingDesktopRestart, context), /dockerDesktopRestartPassed/);

    const missingRemoteContract: Partial<typeof evidence> = structuredClone(evidence);
    delete missingRemoteContract.remoteAccessConformance;
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingRemoteContract, context), /remote-access-v1\.json/);
    const wrongRemoteClientPath = structuredClone(evidence);
    wrongRemoteClientPath.remoteAccess[1]!.clientPath = 'local-loopback-client';
    await assert.rejects(acceptance.validateAcceptanceEvidence(wrongRemoteClientPath, context), /must record client path/);
    const mislabeledDirectPeer = structuredClone(evidence);
    mislabeledDirectPeer.remoteAccess[0]!.peerAddressComparison = 'different';
    await assert.rejects(acceptance.validateAcceptanceEvidence(mislabeledDirectPeer, context), /must record same peer-address comparison for direct/);
    const crossFamilyDirectPeer = structuredClone(evidence);
    crossFamilyDirectPeer.remoteAccess[0]!.observedAddressFamily = 'ipv6';
    await assert.rejects(acceptance.validateAcceptanceEvidence(crossFamilyDirectPeer, context), /cannot record the same peer across different address families/);
    const mislabeledNatPeer = structuredClone(evidence);
    mislabeledNatPeer.remoteAccess[1]!.peerAddressComparison = 'same';
    await assert.rejects(acceptance.validateAcceptanceEvidence(mislabeledNatPeer, context), /must record different peer-address comparison for nat-translated/);
    const loopbackRemotePeer = structuredClone(evidence);
    loopbackRemotePeer.remoteAccess[0]!.observedAddressScope = 'loopback';
    await assert.rejects(acceptance.validateAcceptanceEvidence(loopbackRemotePeer, context), /must use non-loopback source and observed peer paths/);
    const missingRemoteSurface = structuredClone(evidence);
    delete missingRemoteSurface.remoteAccess[0]!.surfaces['preview-websocket'];
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingRemoteSurface, context), /required remote surfaces/);
    const failedRemoteNetworkBoundary = structuredClone(evidence);
    failedRemoteNetworkBoundary.remoteAccess[0]!.checks.clientNetworkDenyPassed = false;
    await assert.rejects(acceptance.validateAcceptanceEvidence(failedRemoteNetworkBoundary, context), /clientNetworkDenyPassed/);
    const missingRemoteWorkflow = structuredClone(evidence);
    delete missingRemoteWorkflow.workflows.remoteGateway;
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingRemoteWorkflow, context), /remoteGateway/);
    const missingRemoteSecurityReview = structuredClone(evidence);
    delete missingRemoteSecurityReview.securityReview.topics.remoteExposure;
    await assert.rejects(acceptance.validateAcceptanceEvidence(missingRemoteSecurityReview, context), /remoteExposure/);

    await writeFile(remoteRequirementsPath, `${JSON.stringify({ ...remoteRequirements, id: 'weakened-remote-access' }, null, 2)}\n`);
    const weakenedRemoteRequirements = structuredClone(evidence);
    weakenedRemoteRequirements.remoteAccessConformance.requirements.sha256 = await sha256(remoteRequirementsPath);
    await assert.rejects(acceptance.validateAcceptanceEvidence(weakenedRemoteRequirements, context), /exact reviewed requirements/);
    await copyFile(remoteAccess.REMOTE_ACCESS_REQUIREMENTS_PATH, remoteRequirementsPath);

    await writeFile(platformRequirementsPath, `${JSON.stringify({ ...platformRequirements, id: 'weakened-platform-support' }, null, 2)}\n`);
    const weakenedPlatformRequirements = structuredClone(evidence);
    weakenedPlatformRequirements.platformConformance.requirements.sha256 = await sha256(platformRequirementsPath);
    await assert.rejects(acceptance.validateAcceptanceEvidence(weakenedPlatformRequirements, context), /exact reviewed requirements/);

    await writeFile(requirementsPath, `${JSON.stringify({ ...requirements, id: 'weakened-requirements' }, null, 2)}\n`);
    const weakenedRequirements = structuredClone(evidence);
    weakenedRequirements.conformance.requirements.sha256 = await sha256(requirementsPath);
    await assert.rejects(acceptance.validateAcceptanceEvidence(weakenedRequirements, context), /exact reviewed requirements/);
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
  const report = {
    SchemaVersion: 2,
    ArtifactName: '.scan-gateway.oci',
    ArtifactType: 'container_image',
    Metadata: { ImageID: platform.configDigest, DiffIDs: platform.diffIds },
    Results: [],
  };
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

test('filtered Trivy bindings reject mismatched platform config, layers, and diff IDs', async () => {
  const { assertTrivyScanBinding } = await import(pathToFileURL(join(root, 'scripts', 'candidate-evidence.mjs')).href);
  const platform = {
    digest: `sha256:${'1'.repeat(64)}`,
    configDigest: `sha256:${'2'.repeat(64)}`,
    layerDigests: [`sha256:${'3'.repeat(64)}`],
    diffIds: [`sha256:${'4'.repeat(64)}`],
  };
  const report = {
    SchemaVersion: 2,
    ArtifactName: '.scan-gateway-linux-amd64.oci',
    ArtifactType: 'container_image',
    Metadata: {
      ImageID: platform.configDigest,
      DiffIDs: platform.diffIds,
      ImageConfig: {
        os: 'linux',
        architecture: 'amd64',
        rootfs: { type: 'layers', diff_ids: platform.diffIds },
      },
    },
    Results: [],
  };
  const expected = {
    reportName: 'trivy-gateway-linux-amd64.json',
    reportSha256: '5'.repeat(64),
    archiveName: 'qubicl-gateway.oci.tar',
    archiveSha256: '6'.repeat(64),
    image: 'gateway',
    platform: 'linux/amd64',
    bindingSchemaVersion: 2,
    measured: { indexDigest: `sha256:${'7'.repeat(64)}`, platforms: { 'linux/amd64': platform } },
  };
  const binding = {
    report: expected.reportName,
    reportSha256: expected.reportSha256,
    image: expected.image,
    platform: expected.platform,
    ociArchive: expected.archiveName,
    ociArchiveSha256: expected.archiveSha256,
    indexDigest: expected.measured.indexDigest,
    manifestDigest: platform.digest,
    configDigest: platform.configDigest,
    layerDigests: platform.layerDigests,
    diffIds: platform.diffIds,
    platformView: {
      input: report.ArtifactName,
      manifestDigest: platform.digest,
      configDigest: platform.configDigest,
      layerDigests: platform.layerDigests,
      diffIds: platform.diffIds,
    },
    reportIdentity: {
      schemaVersion: 2,
      artifactType: 'container_image',
      imageId: platform.configDigest,
      diffIds: platform.diffIds,
      imageConfig: { os: 'linux', architecture: 'amd64', diffIds: platform.diffIds },
    },
    options: { scanners: ['vuln', 'secret'], input: report.ArtifactName },
  };
  assert.doesNotThrow(() => assertTrivyScanBinding(binding, report, expected));
  assert.throws(() => assertTrivyScanBinding({ ...binding, configDigest: `sha256:${'8'.repeat(64)}` }, report, expected), /manifest, or config digest/);
  assert.throws(() => assertTrivyScanBinding({ ...binding, layerDigests: [`sha256:${'8'.repeat(64)}`] }, report, expected), /layer identity/);
  assert.throws(() => assertTrivyScanBinding({ ...binding, diffIds: [`sha256:${'8'.repeat(64)}`] }, report, expected), /layer identity/);
  assert.throws(() => assertTrivyScanBinding(binding, {
    ...report,
    Metadata: { ...report.Metadata, ImageConfig: { ...report.Metadata.ImageConfig, architecture: 'arm64' } },
  }, expected), /another platform/);
  assert.throws(() => assertTrivyScanBinding({
    ...binding,
    platformView: { ...binding.platformView, layerDigests: [`sha256:${'8'.repeat(64)}`] },
  }, report, expected), /filtered OCI platform view/);
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
  assert.doesNotThrow(() => assertTrivyScannerIdentity({ ...bindings, schemaVersion: 2 }, '2026-08-23T13:00:00.000Z'));
  const stale = structuredClone(bindings);
  stale.scanner.vulnerabilityDatabase.UpdatedAt = '2026-08-20T11:00:00.000Z';
  assert.throws(() => assertTrivyScannerIdentity(stale, '2026-08-23T13:00:00.000Z'), /stale/);
  const unidentified = structuredClone(bindings);
  unidentified.scanner.vulnerabilityDatabase.sha256 = 'unknown';
  assert.throws(() => assertTrivyScannerIdentity(unidentified, '2026-08-23T13:00:00.000Z'), /database identity/);
});

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
