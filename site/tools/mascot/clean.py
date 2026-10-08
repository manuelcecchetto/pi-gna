# Clean generated mascot PNGs: drop the faint glow outside the drawing, make near-opaque pixels opaque,
# and report what changed. Usage: clean.py in.png out.png [--no-trim]
import sys
from PIL import Image, ImageFilter
import numpy as np
src, dst = sys.argv[1], sys.argv[2]
trim = '--no-trim' not in sys.argv
im = Image.open(src).convert('RGBA')
a = np.array(im).astype(np.int32)
al = a[..., 3]
solid = Image.fromarray(((al >= 128) * 255).astype(np.uint8))
near = np.array(solid.filter(ImageFilter.MaxFilter(5))) > 0   # 2 px band around the solid drawing
before_haze = int(((al > 0) & ~near).sum())
al = np.where(near, al, 0)
al = np.where(al >= 240, 255, al)
a[..., 3] = al
# zero the color of fully transparent pixels so no stray RGB leaks into resizes
a[al == 0, :3] = 0
out = Image.fromarray(a.astype(np.uint8), 'RGBA')
if trim:
    ys, xs = np.where(al > 0)
    pad = 12
    box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0), min(xs.max() + pad + 1, im.width), min(ys.max() + pad + 1, im.height))
    out = out.crop(box)
else:
    box = (0, 0, im.width, im.height)
out.save(dst, optimize=True)
partial = int(((al > 0) & (al < 255)).sum())
print(f'{src}: removed {before_haze} haze px, partial edge px {partial}, crop {box}, out {out.size}')
