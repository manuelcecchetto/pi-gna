import { createRoot } from "react-dom/client";
import { DocxEditor, configureDefaultFonts } from "@betteroffice/docx-react";
import "@betteroffice/docx-react/styles.css";
import * as fonts from "@betteroffice/fonts";
import { setGoogleFontsEnabled } from "@betteroffice/docx";
import { useRef } from "react";
import { fail, loadBytes, mark, params, settle } from "./common";

setGoogleFontsEnabled(false);
configureDefaultFonts({ fonts });
mark("script");
function App({ bytes }: { bytes: Uint8Array }) {
  const ref = useRef<any>(null);
  return (
    <DocxEditor
      ref={ref}
      documentBuffer={bytes}
      mode="viewing"
      readOnly
      showToolbar={false}
      showRuler={false}
      experimentalWorkerOpen={params.get("worker") === "1"}
      previewFirstPage={params.get("preview") === "1"}
      onFirstPagePainted={() => { mark("firstPage"); settle(() => ref.current?.getTotalPages?.() ?? 0, () => ({ canvases: document.querySelectorAll("canvas").length }), 2500); }}
      onError={(e) => { (window as any).__errors = [...((window as any).__errors ?? []), "onError: " + String(e).slice(0, 200)]; }}
    />
  );
}
loadBytes().then((bytes) => createRoot(document.getElementById("root")!).render(<App bytes={bytes} />), fail);
