// What the phone's composer needs from pi besides the session reducer's state: models, thinking levels, slash
// commands, session stats and the compaction settings, all read through the host (`chat.command` allowlist) and the
// file list for @ mentions (`chat.files`). The reads are plain async functions so a fake call can test them.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompactionSettings } from "../shared/compaction";
import { fastCommand } from "../shared/fast";
import type { Model, RpcCommand, RpcResponse, RpcSessionState, SessionStats, SlashCommand, ThinkingLevel } from "../shared/protocol";
import type { SessionState } from "../shared/session-state";
import type { HostClient } from "./client/host-client";
import { toast } from "./toasts";

export type RpcCall = (command: RpcCommand) => Promise<RpcResponse>;

const read = async <T>(call: RpcCall, command: RpcCommand): Promise<T | undefined> => {
  try {
    const response = await call(command);
    return response.success ? (response.data as T) : undefined;
  } catch {
    return undefined;
  }
};

export const loadCommands = async (call: RpcCall) => (await read<{ commands: SlashCommand[] }>(call, { type: "get_commands" }))?.commands;
export const loadLevels = async (call: RpcCall) => (await read<{ levels: ThinkingLevel[] }>(call, { type: "get_available_thinking_levels" }))?.levels;
export const loadModels = async (call: RpcCall) => (await read<{ models: Model[] }>(call, { type: "get_available_models" }))?.models;
export const loadStats = (call: RpcCall) => read<SessionStats>(call, { type: "get_session_stats" });
export const loadState = (call: RpcCall) => read<RpcSessionState>(call, { type: "get_state" });

/** Switch model: the levels a model offers differ, so they and the thinking level are read again. */
export async function switchModel(call: RpcCall, model: Model): Promise<{ ok: true; model: Model; levels?: ThinkingLevel[]; thinkingLevel?: ThinkingLevel } | { ok: false; error: string }> {
  const response = await call({ type: "set_model", provider: model.provider, modelId: model.id });
  if (!response.success) return { ok: false, error: response.error ?? "pi refused the model" };
  const [levels, state] = await Promise.all([loadLevels(call), loadState(call)]);
  return { ok: true, model: (response.data as Model | undefined) ?? model, levels, thinkingLevel: state?.thinkingLevel };
}

/** Whether the level picker has anything to offer (a model without reasoning only has "off"). */
export const hasLevels = (levels: ThinkingLevel[] | undefined): levels is ThinkingLevel[] => Boolean(levels && !(levels.length === 1 && levels[0] === "off"));

const models = new WeakMap<HostClient, Model[]>();
const fileLists = new Map<string, { at: number; list: Promise<string[]> }>();
const FILES_TTL_MS = 15_000;

/** The project's files for @ mentions, listed on the host and kept for a few seconds. */
export function projectFiles(client: HostClient, cwd: string, now = Date.now()): Promise<string[]> {
  const key = cwd;
  const cached = fileLists.get(key);
  if (cached && now - cached.at < FILES_TTL_MS) return cached.list;
  const list = client.call("chat.files", { cwd }).catch((): string[] => []);
  fileLists.set(key, { at: now, list });
  return list;
}

/** Until the host answers: pi's built-in reserve applies. */
const NO_SETTINGS: CompactionSettings = {};

export interface ComposerData {
  commands: SlashCommand[];
  levels: ThinkingLevel[] | undefined;
  models: Model[];
  /** The session with the stats and the model or thinking level this phone just set. */
  session: SessionState;
  compaction: CompactionSettings;
  pickModel(model: Model): Promise<void>;
  pickThinking(level: ThinkingLevel): Promise<void>;
  /** Fast mode through the /fast extension command; its status (`fast`) updates the session. */
  setFast(on: boolean): Promise<void>;
  compactNow(): Promise<void>;
}

