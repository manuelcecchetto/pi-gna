#!/usr/bin/env python3
# Test fixture for the Linux Computer Use helper: a GTK 4 window with known controls, so input, accessibility reads
# and captures can be checked against state it reports itself. Run: python3 native/computer-use-linux/fixture.py
# Prints one JSON line per event on stdout ("clicked", "text", "key", "scrolled", "dragged").
import json
import sys

import gi

gi.require_version("Gtk", "4.0")
from gi.repository import GLib, Gtk  # noqa: E402


def emit(kind, **data):
    print(json.dumps({"event": kind, **data}), flush=True)


def build(app):
    win = Gtk.ApplicationWindow(application=app, title="pi-gna CU fixture")
    win.set_default_size(640, 480)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin_top=12, margin_bottom=12, margin_start=12, margin_end=12)
    label = Gtk.Label(label="Clicks: 0")
    label.set_accessible_role  # noqa: B018 (exists on GTK 4)
    entry = Gtk.Entry(placeholder_text="Type here")
    entry.set_tooltip_text("Name field")
    button = Gtk.Button(label="Increment")
    check = Gtk.CheckButton(label="Enable feature")
    clicks = {"n": 0}

    def on_click(_b):
        clicks["n"] += 1
        label.set_label(f"Clicks: {clicks['n']}")
        emit("clicked", n=clicks["n"])

    button.connect("clicked", on_click)
    entry.connect("changed", lambda e: emit("text", value=e.get_text()))
    check.connect("toggled", lambda c: emit("toggled", active=c.get_active()))
    keys = Gtk.EventControllerKey()
    keys.connect("key-pressed", lambda _c, keyval, _code, state: emit("key", name=Gtk.accelerator_name(keyval, state)) or False)
    win.add_controller(keys)
    view = Gtk.TextView()
    view.get_buffer().set_text("\n".join(f"Line {i}" for i in range(1, 201)))
    scroller = Gtk.ScrolledWindow(vexpand=True)
    scroller.set_child(view)
    scroller.get_vadjustment().connect("value-changed", lambda a: emit("scrolled", value=round(a.get_value())))
    for widget in (label, entry, button, check, scroller):
        box.append(widget)
    win.set_child(box)
    win.present()


app = Gtk.Application(application_id="io.github.pigna.CuFixture")
app.connect("activate", build)
sys.exit(app.run([]))
