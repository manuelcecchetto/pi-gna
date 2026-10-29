// The voice call screen (src/shared/voice.ts): an orb that shows who is talking, the call's live captions and the
// hand-offs to the chats, and the call's controls. It covers the window while a call is on; Esc ends the call. GPT-Live
// listens while it speaks, so you interrupt it by talking.
import { useEffect, useRef, useState } from "react";
import type { CallState } from "../../../shared/voice";
import { useApp } from "../state/app";
import { endCall, orbLevel, startCall, toggleAssistant, toggleMic, useVoiceCall, useVoiceStatus } from "../state/voice";
import { AudioLines, Mic, MicOff, PhoneOff, Volume2, VolumeX, X } from "./icons";

const STATE_LABEL: Record<CallState, string> = {
  connecting: "Connecting…",
  listening: "Listening…",
  hearing: "Hearing you…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  ended: "Call ended",
};

/** The level the orb swells with: the voice while it speaks, the microphone while you do. */
function useOrbLevel(state: CallState): number {
  const [now, setNow] = useState(0);
  const frame = useRef(0);
  useEffect(() => {
    if (state !== "speaking" && state !== "hearing") return setNow(0);
    const tick = () => {
      setNow(orbLevel());
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [state]);
  return now;
}

function CallButton({ label, onClick, danger, pressed, children, testId }: { label: string; onClick: () => void; danger?: boolean; pressed?: boolean; children: React.ReactNode; testId: string }) {
  return (
    <div className="flex w-24 flex-col items-center gap-2">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        data-testid={testId}
        className={`grid h-14 w-14 place-items-center rounded-full transition-colors ${
          danger ? "bg-bad text-white hover:opacity-90" : pressed ? "bg-fg text-canvas" : "bg-raised text-fg hover:bg-line"
        }`}
      >
        {children}
      </button>
      <span className="text-center text-[12px] leading-tight text-muted">{label}</span>
    </div>
  );
}

export function VoiceCallScreen() {
  const call = useVoiceCall();
  const level = useOrbLevel(call?.state ?? "ended");
  useEffect(() => {
    if (!call) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endCall();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [call?.id]);
  if (!call) return null;
  const project = call.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? call.cwd;
  const ended = call.state === "ended";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-label="Voice call" data-testid="voice-call">
      <div className="drag h-12 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-8 pb-10">
        <div className="text-[13px] text-muted">
          Voice call · <span className="text-fg">{project}</span>
        </div>
        <div className="voice-orb" data-state={call.state} style={{ "--level": level.toFixed(3) } as React.CSSProperties} aria-hidden data-testid="voice-orb" />
        <div className="flex flex-col items-center gap-1">
          <div className="text-[15px] font-medium text-fg" aria-live="polite" data-testid="voice-state">
            {ended && call.ended && call.ended !== "ended" ? call.ended : STATE_LABEL[call.state]}
          </div>
          <div className={`text-[12px] text-faint ${call.state === "speaking" ? "" : "invisible"}`}>Talk to interrupt</div>
        </div>
        <ol className="flex min-h-[7.5rem] w-full max-w-xl flex-col justify-end gap-1.5 text-center" data-testid="voice-lines">
          {call.lines.map((line, index) => (
            <li
              key={`${index}:${line.text}`}
              className={
                line.kind === "assistant"
                  ? "selectable text-[14px] leading-snug text-fg"
                  : line.kind === "error"
                    ? "text-[12.5px] text-bad"
                    : line.kind === "work"
                      ? "text-[12px] text-faint"
                      : "selectable text-[12.5px] text-muted"
              }
            >
              {line.kind === "user" ? `“${line.text.trim()}”` : line.text}
            </li>
          ))}
          {!call.lines.length && !ended && (
            <li className="text-[12.5px] text-faint">Ask what your chats are doing, or tell one what to do next.</li>
          )}
        </ol>
        <div className="flex items-start justify-center gap-2">
          {ended ? (
            <>
              <CallButton label="Call again" onClick={() => void startCall(call.cwd)} testId="voice-again">
                <AudioLines size={22} />
              </CallButton>
              <CallButton label="Close" onClick={endCall} testId="voice-close">
                <X size={22} />
              </CallButton>
            </>
          ) : (
            <>
              <CallButton label={call.assistantMuted ? "Unmute assistant" : "Mute assistant"} pressed={call.assistantMuted} onClick={toggleAssistant} testId="voice-mute-assistant">
                {call.assistantMuted ? <VolumeX size={22} /> : <Volume2 size={22} />}
              </CallButton>
              <CallButton label={call.micMuted ? "Unmute microphone" : "Mute microphone"} pressed={call.micMuted} onClick={toggleMic} testId="voice-mute-mic">
                {call.micMuted ? <MicOff size={22} /> : <Mic size={22} />}
              </CallButton>
              <CallButton label="End call" danger onClick={endCall} testId="voice-end">
                <PhoneOff size={24} />
              </CallButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The composer's call button, beside the mic: a call about the chat's project. */
export function VoiceCallButton({ cwd }: { cwd: string }) {
  const on = useApp((state) => state.settings.voice);
  const status = useVoiceStatus(on);
  if (!on) return null;
  const ready = status?.phase === "ready";
  const title = status?.phase === "error" ? `Voice call: ${status.error ?? "not ready"} (see Settings > Agent > Voice calls)` : "Voice call: talk to this project's chats";
  return (
    <button
      type="button"
      title={title}
      aria-label="Voice call"
      disabled={!ready}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void startCall(cwd)}
      data-testid="composer-voice-call"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-50"
    >
      <AudioLines size={15} />
    </button>
  );
}
