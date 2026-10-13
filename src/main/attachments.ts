// Turn file-system paths (native picker, drag and drop, pasted Finder files) into composer attachments:
// folders and files are referenced by path, images also carry their bytes so the model can see them.
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { PickedPath } from "../shared/ipc";

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** pi downsizes images itself (images.autoResize); this only guards against absurd files. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export async function describePaths(paths: string[]): Promise<PickedPath[]> {
  const described = await Promise.all(
    paths.filter((path) => typeof path === "string" && isAbsolute(path)).map(async (path): Promise<PickedPath | undefined> => {
      const info = await stat(path).catch(() => undefined);
      if (!info) return undefined;
      const name = basename(path);
      if (info.isDirectory()) return { path, name, isDir: true };
      const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
      if (mimeType && info.size <= MAX_IMAGE_BYTES) {
        return { path, name, isDir: false, image: { mimeType, data: (await readFile(path)).toString("base64") } };
      }
      return { path, name, isDir: false };
    }),
  );
  return described.filter((item): item is PickedPath => item !== undefined);
}

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_TYPES).map((ext) => ext.slice(1));

/** The native picker behind the composer's attach button ("files") and Add photos ("photos"). */
export function attachDialog(kind: "photos" | "files", platform: string): { title: string; properties: ("openFile" | "openDirectory" | "multiSelections")[]; filters?: { name: string; extensions: string[] }[] } {
  if (kind === "photos") return { title: "Add photos", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] };
  // The Linux file chooser (the desktop portal) picks either files or folders, and asked for both it shows folders only.
  if (platform === "linux") return { title: "Attach files", properties: ["openFile", "multiSelections"] };
  return { title: "Attach files and folders", properties: ["openFile", "openDirectory", "multiSelections"] };
}
