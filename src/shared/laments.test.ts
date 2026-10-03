import { describe, expect, it } from "vitest";
import { applyLamentOp, emptyLaments, LAMENT_LIMITS, LamentError, type LamentOp, lamentSeverity, type Laments, parseLaments, projectLaments } from "./laments";

const run = (ops: LamentOp[], laments: Laments = emptyLaments()) => ops.reduce((current, op, index) => applyLamentOp(current, op, 1000 + index), laments);
const chat = { path: "/s/chat.jsonl", cwd: "/repo" };
const file = (id: string, severity: "annoying" | "costly" | "blocking" = "annoying", cwd = "/repo"): LamentOp => ({
  type: "file",
  id,
  title: `Missing ${id}`,
  text: "No tool for it; did it by hand.",
  severity,
  cwd,
  chat,
});

describe("lament ops", () => {
  it("files a lament on its project's board with the chat that filed it", () => {
    const laments = applyLamentOp(emptyLaments(), { type: "file", title: "  No tab\n recorder ", text: " body ", severity: "costly", cwd: "/repo", chat }, 5);
    expect(laments.laments).toHaveLength(1);
    expect(laments.laments[0]).toMatchObject({ title: "No tab recorder", cwd: "/repo", createdAt: 5, updatedAt: 5, reports: [{ at: 5, text: "body", severity: "costly", chat }] });
    expect(laments.laments[0]?.id).toMatch(/^[a-z0-9]{6}$/);
  });

  it("is as bad as its worst report, and a repeat reopens a resolved lament", () => {
    let laments = run([file("aaaaaa", "costly"), { type: "resolve", id: "aaaaaa", resolved: true }]);
    expect(laments.laments[0]?.resolvedAt).toBe(1001);
    laments = run([{ type: "repeat", id: "aaaaaa", text: "Again", severity: "annoying" }], laments);
    const lament = laments.laments[0];
    expect(lament?.resolvedAt).toBeUndefined();
    expect(lament?.reports.map((report) => report.severity)).toEqual(["costly", "annoying"]);
    expect(lament && lamentSeverity(lament)).toBe("costly");
    laments = run([{ type: "repeat", id: "aaaaaa", text: "Now it blocks", severity: "blocking" }], laments);
    expect(laments.laments[0] && lamentSeverity(laments.laments[0])).toBe("blocking");
  });

  it("keeps the first report and the latest ones", () => {
    const repeats: LamentOp[] = Array.from({ length: LAMENT_LIMITS.reports + 5 }, (_, index) => ({ type: "repeat", id: "aaaaaa", text: `repeat ${index}`, severity: "annoying" }));
    const reports = run([file("aaaaaa"), ...repeats]).laments[0]?.reports ?? [];
    expect(reports).toHaveLength(LAMENT_LIMITS.reports);
    expect(reports[0]?.text).toBe("No tool for it; did it by hand.");
    expect(reports.at(-1)?.text).toBe(`repeat ${LAMENT_LIMITS.reports + 4}`);
  });

  it("resolves, reopens and removes; an op that changes nothing returns the same laments", () => {
    const laments = run([file("aaaaaa")]);
    expect(applyLamentOp(laments, { type: "resolve", id: "aaaaaa", resolved: false }, 9)).toBe(laments);
    const resolved = applyLamentOp(laments, { type: "resolve", id: "aaaaaa", resolved: true }, 9);
    expect(applyLamentOp(resolved, { type: "resolve", id: "aaaaaa", resolved: false }, 10).laments[0]?.resolvedAt).toBeUndefined();
    expect(applyLamentOp(laments, { type: "remove", id: "aaaaaa" }, 9).laments).toEqual([]);
  });

  it("rejects bad input from the renderer or an agent", () => {
    const laments = run([file("aaaaaa")]);
    const bad: unknown[] = [
      { ...file("bbbbbb"), title: "  " },
      { ...file("bbbbbb"), title: "x".repeat(LAMENT_LIMITS.title + 1) },
      { ...file("bbbbbb"), text: "   " },
      { ...file("bbbbbb"), text: "x".repeat(LAMENT_LIMITS.text + 1) },
      { ...file("bbbbbb"), severity: "furious" },
      { ...file("bbbbbb"), cwd: "relative" },
      { ...file("bbbbbb"), chat: { path: "relative", cwd: "/repo" } },
      file("aaaaaa"),
      { ...file("bbbbbb"), id: "../etc" },
      { type: "repeat", id: "zzzzzz", text: "x", severity: "annoying" },
      { type: "remove", id: "zzzzzz" },
      { type: "explode" },
      null,
    ];
    for (const op of bad) expect(() => applyLamentOp(laments, op as LamentOp, 1)).toThrow(LamentError);
  });

  it("lists a project's open laments worst first, then the most recent; resolved ones the most recent first", () => {
    const laments = run([
      file("aaaaaa", "annoying"),
      file("bbbbbb", "blocking"),
      file("cccccc", "annoying"),
      file("dddddd", "costly", "/other"),
      file("eeeeee", "blocking"),
      { type: "resolve", id: "eeeeee", resolved: true },
    ]);
    expect(projectLaments(laments, "/repo").map((lament) => lament.id)).toEqual(["bbbbbb", "cccccc", "aaaaaa"]);
    expect(projectLaments(laments, "/repo", true).map((lament) => lament.id)).toEqual(["eeeeee"]);
    expect(projectLaments(laments, "/other").map((lament) => lament.id)).toEqual(["dddddd"]);
  });

  it("reads a laments file, skipping malformed laments", () => {
    const good = run([file("aaaaaa")]).laments[0];
    const { laments, dropped } = parseLaments({ version: 1, laments: [good, { id: "broken" }, { ...good, reports: [] }] });
    expect(laments.laments).toEqual([good]);
    expect(dropped).toBe(2);
    expect(() => parseLaments({ cards: [] })).toThrow(LamentError);
  });
});
