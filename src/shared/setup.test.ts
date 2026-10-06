import { describe, expect, it } from "vitest";
import { installError, nodeSupported, piReady } from "./setup";

describe("nodeSupported", () => {
  it("needs Node.js 22.19 or newer", () => {
    for (const ok of ["v22.19.0", "22.19.1", "v22.20.0", "v24.15.0", "23.0.0"]) expect(nodeSupported(ok), ok).toBe(true);
    for (const old of ["v22.18.9", "v20.11.1", "18.0.0", "v22", "", "abc"]) expect(nodeSupported(old), old).toBe(false);
    for (const ok of ["v24", "22.19", "v22.19.0-nightly"]) expect(nodeSupported(ok), ok).toBe(true);
  });
});

describe("piReady", () => {
  it("needs pi and its package", () => {
    const base = {
      node: { version: "24.0.0", ok: true },
      npm: true,
      brew: false,
    };
    expect(piReady({ ...base, pi: { version: "1.0.0" }, sdk: true })).toBe(true);
    expect(piReady({ ...base, pi: { version: "1.0.0" }, sdk: false })).toBe(false);
    expect(piReady({ ...base, pi: null, sdk: false })).toBe(false);
    expect(piReady({ ...base, pi: { error: "no answer in 15 s" }, sdk: true })).toBe(false);
  });
});

describe("installError", () => {
  it("explains permission and network failures, else shows npm's error lines", () => {
    expect(installError("npm error code EACCES\nnpm error syscall mkdir", 243)).toMatch(/global folder/);
    expect(installError("npm error code ENOTFOUND", 1)).toMatch(/registry/);
    expect(installError("added 1\nnpm error code E404\nnpm error 404 Not Found", 1)).toBe("npm error code E404\nnpm error 404 Not Found");
    expect(installError("", 7)).toBe("npm exited with code 7.");
    expect(installError("npm error code ETARGET\nnpm error notarget No matching version\nnpm error\nnpm error A complete log of this run can be found in: /x.log", 1)).toBe(
      "npm error code ETARGET\nnpm error notarget No matching version",
    );
  });
});
