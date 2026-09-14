import { operationOutput } from './operation-context.js';
import { BlockList, isIP } from 'node:net';
import { ConfigSchema, NetworkPolicySchema, NetworkProfileSchema, type ComputerConfig, type NetworkPolicy } from '@qubicl/core';
import type { ParsedArgs } from './args.js';
import { stringOption } from './args.js';
import { ensureRuntimeImages, validateDocker } from './docker.js';
import { loadState, statePaths, withStateLock, type LoadedState } from './state.js';
import { createStateTransaction, executeStateTransaction } from './transactions.js';

export async function networkCommand(args: ParsedArgs): Promise<void> {
  const action = required(args.positionals[0], 'network action');
  const name = required(args.positionals[1], 'computer name');
  const paths = statePaths();
  await withStateLock(paths, async () => {
    const state = await loadState(paths);
    const computer = findComputer(state, name);
    if (action === 'show') {
      operationOutput('log', JSON.stringify(computer.network ?? developerPolicy(), null, 2));
      return;
    }
    if (action === 'explain') {
      const target = required(args.positionals[2], 'URL or host:port');
      operationOutput('log', JSON.stringify(explainNetworkPolicy(computer.network ?? developerPolicy(), target), null, 2));
      return;
    }
    if (action === 'set') {
      const profile = NetworkProfileSchema.parse(required(args.positionals[2], 'network profile'));
      computer.network = NetworkPolicySchema.parse({
        profile,
        allowDomains: commaList(stringOption(args, 'allow-domains')),
        denyDomains: commaList(stringOption(args, 'deny-domains')),
        allowCidrs: commaList(stringOption(args, 'allow-cidrs')),
        allowTcpPorts: portList(stringOption(args, 'allow-tcp-ports')),
        temporaryApprovals: [],
      });
      if (profile === 'custom' && !computer.network.allowDomains.length && !computer.network.allowCidrs.length) throw new Error('The custom network profile requires --allow-domains or --allow-cidrs.');
      await commitPolicyChange(state, computer);
      operationOutput('log', `Network profile for ${computer.name}: ${profile}. Runtime root changes were recreated; /home remained durable.`);
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
      operationOutput('log', `Temporarily approved ${domain} for ${seconds} seconds on ${computer.name}.`);
      return;
    }
    if (action === 'revoke') {
      const domain = required(args.positionals[2], 'approved domain').toLowerCase();
      const policy = NetworkPolicySchema.parse(computer.network ?? developerPolicy());
      const before = policy.temporaryApprovals.length;
      policy.temporaryApprovals = policy.temporaryApprovals.filter((entry) => entry.domain !== domain);
      computer.network = policy;
      await commitPolicyChange(state, computer);
      operationOutput('log', before === policy.temporaryApprovals.length ? `No temporary approval existed for ${domain}.` : `Revoked temporary approval for ${domain}.`);
      return;
    }
    throw new Error(`Unknown network action ${action}.`);
  });
}

