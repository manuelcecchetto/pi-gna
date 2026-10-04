import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "./settings";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pigna-settings-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("refuses a feature's bridge route while it is off, for chats that still have its tools", async () => {
    const changed = vi.fn();
    const settings = new SettingsStore(join(dir, "settings.json"), changed);
    const route = vi.fn(async () => ({ text: "ok" }));
    const gated = settings.gate("kanban", route);
    expect(await gated("h", { title: "x" })).toEqual({ text: "ok" });

    await settings.apply({ type: "feature", feature: "kanban", enabled: false });
    expect(changed).toHaveBeenCalledOnce();
    await expect(gated("h", {})).rejects.toMatchObject({ status: 403, message: "Kanban is turned off in pi-gna's Settings" });
    expect(route).toHaveBeenCalledOnce();

    await settings.flushed();
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).features.kanban).toBe(false);
    expect((await new SettingsStore(join(dir, "settings.json"), vi.fn()).get()).features.kanban).toBe(false);
  });

  it("counts changes, and refuses a stale theme edit but not a stale switch", async () => {
    const settings = new SettingsStore(join(dir, "settings.json"), vi.fn());
    await settings.apply({ type: "theme", theme: "dark" });
    await settings.apply({ type: "theme", theme: "dark" }); // no change: no rev
    expect((await settings.get()).rev).toBe(1);
    await expect(settings.apply({ type: "theme", theme: "light" }, 0)).rejects.toMatchObject({ code: "conflict", detail: { rev: 1 } });
    await settings.apply({ type: "visuals", on: true }, 0);
    await settings.apply({ type: "theme", theme: "light" }, 2);
    expect(await settings.get()).toMatchObject({ rev: 3, theme: "light", visuals: true });
    await settings.flushed();
  });
});
