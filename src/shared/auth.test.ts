import { describe, expect, it } from "vitest";
import { type AuthProvider, authStatus, claudeFromEnvironment, searchProviders, splitProviders } from "./auth";

const provider = (id: string, extra: Partial<AuthProvider> = {}): AuthProvider => ({ id, name: id[0]?.toUpperCase() + id.slice(1), ...extra });

describe("authStatus", () => {
  it("names how pi authenticates, for the way of signing in asked about", () => {
    expect(authStatus(provider("a"), "oauth")).toEqual({ text: "Not connected", tone: "off" });
    expect(authStatus(provider("a", { status: { method: "oauth", source: "stored" } }), "oauth")).toEqual({ text: "Signed in", tone: "on" });
    expect(authStatus(provider("a", { status: { method: "api_key", source: "stored" } }), "api_key")).toEqual({ text: "Key saved", tone: "on" });
    expect(authStatus(provider("a", { status: { method: "api_key", source: "environment", label: "A_API_KEY" } }), "api_key")).toEqual({ text: "From A_API_KEY", tone: "on" });
    expect(authStatus(provider("a", { status: { method: "api_key", source: "models_json_command" } }), "api_key")).toEqual({ text: "From models.json", tone: "on" });
    expect(authStatus(provider("a", { status: { method: "api_key", source: "fallback" } }), "api_key")).toEqual({ text: "Configured", tone: "on" });
  });

  it("says when pi signs in the other way", () => {
    expect(authStatus(provider("a", { status: { method: "api_key", source: "stored" } }), "oauth")).toEqual({ text: "Uses an API key", tone: "other" });
    expect(authStatus(provider("a", { status: { method: "api_key", source: "environment", label: "A_KEY" } }), "oauth")).toEqual({ text: "From A_KEY", tone: "other" });
    expect(authStatus(provider("a", { status: { method: "oauth", source: "stored" } }), "api_key")).toEqual({ text: "Signed in with an account", tone: "other" });
  });

  it("names Claude Code's login and plan", () => {
    expect(authStatus(provider("claude-bridge", { status: { method: "oauth", source: "claude_code", label: "max" } }), "oauth")).toEqual({ text: "Signed in · Claude Max", tone: "on" });
    expect(authStatus(provider("claude-bridge", { status: { method: "oauth", source: "claude_code" } }), "oauth")).toEqual({ text: "Signed in", tone: "on" });
    expect(authStatus(provider("claude-bridge", { status: { method: "api_key", source: "claude_code", label: "api_key" } }), "oauth")).toEqual({ text: "Claude Code uses an API key", tone: "other" });
  });
});

describe("claudeFromEnvironment", () => {
  it("explains a Claude Code key from the environment, which no sign-in or sign-out changes", () => {
    expect(claudeFromEnvironment(provider("claude-bridge", { status: { method: "api_key", source: "environment", label: "ANTHROPIC_API_KEY" } }))).toContain("ANTHROPIC_API_KEY");
    expect(claudeFromEnvironment(provider("claude-bridge", { status: { method: "oauth", source: "claude_code" } }))).toBeUndefined();
    expect(claudeFromEnvironment(provider("anthropic", { status: { method: "api_key", source: "environment", label: "ANTHROPIC_API_KEY" } }))).toBeUndefined();
  });
});

describe("splitProviders", () => {
  it("puts subscriptions first among the account sign-ins, keeping pi's order otherwise", () => {
    const providers = [
      provider("acme", { oauth: { name: "Acme", subscription: false }, apiKey: { name: "Acme key", login: true } }),
      provider("beta", { apiKey: { name: "Beta key", login: true } }),
      provider("cora", { oauth: { name: "Cora Pro", subscription: true } }),
      provider("dune", { oauth: { name: "Dune Max", subscription: true }, apiKey: { name: "Dune key", login: true } }),
    ];
    const { accounts, keys } = splitProviders(providers);
    expect(accounts.map((one) => one.id)).toEqual(["cora", "dune", "acme"]);
    expect(keys.map((one) => one.id)).toEqual(["acme", "beta", "dune"]);
  });

  it("never offers pi's own Anthropic account login, keeping Anthropic's key; Claude plans go through claude-bridge", () => {
    const anthropic = provider("anthropic", { oauth: { name: "Anthropic (Claude Pro/Max)", subscription: true }, apiKey: { name: "Anthropic API key", login: true } });
    const bridge = provider("claude-bridge", { oauth: { name: "Claude Code (Claude subscription)", subscription: true } });
    expect(splitProviders([anthropic]).accounts).toEqual([]);
    expect(splitProviders([anthropic]).keys.map((one) => one.id)).toEqual(["anthropic"]);
    const split = splitProviders([anthropic, bridge]);
    expect(split.accounts.map((one) => one.id)).toEqual(["claude-bridge"]);
    expect(split.keys.map((one) => one.id)).toEqual(["anthropic"]);
    expect(split.piClaude).toBeUndefined();
    // pi still has its own Claude login saved: offered to sign out of.
    const saved = { ...anthropic, stored: "oauth" as const, status: { method: "oauth" as const, source: "stored" } };
    expect(splitProviders([saved, bridge]).piClaude).toBe(saved);
    expect(splitProviders([saved]).piClaude).toBe(saved);
    expect(splitProviders([{ ...anthropic, stored: "api_key" }, bridge]).piClaude).toBeUndefined();
  });
});

describe("searchProviders", () => {
  const providers = [
    provider("groq", { apiKey: { name: "Groq API key", login: true } }),
    provider("google", { apiKey: { name: "Gemini API key", login: true }, status: { method: "api_key", source: "stored" } }),
    provider("zai", { name: "Z.AI", apiKey: { name: "Z.AI API key", login: true } }),
  ];

  it("matches every word against the name, id and key name, connected providers first", () => {
    expect(searchProviders(providers, "").map((one) => one.id)).toEqual(["google", "groq", "zai"]);
    expect(searchProviders(providers, "gemini").map((one) => one.id)).toEqual(["google"]);
    expect(searchProviders(providers, "z.ai key").map((one) => one.id)).toEqual(["zai"]);
    expect(searchProviders(providers, "groq gemini")).toEqual([]);
  });
});
