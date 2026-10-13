"""get_app_state: the window's accessibility tree (AT-SPI) as indexed text, with diffs against the previous read, the
same shape as the macOS helper's (native/computer-use/Sources/AXTree.swift).

On Wayland toolkits report element positions relative to their window (screen positions are not known to clients),
so frames are read in WINDOW coordinates and mapped to the screen through KWin's client geometry of that window.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

MAX_ELEMENTS = 1500
MAX_DEPTH = 40
MAX_TEXT = 60_000

LAYOUT_ROLES = {"panel", "filler", "section", "unknown", "redundant object", "layered pane", "viewport", "scroll pane", "split pane", "grouping", "html container", "invalid"}
VALUE_TEXT_ROLES = {"text", "entry", "password text", "terminal", "editbar", "paragraph", "static", "label", "combo box", "spin button"}
UNLABELED_FRAME_ROLES = {"image", "push button", "button", "toggle button", "check box", "radio button", "icon", "menu button"}
TEXT_ENTRY_ROLES = {"text", "entry", "password text", "editbar", "combo box", "spin button", "document text", "terminal"}


@dataclass
class Element:
    acc: Atspi.Accessible
    frame: tuple[float, float, float, float]  # window coordinates (logical px)
    role: str
    label: str


@dataclass
class AppCache:
    elements: dict[int, Element] = field(default_factory=dict)
    window_uuid: str | None = None
    lines: dict[str, str] = field(default_factory=dict)
    order: list[str] = field(default_factory=list)
    revision: int = 0


caches: dict[str, AppCache] = {}
lock = threading.Lock()


def clip(text: str, limit: int) -> str:
    flat = text.replace("\n", "⏎")
    return flat[:limit] + "…" if len(flat) > limit else flat


def app_for_pid(pid: int) -> Atspi.Accessible | None:
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        try:
            if app is not None and app.get_process_id() == pid:
                return app
        except Exception:  # noqa: BLE001 (an app that went away mid-listing)
            continue
    return None


def _states(acc: Atspi.Accessible) -> Atspi.StateSet | None:
    try:
        return acc.get_state_set()
    except Exception:  # noqa: BLE001
        return None


def wake(app: Atspi.Accessible, top: Atspi.Accessible) -> None:
    """Chromium and Electron build their web tree only for a client that reads accessible attributes (atk_util_auralinux:
    ACCESSIBILITY_ENABLED=1 at launch does it too); a first read of a bare frame waits for the tree to appear."""
    try:
        if (app.get_toolkit_name() or "") != "Chromium":
            return
        bare = top.get_child_count() <= 1 and all((top.get_child_at_index(i) is None or top.get_child_at_index(i).get_child_count() == 0) for i in range(top.get_child_count()))
        for acc in (app, top):
            acc.get_attributes()
            acc.get_relation_set()
    except Exception:  # noqa: BLE001
        return
    if bare:
        import time

        time.sleep(0.6)


def window_accessible(app: Atspi.Accessible, caption: str) -> Atspi.Accessible | None:
    """The app's top-level accessible for the KWin window: same title, else the active one, else the first."""
    tops = []
    for i in range(app.get_child_count()):
        child = app.get_child_at_index(i)
        if child is not None:
            tops.append(child)
    for top in tops:
        try:
            if (top.get_name() or "") == caption:
                return top
        except Exception:  # noqa: BLE001
            continue
    for top in tops:
        states = _states(top)
        if states and states.contains(Atspi.StateType.ACTIVE):
            return top
    # Chromium names its frame after the page title, which KWin may show with an app suffix.
    for top in tops:
        name = top.get_name() or ""
        if name and (name in caption or caption in name):
            return top
    return tops[0] if tops else None


def extents(acc: Atspi.Accessible) -> tuple[float, float, float, float] | None:
    try:
        rect = acc.get_extents(Atspi.CoordType.WINDOW)
    except Exception:  # noqa: BLE001 (no Component interface)
        return None
    return (rect.x, rect.y, rect.width, rect.height)


def label(acc: Atspi.Accessible) -> str:
    for getter in ("get_name", "get_description"):
        try:
            value = getattr(acc, getter)() or ""
        except Exception:  # noqa: BLE001
            value = ""
        if value.strip():
            return value.strip()
    try:
        for relation in acc.get_relation_set() or []:
            if relation.get_relation_type() == Atspi.RelationType.LABELLED_BY and relation.get_n_targets():
                name = relation.get_target(0).get_name() or ""
                if name.strip():
                    return name.strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def all_actions(acc: Atspi.Accessible) -> list[str]:
    """Every action name, in index order (for do_action)."""
    try:
        if not acc.is_action():
            return []
        return [Atspi.Action.get_action_name(acc, i) or "" for i in range(Atspi.Action.get_n_actions(acc))]
    except Exception:  # noqa: BLE001
        return []


