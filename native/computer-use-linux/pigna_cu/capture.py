"""Window screenshots through KWin's ScreenShot2 (CaptureWindow). KWin answers only processes whose executable a
desktop file authorizes (X-KDE-DBUS-Restricted-Interfaces); the installer points one at this helper's own copy of the
interpreter, so no other Python program gains the right."""

from __future__ import annotations

import base64
import io
import os

import dbus
from PIL import Image

MAX_WIDTH = 1600.0


class CaptureError(RuntimeError):
    def __init__(self, message: str, unauthorized: bool = False) -> None:
        super().__init__(message)
        self.unauthorized = unauthorized


def _iface(bus: dbus.Bus) -> dbus.Interface:
    return dbus.Interface(bus.get_object("org.kde.KWin", "/org/kde/KWin/ScreenShot2"), "org.kde.KWin.ScreenShot2")


def authorized(bus: dbus.Bus) -> bool:
    """Whether KWin lets this process capture: an unknown window says "invalid window" only to an authorized caller."""
    read, write = os.pipe()
    try:
        _iface(bus).CaptureWindow("{00000000-0000-0000-0000-000000000000}", {}, dbus.types.UnixFd(write))
        return True
    except dbus.DBusException as error:
        return "NoAuthorized" not in (error.get_dbus_name() or "")
    finally:
        os.close(write)
        os.close(read)


def capture(bus: dbus.Bus, window_uuid: str) -> tuple[Image.Image, float]:
    """The window's client area at logical size, and the screenshot scale the tree coordinates use."""
    read, write = os.pipe()
    try:
        try:
            meta = _iface(bus).CaptureWindow(window_uuid, {"include-decoration": False, "include-shadow": False, "native-resolution": False}, dbus.types.UnixFd(write))
        except dbus.DBusException as error:
            name = error.get_dbus_name() or ""
            raise CaptureError(f"Window capture failed: {error.get_dbus_message()}", unauthorized="NoAuthorized" in name) from error
        finally:
            os.close(write)
        chunks = []
        while chunk := os.read(read, 1 << 20):
            chunks.append(chunk)
    finally:
        os.close(read)
    data = b"".join(chunks)
    width, height, stride = int(meta["width"]), int(meta["height"]), int(meta["stride"])
    # QImage formats 4-6 (RGB32, ARGB32, ARGB32 premultiplied) are B,G,R,A bytes on little-endian machines.
    image = Image.frombuffer("RGBA", (width, height), data, "raw", "BGRA", stride, 1).convert("RGB")
    scale = min(1.0, MAX_WIDTH / max(width, 1))
    if scale < 1:
        image = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS)
    return image, scale


def jpeg(image: Image.Image) -> str:
    out = io.BytesIO()
    image.save(out, "JPEG", quality=70)
    return base64.b64encode(out.getvalue()).decode("ascii")
