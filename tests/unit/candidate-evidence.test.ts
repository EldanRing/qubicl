import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = process.cwd();
const evidenceModule = pathToFileURL(join(root, 'scripts', 'candidate-evidence.mjs')).href;

test('candidate catalog identity rejects stale version, revision, and source', async () => {
  const { assertCatalogIdentity } = await import(evidenceModule);
  const catalog = catalogFixture();
  assert.equal(assertCatalogIdentity(catalog, {
    version: '1.2.3',
    revision: 'abc123',
    source: 'https://github.com/example/qubicl',
  }), catalog);

  assert.throws(() => assertCatalogIdentity({ ...catalog, releaseVersion: '1.2.2' }, {
    version: '1.2.3',
    revision: 'abc123',
    source: 'https://github.com/example/qubicl',
  }), /releaseVersion/);
  assert.throws(() => assertCatalogIdentity({ ...catalog, revision: 'old' }, {
    version: '1.2.3',
    revision: 'abc123',
    source: 'https://github.com/example/qubicl',
  }), /revision/);
  assert.throws(() => assertCatalogIdentity({ ...catalog, source: 'https://github.com/other/qubicl' }, {
    version: '1.2.3',
    revision: 'abc123',
    source: 'https://github.com/example/qubicl',
  }), /source/);
});

test('candidate verification facts stay bound to one clean reviewed revision', async () => {
  const { assertReviewedRevisionFacts } = await import(evidenceModule);
  const candidate = {
    version: '1.2.3',
    revision: 'a'.repeat(40),
    created: '2026-08-27T12:00:00-04:00',
    source: 'https://github.com/example/qubicl',
  };
  const facts = {
    head: candidate.revision,
    clean: true,
    version: candidate.version,
    created: candidate.created,
    source: `${candidate.source}.git`,
  };
  assert.doesNotThrow(() => assertReviewedRevisionFacts(facts, candidate));
  assert.throws(() => assertReviewedRevisionFacts({ ...facts, head: 'b'.repeat(40) }, candidate), /HEAD/);
  assert.throws(() => assertReviewedRevisionFacts({ ...facts, clean: false }, candidate), /clean/);
  assert.throws(() => assertReviewedRevisionFacts({ ...facts, version: '1.2.4' }, candidate), /version/);
  assert.throws(() => assertReviewedRevisionFacts({ ...facts, created: '2026-08-27T12:00:01-04:00' }, candidate), /timestamp/);
  assert.throws(() => assertReviewedRevisionFacts({ ...facts, source: 'https://github.com/other/qubicl' }, candidate), /source repository/);
});

test('Trivy reports reject absolute and traversing builder paths', async () => {
  const { assertTrivyReportPrivacy } = await import(evidenceModule);
  assert.doesNotThrow(() => assertTrivyReportPrivacy({
    ArtifactName: '.scan-gateway.oci',
    Results: [
      { Target: '.scan-gateway.oci (debian 13)' },
      { Target: '/etc/ssh/ssh_host_ecdsa_key' },
    ],
  }, '.scan-gateway.oci'));
  assert.throws(() => assertTrivyReportPrivacy({
    ArtifactName: '/home/builder/qubicl/.scan-gateway.oci',
    Results: [],
  }, '.scan-gateway.oci'), /relative/);
  assert.throws(() => assertTrivyReportPrivacy({
    ArtifactName: '../private/.scan-gateway.oci',
    Results: [],
  }, '.scan-gateway.oci'), /traverse/);
  assert.throws(() => assertTrivyReportPrivacy({
    ArtifactName: '.scan-gateway.oci',
    Results: [{ Target: '/home/builder/qubicl/.scan-gateway.oci (debian 13)' }],
  }, '.scan-gateway.oci'), /non-relative scan path/);
});

