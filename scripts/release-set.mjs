#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateDirectory } from './candidate-evidence.mjs';
import { signEvidence, verifyEvidenceSignature } from './evidence-signature.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const RELEASE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

export async function createReleaseSet(directory, { root = repositoryRoot } = {}) {
  const setDirectory = resolve(directory);
  const completeCandidate = await verifyCandidateDirectory(join(setDirectory, 'linux-x64'), { root });
  assert(['initial', 'supported'].includes(completeCandidate.candidate.releaseTier),
    'Release sets can be created only for initial or supported candidates.');
  const targets = completeCandidate.candidate.releaseTier === 'initial' ? ['linux-x64'] : RELEASE_TARGETS;
  const members = [];
  let common;
  for (const target of targets) {
    const candidateDirectory = join(setDirectory, target);
    const { candidate } = target === 'linux-x64'
      ? completeCandidate
      : await verifyCandidateDirectory(candidateDirectory, { root });
    assert(candidate.host.target === target, `${target} candidate declares host target ${candidate.host.target}.`);
    const identity = {
      version: candidate.version,
      revision: candidate.revision,
      source: candidate.source,
      imageCatalogSha256: candidate.imageCatalog.sha256,
      releaseTier: candidate.releaseTier,
    };
    common ??= identity;
    assert(JSON.stringify(identity) === JSON.stringify(common), `${target} candidate does not share the release identity and catalog.`);
    const archiveName = `qubicl-${candidate.version}-${target}.tar.gz`;
    const sbomName = `qubicl-${candidate.version}-${target}.spdx.json`;
    members.push({
      target,
      directory: target,
      candidateJsonSha256: await sha256(join(candidateDirectory, 'candidate.json')),
      checksumsSha256: await sha256(join(candidateDirectory, 'SHA256SUMS')),
      nativeArchive: await artifactIdentity(candidate, archiveName),
      nativeSbom: await artifactIdentity(candidate, sbomName),
      complete: candidate.modes?.binaryOnly === false && candidate.modes?.images === true
        && candidate.modes?.scans === true && candidate.modes?.exactArtifactAcceptance === true,
    });
  }
  assert(members.filter(({ complete }) => complete).length === 1, 'A release set requires exactly one complete scanned exact-artifact candidate.');
  const document = {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    ...common,
    completeTarget: members.find(({ complete }) => complete).target,
    members,
  };
  const output = join(setDirectory, 'release-set.json');
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  return { document, output };
}

export async function verifyReleaseSet(path, { root = repositoryRoot } = {}) {
  const releaseSetPath = resolve(path);
  const document = JSON.parse(await readFile(releaseSetPath, 'utf8'));
  assertReleaseSetShape(document);
  const setDirectory = dirname(releaseSetPath);
  for (const member of document.members) {
    const candidateDirectory = join(setDirectory, member.directory);
    const { candidate } = await verifyCandidateDirectory(candidateDirectory, { root });
    assert(candidate.host.target === member.target, `${member.target} release-set directory contains another target.`);
    assert(candidate.version === document.version && candidate.revision === document.revision
      && candidate.source === document.source && candidate.imageCatalog.sha256 === document.imageCatalogSha256,
    `${member.target} candidate does not match the release-set identity.`);
    if (document.schemaVersion === 2) {
      assert(candidate.releaseTier === document.releaseTier,
        `${member.target} candidate does not match the release-set tier.`);
    }
    assert(await sha256(join(candidateDirectory, 'candidate.json')) === member.candidateJsonSha256, `${member.target} candidate.json hash does not match.`);
    assert(await sha256(join(candidateDirectory, 'SHA256SUMS')) === member.checksumsSha256, `${member.target} SHA256SUMS hash does not match.`);
    for (const field of ['nativeArchive', 'nativeSbom']) {
      const artifact = member[field];
      assert((await artifactIdentity(candidate, artifact.name)).sha256 === artifact.sha256, `${member.target} ${field} does not match the candidate.`);
    }
    const complete = candidate.modes?.binaryOnly === false && candidate.modes?.images === true
      && candidate.modes?.scans === true && candidate.modes?.exactArtifactAcceptance === true;
    assert(complete === member.complete, `${member.target} complete-candidate status does not match.`);
  }
  return { document, path: releaseSetPath, directory: setDirectory, sha256: await sha256(releaseSetPath) };
}

