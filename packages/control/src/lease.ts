import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { LeaseProofSchema } from '@qubicl/core';
import { QubiclError } from './errors.js';

export type LeaseProof = z.infer<typeof LeaseProofSchema>;

type Lease = LeaseProof & {
  expiresAt: number;
  durationMs: number;
  backgroundOnly: boolean;
  actor?: LeaseActor;
};

export type LeaseActorProtocol = 'mcp' | 'openapi' | 'open-terminal';

/** Display-only caller attribution. The label is supplied by the client and must never authorize an action. */
export interface LeaseActor {
  protocol: LeaseActorProtocol;
  untrustedLabel: string;
}

export interface LeaseSnapshot {
  epoch: string;
  generation: number;
  controller: 'none' | 'agent' | 'human';
  expiresAt?: string;
  actor?: LeaseActor;
  backgroundAgent?: true;
  fencing?: 'in_progress' | 'failed';
}

export interface LeaseRevocationReport {
  terminatedManagedProcesses: number;
}

export interface HumanTakeoverSnapshot extends LeaseSnapshot, LeaseRevocationReport {}

type LeaseRevocationHandler = (proof: LeaseProof | undefined) => LeaseRevocationReport | void | Promise<LeaseRevocationReport | void>;
type RevocationTarget = { proof: LeaseProof | undefined; invokeWithoutProof: boolean };
type LeaseWaiter = {
  durationSeconds: number;
  actor?: LeaseActor;
  resolve: (lease: LeaseProof & { expiresAt: string }) => void;
  reject: (error: QubiclError) => void;
  timer: NodeJS.Timeout;
};

export class LeaseManager {
  private _epoch = randomBytes(18).toString('base64url');
  private generation = 0;
  private lease: Lease | undefined;
  private human = false;
  private timer: NodeJS.Timeout | undefined;
  private revocation: Promise<LeaseRevocationReport> | undefined;
  private failedRevocations: RevocationTarget[] = [];
  private readonly waiters: LeaseWaiter[] = [];
  private onRevoked: LeaseRevocationHandler = () => undefined;

  get epoch(): string {
    return this._epoch;
  }

  setRevocationHandler(handler: LeaseRevocationHandler): void {
    this.onRevoked = handler;
  }

  snapshot(): LeaseSnapshot {
    this.expireIfNeeded();
    const base: LeaseSnapshot = {
      epoch: this._epoch,
      generation: this.generation,
      controller: this.human ? 'human' : this.lease && !this.lease.backgroundOnly ? 'agent' : 'none',
    };
    if (this.lease) base.expiresAt = new Date(this.lease.expiresAt).toISOString();
    if (this.lease?.actor) base.actor = { ...this.lease.actor };
    if (this.lease?.backgroundOnly) base.backgroundAgent = true;
    if (this.revocation) base.fencing = 'in_progress';
    else if (this.failedRevocations.length) base.fencing = 'failed';
    return base;
  }

  acquire(durationSeconds: number, actor?: LeaseActor): LeaseProof & { expiresAt: string } {
    this.expireIfNeeded();
    if (this.revocation) throw new QubiclError('lease_transition', 'The previous controller is still being fenced; retry shortly.', 409);
    if (this.failedRevocations.length) throw new QubiclError('lease_fencing_failed', 'The previous controller could not be fully fenced. Retry human takeover or operator recovery before acquiring control.', 409);
    if (this.lease) throw this.unavailableError();
    if (this.waiters.length) throw new QubiclError('lease_queue_active', 'Other clients are already waiting for input ownership.', 409, { category: 'ownership', queuedClients: this.waiters.length, remedy: 'retry-with-wait' });
    return this.grant(durationSeconds, actor);
  }

