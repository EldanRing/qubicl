export interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
}

const booleanOptions = new Set([
  'empty',
  'dry-run',
  'prune',
  'yes',
  'no-open',
  'help',
  'json',
  'no-create',
  'no-start',
  'offline',
  'allow-unsupported-resources',
  'verbose',
  'no-clear',
  'encrypt',
  'quiesce',
  'stopped',
  'read-only',
  'orphans',
  'images',
  'all',
]);
const optionalValueOptions = new Set(['enable']);
const stringOptions = new Set([
  'image',
  'cpus',
  'memory',
  'client',
  'client-host',
  'output',
  'transport',
  'profile',
  'result-mode',
  'gateway-port',
  'default-image',
  'default-preset',
  'default-cpus',
  'default-memory',
  'preset',
  'create',
  'passphrase-file',
  'keep',
  'directory',
  'repo',
  'branch',
  'remote',
  'allow-domains',
  'deny-domains',
  'duration',
  'base-url',
  'path-prefix',
  'methods',
  'header',
  'provider',
  'provider-ref',
  'port',
  'name',
  'compatibility',
  'tag',
  'skills',
  'tools',
  'disable',
  'ref',
  'path',
]);

export function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!optionsEnded && value === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value === '-h') {
      setOption(options, 'help', true);
      continue;
    }
    if (optionsEnded || !value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    if (equals !== -1) {
      const key = value.slice(2, equals);
      if (booleanOptions.has(key)) throw new Error(`Option --${key} does not take a value.`);
      if (!optionalValueOptions.has(key)) assertKnownStringOption(key);
      const optionValue = value.slice(equals + 1);
      if (!optionValue) throw new Error(`Option --${key} requires a value.`);
      setOption(options, key, optionValue);
      continue;
    }
    const key = value.slice(2);
    if (optionalValueOptions.has(key)) {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) setOption(options, key, true);
      else { setOption(options, key, next); index += 1; }
      continue;
    }
    if (booleanOptions.has(key)) {
      setOption(options, key, true);
      continue;
    }
    assertKnownStringOption(key);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Option --${key} requires a value.`);
    setOption(options, key, next);
    index += 1;
  }
  return { positionals, options };
}

function assertKnownStringOption(key: string): void {
  if (!stringOptions.has(key)) throw new Error(`Unknown option --${key}.`);
}

function setOption(options: Map<string, string | boolean>, key: string, value: string | boolean): void {
  if (options.has(key)) throw new Error(`Option --${key} was provided more than once.`);
  options.set(key, value);
}

export function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Option --${name} requires a value.`);
  return value;
}

export function numberOption(args: ParsedArgs, name: string): number | undefined {
  const value = stringOption(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Option --${name} must be a number.`);
  return parsed;
}

export function flag(args: ParsedArgs, name: string): boolean {
  return args.options.get(name) === true;
}
