"""Small Mousepad regression in a disposable X11/AT-SPI session."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_helper', root / 'packages/control/src/desktop-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
desktop = helper.Desktop()
errors = tempfile.TemporaryFile(mode='w+')
app = subprocess.Popen(['mousepad', '--disable-server'], stdout=subprocess.DEVNULL, stderr=errors)
try:
    deadline = time.monotonic() + 10
    result = None
    while time.monotonic() < deadline:
        window = next((w for w in desktop.inventory() if w['pid'] == app.pid), None)
        if window:
            result = desktop.snapshot({'windowId': window['id'], 'limit': 3})
            if any('editable' in item['states'] for item in result['elements']):
                break
        time.sleep(.1)
    errors.seek(0)
    assert result and any('editable' in item['states'] for item in result['elements']), {
        'snapshot': result, 'windows': desktop.inventory(), 'appExit': app.poll(), 'stderr': errors.read(),
        'windowManagerLog': Path('/tmp/window-manager.log').read_text() if Path('/tmp/window-manager.log').exists() else None,
    }
    assert all({'visible', 'showing'} <= set(item['states']) for item in result['elements']), result
    assert not result['scopeLimitReached'], result
    omitted = result['hiddenElementsOmitted']
    result = desktop.snapshot({'windowId': window['id'], 'includeHidden': True})
    hidden = []
    while True:
        hidden.extend(item for item in result['elements'] if not {'visible', 'showing'} <= set(item['states']))
        if not result['nextCursor']:
            break
        result = desktop.snapshot({'windowId': window['id'], 'cursor': result['nextCursor']})
    assert len(hidden) >= omitted, (len(hidden), omitted)
    print(json.dumps({'result': 'passed', 'editorInFirstThree': True, 'hiddenElementsOmitted': omitted,
                      'hiddenElementsAvailable': len(hidden)}))
finally:
    app.terminate()
    app.wait(timeout=5)
    errors.close()