  acquireWaiting(durationSeconds: number, actor: LeaseActor | undefined, waitSeconds: number): Promise<LeaseProof & { expiresAt: string }> {
    this.expireIfNeeded();
    if (waitSeconds <= 0) return Promise.resolve(this.acquire(durationSeconds, actor));
    if (!this.lease && !this.revocation && !this.failedRevocations.length && !this.waiters.length) {
      return Promise.resolve(this.grant(durationSeconds, actor));
    }
    return new Promise((resolve, reject) => {
      const waiter: LeaseWaiter = {
        durationSeconds,
        ...(actor ? { actor: validateLeaseActor(actor) } : {}),
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new QubiclError('lease_wait_timeout', 'Input ownership did not become available before the requested wait ended.', 409, {
            category: 'ownership',
            ...(this.snapshot().actor ? { currentOwner: this.snapshot().actor } : {}),
            remedy: 'retry-or-use-background-task',
          }));
        }, waitSeconds * 1000),
      };
      this.waiters.push(waiter);
      this.drainWaiters();
    });
  }

  private grant(durationSeconds: number, actor?: LeaseActor): LeaseProof & { expiresAt: string } {
    this.generation += 1;
    const durationMs = durationSeconds * 1000;
    this.lease = {
      id: randomBytes(32).toString('base64url'),
      generation: this.generation,
      epoch: this._epoch,
      expiresAt: Date.now() + durationMs,
      durationMs,
      backgroundOnly: this.human,
      ...(actor ? { actor: validateLeaseActor(actor) } : {}),
    };
    this.armTimer();
    return this.publicLease(this.lease);
  }

  private unavailableError(): QubiclError {
    const snapshot = this.snapshot();
    return new QubiclError('lease_unavailable', 'This computer already has an active agent lease.', 409, {
      category: 'ownership',
      ...(snapshot.actor ? { currentOwner: snapshot.actor } : {}),
      ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt } : {}),
      queuedClients: this.waiters.length,
      remedy: 'wait-release-or-run-observation',
    });
  }

  verify(proof: LeaseProof, renewActivity = false): LeaseProof {
    this.expireIfNeeded();
    const lease = this.lease;
    if (!lease || proof.epoch !== this._epoch || proof.id !== lease.id || proof.generation !== lease.generation) {
      throw new QubiclError('stale_lease', 'The lease proof is missing, expired, preempted, or stale.', 409);
    }
    if (renewActivity) {
      lease.expiresAt = Date.now() + lease.durationMs;
      this.armTimer();
    }
    return { id: lease.id, generation: lease.generation, epoch: lease.epoch };
  }

  verifyInteractive(proof: LeaseProof): LeaseProof {
    const verified = this.verify(proof);
    if (this.human) throw new QubiclError('human_control_active', 'A human currently owns interactive input. Background work and observations remain available.', 409, {
      category: 'ownership',
      currentOwner: { protocol: 'viewer', untrustedLabel: 'Human desktop viewer' },
      remedy: 'continue-with-observation-or-retained-task',
    });
    if (this.lease?.backgroundOnly) throw new QubiclError('background_lease', 'This lease was acquired for background work during human control. Release it and acquire interactive input again.', 409, {
      category: 'ownership',
      remedy: 'release-and-reacquire-after-human-control',
    });
    return verified;
  }

  renew(proof: LeaseProof, durationSeconds: number): LeaseProof & { expiresAt: string } {
    this.verify(proof);
    const lease = this.lease!;
    lease.durationMs = durationSeconds * 1000;
    lease.expiresAt = Date.now() + lease.durationMs;
    this.armTimer();
    return this.publicLease(lease);
  }

  async release(proof: LeaseProof): Promise<void> {
    this.verify(proof);
    const revoked = this.lease;
    this.lease = undefined;
    this.generation += 1;
    this.clearTimer();
    await this.revoke(revoked);
  }

  async revokeAgentControl(): Promise<LeaseRevocationReport> {
    const revoked = this.lease;
    this.lease = undefined;
    if (revoked) this.generation += 1;
    this.clearTimer();
    return this.revoke(revoked);
  }

  async revokeAgentControlFor(proof: LeaseProof): Promise<LeaseRevocationReport> {
    const current = this.lease;
    if (current && sameProof(current, proof)) {
      this.lease = undefined;
      this.generation += 1;
      this.clearTimer();
    }
    return this.revokeExact([proof]);
  }

  async takeHumanControl(): Promise<HumanTakeoverSnapshot> {
    if (this.human) {
      if (this.revocation) await this.revocation;
      const report = this.failedRevocations.length
        ? await this.retryFailedRevocations()
        : { terminatedManagedProcesses: 0 };
      return { ...this.snapshot(), ...report };
    }
    const revoked = this.lease;
    this.lease = undefined;
    this.human = true;
    this.generation += 1;
    this.clearTimer();
    const report = await this.revoke(revoked);
    return { ...this.snapshot(), ...report };
  }

  releaseHumanControl(): LeaseSnapshot {
    if (this.human) this.generation += 1;
    this.human = false;
    this.drainWaiters();
    return this.snapshot();
  }

  async resetEpoch(): Promise<void> {
    const revoked = this.lease;
    this.lease = undefined;
    this.human = false;
    this.generation = 0;
    this._epoch = randomBytes(18).toString('base64url');
    this.clearTimer();
    // An epoch change invalidates gateway-scoped capabilities even when no
    // agent currently owns the computer. Run the revocation handler so stale
    // preview publications and viewer pointers cannot become usable again
    // after a gateway revoke/re-expose cycle.
    await this.revoke(revoked, true);
  }

  private publicLease(lease: Lease): LeaseProof & { expiresAt: string } {
    return {
      id: lease.id,
      generation: lease.generation,
      epoch: lease.epoch,
      expiresAt: new Date(lease.expiresAt).toISOString(),
    };
  }

  private expireIfNeeded(): void {
    if (!this.lease || this.lease.expiresAt > Date.now()) return;
    const expired = this.lease;
    this.lease = undefined;
    this.generation += 1;
    this.clearTimer();
    void this.revoke(expired).catch(() => undefined);
  }

  private armTimer(): void {
    this.clearTimer();
    if (!this.lease) return;
    const wait = Math.max(1, this.lease.expiresAt - Date.now() + 1);
    this.timer = setTimeout(() => this.expireIfNeeded(), wait);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private revoke(proof: LeaseProof | undefined, invokeWithoutProof = false): Promise<LeaseRevocationReport> {
    return this.enqueueRevocations([{ proof, invokeWithoutProof }]);
  }

  private revokeExact(proofs: readonly LeaseProof[]): Promise<LeaseRevocationReport> {
    return this.enqueueRevocations(proofs.map((proof) => ({ proof, invokeWithoutProof: false })));
  }

  private retryFailedRevocations(): Promise<LeaseRevocationReport> {
    return this.enqueueRevocations([]);
  }

  private enqueueRevocations(targets: readonly RevocationTarget[]): Promise<LeaseRevocationReport> {
    const previous = this.revocation ?? Promise.resolve({ terminatedManagedProcesses: 0 });
    const pending = previous.catch(() => ({ terminatedManagedProcesses: 0 })).then(async () => {
      const requested = deduplicateTargets([...this.failedRevocations, ...targets]);
      this.failedRevocations = [];
      let terminatedManagedProcesses = 0;
      let failure: unknown;
      for (const target of requested) {
        if (!target.proof && !target.invokeWithoutProof) continue;
        try {
          const report = await this.onRevoked(target.proof);
          terminatedManagedProcesses += report?.terminatedManagedProcesses ?? 0;
        } catch (error) {
          this.failedRevocations.push(target);
          failure ??= error;
        }
      }
      if (failure) throw failure;
      return { terminatedManagedProcesses };
    });
    this.revocation = pending;
    void pending.then(() => {
      if (this.revocation === pending) this.revocation = undefined;
      this.drainWaiters();
    }, () => {
      if (this.revocation === pending) this.revocation = undefined;
    });
    return pending;
  }

  private drainWaiters(): void {
    this.expireIfNeeded();
    if (this.lease || this.revocation || this.failedRevocations.length || !this.waiters.length) return;
    const waiter = this.waiters.shift()!;
    clearTimeout(waiter.timer);
    try { waiter.resolve(this.grant(waiter.durationSeconds, waiter.actor)); }
    catch (error) { waiter.reject(error instanceof QubiclError ? error : new QubiclError('lease_unavailable', 'Input ownership could not be granted.', 409)); }
  }
}

function deduplicateTargets(targets: readonly RevocationTarget[]): RevocationTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = target.proof
      ? `${target.proof.epoch}:${target.proof.generation}:${target.proof.id}`
      : target.invokeWithoutProof ? 'without-proof' : 'noop';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameProof(left: LeaseProof, right: LeaseProof): boolean {
  return left.id === right.id && left.generation === right.generation && left.epoch === right.epoch;
}

function validateLeaseActor(actor: LeaseActor): LeaseActor {
  if (!['mcp', 'openapi', 'open-terminal'].includes(actor.protocol)
    || typeof actor.untrustedLabel !== 'string'
    || actor.untrustedLabel.length < 1
    || actor.untrustedLabel.length > 120
    || [...actor.untrustedLabel].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    })) {
    throw new QubiclError('invalid_arguments', 'Lease actor attribution is invalid.', 400);
  }
  return { protocol: actor.protocol, untrustedLabel: actor.untrustedLabel };
}
