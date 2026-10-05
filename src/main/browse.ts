// `fs.browseFolders` for phones: folders (and optionally file names) below the home folder, for the project and
// attachment pickers (dot-entries only when `hidden`). Names only, no contents; symlinks are shown but never followed out of the home folder.
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { HostError, type FolderListing } from "../shared/host-api";

const MAX_ENTRIES = 500;

export async function browse(home: string, requested: unknown, withFiles: boolean, hidden = false): Promise<FolderListing> {
  const root = await realpath(home);
  const wanted = requested === undefined || requested === "" ? root : requested;
  if (typeof wanted !== "string" || !isAbsolute(wanted) || wanted.includes("\0")) throw new HostError("bad_request", "a folder is an absolute path");
  const path = await realpath(wanted).catch(() => {
    throw new HostError("not_found", "no such folder");
  });
  if (path !== root && !path.startsWith(root + sep)) throw new HostError("forbidden", "outside the home folder");
  if (!(await stat(path)).isDirectory()) throw new HostError("bad_request", "not a folder");
  const folders: FolderListing["folders"] = [];
  const files: NonNullable<FolderListing["files"]> = [];
  const entries = (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((e) => hidden || !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (folders.length + files.length >= MAX_ENTRIES) break;
    const full = join(path, entry.name);
    let dir = entry.isDirectory();
    let file = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Follow only when the target stays below home.
      const target = await realpath(full).catch(() => undefined);
      if (!target || (target !== root && !target.startsWith(root + sep))) continue;
      const info = await stat(target).catch(() => undefined);
      dir = info?.isDirectory() ?? false;
      file = info?.isFile() ?? false;
    }
    if (dir) folders.push({ name: entry.name, path: full });
    else if (file && withFiles) files.push({ name: entry.name, path: full });
  }
  return { path, parent: path === root ? null : dirname(path), folders, ...(withFiles ? { files } : {}) };
}
