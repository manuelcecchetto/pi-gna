import { describe, expect, it, vi } from "vitest";
import { type ComputerNotification, type ComputerOp, type ComputerSettings, emptyComputerSettings, applyComputerOp } from "../../shared/computer";
import { ComputerError, ComputerErrorCode } from "../../shared/computer";
import { ComputerAgent, type ComputerHost } from "./agent";

const APPS = [
  { id: "com.apple.calculator", bundleId: "com.apple.calculator", displayName: "Calculator", isRunning: true },
  { id: "com.apple.TextEdit", bundleId: "com.apple.TextEdit", displayName: "TextEdit", isRunning: true },
  { id: "com.apple.Terminal", bundleId: "com.apple.Terminal", displayName: "Terminal", isRunning: true },
  { id: "io.github.example.other", bundleId: "io.github.example.other", displayName: "pi-gna", isRunning: true },
  { id: "com.apple.Notes", bundleId: "com.apple.Notes", displayName: "Notes", isRunning: false },
];

function setup(options: { enabled?: boolean; answer?: string; idleMs?: number } = {}) {
  let settings: ComputerSettings = { ...emptyComputerSettings(), enabled: options.enabled ?? true };
  const listeners = new Set<(n: ComputerNotification) => void>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Methods that wait for the test to let them finish. */
  const gates = new Map<string, () => void>();
  const gated = new Set<string>();
  const service = {
    onNotification: (fn: (n: ComputerNotification) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    call: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const app = params.app as string | { bundleId: string } | undefined;
      const id = typeof app === "string" ? app : app?.bundleId;
      if (method === "resolve_app") {
        const hit = APPS.find((a) => a.bundleId === id || a.displayName.toLowerCase() === String(id).toLowerCase());
        if (!hit || (!hit.isRunning && params.launch === false)) throw new ComputerError(ComputerErrorCode.appNotFound, "not running");
        return { bundleId: hit.bundleId, displayName: hit.displayName, pid: 1 };
      }
      if (method === "list_apps") return { apps: APPS };
      if (method === "get_app_state") return { text: `state of ${id}`, windowId: 42 };
      if (method === "screenshot") return { jpeg: "AAAA" };
      if (method === "overlay_show" || method === "overlay_hide") return {};
      if (gated.has(`${method}:${id}`)) await new Promise<void>((resolve) => gates.set(`${method}:${id}`, resolve));
      if (method === "type_text") return { method: "cgevent", settled: true, target: '[9] AXTextArea "chat"' };
      return { method: "ax", settled: true };
    }),
  };
  const chose: string[] = [];
  const aborted: string[] = [];
  const host: ComputerHost = {
    choose: vi.fn(async (handle: string, title: string) => {
      chose.push(`${handle}:${title}`);
      return options.answer ?? "Allow once";
    }),
    chatName: async (handle) => `chat ${handle}`,
    abort: async (handle) => void aborted.push(handle),
  };
  const policy = {
    get: async () => settings,
    apply: vi.fn(async (op: ComputerOp) => void (settings = applyComputerOp(settings, op, 1))),
  };
  const agent = new ComputerAgent(service as never, policy, host, { ownNames: ["pi-gna"], idleMs: options.idleMs });
  const names = () => calls.map((c) => `${c.method}${c.params.app && typeof c.params.app === "object" ? `:${(c.params.app as { bundleId: string }).bundleId}` : ""}`);
  return { agent, service, policy, host, calls, chose, aborted, names, gated, gates, notify: (n: ComputerNotification) => listeners.forEach((fn) => fn(n)), settings: () => settings };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (app: string, extra: Record<string, unknown> = {}) => ({ action: "click", app, element_index: 3, ...extra });

