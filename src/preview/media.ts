// Audio and video: a native media element over the raw URL (main serves Range, so seeking works). Bare media URLs cannot
// be loaded as a top-level document (loadURL rejects), which is why they go through this page.
import { app, type Source } from "./shell";

export function showMedia(source: Source): void {
  const stage = document.createElement("div");
  stage.className = "stage media";
  const player = document.createElement(source.kind === "video" ? "video" : "audio");
  player.controls = true;
  player.src = source.rawUrl;
  player.preload = "metadata";
  stage.append(player);
  app.replaceChildren(stage);
}
