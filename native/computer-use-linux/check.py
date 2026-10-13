#!/usr/bin/env python3
"""End-to-end check of the Linux Computer Use helper against the real desktop (KDE Plasma on Wayland): starts the GTK
fixture and the helper, drives every protocol method through the helper's socket, and checks the results against what
the fixture reports itself (stdout events) and what KWin shows. Moves the real pointer and keyboard for a few seconds.

    python3 native/computer-use-linux/check.py [--interpreter ~/.pi-gna/computer-use/linux/pigna-computer-use]

Without the installed interpreter copy (authorized for window screenshots) the screenshot checks fail, which is the
point: a missing authorization must show. Exit code 0 only when every check passed.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP = "io.github.pigna.CuFixture"
results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> None:
    results.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name:<55} {detail}"[:220], flush=True)


class Fixture:
    def __init__(self) -> None:
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "fixture.py")], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.events: queue.Queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        for line in self.proc.stdout:
            try:
                self.events.put(json.loads(line))
            except ValueError:
                pass

    def drain(self) -> list[dict]:
        out = []
        while not self.events.empty():
            out.append(self.events.get())
        return out

    def wait(self, kind: str, timeout: float = 3.0) -> list[dict]:
        seen, deadline = [], time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                event = self.events.get(timeout=0.1)
            except queue.Empty:
                continue
            seen.append(event)
            if event["event"] == kind:
                time.sleep(0.2)
                return seen + self.drain()
        return seen


class Helper:
    def __init__(self, interpreter: str) -> None:
        self.dir = tempfile.mkdtemp(prefix="pigna-cu-check-")
        self.sock_path = os.path.join(self.dir, "cu.sock")
        self.token = secrets.token_hex(24)
        env = {**os.environ, "PYTHONHOME": "/usr"}
        self.proc = subprocess.Popen([interpreter, "-I", os.path.join(HERE, "pigna_cu", "__main__.py"), "--socket", self.sock_path, "--token", self.token, "--parent", str(os.getpid())], env=env, stderr=subprocess.DEVNULL)
        for _ in range(200):
            if os.path.exists(self.sock_path):
                break
            time.sleep(0.05)
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(self.sock_path)
        self.file = self.sock.makefile("rwb")
        self.notifications: list[dict] = []
        self.id = 0

    def call(self, method: str, **params) -> dict:
        self.id += 1
        self.file.write((json.dumps({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params}) + "\n").encode())
        self.file.flush()
        while True:
            message = json.loads(self.file.readline())
            if message.get("id") == self.id:
                return message
            self.notifications.append(message)


def index_of(text: str, needle: str) -> int:
    for line in text.splitlines():
        if needle in line and "[" in line:
            return int(line.split("[", 1)[1].split("]", 1)[0])
    raise AssertionError(f"{needle!r} not in the tree:\n{text}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--interpreter", default=os.path.expanduser("~/.pi-gna/computer-use/linux/pigna-computer-use"))
    args = parser.parse_args()
    interpreter = args.interpreter if os.path.exists(args.interpreter) else sys.executable
    if interpreter == sys.executable:
        print(f"note: {args.interpreter} is missing; using {sys.executable} (screenshots will be refused)")
    fixture = Fixture()
    time.sleep(2.0)
    helper = Helper(interpreter)
    try:
        hello = helper.call("hello", token=helper.token, protocol=1)["result"]
        check(hello["protocol"] == 1 and hello["permissions"]["accessibility"], "hello: protocol 1, accessibility", json.dumps(hello["permissions"]))
        check(hello["permissions"]["screenRecording"], "hello: KWin authorizes window screenshots")
        raw = socket.socket(socket.AF_UNIX)
        raw.connect(helper.sock_path)
        raw.sendall(b'{"jsonrpc":"2.0","id":1,"method":"list_apps","params":{}}\n')
        reply = json.loads(raw.makefile("rb").readline())
        check(reply.get("error", {}).get("code") == -32600, "a client without the token is refused", json.dumps(reply.get("error")))
        raw.close()

        apps = helper.call("list_apps")["result"]["apps"]
        mine = next((app for app in apps if app["id"] == APP), None)
        check(mine is not None and mine["isRunning"] and mine["windows"], "list_apps lists the fixture with its window")
        check(any(not app["isRunning"] for app in apps), "list_apps lists installed apps too")

        state = helper.call("get_app_state", app=APP)["result"]
        text = state["text"]
        check('label "Clicks: 0"' in text and "button \"Increment\"" in text, "get_app_state: indexed tree with labels", f"{state['elementCount']} elements")
        diff = helper.call("get_app_state", app=APP)["result"]
        check(diff["mode"] == "diff" and "(no changes)" in diff["text"], "a second read is a diff with no changes")

        fixture.drain()
        click = helper.call("click", app=APP, element_index=index_of(text, 'button "Increment"'))["result"]
        events = fixture.wait("clicked")
        check(click["method"] == "atspi" and any(e["event"] == "clicked" for e in events), "click by element: accessible action", json.dumps(click))

        click = helper.call("click", app=APP, element_index=index_of(text, 'check_box "Enable feature"'))["result"]
        events = fixture.wait("toggled")
        check(click["method"] == "eis" and any(e.get("active") is True for e in events), "click without an action: real pointer (EIS)", json.dumps(click))

        name = index_of(text, 'text "Name field"')
        result = helper.call("set_value", app=APP, element_index=name, value="set by check")
        events = fixture.wait("text")
        check("result" in result and any(e.get("value") == "set by check" for e in events), "set_value through accessibility")

        helper.call("click", app=APP, element_index=name)
        helper.call("press_key", app=APP, key="End")
        typed = helper.call("type_text", app=APP, text=" + Typed 1!")
        events = fixture.wait("text")
        time.sleep(0.4)
        events += fixture.drain()
        values = [e["value"] for e in events if e["event"] == "text"]
        check(values and values[-1] == "set by check + Typed 1!", "type_text with shifted characters (EIS)", repr(values[-1] if values else None) + " " + json.dumps(typed.get("result", typed.get("error"))))

        keys = helper.call("press_key", app=APP, key="ctrl+a BackSpace")
        events = fixture.wait("text")
        check(any(e.get("value") == "" for e in events), "press_key chords: ctrl+a then BackSpace", json.dumps(keys.get("result", keys.get("error"))))

        helper.call("set_value", app=APP, element_index=name, value="alpha beta gamma")
        fixture.drain()
        selected = helper.call("select_text", app=APP, element_index=name, text="beta")
        state = helper.call("get_app_state", app=APP)["result"]
        check(selected.get("result", {}).get("range") == [6, 4] and 'Selected text: "beta"' in state["text"], "select_text selects inside the field")

        scrolled = helper.call("scroll", app=APP, x=320, y=320, direction="down", pages=1)
        events = fixture.wait("scrolled")
        check(any(e["event"] == "scrolled" and e["value"] > 0 for e in events), "scroll at a screenshot point (EIS)", json.dumps(scrolled.get("result", scrolled.get("error"))))

        shot = helper.call("screenshot", app=APP)
        res = shot.get("result", {})
        check(res.get("width") == 640 and res.get("height") == 480 and len(res.get("jpeg", "")) > 1000, "screenshot: the window's client area", json.dumps({k: v for k, v in res.items() if k != "jpeg"} or shot.get("error")))

        unknown = helper.call("get_app_state", app="no.such.app")
        check(unknown.get("error", {}).get("code") == -32002, "an unknown app is app_not_found")
        stale = helper.call("click", app=APP, element_index=9999)
        check(stale.get("error", {}).get("code") == -32004, "a stale element index is refused")
        konsole = subprocess.run(["sh", "-c", "command -v konsole"], capture_output=True).returncode == 0
        if konsole:
            denied = helper.call("resolve_app", app="org.kde.konsole", launch=True)
            check(denied.get("error", {}).get("code") == -32007, "a terminal is denied before launch", json.dumps(denied.get("error")))
        bad_key = helper.call("press_key", app=APP, key="hyper+q")
        check(bad_key.get("error", {}).get("code") == -32008, "an unknown key is invalid params")

        shown = helper.call("overlay_show", app=APP, session="check-session", session_label="the check")
        check(shown.get("result", {}).get("overlay") is True, "overlay_show draws the banner")
        fixture.proc.terminate()
        # The helper looks for gone apps every 1.5 s; a ping afterwards collects the notifications sent meanwhile.
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not any(n.get("method") == "app_gone" for n in helper.notifications):
            time.sleep(1)
            helper.call("ping")
        gone = [n for n in helper.notifications if n.get("method") == "app_gone"]
        check(gone and gone[0]["params"] == {"app": APP, "session": "check-session"}, "app_gone when the held app closes", json.dumps(gone[:1]))
    finally:
        try:
            helper.call("shutdown")
        except Exception:  # noqa: BLE001
            pass
        if fixture.proc.poll() is None:
            fixture.proc.terminate()
    failed = [name for ok, name, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} of {len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
