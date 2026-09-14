import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { classifyReleaseImpact, requiresReleaseImpact, validateReleaseImpact, verifyReleaseImpactDocument } from '../../scripts/release-impact.mjs';

const exec = promisify(execFile);

test('release impact keeps documentation narrow and fails unknown paths closed', () => {
  assert.deepEqual(classifyReleaseImpact(['docs/clients.md']).affectedArtifacts, ['source']);
  assert.deepEqual(classifyReleaseImpact(['packages/cli/README.md']).affectedArtifacts, ['source', 'npm']);
  assert.equal(classifyReleaseImpact(['packages/control/src/lease.ts']).affectedArtifacts.includes('workstation-image'), true);
  assert.equal(classifyReleaseImpact(['unexpected/new-surface.bin']).profile, 'full');
});

test('release impact validation rejects understated checks', () => {
  const plan = classifyReleaseImpact(['packages/core/src/tools.ts']);
  assert.doesNotThrow(() => validateReleaseImpact(plan));
  assert.throws(() => validateReleaseImpact({ ...plan, requiredChecks: ['types'] }), /understates/u);
});

test('release impact metadata is mandatory beginning with 0.6', () => {
  assert.equal(requiresReleaseImpact('0.5.1'), false);
  assert.equal(requiresReleaseImpact('0.6.0'), true);
  assert.equal(requiresReleaseImpact('1.0.0-rc.1'), true);
  assert.throws(() => requiresReleaseImpact('next'), /Semantic Versioning/u);
});

test('release impact verification binds the exact Git range and rejects understated files', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'qubicl-release-impact-'));
  try {
    await exec('git', ['init', '--quiet'], { cwd: repositoryRoot });
    await exec('git', ['config', 'user.name', 'Qubicl Test'], { cwd: repositoryRoot });
    await exec('git', ['config', 'user.email', 'test@qubicl.invalid'], { cwd: repositoryRoot });
    await writeFile(join(repositoryRoot, 'README.md'), '# Fixture\n');
    await writeFile(join(repositoryRoot, 'obsolete.txt'), 'remove me\n');
    await exec('git', ['add', 'README.md', 'obsolete.txt'], { cwd: repositoryRoot });
    await exec('git', ['commit', '--quiet', '-m', 'fixture base'], { cwd: repositoryRoot });
    const baseRevision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();

    await writeFile(join(repositoryRoot, 'README.md'), '# Changed fixture\n');
    await rm(join(repositoryRoot, 'obsolete.txt'));
    await exec('git', ['add', '--all'], { cwd: repositoryRoot });
    await exec('git', ['commit', '--quiet', '-m', 'fixture change'], { cwd: repositoryRoot });
    const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
    const impactPath = join(repositoryRoot, 'release-impact.json');
    await writeFile(impactPath, `${JSON.stringify({
      ...classifyReleaseImpact(['README.md', 'obsolete.txt']),
      baseRevision,
      revision,
    }, null, 2)}\n`);

    const verified = await verifyReleaseImpactDocument(impactPath, { revision, repositoryRoot });
    assert.deepEqual(verified.changedFiles, ['README.md', 'obsolete.txt']);

    const understated = {
      ...classifyReleaseImpact([]),
      baseRevision,
      revision,
    };
    await writeFile(impactPath, `${JSON.stringify(understated, null, 2)}\n`);
    await assert.rejects(verifyReleaseImpactDocument(impactPath, { revision, repositoryRoot }), /changed files do not match/u);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});