def action_names(acc: Atspi.Accessible) -> list[str]:
    """The readable actions; GTK 4's internal action groups ("clipboard.copy", "window.close") are left out."""
    names = []
    for name in all_actions(acc):
        # Chromium offers doDefault and showContextMenu on every node, layout included; they say nothing.
        if name and "." not in name and name not in ("doDefault", "showContextMenu") and name not in names:
            names.append(name)
    return names


def do_action(acc: Atspi.Accessible, name: str) -> bool:
    lower = [n.lower() for n in all_actions(acc)]
    if name.lower() not in lower:
        return False
    return bool(Atspi.Action.do_action(acc, lower.index(name.lower())))


def text_of(acc: Atspi.Accessible) -> str | None:
    # PyGObject merges the interfaces into the Accessible, where get_text is the deprecated getter of the Text
    # interface; the interface functions are called through their class.
    try:
        return Atspi.Text.get_text(acc, 0, -1) if acc.is_text() else None
    except Exception:  # noqa: BLE001
        return None


def value_text(acc: Atspi.Accessible, role: str) -> str | None:
    if role == "password text":
        return "value=<hidden>"
    if role in VALUE_TEXT_ROLES:
        content = (text_of(acc) or "").replace("\ufffc", "").strip()
        if content and content != label(acc):
            flat = content.replace("\n", "⏎")
            if len(flat) > 200:
                return f'value="{flat[:200]}…" (truncated {len(flat) - 200} chars)'
            return f'value="{flat}"'
    try:
        if acc.is_value():
            return f"value={Atspi.Value.get_current_value(acc):g}"
    except Exception:  # noqa: BLE001
        pass
    return None


def selected_range(acc: Atspi.Accessible) -> str | None:
    try:
        if not acc.is_text():
            return None
        if Atspi.Text.get_n_selections(acc) > 0:
            sel = Atspi.Text.get_selection(acc, 0)
            return f"selected=[{sel.start_offset},{sel.end_offset - sel.start_offset}]"
        return f"caret={Atspi.Text.get_caret_offset(acc)}"
    except Exception:  # noqa: BLE001
        return None


def editable(acc: Atspi.Accessible, states: Atspi.StateSet | None) -> bool:
    try:
        return acc.is_editable_text() and bool(states and states.contains(Atspi.StateType.EDITABLE))
    except Exception:  # noqa: BLE001
        return False


@dataclass
class Node:
    depth: int
    key: str
    content: str
    element: Element
    focused: bool


class Walker:
    def __init__(self, size: tuple[float, float], scale: float) -> None:
        self.nodes: list[Node] = []
        self.width, self.height = size
        self.scale = scale
        self.truncated = False
        self.focused: Atspi.Accessible | None = None

    def walk(self, acc: Atspi.Accessible, depth: int, parent_key: str, ordinals: dict[str, int], in_menu: bool = False) -> None:
        if depth > MAX_DEPTH:
            return
        if len(self.nodes) >= MAX_ELEMENTS:
            self.truncated = True
            return
        try:
            role = acc.get_role_name() or "unknown"
        except Exception:  # noqa: BLE001 (gone)
            return
        states = _states(acc)
        # Closed menus and hidden panels are not SHOWING; only what is on screen is listed (an open menu is).
        if states is not None and depth > 0 and not states.contains(Atspi.StateType.SHOWING):
            return
        frame = extents(acc)
        if frame and depth > 0 and not in_menu:
            x, y, w, h = frame
            if w <= 0 or h <= 0:
                return
            if x + w <= 0 or y + h <= 0 or x >= self.width or y >= self.height:
                return
        lab = label(acc)
        acts = action_names(acc)
        value = value_text(acc, role)
        focused = bool(states and states.contains(Atspi.StateType.FOCUSED))
        printable = role not in LAYOUT_ROLES or bool(lab) or bool(acts) or value is not None or focused
        key = parent_key
        child_depth = depth
        if printable:
            base = f"{role}|{lab}"
            ordinal = ordinals.get(base, 0)
            ordinals[base] = ordinal + 1
            key = f"{parent_key}/{base}#{ordinal}"
            parts = [role.replace(" ", "_")]
            if lab:
                parts.append(f'"{clip(lab, 120)}"')
            if value:
                parts.append(value)
            if states is not None:
                if states.contains(Atspi.StateType.CHECKABLE) or role in ("check box", "radio button", "toggle button", "check menu item", "radio menu item"):
                    parts.append("checked" if states.contains(Atspi.StateType.CHECKED) else "unchecked")
                if states.contains(Atspi.StateType.EXPANDABLE):
                    parts.append("expanded" if states.contains(Atspi.StateType.EXPANDED) else "collapsed")
                if states.contains(Atspi.StateType.SELECTED) and role not in ("text", "entry"):
                    parts.append("selected")
                if not states.contains(Atspi.StateType.ENABLED) and not states.contains(Atspi.StateType.SENSITIVE):
                    parts.append("disabled")
            if focused:
                rng = selected_range(acc)
                if rng:
                    parts.append(rng)
                parts.append("focused")
                self.focused = acc
            if editable(acc, states):
                parts.append("settable")
            if acts:
                parts.append(f"actions=[{','.join(acts)}]")
            if frame and not lab and (role in UNLABELED_FRAME_ROLES or depth == 0):
                x, y, w, h = frame
                parts.append(f"(frame {int(x * self.scale)},{int(y * self.scale)} {int(w * self.scale)}x{int(h * self.scale)})")
            element = Element(acc, frame or (0, 0, 0, 0), role, lab)
            self.nodes.append(Node(depth, key, " ".join(parts), element, focused))
            child_depth = depth + 1
        try:
            count = acc.get_child_count()
        except Exception:  # noqa: BLE001
            return
        child_ordinals: dict[str, int] = {}
        for i in range(min(count, 5000)):
            try:
                child = acc.get_child_at_index(i)
            except Exception:  # noqa: BLE001
                continue
            if child is None:
                continue
            self.walk(child, child_depth, key, child_ordinals, in_menu or role in ("menu", "menu bar"))
            if self.truncated:
                return


