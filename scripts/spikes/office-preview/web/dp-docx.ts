import { done, fail, loadBytes, mark } from "./common";
(async () => {
  mark("script");
  const [bytes, { renderAsync }] = await Promise.all([loadBytes(), import("docx-preview")]);
  const root = document.getElementById("root")!;
  root.style.height = "auto";
  await renderAsync(bytes, root, undefined, {
    className: "docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
    renderChanges: false, useBase64URL: true, ignoreWidth: false, ignoreHeight: false,
  });
  await new Promise(requestAnimationFrame);
  mark("firstPage");
  done({ pages: root.querySelectorAll("section.docx").length });
  mark("settled");
})().catch(fail);
