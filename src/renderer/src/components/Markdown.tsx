import { memo, type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type ChatLinks, type ChatUi, ChatUiProvider, type ChatUiState, useChatActions, useChatUiHandle, useChatUi } from "../lib/chat-ui";
import { VisualFrame } from "./VisualFrame";
import { highlightWithin, observeHighlight } from "../lib/highlight";
import { type LexedMarkdown, lexMarkdown, renderMarkdownBlocks, renderMarkdownCached } from "../lib/markdown";
import { decorateWebLinks, loadChatImages, openCardLink, openFileLink, resolveCardLinks, resolveFileLinks } from "../lib/preview";

interface ProseActions {
  openExternal(url: string): void;
  openLightbox(src: string, images: string[]): void;
  links?: ChatLinks;
  homeDir: string;
  board: ChatUiState["board"];
}

function onProseClick(event: MouseEvent<HTMLElement>, { openExternal, openLightbox, links, homeDir, board }: ProseActions): void {
  const target = event.target as HTMLElement;
  const copy = target.closest<HTMLButtonElement>("[data-copy]");
  if (copy) {
    const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard.writeText(code);
    copy.textContent = "Copied";
    setTimeout(() => {
      copy.textContent = "Copy";
    }, 1200);
    return;
  }
  // An embedded image opens full screen, like tool-result images, and pages through the answer's other images.
  const image = target.closest<HTMLElement>("[data-image]")?.querySelector("img");
  if (image) {
    openLightbox(image.src, [...event.currentTarget.querySelectorAll<HTMLImageElement>("[data-image] img")].map((img) => img.src));
    return;
  }
  const card = target.closest<HTMLElement>("[data-card]");
  if (card) {
    event.preventDefault();
    openCardLink(card, links, board);
    return;
  }
  const file = target.closest<HTMLElement>("[data-file]");
  if (file) {
    event.preventDefault();
    openFileLink(file, event, links, homeDir);
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    openExternal(link.href);
  }
}

