import { initWasm, openWorkbook, paintDisplayList } from "@betteroffice/xlsx";
import { done, fail, loadBytes, mark } from "./common";
(async () => {
  mark("script");
  const [bytes] = await Promise.all([loadBytes(), initWasm().then(() => mark("wasm"))]);
  const wb = openWorkbook(bytes);
  mark("open");
  const info = wb.sheetInfo();
  const root = document.getElementById("root")!;
  const tabs = document.createElement("div"); tabs.className = "tabs";
  for (const s of info.sheetNames) { const t = document.createElement("span"); t.textContent = s; tabs.append(t); }
  const c = document.createElement("canvas");
  const W = 1000, H = 1200, dpr = devicePixelRatio;
  c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px";
  root.append(tabs, c);
  const frame = wb.displayList({ x: info.initialScrollX, y: info.initialScrollY, width: W, height: H });
  paintDisplayList(c.getContext("2d")!, frame, dpr);
  await new Promise(requestAnimationFrame);
  mark("firstPage");
  done({ sheets: info.sheetNames.length, contentWidth: info.contentWidth, contentHeight: info.contentHeight });
})().catch(fail);
