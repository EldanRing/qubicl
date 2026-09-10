import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardPeerPolicy, readTlsFile, sha256, validateDashboardExposure } from '../../packages/cli/dist/dashboard/exposure.js';
import { dashboardServiceDefinition } from '../../packages/cli/dist/dashboard/service.js';
import { assertDashboardRuntimeInspection, dashboardConfigurationAtCatalog, renderDashboardCompose, assertDashboardConfiguration, requireRunningDashboardRuntime, startDashboardAtCurrentCatalog, type DashboardCatalogStartRuntime, type DashboardConfiguration } from '../../packages/cli/dist/dashboard/runtime.js';
import { dashboardLoopbackBindings, restoreDashboardAssetsIfDesired, type DashboardAssetRecoveryRuntime } from '../../packages/cli/dist/dashboard/command.js';
import { defaultConfig, defaultSecrets } from '../../packages/core/dist/index.js';
import { statePaths } from '../../packages/cli/dist/state.js';
import { TEST_GATEWAY_PRIVATE_KEY_PEM } from './gateway-test-fixtures.js';

function catalogStartFixture(initial: 'previous' | 'candidate' | 'foreign' | 'absent', running = true) {
  const previous: DashboardConfiguration = {
    schemaVersion: 1, installationId: randomUUID(), enabled: true, desiredRunning: true,
    localPort: 3212, assetPort: 3213,
    image: { requested: 'qubicl/dashboard:old', resolved: 'qubicl/dashboard:old', contentId: 'sha256:' + 'a'.repeat(64) },
    assetManifestSha256: 'b'.repeat(64),
  };
  const identity = { image: { requested: 'qubicl/dashboard:new', resolved: 'qubicl/dashboard:new' }, assetManifestSha256: 'c'.repeat(64) };
  const events: string[] = [];
  let current = initial;
  let runtimeRunning = running;
  let saved = structuredClone(previous);
  let failAcquire = false;
  let failSave = false;
  const runtime: DashboardCatalogStartRuntime = {
    catalogIdentity: async () => { events.push('catalog'); return identity; },
    acquireContentId: async (_root, config) => {
      events.push(`acquire:${config.image.requested}`);
      if (failAcquire) throw new Error('image verification failed');
      return 'sha256:' + 'd'.repeat(64);
    },
    inspectRuntime: async (_root, config, requireRunning = false) => {
      events.push(`inspect:${config.image.requested}:${requireRunning ? 'running' : 'retained'}`);
      if (current === 'absent') return false;
      if (current === 'foreign') throw new Error('runtime isolation mismatch');
      const expected = current === 'previous' ? previous.image.requested : identity.image.requested;
      if (config.image.requested !== expected) throw new Error('runtime identity mismatch');
      return !requireRunning || runtimeRunning;
    },
    replaceRuntime: async (_root, config) => { events.push(`replace:${config.image.requested}`); current = 'candidate'; runtimeRunning = true; },
    saveConfiguration: async (_root, config) => {
      events.push(`save:${config.image.requested}`);
      if (failSave) { failSave = false; throw new Error('config save failed'); }
      saved = structuredClone(config);
    },
    setRunning: async (_root, value, recreate) => { events.push(`set-running:${value}:${recreate}`); runtimeRunning = value; },
    readConfiguration: async () => structuredClone(saved),
  };
  return {
    previous, identity, events, runtime,
    failAcquire: () => { failAcquire = true; },
    failSave: () => { failSave = true; },
    state: () => ({ current, running: runtimeRunning, saved: structuredClone(saved) }),
  };
}

