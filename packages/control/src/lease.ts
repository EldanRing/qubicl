import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { LeaseProofSchema } from '@qubicl/core';
import { QubiclError } from './errors.js';

export type LeaseProof = z.infer<typeof LeaseProofSchema>;

type Lease = LeaseProof & {
  expiresAt: number;
  durationMs: number;
};

export interface LeaseSnapshot {
  epoch: string;
  generation: number;
  controller: 'none' | 'agent' | 'human';
  expiresAt?: string;
}

export interface LeaseRevocationReport {
  terminatedManagedProcesses: number;
}

export interface HumanTakeoverSnapshot extends LeaseSnapshot, LeaseRevocationReport {}

type LeaseRevocationHandler = (proof: LeaseProof | undefined) => LeaseRevocationReport | void | Promise<LeaseRevocationReport | void>;

export class LeaseManager {
  private _epoch = randomBytes(18).toString('base64url');
  private generation = 0;
  private lease: Lease | undefined;
  private human = false;
  private timer: NodeJS.Timeout | undefined;
  private revocation: Promise<LeaseRevocationReport> | undefined;
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
      controller: this.human ? 'human' : this.lease ? 'agent' : 'none',
    };
    if (this.lease) base.expiresAt = new Date(this.lease.expiresAt).toISOString();
    return base;
  }

  acquire(durationSeconds: number): LeaseProof & { expiresAt: string } {
    this.expireIfNeeded();
    if (this.revocation) throw new QubiclError('lease_transition', 'The previous controller is still being fenced; retry shortly.', 409);
    if (this.human) throw new QubiclError('human_control_active', 'A human currently controls this computer.', 409);
    if (this.lease) throw new QubiclError('lease_unavailable', 'This computer already has an active lease.', 409);
    this.generation += 1;
    const durationMs = durationSeconds * 1000;
    this.lease = {
      id: randomBytes(32).toString('base64url'),
      generation: this.generation,
      epoch: this._epoch,
      expiresAt: Date.now() + durationMs,
      durationMs,
    };
    this.armTimer();
    return this.publicLease(this.lease);
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
    this.lease = undefined;
    if (current) this.generation += 1;
    this.clearTimer();
    const proofs = [proof];
    if (current && !sameProof(current, proof)) proofs.push(current);
    return this.revokeExact(proofs);
  }

  async takeHumanControl(): Promise<HumanTakeoverSnapshot> {
    if (this.human) {
      if (this.revocation) await this.revocation;
      return { ...this.snapshot(), terminatedManagedProcesses: 0 };
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
    const previous = this.revocation ?? Promise.resolve({ terminatedManagedProcesses: 0 });
    const pending = previous.then(async () => {
      if (proof || invokeWithoutProof) return await this.onRevoked(proof) ?? { terminatedManagedProcesses: 0 };
      return { terminatedManagedProcesses: 0 };
    });
    this.revocation = pending;
    void pending.then(() => {
      if (this.revocation === pending) this.revocation = undefined;
    }, () => undefined);
    return pending;
  }

  private revokeExact(proofs: readonly LeaseProof[]): Promise<LeaseRevocationReport> {
    const previous = this.revocation;
    const pending = (async () => {
      let failure: unknown;
      if (previous) {
        try { await previous; }
        catch (error) { failure = error; }
      }
      let terminatedManagedProcesses = 0;
      for (const proof of proofs) {
        try {
          const report = await this.onRevoked(proof);
          terminatedManagedProcesses += report?.terminatedManagedProcesses ?? 0;
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
      return { terminatedManagedProcesses };
    })();
    this.revocation = pending;
    void pending.then(() => {
      if (this.revocation === pending) this.revocation = undefined;
    }, () => undefined);
    return pending;
  }
}

function sameProof(left: LeaseProof, right: LeaseProof): boolean {
  return left.id === right.id && left.generation === right.generation && left.epoch === right.epoch;
}
