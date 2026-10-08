import type { ImageMetadata } from 'astro';
import chat from '../assets/mascot/chat.webp';
import browser from '../assets/mascot/browser.webp';
import computer from '../assets/mascot/computer.webp';
import kanban from '../assets/mascot/kanban.webp';
import detective from '../assets/mascot/detective.webp';
import laments from '../assets/mascot/laments.webp';
import atp from '../assets/mascot/atp.webp';
import phone from '../assets/mascot/phone.webp';
import visuals from '../assets/mascot/visuals.webp';
import plugins from '../assets/mascot/plugins.webp';

/** A palette name from global.css: `--<color>` is the strong hue, `--<color>-soft` the tint. */
export type Color = 'sky' | 'blue' | 'lilac' | 'coral' | 'mint' | 'rain' | 'gold' | 'teal' | 'pink' | 'lime';

export interface Feature {
  slug: string;
  /** Short name for cards and navigation. */
  name: string;
  /** The feature page's H1. */
  title: string;
  /** One line for cards. */
  summary: string;
  /** The paragraph under the H1; also the meta description. */
  tagline: string;
  pose: ImageMetadata;
  /** What the mascot is doing, for alt text. */
  poseAlt: string;
  color: Color;
  keys: { keys: string[]; label: string }[];
  /** Body text accepts `code` and **bold**. */
  points: { title: string; body: string }[];
}

