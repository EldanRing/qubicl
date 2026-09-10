import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { run } from '../docker.js';
import { atomicWrite } from '../state.js';

export interface DashboardServiceDefinition { path: string; contents: string; label: string }
export function dashboardServiceDefinition(root: string, installationId: string, platform = process.platform, home = homedir(), executable = process.execPath, script = process.argv[1], sea = isSea()): DashboardServiceDefinition {
  if (!/^[a-f0-9-]{36}$/u.test(installationId)) throw new Error('Invalid installation identity.');
  if ([root, home, executable, script ?? '', process.env.PATH ?? ''].some((value) => /[\r\n\0]/u.test(value))) throw new Error('Invalid service environment or path.');
  const label = `org.qubicl.dashboard.${installationId.replaceAll('-', '').slice(0, 16)}`;
  const argv = sea ? [executable, 'dashboard', 'serve'] : [executable, resolve(script ?? ''), 'dashboard', 'serve'];
  const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  if (platform === 'darwin') return {
    label, path: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argv.map((value) => `<string>${xml(value)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>QUBICL_HOME</key><string>${xml(root)}</string><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`,
  };
  if (platform !== 'linux') throw new Error('Dashboard background service is supported only on native Linux and macOS.');
  const quote = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
  if (argv.some((value) => /[\r\n\0]/u.test(value)) || /[\r\n\0]/u.test(root)) throw new Error('Invalid service path.');
  return { label, path: join(home, '.config', 'systemd', 'user', `${label}.service`), contents: `[Unit]\nDescription=Qubicl local management\n\n[Service]\nType=simple\nExecStart=${argv.map(quote).join(' ')}\nEnvironment=${quote(`QUBICL_HOME=${root}`)}\nEnvironment=${quote(`PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`)}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` };
}
export async function manageDashboardService(root: string, installationId: string, action: 'enable' | 'disable' | 'start' | 'stop' | 'restart'): Promise<void> {
  const definition = dashboardServiceDefinition(root, installationId);
  if (action === 'disable' && !await managedServiceDefinitionExists(definition.path)) return;
  if (action === 'enable') {
    await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
    await assertSafeServiceLocation(definition.path);
    await atomicWrite(definition.path, definition.contents, 0o600);
  }
  if (process.platform === 'linux') {
    if (action === 'enable' || action === 'disable') await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', action === 'enable' ? 'enable' : action === 'disable' ? 'disable' : action, ...(['enable', 'disable'].includes(action) ? ['--now'] : []), `${definition.label}.service`]);
  } else {
    const domain = `gui/${process.getuid!()}`;
    if (action === 'enable' || action === 'start') await run('launchctl', ['bootstrap', domain, definition.path]);
    else if (action === 'restart') await run('launchctl', ['kickstart', '-k', `${domain}/${definition.label}`]);
    else await run('launchctl', ['bootout', `${domain}/${definition.label}`]);
  }
  if (action === 'disable') {
    await assertSafeServiceLocation(definition.path);
    await rm(definition.path);
    if (process.platform === 'linux') await run('systemctl', ['--user', 'daemon-reload']);
  }
}

async function managedServiceDefinitionExists(path: string): Promise<boolean> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!existing) return false;
  const uid = process.getuid?.();
  if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || (existing.mode & 0o077) !== 0) throw new Error('Unsafe existing service definition.');
  return true;
}

async function assertSafeServiceLocation(path: string): Promise<void> {
  const uid = process.getuid?.();
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o022) !== 0) throw new Error('Unsafe service directory.');
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || (existing.mode & 0o077) !== 0)) throw new Error('Unsafe existing service definition.');
}
