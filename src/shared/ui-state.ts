// The user data that is not layout, the same on every client (userData/ui-state.json): pinned and hidden projects,
// pinned chats, bookmarked turns and pinned models. Main owns the file and applies every change through applyUiOp. A turn is identified by its message's
// timestamp, since item keys are assigned per load. Layout (sidebar width, panel sizes) and "seen" marks stay
// per client.
import type { UiState } from "./host-api";
import { isModelKey } from "./model-pins";

export type UiOp =
  /** Pins go below the existing ones. */
  | { type: "pin"; cwd: string }
  | { type: "unpin"; cwd: string }
  /** Move a pinned project to `index` among the pins. */
  | { type: "reorder"; cwd: string; index: number }
  /** Hiding a project also unpins it. */
  | { type: "hide"; cwd: string }
  | { type: "unhide"; cwd: string }
  /** A chat is its session file. */
  | { type: "pinChat"; session: string }
  | { type: "unpinChat"; session: string }
  | { type: "bookmark"; session: string; at: number }
  | { type: "unbookmark"; session: string; at: number }
  /** `model` is `provider/id`; pins go below the existing ones. */
  | { type: "pinModel"; model: string }
  | { type: "unpinModel"; model: string };

export class UiStateError extends Error {}

export const emptyUiState = (): UiState => ({ pins: [], hidden: [], chats: [], bookmarks: {}, models: [] });

const isPath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/") && value.length <= 4096;
const isAt = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Keeps the well-formed entries of a file (or of the window's old localStorage copies); `dropped` counts the rest. */
export function parseUiState(raw: unknown): { value: UiState; dropped: number } {
  const value = emptyUiState();
  let dropped = 0;
  const file = raw && typeof raw === "object" ? (raw as { pins?: unknown; hidden?: unknown; chats?: unknown; bookmarks?: unknown; models?: unknown }) : {};
  if (Array.isArray(file.hidden)) {
    for (const cwd of file.hidden) {
      if (isPath(cwd) && !value.hidden.includes(cwd)) value.hidden.push(cwd);
      else dropped++;
    }
  }
  if (Array.isArray(file.pins)) {
    for (const pin of file.pins) {
      if (isPath(pin) && !value.pins.includes(pin) && !value.hidden.includes(pin)) value.pins.push(pin);
      else dropped++;
    }
  }
  if (Array.isArray(file.chats)) {
    for (const session of file.chats) {
      if (isPath(session) && !value.chats.includes(session)) value.chats.push(session);
      else dropped++;
    }
  }
  if (file.bookmarks && typeof file.bookmarks === "object") {
    for (const [session, turns] of Object.entries(file.bookmarks)) {
      const kept = Array.isArray(turns) ? [...new Set(turns.filter(isAt))] : [];
      if (isPath(session) && kept.length) value.bookmarks[session] = kept;
      else dropped++;
    }
  }
  if (Array.isArray(file.models)) {
    for (const model of file.models) {
      if (isModelKey(model) && !value.models.includes(model)) value.models.push(model);
      else dropped++;
    }
  }
  return { value, dropped };
}

/** The same value when the op changes nothing; throws UiStateError for an invalid op. */
export function applyUiOp(state: UiState, op: UiOp): UiState {
  switch (op.type) {
    case "pin":
      if (!isPath(op.cwd)) throw new UiStateError("A pinned project is an absolute path");
      if (state.hidden.includes(op.cwd)) throw new UiStateError("That project is hidden");
      return state.pins.includes(op.cwd) ? state : { ...state, pins: [...state.pins, op.cwd] };
    case "unpin":
      return state.pins.includes(op.cwd) ? { ...state, pins: state.pins.filter((cwd) => cwd !== op.cwd) } : state;
    case "reorder": {
      const from = state.pins.indexOf(op.cwd);
      if (from < 0) throw new UiStateError("That project is not pinned");
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= state.pins.length) throw new UiStateError("Position out of range");
      if (from === op.index) return state;
      const pins = state.pins.filter((cwd) => cwd !== op.cwd);
      pins.splice(op.index, 0, op.cwd);
      return { ...state, pins };
    }
    case "hide":
      if (!isPath(op.cwd)) throw new UiStateError("A hidden project is an absolute path");
      return state.hidden.includes(op.cwd) ? state : { ...state, pins: state.pins.filter((cwd) => cwd !== op.cwd), hidden: [...state.hidden, op.cwd] };
    case "unhide":
      return state.hidden.includes(op.cwd) ? { ...state, hidden: state.hidden.filter((cwd) => cwd !== op.cwd) } : state;
    case "pinChat":
      if (!isPath(op.session)) throw new UiStateError("A pinned chat is a session file");
      return state.chats.includes(op.session) ? state : { ...state, chats: [...state.chats, op.session] };
    case "unpinChat":
      return state.chats.includes(op.session) ? { ...state, chats: state.chats.filter((session) => session !== op.session) } : state;
    case "bookmark": {
      if (!isPath(op.session) || !isAt(op.at)) throw new UiStateError("A bookmark is a session file and a message time");
      const current = state.bookmarks[op.session] ?? [];
      return current.includes(op.at) ? state : { ...state, bookmarks: { ...state.bookmarks, [op.session]: [...current, op.at] } };
    }
    case "unbookmark": {
      const current = state.bookmarks[op.session];
      if (!current?.includes(op.at)) return state;
      const { [op.session]: _removed, ...rest } = state.bookmarks;
      const next = current.filter((at) => at !== op.at);
      return { ...state, bookmarks: next.length ? { ...rest, [op.session]: next } : rest };
    }
    case "pinModel":
      if (!isModelKey(op.model)) throw new UiStateError("A pinned model is provider/id");
      return state.models.includes(op.model) ? state : { ...state, models: [...state.models, op.model] };
    case "unpinModel":
      return state.models.includes(op.model) ? { ...state, models: state.models.filter((model) => model !== op.model) } : state;
    default:
      // A newer client's change this host does not know.
      throw new UiStateError("Unknown change");
  }
}
