import { describe, expect, it } from "vitest";
import { ATP_RUNTIME_PREFIX, classifySession, namesPignaTools, projectKey, projectLabels, type SessionEvidence, startsAtpRuntime } from "./usage-classify";
import type { SessionMarkers } from "./usage";

// Paths as the session folders of this Mac encode them, with the user name replaced.
const PROJECT = "/Users/me/Code/personal/pi-gna";
const CARD = "/Users/me/.pi-gna/worktrees/0aux49/Users/me/Code/personal/pi-gna";
const ATP_WORKTREE = "/Users/me/.pi-gna/worktrees/6qagd6/Users/me/Code/personal/pi-gna";
const RUNNER = "/Users/me/Code/work/CASUS-Tech/actions-runners/code-review-2/_work/casus-review/casus-review";
const OTHER_RUNNER = "/Users/me/Code/work/CASUS-Tech/actions-runners/code-review-1/_work/casus-review/casus-review";
const SESSIONS_FILE = "/Users/me/.pi/agent/sessions/--Users-me-Code-personal-pi-gna--/2026-10-09T12-36-36-561Z_01a120a9-a0b3-72ef-9970-b4d64de21286.jsonl";
const SUBAGENT_FILE = "/Users/me/.pi/agent/sessions/--Users-me-Code-personal-pi-gna--/2026-10-09T12-36-36-561Z_01a120a9-a0b3-72ef-9970-b4d64de21286/tasks/2026-10-09T12-36-36-561Z_01a120aa-5651-72ef-9970-b4db54d8c935.jsonl";

const PLAIN: SessionMarkers = { systemMessage: true, pignaTools: false, atpRuntime: false };
const PIGNA: SessionMarkers = { ...PLAIN, pignaTools: true };

function session(cwd: string, extra: Partial<SessionEvidence> = {}): SessionEvidence {
  return { root: "sessions", path: SESSIONS_FILE, cwd, markers: PLAIN, ...extra };
}

describe("classifySession", () => {
  it("folds a card worktree into its project and keeps the card id", () => {
    expect(classifySession(session(CARD, { markers: PIGNA }))).toEqual({ project: PROJECT, surface: "card", isPigna: true, card: "0aux49" });
  });

  it("keeps a plain folder as its own terminal project", () => {
    expect(classifySession(session(PROJECT))).toEqual({ project: PROJECT, surface: "terminal", isPigna: false });
  });

  it("marks a chat whose system message names pi-gna's tools as a pi-gna chat", () => {
    expect(classifySession(session(PROJECT, { markers: PIGNA }))).toEqual({ project: PROJECT, surface: "pigna-chat", isPigna: true });
  });

  it("puts ATP chats in the atp root, or any chat whose first prompt is a claim packet, under atp-worker", () => {
    expect(classifySession({ ...session(ATP_WORKTREE), root: "atp" })).toEqual({ project: PROJECT, surface: "atp-worker", isPigna: true, card: "6qagd6" });
    expect(classifySession(session(PROJECT, { markers: { ...PLAIN, atpRuntime: true } }))).toEqual({ project: PROJECT, surface: "atp-worker", isPigna: true });
  });

  it("groups every CI runner of one repository into one project", () => {
    expect(classifySession(session(RUNNER))).toEqual({ project: "ci:casus-review", surface: "ci", isPigna: false });
    expect(projectKey(OTHER_RUNNER)).toBe("ci:casus-review");
  });

  it("gives a subagent its parent's pi-gna flag, and only inside a tasks folder", () => {
    const child = session(PROJECT, { path: SUBAGENT_FILE, parentId: "01a120a9-a0b3-72ef-9970-b4d64de21286" });
    expect(classifySession(child, true)).toEqual({ project: PROJECT, surface: "subagent", isPigna: true });
    expect(classifySession(child)).toEqual({ project: PROJECT, surface: "subagent", isPigna: false });
    expect(classifySession({ ...child, path: SESSIONS_FILE }, true)).toEqual({ project: PROJECT, surface: "terminal", isPigna: false });
  });

  it("decides a subagent before the ATP root, and a card before a pi-gna chat", () => {
    const child = session(ATP_WORKTREE, { root: "atp", path: SUBAGENT_FILE, parentId: "x" });
    expect(classifySession(child, true).surface).toBe("subagent");
    expect(classifySession(session(CARD, { markers: PIGNA })).surface).toBe("card");
  });
});

describe("markers", () => {
  it("finds pi-gna's tool and prompt names in a system message", () => {
    expect(namesPignaTools("rules: call kanban_update when you start")).toBe(true);
    expect(namesPignaTools({ includes: (search: string) => "call lament right away".includes(search) })).toBe(true);
    expect(namesPignaTools("You are an expert coding assistant operating inside pi")).toBe(false);
  });

  it("recognises the ATP runner's claim packet at the start of a prompt only", () => {
    expect(startsAtpRuntime(`${ATP_RUNTIME_PREFIX}\n- project_root: ${PROJECT}`)).toBe(true);
    expect(startsAtpRuntime(`Review ${ATP_RUNTIME_PREFIX}`)).toBe(false);
  });
});

describe("projectLabels", () => {
  it("labels a project with its last folder name", () => {
    const labels = projectLabels([PROJECT, "/Users/me/Code/work/CASUS-Tech/casus-review"]);
    expect(labels.get(PROJECT)).toBe("pi-gna");
    expect(labels.get("/Users/me/Code/work/CASUS-Tech/casus-review")).toBe("casus-review");
  });

  it("adds folders until projects with the same name are told apart", () => {
    const labels = projectLabels(["/Users/me/Code/personal/pi-gna", "/Users/me/Code/work/pi-gna"]);
    expect(labels.get("/Users/me/Code/personal/pi-gna")).toBe("personal/pi-gna");
    expect(labels.get("/Users/me/Code/work/pi-gna")).toBe("work/pi-gna");
  });

  it("names the CI project after its repository", () => {
    expect(projectLabels(["ci:casus-review"]).get("ci:casus-review")).toBe("CI runners (casus-review)");
  });
});
