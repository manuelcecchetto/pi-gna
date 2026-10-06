# File preview

Source of truth for the file-preview feature. A preview
is a normal browser tab: one `WebContentsView` in `persist:pigna-browser` that loads a privileged custom scheme. It
shares the tab strip, activation, pop-out, agent tools, DevTools and phone streaming with web tabs. Sections marked
**(spiked)** record behavior observed in Electron 44.5.1 while designing it; the rest is a decision. Code map: handler and
token registry `src/main/browser/preview-protocol.ts`, tab wiring and live reload `preview-tabs.ts` + `manager.ts`
(`openPreview`), target resolution `resolve-targets.ts`, shared model `src/shared/preview.ts`, viewer `src/preview/`.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Scheme | `pigna-file`, registered in the one `registerAppScheme()` call with `{ standard: true, secure: true, supportFetchAPI: true }`. No `stream`, no `bypassCSP`, no `corsEnabled`. |
| URL | `pigna-file://<token>/<path relative to the root, percent-encoded>[?view=raw]` (`rendered` is the default; `#L<n>` jumps to a line) |
| Handler | `session.fromPartition("persist:pigna-browser").protocol.handle("pigna-file", ...)` in `src/main/browser/preview-protocol.ts` (`servePreview`, wired in `main/index.ts`). Only on that session, never on the default session. |
| PDF | Viewer + pdf.js (`pdfjs-dist`, Apache-2.0) with our own bar; Chromium's PDF plugin is not used (its UI can't be hidden or themed). |
| HTML | Served raw; relative assets resolve under the same token. Source mode (`?view=raw`) goes through the viewer. |
| Media | Wrapped by the viewer (`<video>`/`<audio>` against the raw URL); handler supports Range. |
| docx, pptx, xlsx | BetterOffice canvas engines (Apache-2.0) in the viewer bundle: `@betteroffice/docx-react` 0.4.3 for DOCX, the `pptx` 0.2.0 and `xlsx` 0.3.0 cores. Canvas only, no HTML rendering ("Office formats"). |
| Viewer build | Separate Vite entry `vite.preview.config.ts` -> `out/preview`, added to `scripts/build.mjs`. Not a static bundle under `resources/`. |
| Confinement | Token is the only capability. Handler enforces root containment (realpath) and a dotfile deny list; `BrowserManager` blocks navigation and popups from non-preview tabs to the scheme. |

## URL and token model

