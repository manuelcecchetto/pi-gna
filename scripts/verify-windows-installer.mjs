#!/usr/bin/env node
// Destructive installer lifecycle check ONLY on a fresh GitHub-hosted Windows runner. Never run on a user's PC.
// NSIS registers an application/uninstaller and shortcuts even with a custom /D directory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Installer lifecycle smoke is restricted to a fresh GitHub-hosted Windows runner; use the non-installing preview smoke locally.");
}
const exec = promisify(execFile);
const exists = async (file) => access(file).then(() => true, () => false);
const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// A pwsh workflow exports PSModulePath for PowerShell 7; do not feed its modules to Windows PowerShell 5.
const desktopEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
const ps = (script, env = process.env) => exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`], { env: desktopEnv(env), windowsHide: true, timeout: 30_000 });
// Refuse existing registrations/state even on a runner. A custom install directory is not sufficient isolation.
await ps(`$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');
  foreach ($key in $keys) { if (Get-ItemProperty $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'pi-gna' }) { throw 'Existing pi-gna registration; refusing install' } }
  if (Get-Process -Name 'pi-gna' -ErrorAction SilentlyContinue) { throw 'An existing pi-gna is running; refusing install' }`);
if (!process.env.APPDATA) throw new Error("APPDATA is missing");
const userData = join(process.env.APPDATA, "pi-gna");
assert.equal(await exists(userData), false, "Do not touch an existing pi-gna profile");
const work = await mkdtemp(join(tmpdir(), "pigna installer smoke-"));
const destination = join(work, "Application");
const executable = join(destination, "pi-gna.exe");
const installer = resolve("dist", "pi-gna-setup-x64.exe");
const env = {
  ...process.env, PIGNA_BACKGROUND: "1", PIGNA_USER_DATA: join(work, "isolated-profile"),
  PI_CODING_AGENT_DIR: join(work, "isolated-agent"), PI_CODING_AGENT_SESSION_DIR: join(work, "isolated-sessions"),
  PIGNA_CWD: work, PIGNA_PI_BIN: join(work, "no-provider.exe"), PIGNA_INSTALL_EXECUTABLE: executable,
};
delete env.PIGNA_TOKEN;
delete env.PIGNA_BRIDGE;
const marker = join(userData, "installer-smoke-marker.txt");
await mkdir(userData);
await writeFile(marker, "Existing user data must survive.");
// A silent installer may auto-start its application. Stop only PIDs whose executable is OUR installed path.
const stopOwnApp = () => ps(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:PIGNA_INSTALL_EXECUTABLE } | ForEach-Object { & "$env:SystemRoot\\System32\\taskkill.exe" /PID $_.ProcessId /T /F | Out-Null }`, env);
const checkMarker = async () => assert.equal(await readFile(marker, "utf8"), "Existing user data must survive.");
let passed = false;
try {
  for (let pass = 0; pass < 2; pass++) {
    // NSIS requires /D last and unquoted, even when the directory contains spaces; no shell is used.
    await exec(installer, ["/S", `/D=${destination}`], { env, windowsHide: true, windowsVerbatimArguments: true, timeout: 120_000 });
    assert.ok(await exists(executable), "Installer created the application at the requested path");
    await stopOwnApp();
    await checkMarker();
    assert.equal(await exists(join(destination, "resources", "computer-use")), false, "No native Computer Use helper is shipped");
    await exec(process.execPath, [resolve("scripts", "verify-windows-preview.mjs"), executable], { env, windowsHide: true, timeout: 120_000 });
  }
  const uninstaller = (await readdir(destination)).find((name) => /^Uninstall .*\.exe$/i.test(name));
  assert.ok(uninstaller, "Per-user uninstaller is present");
  await exec(join(destination, uninstaller), ["/S", `_?=${destination}`], { env, windowsHide: true, windowsVerbatimArguments: true, timeout: 120_000 });
  const deadline = Date.now() + 15_000;
  while (await exists(executable)) {
    if (Date.now() > deadline) throw new Error("Uninstall did not remove the application");
    await new Promise((done) => setTimeout(done, 200));
  }
  await checkMarker();
  console.log("PASS: fresh per-user NSIS install, packaged RPC/Kanban/preview, reinstall, uninstall and profile preservation; no Computer Use helper.");
  passed = true;
} finally {
  await stopOwnApp();
  if (passed) {
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(userData, { recursive: true, force: true }); // Only the marker directory this script exclusively created.
  } else console.error(`Installer smoke fixtures retained: ${work}`);
}
