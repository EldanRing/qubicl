import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { presetDefaults, type ComputerConfig, type ComputerMetadata } from '@qubicl/core';
import { auditState, findTrash, initializeState, loadState, newSecret, readMetadata, saveMetadata, saveState, statePaths } from '../../packages/cli/dist/state.js';
import { renderRuntime } from '../../packages/cli/dist/runtime.js';

function computer(id: string, name: string, deleted = false): ComputerMetadata {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    ...presetDefaults('workstation'),
    ...(deleted ? { deletedAt: new Date().toISOString() } : {}),
  };
}

test('state uses secure modes and runtime contains capability contracts but no bearer tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-state-'));
  const state = await initializeState(statePaths(root));
  const configured = computer('00000000-0000-4000-8000-000000000001', 'qubicl-1') as ComputerConfig;
  state.config.computers.push(configured);
  state.secrets.computers[configured.id] = newSecret();
  await saveMetadata(state.paths, configured);
  await saveState(state);
  await renderRuntime(state);

  for (const path of [state.paths.root, state.paths.computers, state.paths.trash, state.paths.runtime, state.paths.backups]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
  assert.equal((await stat(state.paths.config)).mode & 0o777, 0o600);
  assert.equal((await stat(state.paths.secrets)).mode & 0o777, 0o600);
  assert.equal((await stat(state.paths.routes)).mode & 0o777, 0o600);
  assert.equal((await stat(state.paths.compose)).mode & 0o777, 0o600);
  const token = state.secrets.computers[configured.id]!.token;
  const routes = await readFile(state.paths.routes, 'utf8');
  const compose = await readFile(state.paths.compose, 'utf8');
  const hostUid = process.getuid?.() ?? 1000;
  const hostGid = process.getgid?.() ?? 1000;
  assert.equal(routes.includes(token), false);
  assert.equal(compose.includes(token), false);
  assert.match(routes, /"version": 2/);
  assert.match(routes, /"capabilities"/);
  assert.match(routes, new RegExp(configured.image.manifestSha256!));
  assert.match(compose, /127\.0\.0\.1:3211:3211/);
  assert.match(compose, new RegExp(`user: ${hostUid}:${hostGid}`));
  assert.match(compose, /target: \/home/);
  assert.match(compose, /QUBICL_EXPECTED_MANIFEST_SHA256/);
  assert.match(compose, /pids_limit: 128/);
  assert.match(compose, /pids_limit: 1024/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(compose, /privileged: true/);
});

test('file-system runtime omits display and viewer routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-state-files-'));
  const state = await initializeState(statePaths(root));
  const configured: ComputerConfig = {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'files',
    createdAt: new Date().toISOString(),
    ...presetDefaults('file-system'),
  };
  state.config.computers.push(configured);
  state.secrets.computers[configured.id] = newSecret();
  await saveMetadata(state.paths, configured);
  await saveState(state);
  await renderRuntime(state);
  const routes = JSON.parse(await readFile(state.paths.routes, 'utf8')) as { routes: Array<Record<string, unknown>> };
  assert.equal(routes.routes[0]?.viewPort, undefined);
  assert.equal(routes.routes[0]?.controlViewPort, undefined);
  const compose = await readFile(state.paths.compose, 'utf8');
  assert.doesNotMatch(compose, /DISPLAY:/);
  assert.doesNotMatch(compose, /shm_size:/);
  assert.match(compose, /pids_limit: 256/);
});

test('legacy metadata is parsed into the conservative v3 contract without changing identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-metadata-v2-'));
  const path = join(root, 'metadata.yaml');
  await writeFile(path, [
    'id: 00000000-0000-4000-8000-000000000009',
    'name: imported',
    'image: example/legacy:1',
    'cpus: 3',
    'memory: 5g',
    'createdAt: 2026-08-19T12:00:00.000Z',
    '',
  ].join('\n'));
  const metadata = await readMetadata(path);
  assert.equal(metadata.id, '00000000-0000-4000-8000-000000000009');
  assert.equal(metadata.preset, 'custom');
  assert.equal(metadata.compatibility, 'workstation');
  assert.equal(metadata.image.requested, 'example/legacy:1');
  assert.equal(metadata.cpus, 3);
  assert.equal(metadata.memory, '5g');
});

