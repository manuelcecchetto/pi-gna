// Screenshots attached to a card when it is added (AddCard): saved in userData/card-images/<card id>/ and listed
// by path in the card's notes, so its chats read them with pi's tools, the way pi's own Ctrl+V puts an image's path
// in the prompt. Not in os.tmpdir() like pi's: macOS empties that after three days, and a card can wait for weeks.
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCardId } from "../shared/board";
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "./attachments";

const EXTENSIONS = new Map(Object.entries(IMAGE_TYPES).map(([extension, mimeType]) => [mimeType, extension]));

export class CardImages {
  constructor(private readonly dir: string) {}

  /** Save one image for the card and return its path. Throws for an invalid card id, type or size. */
  async save(card: string, image: { mimeType: string; data: string }): Promise<string> {
    if (!isCardId(card)) throw new Error(`invalid card id ${String(card)}`);
    const extension = EXTENSIONS.get(image?.mimeType);
    if (!extension) throw new Error(`not an image pi can read: ${String(image?.mimeType)}`);
    const bytes = Buffer.from(typeof image.data === "string" ? image.data : "", "base64");
    if (!bytes.length) throw new Error("the image is empty");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`the image is too large (${Math.round(bytes.length / 1024 / 1024)} MB)`);
    const folder = join(this.dir, card);
    await mkdir(folder, { recursive: true });
    const path = join(folder, `image-${randomUUID()}${extension}`);
    await writeFile(path, bytes);
    return path;
  }

  /** Delete the card's images, with the card. */
  async remove(card: string): Promise<void> {
    if (isCardId(card)) await rm(join(this.dir, card), { recursive: true, force: true });
  }
}
