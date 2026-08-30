import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  ConfigSchema,
  GatewayExposureConfigSchema,
  GatewayExposureRuntimeSchema,
  HttpsOriginSchema,
  NetworkCidrSchema,
  SecretsSchema,
  certificateCoversGatewayHostname,
  defaultConfig,
  defaultSecrets,
  gatewayExposureOrigin,
  gatewayExposureTlsSecretMatches,
  presetDefaults,
  sha256Text,
} from '@qubicl/core';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { gatewayExternalReadinessCheck, inspectMounts } from '../../packages/cli/dist/commands.js';
import { gatewayExternalPublicationFromInspection } from '../../packages/cli/dist/docker.js';
import {
  GATEWAY_EXPOSURE_CERTIFICATE_FILE,
  GATEWAY_EXPOSURE_PRIVATE_KEY_FILE,
  GATEWAY_EXPOSURE_RUNTIME_DIRECTORY,
  GATEWAY_EXPOSURE_RUNTIME_DOCUMENT,
  buildGatewayExposureConfig,
  certificateHasPreviewWildcard,
  gatewayEndpointSet,
  gatewayExposureProbeHost,
  gatewayExposurePaths,
  normalizeBindAddress,
  normalizeGatewayHostname,
  normalizeGatewayPreviewDomain,
  normalizeHttpsOrigin,
  validateConfiguredGatewayTls,
  validateGatewayExposureRuntimeSnapshot,
  validateGatewayTlsInput,
} from '../../packages/cli/dist/gateway-access.js';
import {
  PREVIEW_ACCESS_CONTAINER_DIRECTORY,
  PREVIEW_ACCESS_CONTAINER_PATH,
  PREVIEW_ACCESS_RUNTIME_DIRECTORY,
  PREVIEW_ACCESS_RUNTIME_FILE,
  computerServiceName,
  renderRuntime,
} from '../../packages/cli/dist/runtime.js';
import { initializeState, loadState, saveState, statePaths } from '../../packages/cli/dist/state.js';
import {
  TEST_GATEWAY_CERTIFICATE_PEM,
  TEST_GATEWAY_PRIVATE_KEY_PEM,
  writeGatewayTlsFixture,
} from './gateway-test-fixtures.js';

const computerId = '00000000-0000-4000-8000-000000000901';

function fakeTlsMaterial() {
  return {
    id: '1'.repeat(64),
    certificateSha256: `sha256:${'2'.repeat(64)}` as const,
    privateKeySha256: `sha256:${'3'.repeat(64)}` as const,
    certificateFingerprint256: `sha256:${'4'.repeat(64)}` as const,
    certificateNotBefore: '2026-01-01T00:00:00.000Z',
    certificateNotAfter: '2126-01-01T00:00:00.000Z',
  };
}

