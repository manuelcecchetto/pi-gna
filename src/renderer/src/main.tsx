import { createRoot } from "react-dom/client";
import { App } from "./App";
import { type ChatUi, ChatUiProvider } from "./lib/chat-ui";
import { editQueue, openLightbox, respondDialog, setExpanded, showBoard, store } from "./state/app";
import "./styles.css";

// The shared transcript components take their state and actions from here (lib/chat-ui.tsx).
const ui: ChatUi = {
  store,
  actions: { homeDir: window.studio.homeDir, setExpanded, openLightbox, showBoard, openExternal: (url) => window.studio.openExternal(url), respondDialog, editQueue },
};

createRoot(document.getElementById("root") as HTMLElement).render(
  <ChatUiProvider ui={ui}>
    <App />
  </ChatUiProvider>,
);
