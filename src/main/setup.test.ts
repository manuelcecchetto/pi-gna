import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSetup } from "./setup";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

// Fake node, npm and pi as shell scripts on a PATH of their own, so nothing real is checked or installed.
let dir: string;
let bin: string;
let saved: { PATH?: string; PIGNA_PI_BIN?: string };

const script = (name: string, body: string, where = bin) => {
  writeFileSync(join(where, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(where, name), 0o755);
};

/** npm: `--version`, `prefix -g` (the scratch prefix) and `install` (prints, counts runs, installs a fake pi into the prefix). */
const fakeNpm = (install: string) =>
  script(
    "npm",
    `case "$1" in
  --version) echo 10.9.0 ;;
  prefix) echo "${dir}/prefix" ;;
  install) echo run >> "${dir}/runs"; ${install} ;;
esac`,
  );

/** What a successful install leaves: pi in the prefix, inside its package (so its SDK is found). */
const INSTALLS_PI = `mkdir -p "${"$DIR"}/prefix/lib/pi/bin" "${"$DIR"}/prefix/bin"
echo '{"name":"@earendil-works/pi-coding-agent"}' > "${"$DIR"}/prefix/lib/pi/package.json"
printf '#!/bin/sh\\necho 1.0.4\\n' > "${"$DIR"}/prefix/lib/pi/bin/pi"; chmod +x "${"$DIR"}/prefix/lib/pi/bin/pi"
ln -sf "${"$DIR"}/prefix/lib/pi/bin/pi" "${"$DIR"}/prefix/bin/pi"`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pigna-setup-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  saved = { PATH: process.env.PATH, PIGNA_PI_BIN: process.env.PIGNA_PI_BIN };
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  delete process.env.PIGNA_PI_BIN;
  process.env.DIR = dir;
  script("node", "echo v22.19.0");
});

afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.PIGNA_PI_BIN === undefined) delete process.env.PIGNA_PI_BIN;
  else process.env.PIGNA_PI_BIN = saved.PIGNA_PI_BIN;
  delete process.env.DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("status", () => {
  it("finds node, npm, pi and pi's package", async () => {
    fakeNpm("true");
    mkdirSync(join(dir, "pkg", "bin"), { recursive: true });
    writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    script("pi", "echo 1.0.0", join(dir, "pkg", "bin"));
    process.env.PATH = `${join(dir, "pkg", "bin")}:${process.env.PATH}`;
    expect(await new PiSetup({ onLine: () => undefined }).status()).toMatchObject({ node: { version: "22.19.0", ok: true }, npm: true, pi: { version: "1.0.0" }, sdk: true });
  });

  it("tells missing from broken and too old", async () => {
    script("node", "echo v20.11.1");
    let status = await new PiSetup({ onLine: () => undefined }).status();
    expect(status).toMatchObject({ node: { version: "20.11.1", ok: false }, npm: false, pi: null, sdk: false });
    script("pi", "echo boom >&2; exit 3");
    status = await new PiSetup({ onLine: () => undefined }).status();
    expect(status.pi).toMatchObject({ error: expect.stringMatching(/\nboom$/) });
  });

  it("calls a pi that does not answer broken", async () => {
    script("pi", "exec sleep 5");
    const status = await new PiSetup({ onLine: () => undefined, checkMs: 1000 }).status();
    expect(status.pi).toEqual({ error: "no answer in 1 s" });
  });
});

describe("installPi", () => {
  it("installs, streams npm's lines and puts its bin on PATH once", async () => {
    fakeNpm(`printf 'one\\ntwo\\r\\nthr'; sleep 0.1; printf 'ee\\n'; echo warn >&2; printf 'last'; ${INSTALLS_PI}`);
    const lines: string[] = [];
    const setup = new PiSetup({ onLine: (line) => lines.push(line) });
    const [a, b] = [setup.installPi(), setup.installPi()];
    expect(a).toBe(b);
    expect(await a).toEqual({ ok: true });
    expect(lines).toEqual(expect.arrayContaining(["one", "two", "three", "warn", "last"]));
    expect(lines).toHaveLength(5);
    expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\n");
    const prefixBin = join(dir, "prefix", "bin");
    expect(process.env.PATH?.split(":").filter((entry) => entry === prefixBin)).toHaveLength(1);
    expect(process.env.PATH?.endsWith(prefixBin)).toBe(true);
    // pi is there now: a second install does not run npm again.
    expect(await setup.installPi()).toEqual({ ok: true });
    expect(readFileSync(join(dir, "runs"), "utf8")).toBe("run\n");
  });

  it("keeps a character split across chunks whole", async () => {
    fakeNpm(`printf '\\342\\234'; sleep 0.1; printf '\\223 done\\n'; ${INSTALLS_PI}`);
    const lines: string[] = [];
    await new PiSetup({ onLine: (line) => lines.push(line) }).installPi();
    expect(lines).toEqual(["✓ done"]);
  });

  it("explains a failed install", async () => {
    fakeNpm(`echo "npm error code EACCES" >&2; exit 243`);
    expect(await new PiSetup({ onLine: () => undefined }).installPi()).toEqual({ ok: false, error: expect.stringMatching(/global folder/) });
  });

  it("stops an install that hangs", async () => {
    fakeNpm("exec sleep 10");
    const result = await new PiSetup({ onLine: () => undefined, installMs: 300 }).installPi();
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/did not finish/) });
  });

  it("refuses to install over a broken pi", async () => {
    fakeNpm("true");
    script("pi", "exit 1");
    expect(await new PiSetup({ onLine: () => undefined }).installPi()).toEqual({ ok: false, error: expect.stringMatching(/already installed/) });
    expect(existsSync(join(dir, "runs"))).toBe(false);
  });

  it("says so when npm is missing", async () => {
    expect(await new PiSetup({ onLine: () => undefined }).installPi()).toEqual({ ok: false, error: expect.stringMatching(/npm.*not on your PATH/) });
  });
});
