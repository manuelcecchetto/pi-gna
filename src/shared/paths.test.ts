import { describe, expect, it } from "vitest";
import { isPlanPath, planName, workerMessage } from "./atp";
import { applyOp, emptyBoard, parseBoard, projectCards, worktreeCwd } from "./board";
import { applyLamentOp, emptyLaments, parseLaments, projectLaments } from "./laments";
import { isAbsoluteHostPath } from "./paths";
import { applyThemeOp, effectiveTheme, emptyThemes, parseThemes } from "./themes";

const projects = ["/Users/me/Repo ü", String.raw`C:\Users\me\Repo ü`, "D:/Repo ü", String.raw`\\server\share\Repo ü`];
const invalid = ["", "repo", "./repo", "../repo", "~/repo", "C:repo", "C:", String.raw`\repo`, String.raw`\\server`,
  "\\\\server\\", String.raw`\\server\..`, String.raw`\\?\C:\repo`, String.raw`\\.\pipe\repo`, "//?/C:/repo", "//./pipe/repo",
  "file:///C:/repo", "https://example.org/repo", "/repo\0x", "C:/repo\0x", null, undefined, 42, {}];

it("uses the host-selected Python 3 command in a Windows worker's prompt", () => {
  expect(workerMessage({ project: "C:/repo", plan: "C:/repo/p.atp.json", branch: "main", librarian: "C:/App with spaces/lib.py", python: "py -3", claim: { kind: "assigned", node: "T1", title: "First", packet: "TASK ASSIGNED: T1 - First" } })).toContain("py -3 'C:/App with spaces/lib.py' atp-read-graph");
  expect(planName(String.raw`/repo/literal\name.atp.json`)).toBe(String.raw`literal\name`);
});

describe("host absolute paths (independent of client OS)", () => {
  it.each([...projects, "/", "C:/", "C:\\", "z:/nested/path", String.raw`\\server\C$`, String.raw`\\server\hidden.share`])("accepts %s", (path) => {
    expect(isAbsoluteHostPath(path)).toBe(true);
  });
  it.each(invalid)("rejects %s", (path) => {
    expect(isAbsoluteHostPath(path)).toBe(false);
  });
});

describe.each(projects)("project state at %s", (project) => {
  const session = String.raw`C:\Users\me\.pi\agent\sessions\chat.jsonl`;
  const clone = worktreeCwd(project.startsWith("/") ? "/Users/me" : "C:\\Users\\me", "abc123", project);

  it("creates, attaches, reports and reloads a card without rewriting its keys", () => {
    let board = applyOp(emptyBoard(), { type: "add", id: "abc123", title: "Windows port", cwd: project }, 1);
    board = applyOp(board, { type: "attach", id: "abc123", chat: { path: session, cwd: clone } }, 2);
    board = applyOp(board, { type: "report", id: "abc123", chat: session, column: "in_review", text: "Verified" }, 3);
    const loaded = parseBoard(JSON.parse(JSON.stringify(board)));
    expect(loaded).toEqual({ board, dropped: 0 });
    expect(projectCards(loaded.board, project)).toMatchObject([{ column: "in_review", chats: [{ path: session, cwd: clone }] }]);
    expect(() => applyOp(board, { type: "attach", id: "abc123", chat: { path: session, cwd: "Z:\\other" } }, 4)).toThrow(/project/);
  });

  it("files, repeats, fixes and reloads a lament", () => {
    let laments = applyLamentOp(emptyLaments(), { type: "file", id: "abc123", title: "Kanban unavailable", text: "Windows paths refused", severity: "blocking", cwd: project, chat: { path: session, cwd: project } }, 1);
    laments = applyLamentOp(laments, { type: "repeat", id: "abc123", text: "Same gap", severity: "costly", chat: { path: session, cwd: clone } }, 2);
    laments = applyLamentOp(laments, { type: "fix", id: "abc123", chat: { path: session, cwd: clone } }, 3);
    expect(parseLaments(JSON.parse(JSON.stringify(laments)))).toEqual({ laments, dropped: 0 });
    expect(projectLaments(laments, project)).toHaveLength(1);
  });

  it("keeps the project theme after restart and in its worktree, then resets it", () => {
    const themes = applyThemeOp(emptyThemes(), { type: "set", scope: { project }, patch: { base: "dark" } });
    const loaded = parseThemes(JSON.parse(JSON.stringify(themes)));
    expect(loaded).toEqual({ themes, dropped: 0 });
    expect(effectiveTheme(loaded.themes, { theme: "light", wallpaper: "none" }, clone)).toMatchObject({ base: "dark", project });
    expect(applyThemeOp(loaded.themes, { type: "reset", scope: { project } })).toEqual(emptyThemes());
  });

  it("recognizes and names ATP plans", () => {
    const plan = `${project}${project.includes("\\") ? "\\" : "/"}roadmap.atp.json`;
    expect(isPlanPath(plan)).toBe(true);
    expect(planName(plan)).toBe("roadmap");
  });
});

it.each(invalid.filter((value): value is string => typeof value === "string"))("still rejects malformed mutation paths: %s", (cwd) => {
  expect(() => applyOp(emptyBoard(), { type: "add", title: "x", cwd }, 1)).toThrow(/absolute path/);
  expect(() => applyLamentOp(emptyLaments(), { type: "file", title: "x", text: "x", severity: "blocking", cwd }, 1)).toThrow(/absolute path/);
  expect(() => applyThemeOp(emptyThemes(), { type: "set", scope: { project: cwd }, patch: { base: "dark" } })).toThrow(/absolute path/);
  expect(parseThemes({ projects: { [cwd]: { base: "dark" } } }).dropped).toBe(1);
});
