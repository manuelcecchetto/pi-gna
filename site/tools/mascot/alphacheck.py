import sys
from PIL import Image
import numpy as np
p=sys.argv[1]; out=sys.argv[2]
im=Image.open(p).convert('RGBA'); a=np.array(im)
al=a[...,3]
print('size',im.size,'alpha hist: zero',(al==0).mean().round(3),'full',(al==255).mean().round(3),'partial',((al>0)&(al<255)).mean().round(4))
# partial alpha pixels: mean color
m=(al>0)&(al<250)
if m.any():
  print('partial px rgb mean',a[m][:,:3].mean(0).round(1),'alpha mean',al[m].mean().round(1), 'count',m.sum())
# low alpha haze (alpha 1..60) count
h=(al>0)&(al<60); print('haze px (a<60):',h.sum())
ys,xs=np.where(al>8); print('bbox',xs.min(),ys.min(),xs.max(),ys.max())
W,H=im.size
bgs=[(250,246,238),(240,144,130),(20,20,26)]
tiles=[]
for c in bgs:
  bg=Image.new('RGBA',im.size,c+(255,)); bg.alpha_composite(im); tiles.append(bg)
sheet=Image.new('RGB',(W*3,H)); 
for i,t in enumerate(tiles): sheet.paste(t.convert('RGB'),(i*W,0))
sheet=sheet.resize((W*3//2,H//2))
sheet.save(out)
