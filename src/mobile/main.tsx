import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { helloBuild, registerServiceWorker, reloadIfStale } from "./boot";
import "./styles.css";

// Placeholder shell: later nodes replace the body once /api/hello says the device is paired.
function Connecting() {
  const [state, setState] = useState<"connecting" | "unreachable" | "ready">("connecting");
  useEffect(() => {
    void helloBuild().then(async (hello) => {
      if (await reloadIfStale(hello)) return;
      setState(hello ? "ready" : "unreachable");
    });
  }, []);
  return (
    <main className="safe-area flex h-full flex-col items-center justify-center gap-2 text-center">
      <div className="font-mono text-[11px] uppercase tracking-wide text-faint">pi-gna</div>
      <div className="text-[15px]">
        {state === "unreachable" ? `Cannot reach ${location.host}` : state === "ready" ? `Connected to ${location.host}` : `Connecting to ${location.host}…`}
      </div>
    </main>
  );
}

registerServiceWorker();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Connecting />
  </StrictMode>,
);
