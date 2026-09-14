import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { assertCatalogIdentity } from './candidate-evidence.mjs';
import { IMAGE_INPUTS_NAME } from './release-inputs.mjs';
import { createReleasePlan } from './release-plan.mjs';
import { writeReleasePresetManifests } from './release-preset-manifests.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const exec = promisify(execFile);
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (option === '--execute' || option === '--help') options[option.slice(2)] = true;
  else if (['--candidate', '--upgrade-from'].includes(option) && args[index + 1] && !args[index + 1].startsWith('--')) options[option.slice(2)] = resolve(args[++index]);
  else throw new Error(`Unknown or incomplete option ${option}.`);
}
if (options.help) {
  console.log('Usage: node scripts/release-diagnose.mjs --candidate DIRECTORY [--upgrade-from OLD_NATIVE_CLI] [--execute]\nBuild current local code against an existing image catalog, then run source E2E or an isolated real upgrade. No image builds, scans, native packaging, signatures, or publication. Test state is retained after an upgrade.');
} else {
  if (!options.candidate) throw new Error('--candidate DIRECTORY is required.');
  const manifest = JSON.parse(await readFile(join(options.candidate, 'candidate.json'), 'utf8'));
  assert(manifest.imageCatalog?.name === 'image-catalog.json' && /^[a-f0-9]{64}$/u.test(manifest.imageCatalog.sha256 ?? ''),
    'Diagnostic candidate has no exact image catalog identity.');
  const catalogPath = join(options.candidate, 'image-catalog.json');
  const catalogBytes = await readFile(catalogPath);
  assert(digest(catalogBytes) === manifest.imageCatalog.sha256,
    'Diagnostic image catalog does not match candidate.json.');
  const catalog = assertCatalogIdentity(JSON.parse(catalogBytes.toString('utf8')), manifest);
  if (manifest.imageInputs) {
    assert(manifest.imageInputs.name === IMAGE_INPUTS_NAME && /^[a-f0-9]{64}$/u.test(manifest.imageInputs.sha256 ?? ''),
      'Diagnostic candidate has invalid image-input evidence.');
    const evidence = await readFile(join(options.candidate, IMAGE_INPUTS_NAME));
    assert(digest(evidence) === manifest.imageInputs.sha256,
      'Diagnostic image-input evidence does not match candidate.json.');
  }
  const compatibility = await createReleasePlan(root, { reuse: options.candidate });
  const plan = {
    stage: 'diagnosis', candidate: options.candidate,
    scenario: options['upgrade-from'] ? 'real-upgrade' : 'source-e2e',
    builds: ['local JavaScript'], imageBuilds: 0, scans: 0, nativeBuilds: 0,
    compatibleImageInputs: compatibility.buildImages.length === 0,
    cleanSource: compatibility.clean,
    finalReleaseEvidence: false,
  };
  console.log(JSON.stringify(plan, null, 2));
  if (options.execute) {
    assert(compatibility.clean, 'Diagnostic execution requires a clean committed source tree.');
    assert(compatibility.buildImages.length === 0,
      `Diagnostic candidate is stale for image inputs: ${compatibility.buildImages.join(', ')}.`);
    const env = {
      ...process.env,
      QUBICL_IMAGE_CATALOG_PATH: catalogPath,
      QUBICL_DEFAULT_GATEWAY_IMAGE: catalog.gateway.requested,
      QUBICL_DEFAULT_COMPUTER_IMAGE: catalog.presets.workstation.image.requested,
      QUBICL_E2E_SKIP_IMAGE_BUILD: '1',
    };
    await run('npm', ['run', 'build'], env);
    await writeReleasePresetManifests(root, {
      schemaVersion: 1,
      version: manifest.version,
      images: Object.fromEntries(Object.entries(compatibility.images).map(([name, value]) => [name, value.origin])),
    });
    if (options['upgrade-from']) await upgrade(options['upgrade-from'], env);
    else await run(process.execPath, ['scripts/test-artifact-e2e.mjs', 'source', '--no-build'], env);
  }
}

async function upgrade(oldCli, environment) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'qubicl-upgrade-diagnosis-'));
  console.log(`Isolated upgrade fixture retained at ${stateRoot}.`);
  const env = { ...environment, QUBICL_HOME: stateRoot };
  const current = join(root, 'packages/cli/dist/qubicl.mjs');
  const call = async (program, parameters) => (await exec(program, parameters, { cwd: root, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  const old = (parameters) => call(oldCli, parameters);
  const next = (parameters) => call(process.execPath, [current, ...parameters]);
  // Ask the host for an unused loopback port; startup still fails safely if
  // another process wins the bind before Qubicl does.
  const { createServer } = await import('node:net');
  const probe = createServer();
  await new Promise((resolvePromise, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolvePromise); });
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  try {
    await old(['setup', '--preset', 'file-system', '--gateway-port', String(port), '--no-create', '--offline', '--yes', '--no-clear']);
    await old(['create', 'upgrade-source', '--preset', 'file-system', '--offline', '--yes']);
    const before = JSON.parse(await old(['list', '--json'])).find(({ name }) => name === 'upgrade-source');
    assert(before, 'Old CLI did not create the upgrade fixture.');
    const tokenBefore = await old(['token', 'show', 'upgrade-source']);
    const markerPath = join(stateRoot, 'computers', before.id, 'home', 'qubicl', 'upgrade-marker.txt');
    await writeFile(markerPath, 'qubicl-upgrade-diagnosis\n', { mode: 0o600 });
    await next(['setup', '--preset', 'file-system', '--gateway-port', String(port), '--no-create', '--offline', '--yes', '--no-clear']);
    await next(['upgrade', '--all', '--offline', '--yes']);
    const after = JSON.parse(await next(['list', '--json'])).find(({ id }) => id === before.id);
    assert(after?.runtime?.health === 'healthy', 'Upgraded fixture is unhealthy.');
    assert(tokenBefore === await next(['token', 'show', 'upgrade-source']), 'Upgrade changed the compatibility token.');
    assert(await readFile(markerPath, 'utf8') === 'qubicl-upgrade-diagnosis\n', 'Upgrade lost durable data.');
    assert(JSON.parse(await next(['doctor', '--json'])).ok, 'Upgraded fixture failed doctor.');
    console.log(JSON.stringify({ passed: true, scenario: 'real-upgrade', finalReleaseEvidence: false, stateRoot }));
  } catch (error) {
    // CLI errors can contain sensitive state. Keep full diagnostics in the
    // protected fixture and print only the command and diagnostic location.
    const diagnostic = join(stateRoot, 'diagnosis-error.txt');
    await writeFile(diagnostic, `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message}\n`, { mode: 0o600 });
    throw new Error(`Upgrade diagnosis failed; inspect ${diagnostic}. Preserve ${dirname(diagnostic)} for recovery.`);
  }
}

function run(program, parameters, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, parameters, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${program} failed (${code}); diagnosis stopped.`)));
  });
}
function assert(value, message) { if (!value) throw new Error(message); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
