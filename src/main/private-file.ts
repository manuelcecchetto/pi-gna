// Private, exclusive temporary files for atomic saves. chmod(0600) does not restrict a Windows DACL.
// Windows' stock .NET Framework FileStream can create a file with its DACL already attached: no write-then-harden
// interval, shell interpolation, elevation or changes to parent/user-profile permissions. Contents travel on stdin.
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const CREATE_PRIVATE = `
$ErrorActionPreference = 'Stop'
$stream = $null
try {
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($user)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
  $stream = [System.IO.FileStream]::new($env:PIGNA_PRIVATE_FILE, [System.IO.FileMode]::CreateNew,
    [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None,
    4096, [System.IO.FileOptions]::None, $acl)
  $actual = $stream.GetAccessControl()
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) {
    throw 'File system did not preserve the private security descriptor'
  }
  $rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $user.Value -or $rules[0].AccessControlType -ne 'Allow') {
    throw 'File system did not preserve the private access rule'
  }
  [Console]::OpenStandardInput().CopyTo($stream)
  $stream.Flush($true)
} catch {
  if ($null -ne $stream) {
    $stream.Dispose()
    [System.IO.File]::Delete($env:PIGNA_PRIVATE_FILE)
  }
  throw
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
`;
const ARGS = ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(CREATE_PRIVATE, "utf16le").toString("base64")];
const powershell = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const options = (file: string) => ({ env: { ...process.env, PIGNA_PRIVATE_FILE: file }, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
const failure = () => new Error("Could not create a protected Windows file; the save was refused. Windows PowerShell and a file system supporting private ACLs are required.");

/** Create, never overwrite. POSIX callers may preserve an existing mode; new files default to 0600.
 * The caller owns the random temporary path and renames the completed file over its destination. */
export async function writePrivateFile(file: string, data: string, mode = 0o600): Promise<void> {
  if (process.platform !== "win32") return writeFile(file, data, { flag: "wx", mode });
  await new Promise<void>((resolve, reject) => {
    const child = execFile(powershell(), ARGS, options(file), (error) => error ? reject(failure()) : resolve());
    // If the protected open fails, stdin may close before consuming the payload; the process callback reports it.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(data);
  });
}

/** Synchronous counterpart for the existing push-store save boundary. */
export function writePrivateFileSync(file: string, data: string): void {
  if (process.platform !== "win32") return writeFileSync(file, data, { flag: "wx", mode: 0o600 });
  try {
    execFileSync(powershell(), ARGS, { ...options(file), input: data, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw failure();
  }
}
