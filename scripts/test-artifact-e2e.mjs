import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractReleaseArchive, inspectReleaseArchive } from './artifact-evidence.mjs';
import { artifactAcceptanceIsolation } from './candidate-concurrency.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const mode = process.argv[2] ?? 'source';
const supportedModes = new Set(['source', 'npm', 'binary']);
if (!supportedModes.has(mode)) throw new Error(`Artifact mode must be source, npm, or binary; received ${mode}.`);
const options = parseOptions(process.argv.slice(3));

const temporary = await mkdtemp(join(tmpdir(), `qubicl-${mode}-e2e-`));

try {
  const cli = await prepareCli();
  if (process.env.QUBICL_E2E_SKIP_IMAGE_BUILD !== '1') await runCli(cli, ['image', 'build-system']);
  const isolation = artifactAcceptanceIsolation(mode, temporary);
  const testEnvironment = {
    ...process.env,
    QUBICL_E2E_ARTIFACT: mode,
    QUBICL_E2E_PORT_START: `${isolation.portStart}`,
    QUBICL_E2E_PORT_END: `${isolation.portEnd}`,
    QUBICL_E2E_IMAGE_NAMESPACE: isolation.imageNamespace,
  };
  delete testEnvironment.QUBICL_E2E_CLI;
  if (cli.kind !== 'source') testEnvironment.QUBICL_E2E_CLI = cli.program;
  await run(process.execPath, [join(root, 'tests', 'e2e', 'run.mjs')], {
    env: testEnvironment,
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function prepareCli() {
  if (mode === 'source') {
    if (!options.noBuild) await run('npm', ['run', 'build']);
    return {
      kind: 'source',
      program: process.execPath,
      prefix: [join(root, 'packages', 'cli', 'dist', 'qubicl.mjs')],
    };
  }

  if (mode === 'npm') {
    let archive = options.archive;
    if (!archive) {
      await run('npm', ['pack', '--workspace', 'packages/cli', '--pack-destination', temporary]);
      const archives = (await readdir(temporary)).filter((name) => name.endsWith('.tgz'));
      if (archives.length !== 1) throw new Error(`Expected one npm archive, found ${archives.length}.`);
      archive = join(temporary, archives[0]);
    }
    await inspectReleaseArchive(archive, 'package');
    const installRoot = join(temporary, 'install');
    await run('npm', ['install', '--prefix', installRoot, archive]);
    return {
      kind: 'npm',
      program: join(installRoot, 'node_modules', '.bin', 'qubicl'),
      prefix: [],
    };
  }

  if (options.archive) {
    const extractRoot = join(temporary, 'native');
    const target = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
    await extractReleaseArchive(options.archive, extractRoot, `qubicl-${target}`);
    return {
      kind: 'binary',
      program: join(extractRoot, `qubicl-${target}`, 'qubicl'),
      prefix: [],
    };
  }

  await run('npm', ['run', 'build:binary']);
  const target = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
  return {
    kind: 'binary',
    program: join(root, 'release', `qubicl-${target}`, 'qubicl'),
    prefix: [],
  };
}

function parseOptions(args) {
  const parsed = { archive: undefined, noBuild: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--no-build') {
      parsed.noBuild = true;
    } else if (option === '--archive') {
      if (!args[index + 1]) throw new Error('--archive requires a path.');
      parsed.archive = resolve(args[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown artifact E2E option ${option}.`);
    }
  }
  if (mode === 'source' && parsed.archive) throw new Error('Source E2E does not accept --archive.');
  if (mode !== 'source' && parsed.noBuild) throw new Error('--no-build is only valid for source E2E.');
  return parsed;
}

function runCli(cli, args) {
  return run(cli.program, [...cli.prefix, ...args]);
}

function run(program, args, options = {}) {
  const label = `${basename(program)} ${args.join(' ')}`;
  console.log(`\n> ${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${label} exited with ${code}.`)));
  });
}
