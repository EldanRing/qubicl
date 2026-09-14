import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertTrivyScannerIdentity, normalizeRepository, REQUIRED_TRIVY_VERSION } from './candidate-evidence.mjs';
import { imageInputIdentities, IMAGE_INPUTS_NAME, RELEASE_IMAGES, selectImageActions, verifyImageInputs } from './release-inputs.mjs';

const exec = promisify(execFile);
export async function createReleasePlan(root, { reuse, now = new Date().toISOString() } = {}) {
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  const revision = await git('rev-parse', 'HEAD');
  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const { version } = workspace;
  const tools = { node: process.version, npm: (await exec('npm', ['--version'], { cwd: root })).stdout.trim() };
  const current = await imageInputIdentities(root, revision);
  let previous;
  let baseline;
  let scansFresh = false;
  let scanReason = 'no reusable scan reports';
  if (reuse) {
    const directory = resolve(reuse);
    baseline = JSON.parse(await readFile(join(directory, 'candidate.json'), 'utf8'));
    if (!/^[a-f0-9]{40}$/u.test(baseline.revision ?? '') || baseline.version !== version) throw new Error('--reuse requires a candidate from the same release version.');
    const repository = typeof workspace.repository === 'string' ? workspace.repository : workspace.repository?.url;
    if (baseline.source !== normalizeRepository(repository)) throw new Error('--reuse requires a candidate from the same source repository.');
    await git('merge-base', '--is-ancestor', baseline.revision, revision);
    if (!baseline.modes?.images || !baseline.modes?.scans) throw new Error('--reuse requires a complete image/scanner candidate.');
    const artifacts = new Map((baseline.artifacts ?? []).map((entry) => [entry.name, entry]));
    for (const name of [
      'image-catalog.json', 'trivy-bindings.json', 'oci-efficiency.json',
      ...RELEASE_IMAGES.map((image) => `qubicl-${image}.oci.tar`),
      ...RELEASE_IMAGES.flatMap((image) => ['linux-amd64', 'linux-arm64'].map((platform) => `trivy-${image}-${platform}.json`)),
    ]) {
      const artifact = artifacts.get(name);
      if (!Number.isInteger(artifact?.bytes) || !/^[a-f0-9]{64}$/u.test(artifact?.sha256 ?? '')) throw new Error(`--reuse candidate lacks exact ${name} identity.`);
    }
    if (baseline.imageInputs) {
      const evidence = await readFile(join(directory, IMAGE_INPUTS_NAME));
      if (baseline.imageInputs.name !== IMAGE_INPUTS_NAME || digest(evidence) !== baseline.imageInputs.sha256) throw new Error('Reusable image-input evidence does not match its candidate manifest.');
      previous = JSON.parse(evidence.toString('utf8'));
      await verifyImageInputs(previous, baseline, root);
    } else {
      for (const name of ['node', 'npm', 'docker', 'buildx']) {
        if (typeof baseline.tools?.[name] !== 'string') throw new Error(`Reusable candidate lacks its ${name} image toolchain identity.`);
      }
      const inputs = await imageInputIdentities(root, baseline.revision);
      previous = { schemaVersion: 1, version, revision: baseline.revision, images: Object.fromEntries(RELEASE_IMAGES.map((name) => [name, {
        version, revision: baseline.revision, inputSha256: inputs[name],
        node: baseline.tools.node, npm: baseline.tools.npm, docker: baseline.tools.docker, buildx: baseline.tools.buildx,
      }])) };
    }
    try {
      const evidence = await readFile(join(directory, 'trivy-bindings.json'));
      const expected = artifacts.get('trivy-bindings.json').sha256;
      if (digest(evidence) !== expected) throw new Error('Reusable Trivy binding does not match its candidate manifest.');
      const bindings = JSON.parse(evidence.toString('utf8'));
      assertTrivyScannerIdentity(bindings, now, { requiredSchemaVersion: 2, requiredVersion: REQUIRED_TRIVY_VERSION });
      scansFresh = true;
      scanReason = 'existing scan database is within the enforced freshness window';
    } catch (error) { scanReason = error.message; }
  }
  const images = selectImageActions({ current, previous, version, revision, tools, scansFresh });
  // A scan batch has one scanner/database identity. If any image needs scanning,
  // refresh the reports as one batch; this never invalidates the OCI archives.
  if (Object.values(images).some(({ scan }) => scan === 'scan')) {
    for (const image of Object.values(images)) image.scan = 'scan';
    scanReason = `scan batch refresh required: ${scanReason}`;
  }
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
  if (args.includes('--help')) console.log('Usage: node scripts/release-plan.mjs [--reuse CANDIDATE_DIRECTORY]\nRead-only build/reuse/scan plan. No Docker or network operations.');
  else {
    if (args.length && (args.length !== 2 || args[0] !== '--reuse')) throw new Error('Expected --reuse CANDIDATE_DIRECTORY.');
    console.log(JSON.stringify(await createReleasePlan(resolve(fileURLToPath(new URL('../', import.meta.url))), { reuse: args[1] }), null, 2));
  }
}
