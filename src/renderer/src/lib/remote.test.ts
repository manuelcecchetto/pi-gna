import { describe, expect, it } from "vitest";
import type { RemoteStatus } from "../../../shared/host-api";
import { canServe, describeAgent, groupCode, pairingLink, remoteChecks } from "./remote";

const status = (over: Partial<RemoteStatus> = {}, tailscale: Partial<RemoteStatus["tailscale"]> = {}): RemoteStatus => ({
  enabled: true,
  port: 4517,
  serve: "off",
  keepAwake: "while-working",
  awake: false,
  devices: 0,
  listening: true,
  connected: 0,
  tailscale: { installed: true, loggedIn: true, dnsName: "mac.tail1.ts.net", httpsAvailable: true, funnel: false, ...tailscale },
  ...over,
});

describe("remoteChecks", () => {
  it("is all green when ready", () => {
    expect(remoteChecks(status()).every((check) => check.ok)).toBe(true);
    expect(canServe(status())).toEqual({ ok: true });
  });

  it("offers a fix for a missing install and for HTTPS", () => {
    const missing = remoteChecks(status({}, { installed: false, loggedIn: false, httpsAvailable: false }));
    expect(missing.find((check) => check.label === "Tailscale")?.fix?.url).toContain("tailscale.com");
    expect(missing.find((check) => check.label === "HTTPS certificates")?.fix).toBeDefined();
  });

  it("explains Funnel and blocks serving", () => {
    const funnel = status({ serve: "funnel_refused" }, { funnel: true });
    expect(remoteChecks(funnel).find((check) => check.label === "Funnel")).toMatchObject({ ok: false });
    expect(canServe(funnel).ok).toBe(false);
  });

  it("shows the port error and blocks serving while not listening", () => {
    const taken = status({ listening: false, error: "Port 4517 is in use. Pick another port." });
    expect(remoteChecks(taken)[0]).toMatchObject({ ok: false, detail: "Port 4517 is in use. Pick another port." });
    expect(canServe(taken).ok).toBe(false);
  });
});

describe("pairing text", () => {
  it("puts the code in the link fragment and groups it for reading", () => {
    expect(pairingLink("https://mac.tail1.ts.net", "ABCD2345")).toBe("https://mac.tail1.ts.net/#pair=ABCD2345");
    expect(groupCode("ABCD2345")).toBe("ABCD 2345");
  });

  it("summarizes a user agent", () => {
    expect(describeAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605 Version/18.0 Mobile Safari/604.1")).toBe("iPhone · Safari");
    expect(describeAgent("")).toBe("Unknown device");
  });
});
