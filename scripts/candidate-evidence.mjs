import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import {
  assertNativeArtifact,
  assertNpmArtifact,
  extractReleaseArchive,
} from './artifact-evidence.mjs';
import { inspectOciArchive } from './oci-evidence.mjs';
export const IMAGE_NAMES = ['gateway', 'file-system', 'browser', 'computer', 'workstation'];
export const PLATFORMS = ['linux/amd64', 'linux/arm64'];
export const RELEASE_TIERS = ['preview', 'initial', 'supported'];
const exec = promisify(execFile);
const PRESETS = IMAGE_NAMES.filter((name) => name !== 'gateway');
const REPORT_PATTERN = /^trivy-(gateway|file-system|browser|computer|workstation)-linux-(amd64|arm64)\.json$/;
const EXCEPTION_KEYS = new Set([
  'id',
  'vulnerabilityId',
  'packageName',
  'installedVersion',
  'images',
  'platforms',
  'applicability',
  'compensatingControls',
  'owner',
  'reviewedBy',
  'reviewedAt',
  'expiresAt',
  'references',
  'browserRisk',
]);
const APPLICABILITY_STATUSES = new Set(['under_investigation', 'not_affected']);
const APPLICABILITY_JUSTIFICATIONS = new Set([
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
]);
const APPLICABILITY_KEYS = new Set([
  'id',
  'status',
  'vulnerabilityIds',
  'packageNames',
  'installedVersion',
  'images',
  'platforms',
  'justification',
  'analysis',
  'evidence',
  'owner',
  'recordedAt',
  'reviewedBy',
  'reviewedAt',
  'expiresAt',
  'references',
]);

export function normalizeRepository(repository) {
  assert(typeof repository === 'string' && repository.length > 0, 'Repository URL is required.');
  return repository.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
}

export function assertCatalogIdentity(catalog, expected) {
  assert(catalog?.schemaVersion === 1, 'Image catalog schemaVersion must be 1.');
  assert(catalog.development === false, 'Candidate artifacts require a non-development image catalog.');
  assert(catalog.releaseVersion === expected.version, `Image catalog releaseVersion ${catalog.releaseVersion} does not match candidate version ${expected.version}.`);
  assert(catalog.revision === expected.revision, `Image catalog revision ${catalog.revision} does not match candidate revision ${expected.revision}.`);
  assert(normalizeRepository(catalog.source) === normalizeRepository(expected.source), `Image catalog source ${catalog.source} does not match candidate source ${expected.source}.`);
  assert(equalArrays(catalog.supportedPlatforms, PLATFORMS), `Image catalog platforms must be exactly ${PLATFORMS.join(', ')}.`);
  assert(catalog.gateway && catalog.presets && typeof catalog.presets === 'object', 'Image catalog is missing gateway or preset entries.');
  assert(equalArrays(Object.keys(catalog.presets).sort(), [...PRESETS].sort()), 'Image catalog must contain exactly the four curated presets.');
  for (const preset of PRESETS) {
    assert(/^[a-f0-9]{64}$/.test(catalog.presets[preset]?.manifestSha256 ?? ''), `Catalog preset ${preset} has no manifest digest.`);
  }
  for (const [name, image] of [['gateway', catalog.gateway], ...PRESETS.map((preset) => [preset, catalog.presets[preset]?.image])]) {
    assert(image && typeof image.requested === 'string' && image.requested.length > 0, `Catalog image ${name} has no requested reference.`);
    assert(/^sha256:[a-f0-9]{64}$/.test(image.indexDigest ?? ''), `Catalog image ${name} has no index digest.`);
    for (const platform of PLATFORMS) {
      const variant = image.platforms?.[platform];
      assert(variant, `Catalog image ${name} has no ${platform} entry.`);
      assert(/^sha256:[a-f0-9]{64}$/.test(variant.digest ?? ''), `Catalog image ${name} ${platform} has no digest.`);
      assert(variant.resolved === `${image.requested.replace(/:[^/@]+$/, '')}@${image.indexDigest}`, `Catalog image ${name} ${platform} is not bound to its exact multi-platform index digest.`);
      assert(Number.isInteger(variant.downloadBytes) && variant.downloadBytes >= 0, `Catalog image ${name} ${platform} has no download size.`);
      assert(Number.isInteger(variant.expandedBytes) && variant.expandedBytes >= 0, `Catalog image ${name} ${platform} has no expanded size.`);
    }
  }
  return catalog;
}

export function parseVulnerabilityExceptions(document) {
  assert(document?.schemaVersion === 1, 'Vulnerability exceptions schemaVersion must be 1.');
  assert(Array.isArray(document.exceptions), 'Vulnerability exceptions must contain an exceptions array.');
  const ids = new Set();
  return document.exceptions.map((entry, index) => {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), `Vulnerability exception ${index} must be an object.`);
    const unexpected = Object.keys(entry).filter((key) => !EXCEPTION_KEYS.has(key));
    assert(unexpected.length === 0, `Vulnerability exception ${entry.id ?? index} has unexpected fields: ${unexpected.join(', ')}.`);
    for (const field of ['id', 'vulnerabilityId', 'packageName', 'installedVersion', 'applicability', 'owner', 'reviewedBy', 'reviewedAt', 'expiresAt']) {
      assert(typeof entry[field] === 'string' && entry[field].trim().length > 0, `Vulnerability exception ${entry.id ?? index} requires ${field}.`);
    }
    assert(/^QVE-\d{4}-\d{3,}$/.test(entry.id), `Vulnerability exception id ${entry.id} must use QVE-YYYY-NNN.`);
    assert(!ids.has(entry.id), `Duplicate vulnerability exception id ${entry.id}.`);
    ids.add(entry.id);
    assert(nonemptyUniqueSubset(entry.images, IMAGE_NAMES), `Vulnerability exception ${entry.id} has invalid images.`);
    assert(nonemptyUniqueSubset(entry.platforms, PLATFORMS), `Vulnerability exception ${entry.id} has invalid platforms.`);
    assert(Array.isArray(entry.compensatingControls) && entry.compensatingControls.length > 0
      && entry.compensatingControls.every(nonemptyString), `Vulnerability exception ${entry.id} requires compensating controls.`);
    assert(Array.isArray(entry.references) && entry.references.length > 0
      && entry.references.every((value) => nonemptyString(value) && value.startsWith('https://')), `Vulnerability exception ${entry.id} requires HTTPS references.`);
    if (entry.browserRisk !== undefined) {
      assert(entry.browserRisk && typeof entry.browserRisk === 'object' && !Array.isArray(entry.browserRisk), `Vulnerability exception ${entry.id} browserRisk must be an object.`);
      assert(entry.browserRisk.hostileInputExposure === true, `Vulnerability exception ${entry.id} must acknowledge hostile browser input.`);
      assert(entry.browserRisk.chromiumSandbox === 'enabled', `Vulnerability exception ${entry.id} must record the enabled Chromium sandbox.`);
      assert(nonemptyString(entry.browserRisk.analysis), `Vulnerability exception ${entry.id} requires browser-risk analysis.`);
    }
    return structuredClone(entry);
  });
}

