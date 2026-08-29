#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IMAGE_NAMES, verifyCandidateDirectory } from './candidate-evidence.mjs';
import { requiresClientConformance } from './client-conformance.mjs';
import { OCI_EFFICIENCY_REPORT_NAME } from './oci-efficiency.mjs';
import { verifyCandidateSignature } from './sign-candidate.mjs';
import { verifyAcceptanceBundle } from './acceptance-evidence.mjs';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function buildPublishPlan(candidate, catalog, candidateDirectory, releaseEvidence) {
  assert(['initial', 'supported'].includes(candidate.releaseTier), 'Only initial or supported candidates may be published.');
  assert(candidate.modes?.images === true && candidate.modes?.scans === true && candidate.modes?.exactArtifactAcceptance === true, 'Publishing requires a complete scanned exact-artifact candidate.');
  assert(candidate.modes?.binaryOnly === false, 'Publishing requires the npm artifact from a complete candidate.');
  const acceptanceRequired = candidate.releaseTier === 'supported' || requiresClientConformance(candidate.version);
  assert(!acceptanceRequired || releaseEvidence, 'Supported releases and v0.2 or later publication require a signed release set and signed acceptance evidence.');
  if (releaseEvidence?.set?.document?.releaseTier !== undefined || requiresClientConformance(candidate.version)) {
    assert(releaseEvidence?.set?.document?.schemaVersion === 2
      && releaseEvidence.set.document.releaseTier === candidate.releaseTier,
    'Signed release evidence must match the candidate release tier.');
  }
  if (requiresClientConformance(candidate.version)) {
    assert(candidate.imageEfficiency?.name === OCI_EFFICIENCY_REPORT_NAME
      && /^[a-f0-9]{64}$/u.test(candidate.imageEfficiency.sha256 ?? ''),
    'v0.2 or later publication requires exact OCI efficiency evidence.');
  }
  const images = IMAGE_NAMES.map((name) => {
    const image = name === 'gateway' ? catalog.gateway : catalog.presets[name].image;
    const registry = parseGhcrReference(image.requested);
    return {
      name,
      archive: join(candidateDirectory, `qubicl-${name}.oci.tar`),
      versionReference: image.requested,
      latestReference: `${image.requested.replace(/:[^/@]+$/, '')}:latest`,
      indexDigest: image.indexDigest,
      registry,
    };
  });
  const nativeAssets = releaseEvidence
    ? releaseEvidence.set.document.members.flatMap((member) => [
      join(releaseEvidence.set.directory, member.directory, member.nativeArchive.name),
      join(releaseEvidence.set.directory, member.directory, member.nativeSbom.name),
    ])
    : [
      join(candidateDirectory, `qubicl-${candidate.version}-${candidate.host.target}.tar.gz`),
      join(candidateDirectory, `qubicl-${candidate.version}-${candidate.host.target}.spdx.json`),
    ];
  const trustAssets = releaseEvidence
    ? [releaseEvidence.set.path, releaseEvidence.releaseSetSignature, releaseEvidence.acceptance, releaseEvidence.acceptanceSignature, ...releaseEvidence.evidenceFiles]
    : [];
  return {
    version: candidate.version,
    revision: candidate.revision,
    source: candidate.source,
    tag: `v${candidate.version}`,
    npmArchive: join(candidateDirectory, `qubicl-cli-${candidate.version}.tgz`),
    nativeArchive: join(candidateDirectory, `qubicl-${candidate.version}-${candidate.host.target}.tar.gz`),
    images,
    releaseAssets: [
      'candidate.json',
      'SHA256SUMS',
      'image-catalog.json',
      'qubicl-npm.spdx.json',
      'trivy-summary.json',
      ...(requiresClientConformance(candidate.version) ? [OCI_EFFICIENCY_REPORT_NAME] : []),
    ].map((name) => join(candidateDirectory, name)).concat(nativeAssets, trustAssets),
  };
}

