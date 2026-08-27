#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateDirectory } from './candidate-evidence.mjs';
import { resumeFailedCandidate } from './candidate-lifecycle.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const candidatesRoot = resolve(root, 'release', 'candidates');

async function main(args) {
  const usage = 'Usage: node scripts/resume-candidate.mjs FAILED_CANDIDATE_DIRECTORY';
  if (args.length !== 1 || args[0] === '--help') {
    if (args[0] === '--help') {
      console.log(`${usage}\n\nFrom the clean reviewed revision, verify preserved failed staging and promote the unchanged bytes to the canonical candidate directory. This verification-only resume does not rebuild images, rerun Trivy, or rerun artifact acceptance.`);
      return;
    }
    throw new Error(usage);
  }
  const result = await resumeFailedCandidate(args[0], {
    candidatesRoot,
    root,
    verify: verifyCandidateDirectory,
  });
  const { candidate } = result.verified;
  console.log(JSON.stringify({
    ok: true,
    verificationOnly: result.verificationOnly,
    resumed: result.source,
    output: result.destination,
    version: candidate.version,
    revision: candidate.revision,
    target: candidate.host.target,
  }, null, 2));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main(process.argv.slice(2));
