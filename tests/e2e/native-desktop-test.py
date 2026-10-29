"""Run in a disposable guest with Xvfb, a WM, and the guest session bus.

No external network, models, user documents, or host desktop are used.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_helper', root / 'packages/control/src/desktop-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
desktop = helper.Desktop()
fixture = subprocess.Popen(['/usr/bin/python3', str(root / 'tests/fixtures/native-desktop.py')])


def wait_for(find, description):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        value = find()
        if value:
            return value
        time.sleep(.15)
    raise AssertionError(description)


def elements(wid):
    page = desktop.snapshot({'windowId': wid, 'limit': 5, 'maxBytes': 2048})
    found = page['elements'][:]
    while page['nextCursor']:
        page = desktop.snapshot({'windowId': wid, 'cursor': page['nextCursor'], 'limit': 5, 'maxBytes': 2048})
        found.extend(page['elements'])
    return found


try:
    window = wait_for(lambda: next((w for w in desktop.inventory() if w['title'] == 'Qubicl native fixture'), None), 'fixture window')
    wid = window['id']
    nodes = wait_for(lambda: elements(wid), 'fixture accessibility')
    assert len({n['ref'] for n in nodes}) == len(nodes)
    buttons = [n for n in nodes if n['role'] == 'button']
    assert len(buttons) == 20, [n['role'] for n in nodes]
    disabled = next(n for n in buttons if n['name'] == 'Button 1')
    assert 'sensitive' not in disabled['states']
    try:
        desktop.act({'ref': disabled['ref'], 'action': 'invoke'})
        raise AssertionError('disabled button accepted')
    except helper.Failure as error:
        assert error.code == 'desktop_element_disabled'
    field = next(n for n in nodes if n['name'] == 'Filename')
    assert desktop.act({'ref': field['ref'], 'action': 'set_text', 'text': 'example.txt'})['acceptedByAccessibilityApi']
    button = next(n for n in buttons if n['name'] == 'Button 0')
    assert desktop.act({'ref': button['ref'], 'action': 'invoke'})['acceptedByAccessibilityApi']
    updated = elements(wid)
    assert any(n.get('text') == 'example.txt' for n in updated)
    assert any(n['name'] == 'Clicked' for n in updated)
    # App-controlled metadata and element names share one response budget.
    original_window, original_describe = desktop.window, desktop.describe
    desktop.window = lambda current: {**original_window(current), 'title': '\x00' * 512, 'className': '\x00' * 512,
                                      'windowTypes': ['\x00' * 80] * 8}
    def long_name(*args):
        item, fingerprint = original_describe(*args)
        return {**item, 'name': '界' * 512}, fingerprint
    desktop.describe = long_name
    try:
        page = desktop.snapshot({'windowId': wid, 'maxBytes': 18000})
        count = 0
        while True:
            assert len(json.dumps(page, ensure_ascii=False).encode()) < 24000
            count += len(page['elements'])
            if not page['nextCursor']:
                break
            page = desktop.snapshot({'windowId': wid, 'cursor': page['nextCursor'], 'maxBytes': 18000})
        assert count == len(updated), 'byte-budget continuation must retain every native element'
    finally:
        desktop.window, desktop.describe = original_window, original_describe
    subprocess.run(['xdotool', 'windowsize', str(wid), '600', '750'], check=True)
    wait_for(lambda: desktop.window(wid)['geometryToken'] != window['geometryToken'], 'geometry change')
    try:
        desktop.validate({'windowId': wid, 'geometryToken': window['geometryToken']})
        raise AssertionError('stale geometry accepted')
    except helper.Failure as error:
        assert error.code == 'stale_desktop_geometry'
    assert desktop.close_process({'pid': fixture.pid})['dispatch'] == 'completed'
    modal = wait_for(lambda: next((w for w in desktop.inventory() if w['transientFor'] == wid and w['modal']), None), 'save dialog')
    assert fixture.poll() is None, 'normal close killed the app'
    modal_nodes = elements(modal['id'])
    discard = next(n for n in modal_nodes if n['name'] == 'Discard')
    assert desktop.act({'ref': discard['ref'], 'action': 'invoke'})['acceptedByAccessibilityApi']
    fixture.wait(timeout=10)
    try:
        desktop.act({'ref': button['ref'], 'action': 'invoke'})
        raise AssertionError('stale reference accepted')
    except helper.Failure as error:
        assert error.code in ('stale_desktop_ref', 'stale_desktop_window')
    print('PASS: native inventory, pagination, disabled states, exact refs, edit/invoke, geometry rejection, modal normal close, stale refs')
finally:
    if fixture.poll() is None:
        fixture.terminate()
        fixture.wait(timeout=5)
