// pi-gna's own settings (userData/settings.json): which optional features are on, the window's appearance and the
// models pi-gna starts its own chats on (card triage, ATP). Main owns the file and applies every change through
// applySettingsOp, so every field is checked. pi's settings stay in pi's settings.json (src/shared/pi-settings.ts),
// and Computer Use keeps its own on/off switch with its policy (computer-use.json).
import type { ThinkingLevel } from "./protocol";

/** Features you can turn off: off hides their pages and menus, and new chats get none of their tools. */
export const FEATURES = ["kanban", "laments", "github", "atp"] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Readonly<Record<Feature, string>> = { kanban: "Kanban", laments: "Laments", github: "GitHub", atp: "ATP" };

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The empty state's backdrop, each a 🤌 in another form, painted at dusk (dark) and by day (light); none leaves the
 * canvas plain. The renderer maps each to its images (lib/wallpapers.ts). */
export const WALLPAPERS = ["sky", "stars", "peak", "pines", "shadow", "ink", "fresco", "none"] as const;
export type Wallpaper = (typeof WALLPAPERS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/** The model a chat pi-gna starts runs on, for that chat only. Without a provider, the chat's own one if it has the
 * model, else any that does. */
export interface TaskModel {
  provider?: string;
  id: string;
  thinking: ThinkingLevel;
}

/** The chats pi-gna starts itself. */
export const TASKS = ["triage", "orchestrator", "worker"] as const;
export type Task = (typeof TASKS)[number];

export const TASK_DEFAULTS: Readonly<Record<Task, TaskModel>> = {
  /** Names, tags and briefly investigates every card you add: quick and cheap, since it runs for each one. */
  triage: { id: "claude-sonnet-5-5", thinking: "low" },
  /** Writes and replans ATP plans with you. */
  orchestrator: { id: "gpt-5.6-sol", thinking: "high" },
  /** Runs one ATP node per chat. */
  worker: { id: "claude-sonnet-5-5", thinking: "medium" },
};

export interface Settings {
  version: 1;
  features: Record<Feature, boolean>;
  theme: Theme;
  wallpaper: Wallpaper;
  /** Each new empty state shows the next wallpaper, from the one picked, instead of always that one. */
  wallpaperLoop: boolean;
  /** Beta: agents may add small sandboxed HTML visuals to replies. Read when a chat starts. */
  visuals: boolean;
  /** Tasks whose model you changed; the others use TASK_DEFAULTS. */
  models: Partial<Record<Task, TaskModel>>;
}

export type SettingsOp =
  | { type: "feature"; feature: Feature; enabled: boolean }
  | { type: "theme"; theme: Theme }
  | { type: "wallpaper"; wallpaper: Wallpaper }
  | { type: "wallpaperLoop"; loop: boolean }
  | { type: "visuals"; on: boolean }
  /** null: back to the default. */
  | { type: "model"; task: Task; model: TaskModel | null };

/** The sections of the Settings page; main opens it at one (View > Computer Use). */
export const SETTINGS_SECTIONS = ["general", "appearance", "shortcuts", "providers", "models", "agent", "features", "computer"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const isSettingsSection = (value: unknown): value is SettingsSection => SETTINGS_SECTIONS.includes(value as SettingsSection);

export class SettingsError extends Error {}

export const emptySettings = (): Settings => ({
  version: 1,
  features: Object.fromEntries(FEATURES.map((feature) => [feature, true])) as Record<Feature, boolean>,
  theme: "system",
  wallpaper: "sky",
  wallpaperLoop: false,
  visuals: false,
  models: {},
});

const NAME = 200;
const isName = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= NAME;

/** A valid model, or undefined. */
function taskModelOf(raw: unknown): TaskModel | undefined {
  const model = raw as Partial<TaskModel> | null;
  if (!model || typeof model !== "object" || !isName(model.id) || !THINKING_LEVELS.includes(model.thinking as ThinkingLevel)) return undefined;
  if (model.provider !== undefined && !isName(model.provider)) return undefined;
  return { ...(model.provider !== undefined && { provider: model.provider }), id: model.id, thinking: model.thinking as ThinkingLevel };
}

/** The model a task runs on: yours, else its default. */
export const taskModel = (settings: Settings, task: Task): TaskModel => settings.models[task] ?? TASK_DEFAULTS[task];

const sameModel = (a: TaskModel | undefined, b: TaskModel | undefined) => a?.provider === b?.provider && a?.id === b?.id && a?.thinking === b?.thinking;

/** Returns the same value when nothing changes; throws SettingsError for an invalid op. */
export function applySettingsOp(settings: Settings, op: SettingsOp): Settings {
  switch (op?.type) {
    case "feature": {
      if (!FEATURES.includes(op.feature) || typeof op.enabled !== "boolean") throw new SettingsError(`cannot turn ${String(op.feature)} ${String(op.enabled)}`);
      if (settings.features[op.feature] === op.enabled) return settings;
      return { ...settings, features: { ...settings.features, [op.feature]: op.enabled } };
    }
    case "theme": {
      if (!THEMES.includes(op.theme)) throw new SettingsError(`unknown theme ${String(op.theme)}`);
      return settings.theme === op.theme ? settings : { ...settings, theme: op.theme };
    }
    case "wallpaper": {
      if (!WALLPAPERS.includes(op.wallpaper)) throw new SettingsError(`unknown wallpaper ${String(op.wallpaper)}`);
      return settings.wallpaper === op.wallpaper ? settings : { ...settings, wallpaper: op.wallpaper };
    }
    case "wallpaperLoop": {
      if (typeof op.loop !== "boolean") throw new SettingsError(`cannot loop wallpapers ${String(op.loop)}`);
      return settings.wallpaperLoop === op.loop ? settings : { ...settings, wallpaperLoop: op.loop };
    }
    case "visuals": {
      if (typeof op.on !== "boolean") throw new SettingsError(`cannot turn visuals ${String(op.on)}`);
      return settings.visuals === op.on ? settings : { ...settings, visuals: op.on };
    }
    case "model": {
      if (!TASKS.includes(op.task)) throw new SettingsError(`unknown task ${String(op.task)}`);
      const model = op.model === null ? undefined : taskModelOf(op.model);
      if (op.model !== null && !model) throw new SettingsError("a model needs an id and a thinking level");
      if (sameModel(settings.models[op.task], model)) return settings;
      const { [op.task]: _, ...models } = settings.models;
      return { ...settings, models: model ? { ...models, [op.task]: model } : models };
    }
    default:
      throw new SettingsError(`unknown settings change ${String((op as { type?: unknown } | null)?.type)}`);
  }
}

/** Lenient: what is missing or malformed falls back to its default (counted in `dropped`); throws when it is no
 * settings file at all. */
export function parseSettings(raw: unknown): { settings: Settings; dropped: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsError("not an object");
  const file = raw as Partial<Record<keyof Settings, unknown>>;
  const settings = emptySettings();
  let dropped = 0;
  const features = (file.features ?? {}) as Record<string, unknown>;
  for (const feature of FEATURES) {
    const value = features[feature];
    if (typeof value === "boolean") settings.features[feature] = value;
    else if (value !== undefined) dropped++;
  }
  if (THEMES.includes(file.theme as Theme)) settings.theme = file.theme as Theme;
  else if (file.theme !== undefined) dropped++;
  if (WALLPAPERS.includes(file.wallpaper as Wallpaper)) settings.wallpaper = file.wallpaper as Wallpaper;
  else if (file.wallpaper !== undefined) dropped++;
  if (typeof file.wallpaperLoop === "boolean") settings.wallpaperLoop = file.wallpaperLoop;
  else if (file.wallpaperLoop !== undefined) dropped++;
  if (typeof file.visuals === "boolean") settings.visuals = file.visuals;
  else if (file.visuals !== undefined) dropped++;
  const models = (file.models ?? {}) as Record<string, unknown>;
  for (const task of TASKS) {
    if (models[task] === undefined) continue;
    const model = taskModelOf(models[task]);
    if (model) settings.models[task] = model;
    else dropped++;
  }
  return { settings, dropped };
}
