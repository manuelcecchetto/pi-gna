import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { helloBuild, registerServiceWorker, reloadIfStale } from "./boot";
import { Pairing } from "./Pairing";
import { signOutThisDevice } from "./pair-flow";
import "./styles.css";

type State = "connecting" | "unreachable" | "unpaired" | "paired";

// Placeholder shell: later nodes replace the paired body with the app.
function Shell() {
  const [state, setState] = useState<State>("connecting");
  const check = () =>
    void helloBuild().then(async (hello) => {
      if (await reloadIfStale(hello)) return;
      setState(!hello ? "unreachable" : hello.authenticated ? "paired" : "unpaired");
    });
  useEffect(check, []);
  if (state === "unpaired") return <Pairing onPaired={check} />;
  return (
    <main className="safe-area flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="font-mono text-[11px] uppercase tracking-wide text-faint">pi-gna</div>
      <div className="text-[15px]">
        {state === "unreachable" ? `Cannot reach ${location.host}` : state === "paired" ? `Connected to ${location.host}` : `Connecting to ${location.host}…`}
      </div>
      {state === "paired" && (
        <button
          className="rounded-lg border border-line px-4 py-2 text-[14px] text-muted"
          data-testid="sign-out"
          onClick={() => void signOutThisDevice((i, n) => fetch(i, n)).then((ok) => ok && check())}
        >
          Sign out this device
        </button>
      )}
    </main>
  );
}

registerServiceWorker();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
