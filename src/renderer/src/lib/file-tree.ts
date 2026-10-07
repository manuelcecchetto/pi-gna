// Folder view over the flat project file list (`rg --files`): folders are the parents of listed files.

export interface TreeEntry {
  /** Path relative to the project, without a trailing slash. */
  path: string;
  folder: boolean;
}

/** The entries directly inside `dir` ("" for the project root): folders first, then files, each by name. */
export function folderEntries(files: string[], dir: string): TreeEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Set<string>();
  const leaves: string[] = [];
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) leaves.push(file);
    else folders.add(prefix + rest.slice(0, slash));
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return [...[...folders].sort(byName).map((path) => ({ path, folder: true })), ...leaves.sort(byName).map((path) => ({ path, folder: false }))];
}

/** Every file and folder below `dir`, for searching it. */
export function entriesBelow(files: string[], dir: string): TreeEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Set<string>();
  const entries: TreeEntry[] = [];
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    entries.push({ path: file, folder: false });
    for (let slash = file.indexOf("/", prefix.length); slash !== -1; slash = file.indexOf("/", slash + 1)) folders.add(file.slice(0, slash));
  }
  return [...[...folders].map((path) => ({ path, folder: true })), ...entries];
}

/** The parent folder of `path` ("" at the root). */
export function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
