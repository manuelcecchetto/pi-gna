// The real HTTP routes and stores with host-native paths, not just POSIX-only reducer fixtures.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BoardStore } from "./board";
import { AgentBridge } from "./bridge";
import { kanbanRoute } from "./kanban";
import { LamentStore, lamentRoute } from "./laments";
import { SettingsStore } from "./settings";
import { ThemeStore, themeRoute } from "./themes";

it("claims/reports cards, files laments and restores project themes through the authenticated bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigna project state ü-"));
  const cwd = join(dir, "Project with spaces ü");
  await mkdir(cwd);
  const chat = { cwd, path: join(dir, "sessions", "one.jsonl") };
  const identify = async (handle: string) => handle === "own" ? chat : { cwd: join(dir, "other"), path: join(dir, "sessions", "two.jsonl") };
  const board = new BoardStore(join(dir, "board.json"), () => undefined);
  const laments = new LamentStore(join(dir, "laments.json"), () => undefined);
  const themes = new ThemeStore(join(dir, "themes.json"), () => undefined);
  const settings = new SettingsStore(join(dir, "settings.json"), () => undefined);
  const stores = [board, laments, themes, settings];
  const bridge = new AgentBridge();
  bridge.route("/kanban", kanbanRoute(board, identify));
  bridge.route("/lament", lamentRoute(laments, identify));
  bridge.route("/theme", themeRoute(themes, settings, async (handle) => (await identify(handle)).cwd));
  await bridge.start();
  const own = bridge.register("own"), other = bridge.register("other");
  const post = (route: string, body: object, token = own) => fetch(`${bridge.url}/${route}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  try {
    const claim = await post("kanban", { action: "claim", title: "Windows port", column: "in_progress", cwd: "/ignored-client-cwd" });
    expect(claim.status).toBe(200);
    const card = (await claim.json() as { card: string }).card;
    expect(card).toMatch(/^[a-z0-9]{6}$/);
    expect((await post("kanban", { action: "update", card, report: "Verified on native paths", column: "in_review" })).status).toBe(200);
    // A second token cannot claim/read/change this project's card, even by spoofing cwd in its request.
    for (const action of ["claim", "list", "update"]) expect((await post("kanban", { action, card, cwd, report: "spoof" }, other)).status).toBe(404);
    const filed = await post("lament", { title: "Windows Kanban paths", body: "A reproducible path rejection", severity: "blocking" });
    expect(filed.status).toBe(200);
    const lament = (await filed.json() as { lament: string }).lament;
    expect((await post("lament", { repeats: lament, body: "Repeated", severity: "costly" })).status).toBe(200);
    expect((await post("lament", { repeats: lament, body: "Spoofed", severity: "costly", cwd }, other)).status).toBe(404);
    expect((await post("theme", { base: "dark" })).status).toBe(200);
    await Promise.all(stores.map((store) => store.flushed()));
    const restored = await new BoardStore(join(dir, "board.json"), () => undefined).get();
    expect(restored.cards).toMatchObject([{ id: card, cwd, column: "in_review", chats: [{ ...chat }], reports: [{ text: "Verified on native paths", chat: chat.path }] }]);
    expect((await new LamentStore(join(dir, "laments.json"), () => undefined).get()).laments).toMatchObject([{ id: lament, cwd, reports: [{ chat }, { chat }] }]);
    expect((await new ThemeStore(join(dir, "themes.json"), () => undefined).get()).projects[cwd]).toEqual({ base: "dark" });
    bridge.unregister("own");
    expect((await post("kanban", { action: "list" })).status).toBe(401);
  } finally {
    bridge.stop();
    await Promise.all(stores.map((store) => store.flushed()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
