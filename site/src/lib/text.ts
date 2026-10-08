import { SITE } from '../data/site';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Repo-relative links in the changelog point at files on GitHub. */
const href = (url: string) => (/^[a-z]+:/i.test(url) || url.startsWith('#') ? url : `${SITE.repo}/blob/main/${url}`);

/** The inline Markdown the copy and the changelog use: `code`, **bold**, *italic* and [links](url). */
export function inline(md: string): string {
  return md
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => `<a href="${href(url)}">${text}</a>`)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
    })
    .join('');
}

/** Plain text of inline Markdown, for meta tags and JSON-LD. */
export const plain = (md: string) => md.replace(/`([^`]+)`/g, '$1').replace(/\*\*?([^*]+)\*\*?/g, '$1');
