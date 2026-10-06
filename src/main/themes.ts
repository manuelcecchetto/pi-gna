// Custom themes on disk (userData/themes.json, src/shared/themes.ts), POST /theme on the agent bridge (the set_theme
// tool) and the images a theme names. The calling chat is the session behind the token; its project is projectOf its
// cwd (a card's worktree counts as its project). A theme's images are files inside its project: main checks the real
// path when the theme is set and again when it reads one, and the window gets them as data: URLs (its CSP has no
// file access).
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { projectOf } from "../shared/board";
import { applySettingsOp, type Settings, type SettingsOp } from "../shared/settings";
import {
  applyThemeOp,
  emptyThemes,
  effectiveTheme,
  IMAGE_MAX_BYTES,
  imagePathError,
  parseThemes,
  scopeTheme,
  ThemeError,
  type ThemeOp,
  type ThemeRequest,
  type ThemeResponse,
  type Themes,
  type ThemeScope,
  type ThemeSpec,
} from "../shared/themes";
import type { Revved } from "../shared/host-api";
import { bridgeError, type Route } from "./bridge";
import type { SettingsStore } from "./settings";
import { JsonStore } from "./store";

export class ThemeStore extends JsonStore<Themes, ThemeOp> {
  constructor(file: string, changed: (themes: Revved<Themes>) => void) {
    const parse = (raw: unknown) => {
      const { themes, dropped } = parseThemes(raw);
      return { value: themes, dropped };
    };
    super(file, { name: "themes", item: "theme", empty: emptyThemes, apply: applyThemeOp, parse }, changed);
  }
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif" };

/** The real file behind a theme image path, after checking it is an image inside the project and small enough. */
export async function themeImageFile(project: string, path: string, kind: keyof typeof IMAGE_MAX_BYTES): Promise<string> {
  const error = imagePathError(path);
  if (error) throw new ThemeError(`${kind}: ${error}`);
  let root: string;
  let file: string;
  try {
    root = await realpath(project);
    file = await realpath(join(project, path));
  } catch {
    throw new ThemeError(`${kind}: there is no ${path} in ${project}`);
  }
  if (!file.startsWith(root + sep)) throw new ThemeError(`${kind}: ${path} leaves the project (it links outside ${project})`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ThemeError(`${kind}: ${path} is not a file`);
    if (info.size > IMAGE_MAX_BYTES[kind]) throw new ThemeError(`${kind}: ${path} is ${Math.round(info.size / 1024)} KB, over ${IMAGE_MAX_BYTES[kind] / 1024 / 1024} MB`);
  } finally {
    await handle.close();
  }
  return file;
}

/** A project theme's wallpaper or logo as a data: URL, or null when the theme has none or its file is gone. */
export async function themeImage(themes: Themes, project: string, kind: "wallpaper" | "logo"): Promise<string | null> {
  const theme = themes.projects[project];
  const path = kind === "logo" ? theme?.logo?.path : theme?.wallpaper && "path" in theme.wallpaper ? theme.wallpaper.path : undefined;
  if (!path) return null;
  try {
    const file = await themeImageFile(project, path, kind);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > IMAGE_MAX_BYTES[kind]) return null;
      // Check the path again after opening, and read the descriptor rather than reopening a symlink.
      if (await realpath(join(project, path)) !== file) return null;
      const buffer = Buffer.alloc(info.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > info.size) return null; // grew during the read; retry on the next request
      return `data:${MIME[extname(path).toLowerCase()]};base64,${buffer.subarray(0, total).toString("base64")}`;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Checks the images a project theme names exist (set time: the agent learns at once). */
async function checkImages(project: string, theme: ThemeSpec): Promise<void> {
  if (theme.wallpaper && "path" in theme.wallpaper) await themeImageFile(project, theme.wallpaper.path, "wallpaper");
  if (theme.logo) await themeImageFile(project, theme.logo.path, "logo");
}

/** Applies a change from the window or the agent: a project theme's images must exist inside the project. */
export async function applyTheme(store: ThemeStore, op: ThemeOp, baseRev?: number): Promise<Revved<Themes>> {
  if (op?.type === "set" && op.scope !== "global") {
    const merged = applyThemeOp(await store.get(), op);
    await checkImages(op.scope.project, scopeTheme(merged, op.scope));
  }
  return store.apply(op, baseRev);
}

/** A set_theme patch for the global scope: its mode and built-in wallpaper are settings; the rest is the global theme. */
function globalSettingsOps(patch: Record<string, unknown>, settings: Settings): { ops: SettingsOp[]; rest: Record<string, unknown> } {
  if ("logo" in patch) throw new ThemeError('a logo belongs to a project: use scope "project"');
  for (const key of Object.keys(patch)) if (!["preset", "base", "wallpaper", "font", "colors"].includes(key)) throw new ThemeError(`unknown field ${key} (expected base, wallpaper, font, colors)`);
  const { base, wallpaper, ...rest } = patch;
  const ops: SettingsOp[] = [];
  if (base !== undefined) ops.push({ type: "theme", theme: base === null ? "system" : (base as Settings["theme"]) });
  if (wallpaper !== undefined) {
    const checked = applyThemeOp({ version: 1, global: {}, projects: {} }, { type: "set", scope: { project: "/validation" }, patch: { wallpaper } });
    const next = checked.projects["/validation"]?.wallpaper;
    if (next && !("builtin" in next)) throw new ThemeError('the global wallpaper must be built in: "none" or { "builtin": "<id>" } (an image path needs scope "project")');
    // An empty object omits every field; null at either level resets the wallpaper.
    if (next || wallpaper === null || (typeof wallpaper === "object" && Object.values(wallpaper).includes(null))) {
      ops.push({ type: "wallpaper", wallpaper: next && "builtin" in next ? next.builtin : "sky" });
    }
  }
  // Check every settings op before applying any, so a bad call changes nothing.
  ops.reduce((current, op) => {
    try {
      return applySettingsOp(current, op);
    } catch (error) {
      throw new ThemeError((error as Error).message);
    }
  }, settings);
  return { ops, rest };
}

/** The full theme of a scope, as the tool reports it back. */
function describe(scope: ThemeScope, themes: Themes, settings: Settings): string {
  return JSON.stringify({ scope: scope === "global" ? "global" : "project", ...effectiveTheme(themes, settings, scope === "global" ? undefined : scope.project) }, null, 2);
}

export function themeRoute(store: ThemeStore, settings: SettingsStore, cwdOf: (handle: string) => Promise<string>): Route {
  return async (handle, body): Promise<ThemeResponse> => {
    const { scope: scopeName = "project", ...patch } = (body ?? {}) as ThemeRequest;
    if (scopeName !== "project" && scopeName !== "global") throw bridgeError(400, 'scope must be "project" or "global"');
    const project = projectOf(await cwdOf(handle));
    const scope: ThemeScope = scopeName === "global" ? "global" : { project };
    try {
      if (Object.keys(patch).length) {
        if (scope === "global") {
          const { ops, rest } = globalSettingsOps(patch, await settings.get());
          if (Object.keys(rest).length) await store.apply({ type: "set", scope, patch: rest });
          for (const op of ops) await settings.apply(op);
        } else {
          await applyTheme(store, { type: "set", scope, patch });
        }
      }
    } catch (error) {
      if (error instanceof ThemeError) throw bridgeError(400, `${error.message}. Nothing was changed.`);
      throw error;
    }
    const where = scope === "global" ? "every project without its own value" : project;
    const verb = Object.keys(patch).length ? "Applied. The theme" : "The theme";
    return { text: `${verb} of ${scope === "global" ? "pi-gna" : "this project"} (used for ${where}) is now:\n${describe(scope, await store.get(), await settings.get())}` };
  };
}
