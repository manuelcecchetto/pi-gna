// Independent check of the Usage report. The naive reader parses every line of every session file with JSON.parse and
// shares no code with src/: it re-derives the totals from the documented rules (docs/DESIGN.md "## Usage"). The real
// index and report run in scripts/usage-crosscheck-real.test.mjs over the same snapshot; this file compares the two.
// Reads only; the snapshot and every output live in a temp directory, never in ~/.pi.
//
//   node scripts/usage-crosscheck.mjs [--days=14] [--work=/tmp/pi-gna-usage-crosscheck] [--now=ms] [--tz=Zone]
//
// macOS only: the snapshot is an APFS clone (cp -c), so pi can keep appending while both sides read the same bytes.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CONTEXT_TIER_EDGE = 272_000;
const RATES_OPUS = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const ERROR_RULES = [
  [/abort/i, "aborted"],
  [/rate limit/i, "rate-limit"],
  [/overloaded|Service Unavailable/i, "overloaded"],
  [/context window/i, "context-overflow"],
  [/signal|process terminated/i, "process"],
  [/WebSocket|timed out|timeout|fetch failed/i, "network"],
];
const STOPS = ["toolUse", "stop", "length", "error", "aborted"];

const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
const billed = (t) => t.input + t.output + t.cacheRead + t.cacheWrite;
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v) => (typeof v === "string" ? v : "unknown");
const bump = (o, k, n = 1) => {
  o[k] = (o[k] ?? 0) + n;
};

function errorCategory(message, stop) {
  if (typeof message === "string" && message !== "") for (const [re, cat] of ERROR_RULES) if (re.test(message)) return cat;
  return stop === "aborted" ? "aborted" : "other";
}

function listJsonl(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push({ path: p, size: statSync(p).size, mtimeMs: statSync(p).mtimeMs });
    }
  };
  walk(dir);
  return out;
}

/** Full JSON.parse of every line, kept as an ordered event list per file. */
function parseFile(file) {
  const raw = readFileSync(file.path, "utf8");
  const lines = raw.split("\n");
  const endsWithNewline = raw.endsWith("\n");
  const f = { ...file, id: undefined, parentId: undefined, events: [], unparseable: 0, torn: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      if (i === lines.length - 1 && !endsWithNewline) f.torn++;
      else f.unparseable++;
      continue;
    }
    if (rec.type === "session") {
      f.id = rec.id;
      f.parentId = typeof rec.parentSession === "string" ? rec.parentSession : undefined;
      continue;
    }
    if (rec.type === "compaction") f.events.push({ k: "compaction", tokensBefore: finite(rec.tokensBefore) });
    if (rec.type === "context_edit") f.events.push({ k: "contextEdit" });
    if (rec.type === "custom" && rec.customType === "subagents:record" && typeof rec.data?.status === "string") f.events.push({ k: "subagentRecord", status: rec.data.status });
    if (rec.type !== "message" || !rec.message) continue;
    const m = rec.message;
    if (m.role === "user") f.events.push({ k: "user", ts: Date.parse(rec.timestamp) });
    else if (m.role === "assistant") {
      const ts = Number.isFinite(m.timestamp) ? m.timestamp : Date.parse(rec.timestamp);
      if (!Number.isFinite(ts)) continue;
      const u = m.usage ?? {};
      const tokens = { input: finite(u.input), output: finite(u.output), cacheRead: finite(u.cacheRead), cacheWrite: finite(u.cacheWrite), reasoning: finite(u.reasoning) };
      const stop = STOPS.includes(m.stopReason) ? m.stopReason : undefined;
      const hasError = typeof m.errorMessage === "string" && m.errorMessage !== "";
      const calls = Array.isArray(m.content) ? m.content.filter((b) => b?.type === "toolCall").map((b) => ({ id: b.id, name: b.name })) : [];
      f.events.push({
        k: "turn",
        ts,
        provider: text(m.provider),
        model: text(m.model),
        tokens,
        context: tokens.input + tokens.cacheRead + tokens.cacheWrite,
        recorded: finite(u.cost?.total),
        stop,
        error: hasError || stop === "error" || stop === "aborted",
        errorCategory: hasError || stop === "error" || stop === "aborted" ? errorCategory(m.errorMessage, stop) : undefined,
        calls,
      });
    } else if (m.role === "toolResult") {
      f.events.push({
        k: "result",
        id: m.toolCallId,
        name: m.toolName,
        isError: Boolean(m.isError),
        ts: m.timestamp,
        nested: Array.isArray(m.nestedCalls?.calls) ? m.nestedCalls.calls.length : 0,
      });
    }
  }
  return f;
}

