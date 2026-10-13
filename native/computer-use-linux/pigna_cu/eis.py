"""Real pointer and keyboard input through KWin's EIS server (libei over ctypes).

KWin hands an EIS socket to any session client through its private D-Bus interface
org.kde.KWin.EIS.RemoteDesktop.connectToEIS, without a portal dialog. Input lands on the real seat: the user's
pointer moves and keys go to the focused window, so callers activate the target window first (foreground mode).
Approach after isac322/kwin-mcp (MIT), src/kwin_mcp/input.py.
"""

from __future__ import annotations

import ctypes
import select
import time

import dbus

CAP_POINTER = 1 << 0
CAP_POINTER_ABSOLUTE = 1 << 1
CAP_KEYBOARD = 1 << 2
CAP_TOUCH = 1 << 3
CAP_SCROLL = 1 << 4
CAP_BUTTON = 1 << 5
ALL_CAPS = (CAP_POINTER, CAP_POINTER_ABSOLUTE, CAP_KEYBOARD, CAP_TOUCH, CAP_SCROLL, CAP_BUTTON)

EVENT_DISCONNECT = 2
EVENT_SEAT_ADDED = 3
EVENT_DEVICE_ADDED = 5
EVENT_DEVICE_REMOVED = 6
EVENT_DEVICE_PAUSED = 7
EVENT_DEVICE_RESUMED = 8

BTN = {"left": 0x110, "right": 0x111, "middle": 0x112}


class EisError(RuntimeError):
    pass


def _lib() -> ctypes.CDLL:
    lib = ctypes.CDLL("libei.so.1")
    p, i, u, d = ctypes.c_void_p, ctypes.c_int, ctypes.c_uint, ctypes.c_double
    sig = {
        "ei_new_sender": (p, [p]),
        "ei_configure_name": (None, [p, ctypes.c_char_p]),
        "ei_setup_backend_fd": (i, [p, i]),
        "ei_dispatch": (None, [p]),
        "ei_get_event": (p, [p]),
        "ei_get_fd": (i, [p]),
        "ei_unref": (p, [p]),
        "ei_event_get_type": (i, [p]),
        "ei_event_unref": (p, [p]),
        "ei_event_get_seat": (p, [p]),
        "ei_event_get_device": (p, [p]),
        "ei_seat_has_capability": (i, [p, u]),
        "ei_device_has_capability": (i, [p, u]),
        "ei_device_ref": (p, [p]),
        "ei_device_unref": (p, [p]),
        "ei_device_start_emulating": (None, [p, u]),
        "ei_device_stop_emulating": (None, [p]),
        "ei_device_frame": (None, [p, ctypes.c_uint64]),
        "ei_device_pointer_motion_absolute": (None, [p, d, d]),
        "ei_device_button_button": (None, [p, u, ctypes.c_bool]),
        "ei_device_scroll_discrete": (None, [p, i, i]),
        "ei_device_scroll_delta": (None, [p, d, d]),
        "ei_device_scroll_stop": (None, [p, ctypes.c_bool, ctypes.c_bool]),
        "ei_device_keyboard_key": (None, [p, u, ctypes.c_bool]),
    }
    for name, (restype, argtypes) in sig.items():
        fn = getattr(lib, name)
        fn.restype = restype
        fn.argtypes = argtypes
    return lib


