// What you can start from a card (its right-click menu and its details): chats that investigate it, resolve it,
// check it in review (main starts them: ChatTasks) or talk about it. Other features add theirs with registerCardAction (say, opening a card's GitHub issue).
import { ClipboardCheck, type IconComponent, MessageSquarePlus, Search, Wrench } from "../components/icons";
import type { Card } from "../../../shared/board";
import { type CardTaskKind, discussCard, runCardTaskHere, startCardTask } from "./app";

export interface CardAction {
  id: string;
  label: string;
  icon: IconComponent;
  /** What it does, as a tooltip. */
  hint?: string;
  /** Offered only for the cards this accepts. */
  when?: (card: Card) => boolean;
  run: (card: Card) => void;
  /** Does it in the chat the card is shown beside, where the card tab offers that ("On another chat" is `run`). */
  runHere?: (card: Card, chat: string) => void;
  /** The card task it starts: its button and the card show it starting, then started (AppState.cardTasks). */
  task?: CardTaskKind;
}

const actions: CardAction[] = [];

/** Add an action, or replace the one with the same id. */
export function registerCardAction(action: CardAction): void {
  const index = actions.findIndex((other) => other.id === action.id);
  if (index < 0) actions.push(action);
  else actions[index] = action;
}

export function cardActions(card: Card): CardAction[] {
  return actions.filter((action) => !action.when || action.when(card));
}

const cardTask = (task: CardTaskKind): Pick<CardAction, "run" | "runHere" | "task"> => ({
  task,
  run: (card) => void startCardTask(card, task),
  runHere: (card, chat) => void runCardTaskHere(card, task, chat),
});

registerCardAction({
  id: "investigate",
  label: "Investigate",
  icon: Search,
  hint: "A new chat looks into it without changing files, and reports on the card",
  ...cardTask("investigate"),
});

registerCardAction({
  id: "resolve",
  label: "Resolve",
  icon: Wrench,
  hint: "A new chat makes the change in a git worktree, on a branch of its own, verifies it and moves the card to review",
  when: (card) => card.column !== "done",
  ...cardTask("resolve"),
});

registerCardAction({
  id: "qa",
  label: "QA",
  icon: ClipboardCheck,
  hint: "A new chat reviews the change, runs the checks and tries it, without fixing anything; it reports on the card, and moves it back to in progress if it fails",
  when: (card) => card.column === "in_review",
  ...cardTask("qa"),
});

registerCardAction({
  id: "discuss",
  label: "Chat about it",
  icon: MessageSquarePlus,
  hint: "Opens a new chat with the card in its composer: its details go with your message, and the chat joins the card when you send",
  run: (card) => discussCard(card),
});
