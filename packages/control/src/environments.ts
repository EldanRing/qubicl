import { resolve } from 'node:path';

const DEFAULT_HOME = '/home/qubicl';
const SAFE_PATH = '/home/qubicl/.local/bin:/usr/local/bin:/usr/bin:/bin';

/**
 * Environment passed to model-controlled commands. Control-plane variables,
 * inherited credentials, proxy credentials, loader hooks, and runtime-specific
 * Node options are deliberately absent.
 */
export function workloadEnvironment(source: NodeJS.ProcessEnv, home = DEFAULT_HOME): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USER: 'qubicl',
    LOGNAME: 'qubicl',
    SHELL: '/bin/bash',
    PATH: SAFE_PATH,
    LANG: safeLocale(source.LANG),
    LC_ALL: safeLocale(source.LC_ALL ?? source.LANG),
    XDG_CONFIG_HOME: resolve(home, '.config'),
    XDG_DATA_HOME: resolve(home, '.local/share'),
    XDG_CACHE_HOME: resolve(home, '.cache'),
  };
  copyTerminalValue(environment, source, 'TERM', /^[A-Za-z0-9_.+:-]{1,64}$/u);
  copyTerminalValue(environment, source, 'COLORTERM', /^[A-Za-z0-9_.+:-]{1,64}$/u);
  copyTerminalValue(environment, source, 'DISPLAY', /^:[0-9]+(?:\.[0-9]+)?$/u);
  const proxy = source.QUBICL_PROXY_URL;
  if (typeof proxy === 'string' && /^http:\/\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+@[A-Za-z0-9_.-]+:\d{1,5}$/u.test(proxy)) {
    environment.HTTP_PROXY = proxy;
    environment.HTTPS_PROXY = proxy;
    environment.http_proxy = proxy;
    environment.https_proxy = proxy;
  }
  const configured = source.QUBICL_WORKLOAD_ENV_JSON;
  if (configured) {
    const values = JSON.parse(configured) as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || key.startsWith('QUBICL_') || typeof value !== 'string') continue;
      if (['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LD_PRELOAD', 'NODE_OPTIONS'].includes(key)) continue;
      environment[key] = value;
    }
  }
  return environment;
}

/** Environment for fixed-shape desktop helper subprocesses. */
export function desktopHelperEnvironment(source: NodeJS.ProcessEnv, home = DEFAULT_HOME): NodeJS.ProcessEnv {
  const environment = workloadEnvironment(source, home);
  environment.DISPLAY = typeof source.DISPLAY === 'string' && /^:[0-9]+(?:\.[0-9]+)?$/u.test(source.DISPLAY)
    ? source.DISPLAY
    : ':0';
  return environment;
}

function safeLocale(value: string | undefined): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,64}$/u.test(value) ? value : 'C.UTF-8';
}

function copyTerminalValue(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  name: 'TERM' | 'COLORTERM' | 'DISPLAY',
  pattern: RegExp,
): void {
  const value = source[name];
  if (typeof value === 'string' && pattern.test(value)) target[name] = value;
}
