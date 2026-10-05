#!/bin/bash
cd "$(dirname "$0")"
run(){ local page=$1 f=$2 q=$3 csp=${4:-relaxed} n=${5:-3}; local tag="$page-$f${q:+-$(echo $q | tr -d '=&')}-$csp"; Q="$q" npx electron driver.mjs $page $f $csp $n res/$tag.json >/dev/null 2>&1 || echo "FAIL $tag"; echo "done $tag"; }
for f in d1 d2 d3 d4 b1 b2 b3 b4; do run bo-docx $f.docx ""; run bo-docx $f.docx "worker=1"; run dp-docx $f.docx ""; done
for f in p1 p2 p3 p4; do run bo-pptx $f.pptx ""; done
for f in x1 x2 x3 x4; do run bo-xlsx $f.xlsx ""; run ts-xlsx $f.xlsx ""; done
run bo-docx d1.docx "" strict 1; run bo-pptx p1.pptx "" strict 1; run bo-xlsx x1.xlsx "" strict 1