test('gateway access validation keeps exposure absent by default and rejects malformed boundaries', () => {
  assert.equal(defaultConfig().gateway.exposure, undefined);
  assert.equal(defaultSecrets().gateway, undefined);
  assert.equal(normalizeBindAddress('[2001:db8::10]'), '2001:db8::10');
  assert.equal(normalizeGatewayHostname('Gateway.Example.Test.'), 'gateway.example.test');
  assert.equal(normalizeGatewayPreviewDomain('Preview.Example.Test.'), 'preview.example.test');
  assert.equal(normalizeHttpsOrigin('https://client.example.test:8443'), 'https://client.example.test:8443');

  for (const value of ['gateway.example.test', 'https://192.0.2.10', '192.0.2.0/24']) {
    assert.throws(() => normalizeBindAddress(value));
  }
  for (const value of [
    'https://gateway.example.test',
    'gateway.example.test:443',
    'user@gateway.example.test',
    'gateway.example.test/path',
    'gateway.example.test?query',
  ]) {
    assert.throws(() => normalizeGatewayHostname(value));
  }
  assert.throws(() => normalizeGatewayPreviewDomain('192.0.2.10'), /DNS domain/);

  for (const value of [
    'http://client.example.test',
    'https://user:secret@client.example.test',
    'https://client.example.test/path',
    'https://client.example.test?query=1',
    'https://client.example.test#fragment',
  ]) {
    assert.throws(() => HttpsOriginSchema.parse(value));
    assert.throws(() => normalizeHttpsOrigin(value));
  }

  assert.equal(NetworkCidrSchema.parse('192.0.2.0/24'), '192.0.2.0/24');
  assert.equal(NetworkCidrSchema.parse('2001:db8::/32'), '2001:db8::/32');
  for (const value of ['192.0.2.0', '192.0.2.0/33', '2001:db8::/129', 'example.test/24', '192.0.2.0/not-a-prefix', '0.0.0.0/00', '::/000']) {
    assert.throws(() => NetworkCidrSchema.parse(value));
  }
  let certificateSubjectPolicy: string | undefined;
  assert.equal(certificateCoversGatewayHostname({
    checkHost: (_hostname, options) => {
      certificateSubjectPolicy = options?.subject;
      return options?.subject === 'never' ? 'gateway.example.test' : undefined;
    },
    checkIP: () => undefined,
  }, 'gateway.example.test'), true);
  assert.equal(certificateSubjectPolicy, 'never');
  assert.throws(() => buildGatewayExposureConfig({
    bindAddress: '192.0.2.10',
    port: 443,
    hostname: 'gateway.example.test',
    allowedNetworks: [],
    tls: fakeTlsMaterial(),
  }));
  assert.throws(() => GatewayExposureConfigSchema.parse({
    protocol: 'direct-tls-v1',
    bindAddress: '192.0.2.10',
    port: 443,
    hostname: 'gateway.example.test',
    allowedNetworks: ['192.0.2.0/24'],
    trustedOrigins: ['https://different.example.test'],
    tls: fakeTlsMaterial(),
  }), /canonical gateway origin/);
  const previewRouteHostname = `preview-${computerId}.preview.example.test`;
  const collidingExposure = {
    protocol: 'direct-tls-v1' as const,
    bindAddress: '192.0.2.10',
    port: 443,
    hostname: previewRouteHostname,
    allowedNetworks: ['192.0.2.0/24'],
    trustedOrigins: [`https://${previewRouteHostname}`],
    previewDomain: 'preview.example.test',
    tls: fakeTlsMaterial(),
  };
  assert.throws(() => GatewayExposureConfigSchema.parse(collidingExposure), /generated per-computer preview hostname/);
  assert.throws(() => GatewayExposureRuntimeSchema.parse({
    version: 1,
    protocol: collidingExposure.protocol,
    hostname: collidingExposure.hostname,
    port: collidingExposure.port,
    allowedNetworks: collidingExposure.allowedNetworks,
    trustedOrigins: collidingExposure.trustedOrigins,
    previewDomain: collidingExposure.previewDomain,
    certificateSha256: collidingExposure.tls.certificateSha256,
    privateKeySha256: collidingExposure.tls.privateKeySha256,
    certificateFingerprint256: collidingExposure.tls.certificateFingerprint256,
    certificateNotBefore: collidingExposure.tls.certificateNotBefore,
    certificateNotAfter: collidingExposure.tls.certificateNotAfter,
  }), /generated per-computer preview hostname/);
  const conflictingPorts = defaultConfig();
  conflictingPorts.gateway.exposure = buildGatewayExposureConfig({
    bindAddress: '192.0.2.10',
    port: conflictingPorts.gateway.port,
    hostname: 'gateway.example.test',
    allowedNetworks: ['192.0.2.0/24'],
    tls: fakeTlsMaterial(),
  });
  assert.throws(() => ConfigSchema.parse(conflictingPorts), /must differ from the local loopback gateway port/i);
});

