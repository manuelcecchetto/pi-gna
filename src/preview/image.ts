// Image view: fit to the pane by default; click or `1`/`0` toggles 100%, ctrl/cmd+wheel (and trackpad pinch, which
// Chromium sends as ctrl+wheel) and `+`/`-` zoom. A checkerboard sits behind transparency; the footer has the pixel size.
import { formatBytes } from "./format";
import { app, readBytes, type Source } from "./shell";

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;

export async function showImage(source: Source): Promise<void> {
  const head = await readBytes(source.rawUrl, 1);
  if (head.total === 0) return void app.replaceChildren(Object.assign(document.createElement("div"), { className: "message", textContent: "This image is empty." }));
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.tabIndex = 0;
  const image = document.createElement("img");
  image.className = "checker";
  image.alt = source.name;
  image.draggable = false;
  const footer = document.createElement("div");
  footer.className = "footer";
  const info = document.createElement("span");
  const zoom = document.createElement("span");
  footer.append(info, zoom);
  stage.append(image);
  app.replaceChildren(stage, footer);

  // `fit` follows the pane size; a number is an explicit scale of the natural size.
  let scale: "fit" | number = "fit";
  const natural = (): { width: number; height: number } => ({ width: image.naturalWidth || 300, height: image.naturalHeight || 300 });
  const effective = (): number => {
    if (scale !== "fit") return scale;
    const { width, height } = natural();
    return Math.min(1, stage.clientWidth / width, stage.clientHeight / height);
  };
  const apply = (): void => {
    const { width, height } = natural();
    if (scale === "fit") {
      stage.classList.remove("zoomed");
      image.style.width = "";
      image.style.height = "";
    } else {
      stage.classList.add("zoomed");
      image.style.width = `${width * scale}px`;
      image.style.height = `${height * scale}px`;
    }
    zoom.textContent = `${Math.round(effective() * 100)}%`;
  };
  const setScale = (next: "fit" | number, anchorX = stage.clientWidth / 2, anchorY = stage.clientHeight / 2): void => {
    const before = effective();
    const ratioX = (stage.scrollLeft + anchorX) / Math.max(1, stage.scrollWidth);
    const ratioY = (stage.scrollTop + anchorY) / Math.max(1, stage.scrollHeight);
    scale = next === "fit" ? "fit" : Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    apply();
    if (scale !== "fit" && scale !== before) {
      stage.scrollLeft = ratioX * stage.scrollWidth - anchorX;
      stage.scrollTop = ratioY * stage.scrollHeight - anchorY;
    }
  };

  image.addEventListener("load", () => {
    const { width, height } = natural();
    info.textContent = `${image.naturalWidth ? `${width} × ${height} px · ` : ""}${formatBytes(head.total)}`;
    apply();
  });
  image.addEventListener("error", () => {
    app.replaceChildren(Object.assign(document.createElement("div"), { className: "message error", textContent: "This image could not be decoded." }));
  });
  image.addEventListener("click", () => setScale(scale === "fit" ? 1 : "fit"));
  stage.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      setScale(effective() * Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
    },
    { passive: false },
  );
  stage.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "0") setScale("fit");
    else if (event.key === "1") setScale(1);
    else if (event.key === "+" || event.key === "=") setScale(effective() * 1.25);
    else if (event.key === "-") setScale(effective() / 1.25);
    else return;
    event.preventDefault();
  });
  window.addEventListener("resize", apply);
  image.src = source.rawUrl;
  stage.focus();
}
