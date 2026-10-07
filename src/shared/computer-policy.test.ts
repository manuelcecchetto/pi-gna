import { describe, expect, it } from "vitest";
import {
  applyComputerOp,
  COMPUTER_LIMITS,
  ComputerPolicyError,
  type ComputerSettings,
  DENYLIST,
  deniedApps,
  denyReason,
  emptyComputerSettings,
  isDenied,
  parseComputerSettings,
} from "./computer";

const start = emptyComputerSettings();
const allow = (s: ComputerSettings, bundleId: string, name = "App") => applyComputerOp(s, { type: "allow-always", bundleId, name }, 5);

describe("applyComputerOp", () => {
  it("is disabled by default and toggles", () => {
    expect(start.enabled).toBe(false);
    const on = applyComputerOp(start, { type: "enable" }, 1);
    expect(on.enabled).toBe(true);
    expect(applyComputerOp(on, { type: "enable" }, 2)).toBe(on);
    expect(applyComputerOp(on, { type: "disable" }, 3).enabled).toBe(false);
  });

  it("allows and revokes apps", () => {
    const s = allow(start, "com.apple.TextEdit", " TextEdit ");
    expect(s.alwaysAllowed).toEqual([{ bundleId: "com.apple.TextEdit", name: "TextEdit", at: 5 }]);
    expect(allow(s, "com.apple.TextEdit", "TextEdit")).toBe(s);
    expect(allow(s, "com.apple.TextEdit", "Edit").alwaysAllowed[0]?.at).toBe(5);
    expect(applyComputerOp(s, { type: "revoke", bundleId: "com.apple.TextEdit" }, 6).alwaysAllowed).toEqual([]);
    expect(applyComputerOp(s, { type: "revoke", bundleId: "com.other.App" }, 6)).toBe(s);
  });

  it("validates every field", () => {
    for (const bundleId of ["", "nodots", "has space.x", "a/b.c", 5 as unknown as string, "x".repeat(300) + ".a"])
      expect(() => allow(start, bundleId)).toThrow(ComputerPolicyError);
    expect(() => allow(start, "com.a.b", "")).toThrow(ComputerPolicyError);
    expect(() => allow(start, "com.a.b", "x".repeat(COMPUTER_LIMITS.name + 1))).toThrow(ComputerPolicyError);
    expect(() => allow(start, "com.a.b", "bad\nname")).toThrow(ComputerPolicyError);
    expect(() => applyComputerOp(start, { type: "nope" } as never, 1)).toThrow(ComputerPolicyError);
    expect(() => applyComputerOp(start, { type: "revoke", bundleId: "x" }, 1)).toThrow(ComputerPolicyError);
  });

  it("caps the list", () => {
    let s = start;
    for (let i = 0; i < COMPUTER_LIMITS.allowed; i++) s = allow(s, `com.app.n${i}`);
    expect(() => allow(s, "com.app.extra")).toThrow(/at most/);
  });

  it("refuses denylisted apps", () => {
    expect(() => allow(start, "com.apple.Terminal")).toThrow(/cannot be allowed/);
  });
});

describe("denylist", () => {
  it("covers terminals, pi-gna, the helper and security prompts", () => {
    for (const id of ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "com.github.wez.wezterm", "net.kovidgoyal.kitty", "org.alacritty", "dev.warp.Warp-Stable", "io.github.manuelcecchetto.pigna", "io.github.manuelcecchetto.pigna.computeruse", "com.apple.SecurityAgent", "com.apple.coreservices.uiagent"])
      expect(isDenied(id), id).toBe(true);
    expect(Object.values(DENYLIST).every(Boolean)).toBe(true);
  });
  it("names every app for the settings pages, grouped by reason", () => {
    const groups = deniedApps();
    expect(groups.flatMap((group) => group.ids).sort()).toEqual(Object.keys(DENYLIST).sort());
    expect(groups.flatMap((group) => group.names).some((name) => name.includes("."))).toBe(false);
    expect(groups.find((group) => group.names.includes("Terminal"))?.names).toEqual(["Terminal", "iTerm2", "Ghostty", "WezTerm", "kitty", "Alacritty", "Warp"]);
  });
  it("is case-insensitive and allows ordinary apps", () => {
    expect(isDenied("COM.APPLE.TERMINAL")).toBe(true);
    expect(isDenied("com.apple.TextEdit")).toBe(false);
  });
  it("denies by runtime id and by path inside pi-gna or the helper", () => {
    expect(isDenied("dev.custom.pigna", undefined, ["dev.custom.pigna"])).toBe(true);
    expect(isDenied("unknown.app", "/Applications/pi-gna.app/Contents/Frameworks/X.app")).toBe(true);
    expect(isDenied("unknown.app", "/Users/me/.pi-gna/computer-use/pi-gna Computer Use.app")).toBe(true);
    expect(isDenied("unknown.app", "/Applications/Other.app")).toBe(false);
    expect(denyReason("com.apple.TextEdit")).toBeUndefined();
  });
});

describe("parseComputerSettings", () => {
  it("defaults to disabled, drops bad and denied entries", () => {
    expect(parseComputerSettings({}).settings).toEqual(emptyComputerSettings());
    const { settings, dropped } = parseComputerSettings({
      enabled: true,
      alwaysAllowed: [{ bundleId: "com.a.b", name: "A", at: 1 }, { bundleId: "com.apple.Terminal", name: "T", at: 1 }, { bundleId: "bad", name: "x" }, { bundleId: "com.a.b", name: "dup", at: 2 }],
    });
    expect(settings.enabled).toBe(true);
    expect(settings.alwaysAllowed.map((a) => a.bundleId)).toEqual(["com.a.b"]);
    expect(dropped).toBe(3);
    expect(() => parseComputerSettings([])).toThrow();
  });
  it("keeps a known cursor motion and falls back to the default for anything else", () => {
    expect(parseComputerSettings({ cursorMotion: "magnetic" }).settings.cursorMotion).toBe("magnetic");
    expect(parseComputerSettings({ cursorMotion: "zigzag" }).settings.cursorMotion).toBe("signature_arc");
  });
});

describe("cursor motion op", () => {
  it("sets a known motion, keeps identity when unchanged and rejects unknown ones", () => {
    const next = applyComputerOp(start, { type: "cursor-motion", motion: "comet_swoop" }, 1);
    expect(next.cursorMotion).toBe("comet_swoop");
    expect(applyComputerOp(next, { type: "cursor-motion", motion: "comet_swoop" }, 1)).toBe(next);
    expect(() => applyComputerOp(start, { type: "cursor-motion", motion: "zigzag" as never }, 1)).toThrow(ComputerPolicyError);
  });
});
