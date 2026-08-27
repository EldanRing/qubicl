declare const __QUBICL_BUILD_VERSION__: string | undefined;
declare const __QUBICL_BUILD_REVISION__: string | undefined;
declare const __QUBICL_BUILD_DATE__: string | undefined;

export const SUPPORTED_NODE_RANGE = '^22.14.0 || ^24.0.0';
export const MIN_DOCKER_ENGINE_VERSION = '24.0.0';
export const MIN_DOCKER_COMPOSE_VERSION = '2.24.0';

export const QUBICL_BUILD = Object.freeze({
  version: typeof __QUBICL_BUILD_VERSION__ === 'undefined' ? 'development' : __QUBICL_BUILD_VERSION__,
  revision: typeof __QUBICL_BUILD_REVISION__ === 'undefined' ? 'development' : __QUBICL_BUILD_REVISION__,
  date: typeof __QUBICL_BUILD_DATE__ === 'undefined' ? 'unknown' : __QUBICL_BUILD_DATE__,
});

export function supportedNodeVersion(version = process.versions.node): boolean {
  const [major, minor] = numericVersion(version);
  return major === 22 && minor >= 14 || major === 24;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  const actual = numericVersion(version);
  const required = numericVersion(minimum);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

export function numericVersion(version: string): [number, number, number] {
  const match = version.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) throw new Error(`Could not parse version ${JSON.stringify(version)}.`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function versionSummary(): string {
  return `qubicl ${QUBICL_BUILD.version} (${QUBICL_BUILD.revision})`;
}