async function main(args) {
  if (args.includes('--help') || args.length === 0) {
    console.log(`Usage:
  npm run release:publish -- --candidate /path/to/candidate --public-key KEY --signature SIGNATURE.json
  QUBICL_RELEASE_APPROVAL=VERSION npm run release:publish -- \\
    --candidate /path/to/candidate --public-key KEY --signature SIGNATURE.json --publish --yes

Without --publish, verify the candidate and print the exact publication plan.
Publishing requires a clean checkout at the candidate revision, npm and GitHub
authentication, Skopeo, and an explicit version-matching approval variable.
Supported releases and every v0.2-or-later publication additionally require
--release-set, --release-set-signature, --acceptance, and
--acceptance-signature. Only the documented v0.1 initial series retains its
acceptance exemption.
It copies tested OCI archives, publishes the tested npm tarball, verifies remote
digests, creates vVERSION and an immutable GitHub release, then moves latest.`);
    return;
  }
  const options = parseOptions(args);
  const candidateDirectory = resolve(options.candidate);
  const { candidate, catalog } = await verifyCandidateDirectory(candidateDirectory, { root });
  const publicKey = await readFile(resolve(options.publicKey));
  const signatureDocument = await verifyCandidateSignature(candidateDirectory, candidate, publicKey, resolve(options.signature));
  let releaseEvidence;
  if (candidate.releaseTier === 'supported' || requiresClientConformance(candidate.version)) {
    for (const [option, value] of [['--release-set', options.releaseSet], ['--release-set-signature', options.releaseSetSignature], ['--acceptance', options.acceptance], ['--acceptance-signature', options.acceptanceSignature]]) assert(value, `${option} is required for supported releases and v0.2 or later publication.`);
    const verified = await verifyAcceptanceBundle(options.releaseSet, options.acceptance, options.publicKey, options.releaseSetSignature, options.acceptanceSignature);
    assert(verified.set.document.version === candidate.version && verified.set.document.revision === candidate.revision, 'Release evidence targets another candidate.');
    if (requiresClientConformance(candidate.version)) {
      assert(verified.set.document.schemaVersion === 2 && verified.set.document.releaseTier === candidate.releaseTier,
        'Release evidence targets another candidate tier.');
    }
    const complete = verified.set.document.members.find(({ complete }) => complete);
    assert(complete?.target === candidate.host.target, 'The published candidate is not the release set complete candidate.');
    assert(complete.candidateJsonSha256 === await sha256(candidateDirectory, 'candidate.json'), 'The release set does not bind the published candidate.json.');
    releaseEvidence = {
      ...verified,
      releaseSetSignature: resolve(options.releaseSetSignature),
      acceptance: resolve(options.acceptance),
      acceptanceSignature: resolve(options.acceptanceSignature),
    };
  }
  const plan = buildPublishPlan(candidate, catalog, candidateDirectory, releaseEvidence);
  plan.releaseAssets.push(resolve(options.publicKey), resolve(options.signature));
  assert(new Set(plan.releaseAssets.map((path) => basename(path))).size === plan.releaseAssets.length, 'Release evidence and artifact filenames must be unique.');
  await assertCheckout(candidate);
  await assertPublicHistory(candidate);
  if (!options.publish) {
    console.log(JSON.stringify({ ok: true, dryRun: true, signatureFingerprint: signatureDocument.publicKeyFingerprint, ...plan }, null, 2));
    return;
  }
  assert(options.yes, 'Publication requires --publish --yes.');
  assert(process.env.QUBICL_RELEASE_APPROVAL === plan.version, `Set QUBICL_RELEASE_APPROVAL=${plan.version} for this exact release.`);
  await requireCommand('skopeo', ['--version']);
  await requireCommand('gh', ['auth', 'status']);
  await requireCommand('npm', ['whoami']);
  const ghcrLogin = await loginGhcr();
  for (const image of plan.images) {
    assert(image.registry.owner.toLowerCase() === ghcrLogin.toLowerCase(), `Image owner ${image.registry.owner} does not match the authenticated GitHub user ${ghcrLogin}.`);
  }

  for (const image of plan.images) {
    const existing = await remoteImageDigest(image.versionReference);
    if (existing) assert(existing === image.indexDigest, `${image.versionReference} already exists with unexpected digest ${existing}.`);
    else await run('skopeo', ['copy', '--all', '--preserve-digests', `oci-archive:${image.archive}`, `docker://${image.versionReference}`]);
    assert(await remoteImageDigest(image.versionReference) === image.indexDigest, `Remote digest verification failed for ${image.versionReference}.`);
  }

  const privatePackages = [];
  for (const image of plan.images) {
    const visibility = await ghcrPackageVisibility(image.registry.packageName);
    if (visibility !== 'public') privatePackages.push({ ...image.registry, visibility });
  }
  if (privatePackages.length > 0) {
    const rows = privatePackages.map(({ packageName, visibility }) => `- ${packageName} (${visibility}): https://github.com/users/${ghcrLogin}/packages/container/${encodeURIComponent(packageName)}/settings`);
    throw new Error(`GHCR packages must permit anonymous pulls before npm is published. GitHub creates command-line container packages as private and exposes visibility changes only in package settings. Change these packages to Public, then rerun the same release command:\n${rows.join('\n')}`);
  }

  const expectedIntegrity = await sri(plan.npmArchive);
  const publishedIntegrity = await npmIntegrity(plan.version);
  if (publishedIntegrity) assert(publishedIntegrity === expectedIntegrity, `qubicl-cli@${plan.version} already exists with different bytes.`);
  else await run('npm', ['publish', plan.npmArchive, '--tag', 'next', '--provenance=false']);
  assert(await npmIntegrity(plan.version) === expectedIntegrity, 'Published npm integrity does not match the candidate tarball.');

  await ensureTag(plan.tag, plan.revision);
  const notes = resolve(root, 'release-notes', `${plan.tag}.md`);
  await readFile(notes);
  const releaseExists = await succeeds('gh', ['release', 'view', plan.tag]);
  if (!releaseExists) await run('gh', ['release', 'create', plan.tag, '--verify-tag', '--target', plan.revision, '--latest', '--title', `Qubicl ${plan.version}`, '--notes-file', notes, ...plan.releaseAssets]);
  await assertReleaseAssets(plan, notes);

  for (const image of plan.images) {
    await run('skopeo', ['copy', '--all', '--preserve-digests', `docker://${image.versionReference}`, `docker://${image.latestReference}`]);
    assert(await remoteImageDigest(image.latestReference) === image.indexDigest, `Mutable-tag verification failed for ${image.latestReference}.`);
  }
  await run('npm', ['dist-tag', 'add', `qubicl-cli@${plan.version}`, 'latest']);
  console.log(JSON.stringify({ ok: true, published: true, version: plan.version, revision: plan.revision, tag: plan.tag, images: plan.images.length, npmIntegrity: expectedIntegrity }, null, 2));
}

