import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertTrivyScannerIdentity, normalizeRepository, REQUIRED_TRIVY_VERSION } from './candidate-evidence.mjs';
import { inspectFailedCandidateDonor } from './candidate-failed-donor.mjs';
import { imageInputIdentities, IMAGE_INPUTS_NAME, RELEASE_IMAGES, selectImageActions, verifyImageInputs } from './release-inputs.mjs';

const exec = promisify(execFile);
export async function createReleasePlan(root, { reuse, reuseFailed, now = new Date().toISOString() } = {}) {
  if (reuse && reuseFailed) throw new Error('Choose --reuse or --reuse-failed, not both.');
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  const revision = await git('rev-parse', 'HEAD');
  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const { version } = workspace;
  const tools = { node: process.version, npm: (await exec('npm', ['--version'], { cwd: root })).stdout.trim() };
  const current = await imageInputIdentities(root, revision, 2);
  let previous;
  let baseline;
  const scansFresh = Object.fromEntries(RELEASE_IMAGES.map((name) => [name, false]));
  let scanReason = 'no reusable scan reports';
  if (reuse || reuseFailed) {
    const directory = resolve(reuse ?? reuseFailed);
    const failedDonor = reuseFailed
      ? await inspectFailedCandidateDonor(root, directory, { version, revision, now })
      : undefined;
    baseline = failedDonor?.baseline ?? JSON.parse(await readFile(join(directory, 'candidate.json'), 'utf8'));
    if (!/^[a-f0-9]{40}$/u.test(baseline.revision ?? '')) throw new Error('--reuse requires an exact candidate source revision.');
    const repository = typeof workspace.repository === 'string' ? workspace.repository : workspace.repository?.url;
    if (baseline.source !== normalizeRepository(repository)) throw new Error('--reuse requires a candidate from the same source repository.');
    await git('merge-base', '--is-ancestor', baseline.revision, revision);
    if (!baseline.modes?.images || (!baseline.modes?.scans && !failedDonor)) throw new Error('--reuse requires a complete image/scanner candidate.');
    const artifacts = new Map((baseline.artifacts ?? []).map((entry) => [entry.name, entry]));
    for (const name of [
      'image-catalog.json', 'oci-efficiency.json',
      ...RELEASE_IMAGES.map((image) => `qubicl-${image}.oci.tar`),
      ...(baseline.modes.scans ? ['trivy-bindings.json',
        ...RELEASE_IMAGES.flatMap((image) => ['linux-amd64', 'linux-arm64'].map((platform) => `trivy-${image}-${platform}.json`))] : []),
    ]) {
      const artifact = artifacts.get(name);
      if (!Number.isInteger(artifact?.bytes) || !/^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? '')) throw new Error(`--reuse candidate lacks exact ${name} identity.`);
    }
    if (failedDonor) {
      previous = failedDonor.previous;
    } else if (baseline.imageInputs) {
      const evidence = await readFile(join(directory, IMAGE_INPUTS_NAME));
      if (baseline.imageInputs.name !== IMAGE_INPUTS_NAME || digest(evidence) !== baseline.imageInputs.sha256) throw new Error('Reusable image-input evidence does not match its candidate manifest.');
      previous = JSON.parse(evidence.toString('utf8'));
      await verifyImageInputs(previous, baseline, root);
    } else {
      for (const name of ['node', 'npm', 'docker', 'buildx']) {
        if (typeof baseline.tools?.[name] !== 'string') throw new Error(`Reusable candidate lacks its ${name} image toolchain identity.`);
      }
      const inputs = await imageInputIdentities(root, baseline.revision, 2);
      previous = { schemaVersion: 2, version: baseline.version, revision: baseline.revision, images: Object.fromEntries(RELEASE_IMAGES.map((name) => [name, {
        version: baseline.version, revision: baseline.revision, inputSha256: inputs[name],
        node: baseline.tools.node, npm: baseline.tools.npm, docker: baseline.tools.docker, buildx: baseline.tools.buildx,
      }])) };
    }
    // Verify legacy evidence with its original rules, then calculate the new
    // version-independent identity at each actual image origin.
    if (previous.schemaVersion === 1) {
      const identities = new Map();
      for (const name of RELEASE_IMAGES) {
        const origin = previous.images[name];
        if (!identities.has(origin.revision)) identities.set(origin.revision, await imageInputIdentities(root, origin.revision, 2));
        origin.inputSha256 = identities.get(origin.revision)[name];
      }
      previous.schemaVersion = 2;
    }
    try {
      if (!baseline.modes.scans) throw new Error(failedDonor.scanReason);
      const evidence = await readFile(join(directory, 'trivy-bindings.json'));
      if (digest(evidence) !== artifacts.get('trivy-bindings.json').sha256) throw new Error('Reusable Trivy binding does not match its candidate manifest.');
      const bindings = JSON.parse(evidence.toString('utf8'));
      for (const name of RELEASE_IMAGES) {
        try {
          const scoped = bindings.schemaVersion === 3 ? { ...bindings, scans: bindings.scans.filter((scan) => scan.image === name) } : bindings;
          if (scoped.schemaVersion === 3 && scoped.scans.length !== 2) throw new Error(`Missing platform scans for ${name}.`);
          assertTrivyScannerIdentity(scoped, now, { requiredSchemaVersion: 2, requiredVersion: REQUIRED_TRIVY_VERSION });
          scansFresh[name] = true;
        } catch (error) { scanReason = error.message; }
      }
    } catch (error) { scanReason = error.message; }
    if (Object.values(scansFresh).every(Boolean)) scanReason = 'existing per-image scans are fresh';
  }
  const images = selectImageActions({ current, previous, version, revision, tools, scansFresh });
  const clean = await git('status', '--porcelain') === '';
  return {
    schemaVersion: 1, version, revision, clean, readyToExecute: clean,
    ...(baseline ? { baselineRevision: baseline.revision } : {}),
    images, scanReason,
    buildImages: RELEASE_IMAGES.filter((name) => images[name].action === 'build'),
    reuseImages: RELEASE_IMAGES.filter((name) => images[name].action === 'reuse'),
    scanImages: RELEASE_IMAGES.filter((name) => images[name].scan === 'scan'),
    cliArtifacts: ['npm', 'native'],
    acceptance: ['npm', 'native'],
    notes: [
      'Planning reads Git and metadata only; execution verifies reused archive bytes and provenance.',
      'Run upgrade/client/lifecycle diagnosis before freezing source. Candidate construction does not run release:check.',
      'Only --execute starts construction. A failure stops; it never starts another candidate automatically.',
    ],
  };
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('Usage: node scripts/release-plan.mjs [--reuse CANDIDATE_DIRECTORY | --reuse-failed FAILED_STAGING_DIRECTORY]\nRead-only build/reuse/scan plan. No Docker or network operations.');
  else {
    if (args.length && (args.length !== 2 || !['--reuse', '--reuse-failed'].includes(args[0])))
      throw new Error('Expected --reuse CANDIDATE_DIRECTORY or --reuse-failed FAILED_STAGING_DIRECTORY.');
    console.log(JSON.stringify(await createReleasePlan(resolve(fileURLToPath(new URL('../', import.meta.url))), {
      ...(args[0] === '--reuse' ? { reuse: args[1] } : args[0] === '--reuse-failed' ? { reuseFailed: args[1] } : {}),
    }), null, 2));
  }
}
