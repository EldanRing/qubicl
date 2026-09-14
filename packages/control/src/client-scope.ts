import type { IncomingHttpHeaders } from 'node:http';
import {
  ALL_CLIENT_CREDENTIAL_SCOPES,
  CLIENT_CREDENTIAL_SCOPES,
  clientScopesAllowTool,
  requiredClientScopesForTool,
  toolsAllowedForClientScopes,
  type ClientCredentialScope,
  type ToolName,
} from '@qubicl/core';
import { QubiclError } from './errors.js';

export interface ClientCredentialContext {
  id: string;
  label: string;
  scopes: readonly ClientCredentialScope[];
}

export function clientCredentialFromNodeHeaders(headers: IncomingHttpHeaders): ClientCredentialContext {
  return parseClientCredential(
    single(headers['x-qubicl-client-id']),
    single(headers['x-qubicl-client-label']),
    single(headers['x-qubicl-client-scopes']),
  );
}

export function clientCredentialFromFetchHeaders(headers: Headers | undefined): ClientCredentialContext {
  return parseClientCredential(
    headers?.get('x-qubicl-client-id') ?? undefined,
    headers?.get('x-qubicl-client-label') ?? undefined,
    headers?.get('x-qubicl-client-scopes') ?? undefined,
  );
}

export function assertClientToolScope(client: ClientCredentialContext, name: ToolName): void {
  if (clientScopesAllowTool(client.scopes, name)) return;
  const required = requiredClientScopesForTool(name);
  throw new QubiclError(
    'client_scope_denied',
    `Tool ${name} requires ${required.join(' or ')} client scope. Credential ${client.label} has ${client.scopes.join(', ')}; use a differently scoped credential or ask the computer owner to update the connection.`,
    403,
    { category: 'client-credential', credentialId: client.id, requiredScopes: required, remedy: 'use-or-create-scoped-client' },
  );
}

export function scopedTools(client: ClientCredentialContext, enabled: readonly ToolName[]): ToolName[] {
  return toolsAllowedForClientScopes(client.scopes, enabled);
}

function parseClientCredential(id: string | undefined, label: string | undefined, rawScopes: string | undefined): ClientCredentialContext {
  // Internal host/operator requests do not carry a client identity. The
  // gateway strips caller-supplied x-qubicl-* headers before adding these
  // fields to bearer-authenticated tool requests.
  if (!id && !label && !rawScopes) return { id: 'operator-internal', label: 'Qubicl operator', scopes: ALL_CLIENT_CREDENTIAL_SCOPES };
  if (!id || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(id) || !label || label.length > 120 || !rawScopes) {
    throw new QubiclError('client_context_invalid', 'The trusted gateway supplied an invalid client credential context.', 500);
  }
  const values = rawScopes.split(',');
  const scopes = CLIENT_CREDENTIAL_SCOPES.filter((scope) => values.includes(scope));
  if (!scopes.length || scopes.length !== values.length || new Set(values).size !== values.length) {
    throw new QubiclError('client_context_invalid', 'The trusted gateway supplied invalid client credential scopes.', 500);
  }
  return { id, label: safeLabel(label), scopes };
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeLabel(value: string): string {
  const normalized = [...value].map((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('').replace(/\s+/gu, ' ').trim();
  return normalized || 'Unnamed client';
}
