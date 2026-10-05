import { memo, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatUiProvider, useChatActions, useChatUiHandle, useChatUi } from "../lib/chat-ui";
import { VisualFrame } from "./VisualFrame";
import { highlight, highlightWithin } from "../lib/highlight";
import { renderMarkdown } from "../lib/markdown";

function onProseClick(event: MouseEvent<HTMLElement>, openExternal: (url: string) => void): void {
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
  const { openExternal } = useChatActions();
  const ui = useChatUiHandle(); // the frames mount in roots of their own, which carry it along
  const enabled = useChatUi((s) => s.settings.visuals) && visuals;
  const html = useMemo(() => {
    // An unfinished visual fence streams as a placeholder instead of raw source.
    const src = enabled && streaming ? text.replace(OPEN_VISUAL, "$1*Drawing visual…*\n") : text;
    return renderMarkdown(src, { visuals: enabled });
  }, [text, enabled, streaming]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!streaming) highlightWithin(ref.current);
  }, [html, streaming]);
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
          const note = document.createElement("span");
          note.className = "visual-drawing";
          note.textContent = "Drawing visual…";
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
    <div ref={ref} className="prose selectable" onClick={(event) => onProseClick(event, openExternal)} dangerouslySetInnerHTML={{ __html: html }} />
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
