// Serves the bundled visual frame (resources/visual) on pigna-visual://<frameId>/, one host per frame, with its own CSP.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { protocol } from "electron";
import { onDisk } from "./resources";
import { VISUAL_CSP, VISUAL_SCHEME, visualAsset } from "./visual-frame";

export function serveVisual(): void {
  protocol.handle(VISUAL_SCHEME, async (request) => {
    const asset = visualAsset(request.url);
    if (!asset) return new Response("not found", { status: 404 });
    try {
      const body = await readFile(join(onDisk("resources", "visual"), asset.file));
      return new Response(body, { headers: { "content-type": asset.type, "content-security-policy": VISUAL_CSP, "cache-control": "no-store" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
