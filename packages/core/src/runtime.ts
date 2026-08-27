import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { NetworkPolicySchema } from './config.js';
import { CapabilityListSchema, ConfigPresetSchema, PresetSchema } from './presets.js';

export const RuntimeRouteSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  host: z.string().min(1),
  viewHost: z.string().min(1).optional(),
  controlPort: z.number().int().positive(),
  viewPort: z.number().int().positive().optional(),
  controlViewPort: z.number().int().positive().optional(),
  preset: ConfigPresetSchema,
  compatibility: PresetSchema,
  capabilities: CapabilityListSchema,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  internalKey: z.string().min(32),
  networkPolicy: NetworkPolicySchema.optional(),
});

export const RuntimeRoutesSchema = z.object({
  version: z.literal(2),
  generatedAt: z.iso.datetime(),
  routes: z.array(RuntimeRouteSchema),
});

export type RuntimeRoute = z.infer<typeof RuntimeRouteSchema>;
export type RuntimeRoutes = z.infer<typeof RuntimeRoutesSchema>;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function deriveInternalServiceKey(internalKey: string, service: 'executor' | 'session' | 'web' | 'egress-proxy' | 'egress-broker'): string {
  return createHmac('sha256', internalKey).update(`qubicl-internal-${service}-v1`).digest('base64url');
}

export function tokenMatches(token: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Host-only preview origin. `*.localhost` is loopback but is not the viewer origin. */
export function previewHostname(computerId: string): string {
  if (!/^[a-f0-9-]{36}$/u.test(computerId)) throw new Error('A canonical computer ID is required for the preview hostname.');
  return `preview-${computerId}.localhost`;
}
