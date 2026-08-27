import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { computerExecutorContainerName, computerResourceEnvelope, computerRuntimeContainerNames, computerSessionContainerName, gatewayContainerName } from '../packages/cli/dist/runtime.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const options = parseArgs(process.argv.slice(2));
const iterations = options.iterations ?? 10;
const cli = resolve(root, 'packages/cli/dist/qubicl.mjs');
const timeAvailable = await stat('/usr/bin/time').then(() => true, () => false);

const revision = await command('git', ['rev-parse', 'HEAD']);
const dirty = (await command('git', ['status', '--porcelain'])).stdout.trim().length > 0;
const build = await timed('npm', ['run', 'build']);
const { CURATED_PRESETS, IMAGE_CATALOG, PRESET_DEFINITIONS } = await import('../packages/core/dist/index.js');
const help = await repeated(process.execPath, [cli, 'help'], iterations);
const version = await repeated(process.execPath, [cli, 'version'], iterations);
const packed = await packageMeasurement();
const images = {
  gateway: await imageMeasurement(currentReference(IMAGE_CATALOG.gateway)),
  ...Object.fromEntries(await Promise.all(CURATED_PRESETS.map(async (preset) => [
    preset,
    await imageMeasurement(currentReference(IMAGE_CATALOG.presets[preset].image)),
  ]))),
};
const runtime = options.runtime ? await runtimeMeasurements() : undefined;
const binary = options.binary ? await binaryMeasurement(resolve(options.binary), iterations) : undefined;

const report = {
  schemaVersion: 2,
  measuredAt: new Date().toISOString(),
  source: { revision: revision.stdout.trim(), dirty },
  environment: {
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    npm: (await command('npm', ['--version'])).stdout.trim(),
  },
  iterations,
  build: summarize([build]),
  cli: { help: summarize(help), version: summarize(version) },
  package: packed,
  images,
  ...(runtime ? { runtime } : {}),
  ...(binary ? { binary } : {}),
};

