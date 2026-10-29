"""Launch the bundled creative apps in a fresh, disposable workstation desktop."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_helper', root / 'packages/control/src/desktop-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
desktop = helper.Desktop()
applications = [('gimp', ['--no-splash']), ('inkscape', []), ('blender', ['--factory-startup']), ('freecad', []), ('kdenlive', [])]

for executable, arguments in applications:
    if len(sys.argv) > 1 and executable not in sys.argv[1:]:
        continue
    before = {w['id'] for w in desktop.inventory()}
    with tempfile.TemporaryDirectory(prefix=f'qubicl-smoke-{executable}-') as profile, open(f'/tmp/qubicl-smoke-{executable}.log', 'w', encoding='utf-8') as log:
        environment = {**os.environ, 'HOME': profile, 'XDG_CONFIG_HOME': profile + '/config',
                       'XDG_DATA_HOME': profile + '/data', 'XDG_CACHE_HOME': profile + '/cache',
                       'TMPDIR': profile, 'LANG': 'C.UTF-8'}
        subprocess.run(['/bin/bash', str(root / 'images/computer/setup-desktop-home.sh')], env=environment, check=True)
        child = subprocess.Popen([executable, *arguments], env=environment, stdout=log, stderr=log, start_new_session=True)
        try:
            deadline = time.monotonic() + 35
            window = None
            welcome_handled = False
            while time.monotonic() < deadline:
                inventory = desktop.inventory()
                # Inkscape intentionally offers templates before its first empty
                # document. Exercise that observed control, not a splash screen.
                if executable == 'inkscape' and not welcome_handled:
                    welcome = next((w for w in inventory if w['id'] not in before and w['modal'] and 'Inkscape' in w['title']), None)
                    if welcome:
                        snapshot = desktop.snapshot({'windowId': welcome['id'], 'limit': 100})
                        create = next((item for item in snapshot['elements'] if item['name'] == 'New Document' and 'click' in item.get('actions', [])), None)
                        if create:
                            desktop.act({'ref': create['ref'], 'action': 'invoke', 'actionName': 'click'})
                            welcome_handled = True
                window = next((w for w in inventory if w['id'] not in before and w['visible'] and
                               executable in (w['className'] + ' ' + w['title']).lower() and
                               'splash' not in w['windowTypes'] and
                               'dialog' not in w['windowTypes'] and
                               w['geometry']['width'] > 100 and w['geometry']['height'] > 100), None)
                if window:
                    break
                if child.poll() is not None and child.returncode != 0:
                    break
                time.sleep(.3)
            if not window:
                diagnostic = []
                for current in desktop.inventory():
                    if current['id'] in before:
                        continue
                    snapshot = desktop.snapshot({'windowId': current['id'], 'limit': 40})
                    diagnostic.append({'window': current, 'controls': [item['name'] for item in snapshot['elements']]})
                print(json.dumps({'app': executable, 'exitCode': child.poll(), 'startupFailure': diagnostic}), flush=True)
                raise AssertionError(f'{executable}: no editor window; see /tmp/qubicl-smoke-{executable}.log')
            time.sleep(.5)
            observation = desktop.snapshot({'windowId': window['id'], 'limit': 20, 'maxBytes': 8000})
            print(json.dumps({'app': executable, 'launched': True, 'window': window['title'],
                              'accessibility': observation['accessibility'], 'sampleElements': len(observation['elements'])}), flush=True)
            desktop.window_action({'windowId': window['id'], 'action': 'close'})
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass  # A new app may ask about an empty project; only this test process is cleaned up below.
        finally:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=3)
