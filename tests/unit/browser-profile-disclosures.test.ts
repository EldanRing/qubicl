import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserProfileDisclosure,
  printBrowserProfileDisclosure,
  type BrowserProfileDisclosureOperation,
} from '../../packages/cli/dist/browser-profile-disclosures.js';

const operations: BrowserProfileDisclosureOperation[] = [
  'upgrade',
  'backup',
  'checkpoint',
  'clone',
  'delete',
  'restore',
  'backup-restore',
  'purge',
];

test('every relevant lifecycle action discloses durable Chromium profile handling', () => {
  for (const operation of operations) {
    const notice = browserProfileDisclosure(operation);
    assert.match(notice, /^Durable browser profile:/u);
    assert.match(notice, /\/home\/qubicl\/\.local\/share\/qubicl\/browser-profile/u);
  }
});

test('full-home copy notices name browser-state categories without claiming authentication', () => {
  for (const operation of ['backup', 'checkpoint', 'clone', 'backup-restore'] as const) {
    const notice = browserProfileDisclosure(operation);
    assert.match(notice, /cookies/u);
    assert.match(notice, /site data/u);
    assert.match(notice, /history/u);
    assert.match(notice, /preferences/u);
    assert.match(notice, /sessions/u);
    assert.doesNotMatch(notice, /stored authentication/iu);
  }
});

test('purge distinguishes destroyed home data from retained copies', () => {
  const notice = browserProfileDisclosure('purge');
  assert.match(notice, /permanently removes the entire trashed home/u);
  assert.match(notice, /backups, clones, and external copies are not removed/u);
});

test('the disclosure writer emits exactly one complete notice', () => {
  const messages: string[] = [];
  printBrowserProfileDisclosure('delete', (message) => messages.push(message));
  assert.deepEqual(messages, [browserProfileDisclosure('delete')]);
});
