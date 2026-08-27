import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  BROWSER_DOWNLOADS_CONTAINER_PATH,
  BROWSER_PROFILE_CONTAINER_PATH,
  MAX_BROWSER_PROFILE_DOMAINS,
  PROFILE_METADATA_QUERIES,
  assertNoBrowserProfileMountBoundaries,
  browserProfileCommand,
  classifyManagedRuntime,
  inspectFixedBrowserProfilePath,
  inspectManagedRuntime,
  inventoryBrowserProfile,
  normalizeStoredDomain,
  parseLinuxMountInfo,
  parseMacOsMountTable,
  readMacOsMountTable,
  removeBrowserProfileNoFollow,
  type BrowserProfileCommandDependencies,
  type BrowserProfileDockerRunner,
  type BrowserProfileInventory,
  type BrowserProfileMountTableSource,
  type MacOsMountCommandRunner,
  type ManagedRuntimeIdentity,
  type ManagedRuntimeSnapshot,
} from '../../packages/cli/dist/browser-profile.js';
import type { ParsedArgs } from '../../packages/cli/dist/args.js';
import {
  computerContainerName,
  computerEgressContainerName,
  computerExecutorContainerName,
  computerRuntimeContainerNames,
  computerSessionContainerName,
  computerSshContainerName,
  computerWebContainerName,
} from '../../packages/cli/dist/runtime.js';
import { statePaths, type LoadedState } from '../../packages/cli/dist/state.js';

const COMPUTER_ID = '11111111-1111-4111-8111-111111111111';

test('domain normalization emits host names only and rejects credential-like or malformed input', () => {
  assert.equal(normalizeStoredDomain('.Example.COM'), 'example.com');
  assert.equal(normalizeStoredDomain('https://Sub.Example.com:443/site/path?opaque=value'), 'sub.example.com');
  assert.equal(normalizeStoredDomain('https://bücher.example'), 'xn--bcher-kva.example');
  assert.equal(normalizeStoredDomain('https://user:password@example.com'), undefined);
  assert.equal(normalizeStoredDomain('user@example.com'), undefined);
  assert.equal(normalizeStoredDomain('chrome-extension://secret'), undefined);
  assert.equal(normalizeStoredDomain('example.com/path'), undefined);
});

