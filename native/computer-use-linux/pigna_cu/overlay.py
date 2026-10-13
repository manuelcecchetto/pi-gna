"""The "pi is using <app>" banner with a Stop button, drawn above every window through wlr-layer-shell (KWin supports
it) without taking keyboard focus. Wayland clients cannot watch keys globally, so the Stop button replaces the macOS
helper's Esc. Runs as its own GTK process (`python overlay.py`), driven by JSON lines on stdin; prints "stop <session>"
when clicked. The controller in this module starts it lazily and tolerates its absence."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from typing import Callable

LAYER_SHELL = "/usr/lib/libgtk4-layer-shell.so"


class Overlay:
    def __init__(self, interpreter: str, on_stop: Callable[[str, str], None]) -> None:
        self.interpreter = interpreter
        self.on_stop = on_stop
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.available = os.path.exists(LAYER_SHELL)

    def _ensure(self) -> bool:
        if not self.available:
            return False
        if self.proc and self.proc.poll() is None:
            return True
        env = {**os.environ, "LD_PRELOAD": LAYER_SHELL, "PYTHONHOME": os.environ.get("PYTHONHOME", "/usr")}
        try:
            self.proc = subprocess.Popen([self.interpreter, "-I", os.path.abspath(__file__)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True, bufsize=1)
        except OSError:
            self.available = False
            return False
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
        return True

    def _read(self, proc: subprocess.Popen) -> None:
        for line in proc.stdout:
            parts = line.strip().split(" ", 2)
            if len(parts) == 3 and parts[0] == "stop":
                self.on_stop(parts[1], parts[2])

    def _send(self, message: dict) -> bool:
        with self.lock:
            if not self._ensure():
                return False
            try:
                self.proc.stdin.write(json.dumps(message) + "\n")
                self.proc.stdin.flush()
                return True
            except OSError:
                return False

    def show(self, app: str, name: str, label: str, session: str, rect: list[float]) -> bool:
        return self._send({"show": {"app": app, "name": name, "label": label, "session": session, "rect": rect}})

    def hide(self, app: str | None) -> None:
        if self.proc and self.proc.poll() is None:
            self._send({"hide": app})

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


def _main() -> None:
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("Gtk4LayerShell", "1.0")
    from gi.repository import Gdk, GLib, Gtk
    from gi.repository import Gtk4LayerShell as Layer

    banners: dict[str, Gtk.Window] = {}
    css = Gtk.CssProvider()
    css.load_from_string(
        ".pigna-cu { background: rgba(24,24,27,0.92); color: #fafafa; border-radius: 12px; padding: 6px 8px 6px 14px; border: 1px solid rgba(250,204,21,0.8); }"
        ".pigna-cu button { background: #dc2626; color: white; border-radius: 8px; padding: 2px 12px; }"
    )
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def monitor_for(rect):
        cx, cy = rect[0] + rect[2] / 2, rect[1] + rect[3] / 2
        monitors = Gdk.Display.get_default().get_monitors()
        for i in range(monitors.get_n_items()):
            mon = monitors.get_item(i)
            g = mon.get_geometry()
            if g.x <= cx < g.x + g.width and g.y <= cy < g.y + g.height:
                return mon
        return None

    def show(spec):
        app = spec["app"]
        old = banners.pop(app, None)
        if old:
            old.destroy()
        win = Gtk.Window()
        Layer.init_for_window(win)
        Layer.set_layer(win, Layer.Layer.OVERLAY)
        Layer.set_keyboard_mode(win, Layer.KeyboardMode.NONE)
        Layer.set_namespace(win, "pigna-computer-use")
        Layer.set_anchor(win, Layer.Edge.TOP, True)
        Layer.set_margin(win, Layer.Edge.TOP, 8)
        mon = monitor_for(spec["rect"])
        if mon is not None:
            Layer.set_monitor(win, mon)
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        box.add_css_class("pigna-cu")
        box.append(Gtk.Label(label=f"pi is using {spec['name']} for {spec['label']} (real mouse and keyboard)"))
        stop = Gtk.Button(label="Stop")
        stop.connect("clicked", lambda _b: print(f"stop {spec['session']} {app}", flush=True))
        box.append(stop)
        win.set_child(box)
        win.present()
        banners[app] = win

    def hide(app):
        for key in list(banners) if app is None else [app]:
            win = banners.pop(key, None)
            if win:
                win.destroy()

    def on_line(source, _cond):
        line = source.readline()
        if not line:
            loop.quit()
            return False
        try:
            message = json.loads(line)
        except ValueError:
            return True
        if "show" in message:
            show(message["show"])
        elif "hide" in message:
            hide(message["hide"])
        return True

    Gtk.init()
    loop = GLib.MainLoop()
    GLib.io_add_watch(sys.stdin, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_line)
    loop.run()


if __name__ == "__main__":
    _main()
