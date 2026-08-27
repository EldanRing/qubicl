import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IMAGE_CATALOG, defaultConfig, defaultSecrets, imageIdentity, presetDefaults } from '@qubicl/core';
import { parseArgs } from '../../packages/cli/dist/args.js';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { localDockerEndpoint, portAvailable } from '../../packages/cli/dist/docker.js';
import { buildGatewayExposureConfig } from '../../packages/cli/dist/gateway-access.js';
import { SetupCancelledError, choosePreset, confirm, presetComparison, type SetupPrompt } from '../../packages/cli/dist/prompts.js';
import { runImagePreflight, runSetupPreflight, validateStatePath, type PreflightServices } from '../../packages/cli/dist/preflight.js';
import { statePaths } from '../../packages/cli/dist/state.js';
import {
  buildSetupResult,
  completeInteractiveSelections,
  printHandoff,
  printPreflight,
  printPreview,
  selectionsFromArgs,
  shouldPromptForSetupSelections,
  setupRetryCommand,
  validateSetupMode,
} from '../../packages/cli/dist/setup.js';
import { buildSetupPlan, sameSetupSnapshot, snapshotSetup } from '../../packages/cli/dist/setup-plan.js';

const inspectNativeLinuxHost = async () => ({ platform: 'linux' as const, arch: 'x64', wsl: null });

class FakePrompt implements SetupPrompt {
  readonly output: string[] = [];
  redrawCount = 0;
  constructor(private readonly answers: string[]) {}
  write(message: string): void { this.output.push(message); }
  redraw(message: string): void { this.redrawCount += 1; this.output.push(message); }
  async question(_message: string): Promise<string> {
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error('No fake answer remains.');
    return answer;
  }
  close(): void {}
}

test('setup plan covers first run, rerun, preset/custom, no-create, no-start, and offline', () => {
  const first = snapshotSetup();
  assert.throws(() => buildSetupPlan(first, { createName: null }), /explicit preset/);
  assert.throws(() => buildSetupPlan(first, { preset: 'browser', image: 'custom', createName: null }), /mutually exclusive/);
  assert.throws(() => buildSetupPlan(first, { preset: 'browser', createName: null, start: false }), /no-start/);
  const browser = buildSetupPlan(first, { preset: 'browser', createName: 'research', start: false, offline: true, allowUnsupportedResources: true });
  assert.equal(browser.firstRun, true);
  assert.equal(browser.createName, 'research');
  assert.equal(browser.start, false);
  assert.equal(browser.offline, true);
  assert.equal(browser.proposedDefault.preset, 'browser');
  assert.equal(
    setupRetryCommand(browser),
    'qubicl setup --preset browser --cpus 2 --memory 2g --gateway-port 3211 --create research --no-start --offline --yes',
  );

  const current = defaultConfig();
  const rerun = buildSetupPlan(snapshotSetup(current), { image: 'example/custom:1', createName: null, allowUnsupportedResources: true });
  assert.equal(rerun.firstRun, false);
  assert.equal(rerun.proposedDefault.preset, 'custom');
  assert.match(rerun.warnings.join(' '), /custom image/i);
});

test('setup snapshot detects concurrent state mutations', () => {
  const config = defaultConfig();
  const snapshot = snapshotSetup(config);
  assert.equal(sameSetupSnapshot(snapshot, structuredClone(config)), true);
  const changed = structuredClone(config);
  changed.gateway.port += 1;
  assert.equal(sameSetupSnapshot(snapshot, changed), false);
  assert.equal(sameSetupSnapshot(snapshotSetup(), undefined), true);
  assert.equal(sameSetupSnapshot(snapshotSetup(), config), false);
});

test('noninteractive setup contract requires deterministic selections and confirmation', () => {
  assert.throws(() => validateSetupMode(parseArgs(['--preset', 'browser', '--no-create']), false), /--yes/);
  assert.throws(() => validateSetupMode(parseArgs(['--yes', '--no-create']), false), /--preset or --image/);
  assert.throws(() => validateSetupMode(parseArgs(['--yes', '--preset', 'browser']), false), /exactly one/);
  assert.throws(() => validateSetupMode(parseArgs(['--yes', '--preset', 'browser', '--create', 'one', '--no-create']), false), /mutually exclusive/);
  assert.throws(() => validateSetupMode(parseArgs(['--yes', '--preset', 'browser', '--no-create', '--no-start']), false), /only with --create/);
  assert.doesNotThrow(() => validateSetupMode(parseArgs(['--yes', '--preset', 'browser', '--create', 'one', '--no-start', '--offline', '--json']), false));
  assert.doesNotThrow(() => validateSetupMode(parseArgs(['--yes', '--image', 'example/custom:1', '--no-create']), false));
});

