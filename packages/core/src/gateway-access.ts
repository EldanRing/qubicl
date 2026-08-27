import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

export const GATEWAY_EXPOSURE_PROTOCOL = 'direct-tls-v1' as const;
export const GATEWAY_EXTERNAL_CONTAINER_PORT = 3216;
export const COMPUTER_PREVIEW_ACCESS_PROTOCOL = 'dynamic-v1' as const;

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const materialId = z.string().regex(/^[a-f0-9]{64}$/u);

export const IpAddressSchema = z.string().min(2).max(45).superRefine((value, context) => {
  if (isIP(value) === 0) context.addIssue({ code: 'custom', message: 'must be an IPv4 or IPv6 address' });
});

export const NetworkCidrSchema = z.string().min(3).max(49).superRefine((value, context) => {
  const separator = value.lastIndexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    context.addIssue({ code: 'custom', message: 'must be an IPv4 or IPv6 CIDR' });
    return;
  }
  const address = value.slice(0, separator);
  const version = isIP(address);
  const prefixText = value.slice(separator + 1);
  const prefix = Number(prefixText);
  const maximum = version === 4 ? 32 : version === 6 ? 128 : -1;
  if (maximum < 0 || !/^\d{1,3}$/u.test(prefixText) || prefixText !== String(prefix)
    || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
    context.addIssue({ code: 'custom', message: 'must be an IPv4 or IPv6 CIDR with a valid prefix length' });
  }
});

const dnsHostname = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;

export const GatewayHostnameSchema = z.string().min(1).max(253).superRefine((value, context) => {
  if (isIP(value) !== 0) return;
  if (value !== value.toLowerCase() || !dnsHostname.test(value) || value.includes('..')) {
    context.addIssue({ code: 'custom', message: 'must be a lowercase DNS hostname or IP address' });
    return;
  }
  for (const label of value.split('.')) {
    if (label.length > 63 || label.startsWith('-') || label.endsWith('-')) {
      context.addIssue({ code: 'custom', message: 'must contain valid DNS labels' });
      return;
    }
  }
});

export const GatewayPreviewDomainSchema = GatewayHostnameSchema.superRefine((value, context) => {
  if (isIP(value) !== 0) context.addIssue({ code: 'custom', message: 'must be a DNS domain, not an IP address' });
});

export const HttpsOriginSchema = z.url({ protocol: /^https$/u }).max(2048).superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
      context.addIssue({ code: 'custom', message: 'must be an exact HTTPS origin with no credentials, path, query, or fragment' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'must be an exact HTTPS origin' });
  }
});

export const GatewayTlsMaterialSchema = z.strictObject({
  id: materialId,
  certificateSha256: sha256,
  privateKeySha256: sha256,
  certificateFingerprint256: sha256,
  certificateNotBefore: z.iso.datetime(),
  certificateNotAfter: z.iso.datetime(),
  clientCertificateAuthoritySha256: sha256.optional(),
});

export const GatewayExposureTlsSecretSchema = z.strictObject({
  id: materialId,
  certificateChainPem: z.string().min(1).max(1_048_576),
  privateKeyPem: z.string().min(1).max(262_144),
  clientCertificateAuthorityPem: z.string().min(1).max(1_048_576).optional(),
});

export const GatewayExposureConfigSchema = z.strictObject({
  protocol: z.literal(GATEWAY_EXPOSURE_PROTOCOL),
  bindAddress: IpAddressSchema,
  port: z.number().int().min(1).max(65_535),
  hostname: GatewayHostnameSchema,
  allowedNetworks: z.array(NetworkCidrSchema).min(1).max(64),
  trustedOrigins: z.array(HttpsOriginSchema).min(1).max(32),
  previewDomain: GatewayPreviewDomainSchema.optional(),
  tls: GatewayTlsMaterialSchema,
}).superRefine((value, context) => {
  if (new Set(value.allowedNetworks).size !== value.allowedNetworks.length) {
    context.addIssue({ code: 'custom', path: ['allowedNetworks'], message: 'network allowlist entries must be unique' });
  }
  if (new Set(value.trustedOrigins).size !== value.trustedOrigins.length) {
    context.addIssue({ code: 'custom', path: ['trustedOrigins'], message: 'trusted origins must be unique' });
  }
  const canonicalOrigin = gatewayExposureOrigin(value);
  if (!value.trustedOrigins.includes(canonicalOrigin)) {
    context.addIssue({ code: 'custom', path: ['trustedOrigins'], message: `must include the canonical gateway origin ${canonicalOrigin}` });
  }
  if (value.previewDomain === value.hostname) {
    context.addIssue({ code: 'custom', path: ['previewDomain'], message: 'must differ from the gateway hostname to retain preview-origin isolation' });
  }
  if (value.previewDomain && gatewayHostnameIsPreviewRoute(value.hostname, value.previewDomain)) {
    context.addIssue({ code: 'custom', path: ['hostname'], message: 'must not equal a generated per-computer preview hostname' });
  }
});

