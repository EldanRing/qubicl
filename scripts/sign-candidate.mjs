#!/usr/bin/env node
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateDirectory } from './candidate-evidence.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
async function main([action, ...args]) {
if (action === 'keygen') {
  if (args.length !== 1) throw new Error('Usage: node scripts/sign-candidate.mjs keygen OUTPUT_PREFIX');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePath = `${resolve(args[0])}.private.pem`; const publicPath = `${resolve(args[0])}.public.pem`;
  await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
  } catch (error) {
    await rm(privatePath, { force: true });
    throw error;
  }
  await chmod(privatePath, 0o600);
  console.log(JSON.stringify({ privateKey: privatePath, publicKey: publicPath, fingerprint: fingerprint(await readFile(publicPath)) }, null, 2));
} else if (action === 'sign') {
  if (args.length !== 3) throw new Error('Usage: node scripts/sign-candidate.mjs sign CANDIDATE_DIRECTORY PRIVATE_KEY SIGNATURE_OUTPUT');
  const directory = resolve(args[0]); const privateKey = await readFile(resolve(args[1]));
  const result = await verifyCandidateDirectory(directory, { root });
  const publicKey = await import('node:crypto').then(({ createPrivateKey, createPublicKey }) => createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' }));
  const payload = await candidatePayload(directory, result.candidate);
  const document = {
    schemaVersion: 1, algorithm: 'Ed25519', createdAt: new Date().toISOString(),
    candidate: payload, publicKeyFingerprint: fingerprint(publicKey),
    signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64'),
  };
  await writeFile(resolve(args[2]), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  console.log(JSON.stringify({ ok: true, signature: resolve(args[2]), fingerprint: document.publicKeyFingerprint, candidate: payload }, null, 2));
} else if (action === 'verify') {
  if (args.length !== 3) throw new Error('Usage: node scripts/sign-candidate.mjs verify CANDIDATE_DIRECTORY PUBLIC_KEY SIGNATURE');
  const directory = resolve(args[0]); const publicKey = await readFile(resolve(args[1]));
  const result = await verifyCandidateDirectory(directory, { root });
  const document = await verifyCandidateSignature(directory, result.candidate, publicKey, resolve(args[2]));
  console.log(JSON.stringify({ ok: true, fingerprint: document.publicKeyFingerprint, candidate: document.candidate }, null, 2));
} else {
  console.log('Usage:\n  node scripts/sign-candidate.mjs keygen OUTPUT_PREFIX\n  node scripts/sign-candidate.mjs sign CANDIDATE PRIVATE_KEY SIGNATURE\n  node scripts/sign-candidate.mjs verify CANDIDATE PUBLIC_KEY SIGNATURE');
  if (action !== '--help') process.exitCode = 1;
}
}

async function candidatePayload(directory, candidate) {
  return {
    version: candidate.version, revision: candidate.revision, source: candidate.source,
    candidateJsonSha256: await sha256File(`${directory}/candidate.json`),
    checksumsSha256: await sha256File(`${directory}/SHA256SUMS`),
  };
}

export async function verifyCandidateSignature(directory, candidate, publicKey, signaturePath) {
  const document = JSON.parse(await readFile(signaturePath, 'utf8'));
  const payload = await candidatePayload(directory, candidate);
  if (document.schemaVersion !== 1 || document.algorithm !== 'Ed25519' || JSON.stringify(document.candidate) !== JSON.stringify(payload)) throw new Error('Signature document does not bind this exact candidate.');
  if (document.publicKeyFingerprint !== fingerprint(publicKey)) throw new Error('Signature public-key fingerprint does not match.');
  if (!verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(document.signature, 'base64'))) throw new Error('Candidate signature is invalid.');
  return document;
}

async function sha256File(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
function fingerprint(key) { return `SHA256:${createHash('sha256').update(key).digest('base64url')}`; }

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main(process.argv.slice(2));
