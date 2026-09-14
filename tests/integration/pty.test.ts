import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PtyManager } from '@qubicl/control/pty';

const owner = { id: 'pty-owner', generation: 1, epoch: 'pty-epoch' };
const otherOwner = { ...owner, generation: 2 };
const helperPath = resolve('images/computer/pty-helper.py');

test('bounded PTY supports output, input, resize, and explicit close', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-pty-'));
  const manager = new PtyManager({ helperPath, home, environment: { PATH: process.env.PATH }, completedTtlMs: 60_000 });
  try {
    const opened = await manager.open('printf ready:; read value; printf got:%s "$value"', home, 24, 80, owner, 'task', 'interactive shell');
    assert.equal(opened.running, true);
    await manager.resize(opened.terminalId, owner, 40, 120);
    await manager.write(opened.terminalId, owner, 'hello\n');
    let page = await manager.read(opened.terminalId, owner, 0, 1000, 2_000, 'utf8');
    const deadline = Date.now() + 2_000;
    while (page.running && Date.now() < deadline) page = await manager.read(opened.terminalId, owner, page.nextOffset, 1000, 200, 'utf8');
    const all = await manager.read(opened.terminalId, owner, 0, 1000, 0, 'utf8');
    assert.match(all.data, /ready:got:hello/u);
    assert.equal(all.running, false);
  } finally {
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

test('session terminals are lease-fenced while task terminals are attachable by a new owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qubicl-pty-ownership-'));
  const manager = new PtyManager({ helperPath, home, environment: { PATH: process.env.PATH }, completedTtlMs: 60_000 });
  try {
    const session = await manager.open('sleep 30', home, 24, 80, owner, 'session', 'session');
    await assert.rejects(manager.read(session.terminalId, otherOwner, 0, 10, 0, 'utf8'), /different lease generation/u);
    const task = await manager.open('read value; printf %s "$value"', home, 24, 80, owner, 'task', 'task');
    await manager.write(task.terminalId, otherOwner, 'continued\n');
    const output = await manager.read(task.terminalId, otherOwner, 0, 100, 2_000, 'utf8');
    assert.match(output.data, /continued/u);
    await manager.close(session.terminalId, owner, true);
  } finally {
    await manager.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
