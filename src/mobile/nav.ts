// Projects -> Chats -> Chat as a stack on the browser's history, so the iPhone's back swipe and the back button agree.
import type { MobileSection } from "./settings-data";
import { useCallback, useEffect, useRef, useState } from "react";
import { lastProject } from "./last-project";

export type Route =
  | { screen: "projects" }
  | { screen: "chats"; cwd: string }
  /** Settings: the sections list, or one section. */
  | { screen: "settings"; section?: MobileSection }
  /** The Mac's browser tabs. */
  | { screen: "browser" }
  /** A project page (board, laments, GitHub, ATP) the phone shows as it gains them. */
  | { screen: "page"; page: "board" | "laments" | "github" | "atp"; cwd: string; cardId?: string }
  /** `handle`: a live chat to join; otherwise the session file is opened (or joined when already live). */
  | { screen: "chat"; cwd: string; sessionPath?: string; handle?: string; title?: string; orchestrator?: boolean; /** Typed into an empty composer (a new plan's architect skill). */ prefill?: string; /** "Chat about it": the card whose details go with the first message (the chat then joins it). */ cardId?: string };

const HOME: Route = { screen: "projects" };

/**
 * The history entries the page starts on, bottom first; the last is shown. A fresh launch (no route in the history,
 * no notification naming a chat) opens an empty chat in the last project with its chat list and the projects below
 * it, so the back button and the iPhone's back swipe have somewhere to go. Seeding real entries matters on iOS:
 * `history.length` there counts entries outside the app (the pairing page, earlier loads of the PWA), so a lone
 * chat entry would hand `history.back()` to a page that is not the app and look stuck.
 * A reload keeps its route and the entries below it, except a chat, which reopens as a fresh launch over it.
 */
export function launchStack(state: unknown, hash: string, lastCwd: string | undefined): Route[] {
  if (isRoute(state) && state.screen !== "chat") return [state];
  return lastCwd && !hash ? [HOME, { screen: "chats", cwd: lastCwd }, { screen: "chat", cwd: lastCwd }] : [HOME];
}

function isRoute(value: unknown): value is Route {
  return typeof value === "object" && value !== null && typeof (value as Route).screen === "string";
}

export function useRoute(): { route: Route; push: (route: Route) => void; replace: (route: Route) => void; back: () => void } {
  const [stack] = useState(() => launchStack(history.state, location.hash, lastProject()));
  const [route, setRoute] = useState<Route>(stack[stack.length - 1] ?? HOME);
  const seeded = useRef(false);
  useEffect(() => {
    // Only a fresh launch seeds more than one entry; it replaces the entry the page loaded with, then pushes the rest.
    // Once: StrictMode runs this effect twice and a second seed would stack a duplicate set.
    if (!seeded.current) stack.forEach((entry, i) => (i === 0 ? history.replaceState(entry, "") : history.pushState(entry, "")));
    seeded.current = true;
    const onPop = (event: PopStateEvent) => setRoute(isRoute(event.state) ? event.state : HOME);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // The first route is what the page loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const push = useCallback((next: Route) => {
    history.pushState(next, "");
    setRoute(next);
  }, []);
  const replace = useCallback((next: Route) => {
    history.replaceState(next, "");
    setRoute(next);
  }, []);
  // A deep entry with nothing below it (a reload of a page opened in a browser tab) falls to the projects.
  const back = useCallback(() => (history.length > 1 ? history.back() : replace(HOME)), [replace]);
  return { route, push, replace, back };
}
