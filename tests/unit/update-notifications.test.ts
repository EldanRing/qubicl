import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ComputerConfigSchema,
  ConfigSchema,
  catalogImageIdentity,
  createDevelopmentCatalog,
  presetDefaults,
  type ImageCatalog,
  type QubiclConfig,
} from '../../packages/core/dist/index.js';
import { statePaths } from '../../packages/cli/dist/state.js';
import {
  DEFAULT_LOCAL_PREFERENCES,
  localNotificationPlatformForHost,
  localUpdateNotification,
  maybePrintLocalUpdateNotification,
  parseUpdateNotificationPreference,
  readLocalPreferences,
  shouldEmitLocalUpdateNotification,
  writeUpdateNotificationPreference,
} from '../../packages/cli/dist/update-notifications.js';

test('local update preference is default-off, strict, private, and outside ConfigSchema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-update-preferences-'));
  try {
    const paths = statePaths(root);
    await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
    assert.deepEqual(await readLocalPreferences(paths), DEFAULT_LOCAL_PREFERENCES);
    assert.equal(parseUpdateNotificationPreference('on'), true);
    assert.equal(parseUpdateNotificationPreference('off'), false);
    assert.throws(() => parseUpdateNotificationPreference('yes'), /must be on or off/);
    await writeUpdateNotificationPreference(true, paths);
    assert.equal((await lstat(paths.preferences)).mode & 0o777, 0o600);
    assert.deepEqual(await readLocalPreferences(paths), { version: 1, updateNotifications: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('notification uses only the bundled catalog, excludes custom images, and writes one stderr-safe line', async () => {
  const { catalog, config } = fixture();
  const args = { positionals: [], options: new Map<string, string | boolean>() };
  const messages: string[] = [];
  let configReads = 0;
  await maybePrintLocalUpdateNotification('list', args, {
    paths: statePaths('/tmp/qubicl-notification-test'),
    readPreferences: async () => ({ version: 1, updateNotifications: true }),
    loadConfig: async () => { configReads += 1; return config; },
    catalog,
    platform: 'linux/amd64',
    write: (message) => messages.push(message),
  });
  assert.equal(configReads, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /1 gateway/);
  assert.doesNotMatch(messages[0]!, /computer/);
  assert.match(messages[0]!, /No network check, telemetry, pull, or automatic mutation/);
  assert.equal(messages[0]!.includes('\n'), false);

  assert.equal(localUpdateNotification(config, DEFAULT_LOCAL_PREFERENCES, catalog, 'linux/amd64'), undefined);
  config.gateway.image = {
    ...catalogImageIdentity(catalog.gateway, 'linux/amd64'),
    contentId: `sha256:${'d'.repeat(64)}`,
  };
  assert.equal(localUpdateNotification(config, { version: 1, updateNotifications: true }, catalog, 'linux/amd64'), undefined);
});

test('notifications exclude explicit update/config/client surfaces and machine-readable commands before reading preferences', async () => {
  const jsonArgs = { positionals: [], options: new Map<string, string | boolean>([['json', true]]) };
  const ordinaryArgs = { positionals: [], options: new Map<string, string | boolean>() };
  assert.equal(shouldEmitLocalUpdateNotification('list', ordinaryArgs), true);
  assert.equal(shouldEmitLocalUpdateNotification('list', jsonArgs), false);
  for (const command of ['help', 'version', 'setup', 'config', 'upgrade', 'status', 'connect', 'mcp']) {
    assert.equal(shouldEmitLocalUpdateNotification(command, ordinaryArgs), false);
  }
  let reads = 0;
  await maybePrintLocalUpdateNotification('list', jsonArgs, {
    readPreferences: async () => { reads += 1; return { version: 1, updateNotifications: true }; },
  });
  assert.equal(reads, 0);
});

test('ordinary commands fail soft for optional notification preference and platform problems', async () => {
  const { catalog, config } = fixture();
  const args = { positionals: [], options: new Map<string, string | boolean>() };
  const messages: string[] = [];
  let configReads = 0;

  await maybePrintLocalUpdateNotification('list', args, {
    readPreferences: async () => { throw new Error('preferences are malformed'); },
    loadConfig: async () => { configReads += 1; return config; },
    catalog,
    write: (message) => messages.push(message),
  });
  await maybePrintLocalUpdateNotification('list', args, {
    readPreferences: async () => ({ version: 1, updateNotifications: true }),
    loadConfig: async () => { configReads += 1; return config; },
    catalog,
    hostArchitecture: 'riscv64',
    write: (message) => messages.push(message),
  });

  assert.equal(configReads, 0);
  assert.deepEqual(messages, []);
  assert.equal(localNotificationPlatformForHost(catalog, 'x64'), 'linux/amd64');
  assert.equal(localNotificationPlatformForHost(catalog, 'arm64'), 'linux/arm64');
  assert.equal(localNotificationPlatformForHost(catalog, 'riscv64'), undefined);
});

function fixture(): { catalog: ImageCatalog; config: QubiclConfig } {
  const catalog = createDevelopmentCatalog('0.2.0', 'bundled-signed-revision');
  catalog.gateway.requested = 'registry.example/qubicl/gateway:0.2.0';
  catalog.gateway.platforms['linux/amd64'] = {
    resolved: `${catalog.gateway.requested}@sha256:${'a'.repeat(64)}`,
    digest: `sha256:${'a'.repeat(64)}`,
    downloadBytes: 1,
    expandedBytes: 2,
  };
  const base = presetDefaults('workstation', 'linux/amd64', catalog);
  const custom = {
    ...base,
    preset: 'custom' as const,
    image: {
      ...base.image,
      requested: 'example.invalid/custom:retained',
      resolved: `example.invalid/custom@sha256:${'b'.repeat(64)}`,
    },
  };
  const computer = ComputerConfigSchema.parse({
    ...custom,
    id: '10000000-0000-4000-8000-000000000001',
    name: 'custom',
    runtimeName: 'custom',
    createdAt: '2026-08-27T00:00:00.000Z',
  });
  const config = ConfigSchema.parse({
    version: 3,
    installationId: '00000000-0000-4000-8000-000000000000',
    gateway: {
      port: 3211,
      image: {
        requested: 'registry.example/qubicl/gateway:old',
        resolved: `registry.example/qubicl/gateway@sha256:${'c'.repeat(64)}`,
      },
    },
    defaults: custom,
    nextName: 2,
    computers: [computer],
  });
  return { catalog, config };
}
