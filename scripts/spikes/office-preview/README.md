# Office preview spike harness

Throwaway harness behind the "Office formats" section of `docs/FILE_PREVIEW.md`. Not built, typechecked or shipped.

```bash
cd scripts/spikes/office-preview
npm install                       # own deps, outside the app's pnpm workspace
mkdir -p files res shots          # put d1-4.docx, b1-4.docx, p1-4.pptx, x1-4.xlsx in files/ (real documents are not committed)
npx vite build                    # -> dist/
# Walnut baseline: extract ChatGPT.app's webview assets and link them in
npx @electron/asar extract /Applications/ChatGPT.app/Contents/Resources/app.asar /tmp/codex-asar/app
ln -sfn /tmp/codex-asar/app/webview/assets dist/codex
# Quick Look: qlmanage -p -o ql files/<f> for each file, then ln -sfn "$PWD/ql" dist/ql
./run-all.sh && ./run-wn.sh       # electron driver.mjs <page> <file> <strict|relaxed> <runs> <out.json>
python3 summarize.py | column -t -s $'\t'
```

`driver.mjs` serves `dist/` and `files/` over a privileged custom scheme with the viewer's headers (`no-store`, the viewer CSP;
`relaxed` adds `'wasm-unsafe-eval'` and `worker-src 'self'`), loads one page per run in a fresh window on one in-memory
session, and records bytes served, the page's `performance.now()` marks, long tasks, peak renderer working set (workers
included), JS heap, DOM/accessibility text and a screenshot. Pages: `bo-docx` (DocxEditor viewing+readOnly; `Q=worker=1`
and/or `preview=1`), `bo-pptx`, `bo-xlsx` (framework-free cores), `dp-docx` (docx-preview, current), `wn-docx` (Codex
Walnut + Granola document worker), `wn-parse` (Walnut parse only), `ts-xlsx` (jszip table prototype), `ql` (Quick Look HTML).
