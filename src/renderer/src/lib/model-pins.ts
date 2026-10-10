// Pinned models (src/shared/model-pins.ts) in the host's ui state, so every client sorts them the same.
import type { Model } from "../../../shared/protocol";
import { modelKey } from "../../../shared/model-pins";
import { applyUi, uiStore } from "./host-ui";
import { useStore } from "./store";

export function usePinnedModels(): string[] {
  return useStore(uiStore, (state) => state.models);
}

export function toggleModelPin(model: Model): void {
  const key = modelKey(model);
  applyUi({ type: uiStore.get().models.includes(key) ? "unpinModel" : "pinModel", model: key });
}
