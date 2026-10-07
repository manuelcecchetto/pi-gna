import { memo, type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type ChatLinks, ChatUiProvider, type ChatUiState, useChatActions, useChatUiHandle, useChatUi } from "../lib/chat-ui";
import { VisualFrame } from "./VisualFrame";
import { highlight, highlightWithin } from "../lib/highlight";
import { renderMarkdown } from "../lib/markdown";
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
  const html = useMemo(() => {
    // An unfinished visual fence streams as an empty visual, which the effect below shows as a skeleton, not raw source.
    const src = enabled && streaming ? text.replace(OPEN_VISUAL, "$1```visual\n```\n") : text;
    return renderMarkdown(src, { visuals: enabled, localImages: true });
  }, [text, enabled, streaming]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!streaming) highlightWithin(ref.current);
  }, [html, streaming]);
  // Site icons go in before paint so links do not shift; favicons are fetched once the message is complete.
  useLayoutEffect(() => decorateWebLinks(ref.current, !streaming), [html, streaming]);
  // File links and embedded images settle once the message is complete, not on every streamed token.
  useEffect(() => {
    if (!streaming) void resolveFileLinks(ref.current, links, homeDir).then(() => loadChatImages(ref.current, links));
  }, [html, streaming, links, homeDir]);
  // Card links settle once the board has cards (a phone's arrives with its first sync), not on every board change.
  const hasCards = board.cards.length > 0;
  useEffect(() => {
    if (!streaming && hasCards) resolveCardLinks(ref.current, board);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, streaming, hasCards]);
  useEffect(() => {
    const root = ref.current;
    if (!root || !enabled) return;
    const roots: ReturnType<typeof createRoot>[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(".visual[data-visual]")) {
      const source = el.querySelector(".visual-src")?.textContent ?? "";
      if (streaming) {
        // Keep the hidden source: the effect runs again when streaming ends and the html (so this element) is unchanged.
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
      el.classList.remove("pending");
      el.textContent = "";
      const mount = createRoot(el);
      mount.render(
        <ChatUiProvider ui={ui}>
          <VisualFrame source={source} />
        </ChatUiProvider>,
      );
      roots.push(mount);
    }
    return () => {
      // Unmount outside the current render pass.
      setTimeout(() => {
        for (const mount of roots) mount.unmount();
      }, 0);
    };
  }, [html, streaming, enabled, ui]);
  return (
    <div ref={ref} className="prose selectable" onClick={(event) => onProseClick(event, { openExternal, openLightbox, links, homeDir, board })}
      onKeyDown={(event) => {
        const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
        if (card && event.key === "Enter") return openCardLink(card, links, board);
        const file = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
        if (file && event.key === "Enter") openFileLink(file, event, links, homeDir);
      }}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
});

/** Plain code with async highlighting; shows unhighlighted text first. */
export function CodeView({ code, lang, className = "" }: { code: string; lang?: string; className?: string }) {
  const [html, setHtml] = useState<string>();
  useEffect(() => {
    let alive = true;
    setHtml(undefined);
    void highlight(code, lang).then((result) => {
      if (alive) setHtml(result);
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return (
    <pre className={`code selectable ${className}`}>
      {html ? <code className="hl" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  );
}
