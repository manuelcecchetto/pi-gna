import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => "/app" } }));

import type { AgentBridge } from "./bridge";
import { type SessionFeatures, SessionHost } from "./session-host";

const bridge = { url: "http://x", register: () => "token" } as unknown as AgentBridge;
const base: SessionFeatures = { kanban: false, laments: false, github: false, atp: false, computer: false, visuals: false };
const argsFor = (features: SessionFeatures, atp?: Parameters<SessionHost["piArgs"]>[2]) =>
  new SessionHost(() => {}, bridge, "/atp").piArgs("abcdef", undefined, atp, features).args;

describe("piArgs visuals prompt", () => {
  it("appends the visual prompt only when visuals is on", () => {
    expect(argsFor(base).join(" ")).not.toContain("pigna-visual-prompt.md");
    expect(argsFor({ ...base, visuals: true })).toContain("/app/resources/pigna-visual-prompt.md");
  });
  it("also appends it for ATP chats", () => {
    const args = argsFor({ ...base, visuals: true }, { role: "worker", plan: "/p/x.atp.json" } as never);
    expect(args).toContain("/app/resources/pigna-visual-prompt.md");
  });
});
