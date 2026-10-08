"""Trace the hero's face layers (hero-*.webp + hero-layers.json) into SVG shapes in base-image pixels.

Eyes and highlights become fitted ellipses, brows, mouth and tongue become smooth closed paths.
Prints JSON for src/data/hero-face.json.
Run: uv run --quiet --with opencv-python-headless --with numpy --with pillow python3 tools/mascot/trace_face.py
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

HERO = Path(__file__).resolve().parents[2] / 'src/assets/hero'
layout = json.loads((HERO / 'hero-layers.json').read_text())


def load(name):
    x, y, w, h = layout['parts'][name]
    im = np.array(Image.open(HERO / f'hero-{name}.webp').convert('RGBA')).astype(np.int32)
    return im, (x, y)


def mask_of(im, kind):
    r, g, b, a = im[..., 0], im[..., 1], im[..., 2], im[..., 3]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if kind == 'dark':
        m = (lum < 110) & (a > 128)
    elif kind == 'white':
        m = (lum > 200) & (abs(r - b) < 40) & (a > 128)
    elif kind == 'red':
        m = (r > 170) & (g < 140) & (b < 140) & (a > 128)
    return (m * 255).astype(np.uint8)


def biggest(mask):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return max(contours, key=cv2.contourArea)


def ellipse(contour, off):
    (cx, cy), (w, h), angle = cv2.fitEllipse(contour)
    return {'cx': round(cx + off[0], 1), 'cy': round(cy + off[1], 1), 'rx': round(w / 2, 1), 'ry': round(h / 2, 1), 'angle': round(angle, 1)}


def smooth_path(contour, off, eps=1.2):
    pts = cv2.approxPolyDP(contour, eps, True)[:, 0, :].astype(float)
    pts += np.array(off)
    n = len(pts)
    # Catmull-Rom through the simplified points, as cubic Béziers.
    d = [f'M{pts[0][0]:.1f} {pts[0][1]:.1f}']
    for i in range(n):
        p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = p1 + (p2 - p0) / 6
        c2 = p2 - (p3 - p1) / 6
        d.append(f'C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}')
    return ''.join(d) + 'Z'


out = {'size': layout['size']}
for side in ('l', 'r'):
    im, off = load(f'eye-{side}')
    dark = mask_of(im, 'dark') | mask_of(im, 'white')
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    out[f'eye-{side}'] = ellipse(biggest(dark), off)
    out[f'shine-{side}'] = ellipse(biggest(mask_of(im, 'white')), off)
    im, off = load(f'brow-{side}')
    out[f'brow-{side}'] = smooth_path(biggest(mask_of(im, 'dark')), off)

im, off = load('mouth')
mouth = mask_of(im, 'dark') | mask_of(im, 'red')
mouth = cv2.morphologyEx(mouth, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
out['mouth'] = smooth_path(biggest(mouth), off)
out['tongue'] = smooth_path(biggest(mask_of(im, 'red')), off)
json.dump(out, sys.stdout, indent=1)
