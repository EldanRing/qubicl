import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'candidate-concurrency.mjs')).href;

test('candidate work is bounded to two jobs and preserves result order', async () => {
  const { LOCAL_CANDIDATE_CONCURRENCY, runWithConcurrency } = await import(moduleUrl);
  let active = 0;
  let maximum = 0;
  const results = await runWithConcurrency([0, 1, 2, 3, 4], async (value: number) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5 * (5 - value)));
    active -= 1;
    return `result-${value}`;
  });

  assert.equal(LOCAL_CANDIDATE_CONCURRENCY, 2);
  assert.equal(maximum, 2);
  assert.deepEqual(results, ['result-0', 'result-1', 'result-2', 'result-3', 'result-4']);
});

test('candidate work stops scheduling after a failure and drains active jobs', async () => {
  const { runWithConcurrency } = await import(moduleUrl);
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstFinished = false;
  let settled = false;

  const result = runWithConcurrency(['first', 'failure', 'never'], async (value: string) => {
    started.push(value);
    if (value === 'failure') throw new Error('deliberate candidate failure');
    await firstGate;
    firstFinished = true;
  }).then(
    () => undefined,
    (error: unknown) => error,
  ).finally(() => { settled = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first', 'failure']);
  assert.equal(settled, false);
  releaseFirst();
  const error = await result;
  assert.equal(firstFinished, true);
  assert.match((error as Error).message, /deliberate candidate failure/);
  assert.deepEqual(started, ['first', 'failure']);
});

test('artifact acceptance receives disjoint ports and unique Docker image namespaces', async () => {
  const { artifactAcceptanceIsolation } = await import(moduleUrl);
  const source = artifactAcceptanceIsolation('source', '/tmp/source-run');
  const npm = artifactAcceptanceIsolation('npm', '/tmp/npm-run');
  const binary = artifactAcceptanceIsolation('binary', '/tmp/binary-run');

  assert.deepEqual(
    [source.portStart, source.portEnd, npm.portStart, npm.portEnd, binary.portStart, binary.portEnd],
    [32_000, 34_666, 34_666, 37_333, 37_333, 40_000],
  );
  assert.equal(new Set([source.imageNamespace, npm.imageNamespace, binary.imageNamespace]).size, 3);
  for (const isolation of [source, npm, binary]) {
    assert.match(isolation.imageNamespace, /^qubicl\/e2e-(?:source|npm|binary)-[a-f0-9]{12}$/u);
  }
  assert.throws(() => artifactAcceptanceIsolation('unknown', '/tmp/unknown'), /source, npm, or binary/);
});

test('candidate assembly wires bounded builds and isolated serial artifact acceptance', async () => {
  const [builder, harness, e2e] = await Promise.all([
    readFile(join(process.cwd(), 'scripts', 'build-local-candidates.mjs'), 'utf8'),
    readFile(join(process.cwd(), 'scripts', 'test-artifact-e2e.mjs'), 'utf8'),
    readFile(join(process.cwd(), 'tests', 'e2e', 'run.mjs'), 'utf8'),
  ]);

  assert.match(builder, /runWithConcurrency\(imageSpecs, buildImageCandidate\)/u);
  assert.match(builder, /for \(const spec of imageSpecs\) await scanImageCandidate\(spec\)/u);
  assert.match(builder, /for \(const args of acceptanceJobs\)/u);
  assert.doesNotMatch(builder, /runWithConcurrency\(acceptanceJobs/u);
  assert.match(harness, /artifactAcceptanceIsolation\(mode, temporary\)/u);
  assert.match(e2e, /QUBICL_E2E_PORT_START/u);
  assert.match(e2e, /QUBICL_E2E_PORT_END/u);
  assert.match(e2e, /QUBICL_E2E_IMAGE_NAMESPACE/u);
  assert.doesNotMatch(e2e, /qubicl\/e2e-custom(?:-|:)*/u);
});
