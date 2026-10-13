"""Windows through KWin scripts: list, activate, raise. A script answers by calling back into this helper over D-Bus
(KWin's `callDBus`), so a query takes one round trip instead of a journal read."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import uuid

import dbus
import dbus.service

IFACE = "io.github.pigna.ComputerUse"

# Window fields every query returns. Geometry is in the compositor's logical coordinates (what EIS takes).
WINDOW_JS = """
function info(w) {
  const c = w.clientGeometry, f = w.frameGeometry;
  return {
    uuid: w.internalId.toString(), pid: w.pid, caption: w.caption, desktopFile: w.desktopFileName || "",
    resourceClass: w.resourceClass || "", resourceName: w.resourceName || "",
    client: [c.x, c.y, c.width, c.height], frame: [f.x, f.y, f.width, f.height],
    minimized: w.minimized, active: workspace.activeWindow === w, normal: w.normalWindow, dialog: w.dialog,
    onCurrentDesktop: w.desktops.length === 0 || w.desktops.indexOf(workspace.currentDesktop) >= 0,
    transientFor: w.transientFor ? w.transientFor.internalId.toString() : null, skipTaskbar: w.skipTaskbar
  };
}
function windows() { return workspace.windowList().filter(w => (w.normalWindow || w.dialog) && !w.deleted).map(info); }
"""


class _Receiver(dbus.service.Object):
    def __init__(self, bus: dbus.Bus, path: str, kwin: "KWin") -> None:
        super().__init__(bus, path)
        self.kwin = kwin

    @dbus.service.method(IFACE, in_signature="ss", out_signature="")
    def Deliver(self, token: str, payload: str) -> None:  # noqa: N802 (D-Bus method name)
        self.kwin._delivered(str(token), str(payload))


class KWin:
    """Runs short KWin scripts and returns what they deliver. Needs the GLib main loop running (see __main__)."""

    def __init__(self, bus: dbus.Bus) -> None:
        self.bus = bus
        self.name = f"io.github.pigna.ComputerUse.p{os.getpid()}"
        self._bus_name = dbus.service.BusName(self.name, bus)
        self._receiver = _Receiver(bus, "/", self)
        self.scripting = dbus.Interface(bus.get_object("org.kde.KWin", "/Scripting"), "org.kde.kwin.Scripting")
        self.dir = tempfile.mkdtemp(prefix="pigna-cu-kwin-")
        self._waiting: dict[str, tuple[threading.Event, list[str]]] = {}
        self._lock = threading.Lock()

    def _delivered(self, token: str, payload: str) -> None:
        with self._lock:
            slot = self._waiting.get(token)
        if slot:
            slot[1].append(payload)
            slot[0].set()

    def run(self, body: str, timeout: float = 3.0):
        """Run `body` (JS that ends with `return <value>;` inside a function) and return the JSON value it produced."""
        token = uuid.uuid4().hex
        name = f"pigna-cu-{token[:12]}"
        path = os.path.join(self.dir, f"{name}.js")
        script = WINDOW_JS + f"""
(function() {{
  let value;
  try {{ value = {{ ok: (function() {{ {body} }})() }}; }} catch (e) {{ value = {{ error: String(e) }}; }}
  callDBus("{self.name}", "/", "{IFACE}", "Deliver", "{token}", JSON.stringify(value === undefined ? null : value));
}})();
"""
        with open(path, "w", encoding="utf-8") as file:
            file.write(script)
        event, box = threading.Event(), []
        with self._lock:
            self._waiting[token] = (event, box)
        try:
            script_id = int(self.scripting.loadScript(path, name, signature="ss"))
            script_obj = dbus.Interface(self.bus.get_object("org.kde.KWin", f"/Scripting/Script{script_id}"), "org.kde.kwin.Script")
            script_obj.run()
            if not event.wait(timeout):
                raise RuntimeError("KWin did not answer the window query in time")
        finally:
            with self._lock:
                self._waiting.pop(token, None)
            try:
                self.scripting.unloadScript(name)
            except dbus.DBusException:
                pass
            try:
                os.unlink(path)
            except OSError:
                pass
        result = json.loads(box[0]) if box else None
        if result is None:
            return None
        if "error" in result:
            raise RuntimeError(f"KWin script failed: {result['error']}")
        return result.get("ok")

    def windows(self) -> list[dict]:
        return self.run("return windows();")

    def activate(self, window_uuid: str) -> dict | None:
        """Bring a window to the front with keyboard focus (un-minimizing it and switching to its desktop)."""
        return self.run(
            f"""
const w = workspace.windowList().find(w => w.internalId.toString() === {json.dumps(window_uuid)});
if (!w) return null;
if (w.minimized) w.minimized = false;
if (w.desktops.length && w.desktops.indexOf(workspace.currentDesktop) < 0) workspace.currentDesktop = w.desktops[0];
workspace.activeWindow = w;
return info(w);
"""
        )

    def window(self, window_uuid: str) -> dict | None:
        return self.run(f"const w = workspace.windowList().find(w => w.internalId.toString() === {json.dumps(window_uuid)}); return w ? info(w) : null;")
