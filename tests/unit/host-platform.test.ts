import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserOpenInvocation,
  filesystemForLinuxPath,
  inspectHostPlatform,
  isWindowsBackedWslFilesystem,
  parseLinuxMountInfo,
  windowsWslStdioLauncher,
} from '../../packages/cli/dist/host-platform.js';

const mountInfo = [
  '320 304 8:80 / / rw,relatime - ext4 /dev/sdf rw,discard,errors=remount-ro',
  '369 320 0:113 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\134;uid=1000;gid=1000,cache=0x5',
  '370 320 0:114 / /home/user/My\\040Data rw,relatime - ext4 /dev/sdf rw',
].join('\n');

test('host inspection distinguishes native Linux, WSL 1, and WSL 2', async () => {
  const native = await inspectHostPlatform({
    platform: 'linux', arch: 'x64', environment: {},
    kernelRelease: async () => '6.8.0-generic', interopAvailable: async () => false,
  });
  assert.equal(native.wsl, null);

  const wsl1 = await inspectHostPlatform({
    platform: 'linux', arch: 'x64', environment: { WSL_DISTRO_NAME: 'Legacy' },
    kernelRelease: async () => '4.4.0-19041-Microsoft', interopAvailable: async () => true,
  });
  assert.equal(wsl1.wsl?.version, 1);

  const wsl2 = await inspectHostPlatform({
    platform: 'linux', arch: 'x64', environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    kernelRelease: async () => '6.6.87.2-microsoft-standard-WSL2', interopAvailable: async () => true,
  });
  assert.deepEqual(wsl2.wsl, {
    version: 2,
    kernelRelease: '6.6.87.2-microsoft-standard-WSL2',
    distro: 'Ubuntu',
    interop: true,
  });
});

test('mount inspection selects the nearest mount and identifies Windows-backed WSL filesystems', () => {
  const mounts = parseLinuxMountInfo(mountInfo);
  assert.equal(mounts[2]?.mountPoint, '/home/user/My Data');
  assert.equal(mounts[1]?.source, 'C:\\');
  const home = filesystemForLinuxPath('/home/user/project', mountInfo);
  const windows = filesystemForLinuxPath('/mnt/c/Users/user/.qubicl', mountInfo);
  assert.equal(home?.filesystem, 'ext4');
  assert.equal(windows?.mountPoint, '/mnt/c');
  assert.equal(windows ? isWindowsBackedWslFilesystem(windows) : false, true);
  assert.equal(home ? isWindowsBackedWslFilesystem(home) : true, false);
});

test('Windows client launcher pins the distribution and absolute Qubicl runtime', () => {
  const host = {
    platform: 'linux' as const,
    arch: 'x64',
    wsl: {
      version: 2 as const,
      kernelRelease: '6.6.87.2-microsoft-standard-WSL2',
      distro: 'Ubuntu',
      interop: true,
    },
  };
  assert.deepEqual(windowsWslStdioLauncher(host, {
    executable: '/usr/bin/node',
    entrypoint: '/home/user/.local/lib/node_modules/qubicl-cli/dist/qubicl.mjs',
  }), {
    command: 'wsl.exe',
    argsPrefix: [
      '-d', 'Ubuntu', '--', '/usr/bin/node',
      '/home/user/.local/lib/node_modules/qubicl-cli/dist/qubicl.mjs',
    ],
  });
  assert.deepEqual(browserOpenInvocation('http://127.0.0.1:3211/view', host), {
    command: 'explorer.exe',
    args: ['http://127.0.0.1:3211/view'],
  });
});

test('Windows client launcher fails closed without WSL 2 and interoperability', () => {
  const runtime = { executable: '/usr/bin/node', entrypoint: '/opt/qubicl/qubicl.mjs' };
  assert.throws(() => windowsWslStdioLauncher({ platform: 'linux', arch: 'x64', wsl: null }, runtime), /requires Qubicl to run inside WSL 2/);
  assert.throws(() => windowsWslStdioLauncher({
    platform: 'linux', arch: 'x64',
    wsl: { version: 2, kernelRelease: 'microsoft-standard-WSL2', distro: 'Ubuntu', interop: false },
  }, runtime), /interoperability is disabled/);
});
