"""Focused GTK modal/Value and real Calc virtual-table checks in disposable X11."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

if len(sys.argv) > 1 and sys.argv[1] == '--gtk':
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk
    window = Gtk.Window(title='Qubicl modal fixture')
    window.set_default_size(570, 400)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
    window.add(box)
    spin = Gtk.SpinButton.new_with_range(1, 400, 1)
    spin.set_value(400)
    spin.get_accessible().set_name('Committed number')
    box.pack_start(spin, False, False, 0)
    output = Gtk.Label(label='Model 400')
    spin.connect('value-changed', lambda widget: output.set_text(f'Model {widget.get_value_as_int()}'))
    box.pack_start(output, False, False, 0)
    button = Gtk.Button(label='Open modal')
    def modal(_button):
        dialog = Gtk.Dialog(title='Qubicl local modal', transient_for=window, modal=True)
        dialog.set_default_size(430, 180)
        dialog.add_button('Close fixture', Gtk.ResponseType.CLOSE)
        dialog.get_content_area().pack_start(Gtk.Entry(), True, True, 0)
        dialog.show_all()
        dialog.run()
        dialog.destroy()
    button.connect('clicked', modal)
    box.pack_start(button, False, False, 0)
    window.connect('destroy', Gtk.main_quit)
    window.show_all()
    Gtk.main()
    sys.exit(0)

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('desktop_helper', root / 'packages/control/src/desktop-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
desktop = helper.Desktop()

def until(find, label):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        # Same event drain as the JSON bridge.
        desktop.call('windows', {})
        value = find()
        if value:
            return value
        time.sleep(.15)
    raise AssertionError(label)

def window(title):
    return next((item for item in desktop.inventory() if title in item['title']), None)

def snapshot(wid):
    value = desktop.snapshot({'windowId': wid})
    if value['accessibility'] != 'at-spi':
        return None
    nodes = value['elements'][:]
    while value['nextCursor']:
        value = desktop.snapshot({'windowId': wid, 'cursor': value['nextCursor']})
        nodes.extend(value['elements'])
    return nodes

processes = []
try:
    lab = subprocess.Popen([sys.executable, __file__, '--gtk'], start_new_session=True)
    processes.append(lab)
    main = until(lambda: window('Qubicl modal fixture'), 'GTK fixture window')
    nodes = until(lambda: snapshot(main['id']), 'GTK accessibility')
    spin = next(item for item in nodes if item['name'] == 'Committed number')
    assert spin['value'] == {'current': 400.0, 'min': 1.0, 'max': 400.0, 'increment': 1.0}, spin
    result = desktop.act({'ref': spin['ref'], 'action': 'set_value', 'value': 200})
    assert result['acceptedByAccessibilityApi'] and result['valueReadbackMatches'], result
    until(lambda: any(item['name'] == 'Model 200' for item in snapshot(main['id']) or []), 'GTK numeric model signal')
    try:
        desktop.act({'ref': spin['ref'], 'action': 'set_value', 'value': 500})
        raise AssertionError('out-of-range value dispatched')
    except helper.Failure as error:
        assert error.code == 'desktop_value_out_of_range'
    nodes = snapshot(main['id'])
    button = next(item for item in nodes if item['name'] == 'Open modal')
    invocation = desktop.act({'ref': button['ref'], 'action': 'invoke'})
    assert invocation['dispatchMethod'] == 'focused_keyboard', invocation
    modal = until(lambda: window('Qubicl local modal'), 'GTK modal window')
    main_nodes = until(lambda: snapshot(main['id']), 'main remains matched with modal')
    modal_nodes = until(lambda: snapshot(modal['id']), 'modal is independently matched')
    assert any(item['name'] == 'Committed number' for item in main_nodes)
    close = next(item for item in modal_nodes if item['name'] == 'Close fixture')
    assert invocation['acceptedByAccessibilityApi'] is None
    desktop.act({'ref': close['ref'], 'action': 'invoke'})
    until(lambda: not window('Qubicl local modal'), 'nested GTK modal closes through its semantic ref')
    assert snapshot(main['id'])
    print('PASS: cached GTK root refreshed across modal; numeric Value updates model and rejects out-of-range input')
    if '--gtk-only' in sys.argv:
        sys.exit(0)
    with tempfile.TemporaryDirectory(prefix='qubicl-calc-retest-') as directory:
        fixture = Path(directory) / 'virtual-cells.xlsx'
        subprocess.run(['/opt/qubicl/skills-venv/bin/python', '-c', 'from openpyxl import Workbook;import sys;w=Workbook();s=w.active;s["A1"]="Visible ID";s["B1"]="Value";s["A2"]="00123";s["B2"]=42;s["A5000"]="Distant cell";w.save(sys.argv[1])', str(fixture)], check=True)
        calc = subprocess.Popen(['libreoffice', '-env:UserInstallation=' + (Path(directory) / 'profile').as_uri(), '--calc', str(fixture)], start_new_session=True)
        processes.append(calc)
        document = until(lambda: window('virtual-cells.xlsx'), 'Calc fixture window')
        nodes = until(lambda: snapshot(document['id']), 'Calc virtual table')
        table = next(item for item in nodes if item.get('table'))
        assert table['table']['rows'] > 10000 and table['table']['columns'] >= 1000, table['table']
        assert any(item.get('text') == '00123' or item['name'] == '00123' for item in nodes), [(item['role'], item['name'], item.get('text')) for item in nodes if item.get('tableCell')]
        targeted = desktop.snapshot({'windowId': document['id'], 'ref': table['ref'], 'tableRange': {'row': 4999, 'column': 0, 'rows': 1, 'columns': 2}})
        assert any(item.get('text') == 'Distant cell' or item['name'] == 'Distant cell' for item in targeted['elements']), targeted
        assert len(targeted['elements']) <= 4, targeted
        print('PASS: real Calc virtual table yields visible cells and explicit distant range without enumerating virtual children')
finally:
    for process in reversed(processes):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