test('fully specified --yes setup skips redundant TTY selection prompts', () => {
  const completeArgs = parseArgs([
    '--yes', '--preset', 'workstation', '--cpus', '2', '--memory', '4g',
    '--gateway-port', '3211', '--no-create', '--offline',
  ]);
  assert.equal(shouldPromptForSetupSelections(completeArgs, selectionsFromArgs(completeArgs), true), false);

  const retryArgs = parseArgs(setupRetryCommand(buildSetupPlan(snapshotSetup(), {
    preset: 'browser', cpus: 2, memory: '2g', gatewayPort: 4321,
    createName: 'research', start: false, offline: true,
  })).split(' ').slice(2));
  assert.equal(shouldPromptForSetupSelections(retryArgs, selectionsFromArgs(retryArgs), true), false);

  const missingMemory = parseArgs([
    '--yes', '--preset', 'workstation', '--cpus', '2',
    '--gateway-port', '3211', '--no-create',
  ]);
  assert.equal(shouldPromptForSetupSelections(missingMemory, selectionsFromArgs(missingMemory), true), true);
  assert.equal(shouldPromptForSetupSelections(missingMemory, selectionsFromArgs(missingMemory), false), false);

  const reviewArgs = parseArgs([
    '--preset', 'workstation', '--cpus', '2', '--memory', '4g',
    '--gateway-port', '3211', '--no-create',
  ]);
  assert.equal(shouldPromptForSetupSelections(reviewArgs, selectionsFromArgs(reviewArgs), true), true);
});

test('numbered prompts support invalid retries, defaults, and no-color narrow output', async () => {
  const selectionPrompt = new FakePrompt(['wat', '2']);
  assert.deepEqual(await choosePreset(selectionPrompt), { preset: 'browser' });
  assert.match(selectionPrompt.output.join('\n'), /Select file-system/);
  const retainPrompt = new FakePrompt(['']);
  assert.deepEqual(await choosePreset(retainPrompt, { preset: 'computer' }), { preset: 'computer' });
  assert.equal(await confirm(new FakePrompt(['']), 'Proceed?', true), true);
  assert.equal(await confirm(new FakePrompt(['no']), 'Create?', true), false);
  const comparison = presetComparison(IMAGE_CATALOG, 'linux/amd64', 40);
  assert.equal(comparison.includes('\u001b['), false);
  assert.ok(comparison.split('\n').every((line) => line.length <= 40));
  for (const preset of ['file-system', 'browser', 'computer', 'workstation']) assert.match(comparison, new RegExp(preset));
  assert.match(comparison, /size not measured in source builds/);
  assert.doesNotMatch(comparison, /capabilities/);
  assert.match(presetComparison(IMAGE_CATALOG, 'linux/amd64', 200, true), /capabilities/);

  const customBack = new FakePrompt(['5', 'back', '1']);
  assert.deepEqual(await choosePreset(customBack), { preset: 'file-system' });
  await assert.rejects(choosePreset(new FakePrompt(['cancel'])), SetupCancelledError);
});

test('interactive selection supports back and retries invalid resources, ports, and names', async () => {
  let port = 40_000;
  while (port < 41_000 && !(await portAvailable(port))) port += 1;
  assert.ok(port < 41_000, 'a local test port is available');
  const prompt = new FakePrompt([
    'back', '2',
    'yes', 'not-a-cpu', '2', '128m', '2g',
    'not-a-port', `${port}`,
    'yes', 'Bad Name', 'research',
  ]);
  const selections = await completeInteractiveSelections(prompt, {}, undefined, {
    ok: true,
    checks: [{ status: 'warn', id: 'test-warning', detail: 'review this', guidance: 'take care' }],
    docker: {
      context: 'default',
      endpoint: 'unix:///var/run/docker.sock',
      engineVersion: '28.0.0',
      composeVersion: '2.30.0',
      operatingSystem: 'Linux',
      os: 'linux',
      architecture: 'x86_64',
      platform: 'linux/amd64',
      cpus: 8,
      memoryBytes: 16 * 1024 ** 3,
    },
  });
  assert.deepEqual(selections, {
    preset: 'browser',
    cpus: 2,
    memory: '2g',
    gatewayPort: port,
    createName: 'research',
    allowUnsupportedResources: false,
  });
  const output = prompt.output.join('\n');
  assert.match(output, /first setup step/);
  assert.match(output, /quarter-CPU/);
  assert.match(output, /at least 256m/);
  assert.match(output, /integer port/);
  assert.match(output, /use lowercase letters, numbers, and hyphens/);
  assert.match(output, /Setup notice:[\s\S]*WARN\ttest-warning\treview this\ttake care/);
  assert.ok(prompt.redrawCount >= 5, 'each setup decision redraws a focused screen');
});

