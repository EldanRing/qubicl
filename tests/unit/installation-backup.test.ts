import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { create as createTar } from 'tar';
import { presetDefaults, type ComputerConfig } from '@qubicl/core';
import { encryptBackupFile } from '../../packages/cli/dist/backups.js';
import { installationCommand } from '../../packages/cli/dist/installation-backup.js';
import { inHostOperation } from '../../packages/cli/dist/operation-context.js';
import { initializeState, loadState, newSecret, readMetadata, saveMetadata, saveMetadataInDirectory, saveState, statePaths } from '../../packages/cli/dist/state.js';
import { computerContainerName, runtimeNamespace } from '../../packages/cli/dist/runtime.js';

test('installation bundle import preserves computers and secrets under a new installation identity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'qubicl-installation-bundle-'));
  const sourceRoot = join(temporary, 'source');
  const targetRoot = join(temporary, 'imported');
  const archive = join(temporary, 'installation.tar.gz');
  const bundle = join(temporary, 'installation.qbi');
  const passphrasePath = join(temporary, 'passphrase');
  const passphrase = 'correct horse battery staple';
  try {
    const state = await initializeState(statePaths(sourceRoot));
    const computer: ComputerConfig = {
      id: '00000000-0000-4000-8000-000000000777',
      name: 'portable-work',
      runtimeName: 'source-installation-portable-work',
      createdAt: '2026-09-14T12:00:00.000Z',
      ...presetDefaults('workstation'),
    };
    state.config.computers.push(computer);
    state.secrets.computers[computer.id] = newSecret();
    await saveMetadata(state.paths, computer);
    const retired = { ...computer, id: '00000000-0000-4000-8000-000000000778', name: 'retired', runtimeName: 'source-installation-retired', deletedAt: '2026-09-14T12:00:00.000Z' };
    await saveMetadataInDirectory(join(state.paths.trash, retired.id), retired);
    await writeFile(join(state.paths.computers, computer.id, 'home', 'qubicl', 'project.txt'), 'preserved\n', { mode: 0o600 });
    await rm(join(state.paths.computers, computer.id, 'home', 'qubicl', '.qubicl-owner'), { force: true });
    await symlink('project.txt', join(state.paths.computers, computer.id, 'home', 'qubicl', '.qubicl-owner'));
    await saveState(state);
    await writeFile(join(sourceRoot, 'installation-manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-09-14T12:01:00.000Z',
      sourceVersion: '0.6-state-v5',
      sourceInstallationId: state.config.installationId,
      computers: [{ id: computer.id, name: computer.name }],
      includes: ['test state'],
      excludes: ['runtime'],
    }, null, 2)}\n`, { mode: 0o600 });
    await createTar({ cwd: sourceRoot, file: archive, gzip: true, portable: true }, [
      'config.yaml', 'secrets.yaml', 'computers', 'audits', 'trash', 'backups', 'installation-manifest.json',
    ]);
    await writeFile(passphrasePath, `${passphrase}\n`, { mode: 0o600 });
    await chmod(passphrasePath, 0o600);
    await encryptBackupFile(archive, bundle, passphrase);

    await inHostOperation(sourceRoot, () => installationCommand({
      positionals: ['inspect', bundle], options: new Map([['passphrase-file', passphrasePath]]),
    }));
    await inHostOperation(sourceRoot, () => installationCommand({
      positionals: ['import', bundle], options: new Map([['target-root', targetRoot], ['passphrase-file', passphrasePath]]),
    }));

    const imported = await loadState(statePaths(targetRoot));
    assert.notEqual(imported.config.installationId, state.config.installationId);
    const importedComputer = imported.config.computers[0]!;
    assert.equal(importedComputer.runtimeName, undefined);
    assert.notEqual(computerContainerName(imported, importedComputer), computerContainerName(state, computer));
    assert.ok(computerContainerName(imported, importedComputer).startsWith(runtimeNamespace(imported.config.installationId)));
    assert.deepEqual(await readMetadata(join(imported.paths.computers, computer.id, 'metadata.yaml')), importedComputer);
    const importedRetired = await readMetadata(join(imported.paths.trash, retired.id, 'metadata.yaml'));
    assert.equal(importedRetired.runtimeName, undefined);
    assert.equal(importedRetired.deletedAt, retired.deletedAt);
    assert.notEqual(computerContainerName(imported, importedRetired), computerContainerName(state, retired));
    assert.equal((await loadState(state.paths)).config.computers[0]!.runtimeName, computer.runtimeName);
    assert.equal((await readMetadata(join(state.paths.trash, retired.id, 'metadata.yaml'))).runtimeName, retired.runtimeName);
    assert.deepEqual(imported.config.computers.map(({ id, name }) => ({ id, name })), [{ id: computer.id, name: computer.name }]);
    assert.equal(imported.secrets.computers[computer.id]?.token, state.secrets.computers[computer.id]?.token);
    assert.equal(await readFile(join(targetRoot, 'computers', computer.id, 'home', 'qubicl', 'project.txt'), 'utf8'), 'preserved\n');
    const importedMarker = join(targetRoot, 'computers', computer.id, 'home', 'qubicl', '.qubicl-owner');
    assert.equal((await lstat(importedMarker)).isSymbolicLink(), false);
    assert.match(await readFile(importedMarker, 'utf8'), /^\d+:\d+\n$/u);
    assert.equal(JSON.parse(await readFile(join(targetRoot, 'import-report.json'), 'utf8')).sourceInstallationId, state.config.installationId);

    // Repack the imported state, including its previous report, just as export
    // does. Two successive migrations must preserve the entire report chain.
    let previousRoot = targetRoot;
    let previousState = imported;
    for (let migration = 0; migration < 2; migration += 1) {
      const previousReport = await readFile(join(previousRoot, 'import-report.json'), 'utf8');
      const nextRoot = join(temporary, `reimported-${migration}`);
      const nextArchive = join(temporary, `reexport-${migration}.tar.gz`);
      const nextBundle = join(temporary, `reexport-${migration}.qbi`);
      await writeFile(join(previousRoot, 'installation-manifest.json'), JSON.stringify({
        schemaVersion: 1, createdAt: new Date().toISOString(), sourceVersion: '0.6-state-v5',
        sourceInstallationId: previousState.config.installationId,
        computers: [{ id: computer.id, name: computer.name }], includes: ['test state'], excludes: ['runtime'],
      }), { mode: 0o600 });
      await createTar({ cwd: previousRoot, file: nextArchive, gzip: true, portable: true },
        (await readdir(previousRoot)).filter((name) => name !== 'runtime'));
      await encryptBackupFile(nextArchive, nextBundle, passphrase);
      await inHostOperation(previousRoot, () => installationCommand({
        positionals: ['import', nextBundle], options: new Map([['target-root', nextRoot], ['passphrase-file', passphrasePath]]),
      }));
      const report = JSON.parse(await readFile(join(nextRoot, 'import-report.json'), 'utf8'));
      assert.equal(report.sourceInstallationId, previousState.config.installationId);
      assert.match(report.previousImportReport, /^import-report-[a-f0-9-]+\.json$/u);
      assert.equal(await readFile(join(nextRoot, report.previousImportReport), 'utf8'), previousReport);
      assert.equal((await readdir(nextRoot)).filter((name) => /^import-report-.*\.json$/u.test(name)).length, migration + 1);
      assert.equal(await readFile(join(previousRoot, 'import-report.json'), 'utf8'), previousReport);
      const nextState = await loadState(statePaths(nextRoot));
      assert.notEqual(nextState.config.installationId, previousState.config.installationId);
      assert.equal(nextState.secrets.computers[computer.id]?.token, state.secrets.computers[computer.id]?.token);
      assert.equal(await readFile(join(nextRoot, 'computers', computer.id, 'home', 'qubicl', 'project.txt'), 'utf8'), 'preserved\n');
      previousRoot = nextRoot;
      previousState = nextState;
    }

    const wrongPassphrase = join(temporary, 'wrong-passphrase');
    await writeFile(wrongPassphrase, 'wrong passphrase\n', { mode: 0o600 });
    await assert.rejects(inHostOperation(sourceRoot, () => installationCommand({
      positionals: ['inspect', bundle], options: new Map([['passphrase-file', wrongPassphrase]]),
    })), /wrong or the archive was modified/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