const budgets = evaluateBudgets(report);
printSummary(report, budgets);
if (options.output) {
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ ...report, budgets }, null, 2)}\n`);
  console.log(`JSON report: ${output}`);
}
if (options.json) console.log(JSON.stringify({ ...report, budgets }, null, 2));
if (budgets.some(({ passed }) => !passed)) process.exitCode = 1;

async function packageMeasurement() {
  const result = await command('npm', ['pack', '--workspace', 'packages/cli', '--dry-run', '--json', '--ignore-scripts']);
  const values = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
  const value = values[0];
  return {
    filename: value.filename,
    packedBytes: value.size,
    unpackedBytes: value.unpackedSize,
    files: value.files.map(({ path, size }) => ({ path, size })),
  };
}

async function imageMeasurement(reference) {
  const result = await command('docker', ['image', 'inspect', reference, '--format', '{{json .}}'], true);
  if (result.code !== 0) return { reference, available: false };
  const image = JSON.parse(result.stdout);
  return {
    reference,
    available: true,
    platformContentBytes: image.Size,
    operatingSystem: image.Os,
    architecture: image.Architecture,
  };
}

function currentReference(image) {
  const platform = `linux/${process.arch === 'x64' ? 'amd64' : process.arch}`;
  return image.platforms[platform]?.resolved ?? image.requested;
}

async function runtimeMeasurements() {
  const temporary = await mkdtemp(resolve(homedir(), `.qubicl-performance-${process.pid}-`));
  const runtimeEnvironment = { ...process.env, QUBICL_HOME: temporary };
  try {
    const measurements = {};
    const port = await freePort();
    await command(process.execPath, [cli, 'setup', '--preset', 'workstation', '--gateway-port', `${port}`, '--no-create', '--offline', '--yes'], { env: runtimeEnvironment });
    for (const preset of CURATED_PRESETS) {
      const policy = PRESET_DEFINITIONS[preset];
      const image = currentReference(IMAGE_CATALOG.presets[preset].image);
      const started = process.hrtime.bigint();
      await command(process.execPath, [cli, 'create', `performance-${preset}`, '--preset', preset, '--offline'], { env: runtimeEnvironment });
      const startupMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      measurements[preset] = {
        image,
        recommendation: { cpus: policy.cpus, memory: policy.memory, pidsLimit: policy.pidsLimit, ...(policy.shmSize ? { shmSize: policy.shmSize } : {}) },
        startupBudgetMs: policy.startupBudgetSeconds * 1000,
        startupMs,
        workload: 'pending',
      };
    }
    const config = YAML.parse(await readFile(resolve(temporary, 'config.yaml'), 'utf8'));
    const state = { paths: { root: temporary }, config };
    const computers = Object.fromEntries(config.computers.map((computer) => [computer.preset, computer]));
    const gateway = gatewayContainerName(config.installationId, temporary);
    await assertTopologyHealthy(gateway, state, computers);
    await Promise.all(CURATED_PRESETS.map(async (preset) => {
      await runPresetWorkload(state, computers[preset], preset);
      measurements[preset].workload = 'passed';
      measurements[preset].loaded = await aggregateStats(computerRuntimeContainerNames(state, computers[preset]));
      measurements[preset].resourceEnvelope = computerResourceEnvelope(computers[preset]);
    }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60_000));
    for (const preset of CURATED_PRESETS) {
      measurements[preset].idleAfterSeconds = 60;
      measurements[preset].idle = await aggregateStats(computerRuntimeContainerNames(state, computers[preset]));
    }
    measurements.sharedGateway = await aggregateStats([gateway]);
    return measurements;
  } finally {
    const compose = resolve(temporary, 'runtime', 'compose.yaml');
    if (await stat(compose).then(() => true, () => false)) await command('docker', ['compose', '--file', compose, 'down', '--remove-orphans'], true);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function assertTopologyHealthy(gateway, state, computers) {
  const names = [gateway, ...CURATED_PRESETS.flatMap((preset) => computerRuntimeContainerNames(state, computers[preset]))];
  for (const name of names) {
    const status = (await command('docker', ['inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', name])).stdout.trim();
    if (!/^running(?: healthy)?$/u.test(status)) throw new Error(`Full-topology self-test found ${name} in state ${status}.`);
  }
}

async function runPresetWorkload(state, computer, preset) {
  const executor = computerExecutorContainerName(state, computer);
  const session = computerSessionContainerName(state, computer);
  const container = ['browser', 'computer'].includes(preset) ? session : executor;
  const common = 'set -e; test "$(id -un)" = qubicl; mkdir -p /home/qubicl/performance; cd /home/qubicl/performance';
  const workload = preset === 'file-system'
    ? `${common}; git init -q; git config user.email local@example.invalid; git config user.name Qubicl; printf before >sample; sed -i 's/^before$/after/' sample; test "$(cat sample)" = after; head -c 1048576 /dev/zero | tr '\\0' x >/tmp/one-megabyte; test "$(wc -c </tmp/one-megabyte)" -eq 1048576; seq 1 500 | xargs touch`
    : preset === 'browser'
      ? `${common}; export DISPLAY=:0; chromium --new-tab 'data:text/html,<title>Qubicl%20performance</title>' 'data:text/html,<h1>second</h1>' 'data:text/html,<h1>third</h1>' >/tmp/chromium-tabs.log 2>&1; sleep 2; scrot /home/qubicl/performance/browser.png; test -s browser.png; xdotool mousemove 80 80; printf clipboard | xclip -selection clipboard; test "$(xclip -selection clipboard -o)" = clipboard`
      : preset === 'computer'
        ? `${common}; export DISPLAY=:0; command -v thunar; command -v mousepad; command -v ristretto; command -v atril; printf desktop >desktop.txt; mousepad desktop.txt >/tmp/mousepad.log 2>&1 & sleep 2; xdotool search --onlyvisible --name 'desktop.txt' >/dev/null; pkill -x mousepad`
        : `${common}; printf '#include <stdio.h>\nint main(void){puts("ok");}\n' >check.c; cc check.c -o check; test "$(./check)" = ok; python3 -c 'from pathlib import Path; Path("python-ok").write_text("ok")'; pip3 --version >/dev/null; printf office >office.txt; libreoffice --headless --convert-to pdf --outdir . office.txt >/tmp/libreoffice-performance.log 2>&1; test -s office.pdf`;
  const result = await command('docker', ['exec', container, 'runuser', '-u', 'qubicl', '--', 'bash', '-ceu', workload], true);
  if (result.code !== 0) throw new Error(`${preset} recommendation workload failed: ${result.stderr.trim()}`);
}

async function aggregateStats(containers) {
  const values = await Promise.all(containers.map(async (container) => {
    const value = JSON.parse((await command('docker', ['stats', '--no-stream', '--format', '{{json .}}', container])).stdout);
    return { container, cpuPercent: Number.parseFloat(value.CPUPerc), memoryBytes: parseMemory(value.MemUsage.split('/')[0].trim()), pids: Number(value.PIDs) };
  }));
  return {
    containers: values,
    cpuPercent: values.reduce((sum, value) => sum + value.cpuPercent, 0),
    memoryBytes: values.reduce((sum, value) => sum + value.memoryBytes, 0),
    pids: values.reduce((sum, value) => sum + value.pids, 0),
  };
}

function parseMemory(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?i?B)$/iu.exec(value);
  if (!match) throw new Error(`Cannot parse Docker memory value ${value}.`);
  const powers = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 };
  const unit = match[2].toUpperCase();
  return Number(match[1]) * (unit.includes('I') ? 1024 : 1000) ** powers[unit];
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a performance-test port.');
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function binaryMeasurement(path, count) {
  const info = await stat(path);
  return { name: basename(path), bytes: info.size, help: summarize(await repeated(path, ['help'], count)), version: summarize(await repeated(path, ['version'], count)) };
}

async function repeated(program, args, count) {
  const samples = [];
  for (let index = 0; index < count; index += 1) samples.push(await timed(program, args));
  return samples;
}

async function timed(program, args) {
  const started = process.hrtime.bigint();
  const result = await timedCommand(program, args);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (result.code !== 0) throw new Error(`${program} ${args.join(' ')} failed (${result.code}):\n${result.stderr}`);
  return { elapsedMs, maxRssKiB: result.maxRssKiB };
}

async function timedCommand(program, args) {
  if (!timeAvailable) return { ...(await command(program, args, true)), maxRssKiB: undefined };
  if (process.platform === 'linux') {
    const marker = '__QUBICL_MAX_RSS_KIB__=';
    const result = await command('/usr/bin/time', ['-f', `${marker}%M`, program, ...args], true);
    const match = result.stderr.match(new RegExp(`${marker}(\\d+)`));
    return { ...result, maxRssKiB: match ? Number(match[1]) : undefined };
  }
  if (process.platform === 'darwin') {
    const result = await command('/usr/bin/time', ['-l', program, ...args], true);
    const match = result.stderr.match(/(\d+)\s+maximum resident set size/);
    return { ...result, maxRssKiB: match ? Math.round(Number(match[1]) / 1024) : undefined };
  }
  return { ...(await command(program, args, true)), maxRssKiB: undefined };
}

function summarize(samples) {
  const elapsed = samples.map(({ elapsedMs }) => elapsedMs).sort((left, right) => left - right);
  const rss = samples.flatMap(({ maxRssKiB }) => maxRssKiB === undefined ? [] : [maxRssKiB]).sort((left, right) => left - right);
  return {
    samples: samples.length,
    elapsedMs: { min: elapsed[0], median: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95), max: elapsed.at(-1) },
    maxRssKiB: rss.length ? { median: percentile(rss, 0.5), p95: percentile(rss, 0.95), max: rss.at(-1) } : null,
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function evaluateBudgets(report) {
  const checks = [
    // The CLI package deliberately carries both the minimal Playwright runtime
    // and the verified, operator-selectable core skill baselines installed
    // into computer images. Keep a narrow ceiling above that reviewed payload
    // so types, trace UIs, installers, or unrelated assets cannot silently land.
    budget('npm packed bytes', report.package.packedBytes, 7_000_000),
    // Loading the full lifecycle/security command surface remains interactive;
    // 125 ms leaves ordinary local scheduling jitter without masking regressions.
    budget('CLI help p95 milliseconds', report.cli.help.elapsedMs.p95, 125),
  ];
  if (report.cli.help.maxRssKiB) checks.push(budget('CLI help max RSS KiB', report.cli.help.maxRssKiB.max, 96 * 1024));
  if (report.images.gateway.available) checks.push(budget('gateway platform bytes', report.images.gateway.platformContentBytes, 65_000_000));
  // The universal local web service, source skill catalog, and common CLI utilities
  // are present in every image. Browser adds Chromium, OCR, and its smaller
  // document closure; computer adds XFCE, SSH, and the full document closure;
  // workstation adds LibreOffice and the compiler toolchain.
  const imageBudgets = { 'file-system': 205_000_000, browser: 625_000_000, computer: 675_000_000, workstation: 925_000_000 };
  for (const [preset, maximum] of Object.entries(imageBudgets)) {
    if (report.images[preset].available) checks.push(budget(`${preset} platform bytes`, report.images[preset].platformContentBytes, maximum));
    if (report.runtime?.[preset]) checks.push(budget(`${preset} startup milliseconds`, report.runtime[preset].startupMs, report.runtime[preset].startupBudgetMs));
  }
  return checks;
}

function budget(name, observed, maximum) {
  return { name, observed, maximum, passed: observed <= maximum };
}

function printSummary(report, budgets) {
  console.log('Qubicl local performance report');
  console.log(`source       ${report.source.revision.slice(0, 12)}${report.source.dirty ? ' (dirty)' : ''}`);
  console.log(`build        ${formatMs(report.build.elapsedMs.p95)}; peak RSS ${formatRss(report.build.maxRssKiB?.max)}`);
  console.log(`CLI help     p95 ${formatMs(report.cli.help.elapsedMs.p95)}; peak RSS ${formatRss(report.cli.help.maxRssKiB?.max)}`);
  console.log(`CLI version  p95 ${formatMs(report.cli.version.elapsedMs.p95)}; peak RSS ${formatRss(report.cli.version.maxRssKiB?.max)}`);
  console.log(`npm package  ${formatBytes(report.package.packedBytes)} packed; ${formatBytes(report.package.unpackedBytes)} unpacked; ${report.package.files.length} files`);
  for (const image of Object.values(report.images)) {
    console.log(`${image.reference.padEnd(27)} ${image.available ? formatBytes(image.platformContentBytes) : 'not available locally'}`);
  }
  if (report.runtime) {
    for (const [preset, measurement] of Object.entries(report.runtime)) {
      if (preset === 'sharedGateway') continue;
      console.log(`${preset.padEnd(27)} startup ${formatMs(measurement.startupMs)}; idle ${measurement.idle.cpuPercent.toFixed(2)}% CPU, ${formatBytes(measurement.idle.memoryBytes)}, ${measurement.idle.pids} PIDs`);
    }
  }
  for (const check of budgets) console.log(`${check.passed ? 'PASS' : 'FAIL'} budget  ${check.name}: ${check.observed} <= ${check.maximum}`);
}

function formatMs(value) {
  return `${value.toFixed(1)} ms`;
}

function formatRss(value) {
  return value === undefined ? 'unavailable' : `${(value / 1024).toFixed(1)} MiB`;
}

function formatBytes(value) {
  return `${(value / 1_000_000).toFixed(2)} MB`;
}

function command(program, args, behavior = false) {
  const options = typeof behavior === 'boolean' ? {} : behavior;
  const allowFailure = typeof behavior === 'boolean' ? behavior : behavior.allowFailure ?? false;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (result.code === 0 || allowFailure) resolvePromise(result);
      else reject(new Error(`${program} ${args.join(' ')} failed (${result.code}):\n${stderr}`));
    });
  });
}

function parseArgs(args) {
  const parsed = { json: false, runtime: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--json') parsed.json = true;
    else if (value === '--runtime') parsed.runtime = true;
    else if (value === '--output' || value === '--binary' || value === '--iterations') {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      const key = value.slice(2);
      parsed[key] = key === 'iterations' ? Number(next) : next;
      index += 1;
    } else if (value === '--help') {
      console.log('Usage: npm run performance -- [--runtime] [--json] [--output report.json] [--iterations 10] [--binary path]');
      process.exit(0);
    } else throw new Error(`Unknown option ${value}.`);
  }
  if (parsed.iterations !== undefined && (!Number.isInteger(parsed.iterations) || parsed.iterations < 1 || parsed.iterations > 100)) {
    throw new Error('--iterations must be an integer from 1 to 100.');
  }
  return parsed;
}