test('doctor readiness requires the exact external listener health contract before any mTLS warning', () => {
  assert.equal(gatewayExternalReadinessCheck({ external: { configured: true, ready: true, protocol: 'direct-tls-v1' } }).status, 'ok');
  const configurationId = `sha256:${'a'.repeat(64)}`;
  assert.equal(gatewayExternalReadinessCheck({
    external: { configured: true, ready: true, protocol: 'direct-tls-v1', configurationId },
  }, configurationId).status, 'ok');
  assert.equal(gatewayExternalReadinessCheck({
    external: { configured: true, ready: true, protocol: 'direct-tls-v1', configurationId: `sha256:${'b'.repeat(64)}` },
  }, configurationId).status, 'fail');
  for (const value of [
    undefined,
    { external: { configured: true, ready: false, protocol: 'direct-tls-v1' } },
    { external: { configured: true, ready: true, protocol: 'direct-tls-v2' } },
    { external: { configured: false, ready: true, protocol: 'direct-tls-v1' } },
  ]) {
    assert.equal(gatewayExternalReadinessCheck(value).status, 'fail');
  }
});

test('doctor requires the dynamic preview access mount on managed controllers', () => {
  const baseMounts = [
    { Type: 'bind', Destination: '/home', RW: true },
    { Type: 'bind', Destination: '/run/qubicl/audit.jsonl', RW: true },
    { Type: 'bind', Destination: '/run/qubicl/policy.json', RW: false },
  ];
  const problems: string[] = [];
  inspectMounts('computer', {
    Mounts: [...baseMounts, { Type: 'bind', Destination: '/run/qubicl/preview-access', RW: false }],
  }, false, problems, true, true, true);
  assert.deepEqual(problems, []);

  const missing: string[] = [];
  inspectMounts('computer', { Mounts: baseMounts }, false, missing, true, true, true);
  assert.match(missing.join('\n'), /read-only preview access document/);
});

test('gateway publication inspection reconciles configured and actual Docker bindings', () => {
  const exact = { HostIp: '0.0.0.0', HostPort: '443' };
  assert.deepEqual(gatewayExternalPublicationFromInspection({
    State: { Running: true },
    HostConfig: { PortBindings: { '3216/tcp': [exact] } },
    NetworkSettings: { Ports: { '3216/tcp': [exact] } },
  }), { hostIp: '0.0.0.0', hostPort: 443 });
  assert.deepEqual(gatewayExternalPublicationFromInspection({
    State: { Running: true },
    HostConfig: { PublishAllPorts: true, PortBindings: {} },
    NetworkSettings: { Ports: { '3216/tcp': [{ HostIp: '0.0.0.0', HostPort: '49152' }] } },
  }), { hostIp: '0.0.0.0', hostPort: 49152, target: 'external-tls', verificationIssue: 'publish-all-ports' });
  assert.deepEqual(gatewayExternalPublicationFromInspection({
    State: { Running: true },
    HostConfig: { PortBindings: { '3216/tcp': [exact] } },
    NetworkSettings: { Ports: { '3216/tcp': [{ HostIp: '127.0.0.1', HostPort: '8443' }] } },
  }), { hostIp: '127.0.0.1', hostPort: 8443, verificationIssue: 'host-runtime-mismatch' });
  assert.deepEqual(gatewayExternalPublicationFromInspection({
    State: { Running: true },
    HostConfig: { PublishAllPorts: true, PortBindings: {} },
    NetworkSettings: { Ports: {} },
  }), {
    target: 'unexpected',
    verificationIssue: 'publish-all-ports',
    detail: 'Docker PublishAllPorts is enabled without an identifiable publication.',
  });
  assert.deepEqual(gatewayExternalPublicationFromInspection({
    State: { Running: true },
    HostConfig: { PortBindings: { '3216/tcp': [exact, { HostIp: '127.0.0.1', HostPort: '8443' }] } },
    NetworkSettings: { Ports: {} },
  }), {
    target: 'external-tls',
    verificationIssue: 'ambiguous-publication',
    detail: 'Gateway has ambiguous configured port publications.',
  });
  assert.deepEqual(gatewayExternalPublicationFromInspection({
    State: { Running: true },
    HostConfig: {
      PublishAllPorts: false,
      PortBindings: {
        '3211/tcp': [{ HostIp: '127.0.0.1', HostPort: '3211' }],
        '3128/tcp': [{ HostIp: '0.0.0.0', HostPort: '3128' }],
      },
    },
    NetworkSettings: {
      Ports: {
        '3211/tcp': [{ HostIp: '127.0.0.1', HostPort: '3211' }],
        '3128/tcp': [{ HostIp: '0.0.0.0', HostPort: '3128' }],
      },
    },
  }, 3211), {
    target: 'unexpected',
    verificationIssue: 'unexpected-publication',
    detail: 'Unexpected gateway target publication(s): 3128/tcp.',
  });
  const broadLocal = { HostIp: '0.0.0.0', HostPort: '3211' };
  assert.deepEqual(gatewayExternalPublicationFromInspection({
    State: { Running: true },
    HostConfig: { PublishAllPorts: false, PortBindings: { '3211/tcp': [broadLocal] } },
    NetworkSettings: { Ports: { '3211/tcp': [broadLocal] } },
  }, 3211), {
    hostIp: '0.0.0.0',
    hostPort: 3211,
    target: 'local-http',
    verificationIssue: 'unsafe-local-publication',
  });
});

