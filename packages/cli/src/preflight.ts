import { constants as fsConstants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import {
  IMAGE_CATALOG,
  SUPPORTED_NODE_RANGE,
  supportedNodeVersion,
  type ImageCatalog,
  type ImageIdentity,
} from '@qubicl/core';
import { assertGatewayPort, filesystemObservation, imageExists, inspectDockerHost, portAvailable, type DockerHostInfo } from './docker.js';
import { inspectStateFormat } from './migrations.js';
import { auditState, statePaths, type LoadedState, type StatePaths } from './state.js';
import { assertWslLinuxFilesystem, inspectHostPlatform, type HostPlatformInfo } from './host-platform.js';

export interface PreflightCheck {
  status: 'pass' | 'warn' | 'fail';
  id: string;
  detail: string;
  guidance?: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
  docker?: DockerHostInfo;
  hostDisk?: { path: string; availableBytes: number; totalBytes: number };
}

export interface PreflightServices {
  inspectDockerHost: typeof inspectDockerHost;
  inspectStateFormat: typeof inspectStateFormat;
  auditState: typeof auditState;
  filesystemObservation: typeof filesystemObservation;
  assertGatewayPort: typeof assertGatewayPort;
  portAvailable: typeof portAvailable;
  validateStatePath: typeof validateStatePath;
  inspectHostPlatform: () => Promise<HostPlatformInfo>;
}

const defaultPreflightServices: PreflightServices = {
  inspectDockerHost,
  inspectStateFormat,
  auditState,
  filesystemObservation,
  assertGatewayPort,
  portAvailable,
  validateStatePath,
  inspectHostPlatform,
};

export async function runImagePreflight(
  gateway: ImageIdentity,
  computer: ImageIdentity,
  offline: boolean,
  exists: (reference: string) => Promise<boolean> = imageExists,
): Promise<PreflightCheck[]> {
  return Promise.all([
    imageAvailabilityCheck('gateway-image', gateway, offline, exists),
    imageAvailabilityCheck('computer-image', computer, offline, exists),
  ]);
}

export async function runSetupPreflight(
  paths: StatePaths = statePaths(),
  state?: LoadedState,
  catalog: ImageCatalog = IMAGE_CATALOG,
  requestedGatewayPort?: number,
  services: PreflightServices = defaultPreflightServices,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const host = await services.inspectHostPlatform();
  checks.push({
    status: ['linux', 'darwin'].includes(host.platform) && ['x64', 'arm64'].includes(host.arch) ? 'pass' : 'fail',
    id: 'host-platform',
    detail: `${host.platform}/${host.arch}`,
    guidance: 'Use a supported Linux or macOS x64/arm64 host.',
  });
  if (host.wsl) {
    checks.push({
      status: host.wsl.version === 2 ? 'pass' : 'fail',
      id: 'wsl-version',
      detail: `WSL ${host.wsl.version}${host.wsl.distro ? ` (${host.wsl.distro})` : ''}; kernel ${host.wsl.kernelRelease || 'unknown'}`,
      guidance: 'Upgrade the distribution to WSL 2. Qubicl does not support WSL 1.',
    });
    checks.push({
      status: host.wsl.interop ? 'pass' : 'warn',
      id: 'wsl-interop',
      detail: host.wsl.interop ? 'Windows executable interoperability is available' : 'Windows executable interoperability is disabled',
      guidance: 'Enable WSL interoperability for Windows-hosted clients, browser opening, and Windows credential helpers.',
    });
  }
  checks.push({
    status: supportedNodeVersion() ? 'pass' : 'fail',
    id: 'node',
    detail: `${process.versions.node} (supported ${SUPPORTED_NODE_RANGE})`,
    guidance: `Install a supported Node runtime (${SUPPORTED_NODE_RANGE}).`,
  });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  checks.push({
    status: uid === 0 ? 'fail' : 'pass',
    id: 'normal-user',
    detail: uid === 0 ? 'Qubicl is running as root' : `host UID ${uid}`,
    guidance: 'Run Qubicl as your normal host user, not root.',
  });
  try {
    const pathCheck = await services.validateStatePath(paths.root);
    checks.push({ status: 'pass', id: 'state-path', detail: pathCheck });
  } catch (error) {
    checks.push({ status: 'fail', id: 'state-path', detail: errorMessage(error), guidance: 'Choose an absolute, user-owned QUBICL_HOME with no symlinked path components. Under WSL, use a Linux filesystem such as /home, not /mnt/<drive>.' });
  }
  const stateFormat = await services.inspectStateFormat(paths);
  checks.push({
    status: ['uninitialized', 'current'].includes(stateFormat.status) ? 'pass' : stateFormat.status === 'legacy' || stateFormat.status === 'migration-pending' ? 'warn' : 'fail',
    id: 'state-format',
    detail: stateFormat.detail,
    ...(stateFormat.status === 'invalid' ? { guidance: 'Preserve the state directory and restore a verified backup before setup.' } : {}),
  });
  if (state) {
    const audit = await services.auditState(state);
    const failures = audit.filter(({ ok }) => !ok);
    checks.push({
      status: failures.length ? 'fail' : 'pass',
      id: 'state-invariants',
      detail: failures.length
        ? failures.map(({ check, detail }) => `${check}: ${detail}`).join('; ')
        : `${audit.length} permission and consistency checks passed`,
      ...(failures.length ? { guidance: 'Preserve the state root, correct the reported invariant failures, and rerun setup.' } : {}),
    });
  }

  let dockerHost: DockerHostInfo | undefined;
  try {
    dockerHost = await services.inspectDockerHost();
    checks.push({ status: 'pass', id: 'docker-context', detail: `${dockerHost.context}: ${dockerHost.endpoint}` });
    checks.push({ status: 'pass', id: 'docker-engine', detail: `${dockerHost.engineVersion}; ${dockerHost.operatingSystem}` });
    checks.push({ status: 'pass', id: 'docker-compose', detail: dockerHost.composeVersion });
    checks.push({ status: 'pass', id: 'docker-resources', detail: `${dockerHost.cpus} CPU; ${dockerHost.memoryBytes} bytes memory` });
    checks.push({
      status: catalog.supportedPlatforms.includes(dockerHost.platform) ? 'pass' : 'fail',
      id: 'image-platform',
      detail: dockerHost.platform,
      guidance: 'Use a Docker server platform represented in this Qubicl catalog.',
    });
  } catch (error) {
    checks.push({
      status: 'fail',
      id: 'docker',
      detail: errorMessage(error),
      guidance: host.wsl
        ? 'Start Docker Desktop, enable WSL integration for this distribution, and verify docker version and docker compose version as the normal WSL user. Qubicl will not install or start Docker.'
        : 'Install or start a supported local Docker Engine/Desktop and Compose, then rerun setup. Qubicl will not install or start Docker.',
    });
  }

  const port = requestedGatewayPort ?? state?.config.gateway.port ?? 3211;
  if (dockerHost) {
    try {
      if (state && state.config.gateway.port === port) await services.assertGatewayPort(state);
      else if (!(await services.portAvailable(port))) throw new Error(`Gateway port 127.0.0.1:${port} is already in use.`);
      checks.push({ status: 'pass', id: 'gateway-port', detail: `127.0.0.1:${port} is available or belongs to the managed gateway` });
    } catch (error) {
      checks.push({ status: 'fail', id: 'gateway-port', detail: errorMessage(error), guidance: 'Choose another port with --gateway-port.' });
    }
  }

  let hostDisk: PreflightResult['hostDisk'];
  try {
    hostDisk = await services.filesystemObservation(paths.root);
    checks.push({ status: 'pass', id: 'host-disk', detail: `${hostDisk.availableBytes} bytes available on the filesystem containing ${hostDisk.path}` });
    checks.push({ status: 'warn', id: 'docker-store-capacity', detail: 'remaining Docker image-store/VM capacity is unknown; Docker does not expose it portably' });
  } catch (error) {
    checks.push({ status: 'warn', id: 'host-disk', detail: errorMessage(error) });
  }
  return {
    ok: !checks.some(({ status }) => status === 'fail'),
    checks,
    ...(dockerHost ? { docker: dockerHost } : {}),
    ...(hostDisk ? { hostDisk } : {}),
  };
}

export async function validateStatePath(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error(`QUBICL_HOME must be absolute; found ${JSON.stringify(root)}.`);
  const absolute = resolve(root);
  const parsed = parse(absolute);
  const pieces = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  let nearest = parsed.root;
  for (const piece of pieces) {
    current = resolve(current, piece);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${current} is not a real directory.`);
      nearest = current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  const info = await lstat(nearest);
  const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (info.uid !== uid) throw new Error(`Nearest existing state parent ${nearest} is owned by UID ${info.uid}, not current UID ${uid}.`);
  await access(nearest, fsConstants.W_OK | fsConstants.X_OK);
  const host = await inspectHostPlatform();
  if (host.wsl) {
    const mount = await assertWslLinuxFilesystem(absolute);
    return `${absolute}; nearest existing parent ${nearest} is user-owned and writable; WSL Linux filesystem ${mount.filesystem} at ${mount.mountPoint}`;
  }
  return `${absolute}; nearest existing parent ${nearest} is user-owned and writable`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function imageAvailabilityCheck(
  id: string,
  identity: ImageIdentity,
  offline: boolean,
  exists: (reference: string) => Promise<boolean>,
): Promise<PreflightCheck> {
  const local = await exists(identity.resolved);
  if (local) return { status: 'pass', id, detail: `${identity.resolved} is available locally` };
  if (offline) {
    return {
      status: 'fail',
      id,
      detail: `${identity.resolved} is not available locally and --offline forbids obtaining it`,
      guidance: 'Provide the exact image locally or rerun without --offline.',
    };
  }
  return {
    status: 'warn',
    id,
    detail: `${identity.resolved} is not local and will be obtained only after confirmation`,
  };
}
