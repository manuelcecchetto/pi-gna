import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedPi === undefined) delete process.env.PIGNA_PI_BIN;
    else process.env.PIGNA_PI_BIN = savedPi;
    rmSync(dir, { recursive: true, force: true });
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

  it("keeps other results when an unknown cmd shim throws synchronously", async () => {
    writeFileSync(join(bin, "npm.cmd"), "@echo unsupported\r\n");
    expect(await new PiSetup({ onLine: () => undefined }).status()).toMatchObject({ node: { ok: true }, npm: false, pi: null });
  });
});
