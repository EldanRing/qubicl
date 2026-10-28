import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  IMAGE_NAMES, PLATFORMS, REQUIRED_TRIVY_VERSION, assertCatalogIdentity,
  assertTrivyScannerIdentity, canonicalJson, normalizeRepository, sha256,
  summarizeTrivyReports,
} from './candidate-evidence.mjs';
import { IMAGE_INPUTS_NAME, verifyImageInputs } from './release-inputs.mjs';

const exec = promisify(execFile);
const FAILED_NAME = /^\.failed-([0-9A-Za-z.+-]+)-([a-f0-9]{12})-linux-x64\.[1-9][0-9]*$/u;

// A failed staging directory is never promoted to a candidate. It may donate
// only exact image and scan bytes; the new candidate must run acceptance.
export async function inspectFailedCandidateDonor(root, directory, { version, revision, now = new Date().toISOString() }) {
  const source = resolve(directory);
  const match = FAILED_NAME.exec(basename(source));
  assert(match && match[1] === version, 'Reuse requires a preserved failed staging directory for this release.');
  const details = await lstat(source);
  assert(details.isDirectory() && !details.isSymbolicLink(), 'Failed staging must be a real directory.');
  const files = await readdir(source, { withFileTypes: true });
  assert(files.every((entry) => entry.isFile()), 'Failed staging may contain regular files only.');
  const names = new Set(files.map((entry) => entry.name));
  assert(!names.has('candidate.json') && !names.has('SHA256SUMS'), 'Use --reuse for a completed candidate.');
  const inputsBytes = await readFile(join(source, IMAGE_INPUTS_NAME));
  const inputs = JSON.parse(inputsBytes);
  assert(inputs.version === version && inputs.revision?.startsWith(match[2]),
    'Failed staging image inputs do not match its preserved identity.');
  await exec('git', ['merge-base', '--is-ancestor', inputs.revision, revision], { cwd: root });
  await verifyImageInputs(inputs, { version, revision: inputs.revision }, root);

  const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const repository = normalizeRepository(typeof workspace.repository === 'string' ? workspace.repository : workspace.repository?.url);
  const catalog = assertCatalogIdentity(JSON.parse(await readFile(join(source, 'image-catalog.json'), 'utf8')),
    { version, revision: inputs.revision, source: repository });
  const bindingsBytes = await readFile(join(source, 'trivy-bindings.json'));
  const bindings = JSON.parse(bindingsBytes);
  assert([2, 3].includes(bindings.schemaVersion),
    'Failed staging has an unsupported Trivy scanner or binding schema.');
  assert(Array.isArray(bindings.scans) && bindings.scans.length === IMAGE_NAMES.length * PLATFORMS.length,
    'Failed staging lacks complete scan bindings.');
  let scansFresh = true;
  let scanReason = 'saved scans are within the enforced freshness window';
  try {
    assertTrivyScannerIdentity(bindings, now, { requiredSchemaVersion: 2, requiredVersion: REQUIRED_TRIVY_VERSION });
  } catch (error) {
    scansFresh = false;
    scanReason = error.message;
  }

  const artifacts = [];
  const record = async (name) => {
    assert(names.has(name), `Failed staging is missing ${name}.`);
    const path = join(source, name);
    const info = await stat(path);
    const artifact = { name, bytes: info.size, sha256: await sha256(path) };
    artifacts.push(artifact);
    return artifact;
  };
  await record('image-catalog.json');
  await record('oci-efficiency.json');
  await record('trivy-bindings.json');
  const reportEntries = [];
  const expectedReports = new Set();
  for (const image of IMAGE_NAMES) {
    const archiveName = `qubicl-${image}.oci.tar`;
    const archive = await record(archiveName);
    const catalogImage = image === 'gateway' ? catalog.gateway : image === 'dashboard' ? catalog.dashboard.image : catalog.presets[image].image;
    for (const platform of PLATFORMS) {
      const reportName = `trivy-${image}-${platform.replace('/', '-')}.json`;
      expectedReports.add(reportName);
      const report = await record(reportName);
      const binding = bindings.scans.find((entry) => entry.report === reportName);
      assert(binding && binding.image === image && binding.platform === platform
        && binding.ociArchive === archiveName && binding.ociArchiveSha256 === archive.sha256
        && binding.reportSha256 === report.sha256
        && binding.indexDigest === catalogImage.indexDigest
        && binding.manifestDigest === catalogImage.platforms[platform].digest,
      `Failed staging scan binding does not match ${reportName} or its archive.`);
      reportEntries.push({ name: reportName, document: JSON.parse(await readFile(join(source, reportName), 'utf8')) });
    }
  }
  assert(new Set(bindings.scans.map((entry) => entry.report)).size === expectedReports.size
    && bindings.scans.every((entry) => expectedReports.has(entry.report)),
  'Failed staging has missing or duplicate scan bindings.');
  const exception = await record('vulnerability-exceptions.json');
  const applicability = await record('vulnerability-applicability.json');
  const summary = JSON.parse(await readFile(join(source, 'trivy-summary.json'), 'utf8'));
  const expectedSummary = summarizeTrivyReports(reportEntries,
    JSON.parse(await readFile(join(source, exception.name), 'utf8')), {
      evaluatedAt: summary.evaluatedAt,
      exceptionSha256: exception.sha256,
      applicabilityDocument: JSON.parse(await readFile(join(source, applicability.name), 'utf8')),
      applicabilitySha256: applicability.sha256,
      releaseTier: 'initial',
    });
  assert(canonicalJson(summary) === canonicalJson(expectedSummary) && summary.policy?.passed === true,
    'Failed staging scan policy evidence does not reproduce.');
  const scannerOutput = `Trivy ${(bindings.scanner ?? bindings.scans[0]?.scanner)?.version ?? 'unknown'} (retained provenance)`;
  return {
    baseline: {
      version, revision: inputs.revision, source: repository,
      modes: { images: true, scans: true },
      artifacts,
      imageInputs: { name: IMAGE_INPUTS_NAME, sha256: createHash('sha256').update(inputsBytes).digest('hex') },
      imageCatalog: { name: 'image-catalog.json', sha256: artifacts.find((entry) => entry.name === 'image-catalog.json').sha256 },
      tools: { trivy: scannerOutput },
    },
    previous: inputs,
    scansFresh,
    scanReason,
  };
}

function assert(condition, message) { if (!condition) throw new Error(message); }
