import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialogs } from "./Dialogs";
import { clockFor } from "./primitives";

vi.mock("../lib/chat-ui", () => ({ useChatActions: () => ({ respondDialog: () => undefined }) }));

describe("Dialogs", () => {
  afterEach(() => vi.useRealTimers());

  it("counts a timeout down from its full length, though the shared clock trails the dialog's opening", () => {
    vi.useFakeTimers({ now: 10_000 });
    clockFor(250).read();
    vi.setSystemTime(10_200);
    const dialog = { type: "extension_ui_request", id: "d1", method: "confirm", title: "Run it?", timeout: 30_000 } as const;
    expect(renderToStaticMarkup(createElement(Dialogs, { handle: "h", dialogs: [dialog] }))).toContain(">30s</span>");
  });
});