test('high and critical findings require exact reviewed, current exception scopes', async () => {
  const { summarizeTrivyReports } = await import(evidenceModule);
  const reports = reportFixtures();
  const exceptions = {
    schemaVersion: 1,
    exceptions: [{
      id: 'QVE-2026-001',
      vulnerabilityId: 'CVE-2026-0001',
      packageName: 'openssl',
      installedVersion: '3.0.0-1',
      images: ['gateway'],
      platforms: ['linux/amd64'],
      applicability: 'The vulnerable function is not reachable from the gateway configuration.',
      compensatingControls: ['The gateway is bound to localhost and runs without the affected feature.'],
      owner: 'release-owner',
      reviewedBy: 'security-reviewer',
      reviewedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2026-08-31T00:00:00Z',
      references: ['https://security.example.invalid/CVE-2026-0001'],
    }],
  };
  const summary = summarizeTrivyReports(reports, exceptions, { evaluatedAt: '2026-08-19T00:00:00Z' });
  assert.equal(summary.policy.passed, true);
  assert.equal(
    summary.reports.find((report: { name: string }) => report.name === 'trivy-gateway-linux-amd64.json')?.acceptedHighCritical,
    1,
  );

  assert.throws(() => summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    evaluatedAt: '2026-08-19T00:00:00Z',
  }), /no current reviewed exception/);
  assert.throws(() => summarizeTrivyReports(reports, exceptions, {
    evaluatedAt: '2026-09-01T00:00:00Z',
  }), /expired/);

  const secretReports = structuredClone(reports);
  secretReports[0]!.document.Results![0]!.Secrets = [{ RuleID: 'private-key' }];
  assert.throws(() => summarizeTrivyReports(secretReports, exceptions, {
    evaluatedAt: '2026-08-19T00:00:00Z',
  }), /secret finding/);
});

test('preview policy retains unfixed findings but blocks secrets and available fixes', async () => {
  const { summarizeTrivyReports } = await import(evidenceModule);
  const reports = reportFixtures();
  const summary = summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    evaluatedAt: '2026-08-19T00:00:00Z',
    releaseTier: 'preview',
  });
  assert.equal(summary.schemaVersion, 4);
  assert.equal(summary.policy.passed, true);
  assert.equal(summary.policy.releaseTier, 'preview');
  assert.equal(summary.policy.verdict, 'preview-only');
  assert.equal(summary.policy.trackedUnfixedHighCritical, 1);
  assert.equal(summary.trackedFindings.length, 1);
  assert.equal(summary.trackedFindings[0]?.vulnerabilityId, 'CVE-2026-0001');
  assert.equal(summary.reports.find((report: { name: string }) => report.name === 'trivy-gateway-linux-amd64.json')?.trackedUnfixedHighCritical, 1);

  const fixAvailable = structuredClone(reports);
  fixAvailable[0]!.document.Results![0]!.Vulnerabilities![0]!.FixedVersion = '3.0.0-2';
  assert.throws(() => summarizeTrivyReports(fixAvailable, { schemaVersion: 1, exceptions: [] }, {
    evaluatedAt: '2026-08-19T00:00:00Z',
    releaseTier: 'preview',
  }), /scanner-reported fix 3\.0\.0-2/);

  const secretReports = structuredClone(reports);
  secretReports[0]!.document.Results![0]!.Secrets = [{ RuleID: 'private-key' }];
  assert.throws(() => summarizeTrivyReports(secretReports, { schemaVersion: 1, exceptions: [] }, {
    evaluatedAt: '2026-08-19T00:00:00Z',
    releaseTier: 'preview',
  }), /secret finding/);
});

test('initial pre-1.0 policy retains unfixed findings with a release verdict', async () => {
  const { summarizeTrivyReports } = await import(evidenceModule);
  const summary = summarizeTrivyReports(reportFixtures(), { schemaVersion: 1, exceptions: [] }, {
    evaluatedAt: '2026-08-19T00:00:00Z',
    releaseTier: 'initial',
  });
  assert.equal(summary.policy.releaseTier, 'initial');
  assert.equal(summary.policy.verdict, 'initial-release');
  assert.equal(summary.policy.trackedUnfixedHighCritical, 1);
  assert.deepEqual(summary.policy.failOn, [
    'secrets',
    'HIGH/CRITICAL vulnerabilities with a scanner-reported fix',
    'ambiguous vulnerability review records',
    'expired vulnerability review records',
  ]);
});

