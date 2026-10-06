import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type ChatUi, ChatUiProvider } from "./lib/chat-ui";
import { editQueue, openLightbox, respondDialog, setExpanded, showBoard, store } from "./state/app";
import { desktopLinks } from "./lib/preview";
import "./styles.css";

// The shared transcript components take their state and actions from here (lib/chat-ui.tsx).
const ui: ChatUi = {
  store,
  actions: { homeDir: window.studio.homeDir, setExpanded, openLightbox, showBoard, openExternal: (url) => window.studio.openExternal(url), links: desktopLinks, respondDialog, editQueue },
};

// Cmd +/- zooms the page but not the native traffic lights, so the title bar sizes what lines up with them in screen
// pixels through --unzoom (styles.css). A zoom change resizes the viewport in CSS px, which fires "resize".
const unzoom = () => document.documentElement.style.setProperty("--unzoom", String(1 / window.studio.zoomFactor()));
unzoom();
window.addEventListener("resize", unzoom);

createRoot(document.getElementById("root") as HTMLElement).render(
  <ChatUiProvider ui={ui}>
    <App />
  </ChatUiProvider>,
);
