// One chat: join it on the host (open, or attach to a live one), show its transcript and approvals, and let go on leave.
// Leaving detaches only: the host keeps the run going (docs/REMOTE.md section 5).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ListChevronsDownUp, ListChevronsUpDown, PanelRight } from "../renderer/src/components/icons";
import { Dialogs } from "../renderer/src/components/Dialogs";
import { Transcript } from "../renderer/src/components/Transcript";
import { useChatUi, useChatUiHandle } from "../renderer/src/lib/chat-ui";
import { useStore } from "../renderer/src/lib/store";
import type { ComputerPreviewFrame } from "../shared/computer";
import { attention } from "../shared/session-state";
import { useWakeAt } from "../renderer/src/components/primitives";
import { agentActive, agentLapse } from "./browser-data";
import { showChat, toggleExpandAll } from "./chat-ui";
import { keepFrame, pollPreview, runUsesComputer } from "./computer-preview";
import type { HostClient } from "./client/host-client";
import { projectOf } from "../shared/board";
import { FolderPicker } from "./ProjectSheets";
import { MobileComposer } from "./MobileComposer";
import type { Route } from "./nav";
import { Header, Mark } from "./Screens";
import { TurnList } from "./TurnList";

type ChatRoute = Extract<Route, { screen: "chat" }>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Takes the chat's lease for as long as the screen is up and puts it on the stream; returns its handle. */
function useJoinedChat(client: HostClient, route: ChatRoute, attempt: number) {
  const [handle, setHandle] = useState<string>();
  const [error, setError] = useState<string>();
  const connection = useStore(client.store, (s) => s.connection);
  // A chat whose pi stopped meanwhile (idle on the Mac, or it exited) opens again from its session file. Not an ATP chat:
  // a plain open would lose its role, and its runner and page start it again themselves.
  const [reopen, setReopen] = useState(0);
  const file = useRef(route.sessionPath);
  const sessionPath = useStore(client.store, (s) => {
    const session = handle ? s.chats[handle]?.session : undefined;
    return session?.atp ? undefined : session?.sessionPath;
  });
  useEffect(() => {
    if (sessionPath) file.current = sessionPath;
  }, [sessionPath]);

  useEffect(() => {
    let dead = false;
    let joined: string | undefined;
    const release = (h: string) => {
      void client.call("chat.viewing", { handle: h, viewing: false }).catch(() => undefined);
      void client.call("chat.detach", { handle: h }).catch(() => undefined);
      // An orchestrator chat is a lease the ATP page took for this client: let the host stop it when nobody else is in it.
      if (route.orchestrator) void client.call("atp.releaseOrchestrators", {}).catch(() => undefined);
    };
    setHandle(undefined);
    setError(undefined);
    (async () => {
      try {
        let h = route.handle;
        if (h && !(await client.call("chat.attach", { handle: h }))) {
          if (!file.current) throw new Error("This chat has ended.");
          h = undefined;
        }
        h ??= (await client.call("chat.open", { request: { cwd: route.cwd, sessionPath: file.current } })).handle;
        joined = h;
        if (dead) return release(h);
        await client.setChats([h]);
        if (dead) return;
        setHandle(h);
        void client.call("chat.viewing", { handle: h, viewing: true }).catch(() => undefined);
      } catch (e) {
        if (!dead) setError(message(e));
      }
    })();
    return () => {
      dead = true;
      void client.setChats([]);
      if (joined) release(joined);
    };
  }, [client, route.cwd, route.sessionPath, route.handle, attempt, reopen]);

  // A suspended page may have lost its lease (60 s grace) while the stream was down: take it again once live.
  useEffect(() => {
    if (!handle || connection !== "live") return;
    void client
      .call("chat.attach", { handle })
      .then((snapshot) => {
        if (snapshot) void client.call("chat.viewing", { handle, viewing: true }).catch(() => undefined);
        else if (file.current) setReopen((n) => n + 1);
        else setError("This chat has ended.");
      })
      .catch(() => undefined);
  }, [client, handle, connection]);

  return { handle, error };
}

/**
 * Read-only view of the Mac app this chat is driving (Computer Use); gone when the chat holds none. Never controls it.
 * Polls only while the run used Computer Use and the page shows; an unchanged frame comes back as its id alone.
 */
function ComputerPreview({ client, handle, active }: { client: HostClient; handle: string; active: boolean }) {
  const [frame, setFrame] = useState<ComputerPreviewFrame | null>(null);
  useEffect(() => {
    if (!active) return setFrame(null);
    let shown: ComputerPreviewFrame | null = null;
    return pollPreview(
      () => client.call("computer.preview", shown ? { handle, since: shown.id } : { handle }),
      (next) => setFrame((shown = keepFrame(shown, next))),
    );
  }, [client, handle, active]);
  if (!frame?.data) return null;
  return (
    <div className="shrink-0 border-t border-line px-3 py-2" data-testid="computer-preview">
      <div className="mb-1 text-[11.5px] text-muted">pi is using {frame.app} on the Mac (view only)</div>
      <img alt={`${frame.app} on the Mac`} src={`data:${frame.mimeType};base64,${frame.data}`} className="max-h-48 w-full rounded-lg object-contain" />
    </div>
  );
}

