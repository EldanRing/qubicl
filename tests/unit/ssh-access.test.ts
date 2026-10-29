import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { presetDefaults, type ComputerConfig, type StateTransaction } from '@qubicl/core';
import { addConfiguredComputer } from '../../packages/cli/dist/computers.js';
import { changeSshAccess, generateSshKey, quoteSshPath, sshConfig, sshKeyPaths, type SshChangeAdapter } from '../../packages/cli/dist/ssh-access.js';
import { durableRename, initializeState, loadState, saveMetadata, saveState, statePaths, type LoadedState } from '../../packages/cli/dist/state.js';
import { executeStateTransaction, inspectPendingTransaction, recoverPendingTransaction, type TransactionRuntime } from '../../packages/cli/dist/transactions.js';

const exec = promisify(execFile);
const oldPublic = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG9sZC1maXh0dXJlLWtleS1tYXRlcmlhbC1vbmx5 qubicl:fixture';
const newPublic = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG5ldy1maXh0dXJlLWtleS1tYXRlcmlhbC1vbmx5 qubicl:fixture';
const oldSsh = { enabled: true, port: 22220, publicKey: oldPublic, fingerprint: 'SHA256:old-fixture' };

async function fixture(context: { after(fn: () => Promise<void>): void }, enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'qubicl ssh paths '));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const state = await initializeState(statePaths(root));
  const computer = addConfiguredComputer(state, 'ssh-test', presetDefaults('computer'));
  if (enabled) {
    computer.ssh = { ...oldSsh };
    const directory = join(state.paths.computers, computer.id, 'ssh');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'id_ed25519'), 'old-private', { mode: 0o600 });
    await writeFile(join(directory, 'id_ed25519.pub'), oldPublic, { mode: 0o600 });
  }
  await saveMetadata(state.paths, computer);
  await saveState(state);
  return { state, computer };
}

function observation(status: 'running' | 'stopped' | 'absent', gateway = false) {
  return { status: status === 'stopped' ? 'exited' : status, group: status === 'absent' ? 'absent' as const : 'complete' as const,
    containers: status === 'absent' ? [] : [{ name: gateway ? 'gateway-test' : 'computer-test', id: (gateway ? 'a' : 'b').repeat(64),
      imageId: `sha256:${'c'.repeat(64)}` as const, status: status === 'stopped' ? 'exited' : status,
      role: gateway ? 'gateway' as const : 'computer' as const }] };
}

async function fakeKey(state: LoadedState, computer: ComputerConfig) {
  return generateSshKey(state, computer, { run: async (_command, args) => {
    if (args.includes('-lf')) return '256 SHA256:new-fixture fixture (ED25519)';
    const path = args[args.indexOf('-f') + 1]!;
    await writeFile(path, 'new-private'); await writeFile(`${path}.pub`, newPublic);
    return '';
  }, publish: durableRename });
}

function adapter(status: 'running' | 'stopped' | 'absent', gateway = status) {
  const transactions: StateTransaction[] = [];
  let ready = 0, images = 0;
  const runtimeCalls: string[] = [];
  const operations: SshChangeAdapter = {
    validate: async () => undefined,
    observeComputer: async () => observation(status), observeGateway: async () => observation(gateway, true),
    ensureImages: async () => { images++; }, generate: fakeKey,
    execute: async (paths, transaction) => {
      transactions.push(transaction);
      await executeStateTransaction(paths, transaction, { runtime: {
        ...runtime,
        startGateway: async () => { runtimeCalls.push('gateway'); },
        replaceStopped: async () => { runtimeCalls.push('replace-stopped'); },
        removeReplacement: async () => { runtimeCalls.push('remove-running'); },
        start: async () => { runtimeCalls.push('start'); },
      } });
    },
    waitReady: async () => { ready++; }, choosePort: async () => 22220,
  };
  return { operations, transactions, runtimeCalls, ready: () => ready, images: () => images };
}

