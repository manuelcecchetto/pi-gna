import { type CSSProperties, memo, useCallback, useEffect, useRef, useState } from "react";
import { useChatActions } from "../lib/chat-ui";
import { watchNear } from "../lib/near";
import { linkFrame, readTokens } from "../lib/visual-frames";
import { CodeView } from "./Markdown";

const MIN_H = 40;

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

/**
 * A visual's box. Its frame runs only while the box is near the viewport (or expanded, or failed); elsewhere a blank of the
 * frame's last height holds its place and the frame, with its process, is gone. Coming back runs the visual again.
 */
function LiveFrame({ source }: { source: string }) {
  const { visualFrames } = useChatActions();
  const placeRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [height, setHeight] = useState(MIN_H);
  // Full window: the same iframe restyled (moving it in the DOM would reload it and lose its state).
  const [full, setFull] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  // Watched through its place in the transcript, which stays put while the box is expanded over the window.
  useEffect(() => (placeRef.current ? watchNear(placeRef.current, setNear) : undefined), []);

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

  // A failed frame stays, hidden, on the desktop, where its process is killed; a remote client cannot kill it, so it takes
  // the frame out of the page altogether.
  const running = error ? !visualFrames : near || full;
  // No box around the frame and no clamp: the visual reads as part of the reply at its full height, and its actions sit
  // under it, shown on hover.
  return (
    <div ref={placeRef}>
      {full && <div className="visual-backdrop" onClick={() => setFull(false)} />}
      <div className={full ? "visual-box full" : "visual-box"}>
        {error && <div className="visual-error">Visual error: {error}</div>}
        {running ? (
          <Frame
            source={source}
            failed={Boolean(error)}
            onHeight={setHeight}
            onError={setError}
            style={{ height: full ? undefined : height, display: error ? "none" : undefined }}
          />
        ) : (
          !error && <div className="visual-frame" data-idle="" style={{ height }} />
        )}
        <footer className="visual-actions">
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
    </div>
  );
}

/** One run of a visual: an iframe of its own (on the desktop, a process of its own), linked to the shared listeners. */
function Frame({
  source,
  failed,
  style,
  onHeight,
  onError,
}: {
  source: string;
  failed: boolean;
  style: CSSProperties;
  onHeight(px: number): void;
  onError(message: string): void;
}) {
  const { visualFrames, openExternal } = useChatActions();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameId] = useState(newFrameId);
  const src = visualFrames ? visualFrames.src(frameId) : `pigna-visual://${frameId}/doc`;

  // A frame that stopped responding keeps spinning even after its iframe is removed: its process has to be killed.
  // A remote client has no process to kill: removing the iframe is all it can do.
  useEffect(() => {
    if (failed && !visualFrames) window.studio.killVisual(frameId);
  }, [failed, frameId, visualFrames]);
  useEffect(() => () => (visualFrames ? undefined : window.studio.killVisual(frameId)), [frameId, visualFrames]);

  useEffect(() => {
    const frame = frameRef.current;
    const view = frame?.contentWindow;
    if (!frame || !view || failed) return;
    let rendered = false;
    const post = (message: unknown) => view.postMessage(message, "*");
    const sendRender = () => post({ type: "render", html: source, tokens: readTokens() });
    const link = linkFrame(view, {
      post,
      onHung: () => onError("Visual stopped responding"),
      onMessage: (data) => {
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
            if (typeof data.px === "number" && Number.isFinite(data.px)) onHeight(Math.max(MIN_H, Math.ceil(data.px)));
            break;
          case "open-link":
            if (typeof data.href === "string" && /^https?:\/\//i.test(data.href)) openExternal(data.href);
            break;
          case "error":
            onError(typeof data.message === "string" ? data.message : "Visual failed to run");
            break;
        }
      },
    });
    const onLoad = () => {
      link.beat();
      sendRender();
    };
    frame.addEventListener("load", onLoad);
    return () => {
      link.unlink();
      frame.removeEventListener("load", onLoad);
    };
  }, [source, failed, openExternal, onHeight, onError]);

  return <iframe ref={frameRef} className="visual-frame" title="Visual" sandbox="allow-scripts" referrerPolicy="no-referrer" src={src} style={style} />;
}
