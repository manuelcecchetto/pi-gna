// What the shared transcript components know about the chat's subagents (src/shared/subagents.ts): its list and how to
// open one. The desktop provides it around a chat's transcript; where nobody does (the phone), subagent calls and
// notices render as before, without a status or a way to open the agent.
import { createContext, useContext } from "react";
import type { Subagent } from "../../../shared/subagents";

export interface SubagentsUi {
  agents: Subagent[];
  open(agent: Subagent): void;
}

const Context = createContext<SubagentsUi | undefined>(undefined);
export const SubagentsProvider = Context.Provider;
export const useSubagentsUi = (): SubagentsUi | undefined => useContext(Context);
