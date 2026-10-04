// What the Providers section shows of a running login, and of each provider.
import type { AuthMethod, AuthPrompt, AuthProvider, LoginUpdate } from "../../../shared/auth";
import { LOGOS, PROVIDER_BRANDS, type ProviderLogo } from "./provider-logos";

export interface LoginView {
  provider: AuthProvider;
  method: AuthMethod;
  /** The sign-in page main opened in the browser. */
  url?: { url: string; instructions?: string };
  /** A code to enter on the provider's page. */
  device?: { userCode: string; verificationUri: string };
  notes: { message: string; links?: { url: string; label?: string }[] }[];
  progress?: string;
  /** Open questions, oldest first: OpenAI asks for a pasted redirect while its browser sign-in is pending. */
  prompts: AuthPrompt[];
  error?: string;
}

export const startLogin = (provider: AuthProvider, method: AuthMethod): LoginView => ({ provider, method, notes: [], prompts: [] });

export function updateLogin(view: LoginView, update: LoginUpdate): LoginView {
  if (update.kind === "prompt") return { ...view, prompts: [...view.prompts.filter((prompt) => prompt.n !== update.prompt.n), update.prompt] };
  if (update.kind === "withdraw") return { ...view, prompts: view.prompts.filter((prompt) => prompt.n !== update.n) };
  const event = update.event;
  switch (event.type) {
    case "auth_url":
      return { ...view, url: { url: event.url, instructions: event.instructions } };
    case "device_code":
      return { ...view, device: { userCode: event.userCode, verificationUri: event.verificationUri }, progress: "Waiting for you to enter the code…" };
    case "info":
      return { ...view, notes: [...view.notes, { message: event.message, links: event.links }] };
    case "progress":
      return { ...view, progress: event.message };
  }
}

/** The answered prompt leaves at once; the next one, if any, comes as its own update. */
export const answered = (view: LoginView, n: number): LoginView => ({ ...view, prompts: view.prompts.filter((prompt) => prompt.n !== n) });

/** The plan an account card signs in to: "Claude Pro/Max" from "Anthropic (Claude Pro/Max)". */
export function accountLabel(provider: AuthProvider): string {
  const oauth = provider.oauth;
  if (!oauth) return "";
  const match = /^(.*?)\s*\((.+)\)$/.exec(oauth.name);
  if (match?.[2]) return match[2] === "subscription" ? `${match[1]} subscription` : match[2];
  return oauth.subscription ? "Subscription" : "Account";
}

/** A provider's logo: its brand, or the brand of the pi provider it is a variant of ("qwen-token-plan-…"). */
export function logoFor(id: string): ProviderLogo | undefined {
  const brand = PROVIDER_BRANDS[id] ?? Object.entries(PROVIDER_BRANDS).find(([known]) => id.startsWith(`${known}-`))?.[1];
  return brand ? LOGOS[brand] : undefined;
}
