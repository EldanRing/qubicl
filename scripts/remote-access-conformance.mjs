import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exactClientVersion } from './client-conformance.mjs';

export const REMOTE_ACCESS_REQUIREMENTS_NAME = 'remote-access-v1.json';
export const REMOTE_ACCESS_REQUIREMENTS_PATH = resolve(
  fileURLToPath(new URL(`../conformance/${REMOTE_ACCESS_REQUIREMENTS_NAME}`, import.meta.url)),
);

const REQUIRED_CLIENT_VERSION_FIELDS = ['mcpHttp', 'openapi', 'openTerminal', 'browser'];
const REQUIRED_SURFACES = [
  'mcp-http',
  'openapi',
  'open-terminal',
  'viewer-static',
  'viewer-websocket',
  'preview-http',
  'preview-websocket',
];
const REQUIRED_CHECKS = [
  'tlsOnlyPassed',
  'certificateIdentityPassed',
  'hostAndSniPassed',
  'exactDockerPublicationPassed',
  'clientNetworkAllowPassed',
  'clientNetworkDenyPassed',
  'forwardedHeadersIgnored',
  'crossComputerBearerRejected',
  'trustedOriginPassed',
  'untrustedOriginRejected',
  'operatorRoutesRejected',
  'clientCertificatePassed',
  'localLoopbackPreserved',
  'runningGatewayLifecyclePassed',
  'stoppedGatewayLifecyclePassed',
  'revokePassed',
  'statusDoctorPassed',
  'durableDataPreserved',
];
const profile = (id, platformId, networkPath, clientPath, allowedPeerAddressBehaviors) => ({
  id,
  platformId,
  networkPath,
  clientPath,
  allowedPeerAddressBehaviors,
});
const EXPECTED_REQUIREMENTS = {
  schemaVersion: 1,
  id: 'qubicl-remote-access',
  acceptanceSchemaVersion: 4,
  protocol: 'direct-tls-v1',
  requiredPreset: 'workstation',
  requiredClientVersionFields: REQUIRED_CLIENT_VERSION_FIELDS,
  requiredSurfaces: REQUIRED_SURFACES,
  requiredChecks: REQUIRED_CHECKS,
  profiles: [
    profile('linux-x64-direct', 'linux-x64', 'native-docker', 'external-lan-client', ['direct']),
    profile(
      'macos-apple-silicon-docker-desktop',
      'macos-apple-silicon',
      'docker-desktop',
      'external-lan-client-through-docker-desktop',
      ['direct', 'nat-translated'],
    ),
    profile(
      'windows-wsl2-x64-docker-desktop',
      'windows-wsl2-x64',
      'wsl2-docker-desktop',
      'windows-host-through-wsl2-docker-desktop',
      ['direct', 'nat-translated'],
    ),
  ],
};

export async function loadRemoteAccessRequirements(path = REMOTE_ACCESS_REQUIREMENTS_PATH) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  assertRemoteAccessRequirements(document);
  return document;
}

export function assertRemoteAccessRequirements(document) {
  assert(canonicalJson(document) === canonicalJson(EXPECTED_REQUIREMENTS),
    'Remote-access requirements do not match the supported version-1 contract.');
  return document;
}

