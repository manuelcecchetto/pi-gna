# Cut the hero's eyes, brows and mouth into layers over the faceless base; write a JSON of their boxes.
from PIL import Image, ImageFilter
import numpy as np, json
lab = np.load('face-labels.npy')
hero = Image.open('clean/hero.png').convert('RGBA'); base = Image.open('clean/hero-faceless.png').convert('RGBA')
h = np.array(hero).astype(np.int32); f = np.array(base).astype(np.int32)
parts = {58: 'mouth', 49: 'eye-l', 50: 'eye-r', 44: 'brow-l', 47: 'brow-r'}
# trim box of the base (shared by all layers)
al = f[..., 3]; ys, xs = np.where(al > 0); pad = 16
B = (xs.min() - pad, ys.min() - pad, xs.max() + pad + 1, ys.max() + pad + 1)
# yellow around the face: how different are the two images there?
ring = np.zeros(lab.shape, bool)
for k in parts: ring |= lab == k
ringd = np.array(Image.fromarray((ring*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(21))) > 0
zone = ringd & ~np.array(Image.fromarray((ring*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))).astype(bool)
print('yellow diff around face (mean abs rgb):', np.abs(h[zone][:, :3] - f[zone][:, :3]).mean(0).round(2))
out = {'size': [int(B[2] - B[0]), int(B[3] - B[1])], 'parts': {}}
base.crop(B).save('layers/hero-base.png', optimize=True)
for k, name in parts.items():
    m = (lab == k)
    m = np.array(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(1.2)))
    ys, xs = np.where(m > 0)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    layer = h.copy(); layer[..., 3] = (layer[..., 3] * (m / 255.0)).astype(np.int32)
    Image.fromarray(layer.astype(np.uint8), 'RGBA').crop(box).save(f'layers/hero-{name}.png', optimize=True)
    out['parts'][name] = [int(box[0] - B[0]), int(box[1] - B[1]), int(box[2] - box[0]), int(box[3] - box[1])]
# full hero trimmed with the same box, for comparison
hero.crop(B).save('layers/hero-full.png', optimize=True)
# recompose and diff
comp = base.crop(B).copy()
for name, (x, y, w, hh) in out['parts'].items():
    comp.alpha_composite(Image.open(f'layers/hero-{name}.png'), (x, y))
c = np.array(comp).astype(np.int32); r = np.array(hero.crop(B)).astype(np.int32)
face = np.zeros(c.shape[:2], bool)
for name, (x, y, w, hh) in out['parts'].items(): face[y:y+hh, x:x+w] = True
print('recompose diff in face boxes (mean abs):', np.abs(c[face][:, :3] - r[face][:, :3]).mean().round(2), 'max', np.abs(c[face][:, :3] - r[face][:, :3]).max())
comp.save('layers/recomposed.png')
json.dump(out, open('layers/hero-layers.json', 'w'), indent=1)
print(json.dumps(out))
