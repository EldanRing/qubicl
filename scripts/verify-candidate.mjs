#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateDirectory } from './candidate-evidence.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === '--help') {
  const usage = 'Usage: node scripts/verify-candidate.mjs CANDIDATE_DIRECTORY';
  if (args[0] === '--help') {
    console.log(`${usage}\n\nFrom the clean reviewed revision, verify the manifest, checksums, exact npm/native evidence, OCI archives, v0.2 layer/package efficiency evidence, per-platform Trivy reports, privacy, and vulnerability exceptions without rebuilding, rerunning acceptance, or publishing.`);
    process.exit(0);
  }
  throw new Error(usage);
}

const result = await verifyCandidateDirectory(args[0], { root });
console.log(JSON.stringify({
  ok: true,
  directory: resolve(args[0]),
  version: result.candidate.version,
  revision: result.candidate.revision,
  target: result.candidate.host.target,
  files: result.files.length,
}, null, 2));
