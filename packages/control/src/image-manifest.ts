import { readFileSync } from 'node:fs';
import {
  ComputerManifestSchema,
  buildComputerManifest,
  manifestSha256,
  QUBICL_BUILD,
  type ComputerManifest,
} from '@qubicl/core';

export interface LoadedComputerManifest {
  manifest: ComputerManifest;
  sha256: string;
}

export function loadComputerManifest(path = process.env.QUBICL_MANIFEST_PATH ?? '/opt/qubicl/computer-manifest.json'): LoadedComputerManifest {
  const manifest = ComputerManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const sha256 = manifestSha256(manifest);
  const expected = process.env.QUBICL_EXPECTED_MANIFEST_SHA256;
  if (expected && expected !== sha256) {
    throw new Error(`Computer manifest mismatch: expected ${expected}, image advertises ${sha256}.`);
  }
  return { manifest, sha256 };
}

export function developmentComputerManifest(): LoadedComputerManifest {
  const manifest = buildComputerManifest('workstation', QUBICL_BUILD.version, QUBICL_BUILD.revision);
  return { manifest, sha256: manifestSha256(manifest) };
}
