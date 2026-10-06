import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { worktreeCwd } from "../shared/board";
import { SettingsStore } from "./settings";
import { applyTheme, ThemeStore, themeImage, themeRoute } from "./themes";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const text = (result: unknown) => (result as { text: string }).text;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pigna-themes-"));
  const project = join(dir, "repo");
  await mkdir(join(project, "assets"), { recursive: true });
  await writeFile(join(project, "assets", "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(dir, "outside.png"), "png");
  await symlink(join(dir, "outside.png"), join(project, "assets", "escape.png"));
  const pushed: unknown[] = [];
  const store = new ThemeStore(join(dir, "themes.json"), (themes) => pushed.push(themes));
  const settings = new SettingsStore(join(dir, "settings.json"), () => undefined);
  let cwd = project;
  const route = themeRoute(store, settings, async () => cwd);
  return { dir, project, store, settings, route, pushed, chatIn: (next: string) => (cwd = next) };
}

describe("POST /theme", () => {
  it("accepts global presets, persists them, and rejects invalid presets atomically", async () => {
    const { store, settings, route, dir } = await setup();
    await route("h", { scope: "global", preset: "aurora" });
    expect((await store.get()).global).toEqual({ preset: "aurora" });
    await store.flushed();
    expect(JSON.parse(await readFile(join(dir, "themes.json"), "utf8")).global.preset).toBe("aurora");
    await expect(route("h", { scope: "global", preset: "nope", base: "dark" })).rejects.toMatchObject({ status: 400 });
    expect((await settings.get()).theme).toBe("system");
    expect((await store.get()).global.preset).toBe("aurora");
  });

  it("merges a project patch, saves and pushes it, and replies with the whole theme", async () => {
    const { dir, project, store, route, pushed } = await setup();
    await route("h", { base: "dark", colors: { dark: { primary: "#4f46e5" } }, logo: { path: "assets/logo.svg" } });
    const result = await route("h", { colors: { dark: { fg: "#e5e7eb" } } });
    expect(JSON.parse(text(result).slice(text(result).indexOf("{")))).toEqual({
      scope: "project",
      project,
      base: "dark",
      font: {},
      wallpaper: { builtin: "sky" },
      colors: { light: {}, dark: { primary: "#4f46e5", fg: "#e5e7eb" } },
      logo: { path: "assets/logo.svg" },
    });
    expect(pushed).toHaveLength(2);
    await store.flushed();
    expect(JSON.parse(await readFile(join(dir, "themes.json"), "utf8")).projects[project].base).toBe("dark");
  });

  it("reads the theme when called without fields, and themes a card worktree's project", async () => {
    const { project, route, chatIn } = await setup();
    chatIn(worktreeCwd("/Users/me", "abc123", project));
    await route("h", { base: "light" });
    expect(text(await route("h", {}))).toContain(`"project": "${project}"`);
    expect(text(await route("h", {}))).toContain('"base": "light"');
  });

  it("refuses images that are missing, outside the project or too far, and changes nothing", async () => {
    const { store, route } = await setup();
    await expect(route("h", { base: "dark", logo: { path: "assets/missing.png" } })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/no assets\/missing\.png.*Nothing was changed/) });
    await expect(route("h", { logo: { path: "assets/escape.png" } })).rejects.toMatchObject({ message: expect.stringMatching(/leaves the project/) });
    await expect(route("h", { wallpaper: { path: "../outside.png" } })).rejects.toMatchObject({ message: expect.stringMatching(/leaves the project/) });
    await expect(route("h", { colors: { light: { primary: "red;}" } } })).rejects.toMatchObject({ message: expect.stringMatching(/not a color/) });
    expect((await store.get()).projects).toEqual({});
  });

  it("puts the global mode and wallpaper in the settings and the rest in the global theme", async () => {
    const { store, settings, route } = await setup();
    const result = await route("h", { scope: "global", base: "light", wallpaper: { builtin: "ink" }, font: { ui: "Inter" } });
    expect(await settings.get()).toMatchObject({ theme: "light", wallpaper: "ink" });
    expect((await store.get()).global).toEqual({ font: { ui: "Inter" } });
    expect(text(result)).toContain('"wallpaper": {\n    "builtin": "ink"');
    await expect(route("h", { scope: "global", logo: { path: "assets/logo.svg" } })).rejects.toMatchObject({ message: expect.stringMatching(/belongs to a project/) });
    await expect(route("h", { scope: "global", base: "sepia", font: { ui: "Menlo" } })).rejects.toMatchObject({ message: expect.stringMatching(/unknown theme sepia/) });
    await expect(route("h", { scope: "global", surprise: true })).rejects.toMatchObject({ message: expect.stringMatching(/unknown field surprise/) });
    await expect(route("h", { scope: "global", wallpaper: { builtin: "ink", path: "ignored.png" } })).rejects.toMatchObject({ message: expect.stringMatching(/unknown field/) });
    expect((await store.get()).global).toEqual({ font: { ui: "Inter" } });
    await route("h", { scope: "global", wallpaper: {} });
    expect((await settings.get()).wallpaper).toBe("ink");
    await route("h", { scope: "global", wallpaper: { builtin: null } });
    expect((await settings.get()).wallpaper).toBe("sky");
  });
});

describe("theme images", () => {
  it("reads a project's logo as a data URL, and nothing for a file gone since", async () => {
    const { project, store } = await setup();
    await applyTheme(store, { type: "set", scope: { project }, patch: { logo: { path: "assets/logo.svg" } } });
    expect(await themeImage(await store.get(), project, "logo")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await themeImage(await store.get(), project, "wallpaper")).toBeNull();
    await writeFile(join(project, "assets", "logo.svg"), "x".repeat(3 * 1024 * 1024));
    expect(await themeImage(await store.get(), project, "logo")).toBeNull();
  });
});
