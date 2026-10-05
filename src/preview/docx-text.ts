// Worker: a DOCX's text as Markdown (accepted view, tables included) for the DOCX view's hidden text layer. The export
// runs BetterOffice's edit engine, whose wasm memory grows with the document and never shrinks (about 400 MB for a
// 150-page contract); in a worker of its own that memory goes away when the view terminates it, and the page never blocks.
import { exportDocxMarkdown } from "@betteroffice/docx";

self.onmessage = async (event: MessageEvent<Uint8Array>) => {
  try {
    const content = await exportDocxMarkdown(event.data, { revisionView: "accepted" });
    self.postMessage({ text: content.markdown });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
