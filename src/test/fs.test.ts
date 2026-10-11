import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { assertPrivateFile } from "./fs";

it("checks actual private-file permissions and rejects public data access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pigna-test-acl-"));
  const file = join(dir, "non-secret-fixture.txt");
  // Only this disposable fixture's DACL changes. No parent/profile/machine policy is changed.
  const changeAcl = (script: string) => promisify(execFile)(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $acl = Get-Acl -LiteralPath $env:PIGNA_TEST_ACL_FILE
    ${script}
    Set-Acl -LiteralPath $env:PIGNA_TEST_ACL_FILE -AclObject $acl
  `], { env: { ...process.env, PIGNA_TEST_ACL_FILE: file }, windowsHide: true, timeout: 10_000 });
  try {
    await writeFile(file, "disposable test marker, no credentials", { mode: 0o600 });
    if (process.platform === "win32") {
      // Unlike POSIX mode bits, inherited permissions may not be private. Construct a known-private positive fixture.
      await changeAcl(`
        $acl.SetAccessRuleProtection($true, $false)
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($me, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
      `);
    }
    await assertPrivateFile(file);
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
    } else {
      // icacls changes only the DACL; Set-Acl can unnecessarily request SACL privileges on a protected file.
      await promisify(execFile)(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [file, "/grant", "*S-1-1-0:R", "/q"], { windowsHide: true, timeout: 10_000 });
    }
    await expect(assertPrivateFile(file)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
