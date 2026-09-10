import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presetDefaults } from '../../packages/core/dist/index.js';
import { initializeState, newSecret, saveState, statePaths } from '../../packages/cli/dist/state.js';
import { dashboardBackups } from '../../packages/cli/dist/dashboard/metadata.js';
import { HostManagementBackend } from '../../packages/cli/dist/dashboard/application.js';

test('dashboard backup inventory distinguishes migration evidence from home archives and retains immutable source identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-dashboard-metadata-'));
  try {
    const state = await initializeState(statePaths(root));
    const source = { ...presetDefaults('file-system'), id: randomUUID(), name: 'original-name', createdAt: new Date().toISOString() };
    const id = `home-${randomUUID()}`;
    await mkdir(join(state.paths.backups, id), { mode: 0o700 });
    await writeFile(join(state.paths.backups, id, 'manifest.json'), JSON.stringify({ version: 1, id, name: source.name, createdAt: source.createdAt, source, encrypted: false, consistency: 'stopped', sha256: 'a'.repeat(64) }), { mode: 0o600 });
    await mkdir(join(state.paths.backups, `2026-09-07T000000-000Z-v3-to-v4-${randomUUID()}`), { mode: 0o700 });
    const listed = await dashboardBackups(root);
    assert.equal(listed.length, 1); assert.equal(listed[0]!.sourceId, source.id);
    assert.equal(Object.hasOwn(listed[0]!, 'source'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dashboard credential metadata omits values, provider references and embedded URL authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-dashboard-scope-'));
  try {
    const state = await initializeState(statePaths(root));
    const computer = { ...presetDefaults('file-system'), id: randomUUID(), name: 'scope-test', createdAt: new Date().toISOString() };
    state.config.computers.push(computer);
    state.secrets.computers[computer.id] = { ...newSecret(), brokerCredentials: [{ id: 'example', baseUrl: 'https://private-user:private-password@example.com/api?private-query=value', pathPrefix: '/', methods: ['GET'], header: 'Authorization', provider: { type: 'direct', value: 'private-credential-value' } }] };
    await saveState(state);
    const value = await new HostManagementBackend(root).query(`computers/${computer.id}/credentials`, new URLSearchParams());
    const serialized = JSON.stringify(value);
    assert.doesNotMatch(serialized, /private-|provider|internalKey|token/);
    assert.match(serialized, /https:\/\/example.com\/api/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
