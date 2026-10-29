import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('browser startup checks workload ownership without repairing mapped data or admitting native mismatches', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-browser-owner-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const storage = join(home, '.local/share/qubicl');
  const profile = join(storage, 'browser-profile');
  const password = join(storage, 'browser-keyring-password');
  await mkdir(profile, { recursive: true });
  await mkdir(join(home, 'Downloads'));
  await writeFile(join(profile, 'preserved-session'), 'existing durable session');
  await writeFile(password, `${'A'.repeat(43)}=\n`, { mode: 0o600 });
  const entrypoint = await readFile('images/computer/entrypoint.sh', 'utf8');
  const start = entrypoint.indexOf('browser_home_ownership_error() {');
  const end = entrypoint.indexOf('\nif [[ "$runtime_role" == session', start);
  assert(start >= 0 && end > start);
  // Use the actual startup functions. Only identity-dependent OS calls are
  // substituted; filesystem checks, traversal, modes and credential validation
  // execute normally on this temporary home.
  const helpers = entrypoint.slice(start, end).replaceAll('/home/qubicl', '${fixture_home}');
  const script = `set -euo pipefail
fixture_home="$1"
workload_owner="$2"
expected_owner=1000:1000
stat() { printf '0:0\\n'; }
chown() { echo unexpected-ownership-repair >&2; exit 97; }
runuser() {
  shift 3
  if [[ "$1" == stat ]]; then
    [[ "$workload_owner" != unavailable ]] || return 1
    printf '%s\\n' "$workload_owner"
  else
    "$@"
  fi
}
${helpers}
case "$3" in
  home) prepare_browser_home ;;
  leaf) prepare_browser_leaf_directory "$fixture_home/.local/share/qubicl/browser-profile" ;;
  parent) prepare_browser_parent_directory "$fixture_home/.local" ;;
  password) prepare_browser_keyring_password ;;
esac`;
  const run = (owner: string, action: string) => spawnSync('/bin/bash', ['-c', script, 'browser-ownership-fixture', home, owner, action], {
    encoding: 'utf8', timeout: 5_000, env: { PATH: process.env.PATH },
  });
  const mapped = run('1000:1000', 'home');
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.equal(await readFile(join(profile, 'preserved-session'), 'utf8'), 'existing durable session');
  assert.equal((await stat(profile)).mode & 0o777, 0o700);
  assert.equal((await stat(password)).mode & 0o777, 0o600);
  // Access alone is insufficient: even a writable leaf with a different owner
  // must fail, and a nonempty genuinely root-owned profile must not be chowned.
  await chmod(profile, 0o777);
  for (const [owner, action] of [['0:0', 'leaf'], ['2000:2000', 'leaf'], ['2000:2000', 'parent'], ['0:0', 'password'], ['2000:2000', 'password'], ['unavailable', 'leaf']]) {
    const mismatch = run(owner!, action!);
    assert.equal(mismatch.status, 78, `${owner}/${action}: ${mismatch.stderr}`);
    assert.match(mismatch.stderr, /ownership does not match/);
    assert.doesNotMatch(mismatch.stderr, /unexpected-ownership-repair/);
  }
  await rm(profile, { recursive: true });
  await symlink(join(home, 'Downloads'), profile);
  assert.equal(run('1000:1000', 'leaf').status, 78);
  await rm(password);
  await writeFile(join(home, 'outside-password'), `${'A'.repeat(43)}=\n`, { mode: 0o600 });
  await symlink(join(home, 'outside-password'), password);
  assert.equal(run('1000:1000', 'password').status, 78);
});
