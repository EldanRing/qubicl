import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, connect as netConnect } from 'node:net';
import { QubiclError } from './errors.js';
import { AuditLog } from './audit.js';
import { isGloballyRoutableIp } from './network-address.js';

const egressAudits = new Map<string, AuditLog>();

export interface EgressNetworkPolicy {
  profile: 'developer' | 'web-only' | 'offline' | 'custom';
  allowDomains: string[];
  denyDomains: string[];
  temporaryApprovals: Array<{ domain: string; expiresAt: string }>;
}

export interface EgressConfiguration {
  id: string;
  policy: EgressNetworkPolicy;
  proxyKey: string;
  brokerKey: string;
  brokerPath?: string;
  auditPath?: string;
}

export interface EgressServerOptions {
  configurations(): readonly EgressConfiguration[];
}

interface BrokerCredential {
  id: string;
  baseUrl: string;
  pathPrefix: string;
  methods: string[];
  header: string;
  value: string;
  expiresAt?: string;
}

export function createEgressServer(options?: EgressServerOptions): ReturnType<typeof createServer> {
  const legacyConfiguration = options ? undefined : {
    id: process.env.QUBICL_ID ?? 'legacy',
    policy: parsePolicy(process.env.QUBICL_NETWORK_POLICY),
    proxyKey: requiredSecret('QUBICL_PROXY_KEY'),
    brokerKey: requiredSecret('QUBICL_BROKER_KEY'),
    ...(process.env.QUBICL_BROKER_PATH ? { brokerPath: process.env.QUBICL_BROKER_PATH } : {}),
    ...(process.env.QUBICL_AUDIT_PATH ? { auditPath: process.env.QUBICL_AUDIT_PATH } : {}),
  } satisfies EgressConfiguration;
  const configurations = (): readonly EgressConfiguration[] => options?.configurations() ?? [legacyConfiguration!];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health') return json(response, 200, options
        ? { status: 'ok', computers: configurations().length }
        : { status: 'ok', profile: legacyConfiguration!.policy.profile });
      if (request.url === '/v1/broker/request') {
        const configuration = brokerConfiguration(request.headers['x-qubicl-broker-key'], configurations());
        if (!configuration) throw new QubiclError('unauthorized', 'Invalid broker credential.', 401);
        return await brokerRequest(request, response, configuration);
      }
      const configuration = proxyConfiguration(request.headers['proxy-authorization'], configurations());
      if (!configuration) throw new QubiclError('proxy_authentication_required', 'Proxy authentication is required.', 407);
      await forwardHttp(request, response, configuration);
    } catch (error) {
      const status = error instanceof QubiclError ? error.status : 500;
      json(response, status, { error: { code: error instanceof QubiclError ? error.code : 'egress_error', message: error instanceof Error ? error.message : String(error) } });
    }
  });
  server.on('connect', (request, client, head) => {
    // A browser/fetch client may reset a CONNECT tunnel at any time (for
    // example while aborting a timed request). Without a listener Node treats
    // that ordinary socket reset as an uncaught process-level error, which
    // would restart the shared gateway and interrupt every computer.
    client.on('error', () => undefined);
    void (async () => {
      try {
        const configuration = proxyConfiguration(request.headers['proxy-authorization'], configurations());
        if (!configuration) throw new QubiclError('proxy_authentication_required', 'Proxy authentication is required.', 407);
        const { host, port } = connectTarget(request.url ?? '');
        const address = await authorizeTarget(host, port, configuration.policy);
        const upstream = netConnect({ host: address, port }, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
          audit(configuration, 'egress_connect', { host, port, profile: configuration.policy.profile });
        });
        client.once('close', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      } catch (error) {
        const status = error instanceof QubiclError ? error.status : 502;
        client.end(`HTTP/1.1 ${status} ${status === 407 ? 'Proxy Authentication Required' : 'Forbidden'}\r\nConnection: close\r\n\r\n`);
      }
    })();
  });
  return server;
}

