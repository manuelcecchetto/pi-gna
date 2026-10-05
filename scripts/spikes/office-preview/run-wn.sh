#!/bin/bash
cd "$(dirname "$0")"
run(){ local page=$1 f=$2 csp=${3:-relaxed} n=${4:-3}; local tag="$page-$f-$csp"; npx electron driver.mjs $page $f $csp $n res/$tag.json >/dev/null 2>&1 || echo "FAIL $tag"; echo "done $tag"; }
for f in d1 d2 d3 d4 b1 b2 b3 b4; do run wn-docx $f.docx; done
for f in b3 p1 p2 p3 p4 x1 x2 x3 x4; do e=${f:0:1}; ext=$([ $e = p ] && echo pptx || ([ $e = x ] && echo xlsx || echo docx)); run wn-parse $f.$ext; done
run wn-docx d1.docx strict 1
