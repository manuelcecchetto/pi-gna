// One CDP session per tab, shared by the manager (emulation) and the agent (input, screenshots).
import type { WebContents } from "electron";

/** Send a CDP command to a tab, attaching the debugger on first use. */
export async function cdp(wc: WebContents, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
  return wc.debugger.sendCommand(method, params);
}
