import { describe, expect, it } from "vitest";
import { matchRanges, type PaletteItem, rankPalette, scoreItem, textScore } from "./palette";

const NOW = 1_000 * 86_400_000;
const item = (group: PaletteItem["group"], title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id: `${group}:${title}`, group, title, run: () => undefined, ...extra });

const items = [
  item("Chats", "Fix the login redirect", { detail: "web-app", time: NOW - 86_400_000 }),
  item("Chats", "Kanban drag and drop", { detail: "pi-gna", time: NOW - 3_600_000 }),
  item("Chats", "Just started", { detail: "pi-gna" }),
  item("Pages", "Kanban"),
  item("Pages", "GitHub"),
  item("Commands", "New chat"),
  item("Cards", "Add a Cmd+K search panel", { detail: "In progress · pi-gna", keywords: "ui chat 40uaxy" }),
  item("Settings", "Appearance", { keywords: "theme dark light font" }),
  item("Projects", "New chat in pi-gna", { detail: "~/Code/pi-gna" }),
];

const titles = (query: string) => rankPalette(items, query, NOW).map((section) => [section.group, section.items.map((i) => i.title)]);

describe("rankPalette", () => {
  it("shows recent chats, pages and commands before you type", () => {
    expect(titles("")).toEqual([
      ["Chats", ["Just started", "Kanban drag and drop", "Fix the login redirect"]],
      ["Pages", ["Kanban", "GitHub"]],
      ["Commands", ["New chat"]],
    ]);
  });

  it("puts the group with the best match first", () => {
    const sections = titles("kanban");
    expect(sections[0]).toEqual(["Pages", ["Kanban"]]);
    expect(sections[1]).toEqual(["Chats", ["Kanban drag and drop"]]);
  });

  it("ranks a title with the whole query above one with its words spread out", () => {
    const whole = scoreItem("close the browser pane", item("Chats", "Resolve: Close the browser pane when its last tab closes"), NOW);
    const spread = scoreItem("close the browser pane", item("Chats", "the browser is slow, pane sizes are off, close it and open it again", { time: NOW }), NOW);
    expect(spread).toBeGreaterThan(0);
    expect(whole).toBeGreaterThan(spread);
  });

  it("finds a feature by its keywords before a chat that mentions them", () => {
    const appearance = scoreItem("theme", item("Settings", "Appearance", { keywords: "theme dark light" }), NOW);
    const chat = scoreItem("theme", item("Chats", "Resolve: Add project-scoped customizable themes", { time: NOW }), NOW);
    expect(appearance).toBeGreaterThan(chat);
  });

  it("puts a feature before a chat that matches as well", () => {
    expect(scoreItem("kanban", item("Pages", "Kanban board"), NOW)).toBeGreaterThan(scoreItem("kanban", item("Chats", "Kanban work", { time: NOW }), NOW));
    expect(scoreItem("kanban", item("Chats", "kanban"), NOW)).toBeGreaterThan(scoreItem("kanban", item("Pages", "Kanban board"), NOW));
  });

  it("finds cards, settings and projects only by searching", () => {
    expect(titles("theme")).toEqual([["Settings", ["Appearance"]]]);
    expect(titles("40uaxy")).toEqual([["Cards", ["Add a Cmd+K search panel"]]]);
    expect(titles("search panel")[0]).toEqual(["Cards", ["Add a Cmd+K search panel"]]);
  });

  it("matches words across the title and the detail", () => {
    expect(titles("login web")).toEqual([["Chats", ["Fix the login redirect"]]]);
    expect(titles("login nowhere")).toEqual([]);
  });

  it("matches keywords only where a word appears as is", () => {
    const sections = [item("Settings", "Appearance", { keywords: "theme" }), item("Settings", "Models", { keywords: "default model provider thinking level triage" })];
    expect(rankPalette(sections, "appear", NOW).map((s) => s.items.map((i) => i.title))).toEqual([["Appearance"]]);
  });
});

describe("scoreItem", () => {
  it("ranks a title match above a detail match and newer above older", () => {
    const title = scoreItem("gna", item("Chats", "pi-gna release"), NOW);
    const detail = scoreItem("gna", item("Chats", "release", { detail: "pi-gna" }), NOW);
    expect(title).toBeGreaterThan(detail);
    const recent = scoreItem("fix", item("Chats", "fix it", { time: NOW }), NOW);
    const old = scoreItem("fix", item("Chats", "fix it", { time: NOW - 60 * 86_400_000 }), NOW);
    expect(recent).toBeGreaterThan(old);
  });
});

describe("textScore", () => {
  it("ranks the title's start, then a word's start, then anywhere, then a subsequence", () => {
    const scores = ["close tab", "Resolve: close tab", "unclose tab", "c-l-o-s-e t-a-b"].map((title) => textScore("close tab", title));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores[3]).toBeGreaterThan(0);
  });

  it("ignores letters scattered over a long title", () => {
    expect(textScore("theme", "check all the stuff that are in review and mark the ones shipped")).toBe(0);
    expect(textScore("apr", "Appearance")).toBeGreaterThan(0);
  });

  it("does not read a title with a URL in it as a path", () => {
    const url = textScore("close the browser", "look at https://x.com/close the browser and more");
    const plain = textScore("close the browser", "Resolve: Close the browser pane when its last tab closes");
    expect(plain).toBeGreaterThan(url);
  });
});

describe("matchRanges", () => {
  it("highlights the whole query, each word, or the subsequence", () => {
    expect(matchRanges("login", "Fix the login redirect")).toEqual([[8, 13]]);
    expect(matchRanges("fix redirect", "Fix the login redirect")).toEqual([[0, 3], [14, 22]]);
    expect(matchRanges("ftl", "Fix the login")).toEqual([[0, 1], [4, 5], [8, 9]]);
    expect(matchRanges("kb", "New chat")).toEqual([]);
  });
});