/** Loads what the composer shows for a chat and keeps stats fresh as runs and compactions end. */
export function useComposerData(client: HostClient, session: SessionState): ComposerData {
  const { handle } = session;
  const call = useCallback<RpcCall>((command) => client.call("chat.command", { handle, command }), [client, handle]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [levels, setLevels] = useState<ThinkingLevel[]>();
  const [modelList, setModelList] = useState<Model[]>(() => models.get(client) ?? []);
  const [stats, setStats] = useState<SessionStats>();
  const [compaction, setCompaction] = useState(NO_SETTINGS);
  const [chosen, setChosen] = useState<{ model?: Model; thinkingLevel?: ThinkingLevel }>({});
  const ready = session.phase === "ready";

  useEffect(() => {
    setChosen({});
    setStats(undefined);
  }, [handle]);

  // Once per chat that is ready: the lists, and the settings behind the context meter.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void (async () => {
      const [found, offered, all, settings] = await Promise.all([
        loadCommands(call),
        loadLevels(call),
        models.has(client) ? undefined : loadModels(call),
        client.call("chat.compactionSettings", {}).catch(() => undefined),
      ]);
      if (!alive) return;
      if (found) setCommands(found);
      if (offered) setLevels(offered);
      if (all) {
        models.set(client, all);
        setModelList(all);
      }
      if (settings) setCompaction(settings);
    })();
    return () => {
      alive = false;
    };
  }, [client, call, ready]);

  // Stats on opening, running or not, and whenever a run or a compaction starts or ends.
  const busy = session.running || Boolean(session.compacting);
  const statsRead = useRef(0);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const read = ++statsRead.current;
    void Promise.all([loadStats(call), loadState(call)]).then(([next, state]) => {
      if (!alive) return;
      if (next && read === statsRead.current) setStats(next);
      if (state) setChosen((current) => ({ model: state.model ?? current.model, thinkingLevel: state.thinkingLevel }));
    });
    return () => {
      alive = false;
    };
  }, [call, ready, busy]);

  // During a run too, as on the desktop: context grows every turn and shrinks on compaction (get_session_stats is cheap).
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = client.onChatEvent((from, event) => {
      if (from !== handle || event.kind !== "rpc" || (event.record.type !== "turn_end" && event.record.type !== "compaction_end")) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const read = ++statsRead.current;
        void loadStats(call).then((next) => next && read === statsRead.current && setStats(next));
      }, 300);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [client, call, handle, ready]);

  const fail = (what: string, error: string) => toast(`${what}: ${error}`, "error");

  const pickModel = async (model: Model) => {
    const result = await switchModel(call, model).catch((error): { ok: false; error: string } => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (!result.ok) return fail("Could not switch model", result.error);
    if (result.levels) setLevels(result.levels);
    setChosen({ model: result.model, thinkingLevel: result.thinkingLevel });
  };

  const pickThinking = async (level: ThinkingLevel) => {
    try {
      const response = await call({ type: "set_thinking_level", level });
      if (response.success) setChosen((current) => ({ ...current, thinkingLevel: level }));
      else fail("Could not set thinking", response.error ?? "pi refused");
    } catch (error) {
      fail("Could not set thinking", error instanceof Error ? error.message : String(error));
    }
  };

  const setFast = async (on: boolean) => {
    try {
      const response = await call({ type: "prompt", message: fastCommand(on, commands) });
      if (!response.success) fail("Could not switch fast mode", response.error ?? "pi refused");
    } catch (error) {
      fail("Could not switch fast mode", error instanceof Error ? error.message : String(error));
    }
  };

  const compactNow = async () => {
    try {
      const response = await call({ type: "compact" });
      if (!response.success) fail("Could not compact", response.error ?? "pi refused");
    } catch (error) {
      fail("Could not compact", error instanceof Error ? error.message : String(error));
    }
  };

  const shown: SessionState = { ...session, stats: stats ?? session.stats, model: chosen.model ?? session.model, thinkingLevel: chosen.thinkingLevel ?? session.thinkingLevel };
  return { commands, levels, models: modelList, session: shown, compaction, pickModel, pickThinking, setFast, compactNow };
}
