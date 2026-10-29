"""One bounded combined-use sample; not a performance benchmark or release gate."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import time

spec = importlib.util.spec_from_file_location('desktop_helper', '/src/packages/control/src/desktop-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
desktop = helper.Desktop()
root = Path('/home/qubicl')
(root / 'memory-page.html').write_text('<!doctype html><title>Qubicl workload fixture</title><h1>Local workstation check</h1>' + '<p>Small local dashboard row</p>' * 40)
(root / 'memory-document.txt').write_text('Qubicl office fixture\n' + 'Small editable document.\n' * 80)
cgroup = Path('/sys/fs/cgroup')
def values(name):
    return {key: int(value) for key, value in (line.split() for line in (cgroup / name).read_text().splitlines())}
base = int((cgroup / 'memory.current').read_text())
events = values('memory.events')
commands = {
    'chromium': ['/usr/bin/chromium', '--no-first-run', '--no-default-browser-check', '--user-data-dir=/home/qubicl/memory-chromium', 'file:///home/qubicl/memory-page.html'],
    'libreoffice': ['libreoffice', '-env:UserInstallation=file:///home/qubicl/memory-office', '--writer', '/home/qubicl/memory-document.txt'],
    'blender': ['blender', '/home/qubicl/audit-fixtures/fixture.blend'],
}
profile = root / 'memory-office/user'
profile.mkdir(parents=True, exist_ok=True)
shutil.copyfile('/etc/skel/.config/libreoffice/4/user/registrymodifications.xcu', profile / 'registrymodifications.xcu')
children = []
try:
    for app, command in commands.items():
        stream = open('/tmp/memory-' + app + '.log', 'w')
        children.append((app, subprocess.Popen(command, stdout=stream, stderr=stream, start_new_session=True)))
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        windows = [w for w in desktop.inventory() if w['visible'] and 'splash' not in w['windowTypes']]
        if all(any(app in w['className'].lower() and expected in w['title'] for w in windows) for app, expected in [('chromium', 'Qubicl workload fixture'), ('libreoffice', 'memory-document'), ('blender', 'fixture')]):
            break
        time.sleep(.5)
    else:
        raise AssertionError('Not all combined-use application windows opened: ' + repr(windows))
    samples = []
    for _ in range(5):
        samples.append({'bytes': int((cgroup / 'memory.current').read_text()), 'anonymousBytes': values('memory.stat')['anon']})
        time.sleep(2)
    after = values('memory.events')
    assert after['oom_kill'] == events['oom_kill'], 'OOM kill during representative workload'
    assert all(child.poll() is None for _, child in children), 'Application exited during measurement'
    print(json.dumps({'limitBytes': int((cgroup / 'memory.max').read_text()), 'baselineBytes': base,
                      'peakBytes': int((cgroup / 'memory.peak').read_text()), 'samples': samples,
                      'oomKillDelta': after['oom_kill'] - events['oom_kill'],
                      'windows': [w['title'] for w in desktop.inventory() if w['visible']],
                      'scope': 'One sandboxed Chromium local page, small Writer document and Blender cube; five samples over ten seconds. No GPU passthrough. Not a large-project sizing guarantee.'}))
finally:
    for _, child in children:
        try: os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError: pass
    for _, child in children:
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
