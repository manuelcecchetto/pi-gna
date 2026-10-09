// Images leave the phone's JSON: method results and stream events carry `{ type: "image", url }` instead of the base64
// bytes, and the phone loads each one once from `GET /api/image/<sha256>`, which its HTTP cache keeps. A long chat with
// screenshots went from tens of MB per open to a few hundred KB (REMOTE.md "Images").
import { createHash } from "node:crypto";

/** Smaller ones (icons, thumbnails) ride inline: a request each would cost more than the bytes. */
export const MIN_INLINE_CHARS = 16 * 1024;
/** Base64 characters kept for serving, newest use last; an evicted image comes back with the next snapshot. */
const DEFAULT_CAP_CHARS = 128 * 1024 * 1024;
/** Types a browser renders as an image and never as a document. */
const SAFE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);
export const IMAGE_ID = /^[a-f0-9]{64}$/;

interface Stored {
  mimeType: string;
  data: string;
}

export class RemoteImages {
  private readonly stored = new Map<string, Stored>();
  /** Each block's id, so a block serialized again (every stream, every snapshot) is not hashed again. */
  private readonly ids = new WeakMap<object, Stored & { id: string }>();
  private chars = 0;

  constructor(private readonly cap = DEFAULT_CAP_CHARS) {}

  /** `JSON.stringify` replacer: swaps each large image block for its URL and keeps the bytes to serve. */
  readonly replacer = (_key: string, value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const block = value as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (block.type !== "image" || typeof block.data !== "string" || typeof block.mimeType !== "string") return value;
    if (block.data.length < MIN_INLINE_CHARS || !SAFE_TYPES.has(block.mimeType)) return value;
    const known = this.ids.get(block);
    // A block edited in place since is hashed again.
    const id = known?.data === block.data && known.mimeType === block.mimeType ? known.id : this.hash(block.mimeType, block.data);
    if (known?.id !== id) this.ids.set(block, { mimeType: block.mimeType, data: block.data, id });
    this.put(id, block.mimeType, block.data);
    return { ...block, data: "", url: `/api/image/${id}` };
  };

  get(id: string): { mimeType: string; bytes: Buffer } | undefined {
    const entry = this.stored.get(id);
    if (!entry) return undefined;
    this.touch(id, entry);
    return { mimeType: entry.mimeType, bytes: Buffer.from(entry.data, "base64") };
  }

  private hash(mimeType: string, data: string): string {
    // The type is part of the id: the same bytes under another type are another response.
    return createHash("sha256").update(mimeType).update("\n").update(data).digest("hex");
  }

  private put(id: string, mimeType: string, data: string) {
    const entry = this.stored.get(id);
    if (entry) this.touch(id, entry);
    else {
      this.stored.set(id, { mimeType, data });
      this.chars += data.length;
      for (const [old, kept] of this.stored) {
        if (this.chars <= this.cap || old === id) break;
        this.stored.delete(old);
        this.chars -= kept.data.length;
      }
    }
  }

  private touch(id: string, entry: Stored) {
    this.stored.delete(id);
    this.stored.set(id, entry);
  }
}
