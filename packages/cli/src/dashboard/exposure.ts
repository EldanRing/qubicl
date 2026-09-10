import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { LoadedState } from '../state.js';
import type { DashboardExposure } from './runtime.js';

const privateNetworks = new BlockList();
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as const) privateNetworks.addSubnet(address, prefix, 'ipv4');
privateNetworks.addSubnet('fc00::', 7, 'ipv6');
export function privatePeer(address: string): boolean {
  address = address.replace(/^::ffff:/u, '');
  const family = isIP(address);
  return family !== 0 && privateNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
export function dashboardPeerPolicy(networks: string[]): (address: string) => boolean {
  if (!networks.length || networks.length > 32) throw new Error('Specify between one and 32 private client networks.');
  const allow = new BlockList();
  for (const network of networks) {
    const [address, prefixText, extra] = network.split('/');
    const family = isIP(address ?? '');
    const prefix = Number(prefixText);
    if (!family || extra !== undefined || !prefixText || !Number.isInteger(prefix) || prefix < 1 || prefix > (family === 4 ? 32 : 128) || !privatePeer(address!)) throw new Error('Only explicit private client CIDRs are supported.');
    // Checking privatePeer at request time prevents a broad network covering public peers.
    allow.addSubnet(address!, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return (raw) => { const address = raw.replace(/^::ffff:/u, ''); return privatePeer(address) && allow.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6'); };
}
export async function readTlsFile(path: string, privateKey: boolean): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 262144 || (privateKey && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('TLS files must be bounded regular files; private keys must be owner-only.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export function validateDashboardExposure(exposure: DashboardExposure, core?: LoadedState, hostAddresses = Object.values(networkInterfaces()).flat().flatMap((entry) => entry ? [entry.address] : []), now = Date.now()): void {
  if (!privatePeer(exposure.bind) || !hostAddresses.includes(exposure.bind)) throw new Error('Bind management to an exact private address present on this host.');
  if (!Number.isInteger(exposure.port) || exposure.port < 1024 || exposure.port > 65535) throw new Error('Choose an unprivileged TLS port.');
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(exposure.hostname) || isIP(exposure.hostname)) throw new Error('Use an exact DNS hostname for remote administration.');
  if (exposure.hostname === 'localhost' || exposure.hostname.endsWith('.localhost')) throw new Error('Remote administration needs a separate private DNS name.');
  dashboardPeerPolicy(exposure.allowNetworks);
  const certificate = new X509Certificate(exposure.certificate);
  const key = createPrivateKey(exposure.privateKey);
  const subjectAltNames = certificate.subjectAltName?.split(', ') ?? [];
  if (subjectAltNames.length !== 1 || !subjectAltNames[0]!.startsWith('DNS:') || subjectAltNames[0]!.slice(4).toLowerCase() !== exposure.hostname) {
    throw new Error('Administrator certificate must name only its exact administrator DNS identity.');
  }
  if (!certificate.checkPrivateKey(key) || !certificate.checkHost(exposure.hostname, { wildcards: false, subject: 'never' })) throw new Error('Certificate/key must match the exact administrator DNS name.');
  if (new Date(certificate.validTo).toISOString() !== exposure.expiresAt) throw new Error('Administrator certificate expiry metadata differs.');
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error('Administrator certificate is not currently valid.');
  if (sha256(exposure.certificate) !== exposure.certificateSha256 || sha256(exposure.privateKey) !== exposure.privateKeySha256) throw new Error('Administrator TLS snapshot identity changed.');
  const gateway = core?.secrets.gateway?.tls;
  if (gateway) {
    const gatewayCertificate = new X509Certificate(gateway.certificateChainPem);
    const gatewayKey = createPrivateKey(gateway.privateKeyPem);
    const keyBytes = key.export({ format: 'der', type: 'pkcs8' });
    const otherBytes = gatewayKey.export({ format: 'der', type: 'pkcs8' });
    if (gatewayCertificate.checkHost(exposure.hostname, { subject: 'never' }) || keyBytes.equals(otherBytes)
      || core?.config.gateway.exposure?.hostname === exposure.hostname
      || (core?.config.gateway.exposure?.hostname && certificate.checkHost(core.config.gateway.exposure.hostname, { subject: 'never' }))) throw new Error('Administrator and gateway require distinct DNS identities and private keys.');
  }
}
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