test('metadata inventory reads only fixed domain columns, normalizes and deduplicates domains, and never exposes values', async () => {
  const fixture = await profileFixture();
  try {
    const network = join(fixture.profile, 'Default', 'Network');
    await mkdir(network, { recursive: true });
    const cookies = new DatabaseSync(join(network, 'Cookies'));
    cookies.exec('CREATE TABLE cookies (host_key TEXT, value TEXT, encrypted_value BLOB)');
    const insertCookie = cookies.prepare('INSERT INTO cookies VALUES (?, ?, ?)');
    insertCookie.run('.Example.COM', 'cookie-value-must-not-appear', Buffer.from('encrypted-cookie-must-not-appear'));
    insertCookie.run('example.com', 'another-private-value', Buffer.from('private'));
    insertCookie.run('sub.example.net', 'private', Buffer.from('private'));
    cookies.close();

    const quota = new DatabaseSync(join(fixture.profile, 'Default', 'QuotaManager'));
    quota.exec('CREATE TABLE buckets (storage_key TEXT, host TEXT, private_payload TEXT)');
    const insertBucket = quota.prepare('INSERT INTO buckets VALUES (?, ?, ?)');
    insertBucket.run('https://www.example.org/private/path', 'WWW.EXAMPLE.ORG', 'site-data-value-must-not-appear');
    quota.close();

    const inventory = await inventoryBrowserProfile(fixture.profile);
    assert.deepEqual(inventory.domains, ['example.com', 'sub.example.net', 'www.example.org']);
    assert.equal(inventory.complete, true);
    const serialized = JSON.stringify(inventory);
    assert.doesNotMatch(serialized, /cookie-value|encrypted-cookie|private-value|site-data-value/u);
    for (const query of Object.values(PROFILE_METADATA_QUERIES)) {
      assert.doesNotMatch(query, /\b(?:value|encrypted_value|private_payload)\b/iu);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('metadata inventory is bounded and reports unreadable, unknown, and unsupported metadata as incomplete', async () => {
  const fixture = await profileFixture();
  try {
    const network = join(fixture.profile, 'Default', 'Network');
    await mkdir(network, { recursive: true });
    const cookies = new DatabaseSync(join(network, 'Cookies'));
    cookies.exec('CREATE TABLE cookies (host_key TEXT, value TEXT)');
    const insert = cookies.prepare('INSERT INTO cookies VALUES (?, ?)');
    cookies.exec('BEGIN');
    for (let index = 0; index < MAX_BROWSER_PROFILE_DOMAINS + 8; index += 1) {
      insert.run(`domain-${String(index).padStart(4, '0')}.example`, `private-${index}`);
    }
    cookies.exec('COMMIT');
    cookies.close();

    await writeFile(join(fixture.profile, 'Default', 'QuotaManager'), 'not a SQLite database');
    const leveldb = join(fixture.profile, 'Default', 'Local Storage', 'leveldb');
    await mkdir(leveldb, { recursive: true });
    await writeFile(join(leveldb, 'CURRENT'), 'MANIFEST-000001\n');

    const inventory = await inventoryBrowserProfile(fixture.profile);
    assert.equal(inventory.domains.length, MAX_BROWSER_PROFILE_DOMAINS);
    assert.equal(inventory.truncated, true);
    assert.equal(inventory.complete, false);
    assert.match(inventory.warnings.join('\n'), /fixed output bound/iu);
    assert.match(inventory.warnings.join('\n'), /could not be read|unknown Chromium schema/iu);
    assert.match(inventory.warnings.join('\n'), /unsupported LevelDB/iu);
    assert.doesNotMatch(JSON.stringify(inventory), /private-/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('metadata inventory does not follow profile or metadata-parent symlinks', async () => {
  const fixture = await profileFixture();
  try {
    const outside = join(fixture.root, 'outside');
    await mkdir(outside, { recursive: true });
    const cookies = new DatabaseSync(join(outside, 'Cookies'));
    cookies.exec('CREATE TABLE cookies (host_key TEXT, value TEXT)');
    cookies.prepare('INSERT INTO cookies VALUES (?, ?)').run('outside.example', 'outside-secret');
    cookies.close();
    await mkdir(join(fixture.profile, 'Default'), { recursive: true });
    await symlink(outside, join(fixture.profile, 'Default', 'Network'));

    const inventory = await inventoryBrowserProfile(fixture.profile);
    assert.deepEqual(inventory.domains, []);
    assert.equal(inventory.complete, false);
    assert.match(inventory.warnings.join('\n'), /parent was not a real directory/iu);
    assert.doesNotMatch(JSON.stringify(inventory), /outside-secret/u);

    const linkedProfile = join(fixture.root, 'linked-profile');
    await symlink(fixture.profile, linkedProfile);
    const linkedInventory = await inventoryBrowserProfile(linkedProfile);
    assert.deepEqual(linkedInventory.domains, []);
    assert.equal(linkedInventory.complete, false);
    assert.match(linkedInventory.warnings.join('\n'), /not a real directory/iu);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('metadata inventory rejects symlinked SQLite companions before opening the database', async () => {
  const fixture = await profileFixture();
  try {
    const network = join(fixture.profile, 'Default', 'Network');
    await mkdir(network, { recursive: true });
    const cookiePath = join(network, 'Cookies');
    const cookies = new DatabaseSync(cookiePath);
    cookies.exec('CREATE TABLE cookies (host_key TEXT, value TEXT)');
    cookies.prepare('INSERT INTO cookies VALUES (?, ?)').run('must-not-be-read.example', 'cookie-secret');
    cookies.close();
    const outside = join(fixture.root, 'outside-wal');
    await writeFile(outside, 'outside companion');
    await symlink(outside, `${cookiePath}-wal`);

    const inventory = await inventoryBrowserProfile(fixture.profile);
    assert.deepEqual(inventory.domains, []);
    assert.equal(inventory.complete, false);
    assert.match(inventory.warnings.join('\n'), /SQLite companion was not a real file/iu);
    assert.doesNotMatch(JSON.stringify(inventory), /must-not-be-read|cookie-secret/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fixed-profile removal unlinks contained symlinks without touching Downloads or other non-profile files', async () => {
  const fixture = await profileFixture();
  try {
    const outside = join(fixture.userHome, 'outside.txt');
    const download = join(fixture.userHome, 'Downloads', 'keep.txt');
    await mkdir(join(fixture.userHome, 'Downloads'), { recursive: true });
    await writeFile(outside, 'outside survives');
    await writeFile(download, 'download survives');
    await writeFile(join(fixture.profile, 'history'), 'remove me');
    await symlink(outside, join(fixture.profile, 'outside-link'));

    assert.equal(await inspectFixedBrowserProfilePath(fixture.userHome, fixture.profile), 'present');
    await removeBrowserProfileNoFollow(fixture.profile, safeLinuxMountSource());
    assert.equal(await inspectFixedBrowserProfilePath(fixture.userHome, fixture.profile), 'absent');
    assert.equal(await readFile(outside, 'utf8'), 'outside survives');
    assert.equal(await readFile(download, 'utf8'), 'download survives');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('fixed-profile validation rejects substituted path components and arbitrary deletion targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-browser-profile-path-'));
  try {
    let mountProbeCalled = false;
    const rejectIfProbed: BrowserProfileMountTableSource = {
      platform: 'linux',
      linuxMountInfo: async () => {
        mountProbeCalled = true;
        throw new Error('mount probe must not run for an invalid profile path');
      },
      macOsMountTable: async () => {
        mountProbeCalled = true;
        throw new Error('mount probe must not run for an invalid profile path');
      },
    };
    const userHome = join(root, 'home', 'qubicl');
    const outside = join(root, 'outside');
    await mkdir(join(userHome), { recursive: true });
    await mkdir(join(outside, 'share', 'qubicl', 'browser-profile'), { recursive: true });
    await symlink(outside, join(userHome, '.local'));
    const profile = join(userHome, '.local', 'share', 'qubicl', 'browser-profile');
    await assert.rejects(inspectFixedBrowserProfilePath(userHome, profile), /not a real directory|symbolic link/iu);
    await assert.rejects(removeBrowserProfileNoFollow(profile, rejectIfProbed), /not a real directory|symbolic link/iu);
    assert.equal(mountProbeCalled, false);

    const arbitrary = join(root, 'unrelated');
    await mkdir(arbitrary);
    await writeFile(join(arbitrary, 'keep.txt'), 'keep');
    await assert.rejects(removeBrowserProfileNoFollow(arbitrary), /fixed managed profile/iu);
    assert.equal(await readFile(join(arbitrary, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Linux mountinfo parsing is strict, bounded, and decodes only kernel path escapes once', () => {
  const escaped = '/mnt/space\\040tab\\011line\\012slash\\134name';
  const once = '/mnt/literal\\134040';
  const parsed = parseLinuxMountInfo([
    linuxMountRecord(1, '/'),
    linuxMountRecord(2, escaped, '8:1', '/', 'shared:7 master:1'),
    linuxMountRecord(3, once),
    linuxMountRecord(4, '/run/ns/test', '0:5', 'mnt:[4026532868]'),
  ].join(''));
  assert.ok(parsed.includes('/mnt/space tab\tline\nslash\\name'));
  assert.ok(parsed.includes('/mnt/literal\\040'));
  assert.ok(parsed.includes('/run/ns/test'));

  assert.throws(() => parseLinuxMountInfo(linuxMountRecord(1, '/').replace('/ rw', '/bad\\141path rw')), /unsupported path escape/iu);
  assert.throws(() => parseLinuxMountInfo(linuxMountRecord(1, '/').trimEnd()), /truncated|malformed/iu);
  assert.throws(() => parseLinuxMountInfo(linuxMountRecord(1, '/not-root')), /root mount record/iu);
  assert.throws(
    () => parseLinuxMountInfo(`1 0 8:1 / /${'x'.repeat(65 * 1024)} rw - ext4 /dev/root rw\n`),
    /record or line bounds/iu,
  );
  assert.throws(() => parseLinuxMountInfo('1 0 malformed\n'), /malformed record/iu);
});

test('mount boundary checks reject exact, descendant, file, stacked, and same-device bind mounts but not siblings', async () => {
  const profile = '/state/computers/id/home/qubicl/.local/share/qubicl/browser-profile';
  const root = linuxMountRecord(1, '/', '8:1');
  const exact = linuxMountRecord(2, profile, '8:1', '/bind-source');
  const child = linuxMountRecord(3, `${profile}/Default`, '8:1', '/other-bind-source');
  const file = linuxMountRecord(4, `${profile}/Default/History`, '8:1', '/history-file');
  await assert.rejects(assertNoBrowserProfileMountBoundaries(profile, linuxMountSource(root + exact)), /host mount point/iu);
  await assert.rejects(assertNoBrowserProfileMountBoundaries(profile, linuxMountSource(root + child)), /host mount point/iu);
  await assert.rejects(assertNoBrowserProfileMountBoundaries(profile, linuxMountSource(root + file)), /host mount point/iu);
  await assert.rejects(
    assertNoBrowserProfileMountBoundaries(profile, linuxMountSource(root + exact + linuxMountRecord(5, profile, '8:1', '/stacked'))),
    /host mount point/iu,
  );
  await assert.doesNotReject(assertNoBrowserProfileMountBoundaries(
    profile,
    linuxMountSource(root + linuxMountRecord(6, `${profile}-old`, '8:1')),
  ));
  await assert.rejects(
    assertNoBrowserProfileMountBoundaries(profile, linuxMountSource(linuxMountRecord(1, '/elsewhere'))),
    /root mount record/iu,
  );
  await assert.rejects(assertNoBrowserProfileMountBoundaries(profile, {
    platform: 'win32',
    linuxMountInfo: async () => root,
    macOsMountTable: async () => '',
  }), /cannot establish mount boundaries/iu);
  await assert.rejects(assertNoBrowserProfileMountBoundaries(profile, {
    platform: 'linux',
    linuxMountInfo: async () => { throw new Error('mountinfo unavailable'); },
    macOsMountTable: async () => '',
  }), /mountinfo unavailable/iu);
});

test('macOS mount parsing preserves raw paths and rejects ambiguous delimiters', async () => {
  const profile = '/Users/operator/Qubicl/browser profile';
  const output = [
    '/dev/disk3s1 on / (apfs, local, journaled)',
    `/dev/disk3s2 on ${profile} (apfs, local)`,
    '/dev/disk3s3 on /Users/operator/literal\\040name (apfs, local)',
  ].join('\n') + '\n';
  const parsed = parseMacOsMountTable(output);
  assert.ok(parsed.includes(profile));
  assert.ok(parsed.includes('/Users/operator/literal\\040name'));
  await assert.rejects(assertNoBrowserProfileMountBoundaries(profile, macMountSource(output)), /host mount point/iu);
  await assert.doesNotReject(assertNoBrowserProfileMountBoundaries(
    profile,
    macMountSource('/dev/disk3s1 on / (apfs, local)\n/dev/disk3s2 on /Users/operator/sibling (apfs, local)\n'),
  ));
  assert.throws(
    () => parseMacOsMountTable('/dev/source on ambiguous on /Users/operator (apfs, local)\n'),
    /ambiguous or malformed/iu,
  );
  assert.throws(() => parseMacOsMountTable('/dev/root on / (apfs, local)'), /truncated|malformed/iu);
});

test('macOS mount command uses an absolute bounded no-shell invocation and fails closed on diagnostics or invalid UTF-8', async () => {
  let captured: { executable: string; args: readonly string[]; timeout: number; maxBuffer: number; locale: string | undefined } | undefined;
  const runner: MacOsMountCommandRunner = async (executable, args, options) => {
    captured = { executable, args, timeout: options.timeout, maxBuffer: options.maxBuffer, locale: options.env.LC_ALL };
    return { stdout: Buffer.from('/dev/root on / (apfs, local)\n'), stderr: Buffer.alloc(0) };
  };
  assert.equal(await readMacOsMountTable(runner), '/dev/root on / (apfs, local)\n');
  assert.deepEqual(captured, {
    executable: '/sbin/mount',
    args: [],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    locale: 'C',
  });
  await assert.rejects(readMacOsMountTable(async () => ({
    stdout: Buffer.from('/dev/root on / (apfs, local)\n'),
    stderr: Buffer.from('diagnostic'),
  })), /diagnostic output/iu);
  await assert.rejects(readMacOsMountTable(async () => ({
    stdout: Buffer.from([0xff]),
    stderr: Buffer.alloc(0),
  })), /valid UTF-8/iu);
});

test('mount-boundary refusal occurs before recursive mutation and preserves profile, Downloads, and outside files', async () => {
  const fixture = await profileFixture();
  try {
    const profileFile = join(fixture.profile, 'Preferences');
    const outside = join(fixture.userHome, 'outside.txt');
    const download = join(fixture.userHome, 'Downloads', 'keep.txt');
    await mkdir(join(fixture.userHome, 'Downloads'), { recursive: true });
    await writeFile(profileFile, 'profile survives');
    await writeFile(outside, 'outside survives');
    await writeFile(download, 'download survives');
    const mounts = linuxMountRecord(1, '/') + linuxMountRecord(2, fixture.profile, '8:1', '/same-device-bind');
    await assert.rejects(removeBrowserProfileNoFollow(fixture.profile, linuxMountSource(mounts)), /host mount point/iu);
    assert.equal(await readFile(profileFile, 'utf8'), 'profile survives');
    assert.equal(await readFile(outside, 'utf8'), 'outside survives');
    assert.equal(await readFile(download, 'utf8'), 'download survives');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('managed runtime classification accepts only complete stable groups', () => {
  const names = ['computer', 'computer-executor'];
  assert.deepEqual(classifyManagedRuntime(names, []), { kind: 'absent', containerNames: [], identities: [] });
  assert.deepEqual(classifyManagedRuntime(names, names.map((name) => ({ name, status: 'running' }))), {
    kind: 'running',
    containerNames: names,
    identities: [],
  });
  assert.deepEqual(classifyManagedRuntime(names, [
    { name: names[0]!, status: 'created' },
    { name: names[1]!, status: 'exited' },
  ]), { kind: 'stopped', containerNames: names, identities: [] });
  for (const status of ['paused', 'restarting', 'removing', 'dead']) {
    assert.throws(
      () => classifyManagedRuntime(names, names.map((name) => ({ name, status }))),
      /stable running or stopped/iu,
    );
  }
  assert.throws(
    () => classifyManagedRuntime(names, [{ name: names[0]!, status: 'running' }]),
    /partial or inconsistent/iu,
  );
  assert.throws(
    () => classifyManagedRuntime(names, [
      { name: names[0]!, status: 'running' },
      { name: names[1]!, status: 'exited' },
    ]),
    /partial or inconsistent/iu,
  );
});

test('managed runtime inspection verifies full immutable identity, exact roles, and complete owned topology', async (context) => {
  const state = fakeState();
  const computer = state.config.computers[0]!;
  const expectedNames = computerRuntimeContainerNames(state, computer);

  await context.test('valid owned topology', async () => {
    const snapshot = await inspectManagedRuntime(state, computer, managedDockerRunner(state));
    assert.equal(snapshot.kind, 'running');
    assert.deepEqual(snapshot.containerNames, expectedNames);
    assert.deepEqual(snapshot.identities.map(({ name }) => name), expectedNames);
    assert.ok(snapshot.identities.every(({ id }) => /^[a-f0-9]{64}$/u.test(id)));
  });

  await context.test('inventory failure', async () => {
    const runner: BrowserProfileDockerRunner = async () => {
      throw new Error('transient Docker list failure');
    };
    await assert.rejects(inspectManagedRuntime(state, computer, runner), /transient Docker list failure/iu);
  });

  await context.test('inspect failure is not treated as absence', async () => {
    let inspectAllowedFailure: boolean | undefined;
    const base = managedDockerRunner(state);
    const runner: BrowserProfileDockerRunner = async (args, options) => {
      if (args[0] === 'container') return base(args, options);
      inspectAllowedFailure = options?.allowFailure;
      throw new Error('transient Docker inspect failure');
    };
    await assert.rejects(inspectManagedRuntime(state, computer, runner), /transient Docker inspect failure/iu);
    assert.equal(inspectAllowedFailure, undefined);
  });

  await context.test('same-name unowned replacement', async () => {
    await assert.rejects(
      inspectManagedRuntime(state, computer, managedDockerRunner(state, { unownedExpected: true })),
      /not owned by Qubicl computer/iu,
    );
  });

  await context.test('extra old sidecar', async () => {
    await assert.rejects(
      inspectManagedRuntime(state, computer, managedDockerRunner(state, { extraSidecar: true })),
      /extra, duplicate, or unknown/iu,
    );
  });

  await context.test('wrong role label', async () => {
    await assert.rejects(
      inspectManagedRuntime(state, computer, managedDockerRunner(state, { wrongRole: true })),
      /unexpected ownership or role binding/iu,
    );
  });

  await context.test('same-name immutable ID replacement during inspection', async () => {
    await assert.rejects(
      inspectManagedRuntime(state, computer, managedDockerRunner(state, { replaceOnSecondInventory: true })),
      /identity changed during inspection/iu,
    );
  });
});

test('--yes runs noninteractively, previews exact scope, and restores a previously running computer', async () => {
  const harness = commandHarness({ interactive: false, runtime: 'running' });
  await browserProfileCommand(commandArgs(true), harness.dependencies);

  assert.equal(harness.questionCount(), 0);
  assert.equal(harness.runtime(), 'running');
  assert.equal(harness.profilePresent(), false);
  assert.ok(harness.events.indexOf('stop') < harness.events.indexOf('inventory'));
  assert.ok(harness.events.indexOf('remove') < harness.events.indexOf('restart'));
  const output = harness.output.join('\n');
  assert.match(output, /Domains with stored cookies\/site data:/u);
  assert.doesNotMatch(output, /stored authentication/iu);
  assert.match(output, /This Chromium profile is durable/iu);
  assert.match(output, /Cookies[\s\S]*Local storage[\s\S]*History[\s\S]*Preferences[\s\S]*Sessions/u);
  assert.match(output, new RegExp(escapeRegex(BROWSER_DOWNLOADS_CONTAINER_PATH), 'u'));
  assert.match(output, new RegExp(escapeRegex(BROWSER_PROFILE_CONTAINER_PATH), 'u'));
  assert.match(output, /backups\/checkpoints, clones, recoverable trash, and external copies/iu);
  assert.doesNotMatch(output, /cookie-secret-value/u);
});

test('typed confirmation must exactly match the computer name and cancellation restores prior runtime state', async () => {
  const canceled = commandHarness({ runtime: 'running', answer: 'Research' });
  await assert.rejects(browserProfileCommand(commandArgs(false), canceled.dependencies), /Confirmation did not match research/iu);
  assert.equal(canceled.questionCount(), 1);
  assert.equal(canceled.profilePresent(), true);
  assert.equal(canceled.runtime(), 'running');
  assert.equal(canceled.events.includes('remove'), false);
  assert.equal(canceled.events.includes('restart'), true);

  const confirmed = commandHarness({ runtime: 'stopped', answer: 'research' });
  await browserProfileCommand(commandArgs(false), confirmed.dependencies);
  assert.equal(confirmed.questionCount(), 1);
  assert.equal(confirmed.profilePresent(), false);
  assert.equal(confirmed.runtime(), 'stopped');
  assert.equal(confirmed.events.includes('stop'), false);
  assert.equal(confirmed.events.includes('restart'), false);
});

test('preview and input exceptions before deletion restore a previously running computer', async () => {
  for (const harness of [
    commandHarness({ runtime: 'running', failPreview: true }),
    commandHarness({ runtime: 'running', failQuestion: true }),
  ]) {
    await assert.rejects(
      browserProfileCommand(commandArgs(false), harness.dependencies),
      /confirmation[\s\S]*No browser profile data was removed[\s\S]*Restored research/iu,
    );
    assert.equal(harness.profilePresent(), true);
    assert.equal(harness.runtime(), 'running');
    assert.equal(harness.events.includes('remove'), false);
    assert.equal(harness.events.includes('restart'), true);
  }
});

test('real SIGINT during typed confirmation restores a previously running computer before failing', async () => {
  const moduleUrl = new URL('../../packages/cli/dist/browser-profile.js', import.meta.url).href;
  const script = `
    import { browserProfileCommand, typedBrowserProfileConfirmation } from ${JSON.stringify(moduleUrl)};
    const events = [];
    let runtime = 'running';
    let removed = false;
    process.once('SIGINT', () => process.exit(130));
    const identity = { id: '${'a'.repeat(64)}', name: 'research', role: 'computer' };
    const snapshot = () => ({ kind: runtime, containerNames: ['research'], identities: [identity] });
    const paths = { computers: '/tmp/qubicl-sigint-state/computers' };
    const state = {
      paths,
      config: { computers: [{ id: '${COMPUTER_ID}', name: 'research', capabilities: ['browser'] }] },
      secrets: { computers: {} },
    };
    const dependencies = {
      paths: () => paths,
      withStateLock: async (_paths, operation) => operation(),
      loadState: async () => state,
      validateDocker: async () => undefined,
      inspectRuntime: async () => snapshot(),
      stopRuntime: async () => { events.push('stop'); runtime = 'stopped'; },
      restartRuntime: async () => { events.push('restart'); runtime = 'running'; },
      inspectProfile: async () => 'present',
      inventoryProfile: async () => ({ domains: ['example.com'], complete: true, truncated: false, warnings: [] }),
      validateMountBoundaries: async () => undefined,
      removeProfile: async () => { events.push('remove'); removed = true; },
      question: typedBrowserProfileConfirmation,
      interactive: true,
      write: () => undefined,
    };
    try {
      await browserProfileCommand({ positionals: ['profile', 'wipe', 'research'], options: new Map() }, dependencies);
      console.log(String.fromCharCode(10) + 'RESULT ' + JSON.stringify({ ok: true, runtime, removed, events }));
    } catch (error) {
      console.log(String.fromCharCode(10) + 'RESULT ' + JSON.stringify({ ok: false, runtime, removed, events, error: error.message }));
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; });
  child.stderr.on('data', (chunk: string) => { errors += chunk; });
  await waitForText(() => output, 'Type research to permanently wipe');
  assert.equal(child.kill('SIGINT'), true);
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.equal(errors, '');
  const resultLine = output.split('\n').find((line) => line.startsWith('RESULT '));
  assert.ok(resultLine);
  const result = JSON.parse(resultLine.slice('RESULT '.length)) as {
    ok: boolean;
    runtime: string;
    removed: boolean;
    events: string[];
    error: string;
  };
  assert.equal(result.ok, false);
  assert.equal(result.runtime, 'running');
  assert.equal(result.removed, false);
  assert.deepEqual(result.events, ['stop', 'restart']);
  assert.match(result.error, /interrupted by SIGINT/iu);
  assert.match(result.error, /Restored research/iu);
});

test('stop failure prevents deletion, while deletion failure stays stopped and reports possible partial removal', async () => {
  const stopFailure = commandHarness({ runtime: 'running', failStop: true });
  await assert.rejects(browserProfileCommand(commandArgs(true), stopFailure.dependencies), /Could not stop[\s\S]*No browser profile data was removed/iu);
  assert.equal(stopFailure.profilePresent(), true);
  assert.equal(stopFailure.events.includes('remove'), false);

  const deleteFailure = commandHarness({ runtime: 'running', failRemove: true });
  await assert.rejects(browserProfileCommand(commandArgs(true), deleteFailure.dependencies), /may be partial[\s\S]*left stopped/iu);
  assert.equal(deleteFailure.runtime(), 'stopped');
  assert.equal(deleteFailure.events.includes('restart'), false);
});

test('runtime state is revalidated immediately before deletion', async () => {
  const harness = commandHarness({ runtime: 'running', runtimeAfterInventory: 'running' });
  await assert.rejects(browserProfileCommand(commandArgs(true), harness.dependencies), /validation changed before deletion/iu);
  assert.equal(harness.profilePresent(), true);
  assert.equal(harness.events.includes('remove'), false);
  assert.equal(harness.runtime(), 'running');

  const identityDrift = commandHarness({ runtime: 'running', identityAfterInventory: 'b'.repeat(64) });
  await assert.rejects(browserProfileCommand(commandArgs(true), identityDrift.dependencies), /validation changed before deletion/iu);
  assert.equal(identityDrift.profilePresent(), true);
  assert.equal(identityDrift.events.includes('remove'), false);
  assert.equal(identityDrift.runtime(), 'running');
});

test('mount preflight refusal occurs before deletion starts and restores prior runtime state', async () => {
  const harness = commandHarness({ runtime: 'running', failMountValidation: true });
  await assert.rejects(
    browserProfileCommand(commandArgs(true), harness.dependencies),
    /validation changed before deletion[\s\S]*Nothing was removed[\s\S]*Restored research/iu,
  );
  assert.equal(harness.profilePresent(), true);
  assert.equal(harness.events.includes('mount-preflight'), true);
  assert.equal(harness.events.includes('remove'), false);
  assert.equal(harness.runtime(), 'running');
});

test('restart failure distinguishes successful wipe from failed runtime recovery', async () => {
  const harness = commandHarness({ runtime: 'running', failRestart: true });
  await assert.rejects(
    browserProfileCommand(commandArgs(true), harness.dependencies),
    /profile was wiped successfully[\s\S]*could not restore[\s\S]*stopped or partial/iu,
  );
  assert.equal(harness.profilePresent(), false);
  assert.equal(harness.runtime(), 'stopped');
});

test('partial deletion failure reports an absent runtime as inactive rather than stopped', async () => {
  const harness = commandHarness({ runtime: 'absent', failRemove: true });
  await assert.rejects(browserProfileCommand(commandArgs(true), harness.dependencies), (error: Error) => {
    assert.match(error.message, /remains inactive/iu);
    assert.doesNotMatch(error.message, /left stopped/iu);
    return true;
  });
  assert.equal(harness.runtime(), 'absent');
  assert.equal(harness.events.includes('restart'), false);
});

test('absent runtime and absent profile outcomes avoid unnecessary lifecycle operations', async () => {
  const absentRuntime = commandHarness({ runtime: 'absent' });
  await browserProfileCommand(commandArgs(true), absentRuntime.dependencies);
  assert.equal(absentRuntime.profilePresent(), false);
  assert.equal(absentRuntime.runtime(), 'absent');
  assert.equal(absentRuntime.events.includes('stop'), false);
  assert.equal(absentRuntime.events.includes('restart'), false);

  const absentProfile = commandHarness({ runtime: 'running', profilePresent: false });
  await browserProfileCommand(commandArgs(true), absentProfile.dependencies);
  assert.equal(absentProfile.runtime(), 'running');
  assert.equal(absentProfile.events.includes('remove'), false);
  assert.equal(absentProfile.events.includes('restart'), true);
  assert.match(absentProfile.output.join('\n'), /No managed Chromium profile was present/iu);
});

test('command rejects noninteractive implicit confirmation, unsupported capability, and imprecise grammar before deletion', async () => {
  const implicit = commandHarness({ interactive: false });
  await assert.rejects(browserProfileCommand(commandArgs(false), implicit.dependencies), /requires --yes/iu);
  assert.deepEqual(implicit.events, []);

  const unsupported = commandHarness({ browserCapability: false });
  await assert.rejects(browserProfileCommand(commandArgs(true), unsupported.dependencies), /does not provide the browser capability/iu);
  assert.equal(unsupported.events.includes('validate-docker'), false);
  assert.equal(unsupported.events.includes('remove'), false);

  const malformed = commandHarness();
  await assert.rejects(
    browserProfileCommand({ positionals: ['profile', 'wipe'], options: new Map([['yes', true]]) }, malformed.dependencies),
    /qubicl browser profile wipe COMPUTER/iu,
  );
  assert.deepEqual(malformed.events, []);
});

async function profileFixture(): Promise<{ root: string; userHome: string; profile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-browser-profile-'));
  const userHome = join(root, 'home', 'qubicl');
  const profile = join(userHome, '.local', 'share', 'qubicl', 'browser-profile');
  await mkdir(profile, { recursive: true });
  return { root, userHome, profile };
}

function commandArgs(yes: boolean): ParsedArgs {
  return {
    positionals: ['profile', 'wipe', 'research'],
    options: yes ? new Map([['yes', true]]) : new Map(),
  };
}

interface HarnessOptions {
  runtime?: ManagedRuntimeSnapshot['kind'];
  interactive?: boolean;
  answer?: string;
  browserCapability?: boolean;
  failStop?: boolean;
  failRemove?: boolean;
  failRestart?: boolean;
  failPreview?: boolean;
  failQuestion?: boolean;
  runtimeAfterInventory?: ManagedRuntimeSnapshot['kind'];
  identityAfterInventory?: string;
  profilePresent?: boolean;
  failMountValidation?: boolean;
}

function commandHarness(options: HarnessOptions = {}): {
  dependencies: BrowserProfileCommandDependencies;
  events: string[];
  output: string[];
  runtime(): ManagedRuntimeSnapshot['kind'];
  profilePresent(): boolean;
  questionCount(): number;
} {
  const events: string[] = [];
  const output: string[] = [];
  const paths = statePaths(join(tmpdir(), 'qubicl-browser-profile-state'));
  const state = fakeState(options.browserCapability !== false, paths);
  let runtime = options.runtime ?? 'stopped';
  let profilePresent = options.profilePresent ?? true;
  let identityId = 'a'.repeat(64);
  let questionCount = 0;
  const snapshot = (): ManagedRuntimeSnapshot => ({
    kind: runtime,
    containerNames: runtime === 'absent' ? [] : ['research'],
    identities: runtime === 'absent' ? [] : [{ id: identityId, name: 'research', role: 'computer' }],
  });
  const inventory: BrowserProfileInventory = {
    domains: ['example.com'],
    complete: true,
    truncated: false,
    warnings: [],
  };
  const dependencies: BrowserProfileCommandDependencies = {
    paths: () => paths,
    withStateLock: async <T>(_paths: typeof paths, operation: () => Promise<T>): Promise<T> => {
      events.push('lock');
      return operation();
    },
    loadState: async () => {
      events.push('load-state');
      return state;
    },
    validateDocker: async () => {
      events.push('validate-docker');
    },
    inspectRuntime: async () => {
      events.push(`inspect-runtime-${runtime}`);
      return snapshot();
    },
    stopRuntime: async () => {
      events.push('stop');
      if (options.failStop) throw new Error('simulated stop failure');
      runtime = 'stopped';
    },
    restartRuntime: async () => {
      events.push('restart');
      if (options.failRestart) throw new Error('simulated restart failure');
      runtime = 'running';
    },
    inspectProfile: async () => {
      events.push('inspect-profile');
      return profilePresent ? 'present' : 'absent';
    },
    inventoryProfile: async () => {
      events.push('inventory');
      if (options.runtimeAfterInventory) runtime = options.runtimeAfterInventory;
      if (options.identityAfterInventory) identityId = options.identityAfterInventory;
      return inventory;
    },
    validateMountBoundaries: async () => {
      events.push('mount-preflight');
      if (options.failMountValidation) throw new Error('simulated mount boundary');
    },
    removeProfile: async () => {
      events.push('remove');
      if (options.failRemove) throw new Error('simulated removal failure');
      profilePresent = false;
    },
    question: async () => {
      events.push('question');
      questionCount += 1;
      if (options.failQuestion) throw new Error('simulated input abort');
      return options.answer ?? 'research';
    },
    interactive: options.interactive ?? true,
    write: (message) => {
      if (options.failPreview && message.startsWith('Browser profile wipe preview')) {
        throw new Error('simulated output failure');
      }
      output.push(message);
    },
  };
  return {
    dependencies,
    events,
    output,
    runtime: () => runtime,
    profilePresent: () => profilePresent,
    questionCount: () => questionCount,
  };
}

function fakeState(browserCapability = true, paths = statePaths(join(tmpdir(), 'qubicl-browser-profile-state'))): LoadedState {
  return {
    paths,
    config: {
      installationId: '22222222-2222-4222-8222-222222222222',
      computers: [{
        id: COMPUTER_ID,
        name: 'research',
        capabilities: browserCapability ? ['browser'] : [],
      }],
    },
    secrets: { computers: {} },
  } as unknown as LoadedState;
}

interface ManagedDockerOptions {
  unownedExpected?: boolean;
  extraSidecar?: boolean;
  wrongRole?: boolean;
  replaceOnSecondInventory?: boolean;
}

interface FakeRuntimeContainer extends ManagedRuntimeIdentity {
  primary: boolean;
  status: string;
}

function managedDockerRunner(state: LoadedState, options: ManagedDockerOptions = {}): BrowserProfileDockerRunner {
  const computer = state.config.computers[0]!;
  let inventoryRound = 0;
  let current = fakeRuntimeContainers(state, false, options);
  return async (args) => {
    if (args[0] === 'container') {
      const primaryFilter = args.includes(`label=dev.qubicl.id=${computer.id}`);
      const sidecarFilter = args.includes(`label=dev.qubicl.computer-id=${computer.id}`);
      if (primaryFilter) {
        inventoryRound += 1;
        current = fakeRuntimeContainers(state, Boolean(options.replaceOnSecondInventory && inventoryRound > 1), options);
        if (options.unownedExpected) return '';
        return current.filter(({ primary }) => primary).map(({ id }) => id).join('\n');
      }
      if (sidecarFilter) {
        if (options.unownedExpected) return '';
        return current.filter(({ primary }) => !primary).map(({ id }) => id).join('\n');
      }
      return current.map(({ id, name }) => JSON.stringify({ ID: id, Names: name })).join('\n');
    }
    if (args[0] !== 'inspect') throw new Error(`Unexpected Docker fixture command ${args.join(' ')}`);
    const id = args.at(-1)!;
    const container = current.find(({ id: candidate }) => candidate === id);
    if (!container) throw new Error(`Unknown fixture container ${id}`);
    const labels: Record<string, string> = {
      'dev.qubicl.installation': state.config.installationId,
      'dev.qubicl.role': container.role,
      [container.primary ? 'dev.qubicl.id' : 'dev.qubicl.computer-id']: computer.id,
    };
    return JSON.stringify({
      Id: container.id,
      Name: `/${container.name}`,
      State: { Status: container.status },
      Config: { Labels: labels },
    });
  };
}

function fakeRuntimeContainers(
  state: LoadedState,
  replacement: boolean,
  options: ManagedDockerOptions,
): FakeRuntimeContainer[] {
  const computer = state.config.computers[0]!;
  const primaryName = computerContainerName(state, computer);
  const roles = new Map<string, string>([
    [primaryName, 'computer'],
    [computerExecutorContainerName(state, computer), 'computer-executor'],
    [computerEgressContainerName(state, computer), 'computer-egress'],
    [computerWebContainerName(state, computer), 'computer-web'],
    [computerSessionContainerName(state, computer), 'computer-session'],
    [computerSshContainerName(state, computer), 'computer-ssh'],
  ]);
  const idCharacters = replacement ? ['1', '2', '3', '4', '5', '6'] : ['a', 'b', 'c', 'd', 'e', 'f'];
  const containers = computerRuntimeContainerNames(state, computer).map((name, index): FakeRuntimeContainer => ({
    id: idCharacters[index]!.repeat(64),
    name,
    role: roles.get(name)!,
    primary: name === primaryName,
    status: 'running',
  }));
  if (options.wrongRole && containers[1]) containers[1].role = 'computer-unknown';
  if (options.extraSidecar) {
    containers.push({
      id: '9'.repeat(64),
      name: `${primaryName}-obsolete`,
      role: 'computer-obsolete',
      primary: false,
      status: 'running',
    });
  }
  return containers;
}

function linuxMountRecord(
  id: number,
  mountPoint: string,
  device = '8:1',
  root = '/',
  optional = '',
): string {
  return `${id} ${id === 1 ? 0 : 1} ${device} ${root} ${mountPoint} rw${optional ? ` ${optional}` : ''} - ext4 /dev/root rw\n`;
}

function linuxMountSource(contents: string): BrowserProfileMountTableSource {
  return {
    platform: 'linux',
    linuxMountInfo: async () => contents,
    macOsMountTable: async () => { throw new Error('macOS probe should not run'); },
  };
}

function safeLinuxMountSource(): BrowserProfileMountTableSource {
  return linuxMountSource(linuxMountRecord(1, '/'));
}

function macMountSource(contents: string): BrowserProfileMountTableSource {
  return {
    platform: 'darwin',
    linuxMountInfo: async () => { throw new Error('Linux probe should not run'); },
    macOsMountTable: async () => contents,
  };
}

async function waitForText(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for child output ${JSON.stringify(expected)}.`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