test('Docker endpoint and state-path discovery reject remote and symlinked locations', async () => {
  assert.equal(localDockerEndpoint('unix:///var/run/docker.sock'), true);
  assert.equal(localDockerEndpoint('npipe:////./pipe/docker_engine'), true);
  assert.equal(localDockerEndpoint('tcp://host:2375'), false);
  assert.equal(localDockerEndpoint('ssh://host'), false);
  const root = await mkdtemp(join(tmpdir(), 'qubicl-safe-root-'));
  assert.match(await validateStatePath(join(root, 'new', 'state')), /nearest existing parent/);
  const target = await mkdtemp(join(tmpdir(), 'qubicl-link-target-'));
  const linked = join(root, 'linked');
  await symlink(target, linked);
  await assert.rejects(validateStatePath(join(linked, 'state')), /not a real directory/);
});

test('image preflight requires the exact resolved identity and is offline-safe', async () => {
  const gateway = imageIdentity('registry.example/gateway:1', `registry.example/gateway@sha256:${'1'.repeat(64)}`);
  const computer = imageIdentity('registry.example/computer:1', `registry.example/computer@sha256:${'2'.repeat(64)}`, '3'.repeat(64));
  const requestedOnly = new Set([gateway.requested, computer.requested]);
  const inspected: string[] = [];
  const offline = await runImagePreflight(gateway, computer, true, async (reference) => {
    inspected.push(reference);
    return requestedOnly.has(reference);
  });
  assert.deepEqual(inspected, [gateway.resolved, computer.resolved]);
  assert.deepEqual(offline.map(({ status }) => status), ['fail', 'fail']);
  assert.match(offline[0]!.detail, /offline forbids obtaining it/);

  const online = await runImagePreflight(gateway, computer, false, async () => false);
  assert.deepEqual(online.map(({ status }) => status), ['warn', 'warn']);
  const local = await runImagePreflight(gateway, computer, true, async () => true);
  assert.deepEqual(local.map(({ status }) => status), ['pass', 'pass']);
});

test('setup preflight reports a complete healthy local host without mutating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-preflight-pass-'));
  const paths = statePaths(root);
  const services: PreflightServices = {
    inspectHostPlatform: inspectNativeLinuxHost,
    validateStatePath,
    inspectStateFormat: async () => ({ status: 'uninitialized', detail: 'no state' }),
    auditState: async () => [],
    inspectDockerHost: async () => ({
      context: 'default', endpoint: 'unix:///var/run/docker.sock', engineVersion: '28.0.0',
      composeVersion: '2.30.0', operatingSystem: 'Linux', os: 'linux', architecture: 'x86_64',
      platform: 'linux/amd64', cpus: 8, memoryBytes: 16 * 1024 ** 3,
    }),
    assertGatewayPort: async () => undefined,
    portAvailable: async () => true,
    filesystemObservation: async () => ({ path: root, availableBytes: 10_000, totalBytes: 20_000 }),
  };
  const result = await runSetupPreflight(paths, undefined, IMAGE_CATALOG, 4321, services);
  assert.equal(result.ok, true);
  assert.equal(result.docker?.platform, 'linux/amd64');
  assert.equal(result.hostDisk?.availableBytes, 10_000);
  assert.equal(result.checks.find(({ id }) => id === 'gateway-port')?.detail.includes('4321'), true);
  assert.equal(result.checks.find(({ id }) => id === 'docker-store-capacity')?.status, 'warn');
});

test('setup preflight preserves structured failures for state, Docker, and disk diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-preflight-fail-'));
  const paths = statePaths(root);
  const state = { paths, config: defaultConfig(), secrets: defaultSecrets() };
  const unavailable = new Error('deliberate test failure');
  const services: PreflightServices = {
    inspectHostPlatform: inspectNativeLinuxHost,
    validateStatePath: async () => { throw unavailable; },
    inspectStateFormat: async () => ({ status: 'current', detail: 'state format 3' }),
    auditState: async () => [{ check: 'state-config-file', ok: false, detail: 'wrong mode' }],
    inspectDockerHost: async () => { throw unavailable; },
    assertGatewayPort: async () => undefined,
    portAvailable: async () => false,
    filesystemObservation: async () => { throw unavailable; },
  };
  const result = await runSetupPreflight(paths, state, IMAGE_CATALOG, undefined, services);
  assert.equal(result.ok, false);
  assert.equal(result.docker, undefined);
  assert.equal(result.checks.find(({ id }) => id === 'state-path')?.status, 'fail');
  assert.match(result.checks.find(({ id }) => id === 'state-invariants')?.detail ?? '', /wrong mode/);
  assert.equal(result.checks.find(({ id }) => id === 'docker')?.status, 'fail');
  assert.equal(result.checks.find(({ id }) => id === 'host-disk')?.status, 'warn');
});

