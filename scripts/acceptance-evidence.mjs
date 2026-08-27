#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyFingerprint, signEvidence, verifyEvidenceSignature } from './evidence-signature.mjs';
import { verifyReleaseSet } from './release-set.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const CLIENTS = ['codex', 'claude-code', 'claude-desktop', 'cursor', 'vscode', 'open-webui', 'mcp-stdio', 'mcp-http', 'openapi'];
const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-intel', 'macos-apple-silicon', 'windows-wsl2-x64'];
const WORKFLOWS = ['upgrade', 'backupRestoreInterruption', 'restart', 'physicalReboot', 'fullTopologyPerformance', 'multipleComputers', 'sustainedDogfooding'];

export async function validateAcceptanceEvidence(evidence, context) {
  const { releaseSet, releaseSetSha256, evidenceDirectory, signatureFingerprint, now = new Date().toISOString() } = context;
  assert(evidence?.schemaVersion === 3, 'Acceptance schemaVersion must be 3.');
  assert(evidence.releaseSet?.sha256 === releaseSetSha256, 'Acceptance evidence targets another release set.');
  assert(evidence.releaseSet?.signatureFingerprint === signatureFingerprint, 'Acceptance evidence names another release-set signature key.');
  assert(evidence.releaseSet?.version === releaseSet.version && evidence.releaseSet?.revision === releaseSet.revision, 'Acceptance evidence targets another version or revision.');
  assert(identity(evidence.owner), 'Acceptance evidence requires an owner identity.');
  assert(identity(evidence.approvedBy) && different(evidence.owner, evidence.approvedBy), 'Final approver must be identified and distinct from the owner.');
  validateTimestamp(evidence.approvedAt, releaseSet.createdAt, now, 'approval');

  await requiredRows(evidence.clients, CLIENTS, 'client', evidenceDirectory, releaseSet.createdAt, now, (row) => {
    assert(version(row.version), `${row.id} requires a real client/protocol version.`);
  });
  await requiredRows(evidence.platforms, PLATFORMS, 'platform', evidenceDirectory, releaseSet.createdAt, now, (row) => {
    assert(row.minimumVersionsPassed === true && row.restartPassed === true && row.physicalRebootPassed === true, `${row.id} lacks minimum/restart/reboot evidence.`);
    for (const field of ['osVersion', 'architecture', 'node', 'dockerEngine', 'dockerCompose']) assert(version(row[field]), `${row.id} requires ${field}.`);
    assert(row.dockerDesktop === null || version(row.dockerDesktop), `${row.id} has invalid dockerDesktop evidence.`);
    if (row.id === 'windows-wsl2-x64') {
      assert(version(row.windowsBuild) && version(row.wslVersion) && version(row.wslKernel) && version(row.distribution), `${row.id} requires exact Windows, WSL, kernel, and distribution versions.`);
      assert(version(row.dockerDesktop), `${row.id} requires Docker Desktop version evidence.`);
      for (const field of ['wslShutdownPassed', 'windowsHostRebootPassed', 'linuxFilesystemPassed', 'windowsBackedStateRejected', 'windowsLocalhostPassed', 'windowsStdioPassed', 'viewerHandoffPassed']) {
        assert(row[field] === true, `${row.id} requires ${field}.`);
      }
    }
  });
  assert(evidence.workflows && typeof evidence.workflows === 'object', 'Acceptance workflows are required.');
  for (const id of WORKFLOWS) await validateResult(evidence.workflows[id], `workflow ${id}`, evidenceDirectory, releaseSet.createdAt, now);

  for (const [name, review] of [['security', evidence.securityReview], ['vulnerability', evidence.vulnerabilityReview], ['privacy', evidence.privacyReview]]) {
    await validateReview(review, `${name} review`, evidence, evidenceDirectory, releaseSet.createdAt, now);
  }
  for (const topic of ['processBoundary', 'internalAuthentication', 'browserSurface', 'filesystemRaces', 'networkReconciliation', 'releaseIntegrity']) {
    assert(evidence.securityReview.topics?.[topic] === true, `Security review lacks ${topic}.`);
  }
  return { clients: evidence.clients.length, platforms: evidence.platforms.length, workflows: WORKFLOWS.length };
}

export function acceptanceEvidenceFiles(evidence, directory) {
  const references = [
    ...(evidence.clients ?? []).map(({ evidence: value }) => value),
    ...(evidence.platforms ?? []).map(({ evidence: value }) => value),
    ...Object.values(evidence.workflows ?? {}).map((value) => value?.evidence),
    evidence.securityReview?.evidence,
    evidence.vulnerabilityReview?.evidence,
    evidence.privacyReview?.evidence,
  ];
  return [...new Set(references.map((reference) => reference?.path).filter(Boolean))].sort().map((path) => join(directory, path));
}

async function requiredRows(rows, ids, label, directory, notBefore, now, extra) {
  assert(Array.isArray(rows) && rows.length === ids.length, `Acceptance requires exactly ${ids.length} ${label} rows.`);
  for (const id of ids) {
    const matches = rows.filter((row) => row?.id === id);
    assert(matches.length === 1, `Expected exactly one ${label} row for ${id}.`);
    await validateResult(matches[0], `${label} ${id}`, directory, notBefore, now);
    extra(matches[0]);
  }
}