test('dashboard sidecar has no authority mounts and an isolated loopback asset publication', () => {
  const config: DashboardConfiguration = { schemaVersion: 1, installationId: randomUUID(), enabled: true, desiredRunning: true, localPort: 3212, assetPort: 3213, image: { requested: 'qubicl/dashboard:dev', resolved: 'qubicl/dashboard:dev' }, assetManifestSha256: 'a'.repeat(64) };
  assertDashboardConfiguration(config);
  const compose = renderDashboardCompose('/temporary/qubicl', config) as { services: Record<string, Record<string, unknown>>; networks: Record<string, Record<string, unknown>> };
  const service = compose.services['qubicl.dashboard']!;
  assert.deepEqual(service.ports, ['127.0.0.1:3213:3213']);
  assert.equal(service.volumes, undefined); assert.equal(service.environment, undefined);
  assert.equal(service.read_only, true); assert.deepEqual(service.cap_drop, ['ALL']);
  assert.equal(service.user, '1000:1000'); assert.equal(compose.networks.dashboard_assets!.driver, 'bridge');
  assert.equal(compose.networks.dashboard_assets!.internal, undefined);
  assert.throws(() => assertDashboardConfiguration({ ...config, assetPort: config.localPort }));
  assert.throws(() => assertDashboardConfiguration({ ...config, image: { requested: 'safe', resolved: 'safe', mount: '/host' } }));
});

test('empty Docker dashboard inspection is treated as an absent runtime', () => {
  const { previous } = catalogStartFixture('absent');
  assert.equal(assertDashboardRuntimeInspection((JSON.parse('[]') as unknown[])[0], '/temporary/qubicl', previous), false);
});

test('dashboard inspection retains stopped identity from configured bindings and requires live running mappings', () => {
  const root = '/temporary/qubicl';
  const config: DashboardConfiguration = {
    schemaVersion: 1, installationId: randomUUID(), enabled: true, desiredRunning: false,
    localPort: 3212, assetPort: 4313,
    image: { requested: 'qubicl/dashboard:dev', resolved: 'qubicl/dashboard:dev', contentId: `sha256:${'b'.repeat(64)}` },
    assetManifestSha256: 'a'.repeat(64),
  };
  const compose = renderDashboardCompose(root, config) as { name: string; networks: { dashboard_assets: { name: string } } };
  const stoppedInspection = {
    Id: 'f'.repeat(64), Image: config.image.contentId, State: { Running: false }, Mounts: [],
    Config: { Labels: {
      'dev.qubicl.installation': config.installationId,
      'dev.qubicl.role': 'dashboard',
      'dev.qubicl.dashboard-protocol-version': '1',
      'dev.qubicl.asset-manifest-sha256': config.assetManifestSha256,
      'com.docker.compose.project': compose.name,
    } },
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      PortBindings: { '3213/tcp': [{ HostIp: '127.0.0.1', HostPort: String(config.assetPort) }] },
    },
    // Docker does not retain a live port mapping after this container stops.
    NetworkSettings: { Ports: {}, Networks: { [compose.networks.dashboard_assets.name]: {} } },
  };
  assert.equal(assertDashboardRuntimeInspection(stoppedInspection, root, config), true);
  assert.equal(assertDashboardRuntimeInspection({ ...stoppedInspection, NetworkSettings: { ...stoppedInspection.NetworkSettings, Ports: null } }, root, config), true);
  assert.equal(assertDashboardRuntimeInspection(stoppedInspection, root, config, true), false);
  assert.throws(() => assertDashboardRuntimeInspection({
    ...stoppedInspection,
    HostConfig: { ...stoppedInspection.HostConfig, PortBindings: { '3213/tcp': [{ HostIp: '0.0.0.0', HostPort: String(config.assetPort) }] } },
  }, root, config), /ownership or isolation/);

  const runningInspection = { ...stoppedInspection, State: { Running: true } };
  assert.throws(() => assertDashboardRuntimeInspection({
    ...runningInspection,
    NetworkSettings: { ...runningInspection.NetworkSettings, Ports: { '3213/tcp': [] } },
  }, root, config), /ownership or isolation/);
  assert.equal(assertDashboardRuntimeInspection({
    ...runningInspection,
    NetworkSettings: { ...runningInspection.NetworkSettings, Ports: { '3213/tcp': [{ HostIp: '127.0.0.1', HostPort: String(config.assetPort) }] } },
  }, root, config, true), true);
});