describe("computer route policy", () => {
  it("refuses everything while Computer Use is disabled", async () => {
    const t = setup({ enabled: false });
    await expect(t.agent.run("a1", click("Calculator"))).rejects.toMatchObject({ status: 403, message: expect.stringContaining("is off") });
    await expect(t.agent.run("a1", { action: "list_apps" })).rejects.toMatchObject({ status: 403 });
    expect(t.calls).toEqual([]);
    expect(t.chose).toEqual([]);
  });

  it("never acts on or asks about a denylisted app, even when stored as always-allowed", async () => {
    const t = setup();
    await expect(t.agent.run("a1", click("Terminal"))).rejects.toMatchObject({ status: 403 });
    await expect(t.agent.run("a1", click("pi-gna"))).rejects.toMatchObject({ status: 403 });
    expect(t.chose).toEqual([]);
    expect(t.names().filter((n) => n.startsWith("click") || n.startsWith("overlay"))).toEqual([]);
    expect((await t.agent.run("a1", { action: "list_apps" })).text).not.toContain("Terminal");
  });

  it("asks once per chat for Allow once and forgets it when the run ends", async () => {
    const t = setup({ answer: "Allow once" });
    await t.agent.run("a1", click("Calculator"));
    await t.agent.run("a1", click("Calculator"));
    expect(t.chose).toHaveLength(1);
    expect(t.settings().alwaysAllowed).toEqual([]);
    await t.agent.release("a1");
    await t.agent.run("a1", click("Calculator"));
    expect(t.chose).toHaveLength(2);
  });

  it("stores Always allow and then skips the card, also for other chats, until revoked", async () => {
    const t = setup({ answer: "Always allow" });
    await t.agent.run("a1", click("Calculator"));
    expect(t.settings().alwaysAllowed.map((a) => a.bundleId)).toEqual(["com.apple.calculator"]);
    await t.agent.release("a1");
    await t.agent.run("b2", click("Calculator"));
    expect(t.chose).toHaveLength(1);
    await t.agent.release("b2");
    t.policy.apply({ type: "revoke", bundleId: "com.apple.calculator" });
    await t.agent.run("b2", click("Calculator"));
    expect(t.chose).toHaveLength(2);
  });

  it("Deny fails the call and is not asked again this run", async () => {
    const t = setup({ answer: "Deny" });
    await expect(t.agent.run("a1", click("Calculator"))).rejects.toMatchObject({ status: 403, message: "The user did not allow Calculator." });
    await expect(t.agent.run("a1", click("Calculator"))).rejects.toMatchObject({ status: 403 });
    expect(t.chose).toHaveLength(1);
    expect(t.names()).not.toContain("click:com.apple.calculator");
  });

  it("a dismissed card counts as Deny", async () => {
    const t = setup();
    (t.host.choose as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(t.agent.run("a1", click("Calculator"))).rejects.toMatchObject({ status: 403 });
  });

  it("parallel calls of one chat for one app share one card", async () => {
    const t = setup();
    await Promise.all([t.agent.run("a1", click("Calculator")), t.agent.run("a1", click("Calculator", { element_index: 4 }))]);
    expect(t.chose).toHaveLength(1);
  });
});

describe("computer route locks and cleanup", () => {
  it("shows the overlay once per run with the chat name and lets a second chat in only after release", async () => {
    const t = setup();
    await t.agent.run("a1", click("Calculator"));
    await t.agent.run("a1", click("Calculator"));
    const shows = t.calls.filter((c) => c.method === "overlay_show");
    expect(shows).toHaveLength(1);
    expect(shows[0]?.params).toMatchObject({ session_label: "chat a1", session: "a1", app: { bundleId: "com.apple.calculator" }, motion: "signature_arc" });

    await expect(t.agent.run("b2", click("Calculator"))).rejects.toMatchObject({ status: 409, message: expect.stringContaining("another chat") });
    expect(t.chose.filter((c) => c.startsWith("b2"))).toEqual([]); // busy is reported before bothering the user

    await t.agent.release("a1");
    expect(t.names()).toContain("overlay_hide:com.apple.calculator");
    await t.agent.run("b2", click("Calculator"));
  });

  it("different apps from different chats run at the same time", async () => {
    const t = setup();
    t.gated.add("click:com.apple.calculator");
    t.gated.add("click:com.apple.TextEdit");
    const a = t.agent.run("a1", click("Calculator"));
    const b = t.agent.run("b2", click("TextEdit"));
    await vi.waitFor(() => expect([...t.gates.keys()].sort()).toEqual(["click:com.apple.TextEdit", "click:com.apple.calculator"]));
    t.gates.get("click:com.apple.calculator")?.();
    t.gates.get("click:com.apple.TextEdit")?.();
    await expect(a).resolves.toMatchObject({ app: { bundleId: "com.apple.calculator" } });
    await expect(b).resolves.toMatchObject({ app: { bundleId: "com.apple.TextEdit" } });
  });

  it("one chat's calls run one at a time", async () => {
    const t = setup();
    t.gated.add("click:com.apple.calculator");
    const first = t.agent.run("a1", click("Calculator"));
    const second = t.agent.run("a1", { action: "type_text", app: "Calculator", text: "7" });
    await vi.waitFor(() => expect(t.gates.has("click:com.apple.calculator")).toBe(true));
    await tick();
    expect(t.names()).not.toContain("type_text:com.apple.calculator");
    t.gates.get("click:com.apple.calculator")?.();
    await Promise.all([first, second]);
    expect(t.names()).toContain("type_text:com.apple.calculator");
  });

  it("releases an app after the idle timeout", async () => {
    const t = setup({ idleMs: 20 });
    await t.agent.run("a1", click("Calculator"));
    await vi.waitFor(() => expect(t.names()).toContain("overlay_hide:com.apple.calculator"));
    await t.agent.run("b2", click("Calculator"));
  });

  it("Esc aborts the run, frees the app and fails the pending call", async () => {
    const t = setup();
    await t.agent.run("a1", click("Calculator"));
    t.gated.add("click:com.apple.calculator");
    const pending = t.agent.run("a1", click("Calculator"));
    const queued = t.agent.run("a1", click("Calculator", { element_index: 9 }));
    await vi.waitFor(() => expect(t.gates.has("click:com.apple.calculator")).toBe(true));
    t.notify({ method: "cancelled", params: { app: "com.apple.calculator", session: "a1", reason: "esc" } });
    await expect(pending).rejects.toThrow("Stopped by the user (Esc)");
    await expect(queued).rejects.toThrow("Stopped by the user (Esc)");
    expect(t.aborted).toEqual(["a1"]);
    t.gated.clear();
    await t.agent.run("b2", click("Calculator")); // lock released
  });

  it("ignores a cancelled notification for an unknown chat", async () => {
    const t = setup();
    t.notify({ method: "cancelled", params: { session: "zz9", reason: "esc" } });
    expect(t.aborted).toEqual([]);
  });

  it("previews the latest held app, and none after Computer Use is turned off", async () => {
    const t = setup();
    await t.agent.run("a1", click("Calculator"));
    await t.agent.run("a1", click("TextEdit"));
    expect(await t.agent.preview("a1")).toEqual({ mimeType: "image/jpeg", data: "AAAA", app: "TextEdit" });
    expect(t.calls.at(-1)).toEqual({ method: "screenshot", params: { app: { bundleId: "com.apple.TextEdit" } } });
    t.policy.apply({ type: "disable" });
    expect(await t.agent.preview("a1")).toBeNull();
  });

  it("takes the screenshot of the window the state came from", async () => {
    const t = setup();
    await t.agent.run("a1", { action: "get_app_state", app: "Notes" });
    expect(t.calls.find((c) => c.method === "screenshot")?.params).toMatchObject({ window_id: 42 });
  });

  it("opens a not-running app only after approval, and only for get_app_state", async () => {
    const t = setup({ answer: "Deny" });
    await expect(t.agent.run("a1", { action: "get_app_state", app: "Notes" })).rejects.toMatchObject({ status: 403 });
    expect(t.calls.some((c) => c.method === "resolve_app" && c.params.launch === true)).toBe(false);

    const allowed = setup();
    await expect(allowed.agent.run("a1", click("Notes"))).rejects.toThrow("not running");
    const state = await allowed.agent.run("a1", { action: "get_app_state", app: "Notes" });
    expect(state).toMatchObject({ text: "state of com.apple.Notes", image: "AAAA" });
    expect(allowed.calls.some((c) => c.method === "resolve_app" && c.params.launch === true)).toBe(true);
  });

  it("names the element a key action's keys went to", async () => {
    const t = setup();
    const result = await t.agent.run("a1", { action: "type_text", app: "TextEdit", text: "hi" });
    expect(result.text).toContain('type_text done (cgevent), keys went to [9] AXTextArea "chat".');
    expect((await t.agent.run("a1", click("TextEdit"))).text).toContain("click done (ax).");
  });

  it("forwards only the declared parameters and maps the secondary action name", async () => {
    const t = setup();
    await t.agent.run("a1", { action: "perform_secondary_action", app: "Calculator", element_index: 2, secondary_action: "Show Menu", token: "x" });
    const call = t.calls.find((c) => c.method === "perform_secondary_action");
    expect(call?.params).toEqual({ app: { bundleId: "com.apple.calculator" }, element_index: 2, action: "Show Menu" });
    await expect(t.agent.run("a1", { action: "click", app: "Calculator", x: { a: 1 } })).rejects.toMatchObject({ message: expect.stringContaining("x must be") });
    await expect(t.agent.run("a1", { action: "bogus", app: "Calculator" })).rejects.toMatchObject({ status: 400 });
  });
});
