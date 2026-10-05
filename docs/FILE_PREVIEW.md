# File preview

Source of truth for the file-preview feature (plan: `docs/plans/draft/file-preview.atp.json`, nodes T02-T11). A preview
is a normal browser tab: one `WebContentsView` in `persist:pigna-browser` that loads a privileged custom scheme. It
shares the tab strip, activation, pop-out, agent tools, DevTools and phone streaming with web tabs. Everything below
marked **(spiked)** was observed in a throwaway Electron 44.5.1 script (not committed); the rest is a decision.

## Decisions at a glance

| Topic | Decision |
|---|---|
| Scheme | `pigna-file`, registered in the one `registerAppScheme()` call with `{ standard: true, secure: true, supportFetchAPI: true }`. No `stream`, no `bypassCSP`, no `corsEnabled`. |
| URL | `pigna-file://<token>/<path relative to the root, percent-encoded>[?view=raw\|rendered\|source]` |
| Handler | `session.fromPartition("persist:pigna-browser").protocol.handle("pigna-file", ...)` in `src/main/file-preview/` (T02). Only on that session, never on the default session. |
| PDF | Served raw as `application/pdf`; Chromium's built-in viewer renders it. No pdf.js. |
| HTML | Served raw; relative assets resolve under the same token. Source mode goes through the viewer. |
| Media | Wrapped by the viewer (`<video>`/`<audio>` against the raw URL); handler supports Range. |
| docx | `docx-preview` (Apache-2.0) + `jszip` in the viewer bundle. Not mammoth. |
| Viewer build | Separate Vite entry `vite.preview.config.ts` -> `out/preview`, added to `scripts/build.mjs`. Not a static bundle under `resources/`. |
| Confinement | Token is the only capability. Handler enforces root containment (realpath) and a dotfile deny list; `BrowserManager` blocks navigation and popups from non-preview tabs to the scheme. |

## URL and token model

