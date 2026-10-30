import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, chown, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { DesktopApplicationManager } from '@qubicl/control/desktop-applications';
import { NativeDesktopManager, nativeDesktop } from '@qubicl/control/desktop-native';
import { controlDesktop, takeScreenshot } from '@qubicl/control/executor';
import { workloadEnvironment } from '../../packages/control/dist/environments.js';

const run = promisify(execFile);
const enabled = process.env.QUBICL_TEST_WORKSTATION_APPS === '1';
async function until<T>(observe: () => Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`Timed out observing ${description}`);
}
interface Window { id: number; title: string; className: string; geometryToken: string; modal: boolean; }
interface Element { ref: string; role: string; name: string; text?: string; states: string[]; }

test('workstation typing preserves saved text in GTK and Qt without replacing file clipboard formats', { skip: !enabled, timeout: 45_000 }, async (context) => {
  const root = '/home/qubicl/qubicl-typing-fixture';
  await mkdir(root, { recursive: true }); await chown(root, 1000, 1000);
  const desktop = new NativeDesktopManager({ script: resolve('packages/control/src/desktop-helper.py'), uid: 1000, gid: 1000 });
  const apps = new DesktopApplicationManager('workstation', { root, spawnUid: 1000, spawnGid: 1000 });
  const environment = workloadEnvironment(process.env, root);
  let qt: ReturnType<typeof spawn> | undefined;
  const clipboard = spawn('xclip', ['-selection', 'clipboard', '-in', '-target', 'x-special/gnome-copied-files', '-quiet'], { uid: 1000, gid: 1000, env: environment, stdio: ['pipe', 'ignore', 'ignore'] });
  const fileList = 'copy\nfile:///home/qubicl/fixture.txt';
  clipboard.stdin!.end(fileList);
  context.after(async () => { qt?.kill(); clipboard.kill(); await apps.shutdown(); desktop.shutdown(); nativeDesktop.shutdown(); await rm(root, { recursive: true, force: true }); });
  const input = '--LF-one\nLF-two\r\nTAB\tEND\nUnicode café ♟ 日本語\n';
  const expected = input.replaceAll('\r\n', '\n');
  const gtkPath = join(root, 'gtk.txt'), qtPath = join(root, 'qt.txt');
  await writeFile(gtkPath, ''); await chown(gtkPath, 1000, 1000);
  await apps.open('text-editor', [gtkPath]);
  for (const toolkit of ['GTK', 'Qt']) {
    if (toolkit === 'Qt') qt = spawn('/usr/bin/python3', [resolve('tests/fixtures/qt-text-editor.py'), qtPath], { uid: 1000, gid: 1000, env: environment, stdio: 'ignore' });
    const window = await until(async () => ((await desktop.windows()).windows as Window[]).find((w) => toolkit === 'GTK' ? w.title.includes('gtk.txt') : w.title === 'Qubicl Qt typing fixture'), `${toolkit} editor`)
      .catch(async (error) => { throw new Error(`${error.message}; windows: ${JSON.stringify((await desktop.windows()).windows)}`); });
    await controlDesktop({ type: 'type', text: input, targetWindowId: window.id });
    await controlDesktop({ type: 'keypress', keys: ['ctrl+s'], targetWindowId: window.id });
    const saved = toolkit === 'GTK' ? gtkPath : qtPath;
    const actual = await until(async () => {
      const value = await readFile(saved, 'utf8').catch(() => undefined);
      return value?.includes('LF-one') ? value : undefined;
    }, `${toolkit} saved content`).catch(async (error) => { throw new Error(`${error.message}; saved: ${JSON.stringify(await readFile(saved, 'utf8').catch(() => null))}`); });
    assert.equal(actual, expected, `${toolkit} exact saved bytes`);
    const clip = await run('xclip', ['-selection', 'clipboard', '-out', '-target', 'x-special/gnome-copied-files'], { env: environment, uid: 1000, gid: 1000 });
    assert.equal(clip.stdout, fileList);
    if (toolkit === 'GTK') {
      const snapshot = await desktop.snapshot({ windowId: window.id });
      const editor = (snapshot.elements as Element[]).find((e) => e.states.includes('editable') && e.text === expected)!;
      assert.ok(editor);
      const targeted = await desktop.snapshot({ windowId: window.id, ref: editor.ref });
      assert.equal(targeted.usefulTree, true); assert.equal(targeted.fallback, undefined);
      const replacement = await desktop.act({ ref: editor.ref, action: 'set_text', text: 'Replacement' });
      assert.equal(replacement.singleUndoGuaranteed, false);
      await controlDesktop({ type: 'keypress', keys: ['ctrl+z'], targetWindowId: window.id });
      const undo = await desktop.snapshot({ windowId: window.id });
      const undone = (undo.elements as Element[]).find((e) => e.states.includes('editable'));
      assert.ok(undone, 'Undo result remains observable; AT-SPI cannot promise atomic grouping');
      await run('xdotool', ['windowsize', String(window.id), '1800', '1100'], { env: environment });
      const oversized = await until(async () => ((await desktop.windows()).windows as Array<Window & { clippedToWorkArea: boolean }>).find((w) => w.id === window.id && w.clippedToWorkArea), 'oversized window');
      const image = await takeScreenshot({ windowId: window.id, geometryToken: oversized.geometryToken }) as { width: number; height: number; clipped: boolean; origin: { x: number; y: number }; data: string };
      assert.equal(image.clipped, true); assert.ok(image.width <= 1440 && image.height <= 900); assert.ok(image.origin.x >= 0 && image.origin.y >= 0);
      await assert.rejects(takeScreenshot({ windowId: window.id, geometryToken: oversized.geometryToken, clipToScreen: false }), /visible screen/);
      await desktop.windowAction(window.id, 'fit', oversized.geometryToken);
      await until(async () => ((await desktop.windows()).windows as Window[]).find((w) => w.id === window.id && w.geometryToken !== oversized.geometryToken), 'fit geometry update');
      await assert.rejects(takeScreenshot({ windowId: window.id, geometryToken: oversized.geometryToken }), /geometry/);
    }
  }
});

