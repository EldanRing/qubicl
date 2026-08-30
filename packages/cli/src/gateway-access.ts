import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect, createSecureContext } from 'node:tls';
import {
  GatewayExposureConfigSchema,
  GatewayExposureRuntimeSchema,
  GatewayHostnameSchema,
  GatewayPreviewDomainSchema,
  HttpsOriginSchema,
  IpAddressSchema,
  NetworkCidrSchema,
  assertGatewayExposureTlsSecretMatches,
  certificateCoversGatewayHostname,
  gatewayExposureOrigin,
  gatewayExposureRuntime,
  gatewayPreviewHostname,
  sha256Text,
  type GatewayExposureConfig,
  type GatewayExposureTlsSecret,
  type QubiclConfig,
} from '@qubicl/core';
import { atomicWrite, durableRemove, syncDirectory, type LoadedState, type StatePaths } from './state.js';

export const GATEWAY_EXPOSURE_RUNTIME_DIRECTORY = 'gateway-exposure';
export const GATEWAY_EXPOSURE_RUNTIME_DOCUMENT = 'gateway-exposure.json';
export const GATEWAY_EXPOSURE_CERTIFICATE_FILE = 'certificate.pem';
export const GATEWAY_EXPOSURE_PRIVATE_KEY_FILE = 'private-key.pem';
export const GATEWAY_EXPOSURE_CLIENT_CA_FILE = 'client-ca.pem';

const MAX_CERTIFICATE_BYTES = 1_048_576;
const MAX_PRIVATE_KEY_BYTES = 262_144;
const MAX_CLIENT_CA_BYTES = 1_048_576;
const PREVIEW_CERTIFICATE_PROBE_ID = '00000000-0000-4000-8000-000000000001';

export interface GatewayTlsInput {
  certificatePath: string;
  privateKeyPath: string;
  clientCertificateAuthorityPath?: string;
  hostname: string;
  previewDomain?: string;
  now?: Date;
}

export interface ValidatedGatewayTlsInput {
  metadata: GatewayExposureConfig['tls'];
  secret: GatewayExposureTlsSecret;
  certificateSubject: string;
  certificateIssuer: string;
  certificateSubjectAltName?: string;
}

export interface GatewayEndpointSet {
  origin: string;
  health: string;
  mcp: string;
  openapi: string;
  openTerminal: string;
  view?: string;
  previewBase?: string;
}

export interface GatewayCertificateSummary {
  fingerprint256: string;
  notBefore: string;
  notAfter: string;
  subject: string;
  issuer: string;
  subjectAltName?: string;
  clientCertificatesRequired: boolean;
}

export interface GatewayTlsProbeResult {
  protocol: string;
  fingerprint256: string;
  statusCode: number;
}

export class GatewayExposureManualProbeRequiredError extends Error {}

