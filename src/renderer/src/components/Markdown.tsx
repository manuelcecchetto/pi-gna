import { memo, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { highlight, highlightWithin } from "../lib/highlight";
import { renderMarkdown } from "../lib/markdown";

function onProseClick(event: MouseEvent<HTMLElement>): void {
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
    window.studio.openExternal(link.href);
  }
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!streaming) highlightWithin(ref.current);
  }, [html, streaming]);
  return (
    <div ref={ref} className="prose selectable" onClick={onProseClick} dangerouslySetInnerHTML={{ __html: html }} />
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
