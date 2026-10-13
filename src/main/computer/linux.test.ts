import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

const { desktopFile, linuxDeps } = await import("./linux");

/** A helper source folder, a fake system interpreter and a home folder, all in a scratch directory. */
function scratch(version = 3) {
  const root = mkdtempSync(join(tmpdir(), "pigna-cu-linux-"));
  const bundled = join(root, "bundled");
  mkdirSync(join(bundled, "pigna_cu"), { recursive: true });
  writeFileSync(join(bundled, "pigna_cu", "__main__.py"), `PROTOCOL = 1\nHELPER_VERSION = ${version}\n`);
  writeFileSync(join(bundled, "pigna_cu", "eis.py"), "# eis\n");
  const python = join(root, "python3.99");
  writeFileSync(python, "#!/bin/sh\n# a stand-in interpreter\n");
  chmodSync(python, 0o755);
  const home = join(root, "home");
  const refresh = vi.fn(async () => undefined);
  const deps = linuxDeps(bundled, join(root, "sockets"), { home, python: async () => python, refresh });
  return { root, bundled, python, home, refresh, deps, installed: join(home, ".pi-gna", "computer-use", "linux") };
}

describe("Linux Computer Use helper install", () => {
  it("installs under ~/.pi-gna/computer-use/linux with its own interpreter and authorizes it for KWin screenshots", async () => {
    const { deps, bundled, python, home, refresh, installed } = scratch();
    expect(join(deps.installDir, deps.appName ?? "")).toBe(installed);
    expect(await deps.readVersion(bundled)).toBe(3);
    expect(await deps.readVersion(installed)).toBeUndefined();
    await deps.install(bundled, installed);
    expect(readFileSync(join(installed, "pigna_cu", "eis.py"), "utf8")).toBe("# eis\n");
    expect(statSync(join(installed, "pigna-computer-use")).size).toBe(statSync(python).size);
    const desktop = readFileSync(desktopFile(home), "utf8");
    expect(desktop).toContain(`Exec=${join(installed, "pigna-computer-use")}\n`);
    expect(desktop).toContain("X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2\n");
    expect(desktop).toContain("NoDisplay=true\n");
    expect(refresh).toHaveBeenCalledOnce();
    expect(await deps.readVersion(installed)).toBe(3);
  });

  it("counts an install whose interpreter copy no longer matches the system's as missing (a Python upgrade)", async () => {
    const { deps, bundled, python, installed } = scratch();
    await deps.install(bundled, installed);
    writeFileSync(python, "#!/bin/sh\n# the upgraded interpreter is bigger\n# really\n");
    expect(await deps.readVersion(installed)).toBeUndefined();
  });

  it("reads no version from a folder without the helper", async () => {
    const { deps, root } = scratch();
    expect(await deps.readVersion(join(root, "nowhere"))).toBeUndefined();
  });
});
