import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectTrust } from "./pi-settings";

let root: string;

beforeEach(async () => {
  // Spelled as tmpdir() gives it, a symlink on macOS: pi keys trust.json by real path.
  root = await mkdtemp(join(tmpdir(), "pigna-trust-"));
  await mkdir(join(root, "agent"));
  await mkdir(join(root, "repo", "web", "src"), { recursive: true });
  await mkdir(join(root, "repo", "vendor"), { recursive: true });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("projectTrust", () => {
  it("is the decision saved for the nearest folder", async () => {
    const real = await realpath(root);
    await writeFile(join(root, "agent", "trust.json"), JSON.stringify({ [join(real, "repo")]: true, [join(real, "repo", "vendor")]: false, [join(real, "repo", "web")]: null }));
    expect(await projectTrust(join(root, "repo", "web", "src"))).toBe(true);
    expect(await projectTrust(join(root, "repo", "vendor"))).toBe(false);
    expect(await projectTrust(root)).toBeUndefined();
  });

  it("is undefined without a trust store", async () => {
    expect(await projectTrust(join(root, "repo"))).toBeUndefined();
    await writeFile(join(root, "agent", "trust.json"), "{ not json");
    expect(await projectTrust(join(root, "repo"))).toBeUndefined();
  });
});