test('gateway endpoint generation preserves local URLs and renders exact remote origins', () => {
  const computer = { id: computerId, capabilities: ['viewer'] };
  const localGateway = { port: 3211 };
  assert.deepEqual(gatewayEndpointSet(localGateway, computer, 'local'), {
    origin: 'http://127.0.0.1:3211',
    health: `http://127.0.0.1:3211/computers/${computerId}/health`,
    mcp: `http://127.0.0.1:3211/computers/${computerId}/mcp`,
    openapi: `http://127.0.0.1:3211/computers/${computerId}/openapi.json`,
    openTerminal: `http://127.0.0.1:3211/computers/${computerId}/open-terminal`,
    view: `http://127.0.0.1:3211/computers/${computerId}/view`,
    previewBase: `http://preview-${computerId}.localhost:3211/computers/${computerId}/previews`,
  });
  assert.equal(gatewayEndpointSet(localGateway, computer, 'remote'), undefined);

  const https443 = buildGatewayExposureConfig({
    bindAddress: '0.0.0.0',
    port: 443,
    hostname: 'gateway.example.test',
    allowedNetworks: ['192.0.2.0/24'],
    trustedOrigins: ['https://client.example.test'],
    previewDomain: 'preview.example.test',
    tls: fakeTlsMaterial(),
  });
  assert.equal(gatewayExposureOrigin(https443), 'https://gateway.example.test');
  const remote = gatewayEndpointSet({ port: 3211, exposure: https443 }, computer, 'remote');
  assert.deepEqual(remote, {
    origin: 'https://gateway.example.test',
    health: `https://gateway.example.test/computers/${computerId}/health`,
    mcp: `https://gateway.example.test/computers/${computerId}/mcp`,
    openapi: `https://gateway.example.test/computers/${computerId}/openapi.json`,
    openTerminal: `https://gateway.example.test/computers/${computerId}/open-terminal`,
    view: `https://gateway.example.test/computers/${computerId}/view`,
    previewBase: `https://preview-${computerId}.preview.example.test/computers/${computerId}/previews`,
  });

  const ipv6 = buildGatewayExposureConfig({
    bindAddress: '::',
    port: 8443,
    hostname: '2001:db8::10',
    allowedNetworks: ['2001:db8::/32'],
    tls: fakeTlsMaterial(),
  });
  assert.equal(gatewayExposureOrigin(ipv6), 'https://[2001:db8::10]:8443');
  assert.equal(
    gatewayEndpointSet({ port: 3211, exposure: ipv6 }, { id: computerId, capabilities: [] }, 'remote')?.mcp,
    `https://[2001:db8::10]:8443/computers/${computerId}/mcp`,
  );
  assert.equal(
    gatewayEndpointSet({ port: 3211, exposure: ipv6 }, { id: computerId, capabilities: [] }, 'remote')?.view,
    undefined,
  );
});

