// Best-effort parse of a streaming JSON object (tool-call arguments arrive as deltas).
// Closes an open string and open brackets; on failure retries from the last top-level comma.

export function parsePartialJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const first = tryComplete(trimmed);
  if (first.value !== undefined) return first.value;
  if (first.lastComma > 0) return tryComplete(trimmed.slice(0, first.lastComma)).value;
  return undefined;
}

function tryComplete(text: string): { value: Record<string, unknown> | undefined; lastComma: number } {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastComma = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") lastComma = i;
  }
  let completed = text;
  if (inString) {
    // Drop an unfinished escape sequence before closing the string.
    completed = completed.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "") + '"';
  }
  completed = completed.replace(/[,:]\s*$/, "") + stack.reverse().join("");
  try {
    const value: unknown = JSON.parse(completed);
    return { value: value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined, lastComma };
  } catch {
    return { value: undefined, lastComma };
  }
}
