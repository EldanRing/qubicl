import { timingSafeEqual } from 'node:crypto';
import { LeaseProofSchema } from '@qubicl/core';
import { QubiclError } from './errors.js';
import type { LeaseManager, LeaseProof } from './lease.js';

// This control/session route uses the existing private session credential, never
// the public client token or a model-supplied attribution label.
export function verifyBrowserInputOwner(credential: unknown, expectedKey: string | undefined, owner: unknown, leases: LeaseManager): void {
  if (typeof credential !== 'string' || !expectedKey || Buffer.byteLength(credential) !== Buffer.byteLength(expectedKey)
    || !timingSafeEqual(Buffer.from(credential), Buffer.from(expectedKey))) {
    throw new QubiclError('unauthorized', 'Invalid desktop-session input credential.', 401);
  }
  const parsed = LeaseProofSchema.safeParse(owner);
  if (!parsed.success) throw new QubiclError('stale_lease', 'Browser input requires a current interactive lease proof.', 409);
  leases.verifyInteractive(parsed.data);
}

export function createBrowserInputVerifier(pointerUrl: string | undefined, key: string | undefined): (owner: LeaseProof | undefined) => Promise<void> {
  const url = pointerUrl ? new URL('/_qubicl/session/input-ownership', pointerUrl) : undefined;
  return async (owner) => {
    if (!owner) throw new QubiclError('stale_lease', 'Browser input requires a current interactive lease proof.', 409);
    if (!url || !key) throw new QubiclError('browser_ownership_unavailable', 'The browser cannot verify interactive ownership.', 503);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-qubicl-pointer-key': key },
        body: JSON.stringify(owner),
        signal: AbortSignal.timeout(2_000),
        redirect: 'error',
      });
    } catch {
      throw new QubiclError('browser_ownership_unavailable', 'The browser could not verify interactive ownership; input was stopped.', 503);
    }
    const result = await response.json().catch(() => undefined) as { authorized?: boolean; error?: { code?: string } } | undefined;
    if (response.ok && result?.authorized === true) return;
    const code = result?.error?.code;
    if (code === 'stale_lease' || code === 'human_control_active' || code === 'background_lease') {
      throw new QubiclError(code, 'Interactive browser ownership has ended; no further input will be sent.', 409);
    }
    throw new QubiclError('browser_ownership_unavailable', 'The browser could not verify interactive ownership; input was stopped.', 503);
  };
}
