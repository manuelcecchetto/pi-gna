// Files and photos a phone sends (`PUT /api/uploads`): stored under <userData>/remote-uploads/<device>/<uuid>/<name>
// and nowhere else. An upload is addressed by id and resolves only for the device that made it, so a phone cannot name
// a path. Old uploads are deleted at startup.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { HostError, type UploadResult } from "../shared/host-api";
import type { PickedPath } from "../shared/ipc";
import { UPLOAD_MAX_BYTES, UPLOAD_RETENTION_MS, isUploadId, sanitizeUploadName } from "../shared/uploads";
import { IMAGE_TYPES } from "./attachments";

const EXTENSION_OF = new Map(Object.entries(IMAGE_TYPES).map(([extension, mimeType]) => [mimeType, extension]));
const extensionOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".")).toLowerCase() : "");
const DEVICE_DIR = /^[A-Za-z0-9_-]{1,64}$/;

export class Uploads {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private folder(device: string, id: string): string {
    if (!DEVICE_DIR.test(device)) throw new HostError("bad_request", "invalid device");
    return join(this.dir, device, id);
  }

  /** Stream `body` into a new upload; over the cap (declared or counted) nothing stays on disk. */
  async put(device: string, rawName: unknown, rawType: unknown, body: Readable, declared?: number): Promise<UploadResult> {
    if (declared !== undefined && declared > UPLOAD_MAX_BYTES) throw new HostError("payload_too_large", "upload too large");
    // An image is told by its type, then by its extension; the stored name always carries the extension that says so.
    const mimeType = String(rawType ?? "").split(";")[0]!.trim().toLowerCase();
    let name = sanitizeUploadName(rawName);
    const suffix = EXTENSION_OF.get(mimeType);
    if (suffix && !IMAGE_TYPES[extensionOf(name)]) name += suffix;
    const id = randomUUID();
    const folder = this.folder(device, id);
    await mkdir(folder, { recursive: true });
    const path = join(folder, name);
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(path, { flags: "wx", mode: 0o600 });
        const fail = (error: Error) => {
          body.unpipe(out);
          out.destroy();
          reject(error);
        };
        body.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > UPLOAD_MAX_BYTES) fail(new HostError("payload_too_large", "upload too large"));
        });
        body.on("error", fail);
        body.on("aborted", () => fail(new HostError("bad_request", "upload interrupted")));
        out.on("error", fail);
        out.on("finish", resolve);
        body.pipe(out);
      });
      if (size === 0) throw new HostError("bad_request", "the upload is empty");
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
    const image = IMAGE_TYPES[extensionOf(name)];
    return { id, path, name, ...(image ? { image: { mimeType: image } } : {}) };
  }

  /** The upload of this device as an attachment: images carry their bytes, as `describePaths` does for the desktop. */
  async resolve(device: string, id: unknown): Promise<PickedPath> {
    if (!isUploadId(id)) throw new HostError("bad_request", "invalid upload id");
    const folder = this.folder(device, id);
    const names = await readdir(folder).catch(() => []);
    const name = names[0];
    if (!name) throw new HostError("not_found", "unknown upload");
    const path = join(folder, name);
    const mimeType = IMAGE_TYPES[extensionOf(name)];
    if (mimeType) return { path, name, isDir: false, image: { mimeType, data: (await readFile(path)).toString("base64") } };
    return { path, name, isDir: false };
  }

  async discard(device: string, id: unknown): Promise<void> {
    if (!isUploadId(id)) throw new HostError("bad_request", "invalid upload id");
    await rm(this.folder(device, id), { recursive: true, force: true });
  }

  /** Deletes uploads older than the retention, then empty device folders. Returns how many uploads went. */
  async prune(retentionMs = UPLOAD_RETENTION_MS): Promise<number> {
    let removed = 0;
    for (const device of await readdir(this.dir).catch(() => [])) {
      const devicePath = join(this.dir, device);
      for (const id of await readdir(devicePath).catch(() => [])) {
        const info = await stat(join(devicePath, id)).catch(() => undefined);
        if (info && this.now() - info.mtimeMs > retentionMs) {
          await rm(join(devicePath, id), { recursive: true, force: true });
          removed++;
        }
      }
      if (!(await readdir(devicePath).catch(() => ["x"])).length) await rm(devicePath, { recursive: true, force: true });
    }
    return removed;
  }
}
