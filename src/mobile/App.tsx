// The paired app: one HostClient for the page, the connection banner, and the Projects -> Chats -> Chat stack.
import { useEffect, useMemo, useState } from "react";
import { ChatUiProvider } from "../renderer/src/lib/chat-ui";
import { useStore } from "../renderer/src/lib/store";
import { ChatScreen } from "./Chat";
import { createChatUi, closeLightbox, useLightbox } from "./chat-ui";
import { HostClient, type ConnectionState } from "./client/host-client";
import { useRoute } from "./nav";
import { Chats, Projects } from "./Screens";
import { noticeFor } from "./notices";
import { toast, Toasts } from "./toasts";

const BANNER: Partial<Record<ConnectionState, string>> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  unreachable: "The Mac is unreachable. Retrying…",
  outdated: "pi-gna was updated. Reloading…",
};

function ConnectionBanner({ client }: { client: HostClient }) {
  const connection = useStore(client.store, (s) => s.connection);
  const text = BANNER[connection];
  if (!text) return null;
  const bad = connection === "unreachable";
  return (
    <div role="status" data-testid="connection-banner" className={`flex shrink-0 items-center gap-3 px-4 py-1.5 text-[12.5px] ${bad ? "bg-bad/15 text-bad" : "bg-warn/15 text-warn"}`}>
      <span className="min-w-0 flex-1">{text}</span>
      {(connection === "unreachable" || connection === "reconnecting") && (
        <button type="button" onClick={() => client.reconnectNow()} className="shrink-0 underline">
          Retry now
        </button>
      )}
    </div>
  );
}

function Lightbox() {
  const src = useLightbox();
  if (!src) return null;
  return (
    <button type="button" aria-label="Close image" onClick={closeLightbox} className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-3">
      <img alt="" src={src} className="max-h-full max-w-full object-contain" />
    </button>
  );
}

export function App({ onUnauthorized, signOut }: { onUnauthorized: () => void; signOut: React.ReactNode }) {
  const client = useMemo(
    () => new HostClient({ buildId: __PIGNA_BUILD__, onUnauthorized, onOutdated: () => location.reload() }),
    // One client per mount: signing out remounts the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [homeDir, setHomeDir] = useState("");
  const { route, push, back } = useRoute();

  useEffect(() => {
    client.start();
    void client.call("app.info", {}).then((info) => setHomeDir(info.homeDir), () => undefined);
    return () => client.stop();
  }, [client]);

  // Extension notices become toasts; startup warnings show once per app run (the set lives as long as the page).
  useEffect(() => {
    const seen = new Set<string>();
    return client.onChatEvent((_handle, event, session) => {
      const notice = noticeFor(event, session, seen);
      if (notice) toast(notice.text, notice.level);
    });
  }, [client]);

  const ui = useMemo(() => createChatUi(client, homeDir), [client, homeDir]);

  return (
    <ChatUiProvider ui={ui}>
      <div className="safe-area flex h-full flex-col bg-canvas">
        <ConnectionBanner client={client} />
        {route.screen === "projects" && <Projects client={client} homeDir={homeDir} push={push} footer={signOut} />}
        {route.screen === "chats" && <Chats client={client} homeDir={homeDir} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "chat" && <ChatScreen key={`${route.sessionPath ?? ""}:${route.handle ?? ""}`} client={client} route={route} back={back} />}
      </div>
      <Toasts />
      <Lightbox />
    </ChatUiProvider>
  );
}