test('wildcard exposure probes an assigned non-loopback address inside the allowlist', () => {
  const interfaces = {
    ethernet: [
      { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.20/24' },
      { address: '2001:db8::20', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: '2001:db8::20/64', scopeid: 0 },
    ],
    loopback: [
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
    ],
  } as never;
  assert.equal(gatewayExposureProbeHost({
    bindAddress: '0.0.0.0',
    allowedNetworks: ['192.168.1.0/24'],
  }, interfaces), '192.168.1.20');
  assert.equal(gatewayExposureProbeHost({
    bindAddress: '::',
    allowedNetworks: ['2001:db8::/64'],
  }, interfaces), '2001:db8::20');
  assert.equal(gatewayExposureProbeHost({
    bindAddress: '0.0.0.0',
    allowedNetworks: ['198.51.100.0/24'],
  }, interfaces), undefined);
});

test('specific exposure requires the bound host address to be locally probeable through the allowlist', () => {
  assert.equal(gatewayExposureProbeHost({
    bindAddress: '192.168.1.20',
    allowedNetworks: ['192.168.1.0/24'],
  }), '192.168.1.20');
  assert.equal(gatewayExposureProbeHost({
    bindAddress: '192.168.1.20',
    allowedNetworks: ['192.168.2.0/24'],
  }), undefined);
  assert.equal(gatewayExposureProbeHost({
    bindAddress: '2001:db8::20',
    allowedNetworks: ['2001:db8::/64'],
  }), '2001:db8::20');
  assert.equal(gatewayExposureProbeHost({
    bindAddress: '2001:db8::20',
    allowedNetworks: ['2001:db9::/64'],
  }), undefined);
});

test('TLS input validation snapshots a matching bounded certificate without retaining source paths', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const validated = await validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      clientCertificateAuthorityPath: fixture.certificate,
      hostname: 'gateway.example.test',
      previewDomain: 'preview.example.test',
      now: fixture.validAt,
    });
    assert.equal(validated.secret.certificateChainPem, TEST_GATEWAY_CERTIFICATE_PEM);
    assert.equal(validated.secret.privateKeyPem, TEST_GATEWAY_PRIVATE_KEY_PEM);
    assert.equal(validated.secret.clientCertificateAuthorityPem, TEST_GATEWAY_CERTIFICATE_PEM);
    assert.equal(validated.metadata.certificateSha256, sha256Text(TEST_GATEWAY_CERTIFICATE_PEM));
    assert.equal(validated.metadata.privateKeySha256, sha256Text(TEST_GATEWAY_PRIVATE_KEY_PEM));
    assert.equal(validated.metadata.clientCertificateAuthoritySha256, sha256Text(TEST_GATEWAY_CERTIFICATE_PEM));
    assert.match(validated.metadata.certificateFingerprint256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(validated.metadata.certificateNotBefore, fixture.validFrom.toISOString());
    assert.equal(validated.metadata.certificateNotAfter, fixture.validTo.toISOString());
    assert.match(validated.certificateSubjectAltName ?? '', /gateway\.example\.test/);
    assert.doesNotMatch(JSON.stringify(validated), new RegExp(fixture.root.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')));

    const exposure = buildGatewayExposureConfig({
      bindAddress: '192.0.2.10',
      port: 443,
      hostname: 'gateway.example.test',
      allowedNetworks: ['192.0.2.0/24'],
      previewDomain: 'preview.example.test',
      tls: validated.metadata,
    });
    assert.equal(gatewayExposureTlsSecretMatches(exposure, validated.secret), true);
    const summary = validateConfiguredGatewayTls(exposure, validated.secret, fixture.validAt);
    assert.equal(summary.fingerprint256, validated.metadata.certificateFingerprint256);
    assert.equal(summary.clientCertificatesRequired, true);
    assert.match(summary.subject, /gateway\.example\.test/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('remote preview certificates require an explicit wildcard SAN', () => {
  const exactProbe = 'preview-00000000-0000-4000-8000-000000000001.preview.example.test';
  assert.equal(certificateHasPreviewWildcard({ subjectAltName: `DNS:${exactProbe}` }, 'preview.example.test'), false);
  assert.equal(certificateHasPreviewWildcard({ subjectAltName: 'DNS:*.preview.example.test' }, 'preview.example.test'), true);
});

test('TLS input validation rejects links, non-files, oversized input, mismatches, dates, and SAN gaps', async () => {
  const fixture = await writeGatewayTlsFixture();
  try {
    const linkedCertificate = join(fixture.root, 'linked-certificate.pem');
    const certificateDirectory = join(fixture.root, 'certificate-directory');
    const oversizedCertificate = join(fixture.root, 'oversized-certificate.pem');
    const unsafePrivateKey = join(fixture.root, 'unsafe-private-key.pem');
    await symlink(fixture.certificate, linkedCertificate);
    await mkdir(certificateDirectory);
    await writeFile(oversizedCertificate, 'x'.repeat(1_048_577), { mode: 0o600 });
    await writeFile(unsafePrivateKey, TEST_GATEWAY_PRIVATE_KEY_PEM, { mode: 0o600 });
    await chmod(unsafePrivateKey, 0o644);

    const validate = (overrides: Partial<Parameters<typeof validateGatewayTlsInput>[0]> = {}) => validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      hostname: 'gateway.example.test',
      now: fixture.validAt,
      ...overrides,
    });
    await assert.rejects(validate({ certificatePath: linkedCertificate }), /symbolic link|regular file/i);
    await assert.rejects(validate({ certificatePath: certificateDirectory }), /regular file/i);
    await assert.rejects(validate({ certificatePath: oversizedCertificate }), /1048576-byte bound/i);
    await assert.rejects(validate({ privateKeyPath: unsafePrivateKey }), /must not be readable or writable by group or other users/i);
    await assert.rejects(validate({ privateKeyPath: fixture.mismatchedPrivateKey }), /invalid or mismatched|do not match/i);
    await assert.rejects(validate({ now: new Date(fixture.validFrom.getTime() - 1) }), /not valid until/i);
    await assert.rejects(validate({ now: new Date(fixture.validTo.getTime() + 1) }), /expired/i);
    await assert.rejects(validate({ hostname: 'other.example.test' }), /does not cover.*hostname/i);
    await assert.rejects(validate({ previewDomain: 'other-preview.example.test' }), /does not cover.*preview/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('state persistence requires an exact exposure/TLS pair', async () => {
  const fixture = await writeGatewayTlsFixture();
  const root = fixture.root;
  try {
    const paths = statePaths(join(root, 'state'));
    const state = await initializeState(paths);
    const validated = await validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      hostname: 'gateway.example.test',
      now: fixture.validAt,
    });
    const exposure = buildGatewayExposureConfig({
      bindAddress: '192.0.2.10',
      port: 443,
      hostname: 'gateway.example.test',
      allowedNetworks: ['192.0.2.0/24'],
      tls: validated.metadata,
    });
    state.config.gateway.exposure = exposure;
    await assert.rejects(saveState(state), /TLS secret material does not match/i);
    assert.equal(YAML.parse(await readFile(paths.config, 'utf8')).gateway.exposure, undefined);

    state.secrets.gateway = { tls: validated.secret };
    assert.doesNotThrow(() => ConfigSchema.parse(state.config));
    assert.doesNotThrow(() => SecretsSchema.parse(state.secrets));
    await saveState(state);
    assert.deepEqual((await loadState(paths)).config.gateway.exposure, exposure);

    state.secrets.gateway.tls.privateKeyPem = `${state.secrets.gateway.tls.privateKeyPem}\n`;
    assert.equal(gatewayExposureTlsSecretMatches(exposure, state.secrets.gateway.tls), false);
    await assert.rejects(saveState(state), /TLS secret material does not match/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime rendering keeps loopback unchanged and materializes only the opted-in TLS listener', async () => {
  const fixture = await writeGatewayTlsFixture();
  const root = fixture.root;
  try {
    const state = await initializeState(statePaths(join(root, 'state')));
    const computer = addConfiguredComputer(state, 'remote-browser', presetDefaults('browser'));
    await renderRuntime(state);
    const baseline = YAML.parse(await readFile(state.paths.compose, 'utf8')) as {
      services: Record<string, {
        environment?: Record<string, string>;
        ports?: Array<string | { target: number; published: string; host_ip: string; protocol: string }>;
        volumes?: Array<{ type: string; source: string; target: string; read_only?: boolean }>;
      }>;
    };
    assert.deepEqual(baseline.services.gateway?.ports, ['127.0.0.1:3211:3211']);
    assert.equal(baseline.services.gateway?.environment?.QUBICL_GATEWAY_EXTERNAL_PORT, undefined);
    assert.equal(
      baseline.services[computerServiceName(state, computer)]?.environment?.QUBICL_PUBLIC_PREVIEW_BASE,
      `http://preview-${computer.id}.localhost:3211/computers/${computer.id}/previews`,
    );
    assert.equal(
      baseline.services[computerServiceName(state, computer)]?.environment?.QUBICL_PREVIEW_ACCESS_PATH,
      PREVIEW_ACCESS_CONTAINER_PATH,
    );
    const previewAccessPath = join(
      state.paths.runtime,
      PREVIEW_ACCESS_RUNTIME_DIRECTORY,
      computer.id,
      PREVIEW_ACCESS_RUNTIME_FILE,
    );
    assert.deepEqual(JSON.parse(await readFile(previewAccessPath, 'utf8')), {
      version: 1,
      publicBaseUrl: `http://preview-${computer.id}.localhost:3211/computers/${computer.id}/previews`,
    });
    assert.ok(baseline.services[computerServiceName(state, computer)]?.volumes?.some((volume) => (
      volume.source === join(state.paths.runtime, PREVIEW_ACCESS_RUNTIME_DIRECTORY, computer.id)
      && volume.target === PREVIEW_ACCESS_CONTAINER_DIRECTORY
      && volume.read_only === true
    )));
    await assert.rejects(lstat(join(state.paths.runtime, GATEWAY_EXPOSURE_RUNTIME_DIRECTORY)), { code: 'ENOENT' });

    const validated = await validateGatewayTlsInput({
      certificatePath: fixture.certificate,
      privateKeyPath: fixture.privateKey,
      hostname: 'gateway.example.test',
      previewDomain: 'preview.example.test',
      now: fixture.validAt,
    });
    state.config.gateway.exposure = buildGatewayExposureConfig({
      bindAddress: '0.0.0.0',
      port: 443,
      hostname: 'gateway.example.test',
      allowedNetworks: ['192.0.2.0/24'],
      trustedOrigins: ['https://client.example.test'],
      previewDomain: 'preview.example.test',
      tls: validated.metadata,
    });
    state.secrets.gateway = { tls: validated.secret };
    await renderRuntime(state);

    const exposed = YAML.parse(await readFile(state.paths.compose, 'utf8')) as typeof baseline;
    const gateway = exposed.services.gateway!;
    assert.deepEqual(gateway.ports, [
      '127.0.0.1:3211:3211',
      { target: 3216, published: '443', host_ip: '0.0.0.0', protocol: 'tcp' },
    ]);
    assert.equal(gateway.environment?.QUBICL_GATEWAY_EXTERNAL_PORT, '3216');
    assert.equal(
      gateway.environment?.QUBICL_GATEWAY_EXPOSURE_CONFIG_PATH,
      `/runtime/${GATEWAY_EXPOSURE_RUNTIME_DIRECTORY}/${GATEWAY_EXPOSURE_RUNTIME_DOCUMENT}`,
    );
    assert.equal(
      gateway.environment?.QUBICL_GATEWAY_TLS_CERT_PATH,
      `/runtime/${GATEWAY_EXPOSURE_RUNTIME_DIRECTORY}/${GATEWAY_EXPOSURE_CERTIFICATE_FILE}`,
    );
    assert.equal(
      gateway.environment?.QUBICL_GATEWAY_TLS_KEY_PATH,
      `/runtime/${GATEWAY_EXPOSURE_RUNTIME_DIRECTORY}/${GATEWAY_EXPOSURE_PRIVATE_KEY_FILE}`,
    );
    assert.doesNotMatch(await readFile(state.paths.compose, 'utf8'), /BEGIN (?:CERTIFICATE|PRIVATE KEY)/u);
    assert.equal(
      exposed.services[computerServiceName(state, computer)]?.environment?.QUBICL_PUBLIC_PREVIEW_BASE,
      `http://preview-${computer.id}.localhost:3211/computers/${computer.id}/previews`,
    );
    assert.equal(exposed.services[computerServiceName(state, computer)]?.environment?.QUBICL_REMOTE_PREVIEW_BASE, undefined);
    assert.deepEqual(
      exposed.services[computerServiceName(state, computer)]?.environment,
      baseline.services[computerServiceName(state, computer)]?.environment,
    );
    assert.deepEqual(JSON.parse(await readFile(previewAccessPath, 'utf8')), {
      version: 1,
      publicBaseUrl: `http://preview-${computer.id}.localhost:3211/computers/${computer.id}/previews`,
      remoteBaseUrl: `https://preview-${computer.id}.preview.example.test/computers/${computer.id}/previews`,
    });

    const runtimePaths = gatewayExposurePaths(state.paths);
    assert.equal((await lstat(runtimePaths.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(runtimePaths.certificate)).mode & 0o777, 0o600);
    assert.equal((await lstat(runtimePaths.privateKey)).mode & 0o777, 0o600);
    assert.equal(await readFile(runtimePaths.certificate, 'utf8'), TEST_GATEWAY_CERTIFICATE_PEM);
    assert.equal(await readFile(runtimePaths.privateKey, 'utf8'), TEST_GATEWAY_PRIVATE_KEY_PEM);
    const runtimeDocument = JSON.parse(await readFile(runtimePaths.document, 'utf8')) as Record<string, unknown>;
    assert.equal(runtimeDocument.protocol, 'direct-tls-v1');
    assert.equal(runtimeDocument.hostname, 'gateway.example.test');
    assert.equal(runtimeDocument.port, 443);
    assert.deepEqual(runtimeDocument.allowedNetworks, ['192.0.2.0/24']);
    assert.equal('certificateChainPem' in runtimeDocument, false);
    assert.equal('privateKeyPem' in runtimeDocument, false);
    await assert.doesNotReject(validateGatewayExposureRuntimeSnapshot(state));
    await writeFile(runtimePaths.privateKey, `${TEST_GATEWAY_PRIVATE_KEY_PEM}\n`, { mode: 0o600 });
    await assert.rejects(validateGatewayExposureRuntimeSnapshot(state), /do not match the protected snapshot/i);
    await writeFile(runtimePaths.privateKey, TEST_GATEWAY_PRIVATE_KEY_PEM, { mode: 0o600 });
    await assert.doesNotReject(validateGatewayExposureRuntimeSnapshot(state));

    delete state.config.gateway.exposure;
    delete state.secrets.gateway;
    await renderRuntime(state);
    const revoked = YAML.parse(await readFile(state.paths.compose, 'utf8')) as typeof baseline;
    assert.deepEqual(revoked.services.gateway?.ports, ['127.0.0.1:3211:3211']);
    assert.deepEqual(JSON.parse(await readFile(previewAccessPath, 'utf8')), {
      version: 1,
      publicBaseUrl: `http://preview-${computer.id}.localhost:3211/computers/${computer.id}/previews`,
    });
    await assert.rejects(lstat(runtimePaths.directory), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