export function explainNetworkPolicy(policy: NetworkPolicy, target: string): Record<string, unknown> {
  let host: string;
  let port: number;
  try {
    const url = target.includes('://') ? new URL(target) : new URL(`tcp://${target}`);
    host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
    port = Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0));
  } catch { throw new Error('Network explanation target must be an HTTP(S) URL or host:port.'); }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Network explanation target requires a valid port.');
  const now = Date.now();
  const matches = (pattern: string): boolean => pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2) : host === pattern;
  const temporary = policy.temporaryApprovals.filter(({ domain, expiresAt }) => matches(domain) && Date.parse(expiresAt) > now).sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
  const denied = policy.denyDomains.some(matches);
  const domainAllowed = policy.allowDomains.some(matches);
  const addressAllowed = isIP(host) !== 0 && addressAllowedByCidrs(host, policy.allowCidrs);
  const portAllowed = port === 80 || port === 443 || policy.allowTcpPorts.includes(port);
  let allowed = true;
  let reason = 'Developer profile permits direct workload egress; Qubicl domain deny rules do not constrain arbitrary direct connections in this profile.';
  let enforcement = 'direct-workload-network';
  if (policy.profile === 'offline') { allowed = false; reason = 'The offline profile disables outbound networking.'; enforcement = 'isolated-network'; }
  else if (policy.profile === 'web-only') {
    allowed = port === 80 || port === 443;
    reason = allowed ? 'The mediated web-only profile permits HTTP and HTTPS to public destinations.' : `Port ${port} is outside the web-only port set.`;
    enforcement = 'authenticated-egress-proxy';
  } else if (policy.profile === 'custom') {
    enforcement = 'authenticated-egress-proxy';
    allowed = portAllowed && (domainAllowed || addressAllowed || Boolean(temporary));
    reason = !portAllowed ? `Port ${port} is outside the custom TCP allowlist.`
      : domainAllowed ? `${host} matches an explicit domain allow rule.`
        : addressAllowed ? `${host} matches an explicit CIDR allow rule.`
        : temporary ? `${host} has a temporary approval until ${temporary.expiresAt}.`
          : `${host} does not match an explicit domain rule. CIDR rules are evaluated after DNS resolution at connection time.`;
  }
  if (policy.profile !== 'developer' && denied && !temporary) { allowed = false; reason = `${host} matches a deny rule and has no active temporary approval.`; }
  return {
    target: { host, port }, profile: policy.profile, allowedByNamedRules: allowed, reason, enforcement,
    dns: policy.profile === 'developer' ? 'workload-resolver' : 'proxy-resolves-and-pins-one-approved-address',
    privateDestinations: policy.profile === 'developer' ? 'directly reachable according to Docker/host routing' : policy.allowCidrs.length ? `only approved CIDRs: ${policy.allowCidrs.join(', ')}` : 'denied',
    note: 'This is a deterministic policy explanation. It does not resolve DNS or make a network request.',
  };
}

function addressAllowedByCidrs(address: string, cidrs: readonly string[]): boolean {
  const family = isIP(address);
  if (!family) return false;
  const block = new BlockList();
  for (const cidr of cidrs) {
    const separator = cidr.lastIndexOf('/');
    const base = cidr.slice(0, separator);
    const prefix = Number(cidr.slice(separator + 1));
    if (isIP(base) === family) block.addSubnet(base, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return block.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export async function commitPolicyChange(state: LoadedState, computer: ComputerConfig): Promise<void> {
  ConfigSchema.parse(state.config);
  await validateDocker();
  const { managedComputerRuntimeObservation } = await import('./docker.js');
  const { requirePreservedRuntimeState } = await import('./lifecycle-update.js');
  const observed = await managedComputerRuntimeObservation(state, computer);
  const prior = requirePreservedRuntimeState(observed, `Computer ${computer.name}`);
  if (prior !== 'absent') await ensureRuntimeImages(state, [computer], true);
  await executeStateTransaction(state.paths, createStateTransaction('config', state, {
    runtime: {
      replaceIds: prior === 'running' ? [computer.id] : [],
      replaceStoppedIds: prior === 'stopped' ? [computer.id] : [],
      ...(prior === 'absent' ? {} : { computerRuntimeBindings: { [computer.id]: observed.containers } }),
      startGateway: prior === 'running',
    },
  }));
}

function developerPolicy(): { profile: 'developer'; allowDomains: never[]; denyDomains: never[]; allowCidrs: never[]; allowTcpPorts: never[]; temporaryApprovals: never[] } {
  return { profile: 'developer', allowDomains: [], denyDomains: [], allowCidrs: [], allowTcpPorts: [], temporaryApprovals: [] };
}
function commaList(value: string | undefined): string[] { return value ? [...new Set(value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))] : []; }
function portList(value: string | undefined): number[] { return value ? [...new Set(value.split(',').map((entry) => Number(entry.trim())))] : []; }
function findComputer(state: LoadedState, value: string): ComputerConfig { const computer = state.config.computers.find(({ id, name }) => id === value || name === value); if (!computer) throw new Error(`Computer ${value} was not found.`); return computer; }
function required(value: string | undefined, description: string): string { if (!value) throw new Error(`Missing ${description}.`); return value; }