const runtime: TransactionRuntime = {
  reconcileContracts: async () => undefined, validate: async () => undefined, ensureImages: async () => undefined,
  startGateway: async () => undefined, replaceStoppedGateway: async () => undefined, verifyGateway: async () => undefined,
  reconnect: async () => undefined, waitForRemoval: async () => undefined, remove: async () => undefined,
  removeReplacement: async () => undefined, replaceStopped: async () => undefined, start: async () => undefined,
  verifyToken: async () => undefined,
};

test('OpenSSH parses generated key and known-host paths containing spaces; config pins a retained host key without starting it', async (context) => {
  const { state, computer } = await fixture(context);
  const key = await generateSshKey(state, computer);
  computer.ssh = { ...key, enabled: true, port: 22220 };
  const paths = await sshKeyPaths(state, computer);
  const derived = (await exec('ssh-keygen', ['-y', '-f', paths.privateKey])).stdout.trim().split(/\s/u).slice(0, 2).join(' ');
  assert.equal(derived, key.publicKey.split(/\s/u).slice(0, 2).join(' '));
  assert.equal((await stat(paths.privateKey)).mode & 0o777, 0o600);
  const host = join(state.paths.computers, computer.id, 'home', 'qubicl', '.local', 'share', 'qubicl', 'ssh-host-keys');
  await mkdir(host, { recursive: true }); await writeFile(join(host, 'ssh_host_ed25519_key.pub'), key.publicKey);
  const file = join(state.paths.root, 'ssh config'); await writeFile(file, await sshConfig(state, computer));
  const parsed = (await exec('ssh', ['-G', '-F', file, `qubicl-${computer.name}`])).stdout;
  assert.ok(parsed.includes(`identityfile ${paths.privateKey}\n`));
  assert.ok(parsed.includes(`userknownhostsfile ${paths.knownHosts}\n`));
  assert.ok((await readFile(paths.knownHosts, 'utf8')).startsWith(`qubicl-${computer.id} ssh-ed25519 `));
  const option = (await exec('ssh', ['-G', '-F', '/dev/null', '-o', `UserKnownHostsFile=${quoteSshPath(paths.knownHosts)}`, 'localhost'])).stdout;
  assert.ok(option.includes(`userknownhostsfile ${paths.knownHosts}\n`));
});

test('key publication is a single pair-directory rename; failed publication leaves the old pair intact', async (context) => {
  const { state, computer } = await fixture(context, true);
  const before = await sshKeyPaths(state, computer);
  let publications = 0;
  await assert.rejects(generateSshKey(state, computer, {
    run: async (_command, args) => {
      if (args.includes('-lf')) return '256 SHA256:new-fixture fixture (ED25519)';
      const path = args[args.indexOf('-f') + 1]!;
      await writeFile(path, 'new-private'); await writeFile(`${path}.pub`, newPublic); return '';
    }, publish: async (source) => {
      publications++;
      assert.equal(await readFile(join(source, 'id_ed25519'), 'utf8'), 'new-private');
      assert.equal(await readFile(join(source, 'id_ed25519.pub'), 'utf8'), newPublic);
      throw new Error('injected directory rename failure');
    },
  }), /injected directory rename failure/u);
  assert.equal(publications, 1, 'there is no second public-key rename that can split an active pair');
  assert.equal(await readFile(before.privateKey, 'utf8'), 'old-private');
  assert.equal(await readFile(before.publicKey, 'utf8'), oldPublic);
  assert.equal((await readdir(dirname(before.privateKey))).some((name) => name.startsWith('.stage-')), false);
});

