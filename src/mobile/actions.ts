// What the long-press sheets offer, as the desktop sidebar's context menus do (Sidebar.tsx sessionMenu/projectMenu):
// the same rows under the same conditions, so the two stay in step. Kanban, Laments, GitHub and ATP rows exist only
// while their feature is on.
import type { Card } from "../shared/board";
import type { Feature } from "../shared/settings";

export type ChatAction = "open" | "show-board" | "add-board" | "close" | "copy-path";
export type ProjectAction = "new-chat" | "pin" | "unpin" | "hide" | "unhide" | "board" | "laments" | "github" | "atp" | "copy-path";

export function chatActions(opts: { kanban: boolean; live: boolean; card?: Card; addable: boolean }): ChatAction[] {
  return [
    "open",
    ...(opts.kanban ? (opts.card ? (["show-board"] as const) : opts.addable ? (["add-board"] as const) : []) : []),
    ...(opts.live ? (["close"] as const) : []),
    "copy-path",
  ];
}

export function projectActions(features: Record<Feature, boolean>, pinned: boolean, hidden = false): ProjectAction[] {
  return [
    "new-chat",
    ...(hidden ? (["unhide"] as const) : ([pinned ? "unpin" : "pin", "hide"] as const)),
    ...(features.kanban ? (["board"] as const) : []),
    ...(features.laments ? (["laments"] as const) : []),
    ...(features.github ? (["github"] as const) : []),
    ...(features.atp ? (["atp"] as const) : []),
    "copy-path",
  ];
}
