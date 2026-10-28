import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { qualificationTemplate, validateQualification, assertQualificationDisclosure } from '../../scripts/release-qualification.mjs';
import { assertReleaseSetShape } from '../../scripts/release-set.mjs';
import { parseOptions } from '../../scripts/publish-candidate.mjs';

const set = { sha256: 'a'.repeat(64), document: { version: '0.7.0', revision: 'b'.repeat(40), releaseImpactSha256: 'c'.repeat(64), createdAt: '2026-10-28T00:00:00Z' } };
const impact = { requiredChecks: ['types'], affectedProtocols: [], affectedPlatforms: ['darwin-arm64'] };

test('qualification requires honest outcomes, exact evidence, and public disclosure of gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-qualification-'));
  try {
    const document = qualificationTemplate(set, impact);
    const context = { set, impact, directory, now: '2026-10-28T01:00:00Z' };
    await assert.rejects(validateQualification(document, context), /approval time/);
    await writeFile(join(directory, 'types.log'), 'types passed\n');
    document.approvedAt = '2026-10-28T00:30:00Z';
    document.decision = 'publish-with-limitations';
    document.checks = [
      { id: 'types', status: 'passed', reason: 'Type check passed.', evidence: [{ path: 'types.log', sha256: createHash('sha256').update('types passed\n').digest('hex') }] },
      { id: 'platform:darwin-arm64', status: 'unverified', reason: 'No native Mac run for this release.', evidence: [] },
    ];
    const summary = await validateQualification(document, context);
    assert.equal(summary.limitations.length, 1);
    assert.throws(() => assertQualificationDisclosure('Everything passed.', summary), /must disclose/);
    assert.doesNotThrow(() => assertQualificationDisclosure('platform:darwin-arm64: unverified — No native Mac run for this release.', summary));
    await assert.rejects(validateQualification({ ...document, decision: 'publish' }, context), /explicitly acknowledge/);
    await assert.rejects(validateQualification({ ...document, checks: document.checks.slice(0, 1) }, context), /every impact-selected check/);
    await writeFile(join(directory, 'types.log'), 'changed\n');
    await assert.rejects(validateQualification(document, context), /Evidence changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native target selection is explicit and does not weaken artifact identity', () => {
  const artifact = { name: 'native.tar.gz', bytes: 12, sha256: 'a'.repeat(64) };
  const document = { ...set.document, schemaVersion: 3, source: 'https://github.com/example/qubicl', releaseTier: 'initial', releaseImpactProfile: 'cli', imageCatalogSha256: 'd'.repeat(64), completeTarget: 'linux-x64', nativeTargets: ['linux-x64'], members: [{ target: 'linux-x64', directory: 'linux-x64', complete: true, candidateJsonSha256: 'e'.repeat(64), checksumsSha256: 'f'.repeat(64), nativeArchive: artifact, nativeSbom: artifact }] };
  assert.doesNotThrow(() => assertReleaseSetShape(document));
  assert.throws(() => assertReleaseSetShape({ ...document, nativeTargets: ['linux-x64', 'darwin-arm64'] }), /exactly 2/);
  assert.throws(() => assertReleaseSetShape({ ...document, nativeTargets: ['../escape'] }), /Invalid native/);
  assert.equal(parseOptions(['--candidate', 'candidate', '--public-key', 'key', '--signature', 'signature', '--qualification', 'q', '--qualification-signature', 'qs']).qualification, 'q');
});
