import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { LoadedState } from './state.js';

const executeFile = promisify(execFile);

export async function resolvedBrokerDocument(state: LoadedState, computerId: string): Promise<{ credentials: Record<string, unknown>[] }> {
  const configured = state.secrets.computers[computerId]?.brokerCredentials ?? [];
  const credentials: Record<string, unknown>[] = [];
  for (const credential of configured) {
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) continue;
    credentials.push({
      id: credential.id,
      baseUrl: credential.baseUrl,
      pathPrefix: credential.pathPrefix,
      methods: credential.methods,
      header: credential.header,
      value: await resolveProvider(credential.provider),
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    });
  }
  return { credentials };
}

async function resolveProvider(provider: { type: string; value?: string; name?: string; path?: string; service?: string; account?: string }): Promise<string> {
  if (provider.type === 'direct') return provider.value!;
  if (provider.type === 'environment') {
    const value = process.env[provider.name!];
    if (!value) throw new Error(`Credential provider environment variable ${provider.name} is unavailable.`);
    return value;
  }
  if (provider.type === 'file') {
    const value = (await readFile(provider.path!, 'utf8')).replace(/[\r\n]+$/u, '');
    if (!value) throw new Error(`Credential provider file ${provider.path} is empty.`);
    return value;
  }
  if (provider.type === 'secret-tool') {
    const { stdout } = await executeFile('secret-tool', ['lookup', 'service', provider.service!, 'account', provider.account!], { maxBuffer: 64 * 1024 });
    const value = stdout.replace(/[\r\n]+$/u, '');
    if (!value) throw new Error(`No OS keyring credential matched service=${provider.service} account=${provider.account}.`);
    return value;
  }
  if (provider.type === 'macos-keychain') {
    if (process.platform !== 'darwin') throw new Error('The macos-keychain provider is available only on macOS.');
    const { stdout } = await executeFile('security', ['find-generic-password', '-w', '-s', provider.service!, '-a', provider.account!], { maxBuffer: 64 * 1024 });
    const value = stdout.replace(/[\r\n]+$/u, '');
    if (!value) throw new Error(`No macOS Keychain credential matched service=${provider.service} account=${provider.account}.`);
    return value;
  }
  throw new Error(`Unsupported credential provider ${provider.type}.`);
}
