// The laments on disk (userData/laments.json) and POST /lament on the agent bridge: the lament tool. The calling
// chat is the session behind the token; its lament goes on its project's board (projectOf: a card's worktree counts
// as its project).
import { projectOf } from "../shared/board";
import {
  applyLamentOp,
  emptyLaments,
  freshLamentId,
  type Lament,
  type LamentOp,
  type LamentRequest,
  type LamentResponse,
  type Laments,
  lamentSeverity,
  parseLaments,
  projectLaments,
  SEVERITY,
} from "../shared/laments";
import { bridgeError, type Route } from "./bridge";
import type { Identify } from "./kanban";
import { JsonStore } from "./store";

export class LamentStore extends JsonStore<Laments, LamentOp> {
  constructor(file: string, changed: (laments: Laments) => void) {
    const parse = (raw: unknown) => {
      const { laments, dropped } = parseLaments(raw);
      return { value: laments, dropped };
    };
    super(file, { name: "laments", item: "lament", empty: emptyLaments, apply: applyLamentOp, parse }, changed);
  }
}

/** Open laments the reply names, so the agent can pass one as `repeats` when it hits the same gap. */
const SHOWN_OPEN = 8;

export function lamentRoute(store: LamentStore, identify: Identify): Route {
  return async (handle, body): Promise<LamentResponse> => {
    const request = body as LamentRequest;
    const chat = await identify(handle);
    const project = projectOf(chat.cwd);
    const from = { path: chat.path, cwd: chat.cwd };
    let id = request?.repeats;
    let filed: string;
    if (id) {
      const lament = (await store.get()).laments.find((other) => other.id === id && other.cwd === project);
      if (!lament) throw bridgeError(404, `No lament ${id} on this project's Lamenting board; leave repeats out to file a new one.`);
      await store.apply({ type: "repeat", id, text: request.body, severity: request.severity, chat: from });
      filed = `Added to lament ${id} (${lament.title})${lament.resolvedAt ? ", which was resolved and is open again" : ""}`;
    } else {
      id = freshLamentId(await store.get());
      await store.apply({ type: "file", id, title: request?.title, text: request?.body, severity: request?.severity, cwd: project, chat: from });
      filed = `Filed lament ${id}`;
    }
    const lament = (await store.get()).laments.find((other) => other.id === id) as Lament;
    const severity = SEVERITY[lamentSeverity(lament)];
    const others = projectLaments(await store.get(), project).filter((other) => other.id !== id);
    const lines = [`${filed} on the Lamenting board of ${project}: ${severity.emoji} ${severity.label}. The user reads it there; carry on with your workaround.`];
    if (others.length) {
      lines.push("", `Other open laments of this project (pass the id as repeats if you hit one of them):`);
      for (const other of others.slice(0, SHOWN_OPEN)) lines.push(`- ${other.id} ${SEVERITY[lamentSeverity(other)].emoji} ${other.title}${other.reports.length > 1 ? ` (×${other.reports.length})` : ""}`);
      if (others.length > SHOWN_OPEN) lines.push(`- … ${others.length - SHOWN_OPEN} more`);
    }
    return { text: lines.join("\n"), lament: id };
  };
}