test('applicability statements are exact, transparent, independently reviewed, and fail closed', async () => {
  const { parseVulnerabilityApplicability, summarizeTrivyReports } = await import(evidenceModule);
  const reports = reportFixtures();
  const pending = applicabilityFixture('under_investigation');
  const preview = summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    applicabilityDocument: pending,
    evaluatedAt: '2026-08-19T00:00:00Z',
    releaseTier: 'preview',
  });
  assert.equal(preview.applicability.underInvestigation, 1);
  assert.equal(preview.applicability.notAffected, 0);
  assert.deepEqual(preview.trackedFindings[0]?.applicability, {
    id: 'QVA-2026-001',
    status: 'under_investigation',
  });
  assert.throws(() => summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    applicabilityDocument: pending,
    evaluatedAt: '2026-08-19T00:00:00Z',
  }), /still under investigation/);

  const reviewed = applicabilityFixture('not_affected');
  const supported = summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    applicabilityDocument: reviewed,
    evaluatedAt: '2026-08-19T00:00:00Z',
  });
  assert.equal(supported.applicability.notAffected, 1);
  assert.equal(supported.policy.notAffectedHighCritical, 1);
  assert.equal(supported.notAffectedFindings.length, 1);
  assert.equal(supported.reports.find((report: { name: string }) => report.name === 'trivy-gateway-linux-amd64.json')?.notAffectedHighCritical, 1);
  assert.equal(supported.trackedFindings.length, 0);

  const selfReviewed = structuredClone(reviewed);
  selfReviewed.statements[0]!.reviewedBy = ` ${selfReviewed.statements[0]!.owner.toUpperCase()} `;
  assert.throws(() => parseVulnerabilityApplicability(selfReviewed), /independent reviewer/);

  const overlappingException = {
    schemaVersion: 1,
    exceptions: [{
      id: 'QVE-2026-001',
      vulnerabilityId: 'CVE-2026-0001',
      packageName: 'openssl',
      installedVersion: '3.0.0-1',
      images: ['gateway'],
      platforms: ['linux/amd64'],
      applicability: 'The same exact finding cannot be covered by two review records.',
      compensatingControls: ['This fixture verifies overlap rejection.'],
      owner: 'release-owner',
      reviewedBy: 'independent-reviewer',
      reviewedAt: '2026-08-02T00:00:00Z',
      expiresAt: '2026-08-31T00:00:00Z',
      references: ['https://security.example.invalid/CVE-2026-0001'],
    }],
  };
  assert.throws(() => summarizeTrivyReports(reports, overlappingException, {
    applicabilityDocument: reviewed,
    evaluatedAt: '2026-08-19T00:00:00Z',
  }), /overlapping review records QVE-2026-001, QVA-2026-001/);

  const stale = structuredClone(pending);
  stale.statements[0]!.installedVersion = '3.0.0-0';
  assert.throws(() => summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    applicabilityDocument: stale,
    evaluatedAt: '2026-08-19T00:00:00Z',
    releaseTier: 'preview',
  }), /is unused/);

  const expired = structuredClone(reviewed);
  expired.statements[0]!.expiresAt = '2026-08-18T00:00:00Z';
  assert.throws(() => summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    applicabilityDocument: expired,
    evaluatedAt: '2026-08-19T00:00:00Z',
  }), /expired/);
});

test('Trivy policy reports every secret and exact vulnerability failure together', async () => {
  const { summarizeTrivyReports } = await import(evidenceModule);
  const reports = reportFixtures();
  const browser = reports.find(({ name }) => name === 'trivy-browser-linux-amd64.json')!;
  browser.document.Results![0]!.Vulnerabilities = [{
    VulnerabilityID: 'CVE-2026-0002',
    PkgName: 'browser-parser',
    InstalledVersion: '2.0.0-1',
    Severity: 'CRITICAL',
  }];
  browser.document.Results![0]!.Secrets = [{ RuleID: 'browser-private-key' }];
  const workstation = reports.find(({ name }) => name === 'trivy-workstation-linux-arm64.json')!;
  workstation.document.Results![0]!.Secrets = [
    { RuleID: 'rsa-private-key' },
    { RuleID: 'ed25519-private-key' },
  ];

  assert.throws(() => summarizeTrivyReports(reports, { schemaVersion: 1, exceptions: [] }, {
    evaluatedAt: '2026-08-19T00:00:00Z',
  }), (error: Error) => {
    assert.match(error.message, /3 secret finding\(s\)/);
    assert.match(error.message, /trivy-browser-linux-amd64\.json: 1 secret finding/);
    assert.match(error.message, /trivy-workstation-linux-arm64\.json: 2 secret finding/);
    assert.match(error.message, /CVE-2026-0001 in openssl@3\.0\.0-1/);
    assert.match(error.message, /CVE-2026-0002 in browser-parser@2\.0\.0-1/);
    return true;
  });
});