export const FEATURES: Feature[] = [
  {
    slug: 'chat',
    name: 'Chats',
    title: 'Chats you can actually read',
    summary: 'Markdown, diffs and thinking, with tool calls folded into tidy groups.',
    tagline:
      'Every pi chat, rendered properly: highlighted code, diffs from pi’s edits, thinking in full and tool calls grouped per run. Type while pi works to steer it.',
    pose: chat,
    poseAlt: 'Pigna reading a very long scroll of code',
    color: 'blue',
    keys: [
      { keys: ['⌘', 'K'], label: 'Search every chat, card, page and setting' },
      { keys: ['⌃', 'O'], label: 'Expand or collapse every tool call' },
      { keys: ['⌥', '↑'], label: 'Jump to the previous message you sent' },
      { keys: ['⌥', '↩'], label: 'Queue a follow-up while pi works' },
      { keys: ['Esc', 'Esc'], label: 'Stop the run and pull queued messages back' },
    ],
    points: [
      {
        title: 'Tool calls, grouped',
        body: 'Each run’s tool calls fold into one tidy group. **Ctrl+O** opens them all when you want the details.',
      },
      {
        title: 'Diffs, not walls of text',
        body: 'Edits from pi’s `edit` tool show as diffs, code is highlighted and thinking is there in full.',
      },
      {
        title: 'Steer and queue',
        body: 'Type while pi works to steer the current run, **Alt+Enter** to queue a follow-up, **Esc** twice to stop and get your queued messages back.',
      },
      {
        title: 'A rail for long chats',
        body: 'Jump between the messages you sent with **⌥↑** and **⌥↓**, or click and drag the rail beside the chat. Bookmark the good bits.',
      },
      {
        title: '⌘K finds anything',
        body: 'Every chat in every project, the Kanban board’s cards, the pages, the settings and the app’s commands, newest first.',
      },
      {
        title: 'Every project in one place',
        body: 'The sidebar lists your pi sessions by project, terminal ones too. A mark shows when pi is working, waiting for you, failed or finished while you were away.',
      },
      {
        title: 'Context at a glance',
        body: 'A meter shows context use, auto-compaction and cache hits; the composer shows how fast the model writes, in tokens per second.',
      },
      {
        title: 'Screenshots as galleries',
        body: 'Images in a reply become a row of thumbnails. Click one for a lightbox that pages through every image in the answer.',
      },
    ],
  },
  {
    slug: 'browser',
    name: 'Shared browser',
    title: 'A browser you share with pi',
    summary: 'pi opens your dev server, clicks around and takes screenshots while you watch.',
    tagline:
      '⌘B opens a browser pane next to the chat, and pi gets tools to drive it: it opens your dev server, clicks, types, reads the page and takes screenshots while you watch.',
    pose: browser,
    poseAlt: 'Pigna surfing a wave on a browser window',
    color: 'sky',
    keys: [{ keys: ['⌘', 'B'], label: 'Show or hide the browser' }],
    points: [
      {
        title: 'pi drives, you watch',
        body: 'pi gets `browser_*` tools for the pane: open a page, click, type, read it, screenshot it. Local URLs open without asking; other sites ask once per session.',
      },
      {
        title: 'Comment on elements',
        body: 'Point at any element and leave a note. pi gets your comments with a crop of each element, so “make this bigger” finally means something.',
      },
      {
        title: 'Responsive in one click',
        body: 'The Dimensions bar has phone and laptop presets that change the User-Agent too. pi can set a viewport or open device-sized windows on its own.',
      },
      {
        title: 'Preview any file',
        body: 'PDF, images, Word `.docx`, Markdown, HTML, code, JSON, CSV, audio and video open as a tab, and reload when the file changes on disk.',
      },
      {
        title: 'Rendered or raw',
        body: 'Markdown, HTML, JSON and CSV switch between Rendered and Raw. Anything else gets an info card with Reveal in Finder.',
      },
    ],
  },
  {
    slug: 'computer-use',
    name: 'Computer Use',
    title: 'pi uses your Mac’s apps, not your mouse',
    summary: 'Native Mac apps in the background, with a cursor of pi’s own.',
    tagline:
      'With Computer Use on, pi works your Mac’s native apps in the background. It clicks and types with a cursor of its own, so you keep your mouse, your focus and your flow.',
    pose: computer,
    poseAlt: 'Pigna riding a giant mouse cursor',
    color: 'lilac',
    keys: [
      { keys: ['⌘', '⇧', 'U'], label: 'Show or hide Settings › Computer use' },
      { keys: ['Esc'], label: 'Stop pi’s computer use' },
    ],
    points: [
      {
        title: 'A cursor of its own',
        body: 'pi reads an app’s accessibility tree and window, then clicks and types with its own cursor. Your mouse and focus stay yours.',
      },
      {
        title: 'You approve each app',
        body: 'Once, or always. Terminals, pi-gna itself and system security prompts are always off limits.',
      },
      {
        title: 'Esc stops it',
        body: 'One key and pi lets go of the app. The phone gets a Stop button too.',
      },
      {
        title: 'Six ways to move',
        body: 'The cursor glides along hand-tuned curves: Signature arc, Spring settle, Magnetic, Comet swoop, Adaptive or Classic. With Reduce Motion on it simply jumps.',
      },
      {
        title: 'Grants that stick',
        body: 'Release builds sign the helper with a stable certificate, so Accessibility and Screen Recording survive updates.',
      },
    ],
  },
  {
    slug: 'kanban',
    name: 'Kanban',
    title: 'A Kanban board for every project',
    summary: 'Describe a task, get a card. Right-click it and a chat gets to work.',
    tagline:
      'Describe a task in your own words and it becomes a card. Right-click it and a new chat investigates it, resolves it in a git worktree or QAs it.',
    pose: kanban,
    poseAlt: 'Pigna holding up a sticky note',
    color: 'mint',
    keys: [{ keys: ['⌘', '⇧', 'K'], label: 'Show or hide the project’s board' }],
    points: [
      {
        title: 'Cards from plain words',
        body: 'Describe a task, with screenshots if you like, and a quick Sonnet chat titles it, tags it and takes a first look.',
      },
      {
        title: 'Resolve it in a worktree',
        body: 'Right-click a card to investigate it, resolve it in a git worktree on a branch of its own, or QA it once it is in review. Your checkout is left alone.',
      },
      {
        title: 'pi moves its own cards',
        body: 'pi gets `kanban_*` tools to take a card, move it across To do, In progress, In review and Done, and report on it.',
      },
      {
        title: 'Chats wear their card',
        body: 'Chats working on a card show their mark on it, so you see at a glance what is moving.',
      },
      {
        title: 'Linked to GitHub',
        body: 'Make a card from an issue or pull request, or link one to a card. Cards show their links.',
      },
    ],
  },
  {
    slug: 'github',
    name: 'GitHub',
    title: 'Issues and pull requests, under the magnifier',
    summary: 'Each project’s issues and PRs. Review a PR without touching your checkout.',
    tagline:
      'Every project gets a GitHub page with its issues and pull requests. Click Review and a fresh chat reviews the PR without touching your checkout.',
    pose: detective,
    poseAlt: 'Pigna as a detective with a magnifying glass',
    color: 'teal',
    keys: [{ keys: ['⌘', '⇧', 'G'], label: 'Show or hide the project’s GitHub page' }],
    points: [
      {
        title: 'Read with your own gh',
        body: 'Issues and PRs, open or closed, read with the GitHub CLI as the account that can see the repository. Your active gh account is never switched.',
      },
      {
        title: 'Review a PR',
        body: 'Review opens a new chat that reviews the pull request with pi-gna’s bundled pr-review skill. Findings stay in the chat unless you ask pi to post them.',
      },
      {
        title: 'Cards from issues',
        body: 'Turn an issue or PR into a Kanban card, or link it to one, by number or URL.',
      },
      {
        title: 'Ask from any chat',
        body: 'Chats opened while GitHub is on can use the skill too: “review PR #12”.',
      },
    ],
  },
  {
    slug: 'laments',
    name: 'Laments',
    title: 'Laments: pi complains, you fix',
    summary: 'When a tool is missing or failing, pi files a lament and carries on.',
    tagline:
      'When pi needs a tool that is missing, unavailable or failing, it files a lament and carries on with a workaround. Read them to see what your setup lacks, then fix it.',
    pose: laments,
    poseAlt: 'Pigna wailing under a rain cloud',
    color: 'rain',
    keys: [{ keys: ['⌘', '⇧', 'L'], label: 'Show or hide the project’s laments' }],
    points: [
      {
        title: 'Three ways to sigh',
        body: '😒 **Annoying**, 😠 **Costly** or 🤬 **Blocking**. pi files each one with its `lament` tool, then gets on with a workaround.',
      },
      {
        title: 'See what your setup lacks',
        body: 'The Lamenting board collects every complaint per project, so the tool that keeps letting pi down is hard to miss.',
      },
      {
        title: 'Fix it in a worktree',
        body: 'Click Fix and a new chat fixes the lament in a git worktree, on a branch of its own. Mark it resolved once the fix is in.',
      },
      {
        title: 'On the phone too',
        body: 'Laments show on the iPhone remote with their severity, next to the board and GitHub.',
      },
    ],
  },
  {
    slug: 'atp',
    name: 'ATP plans',
    title: 'Big projects, conducted',
    summary: 'A graph of tasks, run node by node by worker chats.',
    tagline:
      'Run big projects as ATP plans: a graph of tasks that worker chats take on one node at a time, while an orchestrator chat keeps the tempo.',
    pose: atp,
    poseAlt: 'Pigna conducting with a baton and music notes',
    color: 'gold',
    keys: [{ keys: ['⌘', '⇧', 'A'], label: 'Show or hide the project’s ATP plans' }],
    points: [
      {
        title: 'Draft a plan',
        body: 'The bundled macro or micro architect writes the plan as an `.atp.json` graph of tasks.',
      },
      {
        title: 'Workers, node by node',
        body: 'Start runs the plan: each node gets a fresh worker chat that completes, fails or splits it, and commits it as `node(<ID>): …`.',
      },
      {
        title: 'A live graph',
        body: 'Hundreds of nodes, zoomable, with running nodes glowing. Click a node for its instruction, report and chats.',
      },
      {
        title: 'An orchestrator to talk to',
        body: 'Its chat tells you how the plan is going, and can edit or extend it.',
      },
      {
        title: 'Off your checkout',
        body: 'A new plan runs in its own git worktree, so its workers and commits stay out of your way.',
      },
    ],
  },
  {
    slug: 'phone',
    name: 'iPhone remote',
    title: 'Your Mac’s pi, in your pocket',
    summary: 'Chats, approvals and the board from your iPhone, over Tailscale.',
    tagline:
      'Use the pi-gna on your Mac from your iPhone, over Tailscale: chats, approvals, the board and the browser, from wherever your beach chair is.',
    pose: phone,
    poseAlt: 'Pigna relaxing in a beach chair with a phone',
    color: 'coral',
    keys: [],
    points: [
      {
        title: 'Your tailnet only',
        body: 'It runs over `tailscale serve` with HTTPS and is reachable only from your own tailnet. Never Funnel, never the public internet. Off by default.',
      },
      {
        title: 'Pair with a code',
        body: 'Add it to your Home Screen, enter a one-time code from the Mac and allow it there. Revoke any phone from Settings.',
      },
      {
        title: 'Almost everything works',
        body: 'Send, steer, queue and stop; approve tool calls; attach photos; the Kanban board, Laments, GitHub, ATP plans and the Mac’s browser tabs, live.',
      },
      {
        title: 'Pushes that say little',
        body: 'Notifications when pi needs an approval or a run finishes or fails. They carry no chat text.',
      },
      {
        title: 'The Mac does the work',
        body: 'pi, your repositories, the browser and Computer Use stay on the Mac; the phone shows and controls them. Keep the Mac awake.',
      },
    ],
  },
  {
    slug: 'visuals',
    name: 'Inline visuals',
    title: 'Answers that draw',
    summary: 'Diagrams, charts and clickable mocks, right in pi’s reply.',
    tagline:
      'pi can put a diagram, a chart, a timeline or a clickable UI mock right in its reply. In beta, and off until you turn it on.',
    pose: visuals,
    poseAlt: 'Pigna painting a bar chart at an easel',
    color: 'pink',
    keys: [],
    points: [
      {
        title: 'Diagrams and charts',
        body: 'Flows, architectures, comparisons and per-module numbers, drawn as a small visual inside the answer.',
      },
      {
        title: 'Clickable UI mocks',
        body: 'Weighing a UI change? pi mocks each option in your product’s own look, with menus and popovers that open, before anything is built.',
      },
      {
        title: 'Flows that play',
        body: 'Animated flows play through their stages with Pause, Restart and speed controls, then stop on the last frame.',
      },
      {
        title: 'Sandboxed',
        body: 'Visuals run in a sandbox with no network, and the text around them always answers on its own.',
      },
      {
        title: 'Turn it on',
        body: '**Settings › Agent › Beta › Inline visuals**, then open a new chat.',
      },
    ],
  },
  {
    slug: 'plugins',
    name: 'Plugins & settings',
    title: 'Plug in, sign in, make it yours',
    summary: 'MCP apps, pi packages, providers and themes, in pi’s own config.',
    tagline:
      'Connect apps over MCP, install pi packages, sign in to model providers and give each project its own look. Everything lands in pi’s own config.',
    pose: plugins,
    poseAlt: 'Pigna winking with a power plug',
    color: 'lime',
    keys: [{ keys: ['⌘', ','], label: 'Open Settings' }],
    points: [
      {
        title: 'MCP apps',
        body: 'Attio, Notion, Granola, Intercom and Brevo connect from **Settings › Plugins**.',
      },
      {
        title: 'pi packages',
        body: 'Install from a short catalog, then switch packages and each of their extensions, skills and prompts on or off, for you or for one project.',
      },
      {
        title: 'Providers',
        body: 'Sign in to pi’s model providers with an account or an API key, as pi’s `/login` does.',
      },
      {
        title: 'One config, two homes',
        body: 'Everything is written to pi’s own `settings.json` and `mcp.json`, so pi in the terminal sees the same.',
      },
      {
        title: 'Your extensions, drawn natively',
        body: 'Extension dialogs become approval cards, notices become toasts and widgets sit above the composer.',
      },
      {
        title: 'Themes and wallpapers',
        body: 'Pick a theme, fonts and colors, and a wallpaper behind each project’s new chat.',
      },
    ],
  },
];

export const featureBySlug = (slug: string) => FEATURES.find((f) => f.slug === slug);
