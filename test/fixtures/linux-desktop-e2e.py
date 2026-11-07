"""Manual Linux Desktop acceptance fixture: only this window may receive test input."""
import os
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

WINDOW_TITLE = os.environ.get('COS_LINUX_E2E_TITLE', 'CoS Linux Desktop E2E Fixture')

window = Gtk.Window(title=WINDOW_TITLE)
window.set_default_size(430, 230)
window.connect('destroy', Gtk.main_quit)

layout = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
layout.set_border_width(18)
window.add(layout)

heading = Gtk.Label(label='Isolated Linux Desktop Test')
heading.get_accessible().set_name('Fixture heading')
layout.pack_start(heading, False, False, 0)

entry = Gtk.Entry()
entry.set_placeholder_text('Test message')
entry.set_text('Not verified')
entry.get_accessible().set_name('Test message')
layout.pack_start(entry, False, False, 0)

button = Gtk.Button(label='Apply test message')
button.get_accessible().set_name('Apply test message')
layout.pack_start(button, False, False, 0)

status = Gtk.Label(label='Result: pending')
status.get_accessible().set_name('Test result')
layout.pack_start(status, False, False, 0)


def apply(_button):
    message = entry.get_text()
    status.set_text(f'Result: {message}')
    print(f'E2E_RESULT={message}', flush=True)


button.connect('clicked', apply)
window.show_all()
print('E2E_READY', flush=True)
Gtk.main()
