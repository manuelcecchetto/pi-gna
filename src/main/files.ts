// Project file list for @ mentions, via `rg --files` (respects .gitignore). Cached briefly.
import { spawn } from "node:child_process";
import { JsonlSplitter } from "./jsonl";
import { log } from "./log";

const MAX_FILES = 50_000;
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; files: Promise<string[]> }>();

export function listFiles(cwd: string): Promise<string[]> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files;
  const files = run(cwd);
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

function run(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const files: string[] = [];
    const splitter = new JsonlSplitter();
    const child = spawn("rg", ["--files", "--hidden", "--glob", "!.git"], { cwd });
    child.stdout.on("data", (chunk: Buffer) => {
      files.push(...splitter.push(chunk));
      if (files.length >= MAX_FILES) child.kill();
    });
    child.on("error", (error) => {
      log.warn("files", `rg failed: ${error.message}`);
      resolve([]);
    });
    child.on("close", () => resolve(files.slice(0, MAX_FILES)));
  });
}
