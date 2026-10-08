// Best-effort parse of a streaming JSON object (tool-call arguments arrive as deltas).
// The scanner state is plain data kept per streaming block, so each delta scans only its own text;
// completing closes an open string and open brackets, and on failure retries from the last comma.

export interface PartialJson {
  text: string;
  /** Closers of the brackets open at the end of `text`, innermost last. */
  closers: string;
  inString: boolean;
  /** The previous character was a backslash inside a string. */
  escaped: boolean;
  /** Hex digits still missing from a `\u` escape at the end of `text` (0 when not in one). */
  hexLeft: number;
  /** Index of the last comma outside a string (-1 when none), and the closers open there. */
  lastComma: number;
  commaClosers: string;
}

export const EMPTY_PARTIAL_JSON: PartialJson = { text: "", closers: "", inString: false, escaped: false, hexLeft: 0, lastComma: -1, commaClosers: "" };

export function appendPartialJson(state: PartialJson, delta: string): PartialJson {
  let { closers, inString, escaped, hexLeft, lastComma, commaClosers } = state;
  const offset = state.text.length;
  for (let i = 0; i < delta.length; i++) {
    const char = delta[i];
    if (inString) {
      if (hexLeft) hexLeft--;
      else if (escaped) {
        escaped = false;
        if (char === "u") hexLeft = 4;
      } else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") closers += "}";
    else if (char === "[") closers += "]";
    else if (char === "}" || char === "]") closers = closers.slice(0, -1);
    else if (char === ",") {
      lastComma = offset + i;
      commaClosers = closers;
    }
  }
  return { text: state.text + delta, closers, inString, escaped, hexLeft, lastComma, commaClosers };
}

export function completePartialJson(state: PartialJson): Record<string, unknown> | undefined {
  let text = state.text;
  if (state.inString) {
    // Drop an unfinished escape sequence before closing the string.
    if (state.escaped) text = text.slice(0, -1);
    else if (state.hexLeft) text = text.slice(0, -(6 - state.hexLeft));
    text += '"';
  } else {
    text = text.trimEnd();
    if (text.endsWith(",") || text.endsWith(":")) text = text.slice(0, -1);
  }
  const value = parseObject(text + reversed(state.closers));
  if (value !== undefined || state.lastComma <= 0) return value;
  return parseObject(state.text.slice(0, state.lastComma) + reversed(state.commaClosers));
}

export function parsePartialJson(text: string): Record<string, unknown> | undefined {
  return completePartialJson(appendPartialJson(EMPTY_PARTIAL_JSON, text));
}

function reversed(closers: string): string {
  let out = "";
  for (let i = closers.length - 1; i >= 0; i--) out += closers[i];
  return out;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
