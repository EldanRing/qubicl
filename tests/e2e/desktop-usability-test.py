"""Focused real-app usability checks; run only in a disposable X11 desktop."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('bridge', ROOT / 'packages/control/src/desktop-helper.py')
bridge = importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
desktop = bridge.Desktop()


def until(find, label):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        desktop.call('windows', {})
        result = find()
        if result:return result
        time.sleep(.08)
    raise AssertionError(label)


def nodes(wid):
    result = desktop.snapshot({'windowId': wid, 'limit': 200, 'maxBytes': 18000})
    records = result['elements'][:]
    while result['nextCursor']:
        result = desktop.snapshot({'windowId': wid, 'cursor': result['nextCursor'], 'limit': 200, 'maxBytes': 18000})
        records.extend(result['elements'])
    return records


def replace(ref, text):
    state = desktop.text_edit({'ref': ref, 'text': text})
    for _ in range(80):
        if state['done']:return state['result']
        time.sleep(.05);desktop.call('windows', {})
        state = desktop.text_edit({'token': state['token']})
    raise AssertionError(('replacement incomplete', state))


processes = []
try:
    with tempfile.TemporaryDirectory(prefix='qubicl-usability-') as directory:
        root = Path(directory)
        environment = dict(os.environ, XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'), XDG_CACHE_HOME=str(root / 'cache'))
        if '--text-only' not in sys.argv:
            folder = root / 'files';folder.mkdir();(folder / 'alpha.txt').write_text('alpha');(folder / 'beta-directory').mkdir()
            thunar = subprocess.Popen(['thunar', str(folder)], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL);processes.append(thunar)
            window = until(lambda: next((w for w in desktop.inventory() if 'thunar' in w['className'].lower()), None), 'Thunar window')
            desktop.focused_chord(window, ['Control_L', '1'])
            until(lambda: desktop.snapshot({'windowId': window['id']}).get('coverageGaps'), 'icon view gap')
            snapshot = desktop.snapshot({'windowId': window['id']})
            assert snapshot['recoveryActions'][0]['input']['action'] == 'file_details'
            receipt = desktop.window_action({'windowId': window['id'], 'action': 'file_details'})
            assert receipt['requestedView'] == 'details'
            entries = until(lambda: [n for n in nodes(window['id']) if n['role'] == 'table cell' and n['name'] in ('alpha.txt', 'beta-directory')], 'accessible directory cells')
            assert {n['name'] for n in entries} == {'alpha.txt', 'beta-directory'}, entries
            for node in entries: assert desktop.resolve(node['ref'])[0].get_name() == node['name']
            print('PASS: explicit Thunar Details mode exposes real named file/directory refs', flush=True)
            # Actual Kdenlive minimum width exceeds this disposable 1440px desktop.
            kdenlive = subprocess.Popen(['kdenlive'], env=dict(environment, QT_X11_NO_MITSHM='1'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL);processes.append(kdenlive)
            window = until(lambda: next((w for w in desktop.inventory() if w['pid'] == kdenlive.pid and not w['transientFor']), None), 'Kdenlive window')
            time.sleep(.2);window = desktop.window(window['id'])
            before = desktop.inventory();screen = desktop.desktop_bounds()['desktopBounds']
            assert window['geometry']['width'] > screen['width'], window
            region = {'x': window['geometry']['width'] - 140, 'y': window['geometry']['height'] - 150, 'width': 140, 'height': 150}
            desktop.window_action({'windowId': window['id'], 'action': 'reveal', 'region': region, 'geometryToken': window['geometryToken']})
            def revealed():
                current = desktop.window(window['id']);g, a = current['geometry'], current['workArea']
                return current if all(a[axis] <= g[axis] + region[axis] and g[axis] + region[axis] + region[size] <= a[axis] + a[size] for axis, size in (('x','width'), ('y','height'))) else None
            current = until(revealed, 'Kdenlive bottom-right region accessible')
            assert desktop.desktop_bounds()['desktopBounds'] == screen
            assert (current['geometry']['width'], current['geometry']['height']) == (window['geometry']['width'], window['geometry']['height'])
            assert all(desktop.window(w['id'])['geometry'] == w['geometry'] for w in before if w['id'] != window['id'])
            try:
                desktop.window_action({'windowId': window['id'], 'action': 'reveal', 'region': region, 'geometryToken': window['geometryToken']})
                raise AssertionError('stale geometry accepted')
            except bridge.Failure as error:assert error.code == 'stale_desktop_geometry'
            region = {'x': 0, 'y': 0, 'width': 140, 'height': 150}
            desktop.window_action({'windowId': current['id'], 'action': 'reveal', 'region': region, 'geometryToken': current['geometryToken']})
            until(revealed, 'Kdenlive top-left region accessible again')
            print('PASS: reveal accesses both edges of oversized Kdenlive without resizing display/other windows; stale geometry rejected', flush=True)
        # The clipboard holds binary data throughout the text operation.
        clipboard = b'QUBICL_BINARY_CLIPBOARD\x00\xff'
        subprocess.run(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-i'], input=clipboard, check=True)
        owner = desktop.x.get_selection_owner(desktop.x.intern_atom('CLIPBOARD')).id
        source = root / 'edit.txt';original = 'ORIGINAL words\nsecond original line';source.write_text(original)
        other = root / 'other.txt';other.write_text('UNRELATED DOCUMENT')
        mousepad = subprocess.Popen(['mousepad', '--disable-server', '--opening-mode=tab', str(other), str(source)], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL);processes.append(mousepad)
        window = until(lambda: next((w for w in desktop.inventory() if w['pid'] == mousepad.pid and not w['modal']), None), 'Mousepad editor')
        editor = until(lambda: next((n for n in nodes(window['id']) if n.get('text') == original and n['role'] == 'text'), None), 'source tab')
        obj, _ = desktop.resolve(editor['ref'])
        desktop.focused_chord(desktop.window(window['id']), ['Control_L', 'r'], obj)
        dialog = until(lambda: next((w for w in desktop.inventory() if w['transientFor'] == window['id']), None), 'replacement preferences')
        controls = nodes(dialog['id'])
        scope = next(n for n in controls if n['role'] == 'combo box' and n['name'] == 'Document')
        combo, _ = desktop.resolve(scope['ref']);menu = combo.get_child_at_index(0)
        index = next(i for i in range(menu.get_child_count()) if menu.get_child_at_index(i).get_name() == 'All Documents')
        assert combo.get_selection_iface().select_child(index)
        desktop.window_action({'windowId': dialog['id'], 'action': 'close'})
        until(lambda: not any(w['transientFor'] == window['id'] for w in desktop.inventory()), 'preferences dialog closed')
        for text in ['REPLACED\n日本語 literal \\1 $1\tend', '']:
            entry = until(lambda: next((n for n in nodes(window['id']) if n.get('text') == original and n['role'] == 'text'), None), 'original editor text')
            result = replace(entry['ref'], text)
            assert result['textReadbackMatches'] and result['undoGrouping'] == 'application_transaction'
            until(lambda: not any(w['transientFor'] == window['id'] for w in desktop.inventory()), 'replace dialog closed')
            obj, _ = desktop.resolve(entry['ref'])
            if text == '':
                inserted = replace(entry['ref'], 'FROM EMPTY 日本語')
                assert inserted['textReadbackMatches']
                until(lambda: not any(w['transientFor'] == window['id'] for w in desktop.inventory()), 'empty-source dialog closed')
                desktop.focused_chord(desktop.window(window['id']), ['Control_L', 'z'], obj)
                until(lambda: desktop.edit_text_value(obj) == '', 'one Undo restores empty source')
            desktop.focused_chord(desktop.window(window['id']), ['Control_L', 'z'], obj)
            until(lambda: desktop.edit_text_value(obj) == original, 'one Undo restores original text')
        assert desktop.x.get_selection_owner(desktop.x.intern_atom('CLIPBOARD')).id == owner
        assert subprocess.check_output(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o']) == clipboard
        assert source.read_text() == original, 'document file was not silently saved'
        desktop.focused_chord(desktop.window(window['id']), ['Control_L', 'Page_Up'], obj)
        until(lambda: any(n.get('text') == 'UNRELATED DOCUMENT' for n in nodes(window['id'])), 'other open buffer remains unchanged despite inherited All Documents preference')
        print('PASS: Mousepad application replacement and clear each undo once; multiline/Unicode/literals, binary clipboard and original file preserved', flush=True)
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=3)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)
