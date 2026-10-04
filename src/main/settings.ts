// pi-gna's own settings on disk (userData/settings.json): features, appearance and task models (src/shared/settings.ts).
import { applySettingsOp, emptySettings, type Feature, FEATURE_LABELS, parseSettings, type Settings, settingsConflict, type SettingsOp } from "../shared/settings";
import type { Revved } from "../shared/host-api";
import { bridgeError, type Route } from "./bridge";
import { JsonStore } from "./store";

export class SettingsStore extends JsonStore<Settings, SettingsOp> {
  constructor(file: string, changed: (settings: Revved<Settings>) => void) {
    const parse = (raw: unknown) => {
      const { settings, dropped } = parseSettings(raw);
      return { value: settings, dropped };
    };
    super(file, { name: "settings", item: "setting", empty: emptySettings, apply: applySettingsOp, parse, conflicts: settingsConflict }, changed);
  }

  /** A feature's bridge route, refused while the feature is off: chats opened before you turned it off still have
   * its tools. */
  gate(feature: Feature, route: Route): Route {
    return async (handle, body) => {
      if (!(await this.get()).features[feature]) throw bridgeError(403, `${FEATURE_LABELS[feature]} is turned off in pi-gna's Settings`);
      return route(handle, body);
    };
  }
}
