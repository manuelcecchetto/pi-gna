// POST /computer on the agent bridge: the single gate between pi sessions and the Computer Use helper
// (docs/DESIGN.md, "Computer Use"). Every call is authorized here, never in the extension: bash inherits
// PIGNA_TOKEN, so a direct curl must meet the same checks. Per chat, calls run one at a time (pi runs one
// message's tool calls in parallel); per app, one chat at a time; different apps run in parallel.
import { type AppInfo, ComputerError, ComputerErrorCode, type ComputerMethods, type ComputerNotification, type ComputerOp, type ComputerSettings, denyReason } from "../../shared/computer";
import { bridgeError, type Route } from "../bridge";
import { log } from "../log";
import type { ComputerService } from "./service";

/** What the route needs from the rest of main. SessionHost and the policy store provide it. */
export interface ComputerHost {
  /** The approval card for one chat: resolves to the chosen option, or undefined when dismissed or unanswered. */
  choose(handle: string, title: string, options: string[]): Promise<string | undefined>;
  /** The chat's name, for the label in the other app. */
  chatName(handle: string): Promise<string | undefined>;
  /** Stop the chat's run, as the Stop button does. */
  abort(handle: string): Promise<unknown>;
}

export interface ComputerPolicy {
  get(): Promise<ComputerSettings>;
  apply(op: ComputerOp): unknown;
}

export interface ComputerAgentOptions {
  /** Names or bundle ids of pi-gna itself at runtime (never operated). */
  ownNames?: string[];
  /** An app a chat stopped using is released after this long without an action. */
  idleMs?: number;
}

const ALLOW_ONCE = "Allow once";
const ALLOW_ALWAYS = "Always allow";
const DENY = "Deny";
const IDLE_MS = 5 * 60_000;
const OFF = "Computer use is off. Enable it in Settings > Computer Use.";
const STOPPED = "Stopped by the user (Esc)";
const RUN_ENDED = "The chat's run ended, so Computer Use was released. Start again with computer_get_app_state.";

/** Body parameters forwarded to the helper per action (snake_case, as the helper wants them). */
const ACTION_PARAMS: Record<string, string[]> = {
  click: ["element_index", "x", "y", "mouse_button", "click_count"],
  drag: ["from_x", "from_y", "to_x", "to_y"],
  scroll: ["element_index", "x", "y", "direction", "pages"],
  type_text: ["text"],
  press_key: ["key"],
  set_value: ["element_index", "value"],
  select_text: ["element_index", "text", "prefix", "suffix", "selection_type"],
  perform_secondary_action: ["element_index", "secondary_action"],
  paste: ["text", "format"],
};
const APP_ACTIONS = new Set(["get_app_state", ...Object.keys(ACTION_PARAMS)]);

interface Held {
  name: string;
  idle?: ReturnType<typeof setTimeout>;
}

interface Session {
  /** Bumped when the run ends or is cancelled; work started under an older epoch fails. */
  epoch: number;
  ended: Map<number, string>;
  /** Chained so one chat's calls run in order. */
  queue: Promise<unknown>;
  once: Set<string>;
  denied: Set<string>;
  /** Apps this chat holds, with the overlay up. */
  apps: Map<string, Held>;
  inflight: Set<(error: Error) => void>;
}

interface Target {
  bundleId: string;
  name: string;
  running: boolean;
}

export interface ComputerResult {
  text: string;
  image?: string;
  app?: { name: string; bundleId: string };
}

type Service = Pick<ComputerService, "call" | "onNotification">;

export class ComputerAgent {
  private readonly sessions = new Map<string, Session>();
  /** bundleId -> the chat driving it. */
  private readonly locks = new Map<string, string>();
  private readonly own: string[];
  private readonly idleMs: number;

