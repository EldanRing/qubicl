import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopApplicationManager, desktopLaunchArguments, parseDesktopExec } from '@qubicl/control/desktop-applications';

test('desktop entry IDs preserve distinct applications sharing an interpreter and their exact arguments', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'qubicl-launchers-'));
  const manager = new DesktopApplicationManager('computer', { root });
  context.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const directory = join(root, '.local/share/applications');
  await mkdir(directory, { recursive: true });
  const script = join(root, 'application code.cjs');
  await writeFile(script, "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));setInterval(()=>{},1000)");
  const document = join(root, 'document with space.txt');
  await writeFile(document, 'fixture');
  for (const id of ['first', 'second']) {
    await writeFile(join(directory, `${id}.desktop`), `[Desktop Entry]\nType=Application\nName=${id}\nExec="${process.execPath}" "application code.cjs" "${join(root, id)}" "fixed argument" "$literal" %F\nPath=${root}\n`);
  }
  const available = await manager.available();
  assert.ok(available.some(item => item.application === 'desktop:first.desktop'));
  assert.ok(available.some(item => item.application === 'desktop:second.desktop'));
  await manager.open('desktop:first.desktop', [document]);
  await manager.open('desktop:second.desktop', [document]);
  for (const id of ['first', 'second']) {
    let data: string | undefined;
    for (let attempt = 0; attempt < 40 && !data; attempt++) {
      data = await readFile(join(root, id), 'utf8').catch(() => undefined);
      if (!data) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(JSON.parse(data!), ['fixed argument', '$literal', document]);
  }
  assert.equal(manager.list().length, 2);
});

test('desktop field codes expand as arguments, with unsupported and ambiguous forms rejected', () => {
  assert.deepEqual(parseDesktopExec('python3 "/opt/my app.py" --literal="two words"'), ['python3', '/opt/my app.py', '--literal=two words']);
  assert.deepEqual(parseDesktopExec(String.raw`example "path\\\\name" "\\$literal"`), ['example', String.raw`path\name`, '$literal']);
  const definition = { executable: '/bin/example', fixedArguments: [], allowedPathKind: 'file' as const,
    launcher: { path: '/usr/share/applications/example.desktop', name: 'Example App', icon: 'example', arguments: ['%i', '%c', '%k', '100%%', '%U'] } };
  assert.deepEqual(desktopLaunchArguments(definition, ['/home/qubicl/a b.txt']), ['--icon', 'example', 'Example App', '/usr/share/applications/example.desktop', '100%', 'file:///home/qubicl/a%20b.txt']);
  assert.throws(() => desktopLaunchArguments({ ...definition, launcher: { ...definition.launcher, arguments: ['%f'] } }, ['a', 'b']), /one file/);
  assert.throws(() => desktopLaunchArguments({ ...definition, launcher: { ...definition.launcher, arguments: ['--file=%F'] } }, []), /Unsupported/);
  assert.throws(() => parseDesktopExec('python3 "unterminated'), /Unterminated/);
});
