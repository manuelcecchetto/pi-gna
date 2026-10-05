import { describe, expect, it } from "vitest";
import { isWebUrl, loginGuide, pageHost } from "./login-view";

const base = { method: "oauth" as const, prompts: [] };

describe("loginGuide", () => {
  it("shows the code of a device-code flow", () => {
    expect(loginGuide({ ...base, device: { userCode: "AB-12", verificationUri: "https://github.com/login/device" } }, false)).toBe("code");
  });
  it("accepts a pasted code or redirect when the login asks for one", () => {
    const prompts = [{ n: 1, type: "manual_code" as const, message: "Paste" }];
    expect(loginGuide({ ...base, url: { url: "https://x.test/a" }, prompts }, false)).toBe("paste");
  });
  it("sends a callback-only flow to the Mac once no paste prompt came", () => {
    expect(loginGuide({ ...base, url: { url: "https://x.test/a" } }, false)).toBe("wait");
    expect(loginGuide({ ...base, url: { url: "https://x.test/a" } }, true)).toBe("mac");
  });
  it("is a plain key entry for API keys", () => {
    expect(loginGuide({ method: "api_key", prompts: [] }, true)).toBe("key");
  });
});

describe("pageHost / isWebUrl", () => {
  it("reads the host and accepts web links only", () => {
    expect(pageHost("https://github.com/login/device")).toBe("github.com");
    expect(pageHost("nonsense")).toBe("nonsense");
    expect(isWebUrl("https://a.test")).toBe(true);
    expect(isWebUrl("claude://login")).toBe(false);
  });
});
