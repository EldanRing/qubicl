import assert from 'node:assert/strict';
import { copyFile, readFile } from 'node:fs/promises';
import test from 'node:test';
import { DesktopApplicationManager } from '@qubicl/control/desktop-applications';
import { NativeDesktopManager, nativeDesktop } from '@qubicl/control/desktop-native';
import { takeScreenshot } from '@qubicl/control/executor';

test('bundled desktop entries open actual editable documents and screenshot crops preserve coordinates', { skip: process.env.QUBICL_TEST_WORKSTATION_APPS !== '1', timeout: 180_000 }, async (context) => {
  const manager = new DesktopApplicationManager('workstation');
  const desktop = new NativeDesktopManager({ script: '/src/packages/control/src/desktop-helper.py' });
  context.after(async () => { await manager.shutdown(); desktop.shutdown(); nativeDesktop.shutdown(); });
  const inventory = await manager.available();
  const fixtures = [
    ['gimp', 'fixture.xcf'], ['inkscape', 'fixture.svg'], ['blender', 'fixture.blend'], ['freecad', 'fixture.FCStd'], ['kdenlive', 'fixture.kdenlive'],
  ];
  for (const [app, file] of fixtures) {
    if (process.env.QUBICL_TEST_WORKSTATION_ONLY && !process.env.QUBICL_TEST_WORKSTATION_ONLY.split(',').includes(app!)) continue;
    const entry = inventory.find(item => item.desktopEntryId && item.executable?.toLowerCase().includes(app!));
    assert.ok(entry, `desktop entry for ${app}`);
    assert.ok((inventory.find(item => item.application === app)?.capabilities)?.packageVersion);
    const before = await desktop.windows() as { windows: Array<{ id: number }> };
    const started = await manager.open(entry.application, ['/home/qubicl/audit-fixtures/' + file]);
    let window: { id: number; title: string; className: string; geometryToken: string; geometry: { x: number; y: number; width: number; height: number } } | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = await desktop.windows() as { windows: Array<typeof window & { visible: boolean; windowTypes: string[] }> };
      window = state.windows.find(item => item && !before.windows.some(old => old.id === item.id) && item.visible && !item.windowTypes.includes('splash') && !item.windowTypes.includes('dialog') && item.className.toLowerCase().includes(app!) && /fixture/i.test(item.title));
      if (window) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(window, `${app} did not open the editable fixture in a main window`);
    console.log(JSON.stringify({ app, desktopEntryId: entry.desktopEntryId, opened: window.title, packageVersion: inventory.find(item => item.application === app)?.capabilities?.packageVersion }));
    if (app === 'inkscape') {
      const capture = await takeScreenshot({ region: { x: window.geometry.x + 10, y: window.geometry.y + 10, width: 80, height: 60 } }) as { width: number; height: number; origin: unknown };
      assert.equal(capture.width, 80); assert.equal(capture.height, 60);
      assert.deepEqual(capture.origin, { x: window.geometry.x + 10, y: window.geometry.y + 10 });

    }
    const copy = 'second-' + file;
    await copyFile('/home/qubicl/audit-fixtures/' + file, '/home/qubicl/audit-fixtures/' + copy);
    await manager.open(entry.application, ['/home/qubicl/audit-fixtures/' + copy]);
    let second: { id: number; title: string; className: string; visible: boolean } | undefined;
    const secondDeadline = Date.now() + 20_000;
    while (Date.now() < secondDeadline) {
      const current = await desktop.windows() as { windows: Array<{ id: number; title: string; className: string; visible: boolean }> };
      second = current.windows.find(item => item.visible && item.className.toLowerCase().includes(app!) && /second-fixture/.test(item.title));
      if (second) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(second, `${app} did not open a second distinct document`);
    console.log(JSON.stringify({ app, secondDocument: second.title, windowBehavior: second.id === window.id ? 'reused-window' : 'additional-window' }));
    if (window.geometry.x >= 0 && window.geometry.y >= 0 && window.geometry.x + window.geometry.width <= 1440 && window.geometry.y + window.geometry.height <= 900) {
      const capture = await takeScreenshot({ windowId: window.id, geometryToken: window.geometryToken }) as { width: number; height: number; windowId: number };
      assert.equal(capture.windowId, window.id); assert.equal(capture.width, window.geometry.width); assert.equal(capture.height, window.geometry.height);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    for (const candidate of (await desktop.windows() as { windows: Array<{ id: number; className: string }> }).windows) {
      if (candidate.className.toLowerCase().includes(app!)) await desktop.windowAction(candidate.id, 'close');
    }
    await new Promise(resolve => setTimeout(resolve, 600));
    if (manager.list().some(item => item.applicationId === started.applicationId)) await manager.close(started.applicationId, true, 'terminate');
  }
  assert.ok((await readFile('/home/qubicl/audit-fixtures/kdenlive.mp4')).length > 100);
});
