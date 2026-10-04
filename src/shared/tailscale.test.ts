import { describe, expect, it } from "vitest";
import { allowedHosts, findCli, noTailscale, parseServe, parseStatus, serveArgs, serveBlocker, serveState, servesPort, TAILSCALE_APP_CLI, type TailscaleStatus, unserveArgs, unserveBlocker } from "./tailscale";

const ready: TailscaleStatus = { installed: true, loggedIn: true, dnsName: "mac.tail1.ts.net", httpsAvailable: true, funnel: false };

describe("parseStatus", () => {
  it("reads sign-in, DNS name and HTTPS availability", () => {
    const json = JSON.stringify({ BackendState: "Running", Self: { DNSName: "Mac.tail1.ts.net." }, CertDomains: ["mac.tail1.ts.net"] });
    expect(parseStatus(json)).toEqual({ loggedIn: true, dnsName: "mac.tail1.ts.net", httpsAvailable: true });
  });

  it("reports signed out and no HTTPS", () => {
    expect(parseStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: {}, CertDomains: null }))).toEqual({ loggedIn: false, httpsAvailable: false });
  });

  it("takes HTTPS from the https capability when there are no cert domains", () => {
    expect(parseStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "a.b.ts.net.", CapMap: { https: [] } } })).httpsAvailable).toBe(true);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseStatus("nope")).toThrow();
  });
});

describe("parseServe", () => {
  const web = (proxy: string) => ({ TCP: { "443": { HTTPS: true } }, Web: { "mac.tail1.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } } });

  it("is empty when nothing is served", () => {
    expect(parseServe("{}")).toEqual({ funnel: false });
    expect(parseServe("")).toEqual({ funnel: false });
  });

  it("finds the :443 proxy target", () => {
    expect(parseServe(JSON.stringify(web("http://127.0.0.1:4517")))).toEqual({ funnel: false, serving: { target: "http://127.0.0.1:4517" } });
  });

  it("detects Funnel on :443 only", () => {
    expect(parseServe(JSON.stringify({ ...web("http://127.0.0.1:4517"), AllowFunnel: { "mac.tail1.ts.net:443": true } })).funnel).toBe(true);
    expect(parseServe(JSON.stringify({ AllowFunnel: { "mac.tail1.ts.net:8443": true } })).funnel).toBe(false);
  });

  it("counts a non-proxy :443 mapping as taken", () => {
    const json = JSON.stringify({ Web: { "mac.tail1.ts.net:443": { Handlers: { "/": { Path: "/tmp" } } } } });
    expect(parseServe(json).serving).toEqual({ target: "(other)" });
  });

  it("ignores mappings on other ports", () => {
    expect(parseServe(JSON.stringify({ Web: { "mac.tail1.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } } } })).serving).toBeUndefined();
  });
});

describe("commands", () => {
  it("serves the loopback port over HTTPS 443 in the background", () => {
    expect(serveArgs(4517)).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4517"]);
  });

  it("turns the 443 mapping off", () => {
    expect(unserveArgs()).toEqual(["serve", "--https=443", "off"]);
  });

  it("never builds a funnel command", () => {
    expect([...serveArgs(4517), ...unserveArgs()].some((arg) => /funnel/i.test(arg))).toBe(false);
  });
});

describe("serveBlocker", () => {
  it("allows a ready tailnet and an existing mapping to this port", () => {
    expect(serveBlocker(ready, 4517)).toBeUndefined();
    expect(serveBlocker({ ...ready, serving: { target: "http://127.0.0.1:4517/" } }, 4517)).toBeUndefined();
  });

  it.each([
    ["not installed", noTailscale(), /not installed/],
    ["signed out", { ...ready, loggedIn: false }, /Sign in/],
    ["no HTTPS", { ...ready, httpsAvailable: false }, /HTTPS/],
    ["funnel on", { ...ready, funnel: true }, /Funnel/],
    ["another service on 443", { ...ready, serving: { target: "http://127.0.0.1:9" } }, /already serves/],
  ])("refuses when %s", (_name, status, message) => {
    expect(serveBlocker(status as TailscaleStatus, 4517)).toMatch(message);
  });
});

describe("unserveBlocker", () => {
  it("turns off only the mapping to this port", () => {
    expect(unserveBlocker({ ...ready, serving: { target: "http://127.0.0.1:4517" } }, 4517)).toBeUndefined();
    expect(unserveBlocker({ ...ready, serving: { target: "http://127.0.0.1:9" } }, 4517)).toMatch(/not turning it off/);
  });
});

describe("serveState", () => {
  it("summarizes for clients", () => {
    expect(serveState(noTailscale(), 4517)).toBe("unavailable");
    expect(serveState(ready, 4517)).toBe("off");
    expect(serveState({ ...ready, serving: { target: "http://127.0.0.1:4517" } }, 4517)).toBe("on");
    expect(serveState({ ...ready, funnel: true }, 4517)).toBe("funnel_refused");
    expect(servesPort({ serving: { target: "http://127.0.0.1:4518" } }, 4517)).toBe(false);
  });
});

describe("findCli", () => {
  it("prefers the PATH, then the app", () => {
    expect(findCli("/usr/bin:/opt/homebrew/bin", (file) => file === "/opt/homebrew/bin/tailscale")).toBe("/opt/homebrew/bin/tailscale");
    expect(findCli("/usr/bin", (file) => file === TAILSCALE_APP_CLI)).toBe(TAILSCALE_APP_CLI);
    expect(findCli(undefined, () => false)).toBeUndefined();
  });
});

describe("allowedHosts", () => {
  it("is the tailnet name, plus loopback only when testing", () => {
    expect(allowedHosts("mac.tail1.ts.net", 4517, false)).toEqual(["mac.tail1.ts.net"]);
    expect(allowedHosts(undefined, 4517, true)).toEqual(["127.0.0.1:4517", "localhost:4517"]);
    expect(allowedHosts(undefined, 4517, false)).toEqual([]);
  });
});
