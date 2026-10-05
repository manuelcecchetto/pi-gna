// What the phone may put on the host (`PUT /api/uploads`): names are sanitized, sizes capped, and an upload is
// addressed by an id that only the device that made it can resolve.

/** Per file, images and files alike (the desktop's image guard, MAX_IMAGE_BYTES). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Per message (client side; the host also checks it on `chat.send`). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Uploads older than this are deleted when pi-gna starts. */
export const UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const NAME_MAX = 120;

/** A file name that is safe as one path component: no separators, no control characters, no dot-only or hidden names. */
export function sanitizeUploadName(raw: unknown): string {
  let name = typeof raw === "string" ? raw : "";
  name = name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/:*?"<>|]+/g, "_").trim();
  name = name.replace(/^\.+/, "").replace(/\s+/g, " ");
  if (name.length > NAME_MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = name.slice(0, NAME_MAX - ext.length) + ext;
  }
  return name || "file";
}

export const isUploadId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