test('setup preview, result, handoff, and flag adapters remain complete and secret-free', () => {
  const selections = selectionsFromArgs(parseArgs([
    '--preset', 'browser', '--cpus', '2.5', '--memory', '3g', '--gateway-port', '4321',
    '--create', 'research', '--no-start', '--offline', '--allow-unsupported-resources',
  ]));
  assert.deepEqual(selections, {
    preset: 'browser', cpus: 2.5, memory: '3g', gatewayPort: 4321,
    createName: 'research', start: false, offline: true, allowUnsupportedResources: true,
  });

  const plan = buildSetupPlan(snapshotSetup(), selections, IMAGE_CATALOG, 'linux/amd64', {
    cpus: 8,
    memoryBytes: 16 * 1024 ** 3,
  });
  const preview: string[] = [];
  const preflight = {
    ok: true,
    checks: [{ status: 'pass' as const, id: 'docker', detail: 'local' }],
    hostDisk: { path: '/home', availableBytes: 1024 ** 3, totalBytes: 2 * 1024 ** 3 },
  };
  printPreflight(preflight, (line) => preview.push(line));
  printPreview(plan, '/home/test/.qubicl', preflight, 'Images 1GB', (line) => preview.push(line));
  assert.match(preview.join('\n'), /127\.0\.0\.1:4321/);
  assert.match(preview.join('\n'), /image size: not measured for source builds/);
  assert.match(preview.join('\n'), /create, do not start/);
  assert.doesNotMatch(preview.join('\n'), /Preflight:/);
  assert.doesNotMatch(preview.join('\n'), /gateway image:/);
  assert.doesNotMatch(preview.join('\n'), /Docker usage now:/);

  const detailed: string[] = [];
  printPreflight(preflight, (line) => detailed.push(line), true);
  printPreview(plan, '/home/test/.qubicl', preflight, 'Images 1GB', (line) => detailed.push(line), true);
  assert.match(detailed.join('\n'), /Preflight:/);
  assert.match(detailed.join('\n'), /gateway image:/);
  assert.match(detailed.join('\n'), /Docker usage now:/);

  const paths = statePaths('/home/test/.qubicl');
  const state = { paths, config: defaultConfig(), secrets: defaultSecrets() };
  state.config.defaults = presetDefaults('browser');
  const computer = addConfiguredComputer(state, 'research', state.config.defaults);
  const result = buildSetupResult(state, computer, true, ['review warning']);
  assert.equal(result.computer?.view?.endsWith('/view'), true);
  assert.equal(JSON.stringify(result).includes('qubicl_'), false);
  const handoff: string[] = [];
  printHandoff(result, (line) => handoff.push(line));
  assert.match(handoff.join('\n'), /qubicl mcp research/);
  assert.match(handoff.join('\n'), /qubicl token show research/);
  assert.match(handoff.join('\n'), /Only \/home is durable/);

  state.config.gateway.exposure = buildGatewayExposureConfig({
    bindAddress: '0.0.0.0',
    port: 443,
    hostname: 'gateway.example.test',
    allowedNetworks: ['192.0.2.0/24'],
    tls: {
      id: '1'.repeat(64),
      certificateSha256: `sha256:${'2'.repeat(64)}`,
      privateKeySha256: `sha256:${'3'.repeat(64)}`,
      certificateFingerprint256: `sha256:${'4'.repeat(64)}`,
      certificateNotBefore: '2026-01-01T00:00:00.000Z',
      certificateNotAfter: '2126-01-01T00:00:00.000Z',
    },
  });
  const remoteResult = buildSetupResult(state, computer, true, []);
  assert.equal(remoteResult.computer?.remote?.origin, 'https://gateway.example.test');
  const remoteHandoff: string[] = [];
  printHandoff(remoteResult, (line) => remoteHandoff.push(line));
  assert.match(remoteHandoff.join('\n'), /Remote HTTPS: https:\/\/gateway\.example\.test/);

  const empty = buildSetupResult(state, undefined, false, []);
  assert.equal(empty.computer, null);
  const emptyHandoff: string[] = [];
  printHandoff(empty, (line) => emptyHandoff.push(line));
  assert.doesNotMatch(emptyHandoff.join('\n'), /bearer token/);
});
