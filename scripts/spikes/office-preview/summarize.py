import json,glob,statistics as st,os
rows=[]
for p in sorted(glob.glob('res/*.json')):
    if os.path.basename(p).startswith('t'): continue
    d=json.load(open(p)); runs=d['runs']; r0=runs[0]; res0=r0['result'] or {}
    m=lambda r,k:(r['result'] or {}).get('marks',{}).get(k)
    warm=[m(r,'firstPage') for r in runs[1:] if m(r,'firstPage') is not None]
    setl=[m(r,'settled') for r in runs if m(r,'settled') is not None]
    rows.append(dict(tag=os.path.basename(p)[:-5], ok=res0.get('ok'), MB=round(r0['bytesTotal']/1e6,1), wasm=(f"{len(r0['wasm'])} files {r0['byKind'].get('wasm',0)/1e6:.1f}MB" if len(r0['wasm'])>3 else ' + '.join(r0['wasm'])) or '-',
      fonts=r0['fonts'], cold=m(r0,'firstPage'), warm=round(st.median(warm)) if warm else None, settled=round(st.median(setl)) if setl else None,
      longmax=max([(r['result'] or {}).get('longTasks',{}).get('max',0) for r in runs]),
      peak=max(r['peakRendererMB'] for r in runs), heap=max(r['jsHeapMB'] for r in runs), pages=res0.get('pages', res0.get('slides', res0.get('sheets'))),
      text=r0['innerTextLen'], ax=r0['axTextChars'], err=(res0.get('error') or '')[:90], cons=';'.join(r0['console'])[:120], errs=';'.join(r0['errors'])[:80]))
keys=['tag','ok','MB','cold','warm','settled','longmax','peak','heap','pages','fonts','text','ax','wasm']
print('\t'.join(keys))
for r in rows: print('\t'.join(str(r[k]) for k in keys))
print()
for r in rows:
    if r['err'] or r['cons'] or r['errs']: print(r['tag'],'|',r['err'],'|',r['cons'],'|',r['errs'])
