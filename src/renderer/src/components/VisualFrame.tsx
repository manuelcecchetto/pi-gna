import { memo, useCallback, useEffect, useRef, useState } from "react";
import { CodeView } from "./Markdown";

const MIN_H = 40;
const MAX_H = 560;
const WATCHDOG_MS = 8000;

const TOKEN_NAMES = ["--canvas", "--panel", "--sunken", "--raised", "--fg", "--muted", "--faint", "--accent", "--ok", "--bad", "--warn", "--line"];

function readTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of TOKEN_NAMES) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  for (const name of ["--font-sans", "--font-mono"]) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  return tokens;
}

function newFrameId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sandboxed iframe running one HTML fragment. Memoised by source so transcript re-renders keep the frame. */
export const VisualFrame = memo(function VisualFrame({ source }: { source: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `pigna-visual://${newFrameId()}/doc`);
  const [height, setHeight] = useState(MIN_H);
  const [expanded, setExpanded] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let lastBeat = Date.now();
    const post = (message: unknown) => frame.contentWindow?.postMessage(message, "*");
    const sendRender = () => post({ type: "render", html: source, tokens: readTokens() });
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: string; px?: unknown; href?: unknown; message?: unknown } | null;
      if (!data || typeof data !== "object") return;
      lastBeat = Date.now();
      switch (data.type) {
        case "ready":
          sendRender();
          break;
        case "height":
          if (typeof data.px === "number" && Number.isFinite(data.px)) setHeight(Math.max(MIN_H, Math.ceil(data.px)));
          break;
        case "open-link":
          if (typeof data.href === "string" && /^https?:\/\//i.test(data.href)) window.studio.openExternal(data.href);
          break;
        case "error":
          setError(typeof data.message === "string" ? data.message : "Visual failed to run");
          break;
      }
    };
    const onLoad = () => {
      lastBeat = Date.now();
      sendRender();
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => post({ type: "tokens", tokens: readTokens() });
    const watchdog = setInterval(() => {
      if (Date.now() - lastBeat > WATCHDOG_MS) setError("Visual stopped responding");
    }, 1000);
    window.addEventListener("message", onMessage);
    frame.addEventListener("load", onLoad);
    media.addEventListener("change", onTheme);
    return () => {
      clearInterval(watchdog);
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("load", onLoad);
      media.removeEventListener("change", onTheme);
    };
  }, [source]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [source]);

  const clamped = height > MAX_H;
  const shown = clamped && !expanded ? MAX_H : height;
  return (
    <>
      <header>
        <span>visual</span>
        <span className="visual-actions">
          {clamped && (
            <button type="button" onClick={() => setExpanded((on) => !on)}>
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
          <button type="button" onClick={() => setShowSource((on) => !on)}>
            {showSource ? "Hide source" : "Source"}
          </button>
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </header>
      {error && <div className="visual-error">Visual error: {error}</div>}
      <iframe
        ref={frameRef}
        className="visual-frame"
        title="Visual"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={src}
        style={{ height: shown, display: error ? "none" : undefined }}
      />
      {(showSource || error) && <CodeView code={source} lang="html" />}
    </>
  );
});
