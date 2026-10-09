import sys
from PIL import Image
p,out=sys.argv[1],sys.argv[2]
boxes=[tuple(map(int,b.split(','))) for b in sys.argv[3:]]
im=Image.open(p).convert('RGBA')
tiles=[]
for b in boxes:
  for c in [(240,144,130),(250,246,238)]:
    cr=im.crop(b); bg=Image.new('RGBA',cr.size,c+(255,)); bg.alpha_composite(cr)
    tiles.append(bg.resize((cr.width*3,cr.height*3),Image.NEAREST).convert('RGB'))
W=sum(t.width for t in tiles[:2]); H=max(t.height for t in tiles)
rows=(len(tiles)+1)//2
sheet=Image.new('RGB',(W,H*rows),(128,128,128))
for i,t in enumerate(tiles): sheet.paste(t,((i%2)*tiles[0].width,(i//2)*H))
sheet.save(out)