export function parseOptions(args) {
  const options = { candidate: undefined, publicKey: undefined, signature: undefined, releaseSet: undefined, releaseSetSignature: undefined, acceptance: undefined, acceptanceSignature: undefined, publish: false, yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--candidate') options.candidate = args[++index];
    else if (arg === '--public-key') options.publicKey = args[++index];
    else if (arg === '--signature') options.signature = args[++index];
    else if (arg === '--release-set') options.releaseSet = args[++index];
    else if (arg === '--release-set-signature') options.releaseSetSignature = args[++index];
    else if (arg === '--acceptance') options.acceptance = args[++index];
    else if (arg === '--acceptance-signature') options.acceptanceSignature = args[++index];
    else if (arg === '--publish') options.publish = true;
    else if (arg === '--yes') options.yes = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  assert(options.candidate, '--candidate is required.');
  assert(options.publicKey, '--public-key is required.');
  assert(options.signature, '--signature is required.');
  return options;
}

async function sha256(directory, name) {
  return createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
}

async function assertCheckout(candidate) {
  const status = await capture('git', ['status', '--porcelain']);
  assert(status === '', 'Publication requires a clean Git worktree.');
  assert(await capture('git', ['rev-parse', 'HEAD']) === candidate.revision, 'Checkout HEAD does not match the candidate revision.');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert(manifest.version === candidate.version, 'Checkout version does not match the candidate.');
}

async function assertPublicHistory(candidate) {
  const policy = JSON.parse(await readFile(resolve(root, 'PUBLIC_HISTORY_POLICY.json'), 'utf8'));
  assert(policy.schemaVersion === 2 && policy.policy === 'trusted-root-linear' && policy.branch === 'main'
    && /^[a-f0-9]{40}$/u.test(policy.trustedRootCommit), 'Unsupported or weakened public-history policy.');
  const branch = await capture('git', ['branch', '--show-current']);
  const head = await capture('git', ['rev-parse', 'HEAD']);
  const commitCount = Number(await capture('git', ['rev-list', '--count', 'HEAD']));
  const roots = (await capture('git', ['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter(Boolean);
  const mergeCommits = (await capture('git', ['rev-list', '--merges', 'HEAD'])).split('\n').filter(Boolean);
  const origin = await capture('git', ['remote', 'get-url', 'origin']);
  assertPublicHistoryFacts({ branch, head, commitCount, roots, mergeCommits, origin }, candidate, policy);
  await run(process.execPath, ['scripts/public-source.mjs', 'check']);
}

export function assertPublicHistoryFacts(facts, candidate, policy) {
  assert(facts.branch === policy.branch, `Publication must run from ${policy.branch}.`);
  assert(facts.head === candidate.revision, 'The public-history checkout does not match the candidate revision.');
  assert(Number.isSafeInteger(facts.commitCount) && facts.commitCount >= 1, 'The public history has an invalid reachable commit count.');
  assert(facts.roots.length === 1 && facts.roots[0] === policy.trustedRootCommit,
    'Publication refuses history not descended solely from the trusted public root.');
  assert(Array.isArray(facts.mergeCommits) && facts.mergeCommits.length === 0,
    'Publication requires linear public history without merge commits.');
  assert(normalizeGitHubUrl(facts.origin) === normalizeGitHubUrl(candidate.source), 'The public origin does not match the candidate source repository.');
}

async function loginGhcr() {
  const login = await capture('gh', ['api', 'user', '--jq', '.login']);
  await new Promise((resolvePromise, reject) => {
    const token = spawn('gh', ['auth', 'token'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    const skopeo = spawn('skopeo', ['login', '--username', login, '--password-stdin', 'ghcr.io'], { cwd: root, stdio: [token.stdout, 'inherit', 'inherit'] });
    let tokenCode;
    let skopeoCode;
    const finish = () => {
      if (tokenCode === undefined || skopeoCode === undefined) return;
      if (tokenCode === 0 && skopeoCode === 0) resolvePromise();
      else reject(new Error(`GHCR login failed: gh=${tokenCode}, skopeo=${skopeoCode}.`));
    };
    token.once('error', reject);
    skopeo.once('error', reject);
    token.once('exit', (code) => { tokenCode = code; finish(); });
    skopeo.once('exit', (code) => { skopeoCode = code; finish(); });
  });
  return login;
}

async function ghcrPackageVisibility(packageName) {
  return capture('gh', ['api', `user/packages/container/${encodeURIComponent(packageName)}`, '--jq', '.visibility']);
}

async function assertReleaseAssets(plan, notesPath) {
  const release = JSON.parse(await capture('gh', ['release', 'view', plan.tag, '--json', 'assets,name,body,isDraft,isPrerelease,targetCommitish,url']));
  const expectedAssets = await Promise.all(plan.releaseAssets.map(async (path) => ({ name: basename(path), bytes: (await stat(path)).size, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  assertReleaseMetadata(release, {
    name: `Qubicl ${plan.version}`,
    body: await readFile(notesPath, 'utf8'),
    targetCommitish: plan.revision,
    assetNames: expectedAssets.map(({ name }) => name),
  });
  const repositoryUrl = await capture('gh', ['repo', 'view', '--json', 'url', '--jq', '.url']);
  assert(normalizeGitHubUrl(repositoryUrl) === normalizeGitHubUrl(plan.source), `Authenticated GitHub repository ${repositoryUrl} does not match candidate source ${plan.source}.`);
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-release-assets-'));
  try {
    await run('gh', ['release', 'download', plan.tag, '--dir', temporary]);
    const downloaded = (await readdir(temporary)).sort();
    assert(JSON.stringify(downloaded) === JSON.stringify(expectedAssets.map(({ name }) => name).sort()), `Downloaded GitHub release ${plan.tag} has missing or extra assets.`);
    for (const expected of expectedAssets) {
      const path = join(temporary, expected.name);
      assert((await stat(path)).size === expected.bytes, `GitHub release asset ${expected.name} has the wrong size.`);
      assert(createHash('sha256').update(await readFile(path)).digest('hex') === expected.sha256, `GitHub release asset ${expected.name} has the wrong SHA-256.`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function assertReleaseMetadata(release, expected) {
  assert(release?.name === expected.name, 'GitHub release title does not match the candidate.');
  assert(release?.body === expected.body, 'GitHub release notes do not match the reviewed release notes.');
  assert(release?.isDraft === false && release?.isPrerelease === false, 'GitHub release must be a published stable release.');
  assert(release?.targetCommitish === expected.targetCommitish, 'GitHub release target commit does not match the candidate revision.');
  const actualNames = (release?.assets ?? []).map((asset) => asset?.name).sort();
  assert(JSON.stringify(actualNames) === JSON.stringify([...expected.assetNames].sort()), 'GitHub release has missing, renamed, or extra assets.');
}

function normalizeGitHubUrl(value) {
  return `${value}`.replace(/^git\+/u, '').replace(/^git@github\.com:/u, 'https://github.com/').replace(/\.git$/u, '').replace(/\/$/u, '').toLowerCase();
}

async function remoteImageDigest(reference) {
  try {
    const { stdout } = await exec('skopeo', ['inspect', '--raw', `docker://${reference}`], { cwd: root, encoding: 'buffer', maxBuffer: 50_000_000 });
    return `sha256:${createHash('sha256').update(stdout).digest('hex')}`;
  } catch (error) {
    if (/manifest unknown|name unknown|not found|404/iu.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`)) return undefined;
    throw error;
  }
}

async function npmIntegrity(version) {
  try {
    const value = await capture('npm', ['view', `qubicl-cli@${version}`, 'dist.integrity', '--json']);
    return JSON.parse(value);
  } catch (error) {
    if (/E404|not found/iu.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`)) return undefined;
    throw error;
  }
}

async function sri(path) {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`;
}

async function ensureTag(tag, revision) {
  const existing = await succeeds('git', ['rev-parse', '--verify', `refs/tags/${tag}`]);
  if (existing) assert(await capture('git', ['rev-list', '-n', '1', tag]) === revision, `Tag ${tag} points to another revision.`);
  else await run('git', ['tag', '--annotate', tag, '--message', `Qubicl ${tag.slice(1)}`, revision], {
    env: { ...process.env, GIT_COMMITTER_NAME: 'Qubicl Maintainers', GIT_COMMITTER_EMAIL: 'contact@qubicl.org' },
  });
  const remote = await capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}*`]);
  if (remote) {
    const rows = remote.split('\n').map((line) => line.trim().split(/\s+/u));
    const peeled = rows.find(([, ref]) => ref === `refs/tags/${tag}^{}`)?.[0];
    const direct = rows.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0];
    assert((peeled ?? direct) === revision, `Remote tag ${tag} points to another revision.`);
  }
  else await run('git', ['push', 'origin', `refs/tags/${tag}`]);
}

async function requireCommand(command, args) {
  try { await run(command, args); } catch (error) { throw new Error(`Release prerequisite failed: ${command} ${args.join(' ')}.`, { cause: error }); }
}

async function succeeds(command, args) {
  try { await exec(command, args, { cwd: root, maxBuffer: 20_000_000 }); return true; } catch { return false; }
}

async function capture(command, args) {
  return (await exec(command, args, { cwd: root, maxBuffer: 50_000_000 })).stdout.trim();
}

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => signal ? reject(new Error(`${command} was terminated by ${signal}.`)) : code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}.`)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseGhcrReference(reference) {
  const match = /^ghcr\.io\/([^/]+)\/([^@]+):([^/:@]+)$/u.exec(reference);
  assert(match, `Release image must use a version-tagged ghcr.io reference: ${reference}.`);
  return { owner: match[1], packageName: match[2] };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main(process.argv.slice(2));
