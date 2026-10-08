import source from '../../../CHANGELOG.md?raw';

export interface Release {
  version: string;
  date: string;
  items: string[];
}

/** The releases in the repository's CHANGELOG.md, newest first; Unreleased is left out. */
export function releases(): Release[] {
  const out: Release[] = [];
  let current: Release | undefined;
  for (const line of source.split('\n')) {
    const heading = line.match(/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})/);
    if (heading) {
      current = { version: heading[1], date: heading[2], items: [] };
      out.push(current);
    } else if (line.startsWith('## ')) {
      current = undefined;
    } else if (!current) {
      continue;
    } else if (line.startsWith('- ')) {
      current.items.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && current.items.length) {
      current.items[current.items.length - 1] += ` ${line.trim()}`;
    }
  }
  return out;
}

export const formatDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
