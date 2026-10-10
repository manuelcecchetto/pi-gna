// Pinned models (UiState.models): starred in the model menus so they sort to the top, the same on every client. A pin is
// keyed `provider/id`, since one name can come from two providers; a pin whose model pi does not list now stays saved
// and is skipped in the order, like a pinned project that is gone.

export const modelKey = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

/** `provider/id`, both parts non-empty (an id may hold slashes itself: `openrouter/anthropic/claude-x`). */
export const isModelKey = (value: unknown): value is string => typeof value === "string" && value.length <= 512 && /^[^/\s]+\/\S/.test(value);

/** The pinned models first, in pin order, then the rest in pi's order. */
export function pinnedFirst<T extends { provider: string; id: string }>(models: readonly T[], pins: readonly string[]): T[] {
  if (!pins.length) return models.slice();
  const byKey = new Map(models.map((model) => [modelKey(model), model]));
  const top = pins.flatMap((pin) => byKey.get(pin) ?? []);
  const pinned = new Set(top);
  return [...top, ...models.filter((model) => !pinned.has(model))];
}