export type GatewayExposureConfig = z.infer<typeof GatewayExposureConfigSchema>;
export type GatewayTlsMaterial = z.infer<typeof GatewayTlsMaterialSchema>;
export type GatewayExposureTlsSecret = z.infer<typeof GatewayExposureTlsSecretSchema>;

export const GatewayExposureRuntimeSchema = z.strictObject({
  version: z.literal(1),
  protocol: z.literal(GATEWAY_EXPOSURE_PROTOCOL),
  hostname: GatewayHostnameSchema,
  port: z.number().int().min(1).max(65_535),
  allowedNetworks: z.array(NetworkCidrSchema).min(1).max(64),
  trustedOrigins: z.array(HttpsOriginSchema).min(1).max(32),
  previewDomain: GatewayPreviewDomainSchema.optional(),
  certificateSha256: sha256,
  privateKeySha256: sha256,
  certificateFingerprint256: sha256,
  certificateNotBefore: z.iso.datetime(),
  certificateNotAfter: z.iso.datetime(),
  clientCertificateAuthoritySha256: sha256.optional(),
}).superRefine((value, context) => {
  if (value.previewDomain && gatewayHostnameIsPreviewRoute(value.hostname, value.previewDomain)) {
    context.addIssue({ code: 'custom', path: ['hostname'], message: 'must not equal a generated per-computer preview hostname' });
  }
});

export type GatewayExposureRuntime = z.infer<typeof GatewayExposureRuntimeSchema>;

export function gatewayExposureOrigin(value: Pick<GatewayExposureConfig, 'hostname' | 'port'>): string {
  const hostname = isIP(value.hostname) === 6 ? `[${value.hostname}]` : value.hostname;
  return `https://${hostname}${value.port === 443 ? '' : `:${value.port}`}`;
}

export function gatewayPreviewHostname(computerId: string, previewDomain: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(computerId)) throw new Error('A canonical computer ID is required for the preview hostname.');
  return `preview-${computerId}.${GatewayPreviewDomainSchema.parse(previewDomain)}`;
}

export function gatewayHostnameIsPreviewRoute(hostname: string, previewDomain: string): boolean {
  const suffix = `.${previewDomain}`;
  if (!hostname.endsWith(suffix)) return false;
  return /^preview-[a-f0-9-]{36}$/u.test(hostname.slice(0, -suffix.length));
}

export function certificateCoversGatewayHostname(
  certificate: {
    checkHost(hostname: string, options?: { subject?: 'default' | 'always' | 'never' }): string | undefined;
    checkIP(address: string): string | undefined;
  },
  hostname: string,
): boolean {
  return isIP(hostname) === 0
    ? certificate.checkHost(hostname, { subject: 'never' }) !== undefined
    : certificate.checkIP(hostname) !== undefined;
}

export function gatewayExposureRuntime(value: GatewayExposureConfig): GatewayExposureRuntime {
  return GatewayExposureRuntimeSchema.parse({
    version: 1,
    protocol: GATEWAY_EXPOSURE_PROTOCOL,
    hostname: value.hostname,
    port: value.port,
    allowedNetworks: value.allowedNetworks,
    trustedOrigins: value.trustedOrigins,
    ...(value.previewDomain ? { previewDomain: value.previewDomain } : {}),
    certificateSha256: value.tls.certificateSha256,
    privateKeySha256: value.tls.privateKeySha256,
    certificateFingerprint256: value.tls.certificateFingerprint256,
    certificateNotBefore: value.tls.certificateNotBefore,
    certificateNotAfter: value.tls.certificateNotAfter,
    ...(value.tls.clientCertificateAuthoritySha256
      ? { clientCertificateAuthoritySha256: value.tls.clientCertificateAuthoritySha256 }
      : {}),
  });
}

export function gatewayExposureRuntimeId(value: GatewayExposureRuntime): string {
  return sha256Text(JSON.stringify(GatewayExposureRuntimeSchema.parse(value)));
}

export function gatewayExposureTlsSecretMatches(
  exposure: GatewayExposureConfig | undefined,
  secret: GatewayExposureTlsSecret | undefined,
): boolean {
  if (!exposure || !secret) return exposure === undefined && secret === undefined;
  return exposure.tls.id === secret.id
    && exposure.tls.certificateSha256 === sha256Text(secret.certificateChainPem)
    && exposure.tls.privateKeySha256 === sha256Text(secret.privateKeyPem)
    && exposure.tls.clientCertificateAuthoritySha256
      === (secret.clientCertificateAuthorityPem === undefined ? undefined : sha256Text(secret.clientCertificateAuthorityPem));
}

export function assertGatewayExposureTlsSecretMatches(
  exposure: GatewayExposureConfig | undefined,
  secret: GatewayExposureTlsSecret | undefined,
): void {
  if (!gatewayExposureTlsSecretMatches(exposure, secret)) {
    throw new Error('Gateway exposure TLS secret material does not match the configured immutable digests.');
  }
}

export function sha256Text(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
