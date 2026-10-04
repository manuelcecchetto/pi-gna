import { describe, expect, it } from "vitest";
import type { AuthProvider } from "../../../shared/auth";
import { accountLabel, answered, logoFor, startLogin, updateLogin } from "./login";
import { LOGOS } from "./provider-logos";

const acme: AuthProvider = { id: "acme", name: "Acme", oauth: { name: "Acme (Pro)", subscription: true } };

describe("updateLogin", () => {
  it("keeps the open prompts, dropping withdrawn and answered ones", () => {
    let view = startLogin(acme, "oauth");
    view = updateLogin(view, { kind: "event", event: { type: "auth_url", url: "https://acme.test/auth", instructions: "Finish in the browser" } });
    view = updateLogin(view, { kind: "prompt", prompt: { n: 1, type: "manual_code", message: "Paste the URL" } });
    view = updateLogin(view, { kind: "prompt", prompt: { n: 2, type: "text", message: "Team?" } });
    expect(view.url).toEqual({ url: "https://acme.test/auth", instructions: "Finish in the browser" });
    expect(view.prompts.map((prompt) => prompt.n)).toEqual([1, 2]);
    expect(answered(view, 2).prompts.map((prompt) => prompt.n)).toEqual([1]);
    expect(updateLogin(view, { kind: "withdraw", n: 1 }).prompts.map((prompt) => prompt.n)).toEqual([2]);
  });

  it("shows a device code, notes and the latest progress", () => {
    let view = startLogin(acme, "oauth");
    view = updateLogin(view, { kind: "event", event: { type: "device_code", userCode: "ABCD-1234", verificationUri: "https://acme.test/device", intervalSeconds: 5 } });
    expect(view.device).toEqual({ userCode: "ABCD-1234", verificationUri: "https://acme.test/device" });
    view = updateLogin(view, { kind: "event", event: { type: "info", message: "Check your mail", links: [{ url: "https://acme.test/help" }] } });
    view = updateLogin(view, { kind: "event", event: { type: "progress", message: "Exchanging the code…" } });
    expect(view.notes).toEqual([{ message: "Check your mail", links: [{ url: "https://acme.test/help" }] }]);
    expect(view.progress).toBe("Exchanging the code…");
  });
});

describe("accountLabel", () => {
  it("takes the plan from pi's name for the sign-in", () => {
    const label = (name: string, subscription = true) => accountLabel({ ...acme, oauth: { name, subscription } });
    expect(label("Anthropic (Claude Pro/Max)")).toBe("Claude Pro/Max");
    expect(label("Kimi Code (subscription)")).toBe("Kimi Code subscription");
    expect(label("GitHub Copilot")).toBe("Subscription");
    expect(label("OpenRouter OAuth", false)).toBe("Account");
  });
});

describe("logoFor", () => {
  it("finds a provider's brand, or the brand of the provider it extends", () => {
    expect(logoFor("anthropic")).toBe(LOGOS.Anthropic);
    expect(logoFor("qwen-token-plan-intl")).toBe(LOGOS.Qwen);
    expect(logoFor("my-proxy")).toBeUndefined();
  });

  it("has every logo's gradient ids prefixed per use", () => {
    for (const logo of Object.values(LOGOS)) {
      for (const [, id] of logo.body.matchAll(/id="([^"]+)"/g)) expect(id).toMatch(/^\{id\}/);
    }
  });
});
