import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename } from 'node:path';

export interface ListeningPort {
  port: number;
  address: 'loopback' | 'all' | 'interface';
  protocol: 'tcp';
  pid?: number;
  process?: string;
}

/** Return TCP listeners owned by the untrusted computer user only. */
export async function discoverListeningPorts(uid: number): Promise<ListeningPort[]> {
  const sockets = new Map<string, Omit<ListeningPort, 'pid' | 'process'>>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const lines = (await readFile(table, 'utf8').catch(() => '')).trim().split('\n').slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || fields[3] !== '0A' || Number(fields[7]) !== uid) continue;
      const [rawAddress = '', rawPort = ''] = fields[1]!.split(':');
      const port = Number.parseInt(rawPort, 16);
      const inode = fields[9]!;
      if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^\d+$/u.test(inode)) continue;
      sockets.set(inode, {
        port,
        address: loopbackAddress(rawAddress) ? 'loopback' : allAddress(rawAddress) ? 'all' : 'interface',
        protocol: 'tcp',
      });
    }
  }

  const owners = await socketOwners(uid, new Set(sockets.keys()));
  return [...sockets.entries()]
    .map(([inode, listener]) => ({ ...listener, ...owners.get(inode) }))
    .sort((left, right) => left.port - right.port || (left.pid ?? 0) - (right.pid ?? 0));
}

async function socketOwners(uid: number, wanted: Set<string>): Promise<Map<string, { pid: number; process: string }>> {
  const result = new Map<string, { pid: number; process: string }>();
  const entries = await readdir('/proc', { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    const foundUid = status.match(/^Uid:\s+(\d+)/mu);
    if (!foundUid || Number(foundUid[1]) !== uid) continue;
    const process = (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim().slice(0, 80) || basename(entry.name);
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const match = target.match(/^socket:\[(\d+)\]$/u);
      if (match && wanted.has(match[1]!)) result.set(match[1]!, { pid, process });
    }
  }
  return result;
}

function loopbackAddress(value: string): boolean {
  return value === '0100007F' || value === '00000000000000000000000001000000';
}

function allAddress(value: string): boolean {
  return /^0+$/u.test(value);
}
