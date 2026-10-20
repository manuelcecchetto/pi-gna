// What is on screen, for a client that drives this page from outside: the TV app (pigna-tv) sends what the remote's
// mic hears to the chat or project shown here, and opens a chat it started. Other clients ignore both.

/** The chat on screen, else the project; empty on the projects list. */
export type Screen = { handle?: string; cwd?: string };

let project: string | undefined;
let chat: { handle: string; cwd: string } | undefined;
let last = "";

function publish(): void {
  const screen: Screen = chat ? { handle: chat.handle, cwd: chat.cwd } : project ? { cwd: project } : {};
  const key = JSON.stringify(screen);
  if (key === last) return;
  last = key;
  (window as { pignaScreen?: Screen }).pignaScreen = screen;
  window.dispatchEvent(new CustomEvent<Screen>("pigna-screen", { detail: screen }));
}

export function setScreenProject(cwd: string | undefined): void {
  project = cwd;
  publish();
}

export function setScreenChat(next: { handle: string; cwd: string } | undefined): void {
  chat = next;
  publish();
}

/** `pigna-open-chat` with a chat handle as its detail: the page opens that chat. A frame cannot fire it on this window. */
export function onOpenChat(open: (handle: string) => void): () => void {
  const listener = (event: Event) => {
    const handle = (event as CustomEvent<unknown>).detail;
    if (typeof handle === "string") open(handle);
  };
  window.addEventListener("pigna-open-chat", listener);
  return () => window.removeEventListener("pigna-open-chat", listener);
}