- A **root** is an absolute directory, resolved with `realpath` at mint time. It is the nearest project root (the
  active chat's cwd) when the file lies inside it, otherwise the file's own directory. A **token** is 16 random bytes
  (`randomBytes(16)`), hex, lowercase (32 chars; hosts are case-folded, so no base64). It maps to `{ root, openedAt }`.
- Tokens are minted by main only (`PreviewRegistry` in `preview-protocol.ts`, reached from the `browser.preview` host method, the address bar, and the agent
  bridge). One token per root, reused for every file under that root, so relative links between files of one
  project work and Back/Forward stay on one origin. Lifetime: until app quit (in memory only, never persisted). The
  tokens are not written to `browser-history.json`: `remember()` already stores only `https?:` URLs, keep it so.
- The file the user opened is `<root>/<rel>`; the tab URL is `pigna-file://<token>/<rel>`. A tab must **show the real
  path**, not the token: the manager reports `BrowserTab.url` as `pigna-file://...` (needed internally) plus a new
  optional `file?: { path, kind }`; the tab title is the file name and its tooltip the path. A preview has **one header, the viewer's own bar**: the pane draws no toolbar row for it. The Rendered/Raw switch sits in the tab strip (kinds with two modes only), and the file actions are in the tab's context menu (Copy path, Reveal in Finder, Open with default app, Reload, Pop out, Inspect). The
  agent's `browser_open` also accepts an absolute path and answers with the real path.
- Reverse lookup (URL -> real path) lives next to the token table: `resolvePreviewUrl(url) -> { path, root } | undefined`.
  "Reveal in Finder", "Open with default app" and drag out use it.
- Query `?view=` selects the mode (see table). The default is per kind. The viewer reads it from `location`.

## Kind detection

Detection is by lowercase extension first; a file without a known extension is sniffed (first 4 KB: NUL byte => binary
info card; valid UTF-8 => text; done by the viewer). `kindOf(path)` lives in `src/shared/preview.ts` so main, renderer, phone and the
agent extension share one table.

| Extension | Kind | Modes (default first) | Served |
|---|---|---|---|
| `pdf` | pdf | rendered | viewer + pdf.js over raw bytes (Range) |
| `png jpg jpeg gif webp avif bmp ico` | image | rendered | viewer page (`<img>`, fit/zoom/checkerboard) over raw bytes |
| `svg` | image | rendered, source | viewer `<img src=raw>` (an `<img>` never runs SVG scripts); source = text viewer |
| `docx` | docx | rendered | viewer, BetterOffice `DocxEditor` (canvas pages); `.doc` and other legacy formats get the info card |
| `pptx` | pptx | rendered | viewer, BetterOffice pptx core (one canvas per slide) |
| `xlsx` | xlsx | rendered | viewer, BetterOffice xlsx core (one canvas, sheet tabs) |
| `md markdown mdx` | markdown | rendered, raw | viewer; rendered goes through `renderMarkdown` (marked + DOMPurify) |
| `html htm xhtml` | html | rendered, source | rendered: raw bytes (scripts run, like a web page); source: viewer |
| `json jsonc` | json | tree/pretty, raw | viewer (highlighted, collapsible) |
| `csv tsv` | table | table, raw | viewer (first 5,000 rows rendered, rest in raw) |
| `mp4 mov m4v webm` | video | rendered | viewer `<video controls src=raw>` |
| `mp3 m4a wav ogg flac aac opus` | audio | rendered | viewer `<audio controls src=raw>` |
| code and text (`ts tsx js jsx py rs go rb java c cpp h css yml yaml toml sh sql txt log env ...` and sniffed text) | code / text | source | viewer, highlighted by the app's shiki setup, line numbers |
| everything else | other | info card | viewer: name, size, mtime, type, Reveal in Finder, Open with default app |

The raw kind (rendered html) is served as bytes by the handler. Every other kind loads `/__viewer/index.html?...` from
`out/preview` and the viewer fetches the file bytes from `pigna-file://<token>/<rel>?raw=1` (same origin). The handler
tells the two apart: for a viewer kind a navigation (`Accept` includes `text/html`, or is absent) returns the viewer HTML, anything else
(`?raw=1`, or a subresource such as a raw HTML page's own css/js/images) returns bytes. `?raw=1` for html is identical to the default, so "Open raw" is a free toggle; `?raw=1` on a PDF is its bytes (what pdf.js reads).

## Viewer architecture and theming

- One page, one bundle (`src/preview/`): plain TS with small renderers per kind, lazy `import()` per kind, so a markdown
  file loads no Office engine and shiki is loaded only for code/json/md fences. React is used only by the DOCX view
  (BetterOffice's `DocxEditor`) and is loaded only with it.
- Output `out/preview/` is served under `pigna-file://<token>/__viewer/*`; the `__viewer` prefix is reserved and read
  from `join(import.meta.dirname, "../preview")` (inside app.asar when packaged; `fs` reads it, like `out/mobile` and the
  renderer today). Files named `__viewer` in a project are unreachable: acceptable.
- The viewer response has a strict CSP: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:;
  connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
  `'wasm-unsafe-eval'` lets the BetterOffice engines and pdf.js's decoders compile their wasm (it allows no JS `eval`); `worker-src 'self'`
  covers the DOCX layout worker and the text-export worker. (`'unsafe-inline'` styles are needed for BetterOffice's
  React styles and shiki.) Plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Viewer pages have no
  preload and no Node (the partition is already sandboxed, context-isolated).
- **Raw HTML gets no CSP from us** (it must behave like a web page), only `Referrer-Policy: no-referrer` and `nosniff`.
- Theming: the app theme is mirrored by `prefers-color-scheme` of the view (`nativeTheme` already follows the app);
  the viewer styles with CSS variables mirroring the renderer tokens and `color-scheme: light dark`. The rendered
  docx page stays white (it is a page); the surround follows the theme. PDF pages stay white like docx; raw HTML keeps its own look.
- Untrusted content rules: markdown rendered with `renderMarkdown` (DOMPurify), images inside it fetched through
  the same token; links to other files in the root navigate within the tab (relative), `https` links open as a new
  browser tab (existing `setWindowOpenHandler`), `file:` and other schemes are dropped.
- Live reload: main watches the opened file (`fs.watch` on the parent directory, filtered by name, 150 ms debounce,
  re-stat; macOS atomic saves replace the inode) and calls `webContents.reload()` on the tab; the viewer keeps scroll
  by restoring `scrollY` from `sessionStorage`. Watchers live while the tab lives. Reloading an HTML page when a sibling asset changes is not done (open question 3).

## Spike results (Electron 44.5.1, `persist:`-partition `WebContentsView`, handler on `ses.protocol`)

### a. PDF **(spiked; superseded)**

The Chromium viewer described here is no longer used: see **PDF viewer** below. Kept as the record of why it was not enough.

- `pigna-file://<token>/t.pdf` served as `application/pdf` renders in Chromium's built-in PDF viewer: toolbar, thumbnail
  rail, `1 / 1`, zoom controls. `document.contentType` is `application/pdf`. The CDP `Page.captureScreenshot` of the
  tab shows the whole viewer, byte-for-byte the same size (71,368 b base64) as the same PDF loaded from `file://`.
- Zoom works through CDP input (two `+` clicks: 73% -> 80% -> 90%). The agent's `browser_screenshot` therefore sees
  the rendered page. In-PDF search (Cmd+F through CDP key events) did not show a find bar in my attempt; not
  verified, so do not promise search (open question 1). The viewer's own toolbar has no search button.
- **No pdf.js needed; no `file://` fallback needed.** `file://` is not used for anything.
- `webContents.loadURL` of the PDF resolved normally.

### b. HTML with relative assets **(spiked)**

`pigna-file://<token>/page.html` linking `sub/s.css`, `sub/s.js`, `sub/p.png`: stylesheet applied
(`rgb(1, 2, 3)`), script ran (`dataset.ran === "yes"`), image loaded (`naturalWidth 1`). `location.origin` is
`pigna-file://<token>`, `isSecureContext` is `true`. With `secure` removed `isSecureContext` is `false`.

### c. Media with Range **(spiked)**

A 5 s H.264/AAC mp4 loaded as a top-level document: `readyState 4`, duration 5, a seek to 3.5 s fired `seeked`
(`currentTime 3.5`). The handler saw `GET` (no Range, 200) then `Range: bytes=0-` (206): Chromium does issue Range requests
and the hand-written 206 + `Content-Range` + `Accept-Ranges` handler satisfies them. **`stream: true` is not needed**:
PDF, HTML, media and `fetch` all worked with only `standard`+`secure`+`supportFetchAPI`. Without `supportFetchAPI` a
same-origin `fetch()` fails ("Failed to fetch") so the viewer could not load its bytes; without `secure` `isSecureContext`
is false. Both are needed.
**Gotcha**: `loadURL()` of a bare media URL **rejects with `ERR_FAILED`** (after 85 ms) even though playback works;
the same happens for an `http://localhost` served mp4, so this is not the scheme. `BrowserManager.load` only swallows
`ERR_ABORTED`. Hence media goes through the viewer page (a normal HTML document), so the handler path must not load bare media.

### d. Confinement **(spiked)**

Probe scripts ran in a tab at `http://localhost:<port>/` and at `https://example.com/` (same partition, same session
as the handler) against a known token, and against a wrong token.

| Probe from a web tab | Result |
|---|---|
| `fetch(pigna-file://<token>/ok.txt)` | **blocked** by CORS ("Failed to fetch"; the handler is still invoked and returns 200, the response is just unreadable). The same for wrong token, `../`, `%2e%2e`, symlink: all "Failed to fetch". |
| `<img src>` | **loaded** (200 served) |
| `<script src>` | **executed** (200 served) |
| `<iframe src>` | **loaded**, but cross-origin (`contentDocument` throws `TypeError`); with `frame-ancestors 'none'` in a CSP header the own-origin iframe is blocked too |
| `<iframe>` or `<img>` with `Cross-Origin-Resource-Policy: same-origin` on the response | **no effect** for img/script from a web origin on a custom scheme (still loaded) |
| `window.open(url)` | succeeds in a bare tab; with `setWindowOpenHandler` it reaches the handler with the full URL, so the manager can deny it |
| `location = url` | **navigates** (handler 200); `will-navigate` fires with the URL, so the manager can cancel it |

Handler-visible request data from those loads: only `Accept`, `User-Agent`, `Upgrade-Insecure-Requests`; no `Origin`,
no `Sec-Fetch-*`. `request.referrer` is `http://localhost:<port>/` from an http page and **empty from an https page**
(https -> custom scheme is a downgrade), so a Referer check cannot be the confinement: an https attacker is
indistinguishable from a top-level navigation. **Chromium blocks only fetch reads and cross-origin DOM access; it does
not stop a web page from loading img/script/iframe or navigating to the scheme.** So the confinement is:

1. **The token** (128-bit) is the capability. A web page cannot guess it (a wrong token: handler 404, nothing leaks) and
   never sees it: tokens are not in history, appear only in preview tabs' own URLs, and are not in any web page's referrer (spiked: a page at `pigna-file://<token>/` fetching an http server sent
   **no `Referer`**; add `Referrer-Policy: no-referrer` anyway, belt and braces).
2. **`BrowserManager`**: in `will-navigate` and `setWindowOpenHandler`, cancel navigation to `pigna-file:` when the
   source tab's current URL is not `pigna-file:` (main-process `loadURL` does not fire `will-navigate`, so mint-and-load
   by main is unaffected). Spiked: both events fire with the target URL for `location=` and `window.open`.
   Add `pigna-file` to the allowed list of `will-navigate`, otherwise previews cannot follow relative links.
3. **Handler containment** (spiked from inside the preview origin, `own_origin`):
   - `../` and `%2e%2e/` are normalized by Chromium before they reach the handler (`/../outside/secret.txt` arrived as
     `/outside/secret.txt`); the handler's `path.resolve(root, "." + decoded)` + `startsWith(root + sep)` is still the
     required check (404 for those probes, nothing outside read).
   - **Symlink out of the root**: `root/link.txt -> ../outside/secret.txt` is only caught by `realpath` + prefix check
     (**403**). The root itself must be `realpath`ed too: with `/tmp/...` (symlink to `/private/tmp`) the first spike run
     rejected *every* file as an escape because the unresolved root was compared with resolved paths.
   - Decode once (`decodeURIComponent`), reject NUL and `\`, only `GET`/`HEAD`, regular files only (no directories or
     devices), no listings. Directory request => 404.
   - **Dotfile deny list** (decision, not spiked): any path segment starting with `.` (`.env`, `.git`, `.ssh`, `.npmrc`...)
     is refused except when it is the opened file itself. An untrusted HTML preview runs scripts that can `fetch` anything in its root
     (own origin: `fetch_ok 200`) and reach the network, so it must not be able to read secrets sitting in the project root.
4. **Residual risk, accepted and documented**: an HTML file previewed as rendered is a web page with read access to its
   root (minus dotfiles) and network access. That is the product (agent-made prototypes). Rendered HTML is therefore
   **never auto-opened**: the transcript/agent path opens it, the user sees the address, and the tab header offers
   "Source" next to "Rendered". Viewer-rendered kinds cannot run file-supplied script (CSP, sanitizer, `<img>` for SVG).

### Not spiked / explicitly unverified

PDF search; HTML `<base>`; `Content-Disposition`; very large file memory behavior beyond the stream design; Windows/Linux.

## docx library **(spiked; superseded by "Office formats")**

Three real contracts (`.docx`, 30-83 KB; one with tables and 88 list items, one with a header image and auto-numbered headings),
rendered in Electron with both libraries, screenshots compared.

| | docx-preview 0.4.1 | mammoth 1.13.0 |
|---|---|---|
| License | Apache-2.0 | BSD-2-Clause |
| Browser bundle | 75 KB min (21 KB gz) + jszip (peer, ~97 KB min); with bundler tree shaking ~170 KB | 405 KB min (100 KB gz), jszip inside |
| Render time (5-page contract) | 38 ms | 49 ms |
| Page layout, header, fonts | **Paper pages, margins, header/footer, fonts, colors** | Flow HTML only, no header/footer |
| Numbered lists | **Correct (1. 2. 3. across paragraphs)** | **Wrong**: every heading restarts at "1." (nested `<ol>` per item) |
| Images | Rendered (header image present) | Dropped in the header sample (`imgs 0`), 2 warnings |
| Tables | 3/3 rendered | 3/3 rendered |
| Tracked changes | `renderChanges` option renders `ins`/`del` (not exercised: none of the samples had them) | Ignored/accepted |
| Content controls ("Klick hier...") | Rendered as placeholders, like Word | Flattened to text |

**Pick docx-preview** (with jszip as an explicit dependency, as its peer). It is a pure browser DOM renderer, so it
runs in the viewer and needs no sanitization to be a script vector: it builds DOM nodes itself; still render it
into a container, never `innerHTML` of its own output string. Mammoth stays out.

## Office formats: BetterOffice canvas **(decided and implemented 2026-10-05)**

Question: can BetterOffice (`@betteroffice/*`, Apache-2.0, Rust/wasm engines painting to canvas) render DOCX, PPTX and XLSX
read-only in the viewer at an acceptable cost, given that big DOCX were slow in casus-review? **Decision: canvas only, so
BetterOffice for all three formats.** DOCX opens with `experimentalWorkerOpen` + `previewFirstPage` behind a loader.
PPTX and XLSX use the framework-free cores. HTML renderers (docx-preview, Quick Look, a TS table) are rejected as targets.
Implemented as below ("Implementation"); docx-preview is removed.

Harness: `scripts/spikes/office-preview/` (README there). Electron 44.5.1, one fresh window per run on an in-memory
session, assets over a privileged custom scheme with this viewer's `no-store` and CSP headers, 3 runs per cell (cold = first
run). "Peak" is the renderer process working set, workers included. Files: d1 24-page contract with tracked changes, d3
21-page contract, d2/d4 short; big ones b1 *SPA Müller mit Markup* (45 p, 248 KB, tracked changes), b4 *SPA Müller*
(50 p), b2 *Framework Agreement* (167 p, 52 tables, footnotes, images), b3 *Refinancing Amendment* (~149 p, 721 KB zip,
**17.3 MB document.xml**, 282 tables). Options:

- **BetterOffice (BO)**: `@betteroffice/docx-react` 0.4.3 in `mode="viewing" readOnly`; the `pptx` 0.2.0 and `xlsx` 0.3.0 cores.
- **Walnut + Granola**: the Codex app's own baseline, the .NET Open XML reader plus its JS layout worker, extracted from
  `/Applications/ChatGPT.app` `app.asar` (`webview/assets`) and driven through its worker protocol. Measurement only:
  it is proprietary and cannot be shipped.
- **docx-preview**: the viewer at the time of the spike.
- **Quick Look**: `qlmanage -p -o`, which emits HTML.

### DOCX

| File (Word pages) | BO default: first page / all pages / peak / longest main-thread task | BO worker + preview: first page / peak / longest task | Walnut + Granola: first page (= all pages) / peak | docx-preview: done / peak |
|---|---|---|---|---|
| d1 (24) | 1.06 s / 1.06 s / 842 MB / 0.18 s | **0.57 s** / 752 MB / 0.19 s | 2.5 s / 423 MB | 0.15 s / 132 MB |
| b1 (45) | 1.50 s / 1.42 s / 1,190 MB / 0.39 s | **0.74 s** / 762 MB / 0.23 s | 4.7 s / 529 MB | 0.21 s / 184 MB |
| b4 (50) | 1.34 s / 1.32 s / 1,143 MB / 0.40 s | **0.74 s** / 765 MB / 0.23 s | 5.4 s / 541 MB | 0.21 s / 188 MB |
| b2 (167) | 1.51 s / 2.37 s / 1,786 MB / 0.69 s | **0.63 s** / 711 MB / under 0.05 s | 10.2 s / 800 MB | 0.29 s / 259 MB |
| b3 (~149) | 7.29 s / 8.40 s / **2,710 MB** / **4.56 s** | **1.03 s** / 878 MB / 0.10 s; all pages ≈ 6.8 s in the worker | **40.4 s** / 1,916 MB | 1.19 s / 596 MB |

- **Bytes per open** (`no-store`, nothing cached):
  - BO: 30.6-32.7 MB. That is `docx_edit` 20.3 MB + `docx_layout` 4.2 MB wasm, 1.6 MB JS, and 4.5-6.2 MB of fonts (11-16 faces).
  - BO in worker mode: 47-53 MB, because 0.4.3 fetches and compiles the edit wasm in the main thread *and* the worker.
  - Walnut + Granola: 17.5-18.2 MB (12.6 MB wasm in 31 .NET assemblies + 4.9 MB JS).
  - docx-preview: under 1 MB.
- **Short files** (d2-d4): BO 0.7-1.3 s, Walnut 2.2-2.8 s, docx-preview under 0.16 s.
- **Pagination vs Word's `<Pages>`**: b1 45 → BO 44 / Granola 45; b4 50 → 50 / 47; b2 167 → 172 / 163; b3 → 155 / 154
  (its `app.xml` count is stale). docx-preview does not paginate: it only breaks at explicit breaks, so b3 is one "page"
  and b2 has 71.
- **Where the big-file time goes**:
  - BO: layout and measurement in the edit wasm on the main thread (b3: 4.6 s single task, 2.7 GB).
  - Walnut: its interpreted .NET parse (b3: 35 s of the 40 s). Granola then lays out every page before painting any,
    so its first page equals its full layout time.
- **Fidelity** (screenshots): both canvas engines draw the contracts faithfully (fonts, numbering, tables, headers).
  On b2's cover, BO places the logo and the "July 2023" text box correctly; Granola paints the date on top of the logo.

**The hypothesis "most of the cost is the editor, view-only is much cheaper" is false for BO 0.4.3.**

- `docx_edit` (20.3 MB) *is* the viewer engine: lowering a story to layout blocks (`yrs_blocks_for_story`) and the resident
  layout exist only there. `docx_layout` (4.2 MB) needs blocks that are already measured.
- `mode="viewing"` loads edit + layout and never loads `docx_parse` (5.3 MB) or `opc`. So no public parse + layout-only
  path exists. The unreleased `docx-react-viewer-worker-only` changeset on BO main only removes the main-thread copy.

The cost to accept: about 24.4 MB of DOCX wasm. What makes big files usable is the stock worker + preview path:
first page in about 1 s on every file, main thread free while the rest lays out.

### PPTX and XLSX

| | BO core: all slides / first viewport painted | bytes per open | peak | Walnut parse only (no paint) | Quick Look (HTML) |
|---|---|---|---|---|---|
| PPTX p1-p4 (5-14 slides) | 0.19-0.21 s, all 4 decks | 7.4-7.6 MB (5.4 MB wasm + 1.9 MB, 3 faces) | 179-195 MB | 0.94-1.39 s; **p3 throws** (FormatException) | 0.08-0.13 s convert; **p3 produces nothing** |
| XLSX x1-x4 (1-6 sheets, charts) | 0.15-0.33 s | 5.2-5.3 MB wasm | 158-189 MB | 0.96-1.38 s | 0.09-0.18 s convert |

The TS table prototype (jszip + DOMParser, values only, first sheet) took 0.10-0.13 s and about 0.15 MB, but it is
HTML and is dropped by the canvas decision. BO PPTX and XLSX are cheap. Their wasm is what an "Office viewer" costs anyway.

### What the viewer needs for BetterOffice

- **CSP**: the current viewer CSP blocks all three engines. They fail with `WebAssembly.compileStreaming ... violates
  CSP`; Walnut fails the same way. Required: `script-src 'self' 'wasm-unsafe-eval'` and `worker-src 'self'` (the DOCX
  resident worker). Nothing else changes: fonts are fetched same-origin (`connect-src 'self'`), and images and styles are
  already covered. Call `setGoogleFontsEnabled(false)`: the docx core otherwise builds `fonts.googleapis.com` URLs for
  unknown families.
- **Fonts**: `@betteroffice/fonts` is 14.2 MB of TTF on disk (65 faces), but faces load lazily per face, same-origin.
  An open fetches 3-16 faces (1.5-6.2 MB).
  - Do not ship `@betteroffice/fonts-cjk` (33 MB). Documents that name CJK families (MS Mincho, MS Gothic; 6 of the 8 test files) then fire `onError("[font] failed to register bundled Noto ...")` and fall back. That `onError` must be treated
    as non-fatal.
  - PPTX: register each face with the engine (`openPresentation({ fonts })`) **and** with the browser
    (`registerBundledFontFace(face, family)`). Otherwise the canvas paints with the default serif. Use
    `inspectPresentation` for the deck's font names.
- **Bundle**: `vite build` emits the wasm, the worker and the font faces as hashed assets under `out/preview` (served by
  `serveViewer`). The DOCX React bundle is 1.43 MB of JS (438 KB gz) and needs React in the viewer, which is plain TS
  today. PPTX and XLSX cores are 46 KB and 25 KB of JS. App size grows by about 57 MB uncompressed (all wasm, including
  the unused `docx_parse`/`opc`, + fonts).
- **Agent text (`browser_snapshot`)**:
  - BO DOCX keeps an accessibility mirror of the pages near the viewport only (d3: 12.7k chars of DOM text vs 46k for the
    whole document).
  - The PPTX/XLSX cores expose no text. Use `exportPptxMarkdown`/`exportXlsxMarkdown` or `buildA11yGrid` for a hidden text
    layer, or the React viewers.
  - Granola renders no DOM text at all.
- **Phone**: the stream is a screencast of the view, so canvas output streams like any page (not separately tested).
- **Caching**: the viewer handler sends `no-store` for every asset. Making it cacheable was measured in the app and
  dropped (see "Implementation").

### Recommendation

| Format | Use | Why |
|---|---|---|
| DOCX | BO `DocxEditor` `mode="viewing" readOnly`, `experimentalWorkerOpen` + `previewFirstPage`, loader until `onFirstPagePainted`, "laying out" state until `whenLayoutComplete()` | ~0.6-1.0 s first page on 24-167 pages; b3 full layout ~7 s off the main thread; Word-faithful pagination; Walnut is 4-40x slower and unshippable |
| PPTX | BO core: `openPresentation` + `paintSlide`, one canvas per slide | 0.2 s, 7.5 MB, renders the deck Walnut and Quick Look fail on |
| XLSX | BO core or `XlsxEditor readOnly` | 0.15-0.33 s, 5.2 MB |

**Next levers if the DOCX loader is not enough**: take BO's worker-only viewer release (the edit wasm then compiles once),
then the casus-review engine patches (mirror removal, wasm prewarm: `docs/research/2026-09-09-native-docx-startup-default.md`
there). Cacheable assets were measured and give nothing (below).

**Why casus-review opens the same contracts in about 5 s**: it pins BO 0.1.0 (patched), which has neither
`experimentalWorkerOpen` nor `previewFirstPage`, opens on the main thread, and its comment layer needs the full
main-thread document (`onRenderedDomContextReady`, paragraph locate) before anything is useful. On 0.4.3 the worker path
would paint page 1 fast there too, but paragraph-anchored features wait for the main-thread copy (`DocxReplicaNotReadyError`).

### Implementation

Files: `src/preview/docx.tsx`, `docx-text.ts` (worker), `pptx.ts`, `xlsx.ts`, `office.ts` (shared checks, loading state,
fonts, text layer); kinds `docx`/`pptx`/`xlsx` in `src/shared/preview.ts`; CSP in `src/main/browser/preview-protocol.ts`.
All three read the whole file (`PREVIEW_LIMITS.office`, 25 MB) after the same checks: empty, too large, OLE container
(legacy or password-protected), not a zip; each check shows a message instead of a broken view.

- **DOCX**: `DocxEditor mode="viewing" readOnly` with `experimentalWorkerOpen` + `previewFirstPage`, no toolbar, ruler,
  zoom control or outline; `colorMode="system"`. A full-page spinner until `onFirstPagePainted`, then a footer
  "Laying out…" until `whenLayoutComplete()` gives the page count. `onError` before the first page fails the view unless
  it is about fonts (missing CJK faces are reported and harmless); after it, errors are logged. `Fit` (default) / `−` / `+`
  / ctrl-cmd-wheel zoom through the ref's `setZoom`.
  - BO 0.4.3 gives the page column an inline `min-width` of the page *at zoom 1*, so a page zoomed to fit a narrow pane
    sat off-center in an 834 px column. `style.css` overrides it and uses `align-items: safe center`.
  - BO gives the full open after the preview **10 s**, then replaces the view with "Failed to Load Document"; the limit
    is not a prop. b3 takes 7-9 s idle and 24.5 s on a loaded machine (load average 14), so it failed there.
    `vite.preview.config.ts` raises it to 2 minutes with a build-time rewrite that fails the build when the code changes.
  - The comments and changes sidebar stays closed: it needs a column beside the page that a preview pane does not have
    (tried: with it open the page shifts left out of view). Tracked changes show inline on the pages.
  - **Agent text**: the DOM mirror is per glyph and only near the viewport, and `readParagraphs` (35 ms on b3) leaves out
    table cells (d4: 283 of 10,515 chars). The ref's `exportStructuredWithPages` took 5.1 s and kept +570 MB; the core
    `exportDocxMarkdown` on the page took 3.4 s of main thread and kept +400 MB (wasm memory never shrinks). So after
    layout a short-lived worker (`docx-text.ts`) runs `exportDocxMarkdown` (accepted view, tables included) and is
    terminated: b3 gets 342k chars about 3 s after layout, the page never blocks, the tab peaks at 1.68 GB during the
    export and returns to 1.21 GB.
- **PPTX**: font names from `inspectPresentation`, each Office family mapped to a bundled face (exact, metric-compatible,
  last resort), registered with the engine and the page; one canvas per slide at the pane width (max 1280 px), laid out
  and painted when near the viewport (`IntersectionObserver`), repainted on resize. Text layer: `exportPptxMarkdown`
  (notes included).
- **XLSX**: one canvas the size of the pane under a transparent scroller sized to the sheet (`contentWidth/Height`); each
  scroll or resize paints `displayList(viewport)` in the next frame. Sheet tabs in the footer. The cells name Office
  families (`"Calibri", sans-serif`); faces for families seen in painted cells are registered and the sheet repaints with
  them. A hidden tab paints when first shown. Text layer: the workbook handle's `exportMarkdown` (BO's caps: 200 rows by 50
  columns per sheet). Known BO 0.3.0 gaps: no row/column headers; gridlines cross text that overflows into empty cells.
- **Text layer**: a visually hidden `<pre>` (`.sr-only`) with the export's Markdown minus its anchor comments; the agent's
  `browser_snapshot` and screen readers read it.
- **Reopen**: opening a file whose tab is already open used to reload it (`startPreview` on the reused tab): b3 lost its
  scroll position and laid out again for 6.9 s. `needsReload` (`preview-tabs.ts`) now shows the tab as it is unless the
  view changes, a line is asked for or the page crashed: 43 ms, same page, scroll kept. This covers chat links, the agent's
  `browser_open` and Open file.
- **Caching, measured and dropped**: `codeCache: true` on the scheme plus `immutable` on `__viewer/assets/*` filled the
  JS code cache, but the HTTP cache stays empty for custom-protocol responses and the wasm code cache never filled. d3's
  first page stayed at 0.54-0.64 s (0.57-0.62 s before). Fetching the 20 MB edit wasm takes about 25 ms and
  `compileStreaming` about 20 ms (lazy compilation); the rest of the ~0.45 s is BO opening the document. Assets stay `no-store`.

Measured in the app (Apple Silicon, idle machine unless noted), first page / all pages laid out:

| File | Pages | First page | Laid out | Tab peak |
|---|---|---|---|---|
| d3 | 20 | 0.57-0.62 s | 1.3 s | |
| b1 *SPA Müller mit Markup* | 44 | 0.89 s | 2.1 s | 0.70 GB |
| b4 *SPA Müller* | 50 | 0.81 s | 2.1 s | 0.73 GB |
| b2 *Framework Agreement* | 172 | 0.61 s | 2.2 s | 0.73 GB |
| b3 *Refinancing Amendment* | 155 | 1.07 s | 7.1 s | 1.33 GB (1.68 GB during the text export) |
| b3, load average 14 | 155 | 3.7 s | 24.5 s | |
| PPTX p1-p4 | 5-14 slides | 0.20-0.27 s | | ~0.2 GB |
| XLSX x1-x4 | 1-6 sheets | 0.14-0.35 s | | ~0.2 GB |

Every open tab keeps its engine: a big contract holds about 0.7-1.3 GB while its tab is open (macOS compresses it while
hidden). Closing the tab ends the renderer process and frees it.

Real-app checks (a throwaway instance driven over the agent bridge and CDP; the repeatable part is in
`scripts/verify-file-preview.mjs`):

- **Chat links**: six chips (four DOCX, a deck, a workbook) clicked 150 ms apart open six tabs that all render; clicking
  open documents again only switches tabs.
- **Quick swaps**: ten opens 100 ms apart with repeats (no duplicate tabs, repeats not reloaded); 40 tab switches 50 ms
  apart; live reload replacing a file twice while it was still laying out (ends on the last content); Markdown preview links
  into DOCX/XLSX/PPTX followed and backed out quickly.
- Closing all tabs leaves no preview renderer process (workers included).

## Viewer build **(decided)**

Separate Vite entry, `vite.preview.config.ts` (`root: src/preview`, `outDir: out/preview`, `emptyOutDir`, `base: "./"`,
minify, React plugin, ES module workers), appended to the list in `scripts/build.mjs` next to the mobile build. Reasons:
the viewer imports npm packages (marked, DOMPurify, shiki, BetterOffice with its wasm, workers and fonts) and needs the
Vite pipeline, which `resources/visual` (hand-written
static files, no imports) does not have; `out/**` is already packed by electron-builder (`files: out/**`), so packaging
needs no change; `out/mobile` is the precedent for reading a built bundle from `import.meta.dirname` in main.
Dev: `electron-vite dev` does not run it; `pnpm dev` builds the viewer once first, `pnpm dev:preview` rebuilds on change, and main reports a clear 500 page "viewer not built" if `out/preview` is missing.
The viewer imports `renderMarkdown` and `highlight` from `src/renderer/src/lib/` by relative path.

**PDF viewer**: `src/preview/pdf.ts`, lazily imported. pdf.js `PDFViewer` renders canvas pages plus a text layer (text selects,
and the agent's snapshot reads it) inside an absolutely positioned scroller (pdf.js requires it). Our one bar: page `‹ n / m ›`
(type a number + Enter), zoom `−` / `Fit` / `+` (Fit = pdf.js `auto`: page width, max 125%), ctrl/cmd+wheel, `+`/`-`/`0`,
←/→ page when nothing scrolls sideways, file size. Find is a card over the pages that **only Cmd/Ctrl+F opens** (field,
`n of m`, up/down chevrons; Enter/Shift+Enter, Cmd/Ctrl+G step; Escape closes and clears highlights). `#page=3` or
`#L3` opens at that page; live reload keeps zoom and scroll (`sessionStorage`). pdf.js loads the file with Range requests
from `?raw=1`; its worker is a bundled asset (`?url` import); CMaps, standard fonts, ICC profiles and image decoders (wasm)
are copied to `out/preview/pdfjs/` by a plugin in `vite.preview.config.ts` (quickjs, pdf.js scripting, is left out:
scripting, XFA and annotation editing are off). The wasm decoders need `'wasm-unsafe-eval'` in the viewer CSP; it allows
compiling WebAssembly, not `eval`. Links in a PDF open in a new tab (`_blank`, via the existing window-open handler).
Messages: empty, password-protected, invalid/corrupt. `pnpm verify:preview` checks pages, text layer, no plugin
(`<embed>`), find (hidden until Cmd+F, jumps, counts, no-match, Escape), zoom, page box and a clean console.

**Viewer files**: `src/preview/` (`main.ts` dispatch, `text.ts`, `image.ts`, `table.ts`, `pdf.ts`, `info.ts`, `shell.ts`, `style.css`).
`pnpm dev` runs the viewer build once first, `pnpm dev:preview` rebuilds on change. The viewer reads `?view=` and a `#L12`
line fragment from its URL (append `#L<n>` to a preview URL to jump to and highlight a line), reads text with a
`Range: bytes=0-<cap-1>` request (total size from `Content-Range`), sniffs extensionless files itself, and shows
html in the code view.

**Markdown**: `src/preview/markdown.ts` renders markdown with the app's `renderMarkdown` (marked GFM + DOMPurify, no
visual fences, so those stay plain code), shiki-highlights fences via `highlightWithin`, gives headings GitHub-style ids
(`links.ts`), shows flat YAML front matter as a small table and a collapsible Contents list from 4 headings. Relative
images get `?raw=1` (a plain URL would return the viewer page); remote images are not loaded (CSP `img-src 'self' data:
blob:`) and show their alt text. Links: `#x` scrolls, same-token links navigate the tab, `http(s)` open in a new tab
(`target=_blank`), everything else loses its `href`. `renderMarkdown(body, { fileLinks: false })`: the chat's file chips
(`span[data-file]`, wired up only in the chat) made every local link in a preview dead until 2026-10-05. The Source
button reloads the page with `?view=raw`.

**docx, pptx, xlsx**: see "Office formats", Implementation. `.doc` goes to the info card with a legacy-format title.

**Media and verification**: `src/preview/media.ts` is a bare `<video>`/`<audio controls>` over the raw URL. `node scripts/verify-file-preview.mjs`
(`pnpm verify:preview`, after `pnpm build`) is the end-to-end check through a throwaway app: every kind (DOCX, PPTX and XLSX from
generated files: what the canvas painted and the text layer), reopening an open file without a reload, a Markdown link into a
docx, confinement from a web tab, handler containment, live reload, chat file links (a Markdown file and a docx). It found that the handler answered a raw HTML page's own stylesheet/script/image
requests with the viewer page (they were viewer kinds without `?raw=1`); a request whose `Accept` lacks `text/html` is now a
subresource and gets bytes. Reality vs the spike: `img` from a web tab with a known token still loads, which is why the script asserts
fetch, iframe reads, navigation and `window.open` and not `img`. Not covered by the script: mp4 (no encoder; audio covers the
element), themes, split/full pane, pop-out window (eyeball).

## Size limits

| Kind | Limit | Over the limit |
|---|---|---|
| code / text / json / csv | 2 MB read into the viewer; highlighting capped at 512 KB or 10,000 lines | plain unhighlighted text for the rest; above 2 MB, first 2 MB + notice + "Open with default app" |
| markdown | 2 MB | raw mode for the rest |
| docx, pptx, xlsx | 25 MB (`PREVIEW_LIMITS.office`) | message pointing at Open with default app |
| image | no cap (Chromium decodes) | n/a |
| pdf, video, audio | none (pdf.js and media read with Range) | n/a |
| any file read by the handler | stream with `createReadStream` (spiked path), never `readFile` of the whole file | n/a |

Limits are constants in `src/shared/preview.ts`, enforced in the viewer (it knows the size from `Content-Length`/HEAD).

## Entry points

1. **Transcript**: absolute and cwd-relative file paths in tool details (`ToolDetails.tsx`, `lib/tools.ts`) and in
   prose (`Markdown.tsx` click handling) open a preview in the browser pane (existing `setPane`); middle/right click keeps
   the context menu: Reveal in Finder.
2. **Address bar**: `normalizeAddress` recognises absolute paths (`/…`, `~/…`) and `file://` URLs and turns them into a
   preview request instead of a search; `BrowserPane` shows the real path (`file` on the tab).
3. **Open file...** in the pane's start page and the app menu (native `dialog.showOpenDialog`).
4. **Drag and drop** of a file onto the pane (renderer reads the path with `webUtils.getPathForFile`).
5. **Agent**: `browser_open` accepts an absolute path (the extension passes it as is; main mints the token). The
   policy in the extension treats a path like a loopback URL (no approval), because it is the user's own project;
   paths outside the active cwd ask once per session like any other origin.
All entries go through one main method, `BrowserManager.openPreview(path, options) -> tab` (exposed as `browser.preview` in `host-core.ts`'s table, `window.studio.browser.preview` over IPC; `browser.previewMode`, `previewReveal` and `previewOpen` switch Rendered/Raw, reveal in Finder and open with the default app).

## Chat links

The agent cites files as Markdown links (`resources/pigna-prompt.md` asks for it); the transcript renders them as file chips and a click previews the file, like the Codex app.

- **Local targets** (`isLocalLinkHref`, `src/shared/preview.ts`): absolute paths, `~/`, `./`, `../`, bare relative paths (`src/a.ts`) and `file://` URLs, each with an optional `:line[:col]` or `#L<n>[-L<m>]` / `#L<n>C<c>` suffix (`parseLocalTarget` reads both; the first line wins). Percent-escapes decode (`<docs/A b.md>` and `docs/A%20b.md` both work). Everything else (`http(s)`, `mailto`, other schemes, `//host`, `#anchor`) keeps the old behavior: `openExternal`.
- **Rendering** (`lib/markdown.ts`): a local link becomes `<span class="file-link" data-file="<raw target>" data-kind="<kind>">` with no `href`, so nothing can navigate; `javascript:` and friends are still ordinary links that DOMPurify strips. The icon comes from `data-kind` (CSS mask).
- **Existence** (`resolvePreviewTargets(cwd, targets[]) -> (path | null)[]`, `main/browser/resolve-targets.ts`, 5 s cache; IPC `browser:resolve-targets`, host method `browser.resolveTargets`, desktop only): `Markdown.tsx` resolves once the message is complete (not while streaming) against the chat's cwd. Missing files lose `data-file` and render as muted text with a "File not found" tooltip. Before resolution (streaming) chips are clickable; a click on a missing file toasts the open error.
- **Images** (`![alt](target)` with a local target): `lib/markdown.ts` renders a `span.chat-image[data-image][data-file]` chip showing the alt text; once the message is complete and the target resolved, `loadChatImages` (`lib/preview.ts`) fetches the bytes (`readPreviewImage`, `main/browser/resolve-targets.ts`: image extensions only, 20 MB cap; IPC `browser:read-image`, host method `browser.readImage`, desktop only) and swaps in an `<img>` (data URL). A click opens the full-screen lightbox like tool-result images, not the preview; a plain link to an image (`[label](shot.png)`) stays a file link and opens the preview. Only the chat turns these on (`localImages`); the Markdown file viewer shares `renderMarkdown` and resolves its own relative images. A missing file is muted text; one that cannot be read stays a file link. A non-image local target renders as a file link; web images stay blocked by CSP. Tool-result images are not repeated above the answer: they stay on their tool rows in the work accordion, and the agent embeds what it wants to show (`browser_screenshot`'s `save` argument writes a JPEG it can embed). Phone: plain text, like file links.
- **Card links**: a link whose target is `card:<id>` or a bare card id (`[card q6ip3j](q6ip3j)`, `cardLinkId` in `src/shared/board.ts`) is not a file: it renders as `span.card-link[data-card]` (tooltip: title and column) and a click opens that card on its project's board (`openCardLink`). An id not on the board becomes muted text, "Card not found".
- **Bare paths**: inline code that `looksLikePath` (needs a `/` and a dotted file name, or a lone name with an extension the preview knows; no spaces, URLs, calls, versions) becomes `code[data-path]`. It turns into a file link only if the file exists.
- **Click**: plain click opens/focuses the preview and the pane, cmd/ctrl-click opens a new tab, Enter on a focused chip works too; the line scrolls the viewer.
- **Phone**: the mobile transcript shares `Markdown.tsx` but has no preview API, so file links render as plain muted text with the path as tooltip (no broken URL). Asking the host to open the preview from the phone is not done.

## Phone

The phone's Browser screen already lists tabs and streams the active view; a preview tab is just a tab, so it appears
and streams without change. The tab label shows the file name (from `file`), the address field shows the real path,
and the phone cannot type a path (no filesystem browsing there): it can open previews only through the agent or by
tapping a tab. Pop-out and DevTools buttons stay as they are for web tabs.

## Spike findings that overturned assumptions

- "Chromium renders raw kinds natively" holds for PDF, HTML and images; **not for bare media**:
  `loadURL` of a media URL rejects with `ERR_FAILED`. Media goes through the viewer.
- "Chromium blocks cross-origin access to the scheme": only for `fetch` (CORS). img, script, iframe, navigation and popups
  from a web tab are **not** blocked, and `Cross-Origin-Resource-Policy` has no effect for custom schemes. The handler
  cannot see an origin or Sec-Fetch headers, and the referrer is empty from https. Confinement rests on the token and
  on `BrowserManager` gating navigation/popups, not on Chromium.
- `stream` privilege is unnecessary; `supportFetchAPI` and `secure` are necessary.
- `registerSchemesAsPrivileged` is already called once in `registerAppScheme()`: the new scheme must be added to that
  array, not a second call.
- A root must be `realpath`ed before comparison (macOS `/tmp` is a symlink).
- mammoth is clearly worse (numbering, headers, images); docx-preview it was, until the canvas decision ("Office formats").

## Open questions

1. ~~PDF find~~: resolved by the pdf.js viewer (Cmd/Ctrl+F find card).
2. Should rendered HTML run with `connect-src` limited to its own origin and `localhost`? Prototypes call APIs; the dotfile
   deny list plus "never auto-open" was chosen instead. Revisit if an agent-fetched untrusted HTML flow appears.
3. Live reload of an HTML preview when a sibling asset changes (watching a whole root is costly): not done, only the opened file.
4. `.doc`, `.xls`, `.ppt` (legacy binary formats): info card. BetterOffice reads only OOXML.
5. ~~`browser_snapshot` on the Chromium PDF plugin~~: moot, PDFs are DOM pages with a pdf.js text layer now.
