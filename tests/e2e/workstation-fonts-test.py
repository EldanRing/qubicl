"""Japanese fallback/render coverage in the workstation's actual GTK font path.

Run with DISPLAY pointing to a disposable workstation X11 session. This sample
does not assert coverage of every CJK language or every selected font family.
"""
import subprocess
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

assert subprocess.check_output(['fc-list', ':lang=ja'], text=True).strip(), 'No font advertises Japanese coverage'
label = Gtk.Label()
layout = label.create_pango_layout('Unicode café ♟ 日本語')
assert layout.get_unknown_glyphs_count() == 0, 'The Japanese sample has missing glyphs'
family = subprocess.check_output(['fc-match', '-f', '%{family}', ':lang=ja'], text=True)
print('PASS: Japanese sample renders without missing glyphs; fallback:', family)
