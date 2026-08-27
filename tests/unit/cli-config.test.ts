import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import YAML from 'yaml';
import { presetDefaults } from '@qubicl/core';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { initializeState, saveState, statePaths } from '../../packages/cli/dist/state.js';
import { portAvailable } from '../../packages/cli/dist/docker.js';
import { buildGatewayExposureConfig, validateGatewayTlsInput } from '../../packages/cli/dist/gateway-access.js';
import { writeGatewayTlsFixture } from './gateway-test-fixtures.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../packages/cli/dist/qubicl.mjs', import.meta.url));

test('config show and set manage validated defaults without hand-editing YAML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-cli-config-'));
  const env = { ...process.env, QUBICL_HOME: root };
  try {
    await initializeState(statePaths(root));
    const port = await freePort();
    const result = await exec('node', [cli, 'config', 'set', '--gateway-port', `${port}`, '--default-cpus', '3.5', '--default-memory', '6g'], { env });
    const changed = JSON.parse(result.stdout);
    assert.equal(changed.gateway.port, port);
    assert.equal(changed.defaults.preset, 'workstation');
    assert.equal(changed.defaults.cpus, 3.5);
    assert.equal(changed.defaults.memory, '6g');
    // Image availability is host-dependent: a developer may already have built
    // the default image locally. The command contract is the boolean signal,
    // not either environmental outcome.
    assert.equal(typeof changed.drift.defaultImage.local, 'boolean');
    const shown = await exec('node', [cli, 'config', 'show'], { env });
    assert.deepEqual(JSON.parse(shown.stdout), changed);
    const storedDefaults = YAML.parse(await readFile(join(root, 'config.yaml'), 'utf8')).defaults;
    assert.equal(storedDefaults.preset, 'workstation');
    assert.equal(storedDefaults.cpus, 3.5);
    assert.equal(storedDefaults.memory, '6g');

    const failed = await exec('node', [cli, 'config', 'set', '--default-cpus', '0'], { env }).then(() => undefined, (error) => error as { stderr: string });
    assert.match(failed?.stderr ?? '', /quarter-CPU increment from 0\.25 upward/i);
    assert.equal(YAML.parse(await readFile(join(root, 'config.yaml'), 'utf8')).defaults.cpus, 3.5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an interrupted config transaction rolls forward on the next command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-cli-config-recovery-'));
  const env = { ...process.env, QUBICL_HOME: root };
  try {
    await initializeState(statePaths(root));
    const interrupted = await exec('node', [cli, 'config', 'set', '--default-memory', '7g'], {
      env: { ...env, NODE_ENV: 'test', QUBICL_TEST_FAIL_AFTER: 'config-written' },
    }).then(() => undefined, (error) => error as { stderr: string });
    assert.match(interrupted?.stderr ?? '', /Simulated transaction interruption/);
    assert.equal((await stat(join(root, 'transaction.yaml'))).isFile(), true);

    const recovered = await exec('node', [cli, 'config', 'show'], { env });
    assert.equal(JSON.parse(recovered.stdout).defaults.memory, '7g');
    await assert.rejects(stat(join(root, 'transaction.yaml')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('connect derives a pinned Windows-to-WSL stdio launcher from the running CLI', async (context) => {
  if (!process.env.WSL_DISTRO_NAME) {
    context.skip('requires a live WSL environment');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'qubicl-cli-wsl-connect-'));
  const env = { ...process.env, QUBICL_HOME: root };
  try {
    const state = await initializeState(statePaths(root));
    addConfiguredComputer(state, 'research', presetDefaults('file-system'));
    await saveState(state);
    const result = await exec(process.execPath, [
      cli, 'connect', 'research', '--client', 'claude-desktop', '--client-host', 'windows',
    ], { env });
    const server = JSON.parse(result.stdout).mcpServers['qubicl-research'] as { command: string; args: string[] };
    assert.equal(server.command, 'wsl.exe');
    assert.deepEqual(server.args.slice(0, 4), ['-d', process.env.WSL_DISTRO_NAME, '--', process.execPath]);
    assert.equal(server.args[4], cli);
    assert.deepEqual(server.args.slice(-2), ['mcp', 'research']);
    assert.match(result.stderr, /Windows-hosted client/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest export omits host-local exposure and all protected TLS bytes', async () => {
  const fixture = await writeGatewayTlsFixture('qubicl-cli-export-exposure-');
  const root = join(fixture.root, 'state');
  const output = join(fixture.root, 'qubicl.yaml');
  const env = { ...process.env, QUBICL_HOME: root };
  try {
    const state = await initializeState(statePaths(root));
    const validated = await validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      hostname: 'gateway.example.test',
      now: fixture.validAt,
    });
    state.config.gateway.exposure = buildGatewayExposureConfig({
      bindAddress: '0.0.0.0',
      port: 443,
      hostname: 'gateway.example.test',
      allowedNetworks: ['192.0.2.0/24'],
      tls: validated.metadata,
    });
    state.secrets.gateway = { tls: validated.secret };
    await saveState(state);

    await exec(process.execPath, [cli, 'export', '--output', output], { env });
    const raw = await readFile(output, 'utf8');
    const manifest = YAML.parse(raw) as { gateway: Record<string, unknown> };
    assert.deepEqual(Object.keys(manifest.gateway).sort(), ['image', 'port']);
    assert.equal(manifest.gateway.exposure, undefined);
    assert.doesNotMatch(raw, /gateway\.example\.test|BEGIN (?:CERTIFICATE|PRIVATE KEY)|certificateSha256|privateKeySha256/u);

    const persisted = YAML.parse(await readFile(join(root, 'config.yaml'), 'utf8')) as { gateway: { exposure?: { hostname?: string } } };
    assert.equal(persisted.gateway.exposure?.hostname, 'gateway.example.test');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  for (let port = 40_000; port < 41_000; port += 1) if (await portAvailable(port)) return port;
  throw new Error('No free test port found.');
}
