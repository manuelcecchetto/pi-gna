#!/usr/bin/env node
// Launches pi-gna with this terminal as its log: main-process logs and every pi child's
// stderr print here. Ctrl-C quits. PIGNA_DEBUG=1 also prints all RPC traffic.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "out", "main", "index.js"))) {
  console.error("pi-gna is not built yet: run `pnpm build` in", root);
  process.exit(1);
}

/**
 * macOS names a running app after its bundle's Info.plist, so Electron from node_modules shows as "Electron" in the
 * Dock, ⌘Tab and the app menu. Run a clone of Electron.app named and labelled like the packaged app instead
 * (node_modules/.pigna/<productName>.app): an APFS clone takes no space, and the executable keeps its name (so
 * `app.isPackaged` stays false) and its ad-hoc linker signature, which covers neither Info.plist nor the icon.
 * Made again when Electron, the name or the icon changes; on any failure Electron runs as it is.
 */
function namedElectron(electron) {
  const source = join(electron, "..", "..", "..");
  if (process.platform !== "darwin" || !source.endsWith(".app")) return electron;
  try {
    const { productName } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const appId = readFileSync(join(root, "electron-builder.yml"), "utf8").match(/^appId:\s*(\S+)/m)?.[1];
    const icon = join(root, "build", "icon.icns");
    const bundle = join(root, "node_modules", ".pigna", `${productName}.app`);
    const stampFile = `${bundle}.stamp`;
    const stamp = JSON.stringify([realpathSync(source), statSync(join(source, "Contents", "Info.plist")).mtimeMs, productName, appId, existsSync(icon) && statSync(icon).mtimeMs]);
    if (!existsSync(bundle) || !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
      const staging = `${bundle}.${process.pid}`;
      mkdirSync(dirname(bundle), { recursive: true });
      rmSync(staging, { recursive: true, force: true });
      execFileSync("cp", ["-cR", source, staging]);
      const plist = join(staging, "Contents", "Info.plist");
      const set = (key, value) => execFileSync("plutil", ["-replace", key, "-string", value, plist]);
      set("CFBundleName", productName);
      set("CFBundleDisplayName", productName);
      // Its own identity, apart from other Electron apps run from node_modules and from the installed pi-gna.
      if (appId) set("CFBundleIdentifier", `${appId}.dev`);
      if (existsSync(icon)) copyFileSync(icon, join(staging, "Contents", "Resources", "electron.icns"));
      rmSync(bundle, { recursive: true, force: true });
      renameSync(staging, bundle);
      writeFileSync(stampFile, stamp);
    }
    return join(bundle, "Contents", "MacOS", basename(electron));
  } catch (error) {
    console.error(`pi-gna: running Electron as "Electron" (${error.message})`);
    return electron;
  }
}

const electron = namedElectron(createRequire(import.meta.url)("electron"));
const env = { ...process.env, PIGNA_CWD: process.cwd() };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: "inherit", env });
// Ctrl-C reaches the whole foreground process group; Electron shuts its pi children down.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