async function forwardHttp(request: IncomingMessage, response: ServerResponse, configuration: EgressConfiguration): Promise<void> {
  const { policy } = configuration;
  const target = new URL(request.url ?? '');
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new QubiclError('network_policy_denied', 'Only HTTP and HTTPS proxy requests are supported.', 403);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const address = await authorizeTarget(target.hostname, port, policy);
  const headers = sanitizedForwardHeaders(request.headers, target.host);
  const factory = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = factory({ hostname: address, servername: target.hostname, port, method: request.method, path: `${target.pathname}${target.search}`, headers }, (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, sanitizedResponseHeaders(incoming.headers));
    incoming.pipe(response);
  });
  upstream.on('error', (error) => response.destroy(error));
  request.pipe(upstream);
  audit(configuration, 'egress_http', { host: target.hostname, port, method: request.method, profile: policy.profile });
}

async function brokerRequest(request: IncomingMessage, response: ServerResponse, configuration: EgressConfiguration): Promise<void> {
  const { policy, brokerPath: path } = configuration;
  if (policy.profile === 'offline') throw new QubiclError('network_policy_denied', 'Credential brokering is disabled by the offline network profile.', 403);
  if (!path) throw new QubiclError('broker_unconfigured', 'No broker configuration is mounted.', 404);
  const config = JSON.parse(await readFile(path, 'utf8')) as { credentials?: BrokerCredential[] };
  const body = await readJson(request, 2_000_000);
  const id = string(body.credentialId, 'credentialId');
  const credential = config.credentials?.find((candidate) => candidate.id === id);
  if (!credential || (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())) throw new QubiclError('credential_unavailable', `Credential ${id} is missing or expired.`, 404);
  const method = string(body.method ?? 'GET', 'method').toUpperCase();
  if (!credential.methods.includes(method)) throw new QubiclError('credential_scope_denied', `Credential ${id} does not allow ${method}.`, 403);
  const target = canonicalBrokerTarget(credential.baseUrl, string(body.path ?? '/', 'path'), credential.pathPrefix, id);
  const targetPort = Number(target.port || 443);
  const targetAddress = await authorizeTarget(target.hostname, targetPort, policy);
  const extraHeaders = stringRecord(body.headers);
  for (const name of ['authorization', 'cookie', 'host', 'connection', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', credential.header.toLowerCase()]) delete extraHeaders[name];
  const payload = typeof body.body === 'string' ? Buffer.from(body.body, body.bodyEncoding === 'base64' ? 'base64' : 'utf8') : undefined;
  const result = await new Promise<{ status: number; headers: Record<string, string | string[]>; data: Buffer }>((resolve, reject) => {
    const outgoing = httpsRequest({ hostname: targetAddress, servername: target.hostname, port: targetPort, method, path: `${target.pathname}${target.search}`, headers: { ...extraHeaders, host: target.host, [credential.header]: credential.value, ...(payload ? { 'content-length': `${payload.length}` } : {}) } }, (incoming) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) incoming.destroy(new Error('Broker response exceeds 2 MB.'));
        else chunks.push(chunk);
      });
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 502, headers: sanitizedResponseHeaders(incoming.headers), data: Buffer.concat(chunks) }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
  audit(configuration, 'credential_broker_use', { credentialId: id, host: target.hostname, method });
  const textResponse = textual(result.headers['content-type']);
  const safeHeaders = redactCredentialValue(result.headers, credential.value) as Record<string, string | string[]>;
  const safeData = redactCredentialBuffer(result.data, credential.value);
  json(response, 200, {
    status: result.status,
    headers: safeHeaders,
    body: textResponse ? redactCredentialText(safeData.toString('utf8'), credential.value) : safeData.toString('base64'),
    bodyEncoding: textResponse ? 'utf8' : 'base64',
  });
}

async function authorizeTarget(host: string, port: number, policy: EgressNetworkPolicy): Promise<string> {
  const normalized = host.toLowerCase().replace(/\.$/u, '');
  if (policy.profile === 'offline') throw new QubiclError('network_policy_denied', 'Outbound access is disabled by the offline network profile.', 403);
  if ((policy.profile === 'web-only' || policy.profile === 'custom') && port !== 80 && port !== 443) throw new QubiclError('network_policy_denied', `Port ${port} is not allowed by ${policy.profile}.`, 403);
  const temporary = policy.temporaryApprovals.some((entry) => Date.parse(entry.expiresAt) > Date.now() && domainMatches(normalized, entry.domain));
  if (!temporary && policy.denyDomains.some((pattern) => domainMatches(normalized, pattern))) throw new QubiclError('network_policy_denied', `${normalized} is denied by network policy.`, 403);
  if (policy.profile === 'custom' && !temporary && !policy.allowDomains.some((pattern) => domainMatches(normalized, pattern))) throw new QubiclError('network_policy_denied', `${normalized} is not in the custom allowlist.`, 403);
  const addresses = isIP(normalized) ? [{ address: normalized }] : await lookup(normalized, { all: true, verbatim: true });
  if (!addresses.length) throw new QubiclError('network_policy_denied', `No address resolved for ${normalized}.`, 403);
  const allowed = addresses.find(({ address }) => policy.profile === 'developer' || isGloballyRoutableIp(address));
  if (!allowed) throw new QubiclError('network_policy_denied', `${normalized} resolves only to a private, loopback, link-local, or metadata address.`, 403);
  return allowed.address;
}

function parsePolicy(value: string | undefined): EgressNetworkPolicy {
  if (!value) return { profile: 'developer', allowDomains: [], denyDomains: [], temporaryApprovals: [] };
  const policy = JSON.parse(value) as EgressNetworkPolicy;
  if (!['developer', 'web-only', 'offline', 'custom'].includes(policy.profile)) throw new Error('QUBICL_NETWORK_POLICY is invalid.');
  return { profile: policy.profile, allowDomains: policy.allowDomains ?? [], denyDomains: policy.denyDomains ?? [], temporaryApprovals: policy.temporaryApprovals ?? [] };
}

function proxyConfiguration(value: string | undefined, configurations: readonly EgressConfiguration[]): EgressConfiguration | undefined {
  if (!value?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
  const supplied = decoded.slice(decoded.indexOf(':') + 1);
  return configurations.find(({ proxyKey }) => secretMatches(supplied, proxyKey));
}
function brokerConfiguration(value: string | string[] | undefined, configurations: readonly EgressConfiguration[]): EgressConfiguration | undefined {
  return configurations.find(({ brokerKey }) => secretMatches(value, brokerKey));
}
function secretMatches(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const left = Buffer.from(value); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function requiredSecret(name: string): string { const value = process.env[name]; if (!value || value.length < 32) throw new Error(`${name} is required.`); return value; }
function connectTarget(value: string): { host: string; port: number } {
  const index = value.lastIndexOf(':');
  const host = value.slice(0, index).replace(/^\[|\]$/gu, '');
  const port = Number(value.slice(index + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new QubiclError('network_policy_denied', 'Invalid CONNECT target.', 403);
  return { host, port };
}
function domainMatches(host: string, pattern: string): boolean { const normalized = pattern.toLowerCase(); return normalized.startsWith('*.') ? host.endsWith(normalized.slice(1)) && host !== normalized.slice(2) : host === normalized; }
function sanitizedForwardHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders { const result: Record<string, string | string[] | undefined> = { ...headers, host }; delete result['proxy-authorization']; delete result['proxy-connection']; return result; }
function sanitizedResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> { const result: Record<string, string | string[]> = {}; for (const [name, value] of Object.entries(headers)) if (value !== undefined && !['set-cookie', 'proxy-authenticate'].includes(name)) result[name] = value; return result; }
async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > limit) throw new QubiclError('request_too_large', 'Request is too large.', 413); chunks.push(data); } const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QubiclError('invalid_arguments', 'Request must be an object.'); return value as Record<string, unknown>; }
function string(value: unknown, name: string): string { if (typeof value !== 'string') throw new QubiclError('invalid_arguments', `${name} must be a string.`); return value; }
function stringRecord(value: unknown): Record<string, string> { if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QubiclError('invalid_arguments', 'headers must be an object.'); const result: Record<string, string> = {}; for (const [key, entry] of Object.entries(value)) { if (typeof entry !== 'string' || !/^[A-Za-z0-9-]{1,80}$/u.test(key)) throw new QubiclError('invalid_arguments', 'headers must contain string HTTP header values.'); result[key.toLowerCase()] = entry; } return result; }
export function canonicalBrokerTarget(baseUrl: string, requestedPath: string, configuredPrefix: string, credentialId = 'credential'): URL {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new QubiclError('credential_scope_denied', `Credential ${credentialId} has an invalid base URL.`, 403); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new QubiclError('credential_scope_denied', `Credential ${credentialId} must use a credential-free HTTPS base URL.`, 403);
  for (const [value, label] of [[requestedPath, 'path'], [configuredPrefix, 'path prefix']] as const) {
    if (!value.startsWith('/') || value.includes('\\') || value.includes('#') || /\/\//u.test(value) || /%(?:2e|2f|5c)/iu.test(value)) {
      throw new QubiclError('credential_scope_denied', `Credential ${credentialId} ${label} is ambiguous or non-canonical.`, 403);
    }
    const rawPath = value.split('?')[0]!;
    if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) throw new QubiclError('credential_scope_denied', `Credential ${credentialId} ${label} contains a dot segment.`, 403);
  }
  const target = new URL(requestedPath, base);
  const prefix = new URL(configuredPrefix, base);
  if (target.origin !== base.origin || prefix.origin !== base.origin || prefix.search || prefix.hash) throw new QubiclError('credential_scope_denied', 'Broker requests cannot change origin.', 403);
  if (!pathWithinPrefix(target.pathname, prefix.pathname)) throw new QubiclError('credential_scope_denied', `Credential ${credentialId} does not allow this path.`, 403);
  return target;
}
function pathWithinPrefix(path: string, prefix: string): boolean { const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`; return path === prefix || path.startsWith(normalized); }
export function redactCredentialText(value: string, credential: string): string { return credential ? value.replaceAll(credential, '[REDACTED]') : value; }
function redactCredentialValue(value: unknown, credential: string): unknown { if (typeof value === 'string') return redactCredentialText(value, credential); if (Array.isArray(value)) return value.map((entry) => redactCredentialValue(entry, credential)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactCredentialValue(entry, credential)])); return value; }
function redactCredentialBuffer(value: Buffer, credential: string): Buffer { const needle = Buffer.from(credential); if (!needle.length || !value.includes(needle)) return value; return Buffer.from(redactCredentialText(value.toString('utf8'), credential)); }
function textual(value: string | string[] | undefined): boolean { const type = Array.isArray(value) ? value[0] : value; return type === undefined || /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded))/iu.test(type); }
function json(response: ServerResponse, status: number, value: unknown): void { const body = JSON.stringify(value); response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...(status === 407 ? { 'proxy-authenticate': 'Basic realm="Qubicl"' } : {}) }); response.end(body); }
function audit(configuration: EgressConfiguration, event: string, details: Record<string, unknown>): void {
  let log = egressAudits.get(configuration.id);
  if (!log) {
    log = new AuditLog(configuration.auditPath);
    egressAudits.set(configuration.id, log);
  }
  log.record({ component: 'egress', computerId: configuration.id, event, ...details });
}
export async function flushEgressAudit(): Promise<void> { await Promise.all([...egressAudits.values()].map((log) => log.flush())); }
