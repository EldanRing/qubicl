import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets } from '@qubicl/core';

test('operator output recursively redacts external and internal credentials', () => {
  const token = 'qubicl_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO';
  const redacted = redactSecrets({
    token,
    nested: {
      authorization: `Bearer ${token}`,
      env: [
        `QUBICL_INTERNAL_KEY=${'x'.repeat(43)}`,
        `QUBICL_EXECUTOR_KEY=${'e'.repeat(43)}`,
        `QUBICL_SESSION_KEY=${'s'.repeat(43)}`,
        `QUBICL_BROKER_KEY=${'b'.repeat(43)}`,
        `QUBICL_WEB_KEY=${'w'.repeat(43)}`,
        `QUBICL_VIEWER_KEY=${'v'.repeat(43)}`,
        `safe=${token}`,
      ],
    },
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('x'.repeat(43)), false);
  for (const character of ['e', 's', 'b', 'w', 'v']) assert.equal(serialized.includes(character.repeat(43)), false);
  assert.match(serialized, /REDACTED/);
});