export async function validateGatewayTlsInput(input: GatewayTlsInput): Promise<ValidatedGatewayTlsInput> {
  const hostname = normalizeGatewayHostname(input.hostname);
  const previewDomain = input.previewDomain === undefined ? undefined : normalizeGatewayPreviewDomain(input.previewDomain);
  const [certificateChainPem, privateKeyPem, clientCertificateAuthorityPem] = await Promise.all([
    readBoundedPem(input.certificatePath, MAX_CERTIFICATE_BYTES, 'certificate chain', false),
    readBoundedPem(input.privateKeyPath, MAX_PRIVATE_KEY_BYTES, 'private key', true),
    input.clientCertificateAuthorityPath === undefined
      ? undefined
      : readBoundedPem(input.clientCertificateAuthorityPath, MAX_CLIENT_CA_BYTES, 'client certificate authority', false),
  ]);

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificateChainPem);
    createSecureContext({
      cert: certificateChainPem,
      key: privateKeyPem,
      ...(clientCertificateAuthorityPem ? { ca: clientCertificateAuthorityPem } : {}),
      minVersion: 'TLSv1.2',
    });
    const privateKey = createPrivateKey(privateKeyPem);
    const privatePublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const certificatePublic = certificate.publicKey.export({ format: 'der', type: 'spki' });
    if (privatePublic.length !== certificatePublic.length || !timingSafeEqual(privatePublic, certificatePublic)) {
      throw new Error('certificate and private key public keys do not match');
    }
    if (clientCertificateAuthorityPem) parseX509Certificate(clientCertificateAuthorityPem);
  } catch (error) {
    throw new Error(`Gateway TLS material is invalid or mismatched: ${errorMessage(error)}`);
  }

  const now = input.now ?? new Date();
  const notBefore = parseCertificateDate(certificate.validFrom, 'not-before');
  const notAfter = parseCertificateDate(certificate.validTo, 'not-after');
  if (notBefore.getTime() > now.getTime()) {
    throw new Error(`Gateway certificate is not valid until ${notBefore.toISOString()}.`);
  }
  if (notAfter.getTime() <= now.getTime()) {
    throw new Error(`Gateway certificate expired at ${notAfter.toISOString()}.`);
  }
  assertCertificateHostname(certificate, hostname, 'gateway hostname');
  if (previewDomain) {
    assertCertificateHostname(
      certificate,
      gatewayPreviewHostname(PREVIEW_CERTIFICATE_PROBE_ID, previewDomain),
      'remote preview wildcard hostname',
    );
    assertCertificatePreviewWildcard(certificate, previewDomain);
  }

  const secret = {
    id: randomBytes(32).toString('hex'),
    certificateChainPem,
    privateKeyPem,
    ...(clientCertificateAuthorityPem ? { clientCertificateAuthorityPem } : {}),
  } satisfies GatewayExposureTlsSecret;
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error('Gateway certificate did not provide a valid SHA-256 fingerprint.');
  return {
    metadata: {
      id: secret.id,
      certificateSha256: sha256Text(certificateChainPem),
      privateKeySha256: sha256Text(privateKeyPem),
      certificateFingerprint256: `sha256:${fingerprint}`,
      certificateNotBefore: notBefore.toISOString(),
      certificateNotAfter: notAfter.toISOString(),
      ...(clientCertificateAuthorityPem
        ? { clientCertificateAuthoritySha256: sha256Text(clientCertificateAuthorityPem) }
        : {}),
    },
    secret,
    certificateSubject: certificate.subject,
    certificateIssuer: certificate.issuer,
    ...(certificate.subjectAltName ? { certificateSubjectAltName: certificate.subjectAltName } : {}),
  };
}

export function buildGatewayExposureConfig(input: {
  bindAddress: string;
  port: number;
  hostname: string;
  allowedNetworks: readonly string[];
  trustedOrigins?: readonly string[];
  previewDomain?: string;
  tls: GatewayExposureConfig['tls'];
}): GatewayExposureConfig {
  const bindAddress = normalizeBindAddress(input.bindAddress);
  const hostname = normalizeGatewayHostname(input.hostname);
  const previewDomain = input.previewDomain === undefined ? undefined : normalizeGatewayPreviewDomain(input.previewDomain);
  const allowedNetworks = unique(input.allowedNetworks.map((value) => NetworkCidrSchema.parse(value.trim())));
  const canonicalOrigin = gatewayExposureOrigin({ hostname, port: input.port });
  const trustedOrigins = unique([
    canonicalOrigin,
    ...(input.trustedOrigins ?? []).map(normalizeHttpsOrigin),
  ]);
  return GatewayExposureConfigSchema.parse({
    protocol: 'direct-tls-v1',
    bindAddress,
    port: input.port,
    hostname,
    allowedNetworks,
    trustedOrigins,
    ...(previewDomain ? { previewDomain } : {}),
    tls: input.tls,
  });
}

export function parseCommaSeparatedOption(value: string | undefined, label: string): string[] {
  if (value === undefined) return [];
  const values = value.split(',').map((entry) => entry.trim());
  if (values.some((entry) => !entry)) throw new Error(`${label} must be a comma-separated list with no empty entries.`);
  return unique(values);
}

export function normalizeBindAddress(value: string): string {
  const candidate = value.trim().replace(/^\[|\]$/gu, '');
  return IpAddressSchema.parse(candidate);
}

export function gatewayBindAddressPresent(bindAddress: string): boolean {
  if (bindAddress === '0.0.0.0' || bindAddress === '::') return true;
  return Object.values(networkInterfaces()).flat().some((entry) => entry?.address === bindAddress);
}