async function validateResult(result, label, directory, notBefore, now) {
  assert(result?.passed === true, `${label} did not pass.`);
  assert(identity(result.testedBy), `${label} requires a tester identity.`);
  validateTimestamp(result.testedAt, notBefore, now, label);
  await validateEvidenceFile(result.evidence, directory, label);
}

async function validateReview(review, label, evidence, directory, notBefore, now) {
  assert(review?.passed === true, `${label} did not pass.`);
  assert(identity(review.reviewedBy), `${label} requires a reviewer identity.`);
  assert(different(review.reviewedBy, evidence.owner) && different(review.reviewedBy, evidence.approvedBy), `${label} reviewer must differ from the owner and final approver.`);
  validateTimestamp(review.reviewedAt, notBefore, now, label);
  await validateEvidenceFile(review.evidence, directory, label);
}

async function validateEvidenceFile(reference, directory, label) {
  assert(reference && typeof reference.path === 'string' && basename(reference.path) === reference.path, `${label} evidence path must name a local sibling file.`);
  assert(hash(reference.sha256), `${label} evidence requires a SHA-256.`);
  const path = join(directory, reference.path);
  assert(await sha256(path) === reference.sha256, `${label} evidence file hash does not match ${reference.path}.`);
}

function validateTimestamp(value, notBefore, now, label) {
  assert(iso(value), `${label} requires a valid UTC ISO timestamp.`);
  const time = Date.parse(value);
  assert(time >= Date.parse(notBefore), `${label} predates the release set.`);
  assert(time <= Date.parse(now) + 300_000, `${label} is implausibly in the future.`);
}

export async function verifyAcceptanceBundle(releaseSetPath, evidencePath, publicKeyPath, releaseSetSignaturePath, acceptanceSignaturePath) {
  const set = await verifyReleaseSet(releaseSetPath, { root });
  const publicKey = await readFile(resolve(publicKeyPath));
  const releaseSignature = await verifyEvidenceSignature('qubicl-release-set', { releaseSetSha256: set.sha256 }, publicKey, resolve(releaseSetSignaturePath));
  const path = resolve(evidencePath);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  const summary = await validateAcceptanceEvidence(evidence, {
    releaseSet: set.document,
    releaseSetSha256: set.sha256,
    evidenceDirectory: dirname(path),
    signatureFingerprint: publicKeyFingerprint(publicKey),
  });
  let acceptanceSignature;
  if (acceptanceSignaturePath) {
    const payload = { releaseSetSha256: set.sha256, acceptanceSha256: await sha256(path) };
    acceptanceSignature = await verifyEvidenceSignature('qubicl-acceptance', payload, publicKey, resolve(acceptanceSignaturePath));
  }
  return { set, publicKey, path, evidence, evidenceFiles: acceptanceEvidenceFiles(evidence, dirname(path)), summary, releaseSignature, acceptanceSignature };
}

async function main(args) {
  const [action, ...rest] = args;
  if (action === 'sign' && rest.length === 6) {
    const [setPath, evidencePath, publicKeyPath, setSignaturePath, privateKeyPath, outputPath] = rest;
    const loaded = await verifyAcceptanceBundle(setPath, evidencePath, publicKeyPath, setSignaturePath);
    const payload = { releaseSetSha256: loaded.set.sha256, acceptanceSha256: await sha256(loaded.path) };
    console.log(JSON.stringify(await signEvidence('qubicl-acceptance', payload, resolve(privateKeyPath), resolve(outputPath)), null, 2));
  } else if (action === 'verify' && rest.length === 5) {
    const [setPath, evidencePath, publicKeyPath, setSignaturePath, acceptanceSignaturePath] = rest;
    const loaded = await verifyAcceptanceBundle(setPath, evidencePath, publicKeyPath, setSignaturePath, acceptanceSignaturePath);
    console.log(JSON.stringify({ ok: true, version: loaded.set.document.version, revision: loaded.set.document.revision, ...loaded.summary, signatureFingerprint: loaded.acceptanceSignature.publicKeyFingerprint }, null, 2));
  } else {
    console.log('Usage:\n  node scripts/acceptance-evidence.mjs sign RELEASE_SET.json EVIDENCE.json PUBLIC_KEY RELEASE_SET_SIGNATURE PRIVATE_KEY OUTPUT_SIGNATURE\n  node scripts/acceptance-evidence.mjs verify RELEASE_SET.json EVIDENCE.json PUBLIC_KEY RELEASE_SET_SIGNATURE ACCEPTANCE_SIGNATURE');
    if (action !== '--help') process.exitCode = 1;
  }
}

async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function iso(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function identity(value) { return typeof value === 'string' && value.trim().length >= 3 && !/^(?:x|todo|tbd|placeholder)$/iu.test(value.trim()); }
function different(left, right) { return `${left}`.trim().toLowerCase() !== `${right}`.trim().toLowerCase(); }
function version(value) { return typeof value === 'string' && value.trim().length >= 2 && /\d/u.test(value); }
function assert(condition, message) { if (!condition) throw new Error(message); }

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main(process.argv.slice(2));