/** The chat's browser tabs on the Mac: how many, accented while the agent drives one. */
function BrowserButton({ client, handle, onOpen }: { client: HostClient; handle: string; onOpen: () => void }) {
  const tabs = useStore(client.store, (s) => s.global.browser?.tabs)?.filter((t) => t.agent === handle) ?? [];
  const now = Date.now();
  useWakeAt(agentLapse(tabs, now));
  const busy = tabs.some((t) => agentActive(t, now));
  const label = tabs.length ? `Browser, ${tabs.length} tab${tabs.length === 1 ? "" : "s"}` : "Browser";
  return (
    <button type="button" aria-label={label} data-testid="open-browser" onClick={onOpen} className={`relative grid h-11 w-11 shrink-0 place-items-center ${busy ? "text-accent" : "text-muted"}`}>
      <PanelRight size={18} className={busy ? "animate-pulse" : undefined} />
      {tabs.length > 0 && <span className="absolute right-1.5 top-2 min-w-4 rounded-full bg-raised px-1 text-center text-[10px] leading-4 text-fg">{tabs.length}</span>}
    </button>
  );
}

export function ChatScreen({ client, route, back, push, replace }: { client: HostClient; route: ChatRoute; back: () => void; push: (route: Route) => void; replace: (route: Route) => void }) {
  const [attempt, setAttempt] = useState(0);
  const [picking, setPicking] = useState(false);
  // Where TurnList puts its button: in the header, not over the transcript.
  const [turnSlot, setTurnSlot] = useState<HTMLSpanElement | null>(null);
  const { handle, error } = useJoinedChat(client, route, attempt);
  const entry = useStore(client.store, (s) => (handle ? s.chats[handle] : undefined));
  const session = entry?.session;
  const failure = error ?? entry?.error;
  const title = session?.name ?? session?.title ?? route.title ?? "New chat";
  const level = session ? attention(session) : undefined;
  const ui = useChatUiHandle();
  const expandAll = useChatUi((s) => s.expandAll);
  // Before the transcript's effects settle its links (layout effects run before every passive effect).
  const chatHandle = session?.handle;
  const chatCwd = session?.cwd;
  useLayoutEffect(() => {
    showChat(chatHandle && chatCwd ? { handle: chatHandle, cwd: chatCwd } : undefined);
    return () => showChat(undefined);
  }, [chatHandle, chatCwd]);
  // A first turn that came in part counts as one more: its prompt is still on the host.
  const hidden = entry?.turns ? entry.turns.from + (entry.turns.offset ? 1 : 0) : 0;
  const earlier = hidden > 0 && handle ? { count: hidden, load: () => client.loadEarlier(handle) } : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={title} onBack={back} trailing={
          <>
            <span ref={setTurnSlot} className="contents" />
            {session && <BrowserButton client={client} handle={session.handle} onOpen={() => push({ screen: "browser", handle: session.handle })} />}
            {session && (
              <button
                type="button"
                aria-label={expandAll ? "Collapse all steps" : "Expand all steps"}
                aria-pressed={expandAll}
                data-testid="expand-all"
                onClick={() => toggleExpandAll(ui)}
                className={`grid h-11 w-11 shrink-0 place-items-center ${expandAll ? "text-accent" : "text-muted"}`}
              >
                {expandAll ? <ListChevronsDownUp size={18} /> : <ListChevronsUpDown size={18} />}
              </button>
            )}
            <span className="pr-4"><Mark level={level} /></span>
          </>
        }
      />
      {failure && !session ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="text-[14px] text-bad">{failure}</div>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-xl border border-line px-5 py-2.5 text-[15px] text-muted">
            Try again
          </button>
        </div>
      ) : !session ? (
        <div className="flex flex-1 items-center justify-center text-[13.5px] text-faint">Opening…</div>
      ) : (
        <>
          {session.phase === "exited" && (
            <div className="border-b border-bad/30 bg-bad/5 px-4 py-2 text-[12.5px]">
              <span className="text-bad">pi exited.</span> <span className="text-muted">The transcript is read-only.</span>{" "}
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="text-accent underline">
                Reopen
              </button>
            </div>
          )}
          <Transcript session={session} earlier={earlier} turns={(nav) => <TurnList client={client} nav={nav} slot={turnSlot} />} onPickProject={() => setPicking(true)} />
          {session.dialogs.length > 0 && (
            <div className="max-h-[55%] shrink-0 overflow-y-auto px-3 pb-2" data-testid="dialogs">
              <Dialogs handle={session.handle} dialogs={session.dialogs} />
            </div>
          )}
          <ComputerPreview client={client} handle={session.handle} active={session.running && runUsesComputer(session.items)} />
          <MobileComposer client={client} session={session} initialText={route.prefill} cardId={route.cardId} />
        </>
      )}
      {picking && (
        <FolderPicker
          client={client}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setPicking(false);
            replace({ screen: "chat", cwd: projectOf(path) });
          }}
        />
      )}
    </div>
  );
}
