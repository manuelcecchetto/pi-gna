# pi-gna.com

The website for pi-gna: a static [Astro](https://astro.build) site served by Cloudflare Workers static assets. No
server code, no client framework, no analytics; each page ships its HTML, a few small CSS files and inline scripts.

```bash
pnpm install
pnpm dev        # http://localhost:4321
pnpm check      # astro check (TypeScript 6: astro check does not support 7 yet)
pnpm build      # dist/
npx wrangler dev   # serve dist/ the way Cloudflare will: redirects, 404, _headers
```

## Layout

| Path | What |
|---|---|
| `src/pages/` | Home, `features/` (index and one page per feature), download, about, faq, changelog, 404 |
| `src/data/features.ts` | Every feature's copy, color, pose and points. The home grid, the features index, the feature pages and their share images all read it |
| `src/data/site.ts` | URLs, download links, nav |
| `src/components/demos/` | The animated app scenes on the feature pages, one per feature (`index.ts` maps slug to demo) |
| `src/components/HeroMascot.astro` | The home hero: Pigna's body is `hero-base.webp`, the face is SVG from `src/data/hero-face.json` so it can look, blink and smile |
| `src/lib/changelog.ts` | Reads `../CHANGELOG.md` at build time for the changelog page, the download page's version and the about page's numbers |
| `src/styles/` | `global.css` (tokens, palette, buttons, reveal), `demo.css` (the app's dark theme for demos) |
| `public/` | `_headers`, `robots.txt`, icons, `og/` share images |
| `tools/mascot/` | How the mascot art was made and cleaned ([README](tools/mascot/README.md)) |

The changelog page and the download page's version come from `CHANGELOG.md`, so pushing a release to `main`
redeploys the site (see Deploy).

### Demos

`DemoFrame` runs each scene at a fixed design size (720×430, the phone 300×620) and scales it to fit. Elements
appear by step: `data-at="3"` shows from step 3, `data-off="5"` hides from step 5, `data-seq` numbers children,
`data-type` types text out. While working on one, run `document.querySelector('[data-demo]').showStep(n)` in the
console to hold a step. Every demo has a Pause button; with reduced motion it holds the last step instead. Keep them true to the app: pi's Computer Use cursor is the 🤌 hand from `native/computer-use`, and the shared
browser has no agent cursor.

## Deploy

Pushing to `main` deploys: [`.github/workflows/site.yml`](../.github/workflows/site.yml) runs when `site/`,
`CHANGELOG.md` or the workflow change (so pushing a release refreshes the changelog and download pages), then checks,
builds and runs `wrangler deploy`. It needs the repo secret `CLOUDFLARE_API_TOKEN`: a Cloudflare API token made from
the "Edit Cloudflare Workers" template, limited to this account and the pi-gna.com zone. Run it by hand with
`gh workflow run site.yml`.

From your machine, in `site/`:

```bash
npx wrangler login     # once
pnpm run deploy        # astro build && wrangler deploy
```

Use `pnpm run deploy`: plain `pnpm deploy` is pnpm's own workspace command.

`wrangler.jsonc` uploads `dist/` as static assets (there is no Worker script) and attaches pi-gna.com as the Worker's
Custom Domain, DNS record included. workers.dev and preview URLs are off, so the site has one address.
`www.pi-gna.com` is a Redirect Rule in the Cloudflare dashboard (www to the apex, 301, path and query kept) on a
proxied `www` DNS record; wrangler's login cannot manage rules.

URLs end in a slash (`trailingSlash: 'always'`, and every link and canonical uses it). Cloudflare's
`auto-trailing-slash` redirects `/download` to `/download/`; unknown paths get `404.html` with a 404 status.
`public/_headers` sets security headers and a year of immutable caching for the hashed files in `/_astro/`.

## Share images

`public/og/<name>.jpg` (1200×630) are screenshots of the dev-only route `src/pages/og/[slug].astro`, so they use the
site's real fonts and art; production builds generate no pages there. To redo one after changing its copy or pose:

1. `pnpm dev`, open `/og/<name>/` (`home`, `features`, `download`, `about`, `faq`, `changelog`, `feature-<slug>`).
2. Set the viewport to exactly 1200×630 at 1x (Chrome DevTools device toolbar) and capture a screenshot.
3. `sips -s format jpeg -s formatOptions 85 shot.png --out public/og/<name>.jpg`

Pages pick their image with the `og` prop of `Base.astro`. A new feature needs its own `feature-<slug>.jpg`.
