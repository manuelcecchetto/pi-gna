// Pure path handling for opening previews from the transcript.

/** A tool or attachment path as an absolute one: `~/` against home, relative against the chat's cwd. */
export function resolveFilePath(path: string, cwd: string | undefined, home: string | undefined): string | undefined {
  const text = path.trim();
  if (!text) return undefined;
  let joined: string;
  if (text === "~" || text.startsWith("~/")) {
    if (!home) return undefined;
    joined = `${home}/${text.slice(2)}`;
  } else if (text.startsWith("/")) {
    joined = text;
  } else {
    if (!cwd) return undefined;
    joined = `${cwd}/${text}`;
  }
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}