def read(app_id: str, app_name: str, window: dict, top: Atspi.Accessible, scale: float, disable_diff: bool) -> dict:
    """Walk the window and render it; replaces the app's element cache (indexes are valid until the next read)."""
    width, height = window["client"][2], window["client"][3]
    walker = Walker((width, height), scale)
    walker.walk(top, 0, "", {})
    with lock:
        cache = caches.setdefault(app_id, AppCache())
        previous, previous_order = cache.lines, cache.order
        same_window = cache.window_uuid == window["uuid"]
        had_previous = cache.revision > 0
        cache.elements, cache.lines, cache.order = {}, {}, []
        index_of: dict[str, int] = {}
        full = []
        for i, node in enumerate(walker.nodes):
            cache.elements[i] = node.element
            cache.lines[node.key] = node.content
            cache.order.append(node.key)
            index_of[node.key] = i
            full.append(f"{'  ' * node.depth}[{i}] {node.content}")
        previous_revision = cache.revision
        cache.revision += 1
        cache.window_uuid = window["uuid"]
        revision = cache.revision
        lines_now = dict(cache.lines)
        order_now = list(cache.order)

    title = window["caption"]
    header = f"App: {app_name} ({app_id})"
    win_line = f'Window: "{title}" frame=({int(window["client"][0])},{int(window["client"][1])} {int(width)}x{int(height)}) scale={scale:.2f}'
    focus_line = next((f"Focused: [{i}]" for i, node in enumerate(walker.nodes) if node.focused), "")
    selected = ""
    if walker.focused is not None:
        try:
            acc = walker.focused
            if acc.is_text() and Atspi.Text.get_n_selections(acc) > 0:
                sel = Atspi.Text.get_selection(acc, 0)
                chosen = Atspi.Text.get_text(acc, sel.start_offset, sel.end_offset)
                if chosen:
                    selected = f'Selected text: "{clip(chosen, 200)}"'
        except Exception:  # noqa: BLE001
            pass

    mode = "full"
    diff_lines = []
    if had_previous and same_window and not disable_diff:
        changed = 0
        for key in order_now:
            i = index_of[key]
            if key in previous:
                if previous[key] != lines_now[key]:
                    diff_lines.append(f"~ [{i}] {lines_now[key]}")
                    changed += 1
            else:
                diff_lines.append(f"+ [{i}] {lines_now[key]}")
                changed += 1
        for key in previous_order:
            if key not in lines_now:
                diff_lines.append(f"- {previous[key]}")
                changed += 1
        if changed <= 0.6 * max(len(walker.nodes), 1):
            mode = "diff"
    if mode == "diff":
        out = [f"{header}  diff vs revision={previous_revision}  revision={revision}", win_line]
        out += diff_lines or ["(no changes)"]
        out.append(f"Indexes: 0..{max(len(walker.nodes) - 1, 0)} valid (renumbered; call with disable_diff for the full tree)")
    else:
        out = [header, f"{win_line} revision={revision}", *full]
        if walker.truncated:
            out.append(f"(tree truncated at {MAX_ELEMENTS} elements)")
    if selected:
        out.append(selected)
    if focus_line:
        out.append(focus_line)
    text = "\n".join(out)
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + f"\n(output truncated at {MAX_TEXT} chars)"
    return {"text": text, "mode": mode, "revision": revision, "elementCount": len(walker.nodes), "focusedWindowTitle": title}


def cached(app_id: str, index: int) -> Element | None:
    with lock:
        cache = caches.get(app_id)
        return cache.elements.get(index) if cache else None


def forget(app_id: str) -> None:
    with lock:
        caches.pop(app_id, None)