- A **root** is an absolute directory, resolved with `realpath` at mint time. It is the nearest project root (the
  active chat's cwd) when the file lies inside it, otherwise the file's own directory. A **token** is 16 random bytes
  (`randomBytes(16)`), hex, lowercase (32 chars; hosts are case-folded, so no base64). It maps to `{ root, openedAt }`.
- Tokens are minted by main only (the file-preview service called from the IPC/host method, the address bar, and the agent
  bridge). One token per root, reused for every file under that root, so relative links between files of one
  project work and Back/Forward stay on one origin. Lifetime: until app quit (in memory only, never persisted). The
  tokens are not written to `browser-history.json`: `remember()` already stores only `https?:` URLs, keep it so.
- The file the user opened is `<root>/<rel>`; the tab URL is `pigna-file://<token>/<rel>`. A tab must **show the real
  path**, not the token: the manager reports `BrowserTab.url` as `pigna-file://...` (needed internally) plus a new
  optional `file?: { path, kind }`; the renderer address bar shows `path` and the tab title is the file name. The
  agent's `browser_open` also accepts an absolute path and answers with the real path (T08).
- Reverse lookup (URL -> real path) lives next to the token table: `resolvePreviewUrl(url) -> { path, root } | undefined`.
  "Reveal in Finder", "Open with default app" and drag out use it.
- Query `?view=` selects the mode (see table). The default is per kind. The viewer reads it from `location`.

## Kind detection

Detection is by lowercase extension first; a file without a known extension is sniffed (first 4 KB: NUL byte => binary
info card; valid UTF-8 => text). `kindOf(path)` lives in `src/shared/preview.ts` (T02) so main, renderer, phone and the
agent extension share one table.

| Extension | Kind | Modes (default first) | Served |
|---|---|---|---|
| `pdf` | pdf | rendered | raw `application/pdf` (Chromium viewer) |
| `png jpg jpeg gif webp avif bmp ico` | image | rendered | viewer page (`<img>`, fit/zoom/checkerboard) over raw bytes |
| `svg` | image | rendered, source | viewer `<img src=raw>` (an `<img>` never runs SVG scripts); source = text viewer |
| `docx` | docx | rendered | viewer + docx-preview; `.doc` and other Office formats get the info card |
| `md markdown mdx` | markdown | rendered, raw | viewer; rendered goes through `renderMarkdown` (marked + DOMPurify) |
| `html htm xhtml` | html | rendered, source | rendered: raw bytes (scripts run, like a web page); source: viewer |
| `json jsonc` | json | tree/pretty, raw | viewer (highlighted, collapsible) |
| `csv tsv` | table | table, raw | viewer (first 5,000 rows rendered, rest in raw) |
| `mp4 mov m4v webm` | video | rendered | viewer `<video controls src=raw>` |
| `mp3 m4a wav ogg flac aac opus` | audio | rendered | viewer `<audio controls src=raw>` |
| code and text (`ts tsx js jsx py rs go rb java c cpp h css yml yaml toml sh sql txt log env ...` and sniffed text) | code / text | source | viewer, highlighted by the app's shiki setup, line numbers |
| everything else | other | info card | viewer: name, size, mtime, type, Reveal in Finder, Open with default app |

Raw kinds (pdf, html) are served as bytes by the handler. Every other kind loads `/__viewer/index.html?...` from
`out/preview` and the viewer fetches the file bytes from `pigna-file://<token>/<rel>?raw=1` (same origin). The handler
tells the two apart: for a rendered-by-viewer kind a navigation request (no `?raw=1`) returns the viewer HTML, a
`?raw=1` request returns bytes. `?raw=1` for pdf/html is identical to the default, so "Open raw" is a free toggle.

## Viewer architecture and theming

- One page, one bundle (`src/preview/`, React is not required; plain TS with small renderers per kind, lazy
  `import()` per kind so a markdown file does not load docx-preview and shiki is loaded only for code/json/md fences).
- Output `out/preview/` is served under `pigna-file://<token>/__viewer/*`; the `__viewer` prefix is reserved and read
  from `join(import.meta.dirname, "../preview")` (inside app.asar when packaged; `fs` reads it, like `out/mobile` and the
  renderer today). Files named `__viewer` in a project are unreachable: acceptable.
- The viewer response has a strict CSP: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none';
  object-src 'none'; base-uri 'none'; form-action 'none'`. (`'unsafe-inline'` styles are needed for docx-preview
  output and shiki.) Plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Viewer pages have no
  preload and no Node (the partition is already sandboxed, context-isolated).
- **Raw HTML gets no CSP from us** (it must behave like a web page), only `Referrer-Policy: no-referrer` and `nosniff`.
- Theming: the app theme is mirrored by `prefers-color-scheme` of the view (`nativeTheme` already follows the app);
  the viewer styles with CSS variables mirroring the renderer tokens and `color-scheme: light dark`. The rendered
  docx page stays white (it is a page); the surround follows the theme. Raw PDF/HTML keep their own look.
- Untrusted content rules: markdown rendered with `renderMarkdown` (DOMPurify), images inside it fetched through
  the same token; links to other files in the root navigate within the tab (relative), `https` links open as a new
  browser tab (existing `setWindowOpenHandler`), `file:` and other schemes are dropped.
- Live reload: main watches the opened file (`fs.watch` on the parent directory, filtered by name, 150 ms debounce,
  re-stat; macOS atomic saves replace the inode) and calls `webContents.reload()` on the tab; the viewer keeps scroll
  by restoring `scrollY` from `sessionStorage`. Watchers live while the tab lives. Reloading an HTML page when a sibling asset changes is not done (open question 3).

## Spike results (Electron 44.5.1, `persist:`-partition `WebContentsView`, handler on `ses.protocol`)

### a. PDF **(spiked)**

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
`ERR_ABORTED`. Hence media goes through the viewer page (a normal HTML document), and T02 must not load bare media.

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

## docx library **(spiked)**

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
runs in the viewer (T04) and needs no sanitization to be a script vector: it builds DOM nodes itself; still render it
into a container, never `innerHTML` of its own output string. Mammoth stays out.

## Viewer build **(decided)**

Separate Vite entry, `vite.preview.config.ts` (`root: src/preview`, `outDir: out/preview`, `emptyOutDir`, `base: "./"`,
minify), appended to the list in `scripts/build.mjs` next to the mobile build. Reasons: the viewer imports npm
packages (marked, DOMPurify, shiki, docx-preview) and needs the Vite pipeline, which `resources/visual` (hand-written
static files, no imports) does not have; `out/**` is already packed by electron-builder (`files: out/**`), so packaging
needs no change; `out/mobile` is the precedent for reading a built bundle from `import.meta.dirname` in main.
Dev: `electron-vite dev` does not run it; `pnpm dev` must build the viewer once (`vite build -c vite.preview.config.ts`,
`--watch` optional) before main starts, and main reports a clear 500 page "viewer not built" if `out/preview` is missing.
Shared code (`renderMarkdown`, `highlight`) is imported from `src/renderer/src/lib/` by relative path only if it has no
renderer-only imports (T03 checks); otherwise it moves to `src/shared/`.

**As built (T04)**: `src/preview/` (`main.ts` dispatch, `text.ts`, `image.ts`, `table.ts`, `info.ts`, `shell.ts`, `style.css`).
`pnpm dev` runs the viewer build once first, `pnpm dev:preview` rebuilds on change. The viewer reads `?view=` and a `#L12`
line fragment from its URL (append `#L<n>` to a preview URL to jump to and highlight a line), reads text with a
`Range: bytes=0-<cap-1>` request (total size from `Content-Range`), sniffs extensionless files itself, and shows
html in the code view. Media and docx fall to the info card until their nodes.

**As built (T05)**: `src/preview/markdown.ts` renders markdown with the app's `renderMarkdown` (marked GFM + DOMPurify, no
visual fences, so those stay plain code), shiki-highlights fences via `highlightWithin`, gives headings GitHub-style ids
(`links.ts`), shows flat YAML front matter as a small table and a collapsible Contents list from 4 headings. Relative
images get `?raw=1` (a plain URL would return the viewer page); remote images are not loaded (CSP `img-src 'self' data:
blob:`) and show their alt text. Links: `#x` scrolls, same-token links navigate the tab, `http(s)` open in a new tab
(`target=_blank`), everything else loses its `href`. The Source button reloads the page with `?view=raw`.

**As built (T06)**: `src/preview/docx.ts` (lazy `import("docx-preview")`, `jszip` is its declared dependency). Pages render into a
detached container first, so a failure shows a message instead of a blank page; they stay white on the themed surround,
`Fit` (default, scales with CSS `zoom` to the pane width, never above 100%) / `-` / `+` / ctrl-cmd-wheel / `0` zoom,
footer shows page count and size. No raw mode: docx is rendered-only. Messages: empty file; over `PREVIEW_LIMITS.docx`
(25 MB) -> message pointing at Open with default app; OLE header (`D0 CF 11 E0`: legacy or password-protected, Word encrypts
`.docx` into an OLE container) -> "Can't preview"; not a zip -> "not a valid .docx"; renderer throws -> "may be corrupt".
`.doc` goes to the info card with a legacy-format title. **CSP unchanged**: docx-preview emits inline `style` attributes and
`<style>` (covered by `style-src 'unsafe-inline'`) and with `useBase64URL: true` images are `data:` URIs (`img-src data:`);
`script-src 'self'` is untouched. Checked in a throwaway Electron harness on real contracts (dark and light), a corrupt
file, a fake OLE `.docx` and `.doc`. Progressive rendering is not done: the 25 MB cap is the guard. Tracked changes are not
shown (`renderChanges: false`: deletions hidden, insertions shown as plain text).

## Size limits

| Kind | Limit | Over the limit |
|---|---|---|
| code / text / json / csv | 2 MB read into the viewer; highlighting capped at 512 KB or 10,000 lines | plain unhighlighted text for the rest; above 2 MB, first 2 MB + notice + "Open with default app" |
| markdown | 2 MB | raw mode for the rest |
| docx | 25 MB | info card |
| image | no cap (Chromium decodes) | n/a |
| pdf, video, audio | none (streamed with Range) | n/a |
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
All entries go through one main method, `openFile(path) -> tabId` (in `host-core.ts`'s table so IPC and the phone share it).

## Chat links

The agent cites files as Markdown links (`resources/pigna-prompt.md` asks for it); the transcript renders them as file chips and a click previews the file, like the Codex app.

- **Local targets** (`isLocalLinkHref`, `src/shared/preview.ts`): absolute paths, `~/`, `./`, `../`, bare relative paths (`src/a.ts`) and `file://` URLs, each with an optional `:line[:col]` or `#L<n>[-L<m>]` / `#L<n>C<c>` suffix (`parseLocalTarget` reads both; the first line wins). Percent-escapes decode (`<docs/A b.md>` and `docs/A%20b.md` both work). Everything else (`http(s)`, `mailto`, other schemes, `//host`, `#anchor`) keeps the old behavior: `openExternal`.
- **Rendering** (`lib/markdown.ts`): a local link becomes `<span class="file-link" data-file="<raw target>" data-kind="<kind>">` with no `href`, so nothing can navigate; `javascript:` and friends are still ordinary links that DOMPurify strips. The icon comes from `data-kind` (CSS mask).
- **Existence** (`resolvePreviewTargets(cwd, targets[]) -> (path | null)[]`, `main/browser/resolve-targets.ts`, 5 s cache; IPC `browser:resolve-targets`, host method `browser.resolveTargets`, desktop only): `Markdown.tsx` resolves once the message is complete (not while streaming) against the chat's cwd. Missing files lose `data-file` and render as muted text with a "File not found" tooltip. Before resolution (streaming) chips are clickable; a click on a missing file toasts the open error.
- **Bare paths**: inline code that `looksLikePath` (needs a `/` and a dotted file name, or a lone name with an extension the preview knows; no spaces, URLs, calls, versions) becomes `code[data-path]`. It turns into a file link only if the file exists.
- **Click**: plain click opens/focuses the preview and the pane, cmd/ctrl-click opens a new tab, Enter on a focused chip works too; the line scrolls the viewer.
- **Phone**: the mobile transcript shares `Markdown.tsx` but has no preview API, so file links render as plain muted text with the path as tooltip (no broken URL). Asking the host to open the preview from the phone is not done.

## Phone

The phone's Browser screen already lists tabs and streams the active view; a preview tab is just a tab, so it appears
and streams without change. The tab label shows the file name (from `file`), the address field shows the real path,
and the phone cannot type a path (no filesystem browsing there): it can open previews only through the agent or by
tapping a tab. Pop-out and DevTools buttons stay as they are for web tabs.

## What the spike disproved or corrected in the plan's context

- The plan's wording "Chromium renders raw kinds natively" holds for PDF, HTML and images; **not for bare media**:
  `loadURL` of a media URL rejects with `ERR_FAILED`. Media goes through the viewer.
- "Chromium blocks cross-origin access to the scheme": only for `fetch` (CORS). img, script, iframe, navigation and popups
  from a web tab are **not** blocked, and `Cross-Origin-Resource-Policy` has no effect for custom schemes. The handler
  cannot see an origin or Sec-Fetch headers, and the referrer is empty from https. Confinement rests on the token and
  on `BrowserManager` gating navigation/popups, not on Chromium.
- `stream` privilege is unnecessary; `supportFetchAPI` and `secure` are necessary.
- `registerSchemesAsPrivileged` is already called once in `registerAppScheme()`: the new scheme must be added to that
  array, not a second call.
- A root must be `realpath`ed before comparison (macOS `/tmp` is a symlink).
- mammoth is clearly worse (numbering, headers, images); docx-preview it is.

## Open questions

1. PDF find (Cmd+F) was not observed in an Electron `WebContentsView`; decide whether to hand-roll nothing (accept) or add
   a pdf.js viewer later. Not needed for the first release.
2. Should rendered HTML run with `connect-src` limited to its own origin and `localhost`? Prototypes call APIs; the dotfile
   deny list plus "never auto-open" was chosen instead. Revisit if an agent-fetched untrusted HTML flow appears.
3. Live reload of an HTML preview when a sibling asset changes (watching a whole root is costly): not done, only the opened file.
4. `.doc`, `.xlsx`, `.pptx`: info card for now.
5. Whether `browser_snapshot` (accessibility/DOM walk) gives useful output on the Chromium PDF viewer (it is a plugin/OOPIF); the
   screenshot works (spiked), the snapshot was not tried.
