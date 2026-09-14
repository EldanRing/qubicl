import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertClientToolScope,
  clientCredentialFromFetchHeaders,
  clientCredentialFromNodeHeaders,
  scopedTools,
} from '../../packages/control/dist/client-scope.js';

test('trusted client context defaults only internal requests to full operator authority', () => {
  const operator = clientCredentialFromNodeHeaders({});
  assert.equal(operator.id, 'operator-internal');
  assert.deepEqual(operator.scopes, ['observe', 'files', 'tasks', 'interactive', 'publish']);
  assert.doesNotThrow(() => assertClientToolScope(operator, 'browser_click'));

  for (const headers of [
    { 'x-qubicl-client-id': 'monitor' },
    { 'x-qubicl-client-id': ['monitor'], 'x-qubicl-client-label': 'Monitor', 'x-qubicl-client-scopes': 'observe' },
    { 'x-qubicl-client-id': 'Bad ID', 'x-qubicl-client-label': 'Monitor', 'x-qubicl-client-scopes': 'observe' },
    { 'x-qubicl-client-id': 'monitor', 'x-qubicl-client-label': 'Monitor', 'x-qubicl-client-scopes': 'observe,observe' },
    { 'x-qubicl-client-id': 'monitor', 'x-qubicl-client-label': 'Monitor', 'x-qubicl-client-scopes': 'unknown' },
  ]) assert.throws(() => clientCredentialFromNodeHeaders(headers), /invalid client credential context|invalid client credential scopes/u);
});

test('scoped client context sanitizes labels and limits both discovery and execution', () => {
  const headers = new Headers({
    'x-qubicl-client-id': 'status-monitor',
    'x-qubicl-client-label': 'Status monitor',
    'x-qubicl-client-scopes': 'observe',
  });
  const client = clientCredentialFromFetchHeaders(headers);
  assert.deepEqual(client, { id: 'status-monitor', label: 'Status monitor', scopes: ['observe'] });
  assert.deepEqual(scopedTools(client, ['get_computer_status', 'read_file', 'browser_click']), ['get_computer_status']);
  assert.doesNotThrow(() => assertClientToolScope(client, 'get_computer_status'));
  assert.throws(
    () => assertClientToolScope(client, 'browser_click'),
    (error: { code?: unknown; status?: unknown; details?: { credentialId?: unknown } }) =>
      error.code === 'client_scope_denied' && error.status === 403 && error.details?.credentialId === 'status-monitor',
  );

  const unnamed = clientCredentialFromNodeHeaders({
    'x-qubicl-client-id': 'unnamed',
    'x-qubicl-client-label': '  \u0007  ',
    'x-qubicl-client-scopes': 'files',
  });
  assert.equal(unnamed.label, 'Unnamed client');
  assert.equal(clientCredentialFromFetchHeaders(undefined).id, 'operator-internal');
});
