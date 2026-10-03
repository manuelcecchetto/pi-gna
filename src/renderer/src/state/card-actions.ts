// What you can start from a card (its right-click menu and its details): chats that investigate it, resolve it,
// check it in review or talk about it. Other features add theirs with registerCardAction (say, opening a card's GitHub issue).
import { ClipboardCheck, type LucideIcon, MessageSquarePlus, Search, Wrench } from "lucide-react";
import type { Card } from "../../../shared/board";
import type { CardWorktree } from "../../../shared/ipc";
import { hasWorktree, investigatePrompt, qaPrompt, resolvePrompt } from "../lib/board";
import { discussCard, remoteError, startCardChat, toast } from "./app";

export interface CardAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /** What it does, as a tooltip. */
  hint?: string;
  /** Offered only for the cards this accepts. */
  when?: (card: Card) => boolean;
  run: (card: Card) => void;
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

registerCardAction({
  id: "investigate",
  label: "Investigate",
  icon: Search,
  hint: "A new chat looks into it without changing files, and reports on the card",
  run: (card) => {
    startCardChat(card.cwd, { card: card.id, name: `Investigate: ${card.title}`, prompt: investigatePrompt(card) });
    toast(`Investigating “${card.title}” in a new chat`);
  },
});

registerCardAction({
  id: "resolve",
  label: "Resolve",
  icon: Wrench,
  hint: "A new chat makes the change in a git worktree, on a branch of its own, verifies it and moves the card to review",
  when: (card) => card.column !== "done",
  run: (card) => void resolve(card),
});

/** Resolve chats work in a git worktree of the project (made by main, reused by later Resolves of the card). */
async function resolve(card: Card): Promise<void> {
  let worktree: CardWorktree | null;
  try {
    worktree = await window.studio.cardWorktree(card.id);
  } catch (error) {
    toast(`Could not make a git worktree for “${card.title}”: ${remoteError(error)}`, "error");
    return;
  }
  startCardChat(worktree?.cwd ?? card.cwd, { card: card.id, name: `Resolve: ${card.title}`, prompt: resolvePrompt(card, worktree) });
  if (!worktree) toast(`Resolving “${card.title}” in a new chat, in the project folder: it is not in a git repository`);
  else if (worktree.dirty) toast(`Resolving “${card.title}” on branch ${worktree.branch}. Your checkout's uncommitted changes are not in its worktree.`, "warning");
  else toast(`Resolving “${card.title}” on branch ${worktree.branch}`);
}

registerCardAction({
  id: "qa",
  label: "QA",
  icon: ClipboardCheck,
  hint: "A new chat reviews the change, runs the checks and tries it, without fixing anything; it reports on the card, and moves it back to in progress if it fails",
  when: (card) => card.column === "in_review",
  run: (card) => void qa(card),
});

/**
 * QA chats check the change where Resolve left it: the card's worktree when a chat on the card worked in one, else
 * the project folder (a new worktree, made from HEAD, would not have the change).
 */
async function qa(card: Card): Promise<void> {
  let worktree: CardWorktree | null = null;
  if (hasWorktree(card)) {
    try {
      worktree = await window.studio.cardWorktree(card.id);
    } catch (error) {
      toast(`Could not open the git worktree of “${card.title}”: ${remoteError(error)}`, "error");
      return;
    }
  }
  startCardChat(worktree?.cwd ?? card.cwd, { card: card.id, name: `QA: ${card.title}`, prompt: qaPrompt(card, worktree) });
  toast(worktree ? `Checking “${card.title}” on branch ${worktree.branch}` : `Checking “${card.title}” in a new chat`);
}

registerCardAction({
  id: "discuss",
  label: "Chat about it",
  icon: MessageSquarePlus,
  hint: "Opens a new chat with the card in its composer: its details go with your message, and the chat joins the card when you send",
  run: (card) => discussCard(card),
});
