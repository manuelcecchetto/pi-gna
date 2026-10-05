// Extension notices (`notify`) as phone toasts. Every pi process repeats the same extension startup notices, so a
// startup warning shows once per app run and startup chatter ("X loaded") not at all (the desktop does the same).
import type { HostEvent } from "../shared/host-api";
import type { SessionState } from "../shared/session-state";

export interface Notice {
  text: string;
  level: "info" | "warning" | "error";
}

/** The toast an event calls for, or undefined; `seen` remembers the startup warnings already shown. */
export function noticeFor(event: HostEvent, session: Pick<SessionState, "phase">, seen: Set<string>): Notice | undefined {
  if (event.kind !== "rpc" || event.record.type !== "extension_ui_request" || event.record.method !== "notify") return undefined;
  const { message, notifyType } = event.record;
  const level = notifyType === "error" ? "error" : notifyType === "warning" ? "warning" : "info";
  if (session.phase === "starting") {
    if (level === "info" || seen.has(message)) return undefined;
    seen.add(message);
  }
  return { text: message, level };
}
