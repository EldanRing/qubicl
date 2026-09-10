import { basename } from 'node:path';
import { inspectOciArchive } from './oci-evidence.mjs';

const [archive, expectedVersion, expectedRevision, expectedSource, expectedContract, expectedContractValue] = process.argv.slice(2);
const dashboard = expectedContract === 'dashboard';

if (!archive || !expectedVersion || !expectedRevision || !expectedSource
  || Boolean(expectedContract) !== Boolean(expectedContractValue)
  || (dashboard && !/^[a-f0-9]{64}$/u.test(expectedContractValue))) {
  throw new Error('Usage: inspect-oci-candidate.mjs ARCHIVE VERSION REVISION SOURCE [PRESET EXPECTED_MANIFEST | dashboard ASSET_MANIFEST_SHA256]');
}

const result = await inspectOciArchive(archive, {
  expectedVersion,
  expectedRevision,
  expectedSource,
  expectedPreset: dashboard ? undefined : expectedContract,
  expectedManifestPath: dashboard ? undefined : expectedContractValue,
  expectedDashboardAssetManifestSha256: dashboard ? expectedContractValue : undefined,
  requireAttestations: true,
});

console.log(JSON.stringify({
  ok: true,
  archive: basename(archive),
  version: expectedVersion,
  contract: expectedContract ?? 'gateway',
  attestations: ['https://slsa.dev/provenance/v1', 'https://spdx.dev/Document'],
  ...result,
}, null, 2));
