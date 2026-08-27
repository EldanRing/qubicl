import { ConfigSchema, NetworkPolicySchema, NetworkProfileSchema, type ComputerConfig } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { stringOption } from './args.js';
import { containerStatus, ensureRuntimeImages, removeComputerRuntime, startComputerAfterGateway, startGateway, validateDocker, verifyGatewayCompatibility } from './docker.js';
import { loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { createStateTransaction, executeStateTransaction } from './transactions.js';
import { usesUnifiedComputerRuntime } from './runtime.js';

export async function networkCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'network action');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    if (action === 'show') {
      console.log(JSON.stringify(computer.network ?? developerPolicy(), null, 2));
      return;
    }
    if (action === 'set') {
      const profile = NetworkProfileSchema.parse(required(args.positionals[2], 'network profile'));
      computer.network = NetworkPolicySchema.parse({
        profile,
        allowDomains: commaList(stringOption(args, 'allow-domains')),
        denyDomains: commaList(stringOption(args, 'deny-domains')),
        temporaryApprovals: [],
      });
      if (profile === 'custom' && !computer.network.allowDomains.length) throw new Error('The custom network profile requires --allow-domains.');
      await commitPolicyChange(state, computer);
      console.log(`Network profile for ${computer.name}: ${profile}. Runtime root changes were recreated; /home remained durable.`);
      return;
    }
    if (action === 'approve') {
      const domain = required(args.positionals[2], 'approved domain').toLowerCase();
      const seconds = Number(stringOption(args, 'duration') ?? '3600');
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) throw new Error('--duration must be 60 through 86400 seconds.');
      const policy = NetworkPolicySchema.parse(computer.network ?? developerPolicy());
      policy.temporaryApprovals = policy.temporaryApprovals.filter((entry) => entry.domain !== domain && Date.parse(entry.expiresAt) > Date.now());
      policy.temporaryApprovals.push({ domain, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() });
      computer.network = NetworkPolicySchema.parse(policy);
      await commitPolicyChange(state, computer);
      console.log(`Temporarily approved ${domain} for ${seconds} seconds on ${computer.name}.`);
      return;
    }
    if (action === 'revoke') {
      const domain = required(args.positionals[2], 'approved domain').toLowerCase();
      const policy = NetworkPolicySchema.parse(computer.network ?? developerPolicy());
      const before = policy.temporaryApprovals.length;
      policy.temporaryApprovals = policy.temporaryApprovals.filter((entry) => entry.domain !== domain);
      computer.network = policy;
      await commitPolicyChange(state, computer);
      console.log(before === policy.temporaryApprovals.length ? `No temporary approval existed for ${domain}.` : `Revoked temporary approval for ${domain}.`);
      return;
    }
    throw new Error(`Unknown network action ${action}.`);
  });
}

async function commitPolicyChange(state: LoadedState, computer: ComputerConfig): Promise<void> {
  ConfigSchema.parse(state.config);
  await validateDocker();
  const priorRuntime = await containerStatus(state, computer.id);
  await ensureRuntimeImages(state, [computer], true);
  await executeStateTransaction(state.paths, createStateTransaction('config', state), { includeRuntime: false });
  // Split runtimes keep a fixed internal control network. Unified runtimes use
  // their single per-computer network as the egress boundary, so changing its
  // internal flag requires replacing that network with the container.
  if (priorRuntime.status !== 'absent') await removeComputerRuntime(state, computer.id, {
    preserveControlNetwork: !usesUnifiedComputerRuntime(computer),
  });
  if (priorRuntime.status === 'running' || priorRuntime.status === 'restarting') {
    await startGateway(state);
    await verifyGatewayCompatibility(state);
    await startComputerAfterGateway(state, computer);
  }
}

function developerPolicy(): { profile: 'developer'; allowDomains: never[]; denyDomains: never[]; temporaryApprovals: never[] } {
  return { profile: 'developer', allowDomains: [], denyDomains: [], temporaryApprovals: [] };
}
function commaList(value: string | undefined): string[] { return value ? [...new Set(value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))] : []; }
function findComputer(state: LoadedState, value: string): ComputerConfig { const computer = state.config.computers.find(({ id, name }) => id === value || name === value); if (!computer) throw new Error(`Computer ${value} was not found.`); return computer; }
function required(value: string | undefined, description: string): string { if (!value) throw new Error(`Missing ${description}.`); return value; }