export function normalizeGatewayHostname(value: string): string {
  const candidate = value.trim().replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (isIP(candidate) !== 0) return GatewayHostnameSchema.parse(candidate);
  if (/[/:@?#]/u.test(candidate)) throw new Error('Gateway hostname must not contain a scheme, port, credentials, path, query, or fragment.');
  let normalized: string;
  try { normalized = new URL(`https://${candidate}`).hostname; }
  catch { throw new Error('Gateway hostname must be a DNS hostname or IP address.'); }
  return GatewayHostnameSchema.parse(normalized);
}

export function normalizeGatewayPreviewDomain(value: string): string {
  return GatewayPreviewDomainSchema.parse(normalizeGatewayHostname(value));
}

export function normalizeHttpsOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { throw new Error(`Trusted origin ${JSON.stringify(value)} is not a URL.`); }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`Trusted origin ${JSON.stringify(value)} must not include credentials, a path, query, or fragment.`);
  }
  return HttpsOriginSchema.parse(parsed.origin);
}

export function gatewayEndpointSet(
  gateway: Pick<QubiclConfig['gateway'], 'port' | 'exposure'>,
  computer: { id: string; capabilities: readonly string[] },
  access: 'local' | 'remote',
): GatewayEndpointSet | undefined {
  if (access === 'remote' && !gateway.exposure) return undefined;
  const origin = access === 'local'
    ? `http://127.0.0.1:${gateway.port}`
    : gatewayExposureOrigin(gateway.exposure!);
  const base = `${origin}/computers/${computer.id}`;
  const previewBase = access === 'local'
    ? `http://preview-${computer.id}.localhost:${gateway.port}${base.slice(origin.length)}/previews`
    : gateway.exposure?.previewDomain
      ? `${gatewayExposureOrigin({ hostname: gatewayPreviewHostname(computer.id, gateway.exposure.previewDomain), port: gateway.exposure.port })}${base.slice(origin.length)}/previews`
      : undefined;
  return {
    origin,
    health: `${base}/health`,
    mcp: `${base}/mcp`,
    openapi: `${base}/openapi.json`,
    openTerminal: `${base}/open-terminal`,
    ...(computer.capabilities.includes('viewer') ? { view: `${base}/view` } : {}),
    ...(previewBase ? { previewBase } : {}),
  };
}

export function gatewayExposurePaths(paths: StatePaths): {
  directory: string;
  document: string;
  certificate: string;
  privateKey: string;
  clientCertificateAuthority: string;
} {
  const directory = join(paths.runtime, GATEWAY_EXPOSURE_RUNTIME_DIRECTORY);
  return {
    directory,
    document: join(directory, GATEWAY_EXPOSURE_RUNTIME_DOCUMENT),
    certificate: join(directory, GATEWAY_EXPOSURE_CERTIFICATE_FILE),
    privateKey: join(directory, GATEWAY_EXPOSURE_PRIVATE_KEY_FILE),
    clientCertificateAuthority: join(directory, GATEWAY_EXPOSURE_CLIENT_CA_FILE),
  };
}