/** One file's whole-file facts, derived in event order as the documented rules say. */
function fileFacts(f) {
  const out = {
    prompts: 0,
    abortedPrompts: 0,
    steps: 0,
    promptToolCalls: 0,
    tools: {},
    stops: {},
    errors: {},
    compactions: 0,
    compactedTokens: 0,
    contextEdits: 0,
    subagentRuns: {},
    overEdge: 0,
  };
  const pending = new Map();
  let open;
  const closePrompt = () => {
    if (!open) return;
    out.prompts++;
    if (open.aborted) out.abortedPrompts++;
    out.steps += open.steps;
    out.promptToolCalls += open.toolCalls;
    open = undefined;
  };
  const tool = (name) => (out.tools[name] ??= { calls: 0, errors: 0, timedCalls: 0, durationMs: 0, nestedCalls: 0 });
  for (const e of f.events) {
    if (e.k === "user") {
      closePrompt();
      open = { steps: 0, toolCalls: 0, aborted: false };
    } else if (e.k === "turn") {
      if (e.stop) bump(out.stops, e.stop);
      if (e.error) bump(out.errors, e.errorCategory);
      if (e.context > CONTEXT_TIER_EDGE) out.overEdge++;
      for (const c of e.calls) {
        tool(c.name).calls++;
        pending.set(c.id, { name: c.name, at: e.ts });
      }
      if (open) {
        open.steps++;
        open.toolCalls += e.calls.length;
        open.aborted = e.stop === "aborted";
      }
    } else if (e.k === "result") {
      if (e.nested > 0 && typeof e.name === "string") tool(e.name).nestedCalls += e.nested;
      const call = typeof e.id === "string" ? pending.get(e.id) : undefined;
      if (!call) continue;
      pending.delete(e.id);
      const stat = tool(call.name);
      if (e.isError) stat.errors++;
      const duration = e.ts - call.at;
      if (Number.isFinite(duration) && duration >= 0) {
        stat.timedCalls++;
        stat.durationMs += duration;
      }
    } else if (e.k === "compaction") {
      out.compactions++;
      out.compactedTokens += e.tokensBefore;
    } else if (e.k === "contextEdit") out.contextEdits++;
    else if (e.k === "subagentRecord") bump(out.subagentRuns, e.status);
  }
  closePrompt();
  return out;
}

/** Local calendar day in a zone, from Intl parts. */
function zoned(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, offsetMs: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000 };
}

function localMidnight(day, timeZone) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - zoned(guess, timeZone).offsetMs;
  return guess - zoned(first, timeZone).offsetMs;
}

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export function localPeriod(now, days, timeZone) {
  const to = Math.ceil(now / HOUR_MS) * HOUR_MS;
  const from = localMidnight(addDays(zoned(now, timeZone).day, 1 - days), timeZone);
  return { from, to };
}