test('state load and save reject mismatched config and secret IDs without a partial write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-state-id-mismatch-'));
  const state = await initializeState(statePaths(root));
  const configured = computer('00000000-0000-4000-8000-000000000041', 'configured') as ComputerConfig;
  const orphanId = '00000000-0000-4000-8000-000000000042';
  const originalConfig = await readFile(state.paths.config, 'utf8');
  const originalSecrets = await readFile(state.paths.secrets, 'utf8');
  state.config.computers.push(configured);
  state.secrets.computers[orphanId] = newSecret();

  await assert.rejects(saveState(state), /Config\/secrets computer IDs do not match/);
  assert.equal(await readFile(state.paths.config, 'utf8'), originalConfig);
  assert.equal(await readFile(state.paths.secrets, 'utf8'), originalSecrets);

  await writeFile(state.paths.config, YAML.stringify(state.config), { mode: 0o600 });
  await writeFile(state.paths.secrets, YAML.stringify(state.secrets), { mode: 0o600 });
  await assert.rejects(loadState(state.paths), /Config\/secrets computer IDs do not match/);
  await rm(root, { recursive: true, force: true });
});

test('trash lookup preserves immutable identity and detects ambiguous display names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-trash-'));
  const state = await initializeState(statePaths(root));
  const first = computer('00000000-0000-4000-8000-000000000011', 'archived', true);
  await saveMetadata(state.paths, first);
  await rename(join(state.paths.computers, first.id), join(state.paths.trash, first.id));
  assert.equal((await findTrash(state.paths, first.id)).metadata.name, 'archived');
  assert.equal((await findTrash(state.paths, 'archived')).metadata.id, first.id);

  const second = { ...first, id: '00000000-0000-4000-8000-000000000012' };
  await saveMetadata(state.paths, second);
  await rename(join(state.paths.computers, second.id), join(state.paths.trash, second.id));
  await assert.rejects(findTrash(state.paths, 'archived'), /Multiple trashed computers/);
});

test('state audit verifies active homes, metadata, secrets, and recoverable trash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-audit-ok-'));
  const state = await initializeState(statePaths(root));
  const active = computer('00000000-0000-4000-8000-000000000021', 'active') as ComputerConfig;
  state.config.computers.push(active);
  state.secrets.computers[active.id] = newSecret();
  await saveMetadata(state.paths, active);

  const trashed = computer('00000000-0000-4000-8000-000000000022', 'trashed', true);
  await saveMetadata(state.paths, trashed);
  await rename(join(state.paths.computers, trashed.id), join(state.paths.trash, trashed.id));
  await saveState(state);
  await renderRuntime(state);

  const checks = await auditState(state);
  assert.equal(checks.length > 0, true);
  assert.deepEqual(checks.filter(({ ok }) => !ok), []);
});

test('state audit reports mismatched indexes, metadata, unsafe homes, and malformed trash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-audit-bad-'));
  const state = await initializeState(statePaths(root));
  const active = computer('00000000-0000-4000-8000-000000000031', 'active') as ComputerConfig;
  state.config.computers.push(active);
  state.secrets.computers[active.id] = newSecret();
  await saveMetadata(state.paths, { ...active, name: 'wrong-name' });
  const home = join(state.paths.computers, active.id, 'home');
  await rm(home, { recursive: true });
  await symlink('/tmp', home);
  await mkdir(join(state.paths.computers, 'orphan-entry'));

  const malformedTrash = computer('00000000-0000-4000-8000-000000000032', 'trashed');
  await saveMetadata(state.paths, malformedTrash);
  await rename(join(state.paths.computers, malformedTrash.id), join(state.paths.trash, malformedTrash.id));
  await saveState(state);
  delete state.secrets.computers[active.id];
  state.secrets.computers['00000000-0000-4000-8000-000000000039'] = newSecret();

  const failed = new Map((await auditState(state)).filter(({ ok }) => !ok).map((check) => [check.check, check.detail]));
  assert.match(failed.get('state-secret-index') ?? '', /missing for IDs.*orphan IDs/);
  assert.match(failed.get('state-computer-index') ?? '', /orphan-entry/);
  assert.match(failed.get('computer-active-metadata') ?? '', /differs from config/);
  assert.match(failed.get('computer-active-home') ?? '', /not a real directory/);
  assert.match(failed.get(`trash-${malformedTrash.id}-metadata`) ?? '', /deletedAt is missing/);
});