test('enable, rotate and disable preserve absent/stopped/running lifecycle plans and gateway state', async (context) => {
  for (const status of ['absent', 'stopped', 'running'] as const) {
    for (const action of ['enable', 'rotate', 'disable'] as const) {
      const { state, computer } = await fixture(context, action !== 'enable');
      const fake = adapter(status);
      await changeSshAccess(state, computer, action, undefined, fake.operations);
      const plan = fake.transactions[0]!.runtime;
      assert.deepEqual(plan.replaceIds, status === 'running' ? [computer.id] : []);
      assert.deepEqual(plan.replaceStoppedIds, status === 'stopped' ? [computer.id] : []);
      assert.equal(plan.startGateway, status === 'running'); assert.deepEqual(plan.startIds, []);
      assert.deepEqual(fake.runtimeCalls, status === 'absent' ? [] : status === 'stopped' ? ['replace-stopped'] : ['gateway','remove-running','start']);
      assert.equal(fake.images(), status === 'absent' ? 0 : 1);
      assert.equal(fake.ready(), status === 'running' && action !== 'disable' ? 1 : 0);
      if (status !== 'absent') assert.equal(plan.computerRuntimeBindings[computer.id]![0]!.id, 'b'.repeat(64));
    }
  }
  const { state, computer } = await fixture(context, true);
  const fake = adapter('running', 'stopped');
  await assert.rejects(changeSshAccess(state, computer, 'rotate', undefined, fake.operations), /gateway to be running/u);
  assert.deepEqual(computer.ssh, oldSsh); assert.equal(fake.transactions.length, 0);
  assert.equal(await readFile((await sshKeyPaths(state, computer)).privateKey, 'utf8'), 'old-private');
});

test('a failed durable config transaction retains coherent old/new pairs and recovery selects the committed generation', async (context) => {
  const { state, computer } = await fixture(context, true);
  const previous = await sshKeyPaths(state, computer);
  const fake = adapter('stopped');
  fake.operations.execute = (paths, transaction) => executeStateTransaction(paths, transaction, {
    runtime, checkpoint: (checkpoint) => { if (checkpoint === 'config-written') throw new Error('injected config failure'); },
  });
  await assert.rejects(changeSshAccess(state, computer, 'rotate', undefined, fake.operations), /injected config failure/u);
  const pending = await inspectPendingTransaction(state.paths);
  assert.equal(pending?.config.computers[0]?.ssh?.publicKey, newPublic);
  const stored = await loadState(state.paths); const selected = await sshKeyPaths(stored, stored.config.computers[0]!);
  assert.equal(await readFile(selected.privateKey, 'utf8'), 'new-private'); assert.equal(await readFile(selected.publicKey, 'utf8'), newPublic);
  assert.equal(await readFile(previous.privateKey, 'utf8'), 'old-private'); assert.equal(await readFile(previous.publicKey, 'utf8'), oldPublic);
  await recoverPendingTransaction(state.paths, { runtime });
  assert.equal(await inspectPendingTransaction(state.paths), undefined);
  const recovered = await loadState(state.paths);
  assert.equal((await sshKeyPaths(recovered, recovered.config.computers[0]!)).privateKey, selected.privateKey);
});

test('failure before transaction journaling keeps the prior config and key pair usable', async (context) => {
  const { state, computer } = await fixture(context, true);
  const previous = await sshKeyPaths(state, computer);
  const fake = adapter('absent');
  fake.operations.execute = async () => { throw new Error('injected journal failure'); };
  await assert.rejects(changeSshAccess(state, computer, 'rotate', undefined, fake.operations), /injected journal failure/u);
  const stored = await loadState(state.paths);
  assert.equal(stored.config.computers[0]!.ssh!.publicKey, oldPublic);
  assert.equal((await sshKeyPaths(stored, stored.config.computers[0]!)).privateKey, previous.privateKey);
  assert.equal(await readFile(previous.privateKey, 'utf8'), 'old-private');
});


test('rotation and disable can repair missing prior key files', async (context) => {
  for (const action of ['rotate', 'disable'] as const) {
    const { state, computer } = await fixture(context, true);
    const old = await sshKeyPaths(state, computer);
    await rm(old.privateKey); await rm(old.publicKey);
    await changeSshAccess(state, computer, action, undefined, adapter('absent').operations);
    const current = await loadState(state.paths);
    if (action === 'disable') assert.equal(current.config.computers[0]!.ssh, undefined);
    else assert.equal(await readFile((await sshKeyPaths(current, current.config.computers[0]!)).privateKey, 'utf8'), 'new-private');
  }
});
