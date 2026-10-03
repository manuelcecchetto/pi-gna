// A JSON file that main owns and both the window and agents (through the bridge) change: the Kanban board and the
// laments. Every change is an op applied by a pure function that checks it; the window gets the whole value after
// each one.
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { log } from "./log";

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
}

export class JsonStore<T, Op> {
  private value: T;
  private readonly loaded: Promise<void>;
  private dirty = false;
  private writing?: Promise<void>;

  constructor(
    private readonly file: string,
    private readonly model: StoreModel<T, Op>,
    private readonly changed: (value: T) => void,
  ) {
    this.value = model.empty();
    this.loaded = this.load();
  }

  async get(): Promise<T> {
    await this.loaded;
    return this.value;
  }

  /** Apply a change, save and broadcast it. Throws the model's error for an invalid op. */
  async apply(op: Op): Promise<T> {
    await this.loaded;
    const next = this.model.apply(this.value, op, Date.now());
    if (next === this.value) return next;
    this.value = next;
    this.changed(next);
    this.dirty = true;
    this.writing ??= this.write();
    return next;
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
      const { value, dropped } = this.model.parse(JSON.parse(raw));
      this.value = value;
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
