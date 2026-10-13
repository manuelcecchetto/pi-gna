"""pi-gna Computer Use helper for Linux (KDE Plasma on Wayland). Speaks protocol v1 (src/shared/computer.ts):
newline-delimited JSON-RPC 2.0 over a Unix socket, `hello` with the launch token first, main as the only client.

Unlike the macOS helper it works in the foreground: pointer and keyboard input go through KWin's EIS server onto the
real seat, so an action raises and focuses the target window and moves the user's pointer. Reading (accessibility
tree, window screenshots, accessibility actions) does not take the foreground.

Run: <interpreter copy> -I pigna_cu/__main__.py --socket <path> --token <hex> --parent <pid>
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import platform
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dbus  # noqa: E402
import dbus.mainloop.glib  # noqa: E402
from gi.repository import GLib  # noqa: E402

PROTOCOL = 1
# Bumped when the helper's behaviour changes; main reinstalls only a newer version (src/main/computer/linux.ts).
HELPER_VERSION = 3

ERR = {
    "permission": -32001, "app": -32002, "window": -32003, "stale": -32004, "failed": -32005,
    "cancelled": -32006, "denied": -32007, "params": -32008, "timeout": -32010, "background": -32011,
}
SETTLE_S = 0.35


class RpcError(Exception):
    def __init__(self, kind: str, message: str, data: dict | None = None) -> None:
        super().__init__(message)
        self.code = ERR[kind]
        self.message = message
        self.data = data


dbus.mainloop.glib.threads_init()
dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

from pigna_cu import apps, capture, keys, tree  # noqa: E402
from pigna_cu.eis import Eis, EisError  # noqa: E402
from pigna_cu.kwin import KWin  # noqa: E402
from pigna_cu.overlay import Overlay  # noqa: E402

import gi  # noqa: E402

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


class Helper:
    def __init__(self, notify) -> None:
        self.bus = dbus.SessionBus()
        self.kwin = KWin(self.bus)
        self.notify = notify
        self._eis: Eis | None = None
        self.window_ids: dict[str, int] = {}
        self.window_uuids: dict[int, str] = {}
        self.scales: dict[str, float] = {}
        # app id -> {session, name}, while its overlay is up
        self.held: dict[str, dict] = {}
        self.overlay = Overlay(sys.executable, self._stopped)

    # ---- helpers ------------------------------------------------------------------------------------------------

    @property
    def eis(self) -> Eis:
        if self._eis is None or self._eis.lost:
            try:
                self._eis = Eis()
            except EisError as error:
                raise RpcError("failed", f"Input is unavailable: {error}") from error
        return self._eis

    def wid(self, window: dict) -> int:
        uuid = window["uuid"]
        if uuid not in self.window_ids:
            number = len(self.window_ids) + 1
            self.window_ids[uuid] = number
            self.window_uuids[number] = uuid
        return self.window_ids[uuid]

    def _stopped(self, session: str, app: str) -> None:
        self.held.pop(app, None)
        self.overlay.hide(app)
        self.notify("cancelled", {"app": app, "session": session, "reason": "esc"})

    def target(self, params: dict) -> dict:
        """The running app named by params["app"] (a name, an id, or {bundleId, pid})."""
        query = params.get("app")
        if isinstance(query, dict):
            query = query.get("bundleId")
        if not isinstance(query, str) or not query.strip():
            raise RpcError("params", "app (name, id or {bundleId}) is required")
        running = apps.running(self.kwin.windows())
        for entry in running.values():
            if apps.matches(query, entry["id"], entry["name"], entry["classes"]):
                reason = apps.deny_reason(entry["id"], *entry["classes"])
                if reason:
                    raise RpcError("denied", f"{entry['name']} cannot be controlled: {reason}.")
                return entry
        raise RpcError("app", f'No running app named "{query}". Call list_apps for the names.')

    def window(self, entry: dict, params: dict) -> dict:
        wanted = params.get("window_id")
        windows = entry["windows"]
        if wanted is not None:
            uuid = self.window_uuids.get(int(wanted))
            for window in windows:
                if window["uuid"] == uuid:
                    return window
            raise RpcError("window", f"Window {wanted} was not found. Call list_apps for current window ids.")
        normal = [w for w in windows if w["normal"]] or windows
        for window in normal:
            if window["active"]:
                return window
        visible = [w for w in normal if not w["minimized"] and w["onCurrentDesktop"]] or normal
        if not visible:
            raise RpcError("window", "The app has no window.")
        return max(visible, key=lambda w: w["client"][2] * w["client"][3])

    def foreground(self, window: dict) -> dict:
        """Raise and focus the window before real input; returns its fresh geometry."""
        if not window["active"] or window["minimized"]:
            fresh = self.kwin.activate(window["uuid"])
            if fresh is None:
                raise RpcError("window", "The window closed.")
            time.sleep(0.15)
            window = self.kwin.window(window["uuid"]) or fresh
            if not window["active"]:
                raise RpcError("failed", f"KWin did not give {window['caption']!r} the keyboard focus.")
        return window

    def scale(self, window: dict) -> float:
        return self.scales.get(window["uuid"]) or min(1.0, capture.MAX_WIDTH / max(window["client"][2], 1))

    def element(self, entry: dict, params: dict) -> tree.Element:
        index = params.get("element_index")
        if not isinstance(index, (int, float)):
            raise RpcError("params", "element_index is required")
        element = tree.cached(entry["id"], int(index))
        if element is None:
            raise RpcError("stale", f"Element {int(index)} is not in the latest state of {entry['name']}. Call get_app_state again.")
        return element

    def screen_point(self, window: dict, wx: float, wy: float) -> tuple[float, float]:
        cx, cy, cw, ch = window["client"]
        if not (0 <= wx <= cw and 0 <= wy <= ch):
            raise RpcError("params", "The point is outside the window.")
        return cx + wx, cy + wy

    def point(self, entry: dict, window: dict, params: dict, xkey: str = "x", ykey: str = "y") -> tuple[float, float]:
        """A screen point from element_index (its centre) or from screenshot coordinates."""
        if params.get("element_index") is not None and xkey == "x":
            element = self.element(entry, params)
            x, y, w, h = element.frame
            if w <= 0 or h <= 0:
                raise RpcError("failed", f"Element {params['element_index']} has no position on screen.")
            return self.screen_point(window, x + w / 2, y + h / 2)
        x, y = params.get(xkey), params.get(ykey)
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            raise RpcError("params", f"element_index or {xkey},{ykey} is required")
        scale = self.scale(window)
        return self.screen_point(window, x / scale, y / scale)

    def focused_element(self, window: dict) -> Atspi.Accessible | None:
        app = tree.app_for_pid(window["pid"])
        top = tree.window_accessible(app, window["caption"]) if app else None
        if top is None:
            return None
        stack, seen = [top], 0
        while stack and seen < 4000:
            acc = stack.pop()
            seen += 1
            try:
                states = acc.get_state_set()
                # Hidden widgets can keep a stale FOCUSED state (KCalc's numeral-base list); only shown ones count.
                if acc is not top and not states.contains(Atspi.StateType.SHOWING):
                    continue
                if states.contains(Atspi.StateType.FOCUSED) and acc is not top:
                    return acc
                count = acc.get_child_count()
            except Exception:  # noqa: BLE001
                continue
            for i in range(min(count, 2000)):
                child = acc.get_child_at_index(i)
                if child is not None:
                    stack.append(child)
        return None

    def _editable_text(self, acc: Atspi.Accessible | None) -> str | None:
        """The text of an editable, focused text element, or None for anything else."""
        try:
            if acc is None or not acc.is_text() or not acc.get_state_set().contains(Atspi.StateType.EDITABLE):
                return None
            return Atspi.Text.get_text(acc, 0, -1)
        except Exception:  # noqa: BLE001
            return None

    def describe(self, acc: Atspi.Accessible | None) -> str | None:
        if acc is None:
            return None
        try:
            name = tree.label(acc)
            return f'{acc.get_role_name().replace(" ", "_")}{f" {json.dumps(tree.clip(name, 60))}" if name else ""}'
        except Exception:  # noqa: BLE001
            return None

    def chord(self, spec: str) -> None:
        try:
            mods, code, shift = keys.chord(spec)
        except keys.KeyError_ as error:
            raise RpcError("params", str(error)) from error
        eis = self.eis
        pressed = [*mods, *([42] if shift else [])]
        for mod in pressed:
            eis.key(mod, True)
            time.sleep(0.015)
        eis.key(code, True)
        time.sleep(0.02)
        eis.key(code, False)
        for mod in reversed(pressed):
            time.sleep(0.015)
            eis.key(mod, False)

    def type_keys(self, text: str) -> None:
        # Pauses around Shift: without them a toolkit could still see Shift on the next key (observed in KCalc:
        # "9*9=" arrived as "9×" and the second 9 was lost).
        eis = self.eis
        for char in text:
            code, shift = keys.CHARS[char]
            if shift:
                eis.key(42, True)
                time.sleep(0.015)
            eis.key(code, True)
            time.sleep(0.01)
            eis.key(code, False)
            if shift:
                time.sleep(0.015)
                eis.key(42, False)
            time.sleep(0.02)

    def finish(self, result: dict) -> dict:
        time.sleep(SETTLE_S)
        return {"settled": True, **result}

    # ---- methods ------------------------------------------------------------------------------------------------

    def permissions(self, _params: dict | None = None) -> dict:
        accessibility = False
        try:
            status = dbus.Interface(self.bus.get_object("org.a11y.Bus", "/org/a11y/bus"), "org.freedesktop.DBus.Properties")
            accessibility = bool(status.Get("org.a11y.Status", "IsEnabled")) and Atspi.get_desktop(0) is not None
        except dbus.DBusException:
            pass
        return {"accessibility": accessibility, "screenRecording": capture.authorized(self.bus)}

    def request_permissions(self, _params: dict) -> dict:
        try:
            status = dbus.Interface(self.bus.get_object("org.a11y.Bus", "/org/a11y/bus"), "org.freedesktop.DBus.Properties")
            if not bool(status.Get("org.a11y.Status", "IsEnabled")):
                status.Set("org.a11y.Status", "IsEnabled", dbus.Boolean(True))
        except dbus.DBusException:
            pass
        return self.permissions()

    def open_settings(self, params: dict) -> dict:
        if params.get("pane") == "accessibility":
            subprocess.Popen(["systemsettings", "kcm_access"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        return {}

    def list_apps(self, _params: dict) -> dict:
        running = apps.running(self.kwin.windows())
        out = []
        for entry in running.values():
            out.append({"id": entry["id"], "bundleId": entry["id"], "displayName": entry["name"], "isRunning": True, "pid": entry["pid"],
                        "windows": [{"id": self.wid(w), "title": w["caption"]} for w in entry["windows"]]})
        seen = set(running)
        for info in apps.installed():
            if info["id"] not in seen:
                seen.add(info["id"])
                out.append({"id": info["id"], "bundleId": info["id"], "displayName": info["name"], "isRunning": False})
        return {"apps": out}

    def resolve_app(self, params: dict) -> dict:
        query = params.get("app")
        if not isinstance(query, str) or not query.strip():
            raise RpcError("params", "app is required")
        try:
            entry = self.target({"app": query})
            return {"bundleId": entry["id"], "displayName": entry["name"], "pid": entry["pid"]}
        except RpcError as error:
            if error.code != ERR["app"] or not params.get("launch"):
                raise
        match = next((info for info in apps.installed() if apps.matches(query, info["id"], info["name"], {info["desktop"]})), None)
        if match is None:
            raise RpcError("app", f'No app named "{query}". Call list_apps for the names.')
        reason = apps.deny_reason(match["id"], match["desktop"])
        if reason:
            raise RpcError("denied", f"{match['name']} cannot be controlled: {reason}.")
        apps.launch(match["desktop"])
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            time.sleep(0.4)
            for entry in apps.running(self.kwin.windows()).values():
                if entry["id"] == match["id"] or apps.matches(query, entry["id"], entry["name"], entry["classes"]):
                    time.sleep(0.6)  # let it build its accessibility tree
                    return {"bundleId": entry["id"], "displayName": entry["name"], "pid": entry["pid"]}
        raise RpcError("timeout", f"{match['name']} did not open a window in time.")

    def get_app_state(self, params: dict) -> dict:
        entry = self.target(params)
        window = self.window(entry, params)
        app = tree.app_for_pid(window["pid"])
        top = tree.window_accessible(app, window["caption"]) if app else None
        if top is None:
            raise RpcError("failed", f"{entry['name']} exposes no accessibility tree.")
        tree.wake(app, top)
        scale = min(1.0, capture.MAX_WIDTH / max(window["client"][2], 1))
        self.scales[window["uuid"]] = scale
        result = tree.read(entry["id"], entry["name"], window, top, scale, bool(params.get("disable_diff")))
        result.update({"bundleId": entry["id"], "pid": entry["pid"], "windowId": self.wid(window),
                       "note": "Element indexes are valid only until the next get_app_state; read state again before using an index from an older read."})
        return result

    def screenshot(self, params: dict) -> dict:
        entry = self.target(params)
        window = self.window(entry, params)
        try:
            image, scale = capture.capture(self.bus, window["uuid"])
        except capture.CaptureError as error:
            if error.unauthorized:
                raise RpcError("permission", "KWin does not let the helper capture windows (its desktop file is missing).", {"missing": ["screen_recording"]}) from error
            raise RpcError("failed", str(error)) from error
        self.scales[window["uuid"]] = scale
        return {"jpeg": capture.jpeg(image), "width": image.width, "height": image.height, "scale": scale, "windowId": self.wid(window)}

    def overlay_show(self, params: dict) -> dict:
        entry = self.target(params)
        window = self.window(entry, params)
        session, label = str(params.get("session") or ""), str(params.get("session_label") or "a chat")
        self.held[entry["id"]] = {"session": session, "name": entry["name"]}
        shown = self.overlay.show(entry["id"], entry["name"], label, session, window["frame"])
        return {"overlay": shown}

    def overlay_hide(self, params: dict) -> dict:
        query = params.get("app")
        if isinstance(query, dict):
            query = query.get("bundleId")
        if query:
            for aid in [aid for aid in self.held if apps.matches(query, aid, self.held[aid]["name"])]:
                self.held.pop(aid, None)
                self.overlay.hide(aid)
            self.overlay.hide(query)
        else:
            self.held.clear()
            self.overlay.hide(None)
        return {}

    def click(self, params: dict) -> dict:
        entry = self.target(params)
        window = self.window(entry, params)
        button = params.get("mouse_button", "left")
        if button not in ("left", "right", "middle"):
            raise RpcError("params", "mouse_button must be left, right or middle")
        count = max(1, min(3, int(params.get("click_count") or 1)))
        if params.get("element_index") is not None and button == "left" and count == 1:
            element = self.element(entry, params)
            # Text fields take a real click (it places the caret); other controls take their accessible action.
            if element.role not in tree.TEXT_ENTRY_ROLES:
                names = [n.lower() for n in tree.action_names(element.acc)]
                for wanted in ("click", "press", "activate", "toggle", "jump", "open"):
                    if wanted in names and tree.do_action(element.acc, wanted):
                        return self.finish({"method": "atspi", "action": wanted})
        window = self.foreground(window)
        x, y = self.point(entry, window, params)
        self.eis.click(x, y, button, count)
        return self.finish({"method": "eis"})

    def drag(self, params: dict) -> dict:
        entry = self.target(params)
        window = self.foreground(self.window(entry, params))
        x0, y0 = self.point(entry, window, params, "from_x", "from_y")
        x1, y1 = self.point(entry, window, params, "to_x", "to_y")
        self.eis.drag(x0, y0, x1, y1)
        return self.finish({"method": "eis"})

    def scroll(self, params: dict) -> dict:
        entry = self.target(params)
        direction = params.get("direction")
        if direction not in ("up", "down", "left", "right"):
            raise RpcError("params", "direction must be up, down, left or right")
        pages = max(0.1, min(20.0, float(params.get("pages") or 1)))
        window = self.foreground(self.window(entry, params))
        if params.get("element_index") is not None or params.get("x") is not None:
            x, y = self.point(entry, window, params)
        else:
            cx, cy, cw, ch = window["client"]
            x, y = cx + cw / 2, cy + ch / 2
        extent = window["client"][3] if direction in ("up", "down") else window["client"][2]
        detents = max(1, min(200, round(pages * extent * 0.9 / 50)))
        dx = detents if direction == "right" else -detents if direction == "left" else 0
        dy = detents if direction == "down" else -detents if direction == "up" else 0
        self.eis.scroll(x, y, dx, dy)
        return self.finish({"method": "eis", "detents": detents})

    def press_key(self, params: dict) -> dict:
        entry = self.target(params)
        spec = params.get("key")
        if not isinstance(spec, str) or not spec.strip():
            raise RpcError("params", "key is required")
        for part in spec.split():
            try:
                keys.chord(part)
            except keys.KeyError_ as error:
                raise RpcError("params", str(error)) from error
        window = self.foreground(self.window(entry, params))
        for part in spec.split():
            self.chord(part)
            time.sleep(0.03)
        result = {"method": "eis"}
        target = self.describe(self.focused_element(window))
        if target:
            result["target"] = target
        return self.finish(result)

    def type_text(self, params: dict) -> dict:
        entry = self.target(params)
        text = params.get("text")
        if not isinstance(text, str):
            raise RpcError("params", "text is required")
        window = self.foreground(self.window(entry, params))
        focused = self.focused_element(window)
        result: dict = {}
        if keys.typeable(text) and layout_is_us():
            before = self._editable_text(focused)
            self.type_keys(text)
            result["method"] = "eis"
            # Real keys can be lost (the user moved focus meanwhile): a text field that kept its text did not get them.
            if before is not None and text.strip():
                time.sleep(0.15)
                if self._editable_text(focused) == before:
                    raise RpcError("failed", f"Typing had no effect: {self.describe(focused)} kept its text. Click the field and type again, or use set_value.")
        else:
            if focused is not None and focused.is_editable_text():
                caret = Atspi.Text.get_caret_offset(focused) if focused.is_text() else 0
                if not Atspi.EditableText.insert_text(focused, max(caret, 0), text, len(text)):
                    raise RpcError("failed", "The focused element refused the inserted text.")
                result["method"] = "atspi_insert"
            else:
                self._paste(text, "text")
                result["method"] = "paste"
        target = self.describe(focused)
        if target:
            result["target"] = target
        return self.finish(result)

    def set_value(self, params: dict) -> dict:
        entry = self.target(params)
        element = self.element(entry, params)
        value = params.get("value")
        if not isinstance(value, str):
            raise RpcError("params", "value (string) is required")
        if element.role == "password text":
            raise RpcError("denied", "Password fields cannot be set; hand them to the user.")
        acc = element.acc
        if acc.is_editable_text():
            if not Atspi.EditableText.set_text_contents(acc, value):
                raise RpcError("failed", f"Element {params['element_index']} refused the new text.")
            return self.finish({"method": "atspi"})
        if acc.is_value():
            try:
                ok = Atspi.Value.set_current_value(acc, float(value))
            except ValueError as error:
                raise RpcError("params", "This element takes a number.") from error
            if not ok:
                raise RpcError("failed", f"Element {params['element_index']} refused the value.")
            return self.finish({"method": "atspi"})
        raise RpcError("failed", f"Element {params['element_index']} has a read-only value; it is not marked settable in the tree.")

    def select_text(self, params: dict) -> dict:
        entry = self.target(params)
        element = self.element(entry, params)
        kind = params.get("selection_type", "text")
        if kind not in ("text", "cursor_before", "cursor_after"):
            raise RpcError("params", "selection_type must be text, cursor_before or cursor_after")
        needle = params.get("text")
        if not isinstance(needle, str) or not needle:
            raise RpcError("params", "text is required")
        acc = element.acc
        content = tree.text_of(acc)
        if content is None:
            raise RpcError("failed", f"Element {params['element_index']} has no text value.")
        prefix, suffix = params.get("prefix") or "", params.get("suffix") or ""
        at = content.find(prefix + needle + suffix)
        if at < 0:
            raise RpcError("failed", f'The text "{needle}" was not found in element {params["element_index"]}.')
        start = at + len(prefix)
        end = start + len(needle)
        try:
            if acc.is_component():
                Atspi.Component.grab_focus(acc)
        except Exception:  # noqa: BLE001 (GTK 4 refuses grab_focus; the selection still applies)
            pass
        if kind == "text":
            ok = Atspi.Text.set_selection(acc, 0, start, end) if Atspi.Text.get_n_selections(acc) else Atspi.Text.add_selection(acc, start, end)
            span = [start, end - start]
        else:
            ok = Atspi.Text.set_caret_offset(acc, start if kind == "cursor_before" else end)
            span = [start if kind == "cursor_before" else end, 0]
        if not ok:
            raise RpcError("failed", "Selecting the text failed.")
        return self.finish({"method": "atspi", "range": span})

    def perform_secondary_action(self, params: dict) -> dict:
        entry = self.target(params)
        element = self.element(entry, params)
        action = params.get("action")
        if not isinstance(action, str) or not action:
            raise RpcError("params", "action is required")
        names = tree.action_names(element.acc)
        if action.lower() not in [n.lower() for n in names]:
            raise RpcError("failed", f'Element {params["element_index"]} does not expose "{action}". Exposed actions: {", ".join(names) or "none"}.', {"actions": names})
        if not tree.do_action(element.acc, action):
            raise RpcError("failed", f"Action {action} failed.")
        return self.finish({"method": "atspi"})

    def _paste(self, text: str, fmt: str) -> None:
        saved = subprocess.run(["wl-paste", "--no-newline"], capture_output=True, timeout=3).stdout if fmt else b""
        mime = ["--type", "text/html"] if fmt == "html" else []
        subprocess.run(["wl-copy", *mime], input=text.encode(), timeout=3, check=True)
        time.sleep(0.1)
        self.chord("ctrl+v")
        time.sleep(0.3)
        # Restore the user's text clipboard (a non-text clipboard is not restored).
        if saved:
            subprocess.run(["wl-copy"], input=saved, timeout=3)

    def paste(self, params: dict) -> dict:
        entry = self.target(params)
        text = params.get("text")
        if not isinstance(text, str):
            raise RpcError("params", "text is required")
        fmt = params.get("format", "text")
        if fmt not in ("text", "md", "html"):
            raise RpcError("params", "format must be text, md or html")
        window = self.foreground(self.window(entry, params))
        self._paste(text, fmt)
        result = {"method": "clipboard"}
        target = self.describe(self.focused_element(window))
        if target:
            result["target"] = target
        return self.finish(result)

    def ping(self, _params: dict) -> dict:
        return {}

    # Held apps that lost every window: tell main (app_gone) and drop the banner.
    def watch(self) -> None:
        while True:
            time.sleep(1.5)
            if not self.held:
                continue
            try:
                running = apps.running(self.kwin.windows())
            except Exception:  # noqa: BLE001
                continue
            for aid, held in list(self.held.items()):
                if aid not in running:
                    self.held.pop(aid, None)
                    self.overlay.hide(aid)
                    tree.forget(aid)
                    self.notify("app_gone", {"app": aid, "session": held["session"]})


def layout_is_us() -> bool:
    try:
        out = subprocess.run(["kreadconfig6", "--file", "kxkbrc", "--group", "Layout", "--key", "LayoutList"], capture_output=True, text=True, timeout=2).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return True
    return out == "" or out.split(",")[0].strip() == "us"


METHODS = ("permissions", "request_permissions", "open_settings", "list_apps", "resolve_app", "get_app_state", "screenshot", "overlay_show", "overlay_hide",
           "click", "drag", "scroll", "press_key", "type_text", "set_value", "select_text", "perform_secondary_action", "paste", "ping")


def serve(path: str, token: str, parent: int) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    if os.path.exists(path):
        os.unlink(path)
    listener.bind(path)
    os.chmod(path, 0o600)
    listener.listen(1)
    send_lock = threading.Lock()
    clients: list[socket.socket] = []

    def send(conn: socket.socket, message: dict) -> None:
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        with send_lock:
            try:
                conn.sendall(data)
            except OSError:
                pass

    def notify(method: str, params: dict) -> None:
        for conn in list(clients):
            send(conn, {"jsonrpc": "2.0", "method": method, "params": params})

    loop = GLib.MainLoop()
    threading.Thread(target=loop.run, daemon=True).start()
    helper = Helper(notify)
    threading.Thread(target=helper.watch, daemon=True).start()
    work: queue.Queue = queue.Queue()

    def worker() -> None:
        while True:
            conn, rid, method, params = work.get()
            try:
                result = getattr(helper, method)(params)
                send(conn, {"jsonrpc": "2.0", "id": rid, "result": result})
            except RpcError as error:
                body = {"code": error.code, "message": error.message}
                if error.data:
                    body["data"] = error.data
                send(conn, {"jsonrpc": "2.0", "id": rid, "error": body})
            except Exception as error:  # noqa: BLE001 (report, keep serving)
                traceback.print_exc()
                send(conn, {"jsonrpc": "2.0", "id": rid, "error": {"code": ERR["failed"], "message": f"{type(error).__name__}: {error}"}})

    threading.Thread(target=worker, daemon=True).start()

    def watchdog() -> None:
        while True:
            time.sleep(2)
            try:
                os.kill(parent, 0)
            except OSError:
                shutdown()

    def shutdown() -> None:
        helper.overlay.close()
        shutil.rmtree(helper.kwin.dir, ignore_errors=True)
        if helper._eis:
            helper._eis.close()
        try:
            os.unlink(path)
        except OSError:
            pass
        os._exit(0)

    if parent > 0:
        threading.Thread(target=watchdog, daemon=True).start()

    def handle(conn: socket.socket) -> None:
        authed = False
        buffer = b""
        while True:
            try:
                chunk = conn.recv(65536)
            except OSError:
                chunk = b""
            if not chunk:
                if conn in clients:
                    clients.remove(conn)
                conn.close()
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    send(conn, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                    continue
                rid, method, params = message.get("id"), message.get("method"), message.get("params") or {}
                if not authed:
                    given = params.get("token") if method == "hello" and isinstance(params.get("token"), str) else ""
                    if not hmac.compare_digest(given.encode(), token.encode()):
                        send(conn, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32600, "message": "unauthorized"}})
                        conn.close()
                        return
                    authed = True
                    clients.append(conn)
                    send(conn, {"jsonrpc": "2.0", "id": rid, "result": {"helperVersion": HELPER_VERSION, "protocol": PROTOCOL, "os": f"{platform.system()} {platform.release()}",
                                                                       "arch": platform.machine(), "pid": os.getpid(), "permissions": helper.permissions()}})
                    continue
                if method == "hello":
                    send(conn, {"jsonrpc": "2.0", "id": rid, "result": {"protocol": PROTOCOL}})
                elif method == "shutdown":
                    send(conn, {"jsonrpc": "2.0", "id": rid, "result": {}})
                    shutdown()
                elif method in METHODS:
                    work.put((conn, rid, method, params))
                else:
                    send(conn, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"method not found: {method}"}})

    while True:
        conn, _ = listener.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--parent", type=int, default=0)
    args = parser.parse_args()
    serve(args.socket, args.token, args.parent)


if __name__ == "__main__":
    main()
