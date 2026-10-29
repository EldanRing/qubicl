import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { NativeDesktopManager } from '@qubicl/control/desktop-native';
import { controlDesktop } from '@qubicl/control/executor';

test('native helper IPC retains usable refs across requests in a guest desktop', {
  skip: process.env.QUBICL_TEST_NATIVE_DESKTOP !== '1' && 'Run in a disposable guest X11/AT-SPI session.', timeout: 20_000,
}, async (context) => {
  const desktop = new NativeDesktopManager({ script: resolve('packages/control/src/desktop-helper.py') });
  const fixture = spawn('/usr/bin/python3', [resolve('tests/fixtures/native-desktop.py')], { stdio: 'ignore' });
  context.after(() => { desktop.shutdown(); fixture.kill(); });
  let windowId: number | undefined;
  for (let attempt = 0; attempt < 30 && !windowId; attempt++) {
    const inventory = await desktop.windows();
    windowId = (inventory.windows as Array<{ id: number; title: string }>).find(({ title }) => title === 'Qubicl native fixture')?.id;
    if (!windowId) await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(windowId, 'fixture must expose an X11 window');
  const snapshot = await desktop.snapshot({ windowId });
  const button = (snapshot.elements as Array<{ name: string; ref: string; geometry: { x: number; y: number; width: number; height: number } }>).find(({ name }) => name === 'Button 0');
  assert.ok(button);
  const click = await controlDesktop({ type: 'click', targetWindowId: windowId,
    geometryToken: (snapshot.window as { geometryToken: string }).geometryToken,
    x: Math.floor(button.geometry.x + button.geometry.width / 2), y: Math.floor(button.geometry.y + button.geometry.height / 2), button: 1,
  }, undefined, desktop) as { dispatch: string; verified: boolean };
  assert.equal(click.dispatch, 'completed');
  assert.equal(click.verified, false);
  const dispatched = await desktop.act({ ref: button.ref, action: 'invoke' });
  assert.equal(dispatched.acceptedByAccessibilityApi, true);
  assert.equal(dispatched.verified, false);
  const after = await desktop.snapshot({ windowId });
  assert.ok((after.elements as Array<{ name: string }>).some(({ name }) => name === 'Clicked'));
});
