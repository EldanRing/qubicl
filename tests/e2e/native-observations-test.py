"""Focused native text, accelerator and explicit window-fit check in disposable X11."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_helper', root / 'packages/control/src/desktop-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
desktop = helper.Desktop()


def wait_for(find, description):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        value = find()
        if value: return value
        time.sleep(.15)
    raise AssertionError(description)


with tempfile.TemporaryDirectory() as directory:
    source = Path(directory) / 'native-observations.txt'
    text = 'Native text 🧪\n' * 800 + 'END\n'
    source.write_text(text)
    app = subprocess.Popen(['mousepad', str(source)])
    try:
        window = wait_for(lambda: next((window for window in desktop.inventory() if source.name in window['title']), None), 'Mousepad window')
        wid = window['id']
        first = wait_for(lambda: desktop.snapshot({'windowId': wid, 'includeHidden': True}), 'snapshot')
        nodes = first['elements'][:]
        while first['nextCursor']:
            first = desktop.snapshot({'windowId': wid, 'cursor': first['nextCursor']})
            nodes.extend(first['elements'])
        editor = next(node for node in nodes if node.get('textLength', 0) >= len(text))
        part = desktop.snapshot({'windowId': wid, 'ref': editor['ref'], 'textOffset': 0, 'maxBytes': 2048})
        actual = part['text']
        while part['nextTextCursor']:
            part = desktop.snapshot({'windowId': wid, 'textCursor': part['nextTextCursor'], 'maxBytes': 2048})
            actual += part['text']
        assert actual == text
        bindings = [binding['binding'] for node in nodes for binding in node.get('keyBindings', []) if binding['binding']]
        assert bindings, 'Mousepad must expose actual menu keybindings'
        subprocess.run(['xdotool', 'windowsize', str(wid), '1800', '1100'], check=True)
        oversized = wait_for(lambda: (window if (window := desktop.window(wid))['clippedToWorkArea'] else None), 'oversized window')
        result = desktop.window_action({'windowId': wid, 'action': 'fit', 'geometryToken': oversized['geometryToken']})
        assert result['verified'] is False
        fitted = wait_for(lambda: (window if not (window := desktop.window(wid))['clippedToWorkArea'] else None), 'fitted window')
        assert fitted['geometry']['width'] <= fitted['workArea']['width']
        print('PASS: native Unicode continuation, provided keybindings, observed clipping and explicit fit')
    finally:
        app.terminate()
        app.wait(timeout=5)
