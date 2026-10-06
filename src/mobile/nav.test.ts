import { describe, expect, it } from "vitest";
import { launchStack } from "./nav";

describe("launchStack", () => {
  it("puts the project's chat list and the projects below a fresh launch's new chat, so back and the swipe have somewhere to go", () => {
    expect(launchStack(null, "", "/p")).toEqual([{ screen: "projects" }, { screen: "chats", cwd: "/p" }, { screen: "chat", cwd: "/p" }]);
  });

  it("reopens a reloaded chat as a fresh launch with the same stack below it", () => {
    expect(launchStack({ screen: "chat", cwd: "/old", handle: "h" }, "", "/p").map((r) => r.screen)).toEqual(["projects", "chats", "chat"]);
  });

  it("keeps a reloaded non-chat route as is: its entries below are still in the history", () => {
    expect(launchStack({ screen: "settings" }, "", "/p")).toEqual([{ screen: "settings" }]);
  });

  it("starts on the projects when a notification names a chat or no project is remembered", () => {
    expect(launchStack(null, "#/chat/h1", "/p")).toEqual([{ screen: "projects" }]);
    expect(launchStack(null, "", undefined)).toEqual([{ screen: "projects" }]);
  });
});
