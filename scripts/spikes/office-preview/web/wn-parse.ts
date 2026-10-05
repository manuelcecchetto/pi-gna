// Walnut (Codex app) parse only: .NET Open XML reader -> protobuf -> decoded JS model. No layout, no paint.
import { done, fail, file, loadBytes, mark } from "./common";
const base = new URL("./codex/", location.href);
(async () => {
  mark("script");
  const reader = await import(/* @vite-ignore */ new URL("walnut-reader.worker-f89300d4d450.js", base).href);
  const [bytes, exp] = await Promise.all([loadBytes(), reader.getPopcornWalnutReaderExports(base)]);
  mark("runtime");
  const ext = file.split(".").pop();
  const [proto, decoderFile, name] =
    ext === "docx" ? [exp.DocxReader.ExtractDocxProto(bytes, false), "walnut-document-decoder.worker-4eebc57de2da.js", "Document"] :
    ext === "pptx" ? [exp.PptxReader.ExtractSlidesProto(bytes, false), "walnut-presentation-decoder.worker-cc92f96b9c37.js", "Presentation"] :
    [exp.XlsxReader.ExtractXlsxProto(bytes, false), "walnut-workbook-decoder.worker-35bf4c1733e1.js", "Workbook"];
  mark("parsed");
  const dec = await import(/* @vite-ignore */ new URL(decoderFile, base).href);
  const model = dec[name].decode(proto);
  mark("decoded");
  mark("firstPage"); // no paint: parse-only ends here
  done({ protoBytes: proto.byteLength, slides: model.slides?.length, sheets: model.sheets?.length, sections: model.sections?.length });
})().catch(fail);
