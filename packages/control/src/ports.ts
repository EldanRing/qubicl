import { execFile } from 'node:child_process';

export interface ListeningPort {
  port: number;
  address: 'loopback' | 'all' | 'interface';
  protocol: 'tcp';
  pid?: number;
  process?: string;
  processGroupId?: number;
  osSessionId?: number;
  /** Internal attribution aid; stripped from the public tool response. */
  ancestorPids?: number[];
}

/** Run /proc FD inspection with the workload identity (root without ptrace
 * capability cannot read another user's FD links). No commands/env are read. */
export async function discoverListeningPorts(uid: number, gid = uid): Promise<ListeningPort[]> {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('Invalid port-inspection identity.');
  if (process.getuid?.() === 0 && uid !== 0) {
    try {
      return await new Promise<ListeningPort[]>((resolve, reject) => {
        // inspectPorts is self-contained so this works in the bundled runtime,
        // without importing the control entrypoint or changing process-wide UID.
        execFile(process.execPath, ['--input-type=module', '-e', `process.stdout.write(JSON.stringify(await (${inspectPorts.toString()})(${uid})))`],
          { uid, gid, cwd: '/tmp', env: {}, timeout: 5000, maxBuffer: 2_000_000 }, (error, stdout) => {
            if (error) reject(error);
            else { try { resolve(JSON.parse(stdout) as ListeningPort[]); } catch (error) { reject(error); } }
          });
      });
    } catch { /* Preserve listener observations when owner metadata is unavailable. */ }
  }
  return inspectPorts(uid);
}

async function inspectPorts(uid: number): Promise<ListeningPort[]> {
  const { readdir, readFile, readlink } = await import('node:fs/promises');
  const sockets = new Map<string, ListeningPort>();
  let readableTables = 0;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let contents: string;
    try { contents = await readFile(table, 'utf8'); readableTables++; } catch (error) {
      if (table.endsWith('tcp6') && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('TCP listener inspection failed; no empty-list inference was made.');
    }
    for (const line of contents.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || fields[3] !== '0A' || Number(fields[7]) !== uid) continue;
      const [address = '', rawPort = ''] = fields[1]!.split(':');
      const port = Number.parseInt(rawPort, 16), inode = fields[9]!;
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^\d+$/u.test(inode)) continue;
      sockets.set(inode, { port, protocol: 'tcp', address: address === '0100007F' || address === '00000000000000000000000001000000' ? 'loopback' : /^0+$/u.test(address) ? 'all' : 'interface' });
    }
  }
  if (!readableTables) throw new Error('TCP listener inspection is unavailable; no empty-list inference was made.');
  if (!sockets.size) return [];
  const metadata = new Map<number, { process: string; parent: number; processGroupId: number; osSessionId: number }>();
  const entries = await readdir('/proc', { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    if (Number(status.match(/^Uid:\s+(\d+)/mu)?.[1]) !== uid) continue;
    const rawStat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    const endOfName = rawStat.lastIndexOf(') ');
    if (endOfName < 0) continue;
    const stat = rawStat.slice(endOfName + 2).trim().split(/\s+/u);
    metadata.set(pid, { process: (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim().slice(0, 80),
      parent: Number(stat[1]), processGroupId: Number(stat[2]), osSessionId: Number(stat[3]) });
  }
  for (const [pid, info] of metadata) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const match = /^socket:\[(\d+)\]$/u.exec(target);
      const listener = match ? sockets.get(match[1]!) : undefined;
      if (!listener || listener.pid !== undefined) continue;
      const ancestorPids: number[] = [];
      let parent = info.parent;
      while (metadata.has(parent) && ancestorPids.length < 32 && !ancestorPids.includes(parent)) {
        ancestorPids.push(parent); parent = metadata.get(parent)!.parent;
      }
      Object.assign(listener, { pid, process: info.process, processGroupId: info.processGroupId, osSessionId: info.osSessionId, ancestorPids });
    }
  }
  return [...sockets.values()].sort((left, right) => left.port - right.port || (left.pid ?? 0) - (right.pid ?? 0));
}

interface ManagedOwner { id: string; pid?: number; kind?: string; status: string; lifecycle: string; label: string; }
interface ApplicationOwner { applicationId: string; pid?: number; application: string; }
export function attributeListeningPorts(ports: ListeningPort[], processes: ManagedOwner[] | null, applications: ApplicationOwner[] | null): Array<Omit<ListeningPort, 'ancestorPids'> & { ownership: Record<string, unknown> }> {
  return ports.map(({ ancestorPids, ...port }) => {
    for (const pid of [port.pid, ...ancestorPids ?? []]) {
      if (!pid) continue;
      const managed = processes?.find((item) => item.pid === pid && item.status === 'running');
      if (managed) return { ...port, ownership: { status: 'managed', [managed.kind === 'terminal' ? 'terminalId' : 'processId']: managed.id, lifecycle: managed.lifecycle, label: managed.label } };
      const application = applications?.find((item) => item.pid === pid);
      if (application) return { ...port, ownership: { status: 'managed', applicationId: application.applicationId, lifecycle: 'desktop_session', application: application.application } };
    }
    return { ...port, ownership: { status: port.pid && processes !== null && applications !== null ? 'unmanaged' : 'unknown' } };
  });
}
