import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DictationStatus } from "../../shared/dictation";
import type { Fetch } from "../autocomplete/install";
import { type DictationRuntime, dictationRuntime, MODEL, RUNTIMES } from "./assets";
import { Dictation, type DictationWorker, type WorkerEnv, type WorkerReply, type WorkerRequest } from "./index";

const root = mkdtempSync(join(tmpdir(), "pigna-dictation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function memoryFetch(files: Record<string, Buffer>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const bytes = files[url];
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("missing", { status: 404, statusText: "Not Found" });
  };
  return Object.assign(fetch, { calls });
}

/** A tar.gz of `files` (paths relative to the archive's root), as served at `url`. */
function tarball(name: string, files: Record<string, string>): Buffer {
  const dir = join(root, `src-${name}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const archive = join(root, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", dir, "."]);
  return readFileSync(archive);
}

/** A utility process stand-in: answers each recording with its length, or crashes on demand. */
class FakeWorker extends EventEmitter implements DictationWorker {
  killed = false;
  constructor(
    readonly env: WorkerEnv,
    private readonly mode: { load: "ok" | "fail"; crashOn?: number },
  ) {
    super();
    setTimeout(() => this.reply(this.mode.load === "ok" ? { type: "ready" } : { type: "failed", message: "bad model" }), 1);
  }
  private reply(message: WorkerReply) {
    this.emit("message", message);
  }
  postMessage({ id, pcm }: WorkerRequest): void {
    if (pcm.length === this.mode.crashOn) return void setTimeout(() => this.emit("exit", 139), 1);
    setTimeout(() => this.reply({ type: "result", id, text: ` ${pcm.length} samples ` }), 1);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function setup(name: string, mode: { load: "ok" | "fail"; crashOn?: number } = { load: "ok" }) {
  const nativeBytes = tarball(`native-${name}`, { "transcribe-native-test/libtranscribe.dylib": "lib", "transcribe-native-test/contract.json": "{}" });
  const koffiBytes = tarball(`koffi-${name}`, { "package/darwin_arm64/koffi.node": "addon", "package/musl_arm64/koffi.node": "other" });
  const weights = Buffer.from("weights");
  const runtime: DictationRuntime = {
    native: { id: "native", url: "https://example.test/native.tar.gz", size: nativeBytes.length, sha256: sha(nativeBytes), library: "libtranscribe.dylib" },
    koffi: { id: "koffi", url: "https://example.test/koffi.tgz", size: koffiBytes.length, sha256: sha(koffiBytes), addon: "package/darwin_arm64/koffi.node" },
  };
  const model = { file: "model.gguf", url: "https://example.test/model.gguf", size: weights.length, sha256: sha(weights) };
  const fetch = memoryFetch({ [runtime.native.url]: nativeBytes, [runtime.koffi.url]: koffiBytes, [model.url]: weights });
  const workers: FakeWorker[] = [];
  const statuses: DictationStatus[] = [];
  const dir = join(root, `userdata-${name}`);
  const service = new Dictation({
    dir,
    fetch,
    fork: (env) => {
      const worker = new FakeWorker(env, mode);
      workers.push(worker);
      return worker;
    },
    onStatus: (status) => statuses.push(status),
    runtime,
    model,
  });
  return { service, statuses, workers, fetch, dir };
}

describe("dictation assets", () => {
  it("pins a runtime for each platform transcribe.cpp builds for, and none for Windows on Arm", () => {
    expect(Object.keys(RUNTIMES).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
    expect(dictationRuntime("win32", "arm64")).toBeUndefined();
    for (const [key, runtime] of Object.entries(RUNTIMES)) {
      for (const download of [runtime.native, runtime.koffi]) expect(download.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(runtime.koffi.url, key).toContain(`/@koromix/koffi-${key}/-/koffi-${key}-`);
      expect(runtime.koffi.addon, key).toBe(`package/${key.replace("-", "_")}/koffi.node`);
    }
    expect(RUNTIMES["win32-x64"]?.native.library).toBe("transcribe.dll");
    // A revision-pinned URL, so the file behind the checksum cannot move.
    expect(MODEL.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
  });

  it("keeps the native library at the binding's version", () => {
    const binding = JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf8")).devDependencies["transcribe-cpp"];
    for (const runtime of Object.values(RUNTIMES)) expect(runtime.native.url).toContain(`/v${binding}/transcribe-native-${binding}-`);
  });
});

describe("Dictation", () => {
  it("downloads on enable, then transcribes in one worker that it reuses", async () => {
    const { service, statuses, workers, dir } = setup("happy");
    try {
      await expect(service.transcribe(new Float32Array(10))).rejects.toThrow("not ready");
      service.setEnabled(true);
      await vi.waitFor(() => expect(service.get().phase).toBe("ready"));
      expect(statuses.some((status) => status.phase === "downloading")).toBe(true);
      expect(await service.transcribe(new Float32Array(10))).toBe("10 samples");
      expect(await service.transcribe(new Float32Array(20))).toBe("20 samples");
      expect(workers).toHaveLength(1);
      const env = workers[0]!.env;
      expect(readFileSync(env.TRANSCRIBE_LIBRARY, "utf8")).toBe("lib");
      // The addon at the pinned path, not the first koffi.node found (the Linux tarballs carry a musl one too).
      expect(readFileSync(env.PIGNA_KOFFI, "utf8")).toBe("addon");
      expect(env.PIGNA_DICTATION_MODEL).toBe(join(dir, "models", "model.gguf"));
      service.setEnabled(false);
      expect(service.get().phase).toBe("off");
      expect(workers[0]!.killed).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it("downloads nothing again on the next start", async () => {
    const first = setup("again");
    first.service.setEnabled(true);
    await vi.waitFor(() => expect(first.service.get().phase).toBe("ready"));
    first.service.dispose();
    const { service, fetch } = setup("again");
    try {
      service.setEnabled(true);
      await vi.waitFor(() => expect(service.get().phase).toBe("ready"));
      expect(fetch.calls).toEqual([]);
      expect(existsSync(join(root, "userdata-again", "runtime", "native.tar.gz"))).toBe(false);
    } finally {
      service.dispose();
    }
  });

  it("starts a new worker after one crashes, failing only the recording it was on", async () => {
    const { service, workers } = setup("crash", { load: "ok", crashOn: 7 });
    try {
      service.setEnabled(true);
      await vi.waitFor(() => expect(service.get().phase).toBe("ready"));
      await expect(service.transcribe(new Float32Array(7))).rejects.toThrow("exit code 139");
      expect(await service.transcribe(new Float32Array(3))).toBe("3 samples");
      expect(workers).toHaveLength(2);
    } finally {
      service.dispose();
    }
  });

  it("reports a model that will not load, and Retry tries again", async () => {
    const { service, workers } = setup("broken", { load: "fail" });
    try {
      service.setEnabled(true);
      await vi.waitFor(() => expect(service.get().phase).toBe("ready"));
      await expect(service.transcribe(new Float32Array(5))).rejects.toThrow("bad model");
      expect(service.get()).toMatchObject({ phase: "error", error: "The speech model would not start: bad model" });
      expect(workers[0]!.killed).toBe(true);
      service.retry();
      expect(service.get().phase).toBe("ready");
    } finally {
      service.dispose();
    }
  });

  it("says so on a computer without a runtime", async () => {
    const statuses: DictationStatus[] = [];
    const service = new Dictation({ dir: join(root, "none"), fetch: memoryFetch({}), fork: () => new FakeWorker({} as WorkerEnv, { load: "ok" }), onStatus: (status) => statuses.push(status), runtime: null });
    service.setEnabled(true);
    await vi.waitFor(() => expect(service.get()).toEqual({ phase: "error", error: "Dictation has no speech model build for this computer." }));
    service.dispose();
  });
});
