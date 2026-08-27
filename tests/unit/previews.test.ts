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
  assert.equal(local.origin, new URL(localBase).origin);
  assert.equal(remote.origin, new URL(remoteBase).origin);
  assert.equal(browser.origin, new URL(internalBase).origin);
  assert.equal(remote.searchParams.get('token'), local.searchParams.get('token'));
  assert.equal(browser.searchParams.get('token'), local.searchParams.get('token'));
  assert.match(local.pathname, new RegExp(`/${published.id}/$`, 'u'));
  assert.match(remote.pathname, new RegExp(`/${published.id}/$`, 'u'));

  assert.deepEqual(manager.list().map(({ url, remoteUrl }) => ({ url, remoteUrl })), [{
    url: `${localBase}/${published.id}/`,
    remoteUrl: `${remoteBase}/${published.id}/`,
  }]);

  const localOnly = new PreviewManager(
    { listPorts: async () => [{ port: 3000, address: 'loopback', protocol: 'tcp' }] },
    '127.0.0.1',
    localBase,
    internalBase,
  );
  assert.equal('remoteUrl' in await localOnly.publish(3000, 300), false);
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
    assert.equal(manager.list()[0]?.remoteUrl, `${remoteBase}/${initial.id}/`);
    const exposed = await manager.publish(3000, 300);
    assert.match(exposed.remoteUrl as string, new RegExp(`^${remoteBase}/`, 'u'));

    const rotatedBase = 'https://preview-example.rotated.test/computers/example/previews';
    await writeAccess(rotatedBase);
    assert.equal(manager.list()[0]?.remoteUrl, `${rotatedBase}/${initial.id}/`);

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