test('Chromium vulnerability reviews require the enabled renderer sandbox posture', async () => {
  const { parseVulnerabilityExceptions } = await import(evidenceModule);
  const exception = {
    schemaVersion: 1,
    exceptions: [{
      id: 'QVE-2026-002',
      vulnerabilityId: 'CVE-2026-0002',
      packageName: 'chromium',
      installedVersion: '140.0.0-1',
      images: ['browser'],
      platforms: ['linux/amd64'],
      applicability: 'This fixture verifies the required browser-risk review posture.',
      compensatingControls: ['Chromium renderers use the Linux namespace and seccomp sandbox.'],
      browserRisk: {
        hostileInputExposure: true,
        chromiumSandbox: 'enabled',
        analysis: 'Untrusted web content remains exposed to an enabled Chromium renderer sandbox.',
      },
      owner: 'release-owner',
      reviewedBy: 'security-reviewer',
      reviewedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2026-08-31T00:00:00Z',
      references: ['https://security.example.invalid/CVE-2026-0002'],
    }],
  };
  assert.equal(parseVulnerabilityExceptions(exception).length, 1);

  const sandboxDisabled = structuredClone(exception);
  sandboxDisabled.exceptions[0]!.browserRisk.chromiumSandbox = 'disabled';
  assert.throws(() => parseVulnerabilityExceptions(sandboxDisabled), /enabled Chromium sandbox/);
});

function catalogFixture(): Record<string, unknown> {
  const requested = (name: string) => `ghcr.io/example/qubicl-${name}:1.2.3`;
  const image = (name: string) => ({
    requested: requested(name),
    indexDigest: digest('a'),
    platforms: {
      'linux/amd64': {
        resolved: `ghcr.io/example/qubicl-${name}@${digest('a')}`,
        digest: digest('b'),
        downloadBytes: 1,
        expandedBytes: 2,
      },
      'linux/arm64': {
        resolved: `ghcr.io/example/qubicl-${name}@${digest('a')}`,
        digest: digest('c'),
        downloadBytes: 1,
        expandedBytes: 2,
      },
    },
  });
  return {
    schemaVersion: 1,
    releaseVersion: '1.2.3',
    development: false,
    source: 'https://github.com/example/qubicl',
    revision: 'abc123',
    supportedPlatforms: ['linux/amd64', 'linux/arm64'],
    gateway: image('gateway'),
    presets: Object.fromEntries(['file-system', 'browser', 'computer', 'workstation'].map((name) => [
      name,
      { manifestSha256: 'd'.repeat(64), image: image(name) },
    ])),
  };
}

function reportFixtures(): Array<{ name: string; document: Record<string, any> }> {
  return ['gateway', 'file-system', 'browser', 'computer', 'workstation'].flatMap((image) =>
    ['amd64', 'arm64'].map((architecture) => ({
      name: `trivy-${image}-linux-${architecture}.json`,
      document: {
        ArtifactName: `.scan-${image}.oci`,
        Results: [{
          Target: `.scan-${image}.oci (debian 13)`,
          Vulnerabilities: image === 'gateway' && architecture === 'amd64' ? [{
            VulnerabilityID: 'CVE-2026-0001',
            PkgName: 'openssl',
            InstalledVersion: '3.0.0-1',
            Severity: 'HIGH',
          }] : [],
          Secrets: [],
        }],
      },
    })));
}

function applicabilityFixture(status: 'under_investigation' | 'not_affected'): Record<string, any> {
  return {
    schemaVersion: 1,
    statements: [{
      id: 'QVA-2026-001',
      status,
      vulnerabilityIds: ['CVE-2026-0001'],
      packageNames: ['openssl'],
      installedVersion: '3.0.0-1',
      images: ['gateway'],
      platforms: ['linux/amd64'],
      justification: 'vulnerable_code_not_in_execute_path',
      analysis: 'The exact vulnerable function is not reachable in this candidate configuration.',
      evidence: ['The image contract and runtime configuration disable the affected function.'],
      owner: 'release-owner',
      recordedAt: '2026-08-01T00:00:00Z',
      references: ['https://security.example.invalid/CVE-2026-0001'],
      ...(status === 'not_affected' ? {
        reviewedBy: 'independent-reviewer',
        reviewedAt: '2026-08-02T00:00:00Z',
        expiresAt: '2026-08-31T00:00:00Z',
      } : {}),
    }],
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
