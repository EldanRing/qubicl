import { operationOutput } from './operation-context.js';
import { SecretsSchema, type ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { stringOption } from './args.js';
import { loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { commitPolicyChange } from './network-policy.js';

export async function secretCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'secret action');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    const secret = state.secrets.computers[computer.id]!;
    const entries = secret.brokerCredentials ??= [];
    if (action === 'list') {
      operationOutput('log', JSON.stringify(entries.map(({ provider, ...entry }) => ({ ...entry, provider: { type: provider.type, ...providerReference(provider) } })), null, 2));
      return;
    }
    if (action === 'explain') {
      const id = required(args.positionals[2], 'credential ID');
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`Credential ${id} was not found on ${computer.name}.`);
      const expired = entry.expiresAt ? Date.parse(entry.expiresAt) <= Date.now() : false;
      operationOutput('log', JSON.stringify({
        computer: computer.name,
        credential: { id: entry.id, destination: `${entry.baseUrl}${entry.pathPrefix}`, methods: entry.methods, header: entry.header, expiresAt: entry.expiresAt ?? null, status: expired ? 'expired' : 'available', provider: { type: entry.provider.type, ...providerReference(entry.provider) } },
        secretValueReturned: false,
        redirectPolicy: 'redirects are not followed by broker requests',
        note: 'This validates stored scope and provider metadata without making a network request or reading the secret value.',
      }, null, 2));
      return;
    }
    if (action === 'remove') {
      const id = required(args.positionals[2], 'credential ID');
      const index = entries.findIndex((entry) => entry.id === id);
      if (index === -1) throw new Error(`Credential ${id} was not found on ${computer.name}.`);
      entries.splice(index, 1);
      await saveAndRefresh(state, computer);
      operationOutput('log', `Removed broker credential ${id} from ${computer.name}.`);
      return;
    }
    if (action !== 'add') throw new Error(`Unknown secret action ${action}.`);
    const id = required(args.positionals[2], 'credential ID');
    if (entries.some((entry) => entry.id === id)) throw new Error(`Credential ${id} already exists on ${computer.name}. Remove it before replacing it.`);
    const template = credentialTemplate(stringOption(args, 'template'));
    const baseUrl = stringOption(args, 'base-url') ?? template?.baseUrl ?? required(undefined, '--base-url or --template');
    const pathPrefix = stringOption(args, 'path-prefix') ?? template?.pathPrefix ?? '/';
    const methods = (stringOption(args, 'methods') ?? template?.methods.join(',') ?? 'GET').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
    const header = stringOption(args, 'header') ?? template?.header ?? 'Authorization';
    const provider = await parseProvider(stringOption(args, 'provider') ?? 'direct', stringOption(args, 'provider-ref'));
    const duration = stringOption(args, 'duration');
    const expiresAt = duration ? expiry(duration) : undefined;
    entries.push({ id, baseUrl, pathPrefix, methods: methods as never, header, provider: provider as never, ...(expiresAt ? { expiresAt } : {}) });
    SecretsSchema.parse(state.secrets);
    await saveAndRefresh(state, computer);
    operationOutput('log', `Added scoped broker credential ${id} to ${computer.name}; the value is not mounted into its workload containers.`);
  });
}

function credentialTemplate(name: string | undefined): { baseUrl: string; pathPrefix: string; methods: string[]; header: string } | undefined {
  if (!name) return undefined;
  const templates: Record<string, { baseUrl: string; pathPrefix: string; methods: string[]; header: string }> = {
    openai: { baseUrl: 'https://api.openai.com', pathPrefix: '/v1/', methods: ['GET', 'POST', 'DELETE'], header: 'Authorization' },
    anthropic: { baseUrl: 'https://api.anthropic.com', pathPrefix: '/v1/', methods: ['POST'], header: 'x-api-key' },
    github: { baseUrl: 'https://api.github.com', pathPrefix: '/', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], header: 'Authorization' },
  };
  const template = templates[name];
  if (!template) throw new Error(`Unknown credential template ${name}; use openai, anthropic, or github.`);
  return template;
}

async function saveAndRefresh(state: LoadedState, computer: ComputerConfig): Promise<void> {
  await commitPolicyChange(state, computer);
}

/** Write-only administrator operation; shares persistence with the CLI. */
export async function manageBrokerCredential(
  state: LoadedState, computer: ComputerConfig, action: 'add' | 'replace' | 'remove', input: Record<string, unknown>,
): Promise<void> {
  const id = typeof input.id === 'string' ? input.id : '';
  if (!id) throw new Error('Credential ID is required.');
  const secret = state.secrets.computers[computer.id]!;
  const entries = secret.brokerCredentials ??= [];
  const index = entries.findIndex((entry) => entry.id === id);
  if (action === 'add' && index !== -1) throw new Error('Credential already exists.');
  if (action !== 'add' && index === -1) throw new Error('Credential was not found.');
  if (index !== -1) entries.splice(index, 1);
  if (action !== 'remove') {
    if (typeof input.value !== 'string' || !input.value) throw new Error('A new credential value is required.');
    entries.push({ id, baseUrl: input.baseUrl, pathPrefix: input.pathPrefix ?? '/', methods: input.methods ?? ['GET'], header: input.header ?? 'Authorization', provider: { type: 'direct', value: input.value } } as never);
  }
  SecretsSchema.parse(state.secrets);
  await saveAndRefresh(state, computer);
}

async function parseProvider(type: string, reference: string | undefined): Promise<Record<string, string>> {
  if (type === 'direct') {
    if (process.stdin.isTTY) throw new Error('Direct credential input is never accepted on the command line. Pipe the value on standard input.');
    const value = (await readStandardInput()).replace(/[\r\n]+$/u, '');
    if (!value) throw new Error('Piped credential value is empty.');
    return { type, value };
  }
  if (!reference) throw new Error(`--provider ${type} requires --provider-ref.`);
  if (type === 'environment') return { type, name: reference };
  if (type === 'file') return { type, path: reference };
  if (type === 'secret-tool' || type === 'macos-keychain') {
    const separator = reference.indexOf(':');
    if (separator < 1 || separator === reference.length - 1) throw new Error(`--provider-ref for ${type} must be SERVICE:ACCOUNT.`);
    return { type, service: reference.slice(0, separator), account: reference.slice(separator + 1) };
  }
  throw new Error('--provider must be direct, environment, file, secret-tool, or macos-keychain.');
}

function providerReference(provider: Record<string, unknown>): Record<string, unknown> {
  if (provider.type === 'environment') return { name: provider.name };
  if (provider.type === 'file') return { path: provider.path };
  if (provider.type === 'secret-tool' || provider.type === 'macos-keychain') return { service: provider.service, account: provider.account };
  return {};
}
async function readStandardInput(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return Buffer.concat(chunks).toString('utf8'); }
function expiry(value: string): string { const seconds = Number(value); if (!Number.isInteger(seconds) || seconds < 60 || seconds > 31_536_000) throw new Error('--duration must be 60 through 31536000 seconds.'); return new Date(Date.now() + seconds * 1000).toISOString(); }
function findComputer(state: LoadedState, value: string): ComputerConfig { const computer = state.config.computers.find(({ id, name }) => id === value || name === value); if (!computer) throw new Error(`Computer ${value} was not found.`); return computer; }
function required(value: string | undefined, description: string): string { if (!value) throw new Error(`Missing ${description}.`); return value; }
