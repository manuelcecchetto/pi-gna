import { describe, expect, it } from "vitest";
import type { Card } from "../shared/board";
import type { Feature } from "../shared/settings";
import { chatActions, projectActions } from "./actions";

const features = (on: Partial<Record<Feature, boolean>>) => ({ kanban: false, laments: false, github: false, atp: false, ...on }) as Record<Feature, boolean>;

describe("long-press actions", () => {
  it("offers board rows only with Kanban on, and Close only for a live chat", () => {
    expect(chatActions({ kanban: false, live: true, addable: true })).toEqual(["open", "close", "copy-path"]);
    expect(chatActions({ kanban: true, live: true, addable: true })).toEqual(["open", "add-board", "close", "copy-path"]);
    expect(chatActions({ kanban: true, live: false, addable: false })).toEqual(["open", "copy-path"]);
    expect(chatActions({ kanban: true, live: false, addable: false, card: { id: "c" } as Card })).toEqual(["open", "show-board", "copy-path"]);
  });

  it("offers only the project pages whose feature is on", () => {
    expect(projectActions(features({}), false)).toEqual(["new-chat", "pin", "hide", "copy-path"]);
    expect(projectActions(features({ kanban: true, github: true, atp: true }), true)).toEqual(["new-chat", "unpin", "hide", "board", "github", "atp", "copy-path"]);
    expect(projectActions(features({}), false, true)).toEqual(["new-chat", "unhide", "copy-path"]);
  });
});
