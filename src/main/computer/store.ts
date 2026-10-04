// The Computer Use policy on disk (userData/computer-use.json): the enable flag and the always-allowed apps.
import { applyComputerOp, type ComputerOp, type ComputerSettings, emptyComputerSettings, parseComputerSettings } from "../../shared/computer";
import type { Revved } from "../../shared/host-api";
import { JsonStore } from "../store";

export class ComputerStore extends JsonStore<ComputerSettings, ComputerOp> {
  constructor(file: string, changed: (settings: Revved<ComputerSettings>) => void) {
    const parse = (raw: unknown) => {
      const { settings, dropped } = parseComputerSettings(raw);
      return { value: settings, dropped };
    };
    super(file, { name: "computer-use", item: "app", empty: emptyComputerSettings, apply: applyComputerOp, parse }, changed);
  }
}
