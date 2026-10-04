// A JSON file that main owns and both the window and agents (through the bridge) change: the Kanban board and the
// laments. Every change is an op applied by a pure function that checks it; the window gets the whole value after
// each one.
//
// Every value has a revision (`rev`, see Revved): persisted in the file, 0 for files from before, +1 for each change
// that alters the value. Free-text ops may carry the `baseRev` the editor saw; the store keeps the last HISTORY values
// by rev, and the model's `conflicts` says whether the field the op replaces changed since then (docs/REMOTE.md s.9).
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { HostError, type Revved } from "../shared/host-api";
import { log } from "./log";

/** How many past revisions are kept to check a stale `baseRev` against; an older one counts as conflicting. */
const HISTORY = 64;

/** How a store's value starts, changes and is read back from disk. */
export interface StoreModel<T, Op> {
  /** For the log: "board". */
  name: string;
  /** For the log: "card", "lament". */
  item: string;
  empty(): T;
  /** Returns the same value when the op changes nothing; throws for an invalid op. */
  apply(value: T, op: Op, now: number): T;
  /** Throws when the file is not this kind of value; `dropped` counts malformed items it skipped. */
  parse(raw: unknown): { value: T; dropped: number };
  /**
   * For an op that replaces free text: whether the field it sets changed between `base` (the value the editor saw,
   * undefined when too old to know) and `current`. Left out: no op of the model conflicts.
   */
  conflicts?(base: T | undefined, current: T, op: Op): boolean;
}

export class JsonStore<T, Op> {
  private value: Revved<T>;
  private readonly history = new Map<number, T>();
  private readonly loaded: Promise<void>;
  private dirty = false;
  private writing?: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly model: StoreModel<T, Op>,
    private readonly changed: (value: Revved<T>) => void,
  ) {
    this.value = { ...model.empty(), rev: 0 };
    this.loaded = this.load();
  }

  async get(): Promise<Revved<T>> {
    await this.loaded;
    return this.value;
  }

  /**
   * Apply a change, save and broadcast it. Throws the model's error for an invalid op, and a `conflict` HostError
   * (detail `{ rev }`) when `baseRev` is stale and the op replaces text changed since. Without `baseRev` (agents,
   * structural ops) the change is last-writer-wins.
   */
  async apply(op: Op, baseRev?: number): Promise<Revved<T>> {
    await this.loaded;
    if (baseRev !== undefined && baseRev !== this.value.rev && this.model.conflicts?.(this.history.get(baseRev), this.value, op)) {
      throw new HostError("conflict", `Conflict: this ${this.model.name} changed elsewhere (revision ${this.value.rev}, you had ${baseRev})`, { rev: this.value.rev });
    }
    const { rev, ...current } = this.value;
    const next = this.model.apply(current as T, op, Date.now());
    if (next === (current as T)) return this.value;
    this.history.set(rev, current as T);
    this.history.delete(rev - HISTORY);
    this.value = { ...next, rev: rev + 1 };
    this.changed(this.value);
    this.dirty = true;
    this.writing ??= this.write();
    return this.value;
  }

  /** Resolves once the latest value is on disk (before quitting). */
  async flushed(): Promise<void> {
    while (this.writing) await this.writing;
  }

  /** One write at a time, always of the latest value; tmp + rename, so a crash never leaves half a file. */
  private async write(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        await writeFile(`${this.file}.tmp`, JSON.stringify(this.value, null, 2));
        await rename(`${this.file}.tmp`, this.file);
      }
    } catch (error) {
      log.error(this.model.name, `could not save ${this.file}: ${(error as Error).message}`);
    } finally {
      this.writing = undefined;
    }
  }

  private async load(): Promise<void> {
    const { name, item } = this.model;
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.error(name, `could not read ${this.file}: ${(error as Error).message}`);
      return;
    }
    // Never overwrite what we could not read: keep a copy beside the file.
    const aside = this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
    try {
      const file = JSON.parse(raw) as { rev?: unknown } | null;
      const { value, dropped } = this.model.parse(file);
      const rev = typeof file?.rev === "number" && Number.isSafeInteger(file.rev) && file.rev > 0 ? file.rev : 0;
      this.value = { ...value, rev };
      if (dropped) {
        await copyFile(this.file, aside);
        log.warn(name, `skipped ${dropped} malformed ${item}(s); the original is in ${aside}`);
      }
    } catch (error) {
      await rename(this.file, aside).catch(() => undefined);
      log.error(name, `${this.file} is not a ${name} file (${(error as Error).message}); moved it to ${aside} and started empty`);
    }
  }
}
