import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommand, shimScript, which } from "./command";

// What npm's cmd-shim writes for a global `pi` (pnpm's shims use "%~dp0\..." instead).
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*
`;

let dir: string;
let cli: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pigna-command-"));
  cli = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  mkdirSync(join(cli, ".."), { recursive: true });
  writeFileSync(cli, "");
  // npm writes all three next to each other.
  writeFileSync(join(dir, "pi"), "#!/bin/sh\n");
  writeFileSync(join(dir, "pi.ps1"), "");
  writeFileSync(join(dir, "pi.cmd"), NPM_SHIM);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveCommand", () => {
  it("spawns a command as is outside Windows", () => {
    expect(resolveCommand("pi", ["--mode", "rpc"], { PATH: dir }, "darwin")).toEqual({ file: "pi", args: ["--mode", "rpc"] });
  });

  it("runs an npm .cmd shim's script with node instead of through a shell", () => {
    const env = { PATH: `C:\\nowhere;${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(resolveCommand("pi", ["--mode", "rpc"], env, "win32")).toEqual({ file: "node", args: [cli, "--mode", "rpc"] });
    // The shim prefers the node.exe beside it, like the shim itself.
    writeFileSync(join(dir, "node.exe"), "");
    expect(resolveCommand("pi", ["-p", "a b"], env, "win32")).toEqual({ file: join(dir, "node.exe"), args: [cli, "-p", "a b"] });
  });

  it("reads Path as Windows spells it, and leaves executables and unknown names alone", () => {
    writeFileSync(join(dir, "rg.exe"), "");
    expect(resolveCommand("rg", ["--files"], { Path: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toEqual({ file: join(dir, "rg.exe"), args: ["--files"] });
    expect(resolveCommand("nope", [], { Path: dir }, "win32")).toEqual({ file: "nope", args: [] });
  });
});

describe("which", () => {
  it("looks a bare Windows name up by PATHEXT only, so npm's sh script beside the shim is skipped", () => {
    expect(which("pi", dir, "win32", ".EXE;.CMD")).toBe(join(dir, "pi.cmd"));
    expect(which("pi.ps1", dir, "win32", ".EXE;.CMD")).toBe(join(dir, "pi.ps1"));
  });

  it.skipIf(process.platform === "win32")("needs the executable bit elsewhere", () => {
    expect(which("pi", dir, "darwin")).toBeUndefined();
    chmodSync(join(dir, "pi"), 0o755);
    expect(which("pi", `/nowhere:${dir}`, "darwin")).toBe(join(dir, "pi"));
  });
});

describe("shimScript", () => {
  it.each(["npm", "npx"])("reads Node's bundled %s launcher without mistaking the prefix helper for its CLI", (name) => {
    const script = join(dir, "node_modules", "npm", "bin", `${name}-cli.js`);
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    writeFileSync(join(dir, "node_modules", "npm", "bin", "npm-prefix.js"), "");
    const variable = `${name.toUpperCase()}_CLI_JS`;
    writeFileSync(join(dir, `${name}.cmd`), `@ECHO OFF\r\nSET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"\r\nSET "${variable}=%~dp0\\node_modules\\npm\\bin\\${name}-cli.js"\r\n"%NODE_EXE%" "%${variable}%" %*\r\n`);
    expect(shimScript(join(dir, `${name}.cmd`))).toBe(script);
    expect(resolveCommand(name, ["--version"], { PATH: dir }, "win32")).toEqual({ file: "node", args: [script, "--version"] });
  });

  it("reads pnpm's %~dp0 form, and gives up on shims it cannot read or whose script is gone", () => {
    writeFileSync(join(dir, "tool.cmd"), `@"%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\n`);
    expect(shimScript(join(dir, "tool.cmd"))).toBe(cli);
    writeFileSync(join(dir, "other.cmd"), "@echo hi\n");
    expect(shimScript(join(dir, "other.cmd"))).toBeUndefined();
    rmSync(cli);
    expect(shimScript(join(dir, "pi.cmd"))).toBeUndefined();
    expect(shimScript(join(dir, "pi"))).toBeUndefined();
  });
});
