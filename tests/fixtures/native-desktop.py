"""Harmless GTK fixture for the native desktop smoke check."""
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

window = Gtk.Window(title='Qubicl native fixture')
window.set_default_size(500, 700)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
entry = Gtk.Entry()
entry.get_accessible().set_name('Filename')
box.pack_start(entry, False, False, 0)
status = Gtk.Label(label='Ready')
box.pack_start(status, False, False, 0)
for index in range(20):
    button = Gtk.Button(label=f'Button {index}')
    if index == 1:
        button.set_sensitive(False)
    button.connect('clicked', lambda *_: status.set_text('Clicked'))
    box.pack_start(button, False, False, 0)


def close_request(*_):
    dialog = Gtk.MessageDialog(transient_for=window, modal=True, text='Unsaved fixture')
    dialog.add_button('Cancel', Gtk.ResponseType.CANCEL)
    dialog.add_button('Discard', Gtk.ResponseType.REJECT)

    def answer(current, response):
        current.destroy()
        if response == Gtk.ResponseType.REJECT:
            window.destroy()
    dialog.connect('response', answer)
    dialog.show_all()
    return True


window.connect('delete-event', close_request)
window.connect('destroy', Gtk.main_quit)
window.add(box)
window.show_all()
Gtk.main()
