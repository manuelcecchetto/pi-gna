// Pinned and hidden projects and bookmarked turns on disk (userData/ui-state.json), the same on every client (src/shared/ui-state.ts).
import type { UiState } from "../shared/host-api";
import type { Revved } from "../shared/host-api";
import { applyUiOp, emptyUiState, parseUiState, type UiOp } from "../shared/ui-state";
import { JsonStore } from "./store";

export class UiStateStore extends JsonStore<UiState, UiOp> {
  constructor(file: string, changed: (ui: Revved<UiState>) => void) {
    super(file, { name: "ui-state", item: "entry", empty: emptyUiState, apply: (value, op) => applyUiOp(value, op), parse: parseUiState }, changed);
  }

  /**
   * Merge what the window kept in localStorage before the host did (once per window; main cannot tell, so the
   * renderer forgets its copy after). Pins and bookmarks already here win and the old ones only add.
   */
  async importLegacy(raw: unknown): Promise<void> {
    const { value } = parseUiState(raw);
    for (const cwd of value.pins) await this.apply({ type: "pin", cwd });
    for (const [session, turns] of Object.entries(value.bookmarks)) for (const at of turns) await this.apply({ type: "bookmark", session, at });
  }
}