export function assertReleaseSetShape(document) {
  assert([1, 2].includes(document?.schemaVersion), 'release-set.json schemaVersion must be 1 or 2.');
  assert(iso(document.createdAt), 'release-set.json requires an ISO createdAt timestamp.');
  for (const field of ['version', 'revision', 'source']) assert(nonempty(document[field]), `release-set.json requires ${field}.`);
  assert(hash(document.imageCatalogSha256), 'release-set.json requires an image-catalog SHA-256.');
  if (document.schemaVersion === 2) {
    assert(['initial', 'supported'].includes(document.releaseTier),
      'release-set.json schemaVersion 2 requires an initial or supported release tier.');
  }
  const targets = document.schemaVersion === 2 && document.releaseTier === 'initial'
    ? ['linux-x64']
    : RELEASE_TARGETS;
  assert(targets.includes(document.completeTarget), 'release-set.json has an invalid complete target.');
  assert(Array.isArray(document.members) && document.members.length === targets.length,
    `release-set.json requires exactly ${targets.length} native member${targets.length === 1 ? '' : 's'} for its release tier.`);
  assert(JSON.stringify(document.members.map(({ target }) => target).sort()) === JSON.stringify([...targets].sort()),
    'release-set.json has missing or duplicate targets for its release tier.');
  for (const member of document.members) {
    assert(member.directory === member.target && basename(member.directory) === member.directory, `Unsafe release-set directory for ${member.target}.`);
    assert(hash(member.candidateJsonSha256) && hash(member.checksumsSha256), `${member.target} lacks candidate hashes.`);
    for (const artifact of [member.nativeArchive, member.nativeSbom]) {
      assert(artifact && basename(artifact.name) === artifact.name && hash(artifact.sha256) && Number.isInteger(artifact.bytes) && artifact.bytes > 0, `${member.target} has invalid native artifact identity.`);
    }
    assert(typeof member.complete === 'boolean', `${member.target} lacks complete-candidate status.`);
  }
  assert(document.members.filter(({ complete }) => complete).length === 1
    && document.members.find(({ complete }) => complete)?.target === document.completeTarget,
  'release-set.json must identify exactly one complete target.');
}

async function artifactIdentity(candidate, name) {
  const artifact = candidate.artifacts.find((entry) => entry.name === name);
  assert(artifact, `Candidate lacks ${name}.`);
  return { name, bytes: artifact.bytes, sha256: artifact.sha256 };
}

async function main(args) {
  const [action, ...rest] = args;
  if (action === 'create' && rest.length === 1) {
    console.log(JSON.stringify(await createReleaseSet(rest[0]), null, 2));
  } else if (action === 'verify' && rest.length === 1) {
    const result = await verifyReleaseSet(rest[0]);
    console.log(JSON.stringify({ ok: true, ...result, document: undefined }, null, 2));
  } else if (action === 'sign' && rest.length === 3) {
    const result = await verifyReleaseSet(rest[0]);
    console.log(JSON.stringify(await signEvidence('qubicl-release-set', { releaseSetSha256: result.sha256 }, resolve(rest[1]), resolve(rest[2])), null, 2));
  } else if (action === 'verify-signature' && rest.length === 3) {
    const result = await verifyReleaseSet(rest[0]);
    const publicKey = await readFile(resolve(rest[1]));
    console.log(JSON.stringify(await verifyEvidenceSignature('qubicl-release-set', { releaseSetSha256: result.sha256 }, publicKey, resolve(rest[2])), null, 2));
  } else {
    console.log('Usage:\n  node scripts/release-set.mjs create RELEASE_SET_DIRECTORY\n  node scripts/release-set.mjs verify RELEASE_SET.json\n  node scripts/release-set.mjs sign RELEASE_SET.json PRIVATE_KEY SIGNATURE.json\n  node scripts/release-set.mjs verify-signature RELEASE_SET.json PUBLIC_KEY SIGNATURE.json');
    if (action !== '--help') process.exitCode = 1;
  }
}

async function sha256(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function iso(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 1; }
function assert(condition, message) { if (!condition) throw new Error(message); }

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main(process.argv.slice(2));
