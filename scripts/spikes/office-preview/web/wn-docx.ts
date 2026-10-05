// Walnut + Granola as the Codex app runs them: the document controller worker parses with Walnut, lays out every page,
// then paints requested page surfaces into OffscreenCanvas and posts ImageBitmaps back.
import { done, fail, loadBytes, mark } from "./common";
const base = new URL("./codex/", location.href);
(async () => {
  mark("script");
  const bytes = await loadBytes();
  const worker = new Worker(new URL("runtime.worker-4664ab3e891e.js", base), { type: "module" });
  const root = document.getElementById("root")!;
  root.className = "stack"; root.style.height = "auto";
  const W = 816, dpr = devicePixelRatio, FIRST = 2;
  let pages: any[] = [], painted = 0, textChars = 0;
  const canvases = new Map<number, HTMLCanvasElement>();
  worker.onerror = (e) => fail(e.message);
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") {
      worker.postMessage({ type: "bootstrap", payload: { bootstrapSource: { kind: "source-bytes", bytes: bytes.buffer }, initialPageIndex: 0, initialZoom: 1 } }, [bytes.buffer]);
      return;
    }
    if (data.type === "error") return fail(data.message);
    if (data.type !== "event") return;
    const p = data.payload;
    if (p.kind === "bootstrap-status") mark("bootstrap-" + p.status);
    if (p.kind === "layout" && !pages.length) {
      mark("layout"); mark("settled");
      pages = p.pageLayouts;
      const surfaces = pages.slice(0, FIRST).map((pg: any, i: number) => {
        const h = Math.round(W * pg.height / pg.width);
        const c = document.createElement("canvas"); c.width = W * dpr; c.height = h * dpr; c.style.width = W + "px"; c.style.height = h + "px";
        root.append(c); canvases.set(i, c);
        return { surfaceId: "s" + i, pageIndex: i, pageTop: 0, revision: 1, width: W, height: h, dpr };
      });
      worker.postMessage({ type: "intent", payload: { kind: "sync-page-canvases", detachedSurfaceIds: [], surfaces } });
    }
    if (p.kind === "rendered-pages") for (const pg of p.pages) for (const b of pg.textLayoutBlocks) textChars += JSON.stringify(b).length;
    if (p.kind === "page-frame") {
      canvases.get(p.pageIndex)?.getContext("2d")!.drawImage(p.bitmap, 0, 0);
      p.bitmap.close?.();
      if (++painted === Math.min(FIRST, pages.length)) {
        requestAnimationFrame(() => { mark("firstPage"); setTimeout(() => done({ pages: pages.length, textLayerJsonChars: textChars }), 300); });
      }
    }
  };
})().catch(fail);