export function parseVulnerabilityApplicability(document) {
  assert(document?.schemaVersion === 1, 'Vulnerability applicability schemaVersion must be 1.');
  assert(Array.isArray(document.statements), 'Vulnerability applicability must contain a statements array.');
  const ids = new Set();
  return document.statements.map((entry, index) => {
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), `Vulnerability applicability statement ${index} must be an object.`);
    const unexpected = Object.keys(entry).filter((key) => !APPLICABILITY_KEYS.has(key));
    assert(unexpected.length === 0, `Vulnerability applicability statement ${entry.id ?? index} has unexpected fields: ${unexpected.join(', ')}.`);
    for (const field of ['id', 'status', 'installedVersion', 'justification', 'analysis', 'owner', 'recordedAt']) {
      assert(nonemptyString(entry[field]), `Vulnerability applicability statement ${entry.id ?? index} requires ${field}.`);
    }
    assert(/^QVA-\d{4}-\d{3,}$/.test(entry.id), `Vulnerability applicability id ${entry.id} must use QVA-YYYY-NNN.`);
    assert(!ids.has(entry.id), `Duplicate vulnerability applicability id ${entry.id}.`);
    ids.add(entry.id);
    assert(APPLICABILITY_STATUSES.has(entry.status), `Vulnerability applicability statement ${entry.id} has invalid status ${entry.status}.`);
    assert(nonemptyUniqueValues(entry.vulnerabilityIds, /^CVE-\d{4}-\d{4,}$/), `Vulnerability applicability statement ${entry.id} has invalid vulnerability IDs.`);
    assert(nonemptyUniqueValues(entry.packageNames, /^[A-Za-z0-9][A-Za-z0-9+.-]*$/), `Vulnerability applicability statement ${entry.id} has invalid package names.`);
    assert(entry.vulnerabilityIds.length === 1 || entry.packageNames.length === 1, `Vulnerability applicability statement ${entry.id} cannot create a many-to-many CVE/package match.`);
    assert(nonemptyUniqueSubset(entry.images, IMAGE_NAMES), `Vulnerability applicability statement ${entry.id} has invalid images.`);
    assert(nonemptyUniqueSubset(entry.platforms, PLATFORMS), `Vulnerability applicability statement ${entry.id} has invalid platforms.`);
    assert(APPLICABILITY_JUSTIFICATIONS.has(entry.justification), `Vulnerability applicability statement ${entry.id} has invalid justification ${entry.justification}.`);
    assert(Array.isArray(entry.evidence) && entry.evidence.length > 0
      && entry.evidence.every(nonemptyString), `Vulnerability applicability statement ${entry.id} requires evidence.`);
    assert(Array.isArray(entry.references) && entry.references.length > 0
      && entry.references.every((value) => nonemptyString(value) && value.startsWith('https://')), `Vulnerability applicability statement ${entry.id} requires HTTPS references.`);
    if (entry.status === 'not_affected') {
      for (const field of ['reviewedBy', 'reviewedAt', 'expiresAt']) {
        assert(nonemptyString(entry[field]), `Not-affected applicability statement ${entry.id} requires ${field}.`);
      }
      assert(entry.reviewedBy.trim().toLowerCase() !== entry.owner.trim().toLowerCase(), `Not-affected applicability statement ${entry.id} requires an independent reviewer.`);
    } else {
      for (const field of ['reviewedBy', 'reviewedAt', 'expiresAt']) {
        assert(entry[field] === undefined, `Under-investigation applicability statement ${entry.id} cannot claim ${field}.`);
      }
    }
    return structuredClone(entry);
  });
}

export function assertTrivyReportPrivacy(document, expectedInput) {
  const artifactName = normalizeScanInputPath(document?.ArtifactName);
  assert(artifactName === expectedInput, `Trivy ArtifactName must be the relative input ${expectedInput}; found ${document?.ArtifactName}.`);
  for (const result of document.Results ?? []) {
    if (typeof result.Target !== 'string') continue;
    const target = normalizeScanTarget(result.Target.split(' (')[0]);
    if (target.includes('.scan-')) assert(target === expectedInput, `Trivy Target exposes a non-relative scan path: ${result.Target}.`);
  }
}

