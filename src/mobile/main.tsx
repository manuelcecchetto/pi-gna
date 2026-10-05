import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { helloBuild, registerServiceWorker, reloadIfStale } from "./boot";
import { Pairing } from "./Pairing";
import { signOutThisDevice } from "./pair-flow";
import { installViewport } from "./viewport";
import "./styles.css";

type State = "connecting" | "unreachable" | "unpaired" | "paired";

function Shell() {
  const [state, setState] = useState<State>("connecting");
  const check = () =>
    void helloBuild().then(async (hello) => {
      if (await reloadIfStale(hello)) return;
      setState(!hello ? "unreachable" : hello.authenticated ? "paired" : "unpaired");
    });
  useEffect(check, []);
  if (state === "unpaired") return <Pairing onPaired={check} />;
  if (state === "paired") {
    return (
      <App
        onUnauthorized={check}
        signOut={
          <div className="p-6 text-center">
            <button
              className="rounded-lg border border-line px-4 py-2.5 text-[14px] text-muted"
              data-testid="sign-out"
              onClick={() => void signOutThisDevice((i, n) => fetch(i, n)).then((ok) => ok && check())}
            >
              Sign out this device
            </button>
            <div className="mt-2 font-mono text-[11px] text-faint">{location.host}</div>
          </div>
        }
      />
    );
  }
  return (
    <main className="safe-area flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="font-mono text-[11px] uppercase tracking-wide text-faint">pi-gna</div>
      <div className="text-[15px]">{state === "unreachable" ? `Cannot reach ${location.host}` : `Connecting to ${location.host}…`}</div>
      {state === "unreachable" && (
        <button className="rounded-lg border border-line px-4 py-2 text-[14px] text-muted" onClick={check}>
          Try again
        </button>
      )}
    </main>
  );
}

registerServiceWorker();
installViewport();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The fixed element WebKit samples for the top edge (it hit-tests 4 px down and skips boxes 10 px or thinner):
        with a solid one there iOS fills the status bar with its color instead of blurring the page. Sampling runs only
        when the load commits or a fixed element comes or goes, so it lives for the whole page. REMOTE_IOS.md row 15. */}
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-30 h-[max(12px,env(safe-area-inset-top))] bg-canvas" />
    <Shell />
  </StrictMode>,
);