const OPEN_VISUAL = /(^|\n)(```+|~~~+)[ \t]*visual\b[^\n]*\n(?![\s\S]*\n\2[ \t]*(\n|$))[\s\S]*$/;

/** What a Markdown element shows: the HTML of each block and the nodes it put in for it. */
interface ShownBlocks {
  html: string[];
  nodes: ChildNode[][];
}

/**
 * Makes `root`'s children show `html`, one entry per block, replacing only the blocks whose HTML changed: the rest keep
 * their nodes (and a selection, an icon or a loaded image in them). Returns the elements it put in.
 */
function patchBlocks(root: HTMLElement, shown: ShownBlocks, html: string[]): Element[] {
  const keep = html.map((block, index) => shown.html[index] === block);
  shown.nodes.forEach((nodes, index) => {
    if (!keep[index]) for (const node of nodes) node.remove();
  });
  const nodes: ChildNode[][] = [];
  const added: Element[] = [];
  // Backwards, so each new block goes in before the first node of the block after it.
  let before: ChildNode | null = null;
  for (let index = html.length - 1; index >= 0; index--) {
    let block = shown.nodes[index];
    if (!keep[index] || !block) {
      const template = document.createElement("template");
      template.innerHTML = html[index] as string;
      block = [...template.content.childNodes];
      for (const node of block) if (node instanceof Element) added.push(node);
      root.insertBefore(template.content, before);
    }
    nodes[index] = block;
    before = block[0] ?? before;
  }
  shown.html = html;
  shown.nodes = nodes;
  return added;
}

/** The frame of a finished visual, in a root of its own that carries the chat's UI handle along. */
function renderFrame(mount: Root, ui: ChatUi, source: string): void {
  mount.render(
    <ChatUiProvider ui={ui}>
      <VisualFrame source={source} />
    </ChatUiProvider>,
  );
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  visuals = false,
}: {
  text: string;
  streaming?: boolean;
  visuals?: boolean;
}) {
  const { openExternal, openLightbox, links, homeDir } = useChatActions();
  const board = useChatUi((s) => s.board);
  const ui = useChatUiHandle(); // the frames mount in roots of their own, which carry it along
  const enabled = useChatUi((s) => s.settings.visuals) && visuals;
  // A text that streams renders block by block, lexing on from the last frame's blocks, so each frame parses only its
  // tail and replaces only its last block. One that has not streamed here renders whole, as a single block.
  const lexed = useRef<LexedMarkdown | undefined>(undefined);
  const blocks = useMemo(() => {
    const options = { visuals: enabled, localImages: true };
    if (!streaming && !lexed.current) return [renderMarkdownCached(text, options)];
    // An unfinished visual fence streams as an empty visual, which the effect below shows as a skeleton, not raw source.
    const src = enabled && streaming ? text.replace(OPEN_VISUAL, "$1```visual\n```\n") : text;
    lexed.current = lexMarkdown(src, lexed.current);
    return renderMarkdownBlocks(lexed.current, options);
  }, [text, enabled, streaming]);
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef<ShownBlocks>({ html: [], nodes: [] });
  // Blocks go in before paint, only those that changed. Site icons go in with them so links do not shift; while
  // streaming only the new blocks get them, and favicons are fetched once the message is complete.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const added = patchBlocks(root, shown.current, blocks);
    if (!streaming) decorateWebLinks(root, true);
    else for (const element of added) decorateWebLinks(element as HTMLElement, false);
  }, [blocks, streaming]);
  // Code blocks highlight as they near the viewport, once the message is complete.
  useEffect(() => (streaming ? undefined : highlightWithin(ref.current)), [blocks, streaming]);
  // File links and embedded images settle once the message is complete, not on every streamed token.
  useEffect(() => {
    if (!streaming) void resolveFileLinks(ref.current, links, homeDir).then(() => loadChatImages(ref.current, links));
  }, [blocks, streaming, links, homeDir]);
  // Card links settle once the board has cards (a phone's arrives with its first sync), not on every board change.
  const hasCards = board.cards.length > 0;
  useEffect(() => {
    if (!streaming && hasCards) resolveCardLinks(ref.current, board);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, streaming, hasCards]);
  // Each finished visual mounts its frame once and keeps it while its block stays; a replaced block's frame unmounts.
  const frames = useRef(new Map<HTMLElement, { mount: Root; ui: ChatUi; source: string }>());
  const alive = useRef(false);
  useEffect(() => {
    const mounted = frames.current;
    alive.current = true;
    return () => {
      alive.current = false;
      // Unmount outside the current render pass, unless the element came back (a development remount).
      setTimeout(() => {
        if (alive.current) return;
        for (const { mount } of mounted.values()) mount.unmount();
        mounted.clear();
      }, 0);
    };
  }, []);
  useEffect(() => {
    const root = ref.current;
    const mounted = frames.current;
    for (const [el, { mount }] of mounted) {
      if (enabled && root?.contains(el)) continue;
      mounted.delete(el);
      setTimeout(() => mount.unmount(), 0);
    }
    if (!root || !enabled) return;
    for (const el of root.querySelectorAll<HTMLElement>(".visual[data-visual]")) {
      const frame = mounted.get(el);
      if (frame) {
        if (frame.ui !== ui) renderFrame(frame.mount, (frame.ui = ui), frame.source);
        continue;
      }
      if (streaming) {
        // Keep the hidden source: the effect runs again when streaming ends and this block (so this element) stays.
        el.classList.add("pending");
        if (!el.querySelector(".visual-drawing")) {
          // A skeleton in the rough shape of a visual (headline numbers, a chart, a few rows); the text is for screen readers.
          const note = document.createElement("div");
          note.className = "visual-drawing";
          note.setAttribute("role", "status");
          note.innerHTML =
            '<span class="sr-only">Drawing visual…</span><div class="sk-row"><i></i><i></i><i></i></div><i class="sk-chart"></i><i class="sk-line"></i><i class="sk-line short"></i>';
          el.append(note);
        }
        continue;
      }
      const source = el.querySelector(".visual-src")?.textContent ?? "";
      el.classList.remove("pending");
      el.textContent = "";
      const mount = createRoot(el);
      renderFrame(mount, ui, source);
      mounted.set(el, { mount, ui, source });
    }
  }, [blocks, streaming, enabled, ui]);
  return (
    <div ref={ref} className="prose selectable" onClick={(event) => onProseClick(event, { openExternal, openLightbox, links, homeDir, board })}
      onKeyDown={(event) => {
        const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
        if (card && event.key === "Enter") return openCardLink(card, links, board);
        const file = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
        if (file && event.key === "Enter") openFileLink(file, event, links, homeDir);
      }} />
  );
});

/** Plain code, highlighted once it nears the viewport; shows unhighlighted text first. */
export function CodeView({ code, lang, className = "" }: { code: string; lang?: string; className?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [html, setHtml] = useState<string>();
  useLayoutEffect(() => {
    setHtml(undefined);
    // A cached result applies before paint, so a remounted view does not flash plain text.
    return ref.current ? observeHighlight(ref.current, code, lang, setHtml) : undefined;
  }, [code, lang]);
  return (
    <pre ref={ref} className={`code selectable ${className}`}>
      {html ? <code className="hl" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  );
}
