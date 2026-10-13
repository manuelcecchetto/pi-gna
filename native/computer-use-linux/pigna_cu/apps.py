"""Apps on Linux: running ones are KWin windows grouped by their desktop file id; installed ones are desktop files.

An app's id plays the role of the macOS bundle id in protocol v1: the desktop file id (`org.kde.kcalc`), or, for an id
without a dot (`slack`), the file name (`slack.desktop`), so ids keep the reverse-DNS shape main validates.
"""

from __future__ import annotations

import time

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GioUnix", "2.0")
from gi.repository import Gio, GioUnix  # noqa: E402

TERMINAL = "Terminals can run anything; Computer Use never operates them"
SECURITY = "security and authentication prompts are never operated"
OWN = "pi-gna and its helper are never operated by the agent"
SHELL = "the desktop shell and lock screen are never operated"

# Desktop file ids (and resource classes) that no approval unlocks. Mirrored in src/shared/computer.ts.
DENIED = {
    **dict.fromkeys(["org.kde.konsole", "org.kde.yakuake", "kitty", "kitty.desktop", "alacritty", "alacritty.desktop", "Alacritty", "org.alacritty", "foot", "footclient", "org.codeberg.dnkl.foot", "org.wezfurlong.wezterm", "com.mitchellh.ghostty", "org.gnome.Terminal", "org.gnome.Console", "xterm", "xterm.desktop", "org.kde.cool-retro-term", "com.raggesilver.BlackBox", "io.elementary.terminal", "Terminator", "terminator", "terminator.desktop", "tilix", "com.gexperts.Tilix"], TERMINAL),
    **dict.fromkeys(["org.kde.polkit-kde-authentication-agent-1", "polkit-kde-authentication-agent-1", "org.kde.kwalletd6", "org.kde.kwalletmanager", "org.kde.kwalletmanager5", "kwalletd6", "org.kde.ksecretd", "pinentry-qt", "org.gnupg.pinentry-qt", "org.kde.kscreenlocker_greet", "kscreenlocker_greet", "org.kde.keditbookmarks.kwallet", "org.freedesktop.impl.portal.desktop.kde"], SECURITY),
    **dict.fromkeys(["pi-gna", "pi-gna.desktop", "io.github.manuelcecchetto.pigna", "io.github.manuelcecchetto.pigna.dev", "io.github.manuelcecchetto.pigna.computeruse"], OWN),
    **dict.fromkeys(["org.kde.plasmashell", "plasmashell", "org.kde.krunner", "org.kde.kwin", "kwin_wayland", "org.kde.ksmserver-logout-greeter"], SHELL),
}
DENIED_LOWER = {key.lower(): reason for key, reason in DENIED.items()}


def deny_reason(*ids: str) -> str | None:
    for value in ids:
        if value and value.lower() in DENIED_LOWER:
            return DENIED_LOWER[value.lower()]
    return None


def app_id(window: dict) -> str:
    raw = window.get("desktopFile") or window.get("resourceClass") or window.get("resourceName") or ""
    raw = raw.removesuffix(".desktop")
    return raw if "." in raw else f"{raw}.desktop"


def _info(desktop_id: str) -> GioUnix.DesktopAppInfo | None:
    name = desktop_id if desktop_id.endswith(".desktop") else f"{desktop_id}.desktop"
    try:
        return GioUnix.DesktopAppInfo.new(name)
    except Exception:  # noqa: BLE001
        return None


def display_name(window: dict) -> str:
    desktop = (window.get("desktopFile") or "").removesuffix(".desktop")
    info = _info(desktop) if desktop else None
    if info is not None and info.get_name():
        return info.get_name()
    return window.get("resourceClass") or window.get("caption") or app_id(window)


def running(windows: list[dict]) -> dict[str, dict]:
    """app id -> {id, name, pid, windows}, from KWin's windows (normal and dialog windows)."""
    apps: dict[str, dict] = {}
    for window in windows:
        aid = app_id(window)
        entry = apps.setdefault(aid, {"id": aid, "name": display_name(window), "pid": window["pid"], "windows": [], "classes": set()})
        entry["windows"].append(window)
        entry["classes"].update({window.get("resourceClass", ""), window.get("resourceName", ""), window.get("desktopFile", "")})
    return apps


def installed() -> list[dict]:
    """Launchable desktop apps (shown in menus)."""
    out = []
    for info in Gio.AppInfo.get_all():
        if not info.should_show():
            continue
        desktop = (info.get_id() or "").removesuffix(".desktop")
        if not desktop:
            continue
        out.append({"id": desktop if "." in desktop else f"{desktop}.desktop", "name": info.get_name() or desktop, "desktop": desktop})
    return out


def matches(query: str, aid: str, name: str, extra: set[str] | None = None) -> bool:
    q = query.strip().lower()
    candidates = {aid.lower(), aid.lower().removesuffix(".desktop"), name.lower(), *(c.lower() for c in (extra or set()) if c)}
    return q in candidates


def launch(desktop: str) -> int | None:
    """Start an installed app by desktop id; returns the launched pid when GIO reports one."""
    info = _info(desktop)
    if info is None:
        return None
    pids: list[int] = []
    context = Gio.AppLaunchContext()
    context.connect("launched", lambda _ctx, _info, data: pids.append(int(data.lookup_value("pid", None).get_int32())) if data and data.lookup_value("pid", None) else None)
    info.launch([], context)
    time.sleep(0.05)
    return pids[0] if pids else None