  constructor(
    private readonly service: Service,
    private readonly policy: ComputerPolicy,
    private readonly host: ComputerHost,
    options: ComputerAgentOptions = {},
  ) {
    this.own = (options.ownNames ?? []).map((name) => name.toLowerCase());
    this.idleMs = options.idleMs ?? IDLE_MS;
    service.onNotification((notification) => this.notified(notification));
  }

  run(handle: string, body: unknown): Promise<ComputerResult> {
    const request = body as Record<string, unknown> | null;
    const action = typeof request?.action === "string" ? request.action : "";
    if (action !== "end" && action !== "list_apps" && !APP_ACTIONS.has(action)) return Promise.reject(bridgeError(400, `unknown action ${action || String(action)}`));
    if (action === "end") return this.release(handle).then(() => ({ text: "Computer use released." }));
    const session = this.session(handle);
    const epoch = session.epoch;
    const next = session.queue.catch(() => undefined).then(() => this.perform(handle, session, epoch, action, request as Record<string, unknown>));
    session.queue = next;
    return next;
  }

  /** A chat's run ended, it was stopped, or it closed: hide the overlays, free its apps, forget its grants. */
  async release(handle: string, reason = RUN_ENDED): Promise<void> {
    const session = this.sessions.get(handle);
    if (!session) return;
    this.stop(session, reason);
    session.once.clear();
    session.denied.clear();
    const held = [...session.apps.keys()];
    for (const bundleId of held) this.free(handle, session, bundleId);
    await Promise.allSettled(held.map((bundleId) => this.service.call("overlay_hide", { app: { bundleId } })));
  }