export function validateConfiguredGatewayTls(
  exposure: GatewayExposureConfig,
  secret: GatewayExposureTlsSecret,
  now = new Date(),
  options: { requireCurrent?: boolean } = {},
): GatewayCertificateSummary {
  assertGatewayExposureTlsSecretMatches(exposure, secret);
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(secret.certificateChainPem);
    createSecureContext({
      cert: secret.certificateChainPem,
      key: secret.privateKeyPem,
      ...(secret.clientCertificateAuthorityPem ? { ca: secret.clientCertificateAuthorityPem } : {}),
      minVersion: 'TLSv1.2',
    });
    const privateKey = createPrivateKey(secret.privateKeyPem);
    const privatePublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const certificatePublic = certificate.publicKey.export({ format: 'der', type: 'spki' });
    if (privatePublic.length !== certificatePublic.length || !timingSafeEqual(privatePublic, certificatePublic)) {
      throw new Error('certificate and private key public keys do not match');
    }
    if (secret.clientCertificateAuthorityPem) parseX509Certificate(secret.clientCertificateAuthorityPem);
  } catch (error) {
    throw new Error(`Configured gateway TLS material is invalid or mismatched: ${errorMessage(error)}`);
  }
  const notBefore = parseCertificateDate(certificate.validFrom, 'not-before');
  const notAfter = parseCertificateDate(certificate.validTo, 'not-after');
  if (options.requireCurrent ?? true) {
    if (notBefore.getTime() > now.getTime()) throw new Error(`Configured gateway certificate is not valid until ${notBefore.toISOString()}.`);
    if (notAfter.getTime() <= now.getTime()) throw new Error(`Configured gateway certificate expired at ${notAfter.toISOString()}.`);
  }
  assertCertificateHostname(certificate, exposure.hostname, 'gateway hostname');
  if (exposure.previewDomain) {
    assertCertificateHostname(
      certificate,
      gatewayPreviewHostname(PREVIEW_CERTIFICATE_PROBE_ID, exposure.previewDomain),
      'remote preview wildcard hostname',
    );
    assertCertificatePreviewWildcard(certificate, exposure.previewDomain);
  }
  const fingerprint256 = `sha256:${certificate.fingerprint256.replaceAll(':', '').toLowerCase()}`;
  if (fingerprint256 !== exposure.tls.certificateFingerprint256
    || notBefore.toISOString() !== exposure.tls.certificateNotBefore
    || notAfter.toISOString() !== exposure.tls.certificateNotAfter) {
    throw new Error('Configured gateway certificate metadata does not match the protected TLS snapshot.');
  }
  return {
    fingerprint256,
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    subject: certificate.subject,
    issuer: certificate.issuer,
    ...(certificate.subjectAltName ? { subjectAltName: certificate.subjectAltName } : {}),
    clientCertificatesRequired: secret.clientCertificateAuthorityPem !== undefined,
  };
}

