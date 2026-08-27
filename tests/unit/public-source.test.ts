import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'public-source.mjs')).href;

test('public-source privacy scan rejects personal contact and host paths', async () => {
  const { scanPublicText } = await import(moduleUrl);
  assert.deepEqual(scanPublicText('README.md', 'hello@example.invalid /home/qubicl/project'), []);
  assert.deepEqual(scanPublicText('README.md', 'Qubicl <noreply@qubicl.local>'), []);
  assert.deepEqual(scanPublicText('SECURITY.md', 'Contact contact@qubicl.org'), []);
  assert.match(scanPublicText('SECURITY.md', `email ${['owner', 'private-domain.dev'].join('@')}`)[0] ?? '', /personal email-like/);
  assert.match(scanPublicText('log.txt', ['/', 'home', 'private-user', 'project'].join('/'))[0] ?? '', /host user path/);
  assert.match(scanPublicText('log.txt', ['private', 'pc', 'ubuntu'].join('-'))[0] ?? '', /private hostname/);
  assert.match(scanPublicText('log.txt', ['.codex', 'attachments', 'file'].join('/'))[0] ?? '', /private attachment path/);
});
