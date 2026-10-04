// The landing screen of an unpaired phone: Add to Home Screen advice in Safari, then code entry, waiting for the Mac, and errors.
import { useEffect, useRef, useState } from "react";
import { PAIRING_CODE_LENGTH } from "../shared/host-api";
import { codeFromHash, defaultDeviceName, isStandalone, normalizeCode, pair, type PairFailure } from "./pair-flow";

const MESSAGES: Record<PairFailure, string> = {
  wrong_code: "That code is not right. Check it on the Mac and try again.",
  locked: "Too many wrong codes. Create a new code on the Mac (Settings > Remote access).",
  rate_limited: "Too many attempts. Wait a minute and try again.",
  expired: "The request expired. Create a new code on the Mac and try again.",
  denied: "The Mac denied this device.",
  unreachable: "Cannot reach the Mac. Check that pi-gna is running and Tailscale is connected.",
};

type Phase = "form" | "sending" | "waiting";

export function Pairing({ onPaired }: { onPaired: () => void }) {
  const standalone = isStandalone(navigator as { standalone?: boolean }, (q) => matchMedia(q).matches);
  const [inSafari, setInSafari] = useState(!standalone);
  const [code, setCode] = useState(() => codeFromHash(location.hash));
  const [name, setName] = useState(() => defaultDeviceName(navigator.userAgent));
  const [phase, setPhase] = useState<Phase>("form");
  const [failure, setFailure] = useState<PairFailure>();
  const abort = useRef<AbortController | undefined>(undefined);

  // The code lives in the fragment only to travel from the QR; drop it from the address bar.
  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    return () => abort.current?.abort();
  }, []);

  const submit = async () => {
    abort.current = new AbortController();
    setFailure(undefined);
    setPhase("sending");
    const outcome = await pair(code, name.trim() || defaultDeviceName(navigator.userAgent), {
      fetch: (input, init) => fetch(input, init),
      onPending: () => setPhase("waiting"),
      signal: abort.current.signal,
    });
    if (abort.current.signal.aborted) return;
    if (outcome.ok) return onPaired();
    setFailure(outcome.failure);
    setPhase("form");
  };

  if (inSafari) {
    return (
      <main className="safe-area flex h-full flex-col justify-center gap-5 px-6 text-[15px]" data-testid="pair-safari">
        <div className="font-mono text-[11px] uppercase tracking-wide text-faint">pi-gna</div>
        <h1 className="text-xl font-semibold">Add to Home Screen first</h1>
        <p className="text-muted">
          The Home Screen app keeps its own storage, separate from Safari. Pair it from there so you stay signed in: tap Share, then Add to Home Screen, then open pi-gna from your Home Screen.
        </p>
        <button className="rounded-lg border border-line px-4 py-3 text-muted" onClick={() => setInSafari(false)}>
          Pair in Safari anyway
        </button>
      </main>
    );
  }

  if (phase === "waiting") {
    return (
      <main className="safe-area flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-[15px]" data-testid="pair-waiting">
        <div className="font-mono text-[11px] uppercase tracking-wide text-faint">pi-gna</div>
        <div>Waiting for approval on the Mac…</div>
        <p className="text-muted">Allow “{name}” in the pi-gna window on your Mac.</p>
        <button
          className="rounded-lg border border-line px-4 py-2 text-muted"
          onClick={() => {
            abort.current?.abort();
            setPhase("form");
          }}
        >
          Cancel
        </button>
      </main>
    );
  }

  const ready = code.length === PAIRING_CODE_LENGTH && phase === "form";
  return (
    <main className="safe-area flex h-full flex-col justify-center gap-4 px-6 text-[15px]" data-testid="pair-form">
      <div className="font-mono text-[11px] uppercase tracking-wide text-faint">pi-gna</div>
      <h1 className="text-xl font-semibold">Pair this device</h1>
      <p className="text-muted">On the Mac open Settings → Remote access, create a pairing code and enter it here. The Mac then asks you to approve.</p>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-faint">Pairing code</span>
        <input
          className="rounded-lg border border-line bg-transparent px-3 py-3 font-mono text-lg tracking-[0.3em]"
          value={code}
          onChange={(e) => setCode(normalizeCode(e.target.value))}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          placeholder="ABCD2345"
          data-testid="pair-code"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-faint">Device name</span>
        <input className="rounded-lg border border-line bg-transparent px-3 py-3 text-[16px]" value={name} onChange={(e) => setName(e.target.value)} data-testid="pair-name" />
      </label>
      {failure && (
        <div role="alert" className="text-[13px] text-red-400" data-testid="pair-error">
          {MESSAGES[failure]}
        </div>
      )}
      <button className="rounded-lg bg-fg px-4 py-3 font-medium text-canvas disabled:opacity-40" disabled={!ready} onClick={() => void submit()} data-testid="pair-submit">
        {phase === "sending" ? "Sending…" : "Pair"}
      </button>
    </main>
  );
}
