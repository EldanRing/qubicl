#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseSet } from './release-set.mjs';
import { verifyReleaseImpactDocument } from './release-impact.mjs';
import { signEvidence, verifyEvidenceSignature } from './evidence-signature.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function qualificationChecks(impact) {
  return [...new Set([
    ...impact.requiredChecks,
    ...impact.affectedProtocols.map((name) => `protocol:${name}`),
    ...impact.affectedPlatforms.map((name) => `platform:${name}`),
  ])].sort();
}

export function qualificationTemplate(set, impact) {
  return {
    schemaVersion: 1,
    kind: 'qubicl-release-qualification',
    version: set.document.version,
    revision: set.document.revision,
    releaseSetSha256: set.sha256,
    releaseImpactSha256: set.document.releaseImpactSha256,
    approvedBy: 'Qubicl Maintainers',
    approvedAt: null,
    decision: 'pending',
    checks: qualificationChecks(impact).map((id) => ({ id, status: 'unverified', reason: '', evidence: [] })),
  };
}

export async function validateQualification(document, { set, impact, directory, now = new Date().toISOString() }) {
  assert(document?.schemaVersion === 1 && document.kind === 'qubicl-release-qualification', 'Unsupported release qualification.');
  assert(document.version === set.document.version && document.revision === set.document.revision
    && document.releaseSetSha256 === set.sha256 && document.releaseImpactSha256 === set.document.releaseImpactSha256,
  'Qualification targets another release set or impact document.');
  assert(typeof document.approvedBy === 'string' && document.approvedBy.trim().length > 0, 'Qualification requires a maintainer identity.');
  const approved = Date.parse(document.approvedAt);
  assert(Number.isFinite(approved) && approved >= Date.parse(set.document.createdAt) && approved <= Date.parse(now), 'Qualification approval time is invalid.');
  assert(['publish', 'publish-with-limitations'].includes(document.decision), 'Qualification has no publication decision.');
  const required = qualificationChecks(impact);
  assert(Array.isArray(document.checks) && JSON.stringify(document.checks.map(({ id }) => id).sort()) === JSON.stringify(required), 'Qualification must account for every impact-selected check exactly once.');
  const evidenceFiles = new Set();
  const limitations = [];
  for (const check of document.checks) {
    assert(['passed', 'failed', 'unverified'].includes(check.status), `Invalid status for ${check.id}.`);
    assert(typeof check.reason === 'string' && check.reason.trim().length > 0, `${check.id} needs an outcome or limitation explanation.`);
    assert(Array.isArray(check.evidence), `${check.id} needs an evidence list.`);
    if (check.status !== 'unverified') assert(check.evidence.length > 0, `${check.id} requires evidence of its result.`);
    if (check.status !== 'passed') limitations.push({ id: check.id, status: check.status, reason: check.reason });
    for (const entry of check.evidence) {
      assert(typeof entry.path === 'string' && !isAbsolute(entry.path) && !entry.path.includes('\\') && !entry.path.split('/').includes('..')
        && /^[a-f0-9]{64}$/u.test(entry.sha256 ?? ''), `Unsafe evidence reference for ${check.id}.`);
      const path = resolve(directory, entry.path);
      const canonical = await realpath(path);
      const inside = relative(await realpath(directory), canonical);
      assert(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), 'Qualification evidence escapes its directory.');
      const details = await lstat(path);
      assert(details.isFile() && details.size <= 16 * 1024 * 1024, 'Qualification evidence must be a regular file under 16 MiB.');
      assert(hash(await readFile(path)) === entry.sha256, `Evidence changed for ${check.id}.`);
      evidenceFiles.add(path);
    }
  }
  assert((limitations.length > 0) === (document.decision === 'publish-with-limitations'), 'Publication decision must explicitly acknowledge incomplete or failed checks.');
  return { limitations, evidenceFiles: [...evidenceFiles].sort() };
}

export function assertQualificationDisclosure(notes, summary) {
  for (const { id, status, reason } of summary.limitations) {
    assert(notes.includes(`${id}: ${status} — ${reason}`), `Release notes must disclose qualification limitation: ${id}: ${status} — ${reason}`);
  }
}

async function loadSet(setPath) {
  const set = await verifyReleaseSet(setPath, { root });
  const complete = set.document.members.find((member) => member.complete);
  const impactPath = join(set.directory, complete.directory, 'release-impact.json');
  assert(hash(await readFile(impactPath)) === set.document.releaseImpactSha256, 'Release-set impact hash mismatch.');
  const impact = await verifyReleaseImpactDocument(impactPath, { revision: set.document.revision, repositoryRoot: root });
  return { set, impact };
}

export async function verifyQualificationBundle(setPath, qualificationPath, publicKeyPath, setSignaturePath, qualificationSignaturePath) {
  const { set, impact } = await loadSet(setPath);
  const publicKey = await readFile(publicKeyPath);
  const releaseSignature = await verifyEvidenceSignature('qubicl-release-set', { releaseSetSha256: set.sha256 }, publicKey, setSignaturePath);
  const path = resolve(qualificationPath);
  const bytes = await readFile(path);
  const evidence = JSON.parse(bytes);
  const summary = await validateQualification(evidence, { set, impact, directory: dirname(path) });
  const qualificationSignature = await verifyEvidenceSignature('qubicl-qualification', { releaseSetSha256: set.sha256, qualificationSha256: hash(bytes) }, publicKey, qualificationSignaturePath);
  return { set, path, evidence, summary, evidenceFiles: summary.evidenceFiles, releaseSignature, qualificationSignature };
}

async function main(args) {
  const [action, setPath, path, key, signature] = args;
  if (!action || args.includes('--help')) {
    console.log('Usage: release-qualification.mjs plan RELEASE_SET OUTPUT\n       release-qualification.mjs sign RELEASE_SET QUALIFICATION PRIVATE_KEY SIGNATURE\nThe plan records selected checks as unverified. Fill outcomes, hashed evidence and the decision before signing. This never publishes.');
    return;
  }
  assert(['plan', 'sign'].includes(action) && setPath && path, 'Expected plan or sign with release set and qualification paths.');
  const { set, impact } = await loadSet(setPath);
  if (action === 'plan') {
    await writeFile(path, `${JSON.stringify(qualificationTemplate(set, impact), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } else {
    assert(key && signature, 'Signing requires a private key and output signature path.');
    const bytes = await readFile(path);
    const summary = await validateQualification(JSON.parse(bytes), { set, impact, directory: dirname(resolve(path)) });
    await signEvidence('qubicl-qualification', { releaseSetSha256: set.sha256, qualificationSha256: hash(bytes) }, key, signature);
    console.log(JSON.stringify({ signed: true, limitations: summary.limitations }, null, 2));
  }
}

function assert(value, message) { if (!value) throw new Error(message); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
