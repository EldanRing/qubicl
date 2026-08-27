import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export function publicKeyFingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64url')}`;
}

export async function signEvidence(kind, payload, privateKeyPath, outputPath) {
  const privateKey = await readFile(privateKeyPath);
  const publicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' });
  const document = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    kind,
    createdAt: new Date().toISOString(),
    payload,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64'),
  };
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  return document;
}

export async function verifyEvidenceSignature(kind, payload, publicKey, signaturePath) {
  const document = JSON.parse(await readFile(signaturePath, 'utf8'));
  assert(document.schemaVersion === 1 && document.algorithm === 'Ed25519' && document.kind === kind, `Unsupported ${kind} signature document.`);
  assert(JSON.stringify(document.payload) === JSON.stringify(payload), `${kind} signature does not bind the expected payload.`);
  assert(document.publicKeyFingerprint === publicKeyFingerprint(publicKey), `${kind} signature fingerprint does not match the supplied public key.`);
  assert(verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(document.signature, 'base64')), `${kind} signature is invalid.`);
  return document;
}

function assert(condition, message) { if (!condition) throw new Error(message); }
