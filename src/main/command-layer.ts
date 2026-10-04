// What every host call shares: retry-safe results (idempotency keys) and ordered chat edits (a mutex).
import { HostError, IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS } from "../shared/host-api";

/** Results larger than this are not kept (a retry then tells the client to refetch state). */
const MAX_CACHED_BYTES = 256 * 1024;

interface Entry {
  fingerprint: string;
  expires: number;
  /** In flight, or the finished result; `unavailable` when it was too large to keep. */
  promise: Promise<unknown>;
  settled: boolean;
  unavailable: boolean;
}

/**
 * Remembers the result of each keyed call for ten minutes, so a client that lost the response and retries gets the
 * same answer instead of running the call twice. Scoped per device (or chat/store); the cache dies with the process,
 * and `bootId` is how a retry learns that: a key sent with another boot's id fails `host_restarted`.
 */
export class IdempotencyCache {
  private readonly scopes = new Map<string, Map<string, Entry>>();

  constructor(
    readonly bootId: string,
    private readonly now: () => number = Date.now,
    private readonly ttl = IDEMPOTENCY_TTL_MS,
    private readonly maxEntries = IDEMPOTENCY_MAX_ENTRIES,
  ) {}

  /**
   * Run `fn` once per (scope, key). `seenBoot` is the boot id the client last saw; `fingerprint` identifies the
   * request body, so a key reused for a different call is refused. Failures are not kept: a retry runs again.
   */
  async run<T>(scope: string, key: string, seenBoot: string | undefined, fingerprint: string, fn: () => Promise<T>): Promise<T> {
    if (seenBoot !== undefined && seenBoot !== this.bootId) throw new HostError("host_restarted", "pi-gna restarted; check the chat before sending again");
    const entries = this.scopes.get(scope) ?? new Map<string, Entry>();
    this.scopes.set(scope, entries);
    const now = this.now();
    for (const [k, entry] of entries) if (entry.settled && entry.expires <= now) entries.delete(k);

    const known = entries.get(key);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new HostError("bad_request", "idempotency key reused for a different request", { reason: "idempotency_mismatch" });
      entries.delete(key);
      entries.set(key, known); // most recently used last
      if (known.unavailable) throw new HostError("conflict", "the result of this call is no longer available", { reason: "result_unavailable" });
      return known.promise as Promise<T>;
    }

    const entry: Entry = { fingerprint, expires: Infinity, promise: Promise.resolve(), settled: false, unavailable: false };
    entry.promise = fn().then(
      (result) => {
        entry.settled = true;
        entry.expires = this.now() + this.ttl;
        if (JSON.stringify(result ?? null).length > MAX_CACHED_BYTES) {
          entry.unavailable = true;
          entry.promise = Promise.resolve();
        }
        return result;
      },
      (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      },
    );
    entries.set(key, entry);
    while (entries.size > this.maxEntries) entries.delete(entries.keys().next().value as string);
    return entry.promise as Promise<T>;
  }
}

/** Runs tasks one after another per key (a chat), whatever they await. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
