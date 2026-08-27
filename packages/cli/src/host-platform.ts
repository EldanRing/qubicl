import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, posix, resolve } from 'node:path';

export interface WslEnvironment {
  version: 1 | 2;
  kernelRelease: string;
  distro: string | undefined;
  interop: boolean;
}

export interface HostPlatformInfo {
  platform: NodeJS.Platform;
  arch: string;
  wsl: WslEnvironment | null;
}

export interface LinuxMountInfo {
  mountPoint: string;
  filesystem: string;
  source: string;
  superOptions: string[];
}

export interface StdioLauncher {
  command: string;
  argsPrefix: string[];
}

interface HostPlatformProbe {
  platform: NodeJS.Platform;
  arch: string;
  environment: NodeJS.ProcessEnv;
  kernelRelease(): Promise<string>;
  interopAvailable(): Promise<boolean>;
}

const defaultHostPlatformProbe: HostPlatformProbe = {
  platform: process.platform,
  arch: process.arch,
  environment: process.env,
  kernelRelease: async () => readFile('/proc/sys/kernel/osrelease', 'utf8'),
  interopAvailable: async () => {
    if (process.env.WSL_INTEROP) return true;
    try {
      await access('/proc/sys/fs/binfmt_misc/WSLInterop', fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export async function inspectHostPlatform(probe: HostPlatformProbe = defaultHostPlatformProbe): Promise<HostPlatformInfo> {
  if (probe.platform !== 'linux') return { platform: probe.platform, arch: probe.arch, wsl: null };
  const kernelRelease = (await probe.kernelRelease().catch(() => '')).trim();
  const distro = probe.environment.WSL_DISTRO_NAME?.trim() || undefined;
  if (!distro && !/microsoft/i.test(kernelRelease)) return { platform: probe.platform, arch: probe.arch, wsl: null };
  return {
    platform: probe.platform,
    arch: probe.arch,
    wsl: {
      version: /wsl2/i.test(kernelRelease) ? 2 : 1,
      kernelRelease,
      distro,
      interop: await probe.interopAvailable(),
    },
  };
}

export function parseLinuxMountInfo(value: string): LinuxMountInfo[] {
  return value.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    const separator = line.indexOf(' - ');
    if (separator === -1) return [];
    const left = line.slice(0, separator).split(' ');
    const right = line.slice(separator + 3).split(' ');
    if (!left[4] || !right[0] || !right[1]) return [];
    return [{
      mountPoint: decodeMountInfoField(left[4]),
      filesystem: right[0],
      source: decodeMountInfoField(right[1]),
      superOptions: (right[2] ?? '').split(',').filter(Boolean),
    }];
  });
}

export function filesystemForLinuxPath(path: string, mountInfo: string): LinuxMountInfo | undefined {
  const target = posix.resolve(path);
  return parseLinuxMountInfo(mountInfo)
    .filter(({ mountPoint }) => target === mountPoint || target.startsWith(`${mountPoint === '/' ? '' : mountPoint}/`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
}

export function isWindowsBackedWslFilesystem(mount: LinuxMountInfo): boolean {
  return mount.filesystem === 'drvfs'
    || (mount.filesystem === '9p' && mount.superOptions.some((option) => option === 'aname=drvfs' || option.startsWith('aname=drvfs;')));
}

export async function assertWslLinuxFilesystem(path: string): Promise<LinuxMountInfo> {
  const mount = filesystemForLinuxPath(path, await readFile('/proc/self/mountinfo', 'utf8'));
  if (!mount) throw new Error(`Could not identify the WSL filesystem containing ${path}.`);
  if (isWindowsBackedWslFilesystem(mount)) {
    throw new Error(`${path} is on the Windows-backed ${mount.mountPoint} mount (${mount.filesystem}); Qubicl state requires a WSL Linux filesystem such as /home.`);
  }
  return mount;
}

export function windowsWslStdioLauncher(
  host: HostPlatformInfo,
  runtime: { executable: string; entrypoint: string | undefined } = defaultRuntime(),
): StdioLauncher {
  if (!host.wsl || host.wsl.version !== 2) throw new Error('--client-host windows requires Qubicl to run inside WSL 2.');
  if (!host.wsl.distro) throw new Error('WSL_DISTRO_NAME is unavailable; Qubicl cannot pin a Windows client launcher to this distribution.');
  if (!host.wsl.interop) throw new Error('WSL interoperability is disabled; enable it before connecting a Windows-hosted client.');
  if (!isAbsolute(runtime.executable)) throw new Error('The Qubicl runtime executable must be an absolute WSL path.');
  if (runtime.entrypoint && !isAbsolute(runtime.entrypoint)) throw new Error('The Qubicl entrypoint must be an absolute WSL path.');
  return {
    command: 'wsl.exe',
    argsPrefix: [
      '-d', host.wsl.distro, '--', resolve(runtime.executable),
      ...(runtime.entrypoint ? [resolve(runtime.entrypoint)] : []),
    ],
  };
}

export function browserOpenInvocation(url: string, host: HostPlatformInfo): { command: string; args: string[] } {
  if (host.wsl) {
    if (!host.wsl.interop) throw new Error('WSL interoperability is disabled. Re-run with --no-open and paste the printed URL into a Windows browser.');
    return { command: 'explorer.exe', args: [url] };
  }
  if (host.platform === 'darwin') return { command: 'open', args: [url] };
  if (host.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function defaultRuntime(): { executable: string; entrypoint: string | undefined } {
  const entrypoint = process.argv[1];
  return {
    executable: process.execPath,
    entrypoint: entrypoint && isAbsolute(entrypoint) && resolve(entrypoint) !== resolve(process.execPath) ? entrypoint : undefined,
  };
}

function decodeMountInfoField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => ({
    '040': ' ',
    '011': '\t',
    '012': '\n',
    '134': '\\',
  })[code] ?? _match);
}
