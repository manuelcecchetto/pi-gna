// What the phone's sign-in sheet offers for a running login (docs/REMOTE.md, "Provider sign-in from the phone"). pi's
// flows end in one of three ways, told apart by what the login sends: a device code (type it on the provider's page,
// works anywhere), a link plus a prompt for a pasted code or redirect (works anywhere), or a link whose redirect lands on
// a local callback server of the Mac, which only the Mac's own browser can reach.
import type { LoginView } from "../renderer/src/lib/login";

export type LoginGuide = "key" | "code" | "paste" | "mac" | "wait";

/** `settled`: the link has been showing long enough that a paste prompt, which follows it at once when there is one, would have come. */
export function loginGuide(view: Pick<LoginView, "device" | "url" | "prompts" | "method">, settled: boolean): LoginGuide {
  if (view.method === "api_key") return "key";
  if (view.device) return "code";
  if (view.prompts.some((prompt) => prompt.type === "manual_code" || prompt.type === "text")) return view.url ? "paste" : "wait";
  if (view.url && settled) return "mac";
  return "wait";
}

/** The host name of a page, for "Enter this code at github.com". */
export function pageHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Only web pages open on the phone; anything else a login sends (a custom scheme) is not offered as a link. */
export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);
