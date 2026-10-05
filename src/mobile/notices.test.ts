import { describe, expect, it } from "vitest";
import type { HostEvent } from "../shared/host-api";
import { noticeFor } from "./notices";

const notify = (message: string, notifyType?: "info" | "warning" | "error"): HostEvent => ({
  kind: "rpc",
  record: { type: "extension_ui_request", id: "n", method: "notify", message, notifyType },
});

describe("noticeFor", () => {
  it("toasts a notice with its level", () => {
    expect(noticeFor(notify("done", "error"), { phase: "ready" }, new Set())).toEqual({ text: "done", level: "error" });
    expect(noticeFor(notify("fyi"), { phase: "ready" }, new Set())).toEqual({ text: "fyi", level: "info" });
  });
  it("drops startup chatter and shows a startup warning once", () => {
    const seen = new Set<string>();
    expect(noticeFor(notify("X loaded"), { phase: "starting" }, seen)).toBeUndefined();
    expect(noticeFor(notify("Y is old", "warning"), { phase: "starting" }, seen)).toEqual({ text: "Y is old", level: "warning" });
    expect(noticeFor(notify("Y is old", "warning"), { phase: "starting" }, seen)).toBeUndefined();
    expect(noticeFor(notify("Y is old", "warning"), { phase: "ready" }, seen)).toEqual({ text: "Y is old", level: "warning" });
  });
  it("ignores other events", () => {
    expect(noticeFor({ kind: "closed", by: "host" }, { phase: "ready" }, new Set())).toBeUndefined();
  });
});
