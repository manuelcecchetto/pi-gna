"""Key names (xdotool syntax, as press_key takes them) and characters to evdev key codes.

Characters map through the US layout: KWin interprets EIS key codes with the active keymap, so typing goes through
the keyboard only on a US layout; elsewhere (and for characters the layout cannot type) text is inserted through
accessibility or pasted.
"""

from __future__ import annotations

MODIFIERS = {
    "ctrl": 29, "control": 29, "ctrl_l": 29, "control_l": 29, "ctrl_r": 97, "control_r": 97,
    "shift": 42, "shift_l": 42, "shift_r": 54,
    "alt": 56, "alt_l": 56, "alt_r": 100, "altgr": 100, "iso_level3_shift": 100,
    "super": 125, "super_l": 125, "super_r": 126, "meta": 125, "cmd": 125, "command": 125, "win": 125,
}

NAMED = {
    "return": 28, "enter": 28, "kp_enter": 96, "tab": 15, "iso_left_tab": 15, "escape": 1, "esc": 1,
    "backspace": 14, "delete": 111, "del": 111, "insert": 110, "space": 57,
    "up": 103, "down": 108, "left": 105, "right": 106, "home": 102, "end": 107,
    "page_up": 104, "pageup": 104, "prior": 104, "page_down": 109, "pagedown": 109, "next": 109,
    "menu": 127, "print": 99, "pause": 119, "caps_lock": 58, "num_lock": 69, "scroll_lock": 70,
    "minus": 12, "equal": 13, "plus": 13, "comma": 51, "period": 52, "slash": 53, "backslash": 43,
    "semicolon": 39, "apostrophe": 40, "grave": 41, "bracketleft": 26, "bracketright": 27,
}
NAMED.update({f"f{n}": code for n, code in zip(range(1, 13), (59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88))})

# character -> (code, needs shift), US layout
CHARS: dict[str, tuple[int, bool]] = {" ": (57, False), "\t": (15, False), "\n": (28, False)}
for normal, shifted, codes in (
    ("`1234567890-=", "~!@#$%^&*()_+", (41, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13)),
    ("qwertyuiop[]\\", "QWERTYUIOP{}|", (16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 43)),
    ("asdfghjkl;'", 'ASDFGHJKL:"', (30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40)),
    ("zxcvbnm,./", "ZXCVBNM<>?", (44, 45, 46, 47, 48, 49, 50, 51, 52, 53)),
):
    for char, code in zip(normal, codes):
        CHARS[char] = (code, False)
    for char, code in zip(shifted, codes):
        CHARS[char] = (code, True)


class KeyError_(ValueError):
    pass


def chord(spec: str) -> tuple[list[int], int, bool]:
    """'ctrl+shift+t' -> (modifier codes, key code, key needs shift)."""
    parts = [p for p in spec.strip().split("+") if p]
    if not parts:
        raise KeyError_("empty key")
    *mods, last = parts
    codes = []
    for mod in mods:
        code = MODIFIERS.get(mod.lower())
        if code is None:
            raise KeyError_(f'Unknown modifier "{mod}". Use ctrl, shift, alt or super.')
        codes.append(code)
    lower = last.lower()
    if lower in MODIFIERS:
        return codes, MODIFIERS[lower], False
    if lower in NAMED:
        return codes, NAMED[lower], False
    if len(last) == 1 and last in CHARS:
        code, shift = CHARS[last]
        # ctrl+A means ctrl+a: a modifier chord on a letter does not add shift for its case.
        return codes, code, shift and not (codes and last.isalpha())
    raise KeyError_(f'Unknown key "{last}". Use names like Return, Tab, Escape, Down, Page_Down, F5 or one character.')


def typeable(text: str) -> bool:
    return all(char in CHARS for char in text)
