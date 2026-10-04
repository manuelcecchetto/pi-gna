// One chat: join it on the host (open, or attach to a live one), show its transcript and approvals, and let go on leave.
// Leaving detaches only: the host keeps the run going (docs/REMOTE.md section 5).
import { useEffect, useState } from "react";
import { Dialogs } from "../renderer/src/components/Dialogs";
import { Transcript } from "../renderer/src/components/Transcript";
import { useStore } from "../renderer/src/lib/store";
import { attention } from "../shared/session-state";
import type { HostClient } from "./client/host-client";
import { MobileComposer } from "./MobileComposer";
import type { Route } from "./nav";
import { Header, Mark } from "./Screens";

type ChatRoute = Extract<Route, { screen: "chat" }>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Takes the chat's lease for as long as the screen is up and puts it on the stream; returns its handle. */
function useJoinedChat(client: HostClient, route: ChatRoute, attempt: number) {
  const [handle, setHandle] = useState<string>();
  const [error, setError] = useState<string>();
  const connection = useStore(client.store, (s) => s.connection);

  useEffect(() => {
    let dead = false;
    let joined: string | undefined;
    const release = (h: string) => {
      void client.call("chat.viewing", { handle: h, viewing: false }).catch(() => undefined);
      void client.call("chat.detach", { handle: h }).catch(() => undefined);
    };
    setHandle(undefined);
    setError(undefined);
    (async () => {
      try {
        let h = route.handle;
        if (h) {
          if (!(await client.call("chat.attach", { handle: h }))) throw new Error("This chat has ended.");
        } else {
          h = (await client.call("chat.open", { request: { cwd: route.cwd, sessionPath: route.sessionPath } })).handle;
        }
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
  }, [client, route.cwd, route.sessionPath, route.handle, attempt]);

  // A suspended page may have lost its lease (60 s grace) while the stream was down: take it again once live.
  useEffect(() => {
    if (!handle || connection !== "live") return;
    void client
      .call("chat.attach", { handle })
      .then((snapshot) => {
        if (!snapshot) setError("This chat has ended.");
        else void client.call("chat.viewing", { handle, viewing: true }).catch(() => undefined);
      })
      .catch(() => undefined);
  }, [client, handle, connection]);

  return { handle, error };
}

export function ChatScreen({ client, route, back }: { client: HostClient; route: ChatRoute; back: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const { handle, error } = useJoinedChat(client, route, attempt);
  const entry = useStore(client.store, (s) => (handle ? s.chats[handle] : undefined));
  const session = entry?.session;
  const failure = error ?? entry?.error;
  const title = session?.name ?? session?.title ?? route.title ?? "Chat";
  const level = session ? attention(session) : undefined;
  const earlier = entry?.turns && entry.turns.from > 0 && handle ? { count: entry.turns.from, load: () => client.loadEarlier(handle) } : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={title} onBack={back} trailing={<span className="pr-4"><Mark level={level} /></span>} />
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
          <Transcript session={session} earlier={earlier} />
          {session.dialogs.length > 0 && (
            <div className="max-h-[55%] shrink-0 overflow-y-auto px-3 pb-2" data-testid="dialogs">
              <Dialogs handle={session.handle} dialogs={session.dialogs} />
            </div>
          )}
          <MobileComposer client={client} session={session} />
        </>
      )}
    </div>
  );
}