  /** pi-gna quits: release every chat. */
  async releaseAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((handle) => this.release(handle)));
  }

  private session(handle: string): Session {
    let session = this.sessions.get(handle);
    if (!session) {
      session = { epoch: 0, ended: new Map(), queue: Promise.resolve(), once: new Set(), denied: new Set(), apps: new Map(), inflight: new Set() };
      this.sessions.set(handle, session);
    }
    return session;
  }

  /** Fail the chat's in-flight and queued calls. */
  private stop(session: Session, reason: string): void {
    session.ended.set(session.epoch, reason);
    session.epoch++;
    for (const fail of [...session.inflight]) fail(new Error(reason));
  }

  private alive(session: Session, epoch: number): void {
    const reason = session.ended.get(epoch);
    if (reason) throw new Error(reason);
  }

  /** The helper's `cancelled` (Esc) aborts the chat's run like the Stop button and frees everything it held. */
  private notified(notification: ComputerNotification): void {
    if (notification.method === "cancelled") {
      const handle = notification.params.session;
      if (!handle || !this.sessions.has(handle)) return;
      log.info("computer", `${handle.slice(0, 4)} cancelled with Esc`);
      void this.host.abort(handle).catch(() => undefined);
      void this.release(handle, STOPPED);
    } else if (notification.method === "app_gone") {
      const handle = notification.params.session;
      const bundleId = notification.params.app;
      const session = handle ? this.sessions.get(handle) : undefined;
      if (handle && session && bundleId) {
        this.free(handle, session, bundleId);
        session.once.delete(bundleId);
      }
    }
  }

  private async perform(handle: string, session: Session, epoch: number, action: string, body: Record<string, unknown>): Promise<ComputerResult> {
    this.alive(session, epoch);
    if (!(await this.policy.get()).enabled) throw bridgeError(403, OFF);
    const guard = <T>(work: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        session.inflight.add(reject);
        work.then(resolve, reject).finally(() => session.inflight.delete(reject));
      }).then((value) => {
        this.alive(session, epoch);
        return value;
      });

    if (action === "list_apps") return guard(this.listApps());

    const query = body.app;
    if (typeof query !== "string" || !query.trim() || query.length > 500) throw bridgeError(400, "app (name or bundle id) is required");
    try {
      const target = await guard(this.identify(query.trim()));
      this.refuseDenied(target);
      this.busy(handle, target);
      await guard(this.authorize(handle, session, target));
      this.alive(session, epoch);
      // Acquire in the same turn as the check, so two chats cannot both pass it.
      this.busy(handle, target);
      this.locks.set(target.bundleId, handle);
      try {
        if (!target.running) {
          if (action !== "get_app_state") throw bridgeError(400, `${target.name} is not running. Call computer_get_app_state to open it.`);
          await guard(this.service.call("resolve_app", { app: target.bundleId, launch: true }));
          target.running = true;
        }
        await guard(this.begin(handle, session, target));
        this.touch(handle, session, target.bundleId);
        return await guard(this.act(action, body, target));
      } finally {
        this.touch(handle, session, target.bundleId);
        if (!session.apps.has(target.bundleId) && this.locks.get(target.bundleId) === handle) this.locks.delete(target.bundleId);
      }
    } catch (error) {
      throw this.failure(error);
    }
  }

  private failure(error: unknown): Error {
    if (error instanceof ComputerError) {
      if (error.code === ComputerErrorCode.deniedApp) return bridgeError(403, error.message);
      if (error.code === ComputerErrorCode.permissionDenied) return new Error("Computer Use needs Accessibility (and Screen Recording) permission: open Settings > Computer Use.");
      return new Error(error.message);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async listApps(): Promise<ComputerResult> {
    const { apps } = await this.service.call("list_apps", {});
    const lines = apps
      .filter((app) => !this.denied(app.bundleId ?? app.id, app.displayName))
      .map((app) => `${app.displayName} (${app.bundleId ?? app.id}) ${app.isRunning ? "running" : "installed"}`);
    return { text: lines.length ? lines.join("\n") : "No apps found." };
  }

  /** Name or bundle id to a bundle id, without launching anything (a denied or unapproved app is never started). */
  private async identify(query: string): Promise<Target> {
    try {
      const found = await this.service.call("resolve_app", { app: query, launch: false });
      return { bundleId: found.bundleId, name: found.displayName, running: true };
    } catch (error) {
      if (!(error instanceof ComputerError) || error.code !== ComputerErrorCode.appNotFound) throw error;
    }
    const { apps } = await this.service.call("list_apps", {});
    const lower = query.toLowerCase();
    const hit = apps.find((app: AppInfo) => (app.bundleId ?? app.id).toLowerCase() === lower || app.displayName.toLowerCase() === lower);
    if (!hit) throw bridgeError(404, `No app named "${query}". Call computer_list_apps for the names.`);
    return { bundleId: hit.bundleId ?? hit.id, name: hit.displayName, running: hit.isRunning };
  }

  private denied(bundleId: string, name: string): string | undefined {
    const reason = denyReason(bundleId, undefined, this.own);
    if (reason) return reason;
    const lower = name.toLowerCase();
    return this.own.includes(lower) || lower.startsWith("pi-gna") ? "pi-gna and its helper are never operated by the agent" : undefined;
  }

  private refuseDenied(target: Target): void {
    const reason = this.denied(target.bundleId, target.name);
    if (reason) throw bridgeError(403, `${target.name} cannot be controlled: ${reason}.`);
  }

  private busy(handle: string, target: Target): void {
    const owner = this.locks.get(target.bundleId);
    if (owner && owner !== handle) throw bridgeError(409, `${target.name} is being used by another chat. Try again later or use a different app.`);
  }

  /** The user's decision for this chat and app. Chat-level calls are already serialized, so a second call for an
   * app waits for the first one's card and then finds its grant. */
  private async authorize(handle: string, session: Session, target: Target): Promise<void> {
    const refused = () => bridgeError(403, `The user did not allow ${target.name}.`);
    if (session.denied.has(target.bundleId)) throw refused();
    if (session.once.has(target.bundleId)) return;
    if ((await this.policy.get()).alwaysAllowed.some((app) => app.bundleId === target.bundleId)) return;
    const choice = await this.host.choose(handle, `pi wants to use ${target.name} (${target.bundleId}). It can read what is on screen and click and type in it.`, [ALLOW_ONCE, ALLOW_ALWAYS, DENY]);
    // The window may have turned Computer Use off or the chat may have ended while the card was open.
    if (!(await this.policy.get()).enabled) throw bridgeError(403, OFF);
    if (choice === ALLOW_ALWAYS) {
      try {
        await this.policy.apply({ type: "allow-always", bundleId: target.bundleId, name: target.name });
      } catch (error) {
        log.warn("computer", `could not store the grant for ${target.bundleId}: ${error instanceof Error ? error.message : String(error)}`);
        session.once.add(target.bundleId);
      }
    } else if (choice === ALLOW_ONCE) session.once.add(target.bundleId);
    else {
      session.denied.add(target.bundleId);
      throw refused();
    }
  }

  /** First action on an app in this run: show the overlay labelled with the chat's name. */
  private async begin(handle: string, session: Session, target: Target): Promise<void> {
    if (session.apps.has(target.bundleId) || !target.running) return;
    const label = (await this.host.chatName(handle).catch(() => undefined)) ?? "this chat";
    await this.service.call("overlay_show", { app: { bundleId: target.bundleId }, session_label: label, session: handle });
    session.apps.set(target.bundleId, { name: target.name });
  }

  /** Restart the idle timer of an app the chat holds. */
  private touch(handle: string, session: Session, bundleId: string): void {
    const held = session.apps.get(bundleId);
    if (!held) return;
    clearTimeout(held.idle);
    held.idle = setTimeout(() => {
      log.info("computer", `${handle.slice(0, 4)} idle on ${bundleId}, releasing`);
      this.free(handle, session, bundleId);
      void this.service.call("overlay_hide", { app: { bundleId } }).catch(() => undefined);
    }, this.idleMs);
    held.idle.unref?.();
  }

  private free(handle: string, session: Session, bundleId: string): void {
    clearTimeout(session.apps.get(bundleId)?.idle);
    session.apps.delete(bundleId);
    if (this.locks.get(bundleId) === handle) this.locks.delete(bundleId);
  }

  private async act(action: string, body: Record<string, unknown>, target: Target): Promise<ComputerResult> {
    const app = { bundleId: target.bundleId };
    const info = { name: target.name, bundleId: target.bundleId };
    let summary = "";
    if (action !== "get_app_state") {
      const params: Record<string, unknown> = { app };
      for (const key of ACTION_PARAMS[action] ?? []) {
        const value = body[key];
        if (value === undefined) continue;
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw bridgeError(400, `${key} must be a string, number or boolean`);
        params[key === "secondary_action" ? "action" : key] = value;
      }
      const result = await this.service.call(action as keyof ComputerMethods & "click", params as unknown as ComputerMethods["click"][0]);
      summary = `${action} done${result.method ? ` (${result.method})` : ""}${result.settled === false ? "; the app was still busy" : ""}.\n\n`;
    }
    const state = await this.service.call("get_app_state", { app, disable_diff: action === "get_app_state" ? body.disable_diff === true : undefined });
    const result: ComputerResult = { text: summary + state.text, app: info };
    // The window the tree came from, not the app's largest one (TextEdit with several documents shows the difference).
    if (action === "get_app_state" || body.screenshot === true) {
      try {
        result.image = (await this.service.call("screenshot", { app, window_id: state.windowId })).jpeg;
      } catch (error) {
        result.text += `\n(No screenshot: ${error instanceof Error ? error.message : String(error)})`;
      }
    }
    return result;
  }
}

/** POST /computer on the agent bridge: the computer_* tools. */
export function computerRoute(agent: () => ComputerAgent | undefined): Route {
  return async (handle, body) => {
    const current = agent();
    if (!current) throw bridgeError(503, "Computer Use is not ready");
    return current.run(handle, body);
  };
}
