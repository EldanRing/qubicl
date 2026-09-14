import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolExecutor } from '../../packages/control/dist/executor.js';
import { PreviewManager, previewAccessFileSource } from '../../packages/control/dist/previews.js';

const localBase = 'http://preview-example.localhost:3211/computers/example/previews';
const internalBase = 'http://gateway:3211/computers/example/previews';
const remoteBase = 'https://preview-example.remote.test/computers/example/previews';

test('preview publication adds a remote URL without replacing existing local and browser URLs', async () => {
  const manager = new PreviewManager(
    { listPorts: async () => [{ port: 3000, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1',
    localBase,
    internalBase,
    remoteBase,
  );

  const published = await manager.publish(3000, 300) as {
    id: string;
    url: string;
    remoteUrl: string;
    browserUrl: string;
  };
  const local = new URL(published.url);
  const remote = new URL(published.remoteUrl);
  const browser = new URL(published.browserUrl);
  assert.equal(local.origin, `http://${published.id}--preview-example.localhost:3211`);
  assert.equal(remote.origin, `https://${published.id}--preview-example.remote.test`);
  assert.equal(browser.origin, new URL(internalBase).origin);
  assert.notEqual(remote.searchParams.get('token'), local.searchParams.get('token'));
  assert.equal(browser.searchParams.get('token'), local.searchParams.get('token'));
  assert.equal(local.pathname, '/');
  assert.equal(remote.pathname, '/');

  assert.deepEqual(manager.list().map(({ url, remoteUrl }) => ({ url, remoteUrl })), [{
    url: `http://${published.id}--preview-example.localhost:3211/`,
    remoteUrl: `https://${published.id}--preview-example.remote.test/`,
  }]);

  const localOnly = new PreviewManager(
    { listPorts: async () => [{ port: 3000, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1',
    localBase,
    internalBase,
  );
  assert.equal('remoteUrl' in await localOnly.publish(3000, 300), false);
});

test('owner previews follow the listener while remote shares rotate and revoke independently', async () => {
  let listening = true;
  let portInspections = 0;
  const manager = new PreviewManager(
    { listPorts: async () => {
      portInspections += 1;
      return listening ? [{ port: 3000, address: 'loopback', protocol: 'tcp' }] : [];
    } },
    '127.0.0.1',
    localBase,
    internalBase,
    remoteBase,
  );
  const owner = await manager.publish(3000) as { id: string; url: string; remoteSharingAvailable: boolean };
  assert.equal(owner.remoteSharingAvailable, true);
  assert.equal('remoteUrl' in owner, false);
  assert.equal(manager.list()[0]?.lifetime, 'while-listening');

  const first = manager.share(owner.id, 300);
  const second = manager.share(owner.id, 300);
  assert.notEqual(new URL(first.remoteUrl).searchParams.get('token'), new URL(second.remoteUrl).searchParams.get('token'));
  assert.equal(manager.list()[0]?.shareExpiresAt, second.expiresAt);
  assert.equal(manager.revokeShare(owner.id), true);
  assert.equal(manager.list()[0]?.shareExpiresAt, undefined);
  assert.equal(manager.list()[0]?.id, owner.id);

  listening = false;
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.deepEqual(manager.list(), []);
  const inspectionsAfterRemoval = portInspections;
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal(portInspections, inspectionsAfterRemoval);
});

test('preview publication reads expose, rotate, and revoke state dynamically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-preview-access-'));
  const path = join(directory, 'access.json');
  const writeAccess = async (remoteBaseUrl?: string): Promise<void> => {
    await writeFile(path, `${JSON.stringify({ version: 1, publicBaseUrl: localBase, ...(remoteBaseUrl ? { remoteBaseUrl } : {}) })}\n`, { mode: 0o600 });
  };
  try {
    await writeAccess();
    const manager = new PreviewManager(
      { listPorts: async () => [{ port: 3000, address: 'loopback', protocol: 'tcp' }] },
      '127.0.0.1',
      localBase,
      internalBase,
      undefined,
      previewAccessFileSource(path),
    );
    const initial = await manager.publish(3000, 300);
    assert.equal('remoteUrl' in initial, false);

    await writeAccess(remoteBase);
    assert.equal(manager.list()[0]?.remoteUrl, `https://${initial.id}--preview-example.remote.test/`);
    const exposed = await manager.publish(3000, 300);
    assert.equal(new URL(exposed.remoteUrl as string).hostname, `${exposed.id as string}--preview-example.remote.test`);

    const rotatedBase = 'https://preview-example.rotated.test/computers/example/previews';
    await writeAccess(rotatedBase);
    assert.equal(manager.list()[0]?.remoteUrl, `https://${initial.id}--preview-example.rotated.test/`);

    await writeAccess();
    assert.equal('remoteUrl' in manager.list()[0]!, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('gateway epoch rotation invalidates preview capabilities without an active lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qubicl-preview-epoch-'));
  const manager = new PreviewManager(
    { listPorts: async () => [{ port: 3000, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1',
    localBase,
    internalBase,
    remoteBase,
  );
  const executor = new ToolExecutor(undefined, { durableRoot: directory, previews: manager });
  try {
    await executor.observeGatewayEpoch('gateway-before-revoke');
    const published = await manager.publish(3000, 300) as { id: string };
    assert.equal(manager.list()[0]?.id, published.id);

    await executor.observeGatewayEpoch('gateway-after-reexpose');

    assert.deepEqual(manager.list(), []);
  } finally {
    await executor.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
