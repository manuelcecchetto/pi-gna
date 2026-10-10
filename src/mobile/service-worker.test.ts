import { describe, expect, it } from "vitest";
import { type BundleFile, serviceWorkerSource, shellFiles } from "./service-worker";

const ORIGIN = "https://phone.test";
const SHELL = ["/", "/manifest.webmanifest", "/assets/index-a.js", "/assets/index-a.css"];

/** The host's tag for a file under its own name (hashed files have none), as remote-server.ts sends it. */
const tagOf = (body: string) => `W/"${body}"`;

/** Runs sw.js against an in-memory CacheStorage and a network that answers `routes` (404 otherwise, a throw offline). */
function worker(routes: Record<string, string>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const network: string[] = [];
  /** The requests that carried an If-None-Match, with it. */
  const revalidated: string[] = [];
  let offline = false;
  /** Whether the worker asked to take over at once, and how many shell caches existed then. */
  let skipped: number | undefined;
  /** The notifications shown, as title and body. */
  const shown: string[] = [];
  const fetchFake = async (input: Request | string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
    network.push(url.pathname);
    if (offline) throw new TypeError("Failed to fetch");
    const body = routes[url.pathname];
    if (body === undefined) return new Response("missing", { status: 404 });
    if (url.pathname.startsWith("/assets/")) return new Response(body);
    const asked = init?.headers?.["If-None-Match"];
    if (asked) revalidated.push(`${url.pathname} ${asked}`);
    return asked === tagOf(body) ? new Response(null, { status: 304 }) : new Response(body, { headers: { ETag: tagOf(body) } });
  };
  const keyOf = (input: Request | string) => new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
  // Opening a cache is I/O: it ends after the page has had its answer.
  const open = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return {
      match: async (input: Request | string) => store.get(keyOf(input))?.clone(),
      put: async (input: Request | string, response: Response) => void store.set(keyOf(input), response),
      addAll: async (urls: string[]) => {
        const responses = await Promise.all(urls.map((url) => fetchFake(url)));
        if (responses.some((response) => !response.ok)) throw new TypeError("addAll: a request failed");
        urls.forEach((url, index) => store.set(keyOf(url), responses[index]!));
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (input: Request | string) => {
      for (const store of stores.values()) {
        const hit = store.get(keyOf(input));
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => void (listeners[type] = listener),
    skipWaiting: async () => void (skipped = stores.size),
    // A window of the app is open and visible: pushes still show a notification.
    clients: { claim: async () => undefined, matchAll: async () => [{ visibilityState: "visible" }] },
    registration: { showNotification: async (title: string, options: { body: string }) => void shown.push(`${title}: ${options.body}`) },
  };
  new Function("self", "caches", "fetch", serviceWorkerSource("b1", SHELL))(self, caches, fetchFake);

  const extendable = () => {
    const pending: Promise<unknown>[] = [];
    return { pending, waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
  };
  return {
    stores,
    network,
    revalidated,
    skipped: () => skipped,
    shown,
    goOffline: () => void (offline = true),
    install: async () => {
      const event = extendable();
      listeners.install!(event);
      await Promise.all(event.pending);
    },
    activate: async () => {
      const event = extendable();
      listeners.activate!(event);
      await Promise.all(event.pending);
    },
    receive: async (data: unknown) => {
      const event = { ...extendable(), data: { json: () => data } };
      listeners.push!(event);
      await Promise.all(event.pending);
    },
    /** The worker's answer, or undefined when it leaves the request to the browser. */
    get: async (path: string, init: { method?: string; mode?: "navigate"; origin?: string } = {}) => {
      const event = { ...extendable(), request: { url: (init.origin ?? ORIGIN) + path, method: init.method ?? "GET", mode: init.mode ?? "cors" }, answer: undefined as Promise<Response> | undefined };
      listeners.fetch!({ ...event, respondWith: (answer: Promise<Response>) => void (event.answer = answer) });
      // The page reads the body as soon as it has the answer, before the worker's own work finishes.
      const response = await event.answer;
      const text = await response?.text();
      await Promise.all(event.pending);
      return response && { status: response.status, text };
    },
  };
}

describe("shellFiles", () => {
  it("lists the entry, the chunks it imports statically and their CSS, never lazy chunks or images", () => {
    const chunk = (fileName: string, imports: string[], css: string[] = [], isEntry = false): BundleFile => ({ type: "chunk", fileName, isEntry, imports, viteMetadata: { importedCss: new Set(css) } });
    const bundle: Record<string, BundleFile> = {
      // An external module (not in the bundle) is not a file to cache.
      "assets/index-a.js": chunk("assets/index-a.js", ["assets/vendor-b.js", "node:external"], ["assets/index-a.css"], true),
      "assets/vendor-b.js": chunk("assets/vendor-b.js", ["assets/index-a.js"], ["assets/vendor-b.css"]),
      "assets/cpp-c.js": chunk("assets/cpp-c.js", ["assets/vendor-b.js"]),
      "assets/index-a.css": { type: "asset", fileName: "assets/index-a.css" },
      "assets/vendor-b.css": { type: "asset", fileName: "assets/vendor-b.css" },
      "assets/sky-dusk-d.webp": { type: "asset", fileName: "assets/sky-dusk-d.webp" },
    };
    expect(shellFiles(bundle).sort()).toEqual(["assets/index-a.css", "assets/index-a.js", "assets/vendor-b.css", "assets/vendor-b.js"]);
  });
});

describe("sw.js", () => {
  const routes = { "/": "<html>", "/manifest.webmanifest": "{}", "/assets/index-a.js": "entry", "/assets/index-a.css": "css", "/assets/cpp-c.js": "grammar", "/assets/sky-dusk-d.webp": "image", "/api/hello": "{}" };

  it("downloads only the shell at install, into the build's cache, and drops older builds' caches", async () => {
    const sw = worker(routes);
    sw.stores.set("pigna-shell-old", new Map());
    await sw.install();
    // It takes over once its cache is filled, without waiting for the old pages to close.
    expect(sw.skipped()).toBe(2);
    expect(sw.network.sort()).toEqual([...SHELL].sort());
    expect([...sw.stores.get("pigna-shell-b1")!.keys()].map((url) => new URL(url).pathname).sort()).toEqual([...SHELL].sort());
    await sw.activate();
    expect([...sw.stores.keys()]).toEqual(["pigna-shell-b1"]);
  });

  it("updates by copying the hashed files an older build holds and asking for the others with their tags", async () => {
    const sw = worker(routes);
    const held = (body: string, tag?: string) => new Response(body, tag ? { headers: { ETag: tag } } : undefined);
    // The previous build's cache: its own "/" (changed since), the same manifest and stylesheet, its own entry.
    sw.stores.set("pigna-shell-b0", new Map([
      [`${ORIGIN}/`, held("<old html>", tagOf("<old html>"))],
      [`${ORIGIN}/manifest.webmanifest`, held("{}", tagOf("{}"))],
      [`${ORIGIN}/assets/index-a.css`, held("css")],
      [`${ORIGIN}/assets/index-0.js`, held("old entry")],
    ]));
    await sw.install();
    expect(sw.network.sort()).toEqual(["/", "/assets/index-a.js", "/manifest.webmanifest"]);
    expect(sw.revalidated.sort()).toEqual([`/ ${tagOf("<old html>")}`, `/manifest.webmanifest ${tagOf("{}")}`]);
    const fresh = sw.stores.get("pigna-shell-b1")!;
    const text = async (path: string) => fresh.get(`${ORIGIN}${path}`)?.text();
    expect(await text("/")).toBe("<html>");
    expect(await text("/manifest.webmanifest")).toBe("{}");
    expect(await text("/assets/index-a.css")).toBe("css");
    expect(await text("/assets/index-a.js")).toBe("entry");
    expect([...fresh.keys()].length).toBe(SHELL.length);
    await sw.activate();
    expect([...sw.stores.keys()]).toEqual(["pigna-shell-b1"]);
  });

  it("shows every push, even while the app is visible (iOS ends a subscription whose pushes show nothing)", async () => {
    const sw = worker(routes);
    await sw.receive({ v: 1, kind: "done", chat: "c1", t: 1, title: "Fix login" });
    await sw.receive({ v: 1, kind: "host_quit", t: 2 });
    await sw.receive({ v: 1, kind: "done", chat: "c1", t: 3, title: "Fix login", preview: "Fixed the redirect loop." });
    expect(sw.shown).toEqual(["Fix login: Run finished", "pi-gna: pi-gna is quitting", "Fix login: Fixed the redirect loop."]);
  });

  it("keeps nothing from an install that failed", async () => {
    const sw = worker({ ...routes, "/assets/index-a.js": undefined as unknown as string });
    await expect(sw.install()).rejects.toThrow("/assets/index-a.js answered 404");
    expect(sw.stores.has("pigna-shell-b1")).toBe(false);
    expect(sw.skipped()).toBeUndefined();
  });

  it("keeps other hashed files the first time they load and serves them from the cache after", async () => {
    const sw = worker(routes);
    await sw.install();
    sw.network.length = 0;
    expect(await sw.get("/assets/cpp-c.js")).toEqual({ status: 200, text: "grammar" });
    expect(await sw.get("/assets/cpp-c.js")).toEqual({ status: 200, text: "grammar" });
    expect(await sw.get("/assets/index-a.js")).toEqual({ status: 200, text: "entry" });
    expect(sw.network).toEqual(["/assets/cpp-c.js"]);
    expect(sw.stores.get("pigna-shell-b1")!.has(`${ORIGIN}/assets/cpp-c.js`)).toBe(true);
  });

  it("never keeps a failed answer", async () => {
    const sw = worker(routes);
    expect(await sw.get("/assets/gone-e.js")).toEqual({ status: 404, text: "missing" });
    expect(await sw.get("/assets/gone-e.js")).toEqual({ status: 404, text: "missing" });
    expect(sw.network).toEqual(["/assets/gone-e.js", "/assets/gone-e.js"]);
    expect(sw.stores.get("pigna-shell-b1")?.has(`${ORIGIN}/assets/gone-e.js`) ?? false).toBe(false);
  });

  it("leaves the API, other methods and other origins to the network", async () => {
    const sw = worker(routes);
    await sw.install();
    expect(await sw.get("/api/hello")).toBeUndefined();
    expect(await sw.get("/visual/x")).toBeUndefined();
    expect(await sw.get("/assets/cpp-c.js", { method: "POST" })).toBeUndefined();
    expect(await sw.get("/assets/cpp-c.js", { origin: "https://elsewhere.test" })).toBeUndefined();
    expect(await sw.get("/notes.txt")).toBeUndefined();
  });

  it("opens offline from the shell, with the files loaded before", async () => {
    const sw = worker(routes);
    await sw.install();
    await sw.get("/assets/sky-dusk-d.webp");
    sw.goOffline();
    expect(await sw.get("/#/chat/x", { mode: "navigate" })).toEqual({ status: 200, text: "<html>" });
    expect(await sw.get("/assets/index-a.js")).toEqual({ status: 200, text: "entry" });
    expect(await sw.get("/assets/sky-dusk-d.webp")).toEqual({ status: 200, text: "image" });
    await expect(sw.get("/assets/cpp-c.js")).rejects.toThrow("Failed to fetch");
  });
});