test('login service definitions preserve argv boundaries without enabling pre-login Docker', () => {
  const id = randomUUID();
  const linux = dashboardServiceDefinition('/owner/state with spaces', id, 'linux', '/owner', '/usr/bin/node', '/owner/app with spaces/main.mjs', false);
  assert.match(linux.contents, /ExecStart="\/usr\/bin\/node" "\/owner\/app with spaces\/main.mjs" "dashboard" "serve"/);
  assert.match(linux.contents, /WantedBy=default.target/);
  assert.doesNotMatch(linux.contents, /docker\.service|multi-user\.target|linger/);
  const mac = dashboardServiceDefinition('/owner/state & data', id, 'darwin', '/owner', '/owner/bin/qubicl', undefined, true);
  assert.match(mac.path, /Library\/LaunchAgents/); assert.match(mac.contents, /state &amp; data/);
  assert.doesNotMatch(mac.contents, /\/bin\/sh|docker|LaunchDaemons/);
  assert.throws(() => dashboardServiceDefinition('/state\nExecStart=bad', id, 'linux'));
});

test('asset recovery rechecks desired state after acquiring the installation lock', async () => {
  const config: DashboardConfiguration = { schemaVersion: 1, installationId: randomUUID(), enabled: true, desiredRunning: true, localPort: 3212, assetPort: 3213, image: { requested: 'qubicl/dashboard:dev', resolved: 'qubicl/dashboard:dev' }, assetManifestSha256: 'a'.repeat(64) };
  let desiredRunning = true;
  let locked = false;
  let acquired = 0;
  let started = 0;
  const runtime: DashboardAssetRecoveryRuntime = {
    validateDocker: async () => undefined,
    withLock: async (_root, action) => {
      // A reviewed dashboard stop wins the lock after recovery was scheduled.
      desiredRunning = false;
      locked = true;
      try { return await action(); } finally { locked = false; }
    },
    readConfiguration: async () => {
      assert.equal(locked, true);
      return { ...config, desiredRunning };
    },
    assertRuntime: async () => false,
    acquireImage: async () => { acquired += 1; },
    setRunning: async () => { started += 1; },
  };
  await restoreDashboardAssetsIfDesired('/unused', runtime);
  assert.equal(acquired, 0);
  assert.equal(started, 0);
});

test('local helper listens only on validated DNS loopback families', () => {
  assert.deepEqual(dashboardLoopbackBindings(['127.0.0.1']), [{ host: '127.0.0.1' }]);
  assert.deepEqual(dashboardLoopbackBindings(['::1']), [{ host: '::1', ipv6Only: true }]);
  assert.deepEqual(dashboardLoopbackBindings(['::1', '127.0.0.1', '::1']), [{ host: '127.0.0.1' }, { host: '::1', ipv6Only: true }]);
  assert.throws(() => dashboardLoopbackBindings([]));
  assert.throws(() => dashboardLoopbackBindings(['127.0.0.1', '192.168.1.2']));
});

