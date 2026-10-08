export const SITE = {
  name: 'pi-gna',
  url: 'https://pi-gna.com',
  tagline: 'The desktop app for the pi coding agent',
  description:
    'pi-gna is a free, open-source Mac app for the pi coding agent: readable chats, a browser you share with pi, Computer Use, a Kanban board, GitHub reviews, ATP plans and your iPhone. It runs the pi you already have.',
  repo: 'https://github.com/manuelcecchetto/pi-gna',
  releases: 'https://github.com/manuelcecchetto/pi-gna/releases',
  latest: 'https://github.com/manuelcecchetto/pi-gna/releases/latest',
  dmgArm: 'https://github.com/manuelcecchetto/pi-gna/releases/latest/download/pi-gna-arm64.dmg',
  dmgIntel: 'https://github.com/manuelcecchetto/pi-gna/releases/latest/download/pi-gna-x64.dmg',
  pi: 'https://pi.dev',
  author: { name: 'Manuel Cecchetto', url: 'https://github.com/manuelcecchetto' },
  installCommand: 'pi install git:github.com/manuelcecchetto/pi-gna',
  agentPrompt:
    'Install pi-gna for me by following the "For agents" steps in https://github.com/manuelcecchetto/pi-gna',
  quarantineCommand: 'xattr -dr com.apple.quarantine /Applications/pi-gna.app',
} as const;

export const NAV = [
  { href: '/features/', label: 'Features' },
  { href: '/faq/', label: 'FAQ' },
  { href: '/changelog/', label: 'Changelog' },
  { href: '/about/', label: 'About' },
] as const;

/** Things Pigna says when you poke it. */
export const EXCLAMATIONS = [
  'Mamma mia!',
  'Che bello!',
  'Andiamo!',
  'Perfetto!',
  'Bellissimo!',
  'Ecco qua!',
  'Dai, dai!',
  'Ma dai!',
  'Forza!',
  'Allora…',
  'Magari!',
  'Boh!',
  'Eccomi!',
  'Che figata!',
] as const;
