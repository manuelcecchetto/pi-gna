// The paired app: one HostClient for the page, the connection banner, and the Projects -> Chats -> Chat stack.
import { useEffect, useMemo, useState } from "react";
import { chatOfHash } from "./push";
import { ChatUiProvider } from "../renderer/src/lib/chat-ui";
import { useStore } from "../renderer/src/lib/store";
import { ChatScreen } from "./Chat";
import { createChatUi } from "./chat-ui";
import { ThemeRoot } from "./ThemeRoot";
import { Lightbox } from "./Lightbox";
import { HostClient, type ConnectionState } from "./client/host-client";
import { rememberProject } from "./last-project";
import { useRoute } from "./nav";
import { BoardScreen } from "./Board";
import { LamentsScreen } from "./Laments";
import { AtpScreen } from "./Atp";
import { GithubScreen } from "./Github";
import { BrowserScreen } from "./Browser";
import { FileScreen } from "./FileView";
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
    // Just under the screen's Header, over the content: the header owns the top edge (see Header).
    <div className="absolute inset-x-0 top-[calc(env(safe-area-inset-top)+3rem+1px)] z-20 bg-canvas">
    <div role="status" data-testid="connection-banner" className={`flex items-center gap-3 px-4 py-1.5 text-[12.5px] ${bad ? "bg-bad/15 text-bad" : "bg-warn/15 text-warn"}`}>
      <span className="min-w-0 flex-1">{text}</span>
      {(connection === "unreachable" || connection === "reconnecting") && (
        <button type="button" onClick={() => client.reconnectNow()} className="shrink-0 underline">
          Retry now
        </button>
      )}
    </div>
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
  const { route, push, replace, back } = useRoute();

  // A chat started here has a session file only once pi writes it, and the host announces nothing: ask again whenever
  // a list screen comes up, and when the live chats start or finish a turn.
  const liveKey = useStore(client.store, (s) =>
    Object.values(s.global.attention).map((c) => `${c.handle}:${c.settled?.at ?? ""}:${c.sessionPath ?? ""}`).join("|"),
  );
  useEffect(() => void client.refreshProjects(), [client, liveKey, route.screen]);

  useEffect(() => {
    if ("cwd" in route) rememberProject(route.cwd);
  }, [route]);

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

  const ui = useMemo(() => createChatUi(client, homeDir, push), [client, homeDir, push]);

  return (
    <ChatUiProvider ui={ui}>
      <ThemeRoot client={client} ui={ui} cwd={"cwd" in route ? route.cwd : undefined} />
      {/* No top padding: every screen's Header covers the status bar itself. */}
      <div className="safe-area relative flex h-full flex-col bg-canvas pt-0">
        <ConnectionBanner client={client} />
        {route.screen === "projects" && <Projects client={client} homeDir={homeDir} push={push} />}
        {route.screen === "chats" && <Chats client={client} homeDir={homeDir} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "settings" && <SettingsScreen client={client} section={route.section} push={push} back={back} signOut={signOut} />}
        {route.screen === "file" && <FileScreen key={`${route.path}:${route.line ?? ""}`} client={client} handle={route.handle} path={route.path} line={route.line} push={push} back={back} />}
        {route.screen === "browser" && <BrowserScreen key={route.tab} client={client} handle={route.handle} initialTab={route.tab} back={back} />}
        {route.screen === "page" && route.page === "board" && <BoardScreen key={route.cwd} client={client} cwd={route.cwd} cardId={route.cardId} push={push} back={back} />}
        {route.screen === "page" && route.page === "laments" && <LamentsScreen client={client} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "page" && route.page === "github" && <GithubScreen client={client} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "page" && route.page === "atp" && <AtpScreen client={client} homeDir={homeDir} cwd={route.cwd} push={push} back={back} />}
        {route.screen === "page" && route.page !== "board" && route.page !== "laments" && route.page !== "github" && route.page !== "atp" && <PageSoon route={route} back={back} />}
        {route.screen === "chat" && <ChatScreen key={`${route.sessionPath ?? ""}:${route.handle ?? ""}`} client={client} route={route} back={back} push={push} replace={replace} />}
      </div>
      <Toasts />
      <Lightbox />
    </ChatUiProvider>
  );
}