test('root-managed Office aliases reach accessible documents and a save dialog through private profiles', { skip: !enabled, timeout: 60_000 }, async (context) => {
  const root = '/home/qubicl/qubicl-office-fixture', runtime = '/tmp/qubicl-office-fixture-profiles';
  await mkdir(root, { recursive: true }); await chown(root, 1000, 1000);
  await mkdir(runtime, { mode: 0o700 });
  const desktop = new NativeDesktopManager({ script: resolve('packages/control/src/desktop-helper.py'), uid: 1000, gid: 1000 });
  const apps = new DesktopApplicationManager('workstation', { spawnUid: 1000, spawnGid: 1000, runtimeRoot: runtime });
  context.after(async () => { await apps.shutdown(); desktop.shutdown(); await rm(root, { recursive: true, force: true }); await rm(runtime, { recursive: true, force: true }); });
  const writer = join(root, 'writer-fixture.txt'), calc = join(root, 'calc-fixture.xlsx'), impress = join(root, 'impress-fixture.pptx');
  await writeFile(writer, 'Office document 日本語\n'); await chmod(writer, 0o644); await chown(writer, 1000, 1000);
  await run('/opt/qubicl/skills-venv/bin/python', ['-c', 'import sys;from openpyxl import Workbook;from pptx import Presentation;w=Workbook();w.active["A1"]="Calc fixture";w.save(sys.argv[1]);p=Presentation();s=p.slides.add_slide(p.slide_layouts[0]);s.shapes.title.text="Impress fixture";p.save(sys.argv[2])', calc, impress]);
  for (const [alias, path] of [['writer', writer], ['calc', calc], ['impress', impress]]) {
    const app = await apps.open(alias!, [path!]);
    const parent = await stat(runtime);
    assert.equal(parent.uid, 0); assert.equal(parent.gid, 1000); assert.equal(parent.mode & 0o777, 0o710);
    assert.equal((await stat(join(runtime, app.applicationId))).mode & 0o777, 0o700);
    const window = await until(async () => ((await desktop.windows()).windows as Window[]).find((w) => w.title.includes(`${alias}-fixture`) && w.className.includes(`libreoffice-${alias}`)), `${alias} document window`);
    const snapshot = await until(async () => {
      const value = await desktop.snapshot({ windowId: window.id });
      return value.accessibility === 'at-spi' && (value.elements as Element[]).some((e) => e.role !== 'frame' && e.states.includes('showing')) ? value : undefined;
    }, `${alias} document accessibility`);
    assert.equal(snapshot.usefulTree, true);
    if (alias === 'writer') {
      await controlDesktop({ type: 'keypress', keys: ['ctrl+shift+s'], targetWindowId: window.id });
      let observedWindows: Window[] = [];
      const dialog = await until(async () => {
        observedWindows = (await desktop.windows()).windows as Window[];
        return observedWindows.find((w) => w.id !== window.id && /save/i.test(w.title));
      }, 'Writer Save dialog').catch((error) => { throw new Error(`${error.message}; windows: ${JSON.stringify(observedWindows.map((w) => ({ title: w.title, modal: w.modal })))}`); });
      const controls = await desktop.snapshot({ windowId: dialog.id });
      assert.equal(controls.accessibility, 'at-spi');
      assert.ok((controls.elements as Element[]).some((e) => e.states.includes('editable')), 'Save As must expose the filename field');
      await controlDesktop({ type: 'keypress', keys: ['Escape'], targetWindowId: dialog.id });
    }
    await apps.close(app.applicationId, true, 'terminate');
  }
});
