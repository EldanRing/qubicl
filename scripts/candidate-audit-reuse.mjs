import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// npm's advisory service can fail while the package and signature endpoints
// remain healthy. Reuse one recent audit only when the entire locked package
// graph, apart from the patched Node/npm engine declarations, is identical.
export async function checkedAuditReuse(path, { root, revision, registry, now }) {
  const original = JSON.parse(await readFile(path, 'utf8'));
  await verifyAuditReuse({ original, root, revision, registry, now });
  return { audit: original.audit, auditReuse: {
    schemaVersion: 1,
    reason: 'npm-advisory-service-timeout',
    original,
  } };
}

export async function verifyAuditReuse({ original, root, revision, registry, now }) {
  assert(original?.schemaVersion === 1 && original.source?.clean === true
    && /^[a-f0-9]{40}$/u.test(original.source.revision ?? ''),
  'Reused audit lacks clean source provenance.');
  assert(Number.isFinite(Date.parse(original.createdAt))
    && Date.parse(original.createdAt) <= Date.parse(now)
    && Date.parse(now) - Date.parse(original.createdAt) <= MAX_AGE_MS,
  'Reused audit is older than 24 hours or has an invalid time.');
  assert(original.install?.registry === registry && original.install?.command?.join(' ') === 'npm ci',
    'Reused audit came from another registry or install procedure.');
  assert(original.audit?.metadata?.vulnerabilities?.high === 0
    && original.audit?.metadata?.vulnerabilities?.critical === 0
    && original.audit?.error === undefined,
  'Reused audit is incomplete or has blocking findings.');
  await exec('git', ['merge-base', '--is-ancestor', original.source.revision, revision], { cwd: root });
  const [oldLockText, currentLockText] = await Promise.all([
    exec('git', ['show', `${original.source.revision}:package-lock.json`], { cwd: root, maxBuffer: 20_000_000 }).then(({ stdout }) => stdout),
    exec('git', ['show', `${revision}:package-lock.json`], { cwd: root, maxBuffer: 20_000_000 }).then(({ stdout }) => stdout),
  ]);
  assert(hash(oldLockText) === original.install.lockfileSha256,
    'Reused audit lockfile does not match its source revision.');
  const normalize = (text) => {
    const lock = JSON.parse(text);
    // Only engine requirements changed. Every dependency field and locked
    // package remains byte-equivalent after these two declarations are removed.
    delete lock.packages?.['']?.engines;
    delete lock.packages?.['packages/cli']?.engines;
    return JSON.stringify(lock);
  };
  assert(normalize(oldLockText) === normalize(currentLockText),
    'Reused audit package graph differs from the current lockfile.');
  return true;
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function assert(condition, message) { if (!condition) throw new Error(message); }
