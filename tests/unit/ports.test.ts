import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { portAvailable } from '../../packages/cli/dist/docker.js';

test('gateway port probing distinguishes free and occupied ports', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  assert.equal(await portAvailable(port), false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await portAvailable(port), true);
});
