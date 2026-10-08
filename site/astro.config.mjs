// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';

/** @param {string} pkg @param {string} file */
const fontsource = (pkg, file) => `@fontsource${pkg}/files/${file}.woff2`;

export default defineConfig({
  site: 'https://pi-gna.com',
  // Cloudflare's asset handling ("auto-trailing-slash") serves /about/ for /about, so canonical URLs end in a slash.
  trailingSlash: 'always',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
  integrations: [sitemap({ filter: (page) => !page.endsWith('/404/') })],
  fonts: [
    {
      name: 'Bricolage Grotesque',
      cssVariable: '--font-display',
      provider: fontProviders.local(),
      fallbacks: ['system-ui', 'sans-serif'],
      options: {
        variants: [
          {
            src: [fontsource('-variable/bricolage-grotesque', 'bricolage-grotesque-latin-opsz-normal')],
            weight: '200 800',
            style: 'normal',
          },
        ],
      },
    },
    {
      name: 'Instrument Serif',
      cssVariable: '--font-serif',
      provider: fontProviders.local(),
      fallbacks: ['Georgia', 'serif'],
      options: {
        variants: [
          { src: [fontsource('/instrument-serif', 'instrument-serif-latin-400-italic')], weight: 400, style: 'italic' },
        ],
      },
    },
    {
      name: 'JetBrains Mono',
      cssVariable: '--font-mono',
      provider: fontProviders.local(),
      fallbacks: ['ui-monospace', 'monospace'],
      options: {
        variants: [
          {
            src: [fontsource('-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal')],
            weight: '100 800',
            style: 'normal',
          },
        ],
      },
    },
  ],
});
