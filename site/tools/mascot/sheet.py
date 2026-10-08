import sys, glob, os
from PIL import Image, ImageDraw
fs=sys.argv[3:]; out=sys.argv[1]; bg=tuple(int(sys.argv[2][i:i+2],16) for i in (0,2,4))
cell=360; cols=5; rows=(len(fs)+cols-1)//cols
sheet=Image.new('RGB',(cols*cell,rows*(cell+24)),bg)
d=ImageDraw.Draw(sheet)
for i,f in enumerate(fs):
  im=Image.open(f).convert('RGBA'); im.thumbnail((cell-20,cell-20))
  t=Image.new('RGBA',(cell,cell),bg+(255,)); t.alpha_composite(im,((cell-im.width)//2,(cell-im.height)//2))
  x,y=(i%cols)*cell,(i//cols)*(cell+24); sheet.paste(t.convert('RGB'),(x,y)); d.text((x+8,y+cell+4),os.path.basename(f),fill=(0,0,0) if sum(bg)>300 else (255,255,255))
sheet.save(out)
