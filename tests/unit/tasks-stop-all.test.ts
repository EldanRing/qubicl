import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../packages/cli/dist/commands.js';
import { parseArgs } from '../../packages/cli/dist/args.js';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { inHostOperation } from '../../packages/cli/dist/operation-context.js';
import { initializeState, saveMetadata, saveState, statePaths } from '../../packages/cli/dist/state.js';
import { RemoteProcessManager } from '../../packages/control/dist/remote-runners.js';

test('tasks stop-all uses one atomic request, supports legacy services, and never falls back after ambiguous failure', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-stop-all-'));
  const calls: Array<{ method: string; path: string; body: string }> = [];
  let mode: 'atomic' | 'legacy' | 'failed' | 'disconnected' | 'invalid' = 'atomic';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = request.url ?? '';
    calls.push({ method: request.method!, path, body: Buffer.concat(chunks).toString('utf8') });
    response.setHeader('content-type', 'application/json');
    if (path.endsWith('/stop-all') || path.endsWith('/management-stop-all')) {
      if (mode === 'disconnected') { response.destroy(); return; }
      response.statusCode = mode === 'legacy' ? 404 : mode === 'failed' ? 502 : 200;
      response.end(JSON.stringify(mode === 'atomic' ? { stopped: 3 } : { error: { message: 'fixture response' } }));
    } else if (path.endsWith('/processes')) {
      response.end(JSON.stringify({ items: [
        { id: 'running', status: 'running', lifecycle: 'task' },
        { id: 'saved', status: 'exited', lifecycle: 'service' },
        { id: 'history', status: 'exited', lifecycle: 'task' },
      ] }));
    } else response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  const state = await initializeState(statePaths(home));
  state.config.gateway.port = port;
  const computer = addConfiguredComputer(state, 'work');
  await saveMetadata(state.paths, computer);
  await saveState(state);
  const run = () => inHostOperation(home, () => execute('tasks', parseArgs(['stop-all', computer.name, '--yes'])));
  const path = `/computers/${computer.id}/operator/management/processes`;
  await run();
  assert.deepEqual(calls, [{ method: 'POST', path: `${path}/stop-all`, body: '{}' }]);

  calls.length = 0;
  mode = 'legacy';
  await run();
  assert.deepEqual(calls.map(({ method, path: route }) => `${method} ${route}`), [
    `POST ${path}/stop-all`, `GET ${path}`, `POST ${path}/stop`, `POST ${path}/stop`,
  ]);
  assert.deepEqual(calls.slice(2).map(({ body }) => JSON.parse(body)), [{ processId: 'running' }, { processId: 'saved' }]);

  for (const failure of ['failed', 'disconnected', 'invalid'] as const) {
    calls.length = 0;
    mode = failure;
    await assert.rejects(run());
    assert.equal(calls.length, 1, `${failure} cannot replay an uncertain stop-all as per-process requests`);
  }

  mode = 'atomic';
  calls.length = 0;
  const remote = new RemoteProcessManager(`http://127.0.0.1:${port}`, 'fixture-key');
  assert.deepEqual(await remote.stopAllForManagement(), { stopped: 3 });
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/process/management-stop-all', body: '{}' }]);
  mode = 'invalid';
  await assert.rejects(remote.stopAllForManagement(), { code: 'internal_runner_ambiguous' });
});