/** Whole-file rule for prompts, tools and health (a file counts when it has a turn in the period); exact rule for turns and tokens. */
export function summarize(files, from, to, timeZone) {
  const byId = new Map();
  let dupIds = 0;
  for (const f of files) {
    if (f.id === undefined) continue;
    const prev = byId.get(f.id);
    if (!prev) byId.set(f.id, f);
    else {
      dupIds++;
      byId.set(f.id, f.size > prev.size || (f.size === prev.size && f.mtimeMs > prev.mtimeMs) ? f : prev);
    }
  }
  const inRange = (t) => t >= from && t < to;
  const sum = {
    turns: 0,
    tokens: zeroTokens(),
    errorTurns: 0,
    recorded: 0,
    sessions: 0,
    topLevelSessions: 0,
    promptsWholeFile: 0,
    promptsAllFiles: 0,
    toolCallsAllFiles: 0,
    promptsExact: 0,
    toolCallsWholeFile: 0,
    toolCallsExact: 0,
    overEdgeExact: 0,
    overEdgeWholeFile: 0,
    abortedPrompts: 0,
    steps: 0,
    promptToolCalls: 0,
    compactions: 0,
    compactedTokens: 0,
    contextEdits: 0,
    stops: {},
    errors: {},
    subagentRuns: {},
    tools: {},
    compactingSessions: 0,
  };
  const models = {};
  const days = {};
  const turnsInRange = [];
  for (const f of byId.values()) {
    const facts = fileFacts(f);
    sum.promptsAllFiles += facts.prompts;
    sum.toolCallsAllFiles += Object.values(facts.tools).reduce((n, t) => n + t.calls, 0);
    let any = false;
    for (const e of f.events) {
      if (e.k !== "turn" || !inRange(e.ts)) continue;
      any = true;
      const key = `${e.provider}/${e.model}`;
      const m = (models[key] ??= { turns: 0, errorTurns: 0, tokens: zeroTokens(), recorded: 0 });
      for (const k of Object.keys(m.tokens)) {
        m.tokens[k] += e.tokens[k];
        sum.tokens[k] += e.tokens[k];
      }
      m.turns++;
      m.recorded += e.recorded;
      if (e.error) m.errorTurns++;
      sum.turns++;
      sum.recorded += e.recorded;
      if (e.error) sum.errorTurns++;
      if (e.context > CONTEXT_TIER_EDGE) sum.overEdgeExact++;
      sum.toolCallsExact += e.calls.length;
      const day = zoned(e.ts, timeZone).day;
      const d = (days[day] ??= { turns: 0, tokens: 0 });
      d.turns++;
      d.tokens += billed(e.tokens);
      turnsInRange.push({ ts: e.ts, tokens: e.tokens, key });
    }
    sum.promptsExact += f.events.filter((e) => e.k === "user" && inRange(e.ts)).length;
    if (!any) continue;
    sum.sessions++;
    if (f.parentId === undefined) sum.topLevelSessions++;
    sum.promptsWholeFile += facts.prompts;
    sum.abortedPrompts += facts.abortedPrompts;
    sum.steps += facts.steps;
    sum.promptToolCalls += facts.promptToolCalls;
    sum.toolCallsWholeFile += Object.values(facts.tools).reduce((n, t) => n + t.calls, 0);
    sum.overEdgeWholeFile += facts.overEdge;
    sum.compactions += facts.compactions;
    sum.compactedTokens += facts.compactedTokens;
    sum.contextEdits += facts.contextEdits;
    if (facts.compactions > 0) sum.compactingSessions++;
    for (const [k, v] of Object.entries(facts.stops)) bump(sum.stops, k, v);
    for (const [k, v] of Object.entries(facts.errors)) bump(sum.errors, k, v);
    for (const [k, v] of Object.entries(facts.subagentRuns)) bump(sum.subagentRuns, k, v);
    for (const [name, t] of Object.entries(facts.tools)) {
      const acc = (sum.tools[name] ??= { calls: 0, errors: 0, timedCalls: 0, durationMs: 0, nestedCalls: 0 });
      for (const k of Object.keys(acc)) acc[k] += t[k];
    }
  }
  sum.tokenBilled = billed(sum.tokens);

  const opus = { turns: 0, cost: 0 };
  for (const t of turnsInRange) {
    if (!t.key.endsWith("/claude-opus-5-5")) continue;
    opus.turns++;
    opus.cost +=
      (t.tokens.input * RATES_OPUS.input + t.tokens.output * RATES_OPUS.output + t.tokens.cacheRead * RATES_OPUS.cacheRead + t.tokens.cacheWrite * RATES_OPUS.cacheWrite) / 1e6;
  }
  const sample = turnsInRange
    .filter((t) => t.key.endsWith("/claude-opus-5-5"))
    .sort((a, b) => billed(b.tokens) - billed(a.tokens))[0];

  turnsInRange.sort((a, b) => a.ts - b.ts);
  const blocks = [];
  let block;
  for (const t of turnsInRange) {
    if (!block || t.ts >= block.end) {
      const start = Math.floor(t.ts / HOUR_MS) * HOUR_MS;
      block = { start, end: start + 5 * HOUR_MS, tokens: 0 };
      blocks.push(block);
    }
    block.tokens += billed(t.tokens);
  }
  const top = [...blocks].sort((a, b) => b.tokens - a.tokens || a.start - b.start).slice(0, 5).map((b) => ({ start: b.start, tokens: b.tokens }));

  return { sum, models, days, opus, windows: { count: blocks.length, top }, dupIds, sampleOpusTurn: sample ? { ts: sample.ts, tokens: sample.tokens } : null };
}