export async function validateRemoteAccessConformance(evidence, requirements, validateResult, selection = {}) {
  assert(evidence?.remoteAccessConformance?.schemaVersion === 1,
    'Acceptance schema 4 requires remote-access conformance schemaVersion 1.');
  const profiles = selectedRemoteProfiles(requirements.profiles, selection.profiles);
  const rows = evidence.remoteAccess;
  assert(Array.isArray(rows) && rows.length === profiles.length,
    `Remote-access conformance requires exactly ${profiles.length} profile rows.`);
  let surfaces = 0;
  for (const requirement of profiles) {
    const matches = rows.filter((row) => row?.id === requirement.id);
    assert(matches.length === 1, `Expected exactly one remote-access row for ${requirement.id}.`);
    const row = matches[0];
    await validateResult(row, `remote-access profile ${requirement.id}`);
    assert(row.platformId === requirement.platformId,
      `remote-access profile ${requirement.id} must use platform ${requirement.platformId}.`);
    assert(row.protocol === requirements.protocol,
      `remote-access profile ${requirement.id} must use protocol ${requirements.protocol}.`);
    assert(row.preset === requirements.requiredPreset,
      `remote-access profile ${requirement.id} must use the ${requirements.requiredPreset} preset.`);
    assert(row.networkPath === requirement.networkPath,
      `remote-access profile ${requirement.id} must record network path ${requirement.networkPath}.`);
    assert(row.clientPath === requirement.clientPath,
      `remote-access profile ${requirement.id} must record client path ${requirement.clientPath}.`);
    assert(requirement.allowedPeerAddressBehaviors.includes(row.peerAddressBehavior),
      `remote-access profile ${requirement.id} has unsupported peer-address behavior ${row.peerAddressBehavior ?? 'missing'}.`);
    assert(['ipv4', 'ipv6'].includes(row.sourceAddressFamily)
      && ['ipv4', 'ipv6'].includes(row.observedAddressFamily),
    `remote-access profile ${requirement.id} must record source and observed peer address families.`);
    assert(row.sourceAddressScope === 'non-loopback' && row.observedAddressScope === 'non-loopback',
      `remote-access profile ${requirement.id} must use non-loopback source and observed peer paths.`);
    const expectedAddressComparison = row.peerAddressBehavior === 'direct' ? 'same' : 'different';
    assert(row.peerAddressComparison === expectedAddressComparison,
      `remote-access profile ${requirement.id} must record ${expectedAddressComparison} peer-address comparison for ${row.peerAddressBehavior}.`);
    if (row.peerAddressComparison === 'same') {
      assert(row.sourceAddressFamily === row.observedAddressFamily,
        `remote-access profile ${requirement.id} cannot record the same peer across different address families.`);
    }
    assert(exactHostname(row.hostname),
      `remote-access profile ${requirement.id} must record an exact lowercase gateway hostname.`);
    assert(Number.isInteger(row.externalPort) && row.externalPort >= 1 && row.externalPort <= 65_535,
      `remote-access profile ${requirement.id} must record the external port.`);
    assert(['TLSv1.2', 'TLSv1.3'].includes(row.tlsProtocol),
      `remote-access profile ${requirement.id} must record TLSv1.2 or TLSv1.3.`);
    assert(/^sha256:[a-f0-9]{64}$/u.test(row.certificateFingerprint256 ?? ''),
      `remote-access profile ${requirement.id} must record the exact certificate SHA-256 fingerprint.`);

    const clientVersionFields = Object.keys(row.clientVersions ?? {}).sort();
    assert(canonicalJson(clientVersionFields) === canonicalJson([...requirements.requiredClientVersionFields].sort()),
      `remote-access profile ${requirement.id} must report exactly the required client versions.`);
    for (const field of requirements.requiredClientVersionFields) {
      assert(exactClientVersion(row.clientVersions[field]),
        `remote-access profile ${requirement.id} requires exact ${field} client version evidence.`);
    }
    const actualChecks = Object.keys(row.checks ?? {}).sort();
    assert(canonicalJson(actualChecks) === canonicalJson([...requirements.requiredChecks].sort()),
      `remote-access profile ${requirement.id} must report exactly the required security and lifecycle checks.`);
    for (const check of requirements.requiredChecks) {
      assert(row.checks[check] === true, `remote-access profile ${requirement.id} requires ${check}.`);
    }
    const actualSurfaces = Object.keys(row.surfaces ?? {}).sort();
    assert(canonicalJson(actualSurfaces) === canonicalJson([...requirements.requiredSurfaces].sort()),
      `remote-access profile ${requirement.id} must report exactly the required remote surfaces.`);
    for (const surface of requirements.requiredSurfaces) {
      await validateResult(row.surfaces[surface], `remote-access profile ${requirement.id} surface ${surface}`);
      surfaces += 1;
    }
  }
  return { remoteProfiles: profiles.length, remoteSurfaces: surfaces };
}

function selectedRemoteProfiles(profiles, selectedIds) {
  if (selectedIds === undefined) return profiles;
  assert(Array.isArray(selectedIds) && new Set(selectedIds).size === selectedIds.length,
    'Acceptance profile has duplicate remote-access requirements.');
  return selectedIds.map((id) => {
    const matches = profiles.filter((profile) => profile.id === id);
    assert(matches.length === 1, `Acceptance profile names unsupported remote-access profile ${id}.`);
    return matches[0];
  });
}

export function remoteAccessEvidenceReferences(evidence) {
  return (evidence.remoteAccess ?? []).flatMap((row) => [
    row?.evidence,
    ...Object.values(row?.surfaces ?? {}).map((result) => result?.evidence),
  ]);
}

function exactHostname(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value === value.toLowerCase()
    && value.length >= 3
    && value.length <= 253
    && value.split('.').every((label) => label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
