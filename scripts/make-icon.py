#!/usr/bin/env python3
"""Render resources/icon.png: the pi logo's 4x4 pixel grid on a dark macOS-style rounded square.
No dependencies; rerun after changing colors. Usage: python3 scripts/make-icon.py"""
import os, struct, zlib

SIZE = 1024
BG_TOP, BG_BOTTOM = (36, 36, 40), (22, 22, 25)
CORAL, BLUE, YELLOW = (0xF0, 0x90, 0x82), (0x4D, 0x9A, 0xBF), (0xF1, 0xBE, 0x58)
GRID = [  # pi.dev/logo-auto.svg
    [CORAL, CORAL, CORAL, None],
    [BLUE, None, CORAL, None],
    [BLUE, BLUE, None, YELLOW],
    [BLUE, None, None, YELLOW],
]
MARGIN, RADIUS = 100, 185          # macOS icon grid: 824px body, ~22% corner radius
CELL = 120                          # logo is 480px wide, centered
ORIGIN = (SIZE - 4 * CELL) // 2

def coverage(x, y):
    """Antialiased coverage of the rounded square at pixel (x, y), 4x4 supersampled."""
    lo, hi = MARGIN, SIZE - MARGIN
    hits = 0
    for sy in range(4):
        for sx in range(4):
            px, py = x + (sx + 0.5) / 4, y + (sy + 0.5) / 4
            cx = min(max(px, lo + RADIUS), hi - RADIUS)
            cy = min(max(py, lo + RADIUS), hi - RADIUS)
            if lo <= px <= hi and lo <= py <= hi and (px - cx) ** 2 + (py - cy) ** 2 <= RADIUS ** 2:
                hits += 1
    return hits / 16

rows = []
for y in range(SIZE):
    t = y / SIZE
    bg = tuple(round(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3))
    row = bytearray(b"\x00")
    for x in range(SIZE):
        inner = MARGIN + RADIUS <= x <= SIZE - MARGIN - RADIUS or MARGIN + RADIUS <= y <= SIZE - MARGIN - RADIUS
        a = 1.0 if inner and MARGIN <= x < SIZE - MARGIN and MARGIN <= y < SIZE - MARGIN else coverage(x, y)
        color = bg
        gx, gy = (x - ORIGIN) // CELL, (y - ORIGIN) // CELL
        if 0 <= gx < 4 and 0 <= gy < 4 and x >= ORIGIN and y >= ORIGIN and GRID[gy][gx]:
            color = GRID[gy][gx]
        row += bytes((*color, round(a * 255)))
    rows.append(bytes(row))

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
out = os.path.join(os.path.dirname(__file__), "..", "resources", "icon.png")
open(out, "wb").write(png)
print(out, len(png), "bytes")
