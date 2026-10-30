import assert from 'node:assert/strict';
import test from 'node:test';
import { browserDisplayUrl, browserDisplayTitle } from '@qubicl/control/browser';

test('browser display URLs preserve ordinary navigation parameters and redact bearer fields', () => {
  const raw = 'https://user:pass@example.test/report?page=2&access_token=QUERY-SECRET#section?token=FRAGMENT-SECRET';
  const safe = browserDisplayUrl(raw);
  assert.equal(new URL(safe).pathname, '/report');
  assert.equal(new URL(safe).searchParams.get('page'), '2');
  assert.ok(safe.includes('#section?token='));
  for (const secret of ['user', 'pass', 'QUERY-SECRET', 'FRAGMENT-SECRET']) assert.ok(!safe.includes(secret), secret);
  assert.equal(browserDisplayUrl('https://example.test/path?q=hello%20world#heading'), 'https://example.test/path?q=hello%20world#heading');
  assert.equal(browserDisplayUrl('about:blank'), 'about:blank');
  assert.equal(browserDisplayUrl('data:text/plain,SYNTHETIC-SECRET'), 'data:[redacted]');
  const title = browserDisplayTitle(`Report QUERY-SECRET ${raw}`, raw);
  assert.ok(!title.includes('QUERY-SECRET'));
  assert.ok(!title.includes('FRAGMENT-SECRET'));
});


test('browser error text redacts repeated URL credentials and preview management tickets', () => {
  const url = 'http://preview.localhost/entry?ticket=PREVIEW-TICKET&access_token=SECRET%2FVALUE#token=FRAGMENT';
  const message = `page.goto: failed at ${url}\nCall log: navigating to "${url}"; SECRET/VALUE; SECRET%2FVALUE`;
  const redacted = browserDisplayTitle(message, '');
  assert.match(redacted, /page.goto: failed/u);
  for (const value of ['PREVIEW-TICKET', 'SECRET/VALUE', 'SECRET%2FVALUE', 'FRAGMENT']) assert.ok(!redacted.includes(value));
  assert.equal(new URL(browserDisplayUrl(url)).searchParams.get('ticket'), '[redacted]');
});
