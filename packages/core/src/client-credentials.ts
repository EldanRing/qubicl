import { z } from 'zod';

export const CLIENT_CREDENTIAL_SCOPES = ['observe', 'files', 'tasks', 'interactive', 'publish'] as const;
export const ClientCredentialScopeSchema = z.enum(CLIENT_CREDENTIAL_SCOPES);
export type ClientCredentialScope = z.infer<typeof ClientCredentialScopeSchema>;

export const ALL_CLIENT_CREDENTIAL_SCOPES: readonly ClientCredentialScope[] = [...CLIENT_CREDENTIAL_SCOPES];

export const ClientCredentialIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/u);
export const ClientCredentialSchema = z.strictObject({
  id: ClientCredentialIdSchema,
  label: z.string().trim().min(1).max(120),
  token: z.string().min(32),
  scopes: z.array(ClientCredentialScopeSchema).min(1).max(CLIENT_CREDENTIAL_SCOPES.length).superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) context.addIssue({ code: 'custom', message: 'client credential scopes must be unique' });
  }),
  createdAt: z.iso.datetime(),
});
export type ClientCredential = z.infer<typeof ClientCredentialSchema>;

export const RuntimeClientCredentialSchema = ClientCredentialSchema.omit({ token: true }).extend({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type RuntimeClientCredential = z.infer<typeof RuntimeClientCredentialSchema>;

export function normalizeClientCredentialScopes(scopes: readonly ClientCredentialScope[]): ClientCredentialScope[] {
  const selected = new Set(scopes);
  return CLIENT_CREDENTIAL_SCOPES.filter((scope) => selected.has(scope));
}
