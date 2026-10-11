import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

/** Check the real privacy boundary: POSIX mode bits, or the Windows DACL. Windows chmod(0600) is not a DACL.
 * This only inspects disposable test files; it never changes machine policy or enables Developer Mode. */
export async function assertPrivateFile(file: string): Promise<void> {
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    return;
  }
  const script = `
    $ErrorActionPreference = 'Stop'
    $allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    $acl = Get-Acl -LiteralPath $env:PIGNA_TEST_ACL_FILE
    if ($acl.Access.Count -eq 0 -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed) {
      throw 'Private file has no access rules or an untrusted owner'
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and ([int]$rule.FileSystemRights -band 7) -ne 0 -and $rule.IdentityReference.Value -notin $allowed) {
        throw 'Private file grants data access outside the current user, SYSTEM and Administrators'
      }
    }
  `;
  await promisify(execFile)(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PIGNA_TEST_ACL_FILE: file }, windowsHide: true, timeout: 10_000,
  });
}

/** File links need a Windows privilege/Developer Mode that a standard session may not have. Only that exact
 * capability failure is skippable; filesystem mistakes still fail. A configured security runner can require it. */
export async function fileSymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM" && process.env.PIGNA_REQUIRE_FILE_SYMLINKS !== "1") return false;
    throw error;
  }
}
