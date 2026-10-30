import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProcessManager } from '@qubicl/control/processes';
import { ToolExecutor } from '@qubicl/control/executor';
import { PreviewManager } from '../../packages/control/dist/previews.js';
import * as sourcePorts from '../../packages/control/dist/ports.js';

const { attributeListeningPorts, discoverListeningPorts } = process.env.QUBICL_TEST_PORT_BUNDLE
  ? await import(process.env.QUBICL_TEST_PORT_BUNDLE) as typeof sourcePorts : sourcePorts;

test('listener metadata identifies a real managed workload without exposing command or lease details', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-port-owner-'));
  const isRoot = process.getuid?.() === 0;
  const uid = isRoot ? 1000 : process.getuid!(), gid = isRoot ? 1000 : process.getgid!();
  const processes = new ProcessManager({ home: '/tmp', outputDirectory: join(root, 'output'), ...(isRoot ? { spawnUid: uid, spawnGid: gid } : {}) });
  const previews = new PreviewManager({ listPorts: () => discoverListeningPorts(uid, gid) }, '127.0.0.1', 'http://preview.localhost', 'http://preview.localhost');
  const executor = new ToolExecutor(undefined, { processes, previews });
  context.after(async () => { await processes.shutdown(); await executor.shutdown(); await rm(root, { recursive: true, force: true }); });
  const lease = executor.leases.acquire(60);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const script = 'const server=require("node:net").createServer();server.listen(0,"127.0.0.1",()=>console.log(server.address().port))';
  const task = await executor.call('exec_command', { lease, command: `${quote(process.execPath)} -e ${quote(script)}`, cwd: '/tmp', yieldTimeMs: 500, lifecycle: 'task', label: 'Port ownership fixture' }) as { output: string; processId: string };
  const port = Number(task.output.trim());
  assert.ok(port > 0);
  const observed = await executor.call('list_ports', {}) as { ports: Array<{ port: number; pid?: number; process?: string; ownership: Record<string, unknown> }> };
  const listener = observed.ports.find((item) => item.port === port)!;
  assert.ok(listener?.pid);
  assert.equal(listener.process, 'node');
  assert.equal(listener.ownership.processId, task.processId);
  assert.equal(listener.ownership.lifecycle, 'task');
  assert.ok(!JSON.stringify(listener).includes(script));
  assert.ok(!JSON.stringify(listener).includes('ancestorPids'));
  assert.equal(attributeListeningPorts([{ port: 1234, address: 'loopback', protocol: 'tcp' }], [], [])[0]!.ownership.status, 'unknown');
});
