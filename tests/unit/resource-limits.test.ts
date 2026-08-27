import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readEffectiveResourceLimits } from '@qubicl/control/resource-limits';
import { ToolExecutor } from '@qubicl/control/executor';

test('effective cgroup-v2 limits distinguish enforceable allocations from host-derived values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-cgroup-'));
  try {
    await Promise.all([
      writeFile(join(root, 'cpu.max'), '200000 100000\n'),
      writeFile(join(root, 'cpuset.cpus.effective'), '0-15\n'),
      writeFile(join(root, 'memory.max'), '4294967296\n'),
      writeFile(join(root, 'memory.current'), '290758656\n'),
      writeFile(join(root, 'pids.max'), '1024\n'),
      writeFile(join(root, 'pids.current'), '104\n'),
    ]);
    assert.deepEqual(await readEffectiveResourceLimits(root), {
      source: 'cgroup-v2',
      available: true,
      cpu: { enforced: true, limitCpus: 2, quotaMicroseconds: 200000, periodMicroseconds: 100000, cpuset: '0-15' },
      memory: { enforced: true, limitBytes: 4294967296, usageBytes: 290758656 },
      pids: { enforced: true, limit: 1024, usage: 104 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unlimited and unavailable cgroup values remain explicitly distinguished', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-cgroup-unlimited-'));
  try {
    await writeFile(join(root, 'cpu.max'), 'max 100000\n');
    await writeFile(join(root, 'memory.max'), 'max\n');
    await writeFile(join(root, 'pids.max'), 'max\n');
    const limits = await readEffectiveResourceLimits(root);
    assert.equal(limits.available, true);
    assert.deepEqual(limits.cpu, { enforced: false, limitCpus: null, quotaMicroseconds: null, periodMicroseconds: 100000, cpuset: null });
    assert.deepEqual(limits.memory, { enforced: false, limitBytes: null, usageBytes: null });
    assert.deepEqual(limits.pids, { enforced: false, limit: null, usage: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const missingRoot = await mkdtemp(join(tmpdir(), 'qubicl-cgroup-missing-'));
  try {
    const missing = await readEffectiveResourceLimits(missingRoot);
    assert.equal(missing.available, false);
    assert.equal(missing.cpu.enforced, null);
    assert.equal(missing.memory.enforced, null);
    assert.equal(missing.pids.enforced, null);
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
  }
});

test('computer status is compact by default and keeps diagnostic detail opt-in', async () => {
  const executor = new ToolExecutor();
  const compact = await executor.call('get_computer_status', {}) as Record<string, unknown> & {
    effectiveResourceLimits: { source: string };
    environment: { durableHome: string; hostMetricsMayDiffer: boolean };
  };
  assert.equal(compact.effectiveResourceLimits.source, 'cgroup-v2');
  assert.deepEqual(compact.environment, { durableHome: '/home/qubicl', hostMetricsMayDiffer: true });
  assert.equal('tools' in compact, false);
  assert.equal('lease' in compact, false);

  const status = await executor.call('get_computer_status', { detail: 'full' }) as {
    effectiveResourceLimits: { source: string };
    resourceVisibility: { authoritativeForScheduling: string; standardSystemInterfacesMayReportHostDerivedValues: boolean };
    leasePolicy: { activityRefresh: boolean };
    tools: string[];
  };
  assert.equal(status.effectiveResourceLimits.source, 'cgroup-v2');
  assert.equal(status.resourceVisibility.authoritativeForScheduling, 'effectiveResourceLimits');
  assert.equal(status.resourceVisibility.standardSystemInterfacesMayReportHostDerivedValues, true);
  assert.equal(status.leasePolicy.activityRefresh, true);
  assert.ok(status.tools.length > 0);
});
