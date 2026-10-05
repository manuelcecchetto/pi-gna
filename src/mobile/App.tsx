// The paired app: one HostClient for the page, the connection banner, and the Projects -> Chats -> Chat stack.
import { useEffect, useMemo, useState } from "react";
import { chatOfHash } from "./push";
import { ChatUiProvider } from "../renderer/src/lib/chat-ui";
import { useStore } from "../renderer/src/lib/store";
import { ChatScreen } from "./Chat";
import { createChatUi } from "./chat-ui";
import { Lightbox } from "./Lightbox";
import { HostClient, type ConnectionState } from "./client/host-client";
import { useRoute } from "./nav";
import { LamentsScreen } from "./Laments";
import { AtpScreen } from "./Atp";
import { GithubScreen } from "./Github";
import { BrowserScreen } from "./Browser";
import { Chats, PageSoon, Projects } from "./Screens";
import { SettingsScreen } from "./SettingsScreen";
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

  // A tapped notification names a chat: `#/chat/<handle>` when it opened the app, a message when the app was running.
  useEffect(() => {
    let stop: (() => void) | undefined;
    const summaryOf = (handle: string) => client.store.snapshot().global.attention[handle];
    const open = (handle: string) => {
      const summary = summaryOf(handle);
      if (summary) push({ screen: "chat", cwd: summary.cwd, handle, title: summary.title });
      return !!summary;
    };
    const fromHash = () => {
      const handle = chatOfHash(location.hash);
      if (!handle) return;
      history.replaceState(history.state, "", location.pathname);
      // The attention summaries arrive with the first sync: wait for the chat's once.
      if (!open(handle)) stop = client.store.subscribe(() => summaryOf(handle) && (stop?.(), open(handle)));
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "open-chat" && typeof event.data.chat === "string") open(event.data.chat);
    };
    fromHash();
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      stop?.();
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
    // Mount only: `push` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const ui = useMemo(() => createChatUi(client, homeDir), [client, homeDir]);

  return (
    <ChatUiProvider ui={ui}>
      <div className="safe-area flex h-full flex-col bg-canvas">
        <ConnectionBanner client={client} />
        {route.screen === "projects" && <Projects client={client} homeDir={homeDir} push={push} footer={signOut} />}
        {route.screen === "chats" && <Chats client={client} homeDir={homeDir} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "settings" && <SettingsScreen client={client} section={route.section} push={push} back={back} signOut={signOut} />}
        {route.screen === "browser" && <BrowserScreen client={client} back={back} />}
        {route.screen === "page" && route.page === "laments" && <LamentsScreen client={client} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "page" && route.page === "github" && <GithubScreen client={client} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "page" && route.page === "atp" && <AtpScreen client={client} homeDir={homeDir} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "page" && route.page !== "laments" && route.page !== "github" && route.page !== "atp" && <PageSoon route={route} back={back} />}
        {route.screen === "chat" && <ChatScreen key={`${route.sessionPath ?? ""}:${route.handle ?? ""}`} client={client} route={route} back={back} />}
      </div>
      <Toasts />
      <Lightbox />
    </ChatUiProvider>
  );
}
