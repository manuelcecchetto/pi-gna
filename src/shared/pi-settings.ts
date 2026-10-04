// The pi settings the Settings page edits, in pi's global settings.json (~/.pi/agent/settings.json, or
// $PI_CODING_AGENT_DIR). pi owns the file and reads it when a chat starts, so a change applies to new chats. Only
// these keys are ever written; everything else in the file is left as it is. A project's .pi/settings.json can
// override them for that project.
import { THINKING_LEVELS } from "./settings";

export type PiSetting =
  | { type: "boolean"; default: boolean }
  | { type: "integer"; default: number; min: number; max: number }
  | { type: "choice"; values: readonly string[]; default: string }
  /** No default: pi picks one itself (the default model is the last one you used in pi). */
  | { type: "text" };

const QUEUE_MODES = ["one-at-a-time", "all"] as const;

/** Keys as pi spells them, nested ones as "parent.child"; defaults as pi has them. */
export const PI_SETTINGS = {
  defaultProvider: { type: "text" },
  defaultModel: { type: "text" },
  defaultThinkingLevel: { type: "choice", values: THINKING_LEVELS, default: "medium" },
  steeringMode: { type: "choice", values: QUEUE_MODES, default: "one-at-a-time" },
  followUpMode: { type: "choice", values: QUEUE_MODES, default: "one-at-a-time" },
  "compaction.enabled": { type: "boolean", default: true },
  "compaction.reserveTokens": { type: "integer", default: 16384, min: 0, max: 1_000_000 },
  "compaction.keepRecentTokens": { type: "integer", default: 20000, min: 0, max: 1_000_000 },
  "retry.enabled": { type: "boolean", default: true },
  "retry.maxRetries": { type: "integer", default: 3, min: 0, max: 20 },
  "images.autoResize": { type: "boolean", default: true },
  "images.blockImages": { type: "boolean", default: false },
  defaultProjectTrust: { type: "choice", values: ["ask", "always", "never"], default: "ask" },
  enableSkillCommands: { type: "boolean", default: true },
  cacheWarming: { type: "choice", values: ["off", "streaming", "idle"], default: "streaming" },
} as const satisfies Record<string, PiSetting>;

export type PiKey = keyof typeof PI_SETTINGS;
export type PiValue = string | number | boolean;
/** The keys set in the file; a missing one is at pi's default. */
export type PiValues = Partial<Record<PiKey, PiValue>>;
/** null unsets a key, back to pi's default. */
export type PiPatch = Partial<Record<PiKey, PiValue | null>>;

/** pi's settings as the Settings page shows them. */
export interface PiSettingsState {
  /** The settings file, to show and open. */
  path: string;
  values: PiValues;
  /** Why the file cannot be read as settings (invalid JSON, say); nothing is written to it then. */
  problem?: string;
}

export const isPiKey = (key: unknown): key is PiKey => typeof key === "string" && Object.hasOwn(PI_SETTINGS, key);

const valid = (setting: PiSetting, value: unknown): value is PiValue => {
  switch (setting.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= setting.min && value <= setting.max;
    case "choice":
      return typeof value === "string" && setting.values.includes(value);
    case "text":
      return typeof value === "string" && value.trim() !== "" && value.length <= 200;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const path = (key: PiKey): [string, string | undefined] => {
  const [parent, child] = key.split(".") as [string, string | undefined];
  return [parent, child];
};

/** The editable keys set in a parsed settings file; values pi would not accept read as unset. */
export function readPiValues(raw: unknown): PiValues {
  const values: PiValues = {};
  if (!isObject(raw)) return values;
  for (const key of Object.keys(PI_SETTINGS) as PiKey[]) {
    const [parent, child] = path(key);
    const value = child === undefined ? raw[parent] : isObject(raw[parent]) ? raw[parent][child] : undefined;
    if (valid(PI_SETTINGS[key], value)) values[key] = value;
  }
  return values;
}

/** The file with the patch applied: a new object, the rest of the file untouched. Throws for an unknown key or a
 * value pi would not accept, and rather than replace a parent that is not an object. */
export function patchPiSettings(raw: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  if (!isObject(patch)) throw new Error("a settings change is an object");
  const next: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(patch)) {
    if (!isPiKey(key)) throw new Error(`pi-gna does not change ${key}`);
    if (value !== null && !valid(PI_SETTINGS[key], value)) throw new Error(`${key} cannot be ${JSON.stringify(value)}`);
    const [parent, child] = path(key);
    if (child === undefined) {
      if (value === null) delete next[parent];
      else next[parent] = value;
      continue;
    }
    if (value === null && next[parent] === undefined) continue;
    if (next[parent] !== undefined && !isObject(next[parent])) throw new Error(`${parent} in pi's settings is not an object`);
    const group: Record<string, unknown> = { ...((next[parent] as Record<string, unknown> | undefined) ?? {}) };
    if (value === null) delete group[child];
    else group[child] = value;
    next[parent] = group;
  }
  return next;
}
