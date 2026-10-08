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

  it("records the chats its Fix started, the same chat once, the latest ten", () => {
    const fixer = { path: "/s/fix.jsonl", cwd: "/home/.pi-gna/worktrees/aaaaaa/repo" };
    let laments = run([file("aaaaaa"), { type: "fix", id: "aaaaaa", chat: fixer, branch: "pigna/aaaaaa-fix-missing-aaaaaa" }]);
    expect(laments.laments[0]).toMatchObject({ updatedAt: 1000, fixes: [{ at: 1001, chat: fixer, branch: "pigna/aaaaaa-fix-missing-aaaaaa" }] });
    laments = run([{ type: "fix", id: "aaaaaa", chat }, { type: "fix", id: "aaaaaa", chat: fixer }], laments);
    expect(laments.laments[0]?.fixes?.map((fix) => [fix.chat.path, fix.branch])).toEqual([
      ["/s/chat.jsonl", undefined],
      ["/s/fix.jsonl", undefined],
    ]);
    const many: LamentOp[] = Array.from({ length: LAMENT_LIMITS.fixes + 3 }, (_, index) => ({ type: "fix", id: "aaaaaa", chat: { ...chat, path: `/s/${index}.jsonl` } }));
    const fixes = run(many, laments).laments[0]?.fixes ?? [];
    expect(fixes).toHaveLength(LAMENT_LIMITS.fixes);
    expect(fixes.at(-1)?.chat.path).toBe(`/s/${LAMENT_LIMITS.fixes + 2}.jsonl`);
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
      { type: "fix", id: "zzzzzz", chat },
      { type: "fix", id: "aaaaaa" },
      { type: "fix", id: "aaaaaa", chat: { path: "relative", cwd: "/repo" } },
      { type: "fix", id: "aaaaaa", chat, branch: "has space" },
      { type: "fix", id: "aaaaaa", chat, branch: "pigna/../main" },
      { type: "fix", id: "aaaaaa", chat, branch: "" },
      { type: "explode" },
      null,
    ];
    for (const op of bad) expect(() => applyLamentOp(laments, op as LamentOp, 1)).toThrow(LamentError);
  });

  it("lists a project's open and resolved laments worst first, then the most recent", () => {
    const laments = run([
      file("aaaaaa", "annoying"),
      file("bbbbbb", "blocking"),
      file("cccccc", "annoying"),
      file("dddddd", "costly", "/other"),
      file("eeeeee", "blocking"),
      file("ffffff", "annoying"),
      file("gggggg", "annoying"),
      { type: "resolve", id: "eeeeee", resolved: true },
      { type: "resolve", id: "ffffff", resolved: true },
      { type: "resolve", id: "gggggg", resolved: true },
    ]);
    expect(projectLaments(laments, "/repo").map((lament) => lament.id)).toEqual(["bbbbbb", "cccccc", "aaaaaa"]);
    expect(projectLaments(laments, "/repo", true).map((lament) => lament.id)).toEqual(["eeeeee", "gggggg", "ffffff"]);
    expect(projectLaments(laments, "/other").map((lament) => lament.id)).toEqual(["dddddd"]);
  });

  it("reads a laments file, skipping malformed laments", () => {
    const good = run([file("aaaaaa")]).laments[0];
    const fixed = run([{ type: "fix", id: "aaaaaa", chat, branch: "pigna/aaaaaa-fix" }], run([file("aaaaaa")])).laments[0];
    const { laments, dropped } = parseLaments({ version: 1, laments: [good, fixed, { id: "broken" }, { ...good, reports: [] }, { ...good, fixes: [{ at: 1 }] }] });
    expect(laments.laments).toEqual([good, fixed]);
    expect(dropped).toBe(3);
    expect(() => parseLaments({ cards: [] })).toThrow(LamentError);
  });
});
