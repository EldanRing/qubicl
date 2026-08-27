import assert from 'node:assert/strict';
import test from 'node:test';
import {
  controlDesktop,
  dragCommandArguments,
  keypressCommandArguments,
  keypressReportedUnknownKey,
  parseX11WindowId,
} from '@qubicl/control/executor';

test('keypresses are represented by one xdotool command', () => {
  assert.deepEqual(keypressCommandArguments(['ctrl+end', 'ctrl+s']), [
    'key',
    '--clearmodifiers',
    'ctrl+End',
    'ctrl+s',
  ]);
});

test('keypresses normalize common key aliases to case-sensitive X11 names', () => {
  assert.deepEqual(keypressCommandArguments(['enter', 'PageDown', 'ESC', 'f12', 'CTRL+END']), [
    'key',
    '--clearmodifiers',
    'Return',
    'Page_Down',
    'Escape',
    'F12',
    'ctrl+End',
  ]);
});

test('keypresses detect xdotool unknown-key warnings even when xdotool exits successfully', () => {
  assert.equal(keypressReportedUnknownKey('', "(symbol) No such key name 'unknown'. Ignoring it."), true);
  assert.equal(keypressReportedUnknownKey('', ''), false);
});

test('targeted keyboard input confirms focus before XTEST dispatch and reports bounded focus evidence', async () => {
  const commands: string[][] = [];
  const runner = async (_command: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    commands.push(args);
    if (args[0] === 'getactivewindow') return { stdout: '42\n', stderr: '' };
    if (args[0] === 'getwindowname') return { stdout: `${'W'.repeat(600)}\n`, stderr: '' };
    if (args[0] === 'getwindowclassname') return { stdout: 'libreoffice-writer\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  const result = await controlDesktop({
    type: 'keypress',
    keys: ['ctrl+end'],
    targetWindowId: 42,
  }, runner) as {
    action: string;
    dispatch: string;
    verified: boolean;
    verification: string;
    focusEvidence: {
      before: { id: number; title: string; className: string };
      after: { id: number; title: string; className: string };
      targetConfirmedBeforeDispatch: boolean;
      targetStillActiveAfterDispatch: boolean;
    };
  };

  assert.deepEqual(commands[0], ['windowactivate', '--sync', '42']);
  assert.deepEqual(commands[4], ['key', '--clearmodifiers', 'ctrl+End']);
  assert.equal(commands.some((args) => args.includes('--window')), false, 'focused-window XTEST should be used instead of rejection-prone XSendEvent');
  assert.equal(result.action, 'keypress');
  assert.equal(result.dispatch, 'completed');
  assert.equal(result.verified, false);
  assert.equal(result.verification, 'dispatch_only');
  assert.equal(result.focusEvidence.before.id, 42);
  assert.equal(result.focusEvidence.before.title.length, 512);
  assert.equal(result.focusEvidence.before.className, 'libreoffice-writer');
  assert.equal(result.focusEvidence.targetConfirmedBeforeDispatch, true);
  assert.equal(result.focusEvidence.targetStillActiveAfterDispatch, true);
});

test('targeted keyboard input fails before dispatch when focus cannot be confirmed', async () => {
  const commands: string[][] = [];
  const runner = async (_command: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    commands.push(args);
    if (args[0] === 'getactivewindow') return { stdout: '7\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    controlDesktop({ type: 'keypress', keys: ['ctrl+end'], targetWindowId: 42 }, runner),
    (error: unknown) => error instanceof Error && error.message.includes('no input was dispatched'),
  );
  assert.equal(commands.some((args) => args[0] === 'key'), false);
});

test('click returns the active window identity needed to pin dependent keyboard input', async () => {
  const runner = async (_command: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args[0] === 'getactivewindow') return { stdout: '3145729\n', stderr: '' };
    if (args[0] === 'getwindowname') return { stdout: 'document.odt — LibreOffice Writer\n', stderr: '' };
    if (args[0] === 'getwindowclassname') return { stdout: 'libreoffice-writer\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const result = await controlDesktop({ type: 'click', x: 50, y: 60, button: 1 }, runner) as {
    verified: boolean;
    focusEvidence: { after: { id: number; title: string; className: string } };
  };
  assert.equal(result.verified, false);
  assert.deepEqual(result.focusEvidence.after, {
    id: 3_145_729,
    title: 'document.odt — LibreOffice Writer',
    className: 'libreoffice-writer',
  });
});

test('X11 window IDs are parsed strictly and bounded to the protocol schema', () => {
  assert.equal(parseX11WindowId('42\n'), 42);
  assert.equal(parseX11WindowId('0'), undefined);
  assert.equal(parseX11WindowId('42\n43'), undefined);
  assert.equal(parseX11WindowId('4294967296'), undefined);
});

test('drag interpolation is represented by one xdotool command', () => {
  const args = dragCommandArguments({ fromX: 10, fromY: 20, toX: 30, toY: 40, durationMs: 32 });
  assert.deepEqual(args.slice(0, 5), ['mousemove', '10', '20', 'mousedown', '1']);
  assert.deepEqual(args.slice(-6), ['mousemove', '--sync', '30', '40', 'mouseup', '1']);
  assert.equal(args.filter((argument) => argument === 'sleep').length, 2);
  assert.equal(args.filter((argument) => argument === 'mousemove').length, 3);
});
