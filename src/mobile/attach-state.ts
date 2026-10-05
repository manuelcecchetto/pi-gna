// The phone's composer attachments: a photo or file uploads to the host as soon as it is picked; a host file or
// folder is just a path. `chat.send` names them as refs, and the host composes the message.
import type { AttachmentRef } from "../shared/host-api";
import { MAX_ATTACHMENTS_PER_MESSAGE, UPLOAD_MAX_BYTES } from "../shared/uploads";

export interface Attached {
  /** Local key. */
  key: string;
  name: string;
  /** From the phone (`upload`) or already on the host (`path`). */
  source: "upload" | "host";
  isDir?: boolean;
  image?: boolean;
  state: "uploading" | "ready" | "error";
  ref?: AttachmentRef;
  error?: string;
}

let seq = 0;
export const nextKey = () => `att${++seq}`;

/** What the next send carries; empty while nothing is ready. */
export const readyRefs = (list: Attached[]): AttachmentRef[] => list.flatMap((a) => (a.state === "ready" && a.ref ? [a.ref] : []));

export const uploading = (list: Attached[]) => list.some((a) => a.state === "uploading");

/** Why a file cannot be attached, before any bytes move. */
export function refusal(list: Attached[], file: { name: string; size: number }): string | undefined {
  if (list.length >= MAX_ATTACHMENTS_PER_MESSAGE) return `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`;
  if (file.size > UPLOAD_MAX_BYTES) return `${file.name} is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MB`;
  if (file.size === 0) return `${file.name} is empty`;
  return undefined;
}

/** A host path attached once. */
export function addHostPath(list: Attached[], item: { name: string; path: string; isDir: boolean }): Attached[] {
  if (list.some((a) => a.ref && "path" in a.ref && a.ref.path === item.path)) return list;
  if (list.length >= MAX_ATTACHMENTS_PER_MESSAGE) return list;
  return [...list, { key: nextKey(), name: item.name, source: "host", isDir: item.isDir, state: "ready", ref: { path: item.path } }];
}