function snapshot(src, dst) {
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  execFileSync("cp", ["-Rc", src, dst]);
}

const num = (x) => (typeof x === "number" ? x : Number.NaN);

/** Equal up to floating-point summation order: numbers within tol, objects and arrays field by field. */
function close(a, b, tol) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && close(a[k], b[k], tol));
}

const TOOL_ROWS = 50;

function compareRows(naive, real) {
  const rows = [];
  const add = (group, check, nv, rv, { rule = "exact", tol = 1e-6 } = {}) => {
    rows.push({ group, check, naive: nv, real: rv, rule, ok: close(nv, rv, tol) });
  };
  const H = naive.history;
  const R = naive.period ? naive.range : undefined;
  const rt = real.report.totals;
  const rs = R.sum;
  add("meta", "period.from", naive.period.from, real.report.meta.from);
  add("meta", "period.to", naive.period.to, real.report.meta.to);
  add("meta", "period days", naive.periodDays.length, real.report.days.length);
  add("range", "turns", rs.turns, rt.turns);
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "reasoning"]) add("range", `tokens.${k}`, rs.tokens[k], rt.tokens[k]);
  add("range", "errorTurns", rs.errorTurns, rt.errorTurns);
  add("range", "recorded cost", rs.recorded, rt.cost.recorded, { tol: 1e-9 });
  add("range", "files with turns (sessions)", rs.sessions, rt.sessions);
  add("range", "prompts (whole-file rule)", rs.promptsWholeFile, rt.prompts);
  add("range", "tool calls (whole-file rule)", rs.toolCallsWholeFile, rt.toolCalls);
  add("range", "unpriced turns", 0, rt.cost.unpricedTurns);
  add("range", "stop reasons", rs.stops, real.report.health.stops);
  add("range", "error categories", rs.errors, real.report.health.errors);
  add("range", "compactions", rs.compactions, real.report.health.compactions);
  add("range", "compacted tokens", rs.compactedTokens, real.report.health.compactedTokens);
  add("range", "context edits", rs.contextEdits, real.report.health.contextEdits);
  add("range", "subagent statuses", rs.subagentRuns, real.report.health.subagentRuns);
  add("range", "aborted prompts", rs.abortedPrompts, real.report.health.abortedPrompts);
  add("range", "steps per prompt", rs.steps / rs.promptsWholeFile, real.report.health.stepsPerPrompt, { tol: 1e-9 });
  add("range", "tool calls per prompt", rs.promptToolCalls / rs.promptsWholeFile, real.report.health.toolCallsPerPrompt, { tol: 1e-9 });

  const naiveModels = Object.fromEntries(Object.entries(R.models).map(([k, v]) => [k, { turns: v.turns, errorTurns: v.errorTurns, tokens: v.tokens, recorded: v.recorded }]));
  const realModels = Object.fromEntries(real.report.models.map((m) => [`${m.provider}/${m.model}`, { turns: m.turns, errorTurns: m.errorTurns, tokens: m.tokens, recorded: m.recorded }]));
  add("models", "per model turns, tokens, errors, recorded", naiveModels, realModels, { tol: 1e-9 });
  const opusReal = real.report.models.filter((m) => m.model === "claude-opus-5-5").reduce((s, m) => s + m.estimated, 0);
  add("cost", "claude-opus-5-5 estimate (hand rates 4/20/0.2/5)", R.opus.cost, opusReal, { tol: 1e-9 });

  const naiveDays = naive.periodDays.map((d) => ({ day: d, turns: R.days[d]?.turns ?? 0, tokens: R.days[d]?.tokens ?? 0 }));
  const realDays = real.report.days.map((d) => ({ day: d.day, turns: d.turns, tokens: d.tokens }));
  add("days", "per-day turns and tokens (local days)", naiveDays, realDays, { tol: 1e-9 });

  add("windows", "count", R.windows.count, real.report.windows.count);
  add("windows", "top 5 starts and tokens", R.windows.top, real.report.windows.top.map((w) => ({ start: w.start, tokens: w.tokens })));

  const naiveTools = Object.fromEntries(
    Object.entries(R.sum.tools)
      .sort(([a, x], [b, y]) => y.calls - x.calls || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, TOOL_ROWS)
      .map(([n, t]) => [n, { calls: t.calls, errors: t.errors, nestedCalls: t.nestedCalls, avgMs: t.timedCalls === 0 ? null : t.durationMs / t.timedCalls }]),
  );
  const realTools = Object.fromEntries(real.report.tools.rows.map((t) => [t.name, { calls: t.calls, errors: t.errors, nestedCalls: t.nestedCalls, avgMs: t.avgMs }]));
  add("tools", "per tool calls, errors, nested, mean duration (whole-file rule)", naiveTools, realTools, { tol: 1e-9 });

  const cacheMiss = (R.sum.tokens.input + R.sum.tokens.cacheWrite) / (R.sum.tokens.input + R.sum.tokens.cacheRead + R.sum.tokens.cacheWrite);
  const realMiss = (rt.tokens.input + rt.tokens.cacheWrite) / (rt.tokens.input + rt.tokens.cacheRead + rt.tokens.cacheWrite);
  add("insights", "cache-miss share", cacheMiss, realMiss, { tol: 1e-9 });
  const longContext = real.report.insights.find((i) => i.id === "long-context");
  add("insights", "long-context turns (whole-file count)", R.sum.overEdgeWholeFile, longContext ? longContext.count : null);

  add("history", "turns", H.sum.turns, real.history.totals.turns);
  add("history", "tokens billed", H.sum.tokenBilled, billed(real.history.totals.tokens));
  add("history", "files with turns", H.sum.sessions, real.history.totals.sessions);
  add("history", "errorTurns", H.sum.errorTurns, real.history.totals.errorTurns);
  add("history", "per model turns and tokens", Object.fromEntries(Object.entries(H.models).map(([k, v]) => [k, { turns: v.turns, tokens: v.tokens }])),
    Object.fromEntries(real.history.models.map((m) => [`${m.provider}/${m.model}`, { turns: m.turns, tokens: m.tokens }])), { tol: 1e-9 });
  add("history", "facts turns", H.sum.turns, real.factSums.turns);
  add("history", "facts prompts (all files)", H.sum.promptsAllFiles, real.factSums.prompts);
  add("history", "facts tool calls (all files)", H.sum.toolCallsAllFiles, real.factSums.toolCalls);
  add("history", "files found", naive.files, real.discovered);
  add("history", "unparseable lines", 0, real.factSums.skippedLines);
  add("history", "warm cache equals cold", true, real.warmSame);

  const explained = [
    { check: "prompts: whole-file minus exact", delta: R.sum.promptsWholeFile - R.sum.promptsExact },
    { check: "tool calls: whole-file minus exact", delta: R.sum.toolCallsWholeFile - R.sum.toolCallsExact },
    { check: "long-context turns: whole-file minus exact", delta: R.sum.overEdgeWholeFile - R.sum.overEdgeExact },
  ];
  return { rows, explained };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
  const now = args.now ? Number(args.now) : Date.now();
  const timeZone = args.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = Number(args.days ?? 14);
  const work = args.work ?? "/tmp/pi-gna-usage-crosscheck";
  const sessionsSrc = join(homedir(), ".pi", "agent", "sessions");
  const atpSrc = join(homedir(), "Library", "Application Support", "pi-gna", "atp-sessions");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");

  mkdirSync(work, { recursive: true });
  const snap = join(work, "snap");
  const t0 = performance.now();
  snapshot(sessionsSrc, join(snap, "sessions"));
  snapshot(atpSrc, join(snap, "atp"));
  const snapMs = Math.round(performance.now() - t0);
  const files = [...listJsonl(join(snap, "sessions")), ...listJsonl(join(snap, "atp"))];

  const t1 = performance.now();
  const parsed = files.map(parseFile);
  const parseMs = Math.round(performance.now() - t1);
  const unparseable = parsed.reduce((n, f) => n + f.unparseable, 0);
  const torn = parsed.reduce((n, f) => n + f.torn, 0);

  const period = localPeriod(now, days, timeZone);
  const H = summarize(parsed, -Infinity, Infinity, timeZone);
  const R = summarize(parsed, period.from, period.to, timeZone);
  const naive = {
    now,
    timeZone,
    days,
    period,
    periodDays: dayKeys(period.from, period.to, timeZone),
    files: files.length,
    unparseable,
    torn,
    parseMs,
    snapMs,
    history: { sum: H.sum, models: H.models, dupIds: H.dupIds },
    range: { sum: R.sum, models: R.models, days: R.days, opus: R.opus, windows: R.windows, sampleOpusTurn: R.sampleOpusTurn },
  };
  writeFileSync(join(work, "naive.json"), JSON.stringify(naive, null, 2));
  console.log(`naive: ${files.length} files, ${unparseable} unparseable lines, ${torn} torn tail, parsed in ${parseMs} ms`);

  const real = spawnSync("pnpm", ["exec", "vitest", "run", "scripts/usage-crosscheck-real.test.mjs", "--pool=forks"], {
    cwd: root,
    env: { ...process.env, USAGE_CROSSCHECK_WORK: work },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (real.status !== 0) {
    console.error(real.stdout.slice(-4000), real.stderr.slice(-4000));
    process.exit(1);
  }
  const realOut = JSON.parse(readFileSync(join(work, "real.json"), "utf8"));
  const { rows, explained } = compareRows(naive, realOut);
  const failed = rows.filter((r) => !r.ok);
  writeFileSync(join(work, "diff.json"), JSON.stringify({ rows, explained }, null, 2));
  for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.group.padEnd(8)} ${r.check}`);
  for (const e of explained) console.log(`info ${e.check}: ${e.delta}`);
  console.log(`info files with turns in period: ${naive.range.sum.sessions}, of which top-level chats: ${naive.range.sum.topLevelSessions}`);
  console.log(`cold index ${realOut.coldMs} ms, warm ${realOut.warmMs} ms, report ${realOut.reportMs} ms; ${rows.length - failed.length}/${rows.length} checks equal`);
  if (failed.length > 0) process.exit(1);
}

function dayKeys(from, to, timeZone) {
  const keys = [];
  for (let d = zoned(from, timeZone).day; d <= zoned(to - 1, timeZone).day; d = addDays(d, 1)) keys.push(d);
  return keys;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
