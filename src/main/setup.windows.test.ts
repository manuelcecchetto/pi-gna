import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSetup } from "./setup";

vi.mock("./log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

describe.skipIf(process.platform !== "win32")("Windows setup", () => {
  let dir: string;
  let bin: string;
  let prefix: string;
  let savedPath: string | undefined;
  let savedPi: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pigna-windows-"));
    bin = join(dir, "Node with spaces");
    prefix = join(dir, "npm global");
    mkdirSync(bin);
    copyFileSync(process.execPath, join(bin, "node.exe"));
    savedPath = process.env.PATH;
    savedPi = process.env.PIGNA_PI_BIN;
    process.env.PATH = bin;
    delete process.env.PIGNA_PI_BIN;
    const npmDir = join(bin, "node_modules", "npm", "bin");
    mkdirSync(npmDir, { recursive: true });
    writeFileSync(join(bin, "npm.cmd"), '@ECHO OFF\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n');
    writeFileSync(join(npmDir, "npm-prefix.js"), 'throw new Error("Wrong entry point");');
    // Fixture-only npm: never contacts a registry or installs real software.
    writeFileSync(join(npmDir, "npm-cli.js"), [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const prefix = " + JSON.stringify(prefix) + ";",
      "if (process.argv[2] === '--version') console.log('11.7.0');",
      "else if (process.argv[2] === 'prefix') console.log(prefix);",
      "else if (process.argv[2] === 'install') {",
      "const pkg = path.join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent');",
      "fs.mkdirSync(pkg, { recursive: true });",
      "fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));",
      "fs.writeFileSync(path.join(pkg, 'cli.js'), 'console.log(\"1.0.4\");');",
      "fs.writeFileSync(path.join(prefix, 'pi.cmd'), " + JSON.stringify('@"%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\cli.js" %*\r\n') + ");",
      "console.log('fixture installed');",
      "}",
    ].join("\n"));
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedPi === undefined) delete process.env.PIGNA_PI_BIN;
    else process.env.PIGNA_PI_BIN = savedPi;
    // Yield so Windows can close the killed process/image handles before deleting the copied node.exe.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("checks bundled npm and discovers installed pi at the Windows prefix root", async () => {
    const setup = new PiSetup({ onLine: () => undefined });
    expect(await setup.status()).toMatchObject({ node: { ok: true }, npm: true, pi: null });
    expect(await setup.installPi()).toEqual({ ok: true });
    expect(process.env.PATH).toBe(bin + ";" + prefix);
    expect(await setup.status()).toMatchObject({ npm: true, pi: { version: "1.0.4" }, sdk: true });
    expect(await setup.installPi()).toEqual({ ok: true });
    expect(process.env.PATH).toBe(bin + ";" + prefix);
  });

  const overrideInstall = (body: string) => {
    const cli = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
    writeFileSync(cli, `if (process.argv[2] === 'install') { ${body} } else { ${readFileSync(cli, "utf8")} }`);
  };
  const fakePi = (body: string) => {
    writeFileSync(join(bin, "pi.js"), body);
    writeFileSync(join(bin, "pi.cmd"), '@echo off\r\nnode "%~dp0\\pi.js" %*\r\n');
  };

  it("joins concurrent installs and streams split Unicode, CRLF, stderr and the final partial line", async () => {
    const runs = join(dir, "runs");
    overrideInstall(`require('fs').appendFileSync(${JSON.stringify(runs)}, 'run\\n');
      process.stdout.write(Buffer.from([0xe2,0x9c]));
      setTimeout(() => { process.stdout.write(Buffer.from([0x93])); process.stdout.write(' done\\r\\nlast'); process.stderr.write('warn\\n'); }, 100);`);
    const lines: string[] = [];
    const setup = new PiSetup({ onLine: (line) => lines.push(line) });
    const first = setup.installPi();
    expect(setup.installPi()).toBe(first);
    expect(await first).toEqual({ ok: true });
    expect(lines).toEqual(expect.arrayContaining(["✓ done", "warn", "last"]));
    expect(lines).toHaveLength(3);
    expect(readFileSync(runs, "utf8")).toBe("run\n");
  });

  it("explains a failed install without running a real npm", async () => {
    overrideInstall("console.error('npm error code EACCES'); process.exit(243);");
    expect(await new PiSetup({ onLine: () => undefined }).installPi()).toEqual({ ok: false, error: expect.stringMatching(/global folder/) });
  });

  it("stops an install that hangs", async () => {
    overrideInstall("setInterval(() => {}, 1000);");
    expect(await new PiSetup({ onLine: () => undefined, installMs: 300 }).installPi()).toEqual({ ok: false, error: expect.stringMatching(/did not finish/) });
  });

  it("reports a pi that does not answer as broken", async () => {
    fakePi("setInterval(() => {}, 1000);");
    expect((await new PiSetup({ onLine: () => undefined, checkMs: 1000 }).status()).pi).toEqual({ error: "no answer in 1 s" });
  });

  it("does not install over a broken pi", async () => {
    fakePi("console.error('boom'); process.exit(3);");
    const runs = join(dir, "runs");
    overrideInstall(`require('fs').writeFileSync(${JSON.stringify(runs)}, 'unexpected');`);
    const setup = new PiSetup({ onLine: () => undefined });
    expect((await setup.status()).pi).toMatchObject({ error: expect.stringMatching(/boom/) });
    expect(await setup.installPi()).toEqual({ ok: false, error: expect.stringMatching(/already installed/) });
    expect(existsSync(runs)).toBe(false);
  });

  it("explains a missing npm", async () => {
    rmSync(join(bin, "npm.cmd"));
    expect(await new PiSetup({ onLine: () => undefined }).installPi()).toEqual({ ok: false, error: expect.stringMatching(/npm.*not on your PATH/) });
  });

  it("returns an install failure instead of rejecting on a synchronous cmd spawn error", async () => {
    writeFileSync(join(bin, "npm.cmd"), "@echo unsupported\r\n");
    expect(await new PiSetup({ onLine: () => undefined }).installPi()).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("keeps other results when an unknown cmd shim throws synchronously", async () => {
    writeFileSync(join(bin, "npm.cmd"), "@echo unsupported\r\n");
    expect(await new PiSetup({ onLine: () => undefined }).status()).toMatchObject({ node: { ok: true }, npm: false, pi: null });
  });
});