export function certificateHasPreviewWildcard(
  certificate: Pick<X509Certificate, 'subjectAltName'>,
  previewDomain: string,
): boolean {
  const expected = `DNS:*.${normalizeGatewayPreviewDomain(previewDomain)}`.toLowerCase();
  return (certificate.subjectAltName ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .includes(expected);
}

function assertCertificatePreviewWildcard(
  certificate: Pick<X509Certificate, 'subjectAltName'>,
  previewDomain: string,
): void {
  if (!certificateHasPreviewWildcard(certificate, previewDomain)) {
    throw new Error(`Gateway certificate does not contain the required DNS:*.${previewDomain} remote preview wildcard SAN.`);
  }
}

export async function probeGatewayExposure(exposure: GatewayExposureConfig): Promise<GatewayTlsProbeResult> {
  const connectHost = gatewayExposureProbeHost(exposure);
  if (!connectHost) {
    throw new GatewayExposureManualProbeRequiredError(
      `No assigned non-loopback host address is inside the configured ${exposure.bindAddress} client allowlist; verify the TLS listener from an allowed client manually.`,
    );
  }
  return new Promise<GatewayTlsProbeResult>((resolve, reject) => {
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (error?: Error, value?: GatewayTlsProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const socket = tlsConnect({
      host: connectHost,
      port: exposure.port,
      ...(isIP(exposure.hostname) === 0 ? { servername: exposure.hostname } : {}),
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });
    socket.setTimeout(5_000, () => finish(new Error('Gateway TLS probe timed out.')));
    socket.once('error', (error) => finish(new Error(`Gateway TLS probe failed: ${error.message}`)));
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      const fingerprint = certificate.fingerprint256?.replaceAll(':', '').toLowerCase();
      const fingerprint256 = fingerprint ? `sha256:${fingerprint}` : undefined;
      if (fingerprint256 !== exposure.tls.certificateFingerprint256) {
        finish(new Error('Gateway TLS probe returned a certificate with an unexpected SHA-256 fingerprint.'));
        return;
      }
      socket.write([
        'GET /health HTTP/1.1',
        `Host: ${new URL(gatewayExposureOrigin(exposure)).host}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 32_768) finish(new Error('Gateway TLS probe response exceeded its bound.'));
    });
    socket.once('end', () => {
      const headerEnd = response.indexOf('\r\n\r\n');
      const statusLine = headerEnd < 0 ? '' : response.subarray(0, headerEnd).toString('latin1').split('\r\n')[0] ?? '';
      const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})(?: |$)/u);
      const statusCode = match ? Number(match[1]) : 0;
      if (statusCode !== 200) {
        finish(new Error(`Gateway TLS probe returned ${statusCode || 'an invalid HTTP response'}.`));
        return;
      }
      finish(undefined, {
        protocol: socket.getProtocol() ?? 'unknown',
        fingerprint256: exposure.tls.certificateFingerprint256,
        statusCode,
      });
    });
  });
}

export function gatewayExposureProbeHost(
  exposure: Pick<GatewayExposureConfig, 'bindAddress' | 'allowedNetworks'>,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  const bindVersion = isIP(exposure.bindAddress);
  const family = bindVersion === 4 ? 'IPv4' : 'IPv6';
  const blockListFamily = bindVersion === 4 ? 'ipv4' : 'ipv6';
  const blockList = new BlockList();
  for (const network of exposure.allowedNetworks) {
    const separator = network.lastIndexOf('/');
    const address = network.slice(0, separator);
    const version = isIP(address);
    blockList.addSubnet(address, Number(network.slice(separator + 1)), version === 4 ? 'ipv4' : 'ipv6');
  }
  if (exposure.bindAddress !== '0.0.0.0' && exposure.bindAddress !== '::') {
    return blockList.check(exposure.bindAddress, blockListFamily) ? exposure.bindAddress : undefined;
  }
  return Object.values(interfaces).flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .filter((entry) => !entry.internal && entry.family === family)
    .map(({ address }) => address)
    .toSorted()
    .find((address) => blockList.check(address, blockListFamily));
}

export async function materializeGatewayExposure(state: LoadedState): Promise<void> {
  const exposure = state.config.gateway.exposure;
  const secret = state.secrets.gateway?.tls;
  assertGatewayExposureTlsSecretMatches(exposure, secret);
  const paths = gatewayExposurePaths(state.paths);
  if (!exposure || !secret) {
    await removeGatewayExposureRuntime(state.paths);
    return;
  }
  // Persist the exact structurally valid snapshot even after expiry so revoke
  // and renewal remain possible. The gateway itself refuses an invalid date,
  // and status/doctor report it as unavailable.
  validateConfiguredGatewayTls(exposure, secret, new Date(), { requireCurrent: false });
  await ensurePrivateRuntimeDirectory(paths.directory);
  await atomicWrite(paths.certificate, secret.certificateChainPem, 0o600);
  await atomicWrite(paths.privateKey, secret.privateKeyPem, 0o600);
  if (secret.clientCertificateAuthorityPem) {
    await atomicWrite(paths.clientCertificateAuthority, secret.clientCertificateAuthorityPem, 0o600);
  } else {
    await durableRemove(paths.clientCertificateAuthority);
  }
  await atomicWrite(paths.document, `${JSON.stringify(gatewayExposureRuntime(exposure), null, 2)}\n`, 0o600);
}

export async function removeGatewayExposureRuntime(paths: StatePaths): Promise<void> {
  const runtime = gatewayExposurePaths(paths);
  let directory;
  try { directory = await lstat(runtime.directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`${runtime.directory} is not Qubicl's real gateway exposure runtime directory.`);
  }
  const entries = await readdir(runtime.directory, { withFileTypes: true });
  const allowed = new Set([
    GATEWAY_EXPOSURE_RUNTIME_DOCUMENT,
    GATEWAY_EXPOSURE_CERTIFICATE_FILE,
    GATEWAY_EXPOSURE_PRIVATE_KEY_FILE,
    GATEWAY_EXPOSURE_CLIENT_CA_FILE,
  ]);
  const unexpected = entries.filter(({ name }) => !allowed.has(name));
  if (unexpected.length) throw new Error(`Gateway exposure runtime directory contains unexpected entries: ${unexpected.map(({ name }) => name).join(', ')}.`);
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Gateway exposure runtime entry ${entry.name} is not a regular file.`);
    await unlink(join(runtime.directory, entry.name));
  }
  await syncDirectory(runtime.directory);
  await rmdir(runtime.directory);
  await syncDirectory(stateRuntimeParent(paths));
}

export async function gatewayExposureRuntimeSnapshotPresent(paths: StatePaths): Promise<boolean> {
  const runtime = gatewayExposurePaths(paths);
  try {
    const info = await lstat(runtime.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${runtime.directory} is not Qubicl's real gateway exposure runtime directory.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function validateGatewayExposureRuntimeSnapshot(
  state: LoadedState,
  options: { requireCurrent?: boolean } = {},
): Promise<GatewayCertificateSummary> {
  const exposure = state.config.gateway.exposure;
  const secret = state.secrets.gateway?.tls;
  if (!exposure || !secret) throw new Error('Gateway exposure is not configured with protected TLS material.');
  const summary = validateConfiguredGatewayTls(exposure, secret, new Date(), options);
  const paths = gatewayExposurePaths(state.paths);
  const [certificate, privateKey, document] = await Promise.all([
    readBoundedPem(paths.certificate, MAX_CERTIFICATE_BYTES, 'runtime certificate chain', true),
    readBoundedPem(paths.privateKey, MAX_PRIVATE_KEY_BYTES, 'runtime private key', true),
    readBoundedPem(paths.document, 128 * 1024, 'runtime document', true),
  ]);
  if (certificate !== secret.certificateChainPem || privateKey !== secret.privateKeyPem) {
    throw new Error('Managed gateway runtime TLS files do not match the protected snapshot.');
  }
  let clientCertificateAuthority: string | undefined;
  if (secret.clientCertificateAuthorityPem) {
    clientCertificateAuthority = await readBoundedPem(
      paths.clientCertificateAuthority,
      MAX_CLIENT_CA_BYTES,
      'runtime client certificate authority',
      true,
    );
    if (clientCertificateAuthority !== secret.clientCertificateAuthorityPem) {
      throw new Error('Managed gateway runtime client certificate authority does not match the protected snapshot.');
    }
  } else {
    try {
      await lstat(paths.clientCertificateAuthority);
      throw new Error('Managed gateway runtime contains an unexpected client certificate authority file.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let parsedDocument;
  try { parsedDocument = GatewayExposureRuntimeSchema.parse(JSON.parse(document)); }
  catch { throw new Error('Managed gateway exposure runtime document is invalid.'); }
  if (JSON.stringify(parsedDocument) !== JSON.stringify(gatewayExposureRuntime(exposure))) {
    throw new Error('Managed gateway exposure runtime document does not match durable configuration.');
  }
  return summary;
}

function stateRuntimeParent(paths: StatePaths): string {
  return paths.runtime;
}

async function readBoundedPem(path: string, maximumBytes: number, label: string, requirePrivateMode: boolean): Promise<string> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`${label} source is not a regular file`);
    if (before.size <= 0n || before.size > BigInt(maximumBytes)) throw new Error(`${label} source exceeds its ${maximumBytes}-byte bound`);
    if (requirePrivateMode && (Number(before.mode) & 0o077) !== 0) throw new Error(`${label} source must not be readable or writable by group or other users`);
    const length = Number(before.size);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} source changed while it was read`);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error(`${label} source changed while it was read`);
    }
    const text = buffer.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer) || text.includes('\0')) throw new Error(`${label} source is not valid PEM text`);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${label} source must be a regular file, not a symbolic link.`);
    }
    throw new Error(`Unable to read gateway ${label} from ${JSON.stringify(path)}: ${errorMessage(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensurePrivateRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} is not a real gateway exposure runtime directory.`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (info.uid !== uid) throw new Error(`${path} is owned by UID ${info.uid}, not current UID ${uid}.`);
  await chmod(path, 0o700);
}

function assertCertificateHostname(certificate: X509Certificate, hostname: string, label: string): void {
  if (!certificateCoversGatewayHostname(certificate, hostname)) {
    throw new Error(`Gateway certificate does not cover the ${label} ${hostname}.`);
  }
}

function parseX509Certificate(pem: string): X509Certificate {
  return new X509Certificate(pem);
}

function parseCertificateDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Gateway certificate ${label} date is invalid.`);
  return parsed;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