class Eis:
    """One EIS connection with an absolute pointer and a keyboard, kept for the helper's lifetime."""

    def __init__(self, name: bytes = b"pi-gna Computer Use") -> None:
        self.lib = _lib()
        iface = dbus.Interface(dbus.SessionBus().get_object("org.kde.KWin", "/org/kde/KWin/EIS/RemoteDesktop"), "org.kde.KWin.EIS.RemoteDesktop")
        caps = CAP_POINTER | CAP_POINTER_ABSOLUTE | CAP_KEYBOARD | CAP_BUTTON | CAP_SCROLL
        try:
            fd, cookie = iface.connectToEIS(dbus.Int32(caps))
        except dbus.DBusException as error:
            raise EisError(f"KWin's input interface is unavailable: {error.get_dbus_message()}") from error
        self.iface, self.cookie = iface, int(cookie)
        self.ei = self.lib.ei_new_sender(None)
        self.lib.ei_configure_name(self.ei, name)
        if self.lib.ei_setup_backend_fd(self.ei, fd.take()) != 0:
            raise EisError("libei could not take KWin's input socket")
        self.pointer = 0
        self.keyboard = 0
        self.emulating: set[int] = set()
        self.lost = False
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not (self.pointer in self.emulating and self.keyboard in self.emulating):
            self._pump(0.2)
        if not self.pointer or not self.keyboard:
            raise EisError("KWin offered no absolute pointer or keyboard device")
        for device in (self.pointer, self.keyboard):
            if device not in self.emulating:
                self.lib.ei_device_start_emulating(device, 0)
                self.emulating.add(device)

    def _pump(self, timeout: float) -> None:
        fd = self.lib.ei_get_fd(self.ei)
        wait = timeout
        for _ in range(64):
            ready, _, _ = select.select([fd], [], [], wait)
            if ready:
                self.lib.ei_dispatch(self.ei)
            while event := self.lib.ei_get_event(self.ei):
                self._event(event)
            if not ready:
                return
            wait = 0

    def _event(self, event: int) -> None:
        lib = self.lib
        try:
            kind = lib.ei_event_get_type(event)
            if kind == EVENT_DISCONNECT:
                self.lost = True
            elif kind == EVENT_SEAT_ADDED:
                seat = lib.ei_event_get_seat(event)
                wanted = [ctypes.c_uint(cap) for cap in ALL_CAPS if lib.ei_seat_has_capability(seat, cap)]
                lib.ei_seat_bind_capabilities(ctypes.c_void_p(seat), *wanted, ctypes.c_void_p(None))
            elif kind == EVENT_DEVICE_ADDED:
                device = lib.ei_event_get_device(event)
                if lib.ei_device_has_capability(device, CAP_POINTER_ABSOLUTE) and not self.pointer:
                    self.pointer = lib.ei_device_ref(device)
                if lib.ei_device_has_capability(device, CAP_KEYBOARD) and not self.keyboard:
                    self.keyboard = lib.ei_device_ref(device)
            elif kind in (EVENT_DEVICE_REMOVED, EVENT_DEVICE_PAUSED, EVENT_DEVICE_RESUMED):
                device = lib.ei_event_get_device(event)
                if kind == EVENT_DEVICE_RESUMED:
                    if device in (self.pointer, self.keyboard) and device not in self.emulating:
                        lib.ei_device_start_emulating(device, 0)
                        self.emulating.add(device)
                else:
                    self.emulating.discard(device)
                    if kind == EVENT_DEVICE_REMOVED:
                        # KWin replaces a device on a layout or output change: take the next one offered.
                        if device == self.pointer:
                            self.pointer = 0
                        if device == self.keyboard:
                            self.keyboard = 0
        finally:
            lib.ei_event_unref(event)

    def _device(self, which: str) -> int:
        deadline = time.monotonic() + 1.5
        while True:
            self._pump(0)
            if self.lost:
                raise EisError("KWin closed the input connection")
            device = self.pointer if which == "pointer" else self.keyboard
            if device and device in self.emulating:
                return device
            if time.monotonic() > deadline:
                raise EisError(f"no usable {which} device from KWin")
            self._pump(0.1)

    def _frame(self, device: int) -> None:
        self.lib.ei_device_frame(device, int(time.monotonic() * 1_000_000))
        self.lib.ei_dispatch(self.ei)

    def move(self, x: float, y: float) -> None:
        device = self._device("pointer")
        self.lib.ei_device_pointer_motion_absolute(device, float(x), float(y))
        self._frame(device)

    def button(self, name: str, down: bool) -> None:
        device = self._device("pointer")
        self.lib.ei_device_button_button(device, BTN[name], down)
        self._frame(device)

    def click(self, x: float, y: float, name: str = "left", count: int = 1) -> None:
        self.move(x, y)
        time.sleep(0.03)
        for n in range(count):
            self.button(name, True)
            time.sleep(0.025)
            self.button(name, False)
            if n + 1 < count:
                time.sleep(0.06)

    def drag(self, x0: float, y0: float, x1: float, y1: float, steps: int = 12) -> None:
        self.move(x0, y0)
        time.sleep(0.03)
        self.button("left", True)
        for i in range(1, steps + 1):
            time.sleep(0.016)
            self.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
        time.sleep(0.05)
        self.button("left", False)

    def scroll(self, x: float, y: float, dx: int, dy: int) -> None:
        """dx/dy in wheel detents (positive dy scrolls down)."""
        self.move(x, y)
        device = self._device("pointer")
        self.lib.ei_device_scroll_discrete(device, dx * 120, dy * 120)
        self._frame(device)

    def key(self, code: int, down: bool) -> None:
        device = self._device("keyboard")
        self.lib.ei_device_keyboard_key(device, code, down)
        self._frame(device)

    def close(self) -> None:
        try:
            for device in (self.pointer, self.keyboard):
                if device:
                    self.lib.ei_device_unref(device)
            if self.ei:
                self.lib.ei_unref(self.ei)
            self.iface.disconnect(dbus.Int32(self.cookie))
        except Exception:  # noqa: BLE001 (closing on the way out)
            pass
