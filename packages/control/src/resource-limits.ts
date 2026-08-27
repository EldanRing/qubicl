import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface EffectiveResourceLimits {
  source: 'cgroup-v2';
  available: boolean;
  cpu: {
    enforced: boolean | null;
    limitCpus: number | null;
    quotaMicroseconds: number | null;
    periodMicroseconds: number | null;
    cpuset: string | null;
  };
  memory: {
    enforced: boolean | null;
    limitBytes: number | null;
    usageBytes: number | null;
  };
  pids: {
    enforced: boolean | null;
    limit: number | null;
    usage: number | null;
  };
}

export async function readEffectiveResourceLimits(root = '/sys/fs/cgroup'): Promise<EffectiveResourceLimits> {
  const [cpuMax, cpuset, memoryMax, memoryCurrent, pidsMax, pidsCurrent] = await Promise.all([
    readCgroupValue(root, 'cpu.max'),
    readCgroupValue(root, 'cpuset.cpus.effective'),
    readCgroupValue(root, 'memory.max'),
    readCgroupValue(root, 'memory.current'),
    readCgroupValue(root, 'pids.max'),
    readCgroupValue(root, 'pids.current'),
  ]);
  const cpu = parseCpuMax(cpuMax);
  return {
    source: 'cgroup-v2',
    available: [cpuMax, cpuset, memoryMax, memoryCurrent, pidsMax, pidsCurrent].some((value) => value !== undefined),
    cpu: {
      ...cpu,
      enforced: limitEnforced(cpuMax),
      cpuset: cpuset || null,
    },
    memory: {
      enforced: limitEnforced(memoryMax),
      limitBytes: parseLimit(memoryMax),
      usageBytes: parseCount(memoryCurrent),
    },
    pids: {
      enforced: limitEnforced(pidsMax),
      limit: parseLimit(pidsMax),
      usage: parseCount(pidsCurrent),
    },
  };
}

function limitEnforced(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  return !value.startsWith('max');
}

async function readCgroupValue(root: string, name: string): Promise<string | undefined> {
  try { return (await readFile(join(root, name), 'utf8')).trim(); }
  catch { return undefined; }
}

function parseCpuMax(value: string | undefined): Omit<EffectiveResourceLimits['cpu'], 'enforced'> {
  const [quotaValue, periodValue] = value?.split(/\s+/, 2) ?? [];
  const periodMicroseconds = parseCount(periodValue);
  const quotaMicroseconds = parseLimit(quotaValue);
  return {
    limitCpus: quotaMicroseconds === null || periodMicroseconds === null || periodMicroseconds === 0
      ? null
      : quotaMicroseconds / periodMicroseconds,
    quotaMicroseconds,
    periodMicroseconds,
    cpuset: null,
  };
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value === 'max') return null;
  return parseCount(value);
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
