import { describe, expect, it } from "vitest";
import { codeFromHash, defaultDeviceName, isStandalone, normalizeCode, pair } from "./pair-flow";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const err = (code: string, message: string, detail?: object) => json({ error: { code, message, detail } }, 400);

describe("pairing helpers", () => {
  it("normalizes typed codes", () => {
    expect(normalizeCode("abcd-2345 xx")).toBe("ABCD2345");
  });
  it("reads the code from the QR fragment", () => {
    expect(codeFromHash("#pair=ABCD2345")).toBe("ABCD2345");
    expect(codeFromHash("#pair=abcd-2345")).toBe("ABCD2345");
    expect(codeFromHash("#pair=short")).toBe("");
    expect(codeFromHash("")).toBe("");
  });
  it("names the device from the user agent", () => {
    expect(defaultDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(defaultDeviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile")).toBe("Android phone");
    expect(defaultDeviceName("")).toBe("Phone");
  });
  it("detects standalone", () => {
    expect(isStandalone({ standalone: true }, () => false)).toBe(true);
    expect(isStandalone({}, (q) => q.includes("standalone"))).toBe(true);
    expect(isStandalone({}, () => false)).toBe(false);
  });
});

describe("pair", () => {
  const run = (responses: Response[]) => {
    const queue = [...responses];
    const urls: string[] = [];
    return { urls, deps: { fetch: (async (url: string) => (urls.push(url), queue.shift()!)) as unknown as typeof fetch } };
  };
  it("waits through pending polls until approved", async () => {
    const { deps, urls } = run([json({ request: "r1" }), json({ state: "pending_approval" }), json({ state: "approved" })]);
    expect(await pair("ABCD2345", "iPhone", deps)).toEqual({ ok: true });
    expect(urls).toEqual(["/api/pair", "/api/pair/r1/wait", "/api/pair/r1/wait"]);
  });
  it.each([
    ["denied", "denied"],
    ["expired", "expired"],
  ])("maps %s", async (state, failure) => {
    const { deps } = run([json({ request: "r1" }), json({ state })]);
    expect(await pair("ABCD2345", "x", deps)).toEqual({ ok: false, failure });
  });
  it("maps wrong, locked and unreachable", async () => {
    expect(await pair("A", "x", run([err("bad_request", "invalid pairing code")]).deps)).toEqual({ ok: false, failure: "wrong_code" });
    expect(await pair("A", "x", run([err("rate_limited", "pairing is locked; ask", { retryAfter: 300 })]).deps)).toEqual({ ok: false, failure: "locked", retryAfter: 300 });
    expect(await pair("A", "x", run([err("rate_limited", "too many pairing attempts", { retryAfter: 9 })]).deps)).toMatchObject({ failure: "rate_limited" });
    expect(await pair("A", "x", { fetch: (async () => Promise.reject(new Error("net"))) as unknown as typeof fetch })).toEqual({ ok: false, failure: "unreachable" });
  });
});
