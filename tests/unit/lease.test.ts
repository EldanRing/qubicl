import assert from 'node:assert/strict';
import test from 'node:test';
import { LeaseManager } from '@qubicl/control/lease';

test('leases reject stale IDs, generations, and server epochs', async () => {
  const leases = new LeaseManager();
  const first = leases.acquire(60);
  assert.equal(leases.verify(first).id, first.id);
  assert.throws(() => leases.verify({ ...first, generation: first.generation + 1 }), /stale/i);
  assert.throws(() => leases.verify({ ...first, epoch: 'different-server-epoch' }), /stale/i);
  await leases.release(first);
  assert.throws(() => leases.verify(first), /stale/i);
  const second = leases.acquire(60);
  assert.ok(second.generation > first.generation);
});

test('human takeover fences interactive input while allowing a background lease', async () => {
  const leases = new LeaseManager();
  const proof = leases.acquire(60);
  const takeover = await leases.takeHumanControl();
  assert.equal(takeover.terminatedManagedProcesses, 0);
  assert.throws(() => leases.verify(proof), /stale/i);
  const background = leases.acquire(60);
  assert.equal(leases.snapshot().backgroundAgent, true);
  assert.equal(leases.verify(background).id, background.id);
  assert.throws(() => leases.verifyInteractive(background), /human.*interactive|background/i);
  leases.releaseHumanControl();
  assert.throws(() => leases.verify(proof), /stale/i);
  assert.throws(() => leases.verifyInteractive(background), /background/i);
  await leases.release(background);
  const interactive = leases.acquire(60);
  assert.equal(leases.verifyInteractive(interactive).epoch, leases.epoch);
});

test('human takeover reports only after generic process fencing finishes', async () => {
  const leases = new LeaseManager();
  let finishRevocation!: () => void;
  const revocation = new Promise<void>((resolve) => { finishRevocation = resolve; });
  leases.setRevocationHandler(async () => {
    await revocation;
    return { terminatedManagedProcesses: 2 };
  });
  const proof = leases.acquire(60);
  let completed = false;
  const takeover = leases.takeHumanControl().then((value) => {
    completed = true;
    return value;
  });
  assert.throws(() => leases.verify(proof), /stale/i);
  assert.throws(() => leases.acquire(60), /human|fenced/i);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  finishRevocation();
  assert.equal((await takeover).terminatedManagedProcesses, 2);
});

test('failed takeover fencing remains fail-closed and can be retried', async () => {
  const leases = new LeaseManager();
  let attempts = 0;
  leases.setRevocationHandler(() => {
    attempts += 1;
    if (attempts === 1) throw new Error('termination could not be confirmed');
    return { terminatedManagedProcesses: 1 };
  });
  leases.acquire(60);
  await assert.rejects(leases.takeHumanControl(), /could not be confirmed/);
  assert.equal(leases.snapshot().fencing, 'failed');
  assert.throws(() => leases.acquire(60), /could not be fully fenced/);
  assert.equal((await leases.takeHumanControl()).terminatedManagedProcesses, 1);
  assert.equal(leases.snapshot().fencing, undefined);
  leases.releaseHumanControl();
  assert.equal(leases.acquire(60).epoch, leases.epoch);
});

test('lease expiry invokes revocation', async () => {
  const leases = new LeaseManager();
  let revoked = false;
  leases.setRevocationHandler(() => { revoked = true; });
  const proof = leases.acquire(0.01);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => leases.verify(proof), /stale/i);
  assert.equal(revoked, true);
});

test('resetting the server epoch fences old proofs and revokes their processes', async () => {
  const leases = new LeaseManager();
  const revoked: string[] = [];
  leases.setRevocationHandler((proof) => { if (proof) revoked.push(proof.id); });
  const proof = leases.acquire(60);
  const oldEpoch = leases.epoch;
  await leases.resetEpoch();
  assert.notEqual(leases.epoch, oldEpoch);
  assert.deepEqual(revoked, [proof.id]);
  assert.throws(() => leases.verify(proof), /stale/i);
  assert.equal(leases.acquire(60).generation, 1);
});

test('resetting the server epoch invokes capability revocation without an active lease', async () => {
  const leases = new LeaseManager();
  const revoked: Array<string | undefined> = [];
  leases.setRevocationHandler((proof) => {
    revoked.push(proof?.id);
  });

  await leases.resetEpoch();

  assert.deepEqual(revoked, [undefined]);
});

test('new controllers cannot acquire while the previous process group is being fenced', async () => {
  const leases = new LeaseManager();
  let finishRevocation!: () => void;
  const revocation = new Promise<void>((resolve) => { finishRevocation = resolve; });
  leases.setRevocationHandler(() => revocation);
  const proof = leases.acquire(60);
  const releasing = leases.release(proof);
  assert.throws(() => leases.acquire(60), /still being fenced/i);
  finishRevocation();
  await releasing;
  assert.equal(leases.acquire(60).epoch, leases.epoch);
});

test('late exact-owner revocation leaves a distinct current lease intact', async () => {
  const leases = new LeaseManager();
  const revoked: string[] = [];
  leases.setRevocationHandler((proof) => {
    if (proof) revoked.push(proof.id);
    return { terminatedManagedProcesses: proof ? 1 : 0 };
  });
  const original = leases.acquire(60);
  await leases.revokeAgentControl();
  const current = leases.acquire(60);

  const result = await leases.revokeAgentControlFor(original);

  assert.equal(result.terminatedManagedProcesses, 1);
  assert.deepEqual(revoked, [original.id, original.id]);
  assert.equal(leases.verify(current).id, current.id);
});

test('waiting leases are granted in FIFO order and timed-out waiters leave the queue', async () => {
  const leases = new LeaseManager();
  const first = leases.acquire(60, { protocol: 'mcp', untrustedLabel: 'first' });
  const second = leases.acquireWaiting(60, { protocol: 'openapi', untrustedLabel: 'second' }, 1);
  const third = leases.acquireWaiting(60, { protocol: 'open-terminal', untrustedLabel: 'third' }, 1);
  assert.equal(leases.snapshot().actor?.untrustedLabel, 'first');
  await leases.release(first);
  const secondProof = await second;
  assert.equal(leases.snapshot().actor?.untrustedLabel, 'second');
  await leases.release(secondProof);
  const thirdProof = await third;
  assert.equal(leases.snapshot().actor?.untrustedLabel, 'third');
  await leases.release(thirdProof);

  const held = leases.acquire(60);
  await assert.rejects(leases.acquireWaiting(60, undefined, 0.01), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'lease_wait_timeout');
    return true;
  });
  await leases.release(held);
  assert.doesNotThrow(() => leases.acquire(60));
});
