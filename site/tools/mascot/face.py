# Split the hero's face (eyes, brows, mouth) into layers by diffing hero.png against hero-faceless.png.
from PIL import Image, ImageFilter
import numpy as np
from collections import deque
h = np.array(Image.open('clean/hero.png').convert('RGBA')).astype(np.int32)
f = np.array(Image.open('clean/hero-faceless.png').convert('RGBA')).astype(np.int32)
d = np.abs(h[..., :3] - f[..., :3]).sum(-1)
both = (h[..., 3] > 200) & (f[..., 3] > 200)
mask = (d > 90) & both
print('diff px', mask.sum())
# where else (outside the face) do they differ?
ys, xs = np.where(mask)
print('diff bbox', xs.min(), ys.min(), xs.max(), ys.max())
m = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
mm = np.array(m) > 0
# connected components
lab = np.zeros(mm.shape, np.int32); n = 0; comps = []
H, W = mm.shape
for y0, x0 in zip(*np.where(mm)):
    if lab[y0, x0]: continue
    n += 1; q = deque([(y0, x0)]); lab[y0, x0] = n; pts = []
    while q:
        y, x = q.popleft(); pts.append((y, x))
        for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
            yy, xx = y+dy, x+dx
            if 0 <= yy < H and 0 <= xx < W and mm[yy, xx] and not lab[yy, xx]:
                lab[yy, xx] = n; q.append((yy, xx))
    p = np.array(pts); comps.append((n, len(pts), p[:,1].min(), p[:,0].min(), p[:,1].max(), p[:,0].max()))
for c in sorted(comps, key=lambda c: -c[1])[:12]: print(c)
np.save('face-labels.npy', lab)
