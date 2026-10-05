// Projects -> Chats -> Chat as a stack on the browser's history, so the iPhone's back swipe and the back button agree.
import { useCallback, useEffect, useState } from "react";

export type Route =
  | { screen: "projects" }
  | { screen: "chats"; cwd: string }
  /** A project page (board, laments, GitHub, ATP) the phone shows as it gains them. */
  | { screen: "page"; page: "board" | "laments" | "github" | "atp"; cwd: string; cardId?: string }
  /** `handle`: a live chat to join; otherwise the session file is opened (or joined when already live). */
  | { screen: "chat"; cwd: string; sessionPath?: string; handle?: string; title?: string };

const HOME: Route = { screen: "projects" };

const isRoute = (value: unknown): value is Route => typeof value === "object" && value !== null && typeof (value as Route).screen === "string";

export function useRoute(): { route: Route; push: (route: Route) => void; back: () => void } {
  const [route, setRoute] = useState<Route>(() => (isRoute(history.state) && history.state.screen !== "chat" ? history.state : HOME));
  useEffect(() => {
    history.replaceState(route, "");
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
  // A deep entry (a reload inside a chat) has nothing below it to go back to: fall to the projects.
  const back = useCallback(() => (history.length > 1 ? history.back() : setRoute(HOME)), []);
  return { route, push, back };
}
