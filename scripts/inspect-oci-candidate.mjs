import { basename } from 'node:path';
import { inspectOciArchive } from './oci-evidence.mjs';

const [archive, expectedVersion, expectedRevision, expectedSource, expectedPreset, expectedManifestPath] = process.argv.slice(2);

if (!archive || !expectedVersion || !expectedRevision || !expectedSource
  || Boolean(expectedPreset) !== Boolean(expectedManifestPath)) {
  throw new Error('Usage: inspect-oci-candidate.mjs ARCHIVE VERSION REVISION SOURCE [PRESET EXPECTED_MANIFEST]');
}

const result = await inspectOciArchive(archive, {
  expectedVersion,
  expectedRevision,
  expectedSource,
  expectedPreset,
  expectedManifestPath,
  requireAttestations: true,
});

console.log(JSON.stringify({
  ok: true,
  archive: basename(archive),
  version: expectedVersion,
  contract: expectedPreset ?? 'gateway',
  attestations: ['https://slsa.dev/provenance/v1', 'https://spdx.dev/Document'],
  ...result,
}, null, 2));
