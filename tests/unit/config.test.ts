import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConfigSchema,
  ComputerConfigSchema,
  NetworkPolicySchema,
  SecretsSchema,
  StateMigrationSchema,
  allocateName,
  assertStateComputerIdsMatch,
  assertValidName,
  defaultConfig,
  defaultSecrets,
  hashToken,
  parseManifestDocument,
  reconcileManifest,
  stateComputerIdMismatch,
  tokenMatches,
  type ComputerConfig,
  type QubiclManifest,
} from '@qubicl/core';

function computer(config: ReturnType<typeof defaultConfig>, id: string, name: string): ComputerConfig {
  return { id, name, createdAt: new Date().toISOString(), ...structuredClone(config.defaults) };
}

test('configuration validation rejects unsafe names and limits', () => {
  const config = defaultConfig();
  assert.equal(ConfigSchema.parse(config).gateway.port, 3211);
  assert.equal(config.version, 3);
  assert.throws(() => assertValidName('Bad Name'));
  assert.throws(() => ConfigSchema.parse({ ...config, gateway: { ...config.gateway, port: 70000 } }));
  const duplicate = computer(config, '00000000-0000-4000-8000-000000000001', 'same');
  assert.throws(() => ConfigSchema.parse({ ...config, computers: [duplicate, duplicate] }), /unique/);
  assert.throws(() => ConfigSchema.parse({
    ...config,
    defaults: { ...config.defaults, viewerAuthentication: 'header-v1' },
  }), /unrecognized key/i);
  assert.throws(() => ConfigSchema.parse({
    ...config,
    computers: [{ ...duplicate, viewerAuthentication: 'header-v1' }],
  }), /unrecognized key/i);
});

test('daily-driver policy schemas reject credential, environment, and network boundary escapes', () => {
  const config = defaultConfig();
  const configured = computer(config, '00000000-0000-4000-8000-000000000099', 'bounded');
  assert.throws(() => ComputerConfigSchema.parse({ ...configured, environment: { QUBICL_INTERNAL_KEY: 'leak' } }), /reserved environment name/);
  assert.throws(() => ComputerConfigSchema.parse({ ...configured, environment: { LD_PRELOAD: '/tmp/inject.so' } }), /reserved environment name/);
  assert.equal(ComputerConfigSchema.parse({ ...configured, environment: { PROJECT_MODE: 'test' } }).environment?.PROJECT_MODE, 'test');

  assert.equal(NetworkPolicySchema.parse({ profile: 'custom', allowDomains: ['api.example.com'], denyDomains: [], temporaryApprovals: [] }).profile, 'custom');
  assert.throws(() => NetworkPolicySchema.parse({ profile: 'web-only', allowDomains: ['http://example.com'], denyDomains: [], temporaryApprovals: [] }), /DNS name/);

  const secrets = defaultSecrets();
  secrets.computers[configured.id] = {
    token: 't'.repeat(43),
    internalKey: 'i'.repeat(43),
    brokerCredentials: [{
      id: 'github-api',
      baseUrl: 'https://api.github.com',
      pathPrefix: '/repos/',
      methods: ['GET'],
      header: 'Authorization',
      provider: { type: 'environment', name: 'GITHUB_TOKEN' },
    }],
  };
  assert.doesNotThrow(() => SecretsSchema.parse(secrets));
  secrets.computers[configured.id]!.brokerCredentials![0]!.baseUrl = 'http://api.github.com';
  assert.throws(() => SecretsSchema.parse(secrets), /https/);
});

test('config, secrets, and migration journals require the same computer IDs', () => {
  const config = defaultConfig();
  const configured = computer(config, '00000000-0000-4000-8000-000000000001', 'configured');
  const orphanId = '00000000-0000-4000-8000-000000000002';
  config.computers.push(configured);
  const secrets = defaultSecrets();
  secrets.computers[orphanId] = { token: 't'.repeat(32), internalKey: 'k'.repeat(32) };

  assert.deepEqual(stateComputerIdMismatch(config, secrets), {
    missingSecrets: [configured.id],
    orphanSecrets: [orphanId],
  });
  assert.throws(() => assertStateComputerIdsMatch(config, secrets), /missing secrets.*000000000001.*orphan secrets.*000000000002/);

  const migration = {
    version: 2,
    id: '00000000-0000-4000-8000-000000000003',
    createdAt: '2026-08-19T12:00:00.000Z',
    sourceVersion: 2,
    targetVersion: 3,
    backupName: 'backup-v2',
    config,
    secrets,
  } as const;
  assert.throws(() => StateMigrationSchema.parse(migration), /must exactly match config computer IDs/);

  delete secrets.computers[orphanId];
  secrets.computers[configured.id] = { token: 't'.repeat(32), internalKey: 'k'.repeat(32) };
  assert.doesNotThrow(() => assertStateComputerIdsMatch(config, secrets));
  assert.equal(StateMigrationSchema.parse(migration).config.computers[0]?.id, configured.id);
});

test('automatic names are monotonic and skip active collisions', () => {
  const config = defaultConfig();
  config.computers.push(computer(config, '00000000-0000-4000-8000-000000000001', 'qubicl-1'));
  assert.equal(allocateName(config), 'qubicl-2');
  config.computers = [];
  assert.equal(allocateName(config), 'qubicl-3');
});

test('token matching uses only deterministic hashes', () => {
  const hash = hashToken('secret-token');
  assert.equal(hash.length, 64);
  assert.equal(tokenMatches('secret-token', hash), true);
  assert.equal(tokenMatches('wrong-token', hash), false);
});

test('manifest v2 reconciliation preserves exact contracts and explicit pruning', () => {
  const config = defaultConfig();
  config.computers.push(
    computer(config, '00000000-0000-4000-8000-000000000001', 'keep'),
    computer(config, '00000000-0000-4000-8000-000000000002', 'omit'),
  );
  const manifest: QubiclManifest = {
    version: 2,
    gateway: { ...config.gateway, port: 4321 },
    defaults: config.defaults,
    computers: [
      { name: 'keep', ...structuredClone(config.defaults), cpus: 4 },
      { name: 'create', ...structuredClone(config.defaults) },
    ],
  };
  const safe = reconcileManifest(config, manifest, false);
  assert.deepEqual(safe.creates.map(({ name }) => name), ['create']);
  assert.deepEqual(safe.updates.map(({ name }) => name), ['keep']);
  assert.deepEqual(safe.trashes, []);
  assert.equal(safe.gatewayChanged, true);
  assert.deepEqual(reconcileManifest(config, manifest, true).trashes.map(({ name }) => name), ['omit']);
  assert.throws(() => reconcileManifest(config, { ...manifest, computers: [manifest.computers[0]!, { ...manifest.computers[0]! }] }, false), /more than once/);
});

test('manifest version 1 is accepted only through the explicit migration parser', () => {
  const fallback = defaultConfig();
  const legacy = { version: 1, gateway: { port: 4321 }, computers: [{ name: 'old', image: 'example/custom:1', cpus: 3, memory: '5g' }] };
  const parsed = parseManifestDocument(legacy, fallback);
  assert.equal(parsed.migrated, true);
  assert.equal(parsed.manifest.version, 2);
  assert.equal(parsed.manifest.computers[0]?.preset, 'custom');
  assert.equal(parsed.manifest.computers[0]?.compatibility, 'workstation');
  assert.equal(parsed.manifest.computers[0]?.image.requested, 'example/custom:1');
});