export function summarizeTrivyReports(reportEntries, exceptionsDocument, {
  evaluatedAt = new Date().toISOString(),
  exceptionName = 'vulnerability-exceptions.json',
  exceptionSha256,
  applicabilityDocument = { schemaVersion: 1, statements: [] },
  applicabilityName = 'vulnerability-applicability.json',
  applicabilitySha256,
  releaseTier = 'supported',
} = {}) {
  assert(RELEASE_TIERS.includes(releaseTier), `Unsupported release tier ${releaseTier}.`);
  const exceptions = parseVulnerabilityExceptions(exceptionsDocument);
  const applicabilityStatements = parseVulnerabilityApplicability(applicabilityDocument);
  validateExceptionDates(exceptions, evaluatedAt);
  validateApplicabilityDates(applicabilityStatements, evaluatedAt);
  const reports = [];
  const usedExceptionScopes = new Set();
  const usedExceptions = new Set();
  const usedApplicabilityScopes = new Set();
  const usedApplicabilityStatements = new Set();
  const secretFailures = [];
  const findingFailures = new Map();
  const trackedFindings = new Map();
  const notAffectedFindings = new Map();

  assert(reportEntries.length === IMAGE_NAMES.length * PLATFORMS.length, `Expected ten Trivy reports; found ${reportEntries.length}.`);

  for (const { name, document } of [...reportEntries].sort((left, right) => left.name.localeCompare(right.name))) {
    const identity = reportIdentity(name);
    assertTrivyReportPrivacy(document, `.scan-${identity.image}.oci`);
    const results = document.Results ?? [];
    const vulnerabilities = results.flatMap((result) => result.Vulnerabilities ?? []);
    const secrets = results.flatMap((result) => (result.Secrets ?? []).map((secret) => ({
      rule: secret.RuleID ?? secret.Category ?? 'unknown-rule',
      target: result.Target ?? 'unknown-target',
    })));
    if (secrets.length > 0) secretFailures.push({ name, secrets });
    const highCritical = vulnerabilities.filter((finding) => ['HIGH', 'CRITICAL'].includes(finding.Severity));
    let reviewedExceptionHighCritical = 0;
    let notAffectedHighCritical = 0;
    let trackedUnfixedHighCritical = 0;
    for (const finding of highCritical) {
      const exceptionMatchesForFinding = exceptions.filter((exception) => exceptionMatches(exception, finding, identity));
      const applicabilityMatchesForFinding = applicabilityStatements.filter((statement) => applicabilityMatches(statement, finding, identity));
      const matchingRecords = [
        ...exceptionMatchesForFinding.map((entry) => entry.id),
        ...applicabilityMatchesForFinding.map((entry) => entry.id),
      ];
      const applicability = applicabilityMatchesForFinding[0];
      const underInvestigation = applicability?.status === 'under_investigation';
      const fixedVersion = nonemptyString(finding.FixedVersion) ? finding.FixedVersion.trim() : undefined;
      const blocking = matchingRecords.length > 1
        || (matchingRecords.length === 0 && (releaseTier === 'supported' || fixedVersion))
        || (underInvestigation && (releaseTier === 'supported' || fixedVersion));
      if (blocking) {
        const key = JSON.stringify([
          finding.VulnerabilityID,
          finding.PkgName,
          finding.InstalledVersion,
          matchingRecords,
          fixedVersion,
        ]);
        const failure = findingFailures.get(key) ?? {
          vulnerabilityId: finding.VulnerabilityID ?? 'unknown-vulnerability',
          packageName: finding.PkgName ?? 'unknown-package',
          installedVersion: finding.InstalledVersion ?? 'unknown-version',
          severity: finding.Severity ?? 'UNKNOWN',
          ...(fixedVersion ? { fixedVersion } : {}),
          matchingRecords,
          ...(underInvestigation ? { underInvestigation: applicability.id } : {}),
          scopes: new Set(),
        };
        failure.scopes.add(`${identity.image} ${identity.platform}`);
        findingFailures.set(key, failure);
        continue;
      }
      if (exceptionMatchesForFinding.length === 1) {
        reviewedExceptionHighCritical += 1;
        usedExceptions.add(exceptionMatchesForFinding[0].id);
        usedExceptionScopes.add(`${exceptionMatchesForFinding[0].id}|${identity.image}|${identity.platform}`);
        continue;
      }
      if (applicability?.status === 'not_affected') {
        notAffectedHighCritical += 1;
        usedApplicabilityStatements.add(applicability.id);
        usedApplicabilityScopes.add(applicabilityScopeKey(applicability.id, finding, identity));
        const key = findingKey(finding);
        const recorded = notAffectedFindings.get(key) ?? findingRecord(finding, {
          applicability: { id: applicability.id, status: applicability.status, justification: applicability.justification },
        });
        recorded.scopes.add(`${identity.image} ${identity.platform}`);
        notAffectedFindings.set(key, recorded);
        continue;
      }
      trackedUnfixedHighCritical += 1;
      if (applicability) {
        usedApplicabilityStatements.add(applicability.id);
        usedApplicabilityScopes.add(applicabilityScopeKey(applicability.id, finding, identity));
      }
      const key = findingKey(finding);
      const tracked = trackedFindings.get(key) ?? findingRecord(finding, applicability ? {
        applicability: { id: applicability.id, status: applicability.status },
      } : {});
      tracked.scopes.add(`${identity.image} ${identity.platform}`);
      trackedFindings.set(key, tracked);
    }
    reports.push({
      name,
      vulnerabilities: vulnerabilities.length,
      uniqueVulnerabilities: new Set(vulnerabilities.map((finding) => finding.VulnerabilityID)).size,
      severities: countBy(vulnerabilities, (finding) => finding.Severity ?? 'UNKNOWN'),
      highCritical: highCritical.length,
      uniqueHighCritical: new Set(highCritical.map((finding) => finding.VulnerabilityID)).size,
      acceptedHighCritical: reviewedExceptionHighCritical + notAffectedHighCritical,
      reviewedHighCritical: reviewedExceptionHighCritical,
      reviewedExceptionHighCritical,
      notAffectedHighCritical,
      trackedUnfixedHighCritical,
      fixAvailableHighCritical: highCritical.filter((finding) => nonemptyString(finding.FixedVersion)).length,
      secrets: secrets.length,
    });
  }

  if (secretFailures.length > 0 || findingFailures.size > 0) {
    const lines = [];
    for (const failure of secretFailures) {
      const details = failure.secrets.map(({ rule, target }) => `${rule} at ${target}`).join(', ');
      lines.push(`${failure.name}: ${failure.secrets.length} secret finding(s): ${details}`);
    }
    for (const failure of [...findingFailures.values()].sort((left, right) =>
      `${left.vulnerabilityId}\0${left.packageName}\0${left.installedVersion}`.localeCompare(`${right.vulnerabilityId}\0${right.packageName}\0${right.installedVersion}`))) {
      const reason = failure.matchingRecords.length > 1
        ? `has overlapping review records ${failure.matchingRecords.join(', ')}; expected at most one`
        : failure.underInvestigation
          ? `has applicability statement ${failure.underInvestigation} still under investigation`
          : failure.fixedVersion
            ? `has scanner-reported fix ${failure.fixedVersion} but no current reviewed exception or not-affected statement`
            : 'has no current reviewed exception or not-affected statement';
      lines.push(`${failure.vulnerabilityId} in ${failure.packageName}@${failure.installedVersion} ${reason} across ${[...failure.scopes].sort().join(', ')}`);
    }
    throw new Error(`Trivy ${releaseTier} policy rejected all reports with ${secretFailures.reduce((total, failure) => total + failure.secrets.length, 0)} secret finding(s) and ${findingFailures.size} blocking exact vulnerability finding(s):\n- ${lines.join('\n- ')}`);
  }

  for (const exception of exceptions) {
    assert(usedExceptions.has(exception.id), `Vulnerability exception ${exception.id} is unused.`);
    for (const image of exception.images) {
      for (const platform of exception.platforms) {
        assert(usedExceptionScopes.has(`${exception.id}|${image}|${platform}`), `Vulnerability exception ${exception.id} has unused scope ${image} ${platform}.`);
      }
    }
  }
  for (const statement of applicabilityStatements) {
    assert(usedApplicabilityStatements.has(statement.id), `Vulnerability applicability statement ${statement.id} is unused.`);
    for (const vulnerabilityId of statement.vulnerabilityIds) {
      for (const packageName of statement.packageNames) {
        for (const image of statement.images) {
          for (const platform of statement.platforms) {
            const key = applicabilityScopeKey(statement.id, {
              VulnerabilityID: vulnerabilityId,
              PkgName: packageName,
              InstalledVersion: statement.installedVersion,
            }, { image, platform });
            assert(usedApplicabilityScopes.has(key), `Vulnerability applicability statement ${statement.id} has unused scope ${vulnerabilityId} ${packageName}@${statement.installedVersion} ${image} ${platform}.`);
          }
        }
      }
    }
  }

  return {
    schemaVersion: 4,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    policy: {
      passed: true,
      releaseTier,
      verdict: releaseTier === 'preview'
        ? 'preview-only'
        : releaseTier === 'initial'
          ? 'initial-release'
          : 'supported-candidate',
      expectedReports: IMAGE_NAMES.length * PLATFORMS.length,
      failOn: releaseTier !== 'supported'
        ? ['secrets', 'HIGH/CRITICAL vulnerabilities with a scanner-reported fix', 'ambiguous vulnerability review records', 'expired vulnerability review records']
        : ['secrets', 'unreviewed HIGH vulnerabilities', 'unreviewed CRITICAL vulnerabilities', 'expired vulnerability review records'],
      trackedUnfixedHighCritical: trackedFindings.size,
      notAffectedHighCritical: notAffectedFindings.size,
    },
    exceptions: {
      name: exceptionName,
      ...(exceptionSha256 ? { sha256: exceptionSha256 } : {}),
      total: exceptions.length,
      matched: usedExceptions.size,
    },
    applicability: {
      name: applicabilityName,
      ...(applicabilitySha256 ? { sha256: applicabilitySha256 } : {}),
      total: applicabilityStatements.length,
      matched: usedApplicabilityStatements.size,
      notAffected: applicabilityStatements.filter(({ status }) => status === 'not_affected').length,
      underInvestigation: applicabilityStatements.filter(({ status }) => status === 'under_investigation').length,
    },
    notAffectedFindings: serializedFindings(notAffectedFindings),
    trackedFindings: serializedFindings(trackedFindings),
    reports,
  };
}

