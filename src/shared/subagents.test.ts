import { describe, expect, it } from "vitest";
import {
  agentOfCall,
  type ChildFacts,
  encodeSubagents,
  joinSubagents,
  liveSubagents,
  mergeSubagents,
  type ParentFacts,
  parseSubagentCommand,
  type Subagent,
  subagentCommand,
} from "./subagents";

const child = (file: string, prompts: string[], extra: Partial<ChildFacts> = {}): ChildFacts => ({ file, id: `id-${file}`, startedAt: 100, prompts, toolUses: 3, tokens: 900, ...extra });

describe("joinSubagents", () => {
  it("links each file to the call whose prompt it starts with, and a resume to the same agent", () => {
    const parent: ParentFacts = {
      spawns: [
        { callId: "c1", at: 10, args: { description: "Fix server", subagent_type: "general-purpose", prompt: "fix the server" }, result: { agentId: "a1", modelName: "claude-bridge/claude-sonnet-5-5", status: "background" } },
        { callId: "c2", at: 11, args: { description: "Fix web", subagent_type: "Explore", prompt: "fix the web" }, result: { agentId: "a2", status: "background" } },
        { callId: "c3", at: 50, args: { description: "Round 2", prompt: "again", resume: "a1" }, result: { agentId: "a1", status: "background" } },
      ],
      records: [
        { id: "a1", status: "completed", completedAt: 40 },
        { id: "a2", status: "error", completedAt: 45, error: "boom" },
        { id: "a1", status: "completed", completedAt: 80 },
      ],
      transcripts: [],
    };
    const agents = joinSubagents(parent, [child("/t/web.jsonl", ["fix the web"], { startedAt: 12 }), child("/t/server.jsonl", ["fix the server", "again"], { startedAt: 11, model: "x/y" })]);
    expect(agents.map((agent) => [agent.id, agent.description, agent.type, agent.file, agent.status, agent.calls])).toEqual([
      ["a2", "Fix web", "Explore", "/t/web.jsonl", "error", ["c2"]],
      ["a1", "Fix server", "general-purpose", "/t/server.jsonl", "completed", ["c1", "c3"]],
    ]);
    expect(agents[1]).toMatchObject({ model: "claude-bridge/claude-sonnet-5-5", endedAt: 80, toolUses: 3, tokens: 900 });
    expect(agents[0]?.error).toBe("boom");
  });

  it("has no outcome for a resume after the last record, and names a file no call claims by its prompt", () => {
    const parent: ParentFacts = {
      spawns: [
        { callId: "c1", at: 10, args: { description: "Review", prompt: "review it" }, result: { agentId: "a1" } },
        { callId: "c2", at: 60, args: { prompt: "and this", resume: "a1" } },
      ],
      records: [{ id: "a1", status: "completed", completedAt: 40 }],
      transcripts: [],
    };
    const agents = joinSubagents(parent, [child("/t/a.jsonl", ["review it", "and this"]), child("/t/stray.jsonl", ["Look for TODOs\nin src"], { startedAt: 500 })]);
    expect(agents.map((agent) => [agent.description, agent.status, agent.endedAt])).toEqual([
      ["Look for TODOs", "unknown", undefined],
      ["Review", "unknown", undefined],
    ]);
  });

  it("prefers the transcript path get_subagent_result named over the prompt", () => {
    const parent: ParentFacts = {
      spawns: [{ callId: "c1", at: 10, args: { description: "Same", prompt: "p" }, result: { agentId: "a1" } }],
      records: [],
      transcripts: [{ agentId: "a1", path: "/t/second.jsonl" }],
    };
    const agents = joinSubagents(parent, [child("/t/first.jsonl", ["p"]), child("/t/second.jsonl", ["p"])]);
    expect(agents.find((agent) => agent.id === "a1")?.file).toBe("/t/second.jsonl");
  });

  it("keeps a foreground run's final status from its result", () => {
    const parent: ParentFacts = { spawns: [{ callId: "c1", at: 10, args: { description: "Fg", prompt: "p" }, result: { agentId: "a1", status: "completed" } }], records: [], transcripts: [] };
    const [agent] = joinSubagents(parent, []);
    expect(agent).toMatchObject({ id: "a1", status: "completed" });
    expect(agent?.file).toBeUndefined();
  });
});

describe("live subagents", () => {
  const agent = (id: string, extra: Partial<Subagent> = {}): Subagent => ({ id, description: id, type: "general-purpose", status: "running", startedAt: 1, toolUses: 0, tokens: 0, ...extra });

  it("round-trips through the status text and drops what it cannot read", () => {
    expect(liveSubagents(encodeSubagents([agent("a")]))).toEqual([agent("a")]);
    expect(liveSubagents(JSON.stringify({ v: 1, agents: [{ id: "x", description: "d", status: "dancing" }, agent("b")] }))).toEqual([agent("b")]);
    expect(liveSubagents("not json")).toEqual([]);
    expect(liveSubagents(undefined)).toEqual([]);
  });

  it("merges the live record over the file's, keeping the calls and the result's model", () => {
    const disk = [agent("a", { status: "unknown", calls: ["c1"], model: "m/1", file: "/f" }), agent("b", { status: "completed", startedAt: 0 })];
    const merged = mergeSubagents(disk, [agent("a", { toolUses: 4, startedAt: 2 }), agent("c", { startedAt: 3 })]);
    expect(merged.map((entry) => [entry.id, entry.status, entry.toolUses, entry.calls, entry.model, entry.file])).toEqual([
      ["c", "running", 0, undefined, undefined, undefined],
      ["a", "running", 4, ["c1"], "m/1", "/f"],
      ["b", "completed", 0, undefined, undefined, undefined],
    ]);
  });

  it("finds the agent of a call by its result, its arguments, its call id, or a running foreground's description", () => {
    const agents = [agent("a1", { description: "Fix", calls: ["c1"] }), agent("a2", { description: "Look", status: "running" })];
    expect(agentOfCall(agents, { id: "zz", name: "subagent", arguments: {} }, { agentId: "a1" })?.id).toBe("a1");
    expect(agentOfCall(agents, { id: "zz", name: "get_subagent_result", arguments: { agent_id: "a2" } }, undefined)?.id).toBe("a2");
    expect(agentOfCall(agents, { id: "c1", name: "subagent", arguments: {} }, undefined)?.id).toBe("a1");
    expect(agentOfCall(agents, { id: "c9", name: "subagent", arguments: { description: "Look" } }, undefined)?.id).toBe("a2");
    expect(agentOfCall(agents, { id: "c9", name: "subagent", arguments: { description: "Fix" } }, undefined)).toBeUndefined();
  });
});

describe("/subagent", () => {
  it("is sent by the name pi gave pi-gna's command, and read back", () => {
    const commands = [{ name: "subagent:1", source: "extension", sourceInfo: { path: "/app/resources/subagents-extension.ts" } }] as never;
    expect(subagentCommand(commands, "stop", "a1")).toBe("/subagent:1 stop a1");
    expect(subagentCommand(undefined, "steer", "a1", "look at\nthe tests")).toBe("/subagent steer a1 look at\nthe tests");
    expect(parseSubagentCommand("stop a1")).toEqual({ action: "stop", id: "a1" });
    expect(parseSubagentCommand("steer a1 look at\nthe tests ")).toEqual({ action: "steer", id: "a1", message: "look at\nthe tests" });
    expect(parseSubagentCommand("steer a1")).toBeUndefined();
    expect(parseSubagentCommand("wave a1")).toBeUndefined();
  });
});
