// Minimal ANSI SGR -> styled spans, for extension status text and tool output.
// Non-SGR escapes (cursor movement, OSC hyperlinks) are stripped.

export interface AnsiStyle {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

const BASIC = ["#3a3a3c", "#ff6b6b", "#5fd38d", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d4d4d8"];
const BRIGHT = ["#7d7d85", "#ff8787", "#8ce99a", "#ffd479", "#82c3ff", "#e0a3ff", "#7ee0ea", "#ffffff"];

const ESCAPES = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const previous = spans.at(-1);
    if (previous && previous.style === style) previous.text += text;
    else spans.push({ text, style });
  };
  for (const match of input.matchAll(ESCAPES)) {
    push(input.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
  }
  push(input.slice(last));
  return spans;
}

export function stripAnsi(input: string): string {
  return input.replace(ESCAPES, "");
}

function applySgr(current: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((code) => Number(code) || 0);
  let next: AnsiStyle = { ...current };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) next.bold = next.dim = undefined;
    else if (code === 23) next.italic = undefined;
    else if (code === 24) next.underline = undefined;
    else if (code >= 30 && code <= 37) next.color = BASIC[code - 30];
    else if (code >= 90 && code <= 97) next.color = BRIGHT[code - 90];
    else if (code === 39) next.color = undefined;
    else if (code >= 40 && code <= 47) next.background = BASIC[code - 40];
    else if (code >= 100 && code <= 107) next.background = BRIGHT[code - 100];
    else if (code === 49) next.background = undefined;
    else if (code === 38 || code === 48) {
      const [color, consumed] = extendedColor(codes, i + 1);
      if (code === 38) next.color = color;
      else next.background = color;
      i += consumed;
    }
  }
  return next;
}

function extendedColor(codes: number[], index: number): [string | undefined, number] {
  if (codes[index] === 2) {
    const [r, g, b] = [codes[index + 1] ?? 0, codes[index + 2] ?? 0, codes[index + 3] ?? 0];
    return [`rgb(${r}, ${g}, ${b})`, 4];
  }
  if (codes[index] === 5) return [xterm256(codes[index + 1] ?? 0), 2];
  return [undefined, 0];
}

function xterm256(n: number): string | undefined {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const v = n - 16;
    const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${level(Math.floor(v / 36))}, ${level(Math.floor(v / 6) % 6)}, ${level(v % 6)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}