test('explicit dashboard restart advances only image trust roots to the embedded catalog', () => {
  const config: DashboardConfiguration = {
    schemaVersion: 1, installationId: randomUUID(), enabled: true, desiredRunning: false,
    localPort: 3212, assetPort: 3213,
    image: { requested: 'qubicl/dashboard:old', resolved: 'qubicl/dashboard@sha256:' + 'a'.repeat(64), contentId: 'sha256:' + 'b'.repeat(64) },
    assetManifestSha256: 'c'.repeat(64),
    remote: { bind: '192.168.1.2', hostname: 'admin.example.test', port: 3214, allowNetworks: ['192.168.1.0/24'], certificate: 'certificate', privateKey: 'private-key', certificateSha256: 'd'.repeat(64), privateKeySha256: 'e'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z' },
  };
  const updated = dashboardConfigurationAtCatalog(config, {
    image: { requested: 'qubicl/dashboard:current', resolved: 'qubicl/dashboard@sha256:' + 'f'.repeat(64) },
    assetManifestSha256: '1'.repeat(64),
  });
  assert.equal(updated.desiredRunning, true);
  assert.deepEqual(updated.image, { requested: 'qubicl/dashboard:current', resolved: 'qubicl/dashboard@sha256:' + 'f'.repeat(64) });
  assert.equal(updated.assetManifestSha256, '1'.repeat(64));
  assert.equal(updated.localPort, config.localPort);
  assert.deepEqual(updated.remote, config.remote);
  assert.equal(config.image.contentId, 'sha256:' + 'b'.repeat(64));
});

test('dashboard start refuses to publish success when the reviewed container is not running', async () => {
  const config: DashboardConfiguration = { schemaVersion: 1, installationId: randomUUID(), enabled: true, desiredRunning: true, localPort: 3212, assetPort: 3213, image: { requested: 'qubicl/dashboard:dev', resolved: 'qubicl/dashboard:dev' }, assetManifestSha256: 'a'.repeat(64) };
  await assert.rejects(
    requireRunningDashboardRuntime('/unused', config, async (_root, _config, requireRunning) => {
      assert.equal(requireRunning, true);
      return false;
    }),
    /did not reach its reviewed running state/,
  );
});

test('catalog start acquires before replacing an exact prior runtime and saves trust after running verification', async () => {
  const fixture = catalogStartFixture('previous');
  const result = await startDashboardAtCurrentCatalog('/unused', fixture.previous, false, false, fixture.runtime);
  assert.equal(result.image.requested, fixture.identity.image.requested);
  assert.deepEqual(fixture.events, [
    'catalog', 'acquire:qubicl/dashboard:new',
    'inspect:qubicl/dashboard:new:retained', 'inspect:qubicl/dashboard:old:retained',
    'replace:qubicl/dashboard:new', 'inspect:qubicl/dashboard:new:running',
    'save:qubicl/dashboard:new',
  ]);
});

test('catalog start rejects a foreign runtime without replacement or trust mutation', async () => {
  const fixture = catalogStartFixture('foreign');
  await assert.rejects(startDashboardAtCurrentCatalog('/unused', fixture.previous, false, false, fixture.runtime), /runtime isolation mismatch/);
  assert.equal(fixture.events.some((event) => event.startsWith('replace:') || event.startsWith('save:') || event.startsWith('set-running:')), false);
  assert.equal(fixture.state().saved.image.requested, fixture.previous.image.requested);
});

test('catalog image verification failure preserves the prior configuration and runtime', async () => {
  const fixture = catalogStartFixture('previous');
  fixture.failAcquire();
  await assert.rejects(startDashboardAtCurrentCatalog('/unused', fixture.previous, false, false, fixture.runtime), /image verification failed/);
  assert.deepEqual(fixture.events, ['catalog', 'acquire:qubicl/dashboard:new']);
  assert.deepEqual(fixture.state(), { current: 'previous', running: true, saved: fixture.previous });
});

test('catalog start retries config publication after a verified replacement without replacing twice', async () => {
  const fixture = catalogStartFixture('previous');
  fixture.failSave();
  await assert.rejects(startDashboardAtCurrentCatalog('/unused', fixture.previous, false, false, fixture.runtime), /config save failed/);
  assert.equal(fixture.state().current, 'candidate');
  assert.equal(fixture.state().saved.image.requested, fixture.previous.image.requested);
  await startDashboardAtCurrentCatalog('/unused', fixture.previous, false, false, fixture.runtime);
  assert.equal(fixture.events.filter((event) => event.startsWith('replace:')).length, 1);
  assert.equal(fixture.state().saved.image.requested, fixture.identity.image.requested);
});

test('catalog start resumes a retained stopped current target instead of replacing it', async () => {
  const fixture = catalogStartFixture('candidate', false);
  await startDashboardAtCurrentCatalog('/unused', fixture.previous, false, false, fixture.runtime);
  assert.equal(fixture.events.some((event) => event.startsWith('replace:')), false);
  assert.equal(fixture.events.at(-1), 'set-running:true:false');
  assert.deepEqual(fixture.state(), { current: 'candidate', running: true, saved: { ...fixture.previous, desiredRunning: true, image: { ...fixture.identity.image, contentId: 'sha256:' + 'd'.repeat(64) }, assetManifestSha256: fixture.identity.assetManifestSha256 } });
});

test('catalog start does not save trust when replacement never reaches running', async () => {
  const fixture = catalogStartFixture('absent');
  fixture.runtime.replaceRuntime = async (_root, config) => { fixture.events.push(`replace:${config.image.requested}`); };
  await assert.rejects(startDashboardAtCurrentCatalog('/unused', fixture.previous, false, false, fixture.runtime), /did not reach its reviewed running state/);
  assert.equal(fixture.events.some((event) => event.startsWith('save:')), false);
});

test('private peer policy rejects public, wildcard, loopback, and unselected clients', () => {
  const allowed = dashboardPeerPolicy(['192.168.1.0/24', '100.64.0.0/10', 'fd12::/16']);
  assert.equal(allowed('192.168.1.22'), true); assert.equal(allowed('::ffff:192.168.1.22'), true);
  assert.equal(allowed('100.80.1.2'), true); assert.equal(allowed('fd12::9'), true);
  for (const address of ['8.8.8.8', '127.0.0.1', '::1', '192.168.2.2']) assert.equal(allowed(address), false);
  for (const network of ['0.0.0.0/0', '10.0.0.0/0', '8.8.8.8/32', '127.0.0.1/32', '::/0']) assert.throws(() => dashboardPeerPolicy([network]));
});

test('direct TLS requires an exact private binding, unique certificate identity/key, and safe key files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-dashboard-tls-'));
  try {
    const keyPath = join(root, 'test.key'); const certPath = join(root, 'test.crt');
    await writeFile(keyPath, TEST_GATEWAY_PRIVATE_KEY_PEM, { mode: 0o600 });
    await promisify(execFile)('openssl', ['req', '-new', '-x509', '-key', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=admin.example.test', '-addext', 'subjectAltName=DNS:admin.example.test'], { timeout: 10000 });
    const certificate = await readFile(certPath, 'utf8');
    const remote = { bind: '192.168.1.2', hostname: 'admin.example.test', port: 3214, allowNetworks: ['192.168.1.0/24'], certificate, privateKey: TEST_GATEWAY_PRIVATE_KEY_PEM, certificateSha256: sha256(certificate), privateKeySha256: sha256(TEST_GATEWAY_PRIVATE_KEY_PEM), expiresAt: new Date(new X509Certificate(certificate).validTo).toISOString() };
    validateDashboardExposure(remote, undefined, ['192.168.1.2']);
    assert.throws(() => validateDashboardExposure(remote, undefined, ['192.168.1.3']), /exact private/);
    assert.throws(() => validateDashboardExposure({ ...remote, hostname: 'other.example.test' }, undefined, [remote.bind]), /exact administrator/);
    assert.throws(() => validateDashboardExposure(remote, undefined, [remote.bind], Date.parse(remote.expiresAt) + 1), /not currently valid/);
    for (const [index, extraName] of [
      'IP:192.168.1.2',
      'URI:https://admin.example.test/',
      'email:operator@example.test',
    ].entries()) {
      const extraPath = join(root, `extra-${index}.crt`);
      await promisify(execFile)('openssl', ['req', '-new', '-x509', '-key', keyPath, '-out', extraPath, '-days', '1', '-subj', '/CN=admin.example.test', '-addext', `subjectAltName=DNS:admin.example.test,${extraName}`], { timeout: 10000 });
      const extraCertificate = await readFile(extraPath, 'utf8');
      assert.throws(() => validateDashboardExposure({
        ...remote,
        certificate: extraCertificate,
        certificateSha256: sha256(extraCertificate),
        expiresAt: new Date(new X509Certificate(extraCertificate).validTo).toISOString(),
      }, undefined, [remote.bind]), /only its exact administrator DNS identity/);
    }
    const core = { paths: statePaths(root), config: defaultConfig(), secrets: defaultSecrets() };
    core.secrets.gateway = { tls: { id: randomUUID(), certificateChainPem: certificate, privateKeyPem: TEST_GATEWAY_PRIVATE_KEY_PEM } };
    assert.throws(() => validateDashboardExposure(remote, core, [remote.bind]), /distinct DNS identities and private keys/);
    assert.equal(await readTlsFile(keyPath, true), TEST_GATEWAY_PRIVATE_KEY_PEM);
    await symlink(keyPath, join(root, 'link.key')); await assert.rejects(readTlsFile(join(root, 'link.key'), true));
    await chmod(keyPath, 0o644); await assert.rejects(readTlsFile(keyPath, true), /owner-only/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
