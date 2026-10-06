import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useChatActions } from "../lib/chat-ui";
import { CodeView } from "./Markdown";

const MIN_H = 40;
const MAX_H = 720;
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
  const { visualFrames } = useChatActions();
  const [armed, setArmed] = useState(!visualFrames?.tapToRender);
  if (!armed)
    return (
      <button type="button" onClick={() => setArmed(true)} className="visual-tap" data-testid="visual-tap">
        Tap to render visual
      </button>
    );
  return <LiveFrame source={source} />;
});

function LiveFrame({ source }: { source: string }) {
  const { visualFrames, openExternal } = useChatActions();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameId] = useState(newFrameId);
  const src = visualFrames ? visualFrames.src(frameId) : `pigna-visual://${frameId}/doc`;
  const [height, setHeight] = useState(MIN_H);
  const [expanded, setExpanded] = useState(false);
  // Full window: the same iframe restyled (moving it in the DOM would reload it and lose its state).
  const [full, setFull] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  // A frame that stopped responding keeps spinning even after its iframe is removed: its process has to be killed.
  // A remote client has no process to kill: removing the iframe is all it can do.
  useEffect(() => {
    if (error && !visualFrames) window.studio.killVisual(frameId);
  }, [error, frameId, visualFrames]);
  useEffect(() => () => (visualFrames ? undefined : window.studio.killVisual(frameId)), [frameId, visualFrames]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let lastBeat = Date.now();
    let rendered = false;
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
        case "rendered":
          rendered = true;
          break;
        case "heartbeat":
          // The frame can load before this effect listens, losing its `ready` and our load handler: re-send until it confirms.
          if (!rendered) sendRender();
          break;
        case "height":
          if (typeof data.px === "number" && Number.isFinite(data.px)) setHeight(Math.max(MIN_H, Math.ceil(data.px)));
          break;
        case "open-link":
          if (typeof data.href === "string" && /^https?:\/\//i.test(data.href)) openExternal(data.href);
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
  }, [source, openExternal]);

  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setFull(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [source]);

  const clamped = height > MAX_H;
  const shown = clamped && !expanded && !full ? MAX_H : height;
  // No box around the frame: the visual reads as part of the reply, and its actions sit under it, shown on hover.
  return (
    <>
      {full && <div className="visual-backdrop" onClick={() => setFull(false)} />}
      <div className={full ? "visual-box full" : "visual-box"}>
        {error && <div className="visual-error">Visual error: {error}</div>}
        {/* A remote client cannot kill the frame's process, so a failed frame is taken out of the page altogether. */}
        {!(error && visualFrames) && (
          <iframe
            ref={frameRef}
            className={clamped && !expanded && !full ? "visual-frame clamped" : "visual-frame"}
            title="Visual"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={src}
            style={{ height: full ? undefined : shown, display: error ? "none" : undefined }}
          />
        )}
        <footer className="visual-actions">
          {clamped && !error && !full && (
            <button type="button" className={expanded ? undefined : "visual-more"} onClick={() => setExpanded((on) => !on)}>
              {expanded ? "Collapse" : "Show all"}
            </button>
          )}
          {!error && (
            <button type="button" onClick={() => setFull((on) => !on)} title={full ? "Close (Esc)" : "Open in the full window"}>
              {full ? "Close" : "Expand"}
            </button>
          )}
          <button type="button" onClick={() => setShowSource((on) => !on)}>
            {showSource ? "Hide source" : "Source"}
          </button>
          <button type="button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </footer>
        {(showSource || error) && !full && <CodeView code={source} lang="html" />}
      </div>
    </>
  );
}