export async function describeFiles(directory) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const details = await stat(path);
    if (details.isFile()) files.push({ name, bytes: details.size, sha256: await sha256(path) });
  }
  return files;
}

export async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

export async function verifyCandidateDirectory(directory, { root, inspectOci = true, now = new Date().toISOString() } = {}) {
  const candidateDirectory = resolve(directory);
  const entries = await readdir(candidateDirectory, { withFileTypes: true });
  assert(entries.every((entry) => entry.isFile()), 'Candidate directories may contain regular files only.');
  const names = entries.map((entry) => entry.name).sort();
  assert(names.includes('candidate.json') && names.includes('SHA256SUMS'), 'Candidate directory is missing candidate.json or SHA256SUMS.');

  const candidate = await jsonFile(join(candidateDirectory, 'candidate.json'));
  assertCandidateManifest(candidate);
  const checksumEntries = parseChecksums(await readFile(join(candidateDirectory, 'SHA256SUMS'), 'utf8'));
  assert(equalArrays([...checksumEntries.keys()].sort(), names.filter((name) => name !== 'SHA256SUMS')), 'SHA256SUMS must cover every candidate file except itself.');
  for (const [name, expected] of checksumEntries) {
    assert(await sha256(join(candidateDirectory, name)) === expected, `Checksum mismatch for ${name}.`);
  }

  const expectedArtifacts = expectedArtifactNames(candidate).sort();
  const manifestArtifacts = candidate.artifacts.map((artifact) => artifact.name).sort();
  assert(equalArrays(manifestArtifacts, expectedArtifacts), 'candidate.json artifact names do not match the mode-specific candidate contract.');
  assert(equalArrays(expectedArtifacts, names.filter((name) => !['candidate.json', 'SHA256SUMS'].includes(name))), 'Candidate directory has missing or extra artifacts.');
  for (const artifact of candidate.artifacts) {
    assert(safeName(artifact.name), `Unsafe artifact name ${artifact.name}.`);
    const details = await stat(join(candidateDirectory, artifact.name));
    assert(details.size === artifact.bytes, `Artifact size mismatch for ${artifact.name}.`);
    assert(await sha256(join(candidateDirectory, artifact.name)) === artifact.sha256, `Artifact hash mismatch for ${artifact.name}.`);
  }

  const catalogPath = join(candidateDirectory, 'image-catalog.json');
  assert(await sha256(catalogPath) === candidate.imageCatalog.sha256, 'candidate.json image-catalog hash does not match.');
  const expectedCatalogText = await readFile(catalogPath, 'utf8');
  const catalog = assertCatalogIdentity(JSON.parse(expectedCatalogText), candidate);
  const dependencyEvidencePath = join(candidateDirectory, 'dependency-evidence.json');
  assert(await sha256(dependencyEvidencePath) === candidate.dependencies.sha256, 'candidate.json dependency-evidence hash does not match.');
  await assertDependencyEvidence(await jsonFile(dependencyEvidencePath), candidate, root);

  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-candidate-verify-'));
  try {
    let npmRoot;
    if (!candidate.modes.binaryOnly) {
      assert(root, 'npm candidate verification requires the reviewed repository root.');
      const npmArchive = join(candidateDirectory, `qubicl-cli-${candidate.version}.tgz`);
      npmRoot = join(temporary, 'npm', 'package');
      const npmEntries = await extractReleaseArchive(npmArchive, join(temporary, 'npm'), 'package');
      await assertNpmArtifact({
        archive: npmArchive,
        root: npmRoot,
        entries: npmEntries,
        version: candidate.version,
        revision: candidate.revision,
        source: candidate.source,
        expectedCatalogText,
        expectedSbomPath: join(candidateDirectory, 'qubicl-npm.spdx.json'),
        expectedManifest: await jsonFile(join(root, 'packages', 'cli', 'package.json')),
      });
    }

    const nativeArchive = join(candidateDirectory, `qubicl-${candidate.version}-${candidate.host.target}.tar.gz`);
    const nativeParent = join(temporary, 'native');
    const nativeArchiveRoot = `qubicl-${candidate.host.target}`;
    const nativeRoot = join(nativeParent, nativeArchiveRoot);
    const nativeEntries = await extractReleaseArchive(nativeArchive, nativeParent, nativeArchiveRoot);
    await assertNativeArtifact({
      archive: nativeArchive,
      root: nativeRoot,
      entries: nativeEntries,
      target: candidate.host.target,
      version: candidate.version,
      revision: candidate.revision,
      source: candidate.source,
      nodeVersion: candidate.tools.node.replace(/^v/, ''),
      expectedCatalogText,
      expectedSbomPath: join(candidateDirectory, `qubicl-${candidate.version}-${candidate.host.target}.spdx.json`),
    });

    if (candidate.modes.images) {
      assert(npmRoot, 'Image candidates require an npm artifact containing expected preset manifests.');
      if (inspectOci) {
        assert(root, 'OCI inspection requires the repository root.');
        for (const image of IMAGE_NAMES) {
          const measured = await inspectOciArchive(join(candidateDirectory, `qubicl-${image}.oci.tar`), {
            expectedVersion: candidate.version,
            expectedRevision: candidate.revision,
            expectedSource: candidate.source,
            expectedPreset: image === 'gateway' ? undefined : image,
            expectedManifestPath: image === 'gateway'
              ? undefined
              : join(npmRoot, 'dist', 'assets', 'computer', 'manifests', `${image}.json`),
            requireAttestations: true,
          });
          const expectedImage = image === 'gateway' ? catalog.gateway : catalog.presets[image].image;
          assert(measured.indexDigest === expectedImage.indexDigest, `${image} OCI index digest does not match image-catalog.json.`);
          for (const platform of PLATFORMS) {
            const actual = measured.platforms[platform];
            const expected = expectedImage.platforms[platform];
            assert(actual.digest === expected.digest
              && actual.downloadBytes === expected.downloadBytes
              && actual.expandedBytes === expected.expandedBytes, `${image} ${platform} OCI digest or size does not match image-catalog.json.`);
          }
        }
      }
    }

    if (candidate.modes.scans) {
      const exceptionPath = join(candidateDirectory, 'vulnerability-exceptions.json');
      const exceptions = await jsonFile(exceptionPath);
      const applicabilityPath = join(candidateDirectory, 'vulnerability-applicability.json');
      const applicability = await jsonFile(applicabilityPath);
      const summary = await jsonFile(join(candidateDirectory, 'trivy-summary.json'));
      const bindings = await jsonFile(join(candidateDirectory, 'trivy-bindings.json'));
      const reportEntries = await Promise.all(IMAGE_NAMES.flatMap((image) => PLATFORMS.map(async (platform) => {
        const name = `trivy-${image}-${platform.replace('/', '-')}.json`;
        return { name, document: await jsonFile(join(candidateDirectory, name)) };
      })));
      assertTrivyScannerIdentity(bindings, now);
      assert(Array.isArray(bindings.scans) && bindings.scans.length === reportEntries.length, 'trivy-bindings.json has incomplete scan coverage.');
      for (const report of reportEntries) {
        const identity = reportIdentity(report.name);
        const binding = bindings.scans.find(({ report: name }) => name === report.name);
        assert(binding, `trivy-bindings.json lacks ${report.name}.`);
        const archive = join(candidateDirectory, `qubicl-${identity.image}.oci.tar`);
        const measured = await inspectOciArchive(archive, { requireAttestations: true });
        assertTrivyScanBinding(binding, report.document, {
          reportName: report.name,
          reportSha256: await sha256(join(candidateDirectory, report.name)),
          archiveName: basename(archive),
          archiveSha256: await sha256(archive),
          image: identity.image,
          platform: identity.platform,
          measured,
        });
      }
      const expectedSummary = summarizeTrivyReports(reportEntries, exceptions, {
        evaluatedAt: summary.evaluatedAt,
        exceptionSha256: await sha256(exceptionPath),
        applicabilityDocument: applicability,
        applicabilitySha256: await sha256(applicabilityPath),
        releaseTier: candidate.releaseTier,
      });
      assert(canonicalJson(summary) === canonicalJson(expectedSummary), 'trivy-summary.json does not match the retained reports and vulnerability review records.');
      assert(canonicalJson(candidate.security) === canonicalJson(summary), 'candidate.json security summary does not match trivy-summary.json.');
      summarizeTrivyReports(reportEntries, exceptions, {
        evaluatedAt: now,
        exceptionSha256: await sha256(exceptionPath),
        applicabilityDocument: applicability,
        applicabilitySha256: await sha256(applicabilityPath),
        releaseTier: candidate.releaseTier,
      });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  return { candidate, catalog, files: names };
}

async function assertDependencyEvidence(evidence, candidate, root) {
  assert(evidence?.schemaVersion === 1 && evidence.source?.revision === candidate.revision && evidence.source?.clean === true, 'Dependency evidence does not identify a clean archive of the candidate revision.');
  assert(/^[a-f0-9]{64}$/u.test(evidence.source?.archiveSha256 ?? ''), 'Dependency evidence lacks the source-archive SHA-256.');
  assert(canonicalJson(evidence.install?.command) === canonicalJson(['npm', 'ci']), 'Candidate dependencies were not installed with npm ci.');
  assert(evidence.install?.npm === candidate.tools.npm, 'Dependency evidence npm version does not match the candidate toolchain.');
  const registry = new URL(evidence.install?.registry ?? 'invalid:');
  assert(registry.protocol === 'https:' && !registry.username && !registry.password, 'Dependency evidence registry must be credential-free HTTPS.');
  assert(root, 'Dependency verification requires the reviewed repository root.');
  assert(evidence.install?.lockfileSha256 === await sha256(join(root, 'package-lock.json')), 'Dependency evidence lockfile does not match reviewed source.');
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-source-archive-'));
  try {
    const archive = join(temporary, 'source.tar');
    await exec('git', ['archive', '--format=tar', '--output', archive, candidate.revision], { cwd: root, maxBuffer: 20_000_000 });
    assert(evidence.source.archiveSha256 === await sha256(archive), 'Dependency evidence source archive does not match the reviewed Git revision.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  assert(evidence.inventory?.name === 'qubicl-workspace' && evidence.inventory?.version === candidate.version, 'Dependency inventory does not describe this workspace.');
  assert((evidence.audit?.metadata?.vulnerabilities?.high ?? 0) === 0 && (evidence.audit?.metadata?.vulnerabilities?.critical ?? 0) === 0, 'Candidate dependency audit contains HIGH or CRITICAL findings.');
  assert(Array.isArray(evidence.signatures?.invalid) && evidence.signatures.invalid.length === 0
    && Array.isArray(evidence.signatures?.missing) && evidence.signatures.missing.length === 0,
  'Candidate dependency signature verification is incomplete or failed.');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function assertTrivyScanBinding(binding, report, expected) {
  const platform = expected.measured.platforms[expected.platform];
  assert(binding.report === expected.reportName && binding.reportSha256 === expected.reportSha256, 'Trivy binding does not identify the exact report bytes.');
  assert(binding.image === expected.image && binding.platform === expected.platform, 'Trivy binding has the wrong image or platform.');
  assert(binding.ociArchive === expected.archiveName && binding.ociArchiveSha256 === expected.archiveSha256, 'Trivy binding does not identify the exact OCI archive bytes.');
  assert(binding.indexDigest === expected.measured.indexDigest && binding.manifestDigest === platform.digest
    && binding.configDigest === platform.configDigest, 'Trivy binding has the wrong OCI index, manifest, or config digest.');
  assert(canonicalJson(binding.layerDigests) === canonicalJson(platform.layerDigests)
    && canonicalJson(binding.diffIds) === canonicalJson(platform.diffIds), 'Trivy binding has the wrong OCI layer identity.');
  assert(binding.reportIdentity?.schemaVersion === 2 && report.SchemaVersion === 2, 'Trivy report schemaVersion must be 2.');
  assert(binding.reportIdentity?.artifactType === 'container_image' && report.ArtifactType === 'container_image', 'Trivy report must describe a container image.');
  assert(report.Metadata?.ImageID === platform.configDigest && binding.reportIdentity.imageId === report.Metadata.ImageID, 'Trivy report ImageID does not match the OCI config digest.');
  assert(canonicalJson(report.Metadata?.DiffIDs) === canonicalJson(platform.diffIds)
    && canonicalJson(binding.reportIdentity.diffIds) === canonicalJson(report.Metadata.DiffIDs), 'Trivy report DiffIDs do not match the OCI config.');
  assert(canonicalJson(binding.options) === canonicalJson({ scanners: ['vuln', 'secret'], input: `.scan-${expected.image}.oci` }), 'Trivy binding has unexpected scan options.');
}

export function assertTrivyScannerIdentity(bindings, now) {
  const scanner = bindings?.scanner;
  const database = scanner?.vulnerabilityDatabase;
  assert(bindings?.schemaVersion === 1 && isoDate(bindings.createdAt), 'trivy-bindings.json has an invalid schema or creation time.');
  assert(scanner?.name === 'trivy' && /^\d+\.\d+\.\d+$/u.test(scanner.version ?? '')
    && /^[a-f0-9]{64}$/u.test(scanner.versionOutputSha256 ?? ''), 'trivy-bindings.json has an invalid scanner identity.');
  assert(Number.isInteger(database?.Version) && isoDate(database?.UpdatedAt) && isoDate(database?.DownloadedAt)
    && isoDate(database?.NextUpdate) && /^[a-f0-9]{64}$/u.test(database?.sha256 ?? ''), 'trivy-bindings.json has an invalid vulnerability database identity.');
  const evaluated = Date.parse(now);
  const updated = Date.parse(database.UpdatedAt);
  assert(updated <= Date.parse(bindings.createdAt) && evaluated - updated <= 48 * 60 * 60 * 1000, 'Trivy vulnerability database is stale or postdates the scan binding.');
  assert(/^sha256:[a-f0-9]{64}$/u.test(scanner.checkBundle?.Digest ?? '') && isoDate(scanner.checkBundle?.DownloadedAt), 'trivy-bindings.json has an invalid checks bundle identity.');
}

function isoDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function validateExceptionDates(exceptions, evaluatedAt) {
  const evaluation = new Date(evaluatedAt);
  assert(Number.isFinite(evaluation.getTime()), `Invalid vulnerability evaluation time ${evaluatedAt}.`);
  for (const exception of exceptions) {
    const reviewed = new Date(exception.reviewedAt);
    const expires = new Date(exception.expiresAt);
    assert(Number.isFinite(reviewed.getTime()) && Number.isFinite(expires.getTime()), `Vulnerability exception ${exception.id} has invalid review or expiry timestamps.`);
    assert(reviewed <= evaluation, `Vulnerability exception ${exception.id} has not been reviewed yet.`);
    assert(evaluation < expires, `Vulnerability exception ${exception.id} expired at ${exception.expiresAt}.`);
    assert(reviewed < expires, `Vulnerability exception ${exception.id} expires before review.`);
    const browserFinding = /chromium/i.test(exception.packageName) && exception.images.some((image) => ['browser', 'computer', 'workstation'].includes(image));
    const maximumDays = browserFinding ? 30 : 90;
    assert(expires.getTime() - reviewed.getTime() <= maximumDays * 86_400_000, `Vulnerability exception ${exception.id} exceeds the ${maximumDays}-day review window.`);
    if (browserFinding) assert(exception.browserRisk, `Chromium exception ${exception.id} requires browserRisk review.`);
  }
}

function validateApplicabilityDates(statements, evaluatedAt) {
  const evaluation = new Date(evaluatedAt);
  assert(Number.isFinite(evaluation.getTime()), `Invalid vulnerability evaluation time ${evaluatedAt}.`);
  for (const statement of statements) {
    const recorded = new Date(statement.recordedAt);
    assert(Number.isFinite(recorded.getTime()), `Vulnerability applicability statement ${statement.id} has an invalid recordedAt timestamp.`);
    assert(recorded <= evaluation, `Vulnerability applicability statement ${statement.id} has not been recorded yet.`);
    if (statement.status !== 'not_affected') continue;
    const reviewed = new Date(statement.reviewedAt);
    const expires = new Date(statement.expiresAt);
    assert(Number.isFinite(reviewed.getTime()) && Number.isFinite(expires.getTime()), `Vulnerability applicability statement ${statement.id} has invalid review or expiry timestamps.`);
    assert(recorded <= reviewed, `Vulnerability applicability statement ${statement.id} was reviewed before it was recorded.`);
    assert(reviewed <= evaluation, `Vulnerability applicability statement ${statement.id} has not been reviewed yet.`);
    assert(evaluation < expires, `Vulnerability applicability statement ${statement.id} expired at ${statement.expiresAt}.`);
    assert(reviewed < expires, `Vulnerability applicability statement ${statement.id} expires before review.`);
    assert(expires.getTime() - reviewed.getTime() <= 90 * 86_400_000, `Vulnerability applicability statement ${statement.id} exceeds the 90-day review window.`);
  }
}

function exceptionMatches(exception, finding, identity) {
  return exception.vulnerabilityId === finding.VulnerabilityID
    && exception.packageName === finding.PkgName
    && exception.installedVersion === finding.InstalledVersion
    && exception.images.includes(identity.image)
    && exception.platforms.includes(identity.platform);
}

function applicabilityMatches(statement, finding, identity) {
  return statement.vulnerabilityIds.includes(finding.VulnerabilityID)
    && statement.packageNames.includes(finding.PkgName)
    && statement.installedVersion === finding.InstalledVersion
    && statement.images.includes(identity.image)
    && statement.platforms.includes(identity.platform);
}

function applicabilityScopeKey(id, finding, identity) {
  return [id, finding.VulnerabilityID, finding.PkgName, finding.InstalledVersion, identity.image, identity.platform].join('|');
}

function findingKey(finding) {
  return JSON.stringify([
    finding.VulnerabilityID,
    finding.PkgName,
    finding.InstalledVersion,
    finding.Severity,
  ]);
}

function findingRecord(finding, extra = {}) {
  return {
    vulnerabilityId: finding.VulnerabilityID ?? 'unknown-vulnerability',
    packageName: finding.PkgName ?? 'unknown-package',
    installedVersion: finding.InstalledVersion ?? 'unknown-version',
    severity: finding.Severity ?? 'UNKNOWN',
    ...extra,
    scopes: new Set(),
  };
}

function serializedFindings(findings) {
  return [...findings.values()]
    .sort((left, right) => `${left.vulnerabilityId}\0${left.packageName}\0${left.installedVersion}`.localeCompare(`${right.vulnerabilityId}\0${right.packageName}\0${right.installedVersion}`))
    .map((finding) => ({ ...finding, scopes: [...finding.scopes].sort() }));
}

function reportIdentity(name) {
  const match = name.match(REPORT_PATTERN);
  assert(match, `Unexpected Trivy report name ${name}.`);
  return { image: match[1], platform: `linux/${match[2]}` };
}

function normalizeScanInputPath(value) {
  assert(typeof value === 'string' && value.length > 0, 'Trivy report has no ArtifactName.');
  assert(!isAbsolute(value) && !win32.isAbsolute(value), `Trivy scan path must be relative: ${value}.`);
  const normalized = value.replaceAll('\\', '/');
  assert(!normalized.split('/').includes('..'), `Trivy scan path may not traverse parents: ${value}.`);
  return normalized.replace(/^\.\//, '');
}

function normalizeScanTarget(value) {
  assert(typeof value === 'string' && value.length > 0, 'Trivy result has no Target.');
  assert(!win32.isAbsolute(value) || isAbsolute(value), `Trivy Target exposes an absolute builder path: ${value}.`);
  const normalized = value.replaceAll('\\', '/');
  assert(!normalized.split('/').includes('..'), `Trivy Target may not traverse parents: ${value}.`);
  // Trivy reports package and secret locations as absolute paths inside the
  // scanned image (for example /etc/ssh/ssh_host_ecdsa_key). Those are image
  // metadata, not builder paths. Only the temporary .scan-* input must remain
  // relative so candidate reports cannot disclose the host staging directory.
  return normalized.startsWith('/') ? normalized : normalized.replace(/^\.\//, '');
}

function assertCandidateManifest(candidate) {
  assert(candidate?.schemaVersion === 5, 'candidate.json schemaVersion must be 5.');
  for (const field of ['version', 'revision', 'created', 'source']) assert(nonemptyString(candidate[field]), `candidate.json requires ${field}.`);
  assert(RELEASE_TIERS.includes(candidate.releaseTier), 'candidate.json requires a supported release tier.');
  assert(candidate.releaseTier !== 'preview' || candidate.version.includes('-'), 'Preview candidates require a prerelease version.');
  assert(candidate.releaseTier !== 'initial' || /^0\.[0-9]+\.[0-9]+$/.test(candidate.version), 'Initial-release candidates require a stable pre-1.0 version.');
  assert(candidate.host && nonemptyString(candidate.host.target), 'candidate.json requires a host target.');
  assert(candidate.tools && /^v[0-9]+[.][0-9]+[.][0-9]+$/.test(candidate.tools.node ?? ''), 'candidate.json requires the exact Node tool version.');
  assert(candidate.dependencies?.name === 'dependency-evidence.json' && /^[a-f0-9]{64}$/u.test(candidate.dependencies?.sha256 ?? ''), 'candidate.json requires exact dependency evidence.');
  assert(candidate.modes && typeof candidate.modes.binaryOnly === 'boolean'
    && typeof candidate.modes.images === 'boolean'
    && typeof candidate.modes.scans === 'boolean'
    && typeof candidate.modes.exactArtifactAcceptance === 'boolean', 'candidate.json has invalid modes.');
  assert(!candidate.modes.scans || candidate.modes.images, 'Candidate scans require image candidates.');
  assert(Array.isArray(candidate.artifacts) && candidate.artifacts.every((entry) => safeName(entry.name)
    && Number.isInteger(entry.bytes) && /^[a-f0-9]{64}$/.test(entry.sha256)), 'candidate.json has invalid artifacts.');
  assert(new Set(candidate.artifacts.map((entry) => entry.name)).size === candidate.artifacts.length, 'candidate.json has duplicate artifacts.');
}

function expectedArtifactNames(candidate) {
  const names = [
    'image-catalog.json',
    'dependency-evidence.json',
    `qubicl-${candidate.version}-${candidate.host.target}.tar.gz`,
    `qubicl-${candidate.version}-${candidate.host.target}.spdx.json`,
  ];
  if (!candidate.modes.binaryOnly) names.push(`qubicl-cli-${candidate.version}.tgz`, 'qubicl-npm.spdx.json');
  if (candidate.modes.images) names.push(...IMAGE_NAMES.map((name) => `qubicl-${name}.oci.tar`));
  if (candidate.modes.scans) {
    names.push(
      'trivy-summary.json',
      'trivy-bindings.json',
      'vulnerability-applicability.json',
      'vulnerability-exceptions.json',
      ...IMAGE_NAMES.flatMap((image) => PLATFORMS.map((platform) => `trivy-${image}-${platform.replace('/', '-')}.json`)),
    );
  }
  return names;
}

function parseChecksums(contents) {
  const entries = new Map();
  for (const line of contents.trimEnd().split('\n')) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/);
    assert(match && safeName(match[2]), `Invalid SHA256SUMS line ${JSON.stringify(line)}.`);
    assert(!entries.has(match[2]), `Duplicate SHA256SUMS entry ${match[2]}.`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && basename(name) === name;
}

function countBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = keyFor(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function nonemptyUniqueSubset(values, allowed) {
  return Array.isArray(values) && values.length > 0 && values.every((value) => allowed.includes(value))
    && new Set(values).size === values.length;
}

function nonemptyUniqueValues(values, pattern) {
  return Array.isArray(values) && values.length > 0
    && values.every((value) => nonemptyString(value) && pattern.test(value))
    && new Set(values).size === values.length;
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function equalArrays(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
