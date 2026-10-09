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
# A drawing that reaches the source's edge was cut off by the generator (the hero's wave lines once were); trimming
# would hide that, so say it.
ys, xs = np.where(al >= 128)
cut = [side for side, hit in (('left', xs.min() == 0), ('top', ys.min() == 0),
                              ('right', xs.max() == im.width - 1), ('bottom', ys.max() == im.height - 1)) if hit]
if cut:
    print(f'WARNING {src}: the drawing touches the {", ".join(cut)} edge of the source, so something there was cut off; '
          'regenerate it or remove the cut part')
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
