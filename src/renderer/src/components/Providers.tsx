// The Settings page's Providers section: sign in to pi's model providers the way pi's /login does. main runs each
// login with pi's own SDK (src/main/pi-auth.ts) and opens sign-in pages in the browser; what a login asks (a choice, a
// pasted code, an API key) is answered in a panel under the card or row that started it. Leaving the section cancels.
// With pi-claude-bridge, Claude plans sign in with Claude Code's own login instead of pi's.
import { Check, Copy, ExternalLink, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";
import { type AuthMethod, type AuthPrompt, type AuthProvider, type AuthState, authStatus, CLAUDE_BRIDGE, searchProviders, splitProviders, type StatusTone } from "../../../shared/auth";
import { tildify } from "../lib/format";
import { accountLabel, answered, type LoginView, logoFor, startLogin, updateLogin } from "../lib/login";
import { remoteError, toast } from "../state/app";
import { Button, ConfirmButton } from "./SettingsControls";

export function ProvidersSection() {
  const { state, reload } = useAuthState();
  const [login, setLogin] = useState<LoginView | null>(null);
  const [query, setQuery] = useState("");
  // The running login, so a result that arrives after you cancelled or started another one is ignored.
  const running = useRef(0);
  const seq = useRef(0);

  useEffect(() => window.studio.auth.onUpdate((update) => setLogin((view) => (view && !view.error ? updateLogin(view, update) : view))), []);
  useEffect(
    () => () => {
      if (running.current) window.studio.auth.cancel();
    },
    [],
  );

  const signIn = async (provider: AuthProvider, method: AuthMethod) => {
    const token = ++seq.current;
    running.current = token;
    setLogin(startLogin(provider, method));
    const result = await window.studio.auth.login(provider.id, method).catch((error: unknown) => ({ ok: false as const, cancelled: false, error: remoteError(error) }));
    if (running.current !== token) return;
    running.current = 0;
    if (result.ok) {
      setLogin(null);
      toast(method === "oauth" ? `Signed in to ${provider.name}. New chats can use its models.` : `Saved the ${provider.apiKey?.name ?? "API key"}. New chats can use ${provider.name}'s models.`);
    } else if (result.cancelled) setLogin(null);
    else setLogin((view) => view && { ...view, prompts: [], progress: undefined, error: result.error });
    reload();
  };
  const cancel = useCallback(() => {
    if (running.current) window.studio.auth.cancel();
    running.current = 0;
    setLogin(null);
  }, []);
  const answer = useCallback((prompt: AuthPrompt, value: string) => {
    window.studio.auth.answer(prompt.n, value);
    setLogin((view) => view && answered(view, prompt.n));
  }, []);
  const signOut = async (provider: AuthProvider) => {
    try {
      await window.studio.auth.logout(provider.id);
      toast(provider.stored === "oauth" ? `Signed out of ${provider.name}` : `Removed the saved ${provider.apiKey?.name ?? "API key"}`);
    } catch (error) {
      toast(remoteError(error), "error");
    }
    reload();
  };

  if (!state) {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-faint">
        <LoaderCircle size={13} className="animate-spin" /> Asking pi for its providers…
      </p>
    );
  }
  if (state.error) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-[12.5px] text-fg">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <p className="selectable break-words">{state.error}</p>
          <p className="mt-1 text-muted">pi-gna signs in with the pi on your PATH, the one its chats run.</p>
        </div>
        <Button onClick={reload}>Try again</Button>
      </div>
    );
  }

  const { accounts, keys, piClaude } = splitProviders(state.providers);
  const shown = searchProviders(keys, query);
  const busy = login !== null && !login.error;
  // In the two-column grid of accounts, a login's panel opens under the row of its card.
  const active = accounts.findIndex((provider) => login?.provider.id === provider.id && login.method === "oauth");
  const panelAfter = active === -1 ? -1 : Math.min(active + 1 - (active % 2), accounts.length - 1);
  return (
    <>
      <p className="text-[12px] leading-relaxed text-faint">
        Saved in pi's <span className="font-mono text-muted">{state.path ? tildify(state.path, window.studio.homeDir) : "auth.json"}</span>, which pi in the terminal uses too
        {accounts.some((provider) => provider.id === CLAUDE_BRIDGE) && "; Claude Code keeps its own login"}. Chats you start after signing in can use the provider's models.
      </p>
      <section>
        <h2 className="mb-2 text-[13px] font-medium text-fg">Accounts</h2>
        <div className="grid grid-cols-2 gap-2.5">
          {accounts.map((provider, index) => (
            <Fragment key={provider.id}>
              <AccountCard
                provider={provider}
                active={index === active}
                busy={busy}
                onSignIn={() => void signIn(provider, "oauth")}
                onSignOut={() => void signOut(provider)}
              />
              {index === panelAfter && login && (
                <div className="col-span-2">
                  <LoginPanel view={login} onAnswer={answer} onCancel={cancel} />
                </div>
              )}
            </Fragment>
          ))}
        </div>
        {piClaude && (
          <div className="mt-2.5 flex items-center gap-2.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[12.5px]">
            <TriangleAlert size={14} className="shrink-0 text-warn" />
            <p className="min-w-0 flex-1 text-muted">
              pi also has its own Claude login saved, for its <span className="font-mono text-[12px]">anthropic</span> provider.{" "}
              <span className="whitespace-nowrap font-mono text-[12px]">claude-bridge</span> uses Claude Code's login above, the safer way to use a Claude plan.
            </p>
            <ConfirmButton label="Sign out" confirm="Sign out?" title="Remove pi's own Anthropic login from auth.json" onConfirm={() => void signOut(piClaude)} />
          </div>
        )}
      </section>
      <section>
        <div className="mb-2 flex items-center gap-3">
          <h2 className="flex-1 text-[13px] font-medium text-fg">API keys</h2>
          <label className="flex w-52 items-center gap-2 rounded-lg bg-sunken px-2.5 py-1 focus-within:ring-1 focus-within:ring-line-strong">
            <Search size={12} className="shrink-0 text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Search providers"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
            />
          </label>
        </div>
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {shown.map((provider) => (
            <div key={provider.id}>
              <KeyRow provider={provider} busy={busy} onAdd={() => void signIn(provider, "api_key")} onRemove={() => void signOut(provider)} />
              {login?.provider.id === provider.id && login.method === "api_key" && (
                <div className="px-3 pb-3">
                  <LoginPanel view={login} onAnswer={answer} onCancel={cancel} />
                </div>
              )}
            </div>
          ))}
          {!shown.length && <p className="px-3 py-2.5 text-[12.5px] text-faint">No provider matches “{query}”.</p>}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-faint">
          A key in your shell's environment (say <span className="font-mono">ANTHROPIC_API_KEY</span>) works without saving it here; pi-gna reads the environment of your login shell.
        </p>
      </section>
    </>
  );
}

/** pi's providers, read again when you come back to the window (you may have signed in in a terminal). */
function useAuthState(): { state?: AuthState; reload: () => void } {
  const [state, setState] = useState<AuthState>();
  const reload = useCallback(() => {
    void window.studio.auth.list().then(setState, (error: unknown) => setState({ providers: [], error: remoteError(error) }));
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  return { state, reload };
}

// ── Providers ────────────────────────────────────────────────────────────────

function AccountCard({ provider, active, busy, onSignIn, onSignOut }: { provider: AuthProvider; active: boolean; busy: boolean; onSignIn: () => void; onSignOut: () => void }) {
  const status = authStatus(provider, "oauth");
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-3 transition-colors ${active ? "border-line-strong bg-raised/50" : "border-line"}`}>
      <ProviderLogo id={provider.id} name={provider.name} size={36} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-fg">{provider.name}</div>
        <div className="truncate text-[12px] text-faint">{provider.account ?? accountLabel(provider)}</div>
        {status.tone !== "off" && <Status text={status.text} tone={status.tone} />}
      </div>
      {provider.stored === "oauth" ? (
        <ConfirmButton
          label="Sign out"
          confirm="Sign out?"
          title={provider.id === CLAUDE_BRIDGE ? "Signs Claude Code out on this Mac, in the terminal too" : undefined}
          onConfirm={onSignOut}
        />
      ) : (
        <Button disabled={busy} title={provider.oauth?.label} onClick={onSignIn}>
          {active ? "Signing in…" : "Sign in"}
        </Button>
      )}
    </div>
  );
}

function KeyRow({ provider, busy, onAdd, onRemove }: { provider: AuthProvider; busy: boolean; onAdd: () => void; onRemove: () => void }) {
  const status = authStatus(provider, "api_key");
  const saved = provider.stored === "api_key";
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <ProviderLogo id={provider.id} name={provider.name} size={26} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-fg">{provider.name}</div>
        <div className="truncate text-[11.5px] text-faint">{provider.apiKey?.name}</div>
      </div>
      {status.tone !== "off" && <Status text={status.text} tone={status.tone} className="shrink-0" />}
      {saved && <ConfirmButton label="Remove" confirm="Remove key?" onConfirm={onRemove} />}
      {provider.apiKey?.login ? (
        <Button disabled={busy} onClick={onAdd}>
          {saved ? "Replace" : "Add key"}
        </Button>
      ) : (
        !provider.status && <span className="shrink-0 text-[12px] text-faint">Set in the environment</span>
      )}
    </div>
  );
}

const TONES: Record<StatusTone, string> = { on: "bg-ok", other: "bg-warn", off: "bg-line-strong" };

function Status({ text, tone, className = "" }: { text: string; tone: StatusTone; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${tone === "off" ? "text-faint" : "text-muted"} ${className}`} title={text}>
      <span className={`size-1.5 shrink-0 rounded-full ${TONES[tone]}`} />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** The provider's mark on its brand tile (src/renderer/src/lib/provider-logos.ts), or its initial. */
export function ProviderLogo({ id, name, size }: { id: string; name: string; size: number }) {
  const prefix = useId().replace(/[^\w-]/g, "");
  const logo = logoFor(id);
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.26) };
  if (!logo) {
    return (
      <span aria-hidden="true" style={{ ...box, fontSize: Math.round(size * 0.45) }} className="flex shrink-0 items-center justify-center bg-raised font-semibold text-muted ring-1 ring-line ring-inset">
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  const mark = Math.round(size * logo.scale);
  return (
    <span aria-hidden="true" style={{ ...box, background: logo.background, color: logo.color }} className="flex shrink-0 items-center justify-center ring-1 ring-black/10 ring-inset dark:ring-white/10">
      {/* The markup is generated from vendored SVG files, never from input. */}
      <svg viewBox={logo.viewBox} width={mark} height={mark} dangerouslySetInnerHTML={{ __html: logo.body.replaceAll("{id}", prefix) }} />
    </span>
  );
}

// ── A running login ──────────────────────────────────────────────────────────

function LoginPanel({ view, onAnswer, onCancel }: { view: LoginView; onAnswer: (prompt: AuthPrompt, value: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Not an expression body: Chromium's smooth scrollIntoView returns a promise, which React would take for a cleanup.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  // esc cancels the login rather than leaving Settings (App's handler skips handled keys); in another field it is that
  // field's (the search clears).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLInputElement && !ref.current?.contains(event.target)) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const { provider, method } = view;
  const waiting = !view.error && view.prompts.length === 0;
  return (
    <div ref={ref} className="flex flex-col gap-3 rounded-xl border border-line-strong bg-panel p-3.5 shadow-sm">
      <div className="flex items-center gap-2.5">
        <ProviderLogo id={provider.id} name={provider.name} size={22} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{method === "oauth" ? `Sign in to ${provider.name}` : (provider.apiKey?.name ?? `${provider.name} API key`)}</span>
        <button type="button" onClick={onCancel} title="Cancel (esc)" className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
          <X size={14} />
        </button>
      </div>
      {view.url && (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-fg">
            Your browser opened <span className="font-mono text-[12px]">{host(view.url.url)}</span>. Finish signing in there.
          </p>
          {/* pi's instructions repeat what a paste prompt asks; shown when there is none. */}
          {view.url.instructions && view.prompts.length === 0 && <p className="text-[12px] leading-relaxed text-faint">{view.url.instructions}</p>}
          <div className="flex gap-2">
            <Button onClick={() => window.studio.openExternal(view.url?.url ?? "")}>
              <ExternalLink size={12} /> Open again
            </Button>
            <CopyButton text={view.url.url} label="Copy link" />
          </div>
        </div>
      )}
      {view.device && (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-fg">
            Enter this code at <span className="font-mono text-[12px]">{host(view.device.verificationUri)}</span>:
          </p>
          <div className="flex items-center gap-2">
            <span className="selectable rounded-lg bg-sunken px-3 py-1.5 font-mono text-[18px] tracking-[0.2em] text-fg">{view.device.userCode}</span>
            <CopyButton text={view.device.userCode} label="Copy" />
            <Button primary onClick={() => window.studio.openExternal(view.device?.verificationUri ?? "")}>
              <ExternalLink size={12} /> Open page
            </Button>
          </div>
        </div>
      )}
      {view.notes.map((note, index) => (
        <p key={index} className="text-[12.5px] leading-relaxed text-muted">
          {note.message}
          {note.links?.map((link) => (
            <button key={link.url} type="button" onClick={() => window.studio.openExternal(link.url)} className="ml-1.5 text-accent hover:underline">
              {link.label ?? host(link.url)}
            </button>
          ))}
        </p>
      ))}
      {view.prompts.map((prompt, index) => (
        <PromptField key={prompt.n} prompt={prompt} focus={index === view.prompts.length - 1} onAnswer={(value) => onAnswer(prompt, value)} />
      ))}
      {view.error ? (
        <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-[12.5px] text-fg">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-bad" />
          <p className="selectable min-w-0 flex-1 break-words">{view.error}</p>
          <Button onClick={onCancel}>Close</Button>
        </div>
      ) : (
        waiting && (
          <p className="flex items-center gap-2 text-[12px] text-faint">
            <LoaderCircle size={12} className="animate-spin" />
            {view.progress ?? (view.url ? "Waiting for the browser…" : "Starting…")}
          </p>
        )
      )}
    </div>
  );
}

/** One question of a login: a choice, or a line of text (an API key is masked). */
function PromptField({ prompt, focus, onAnswer }: { prompt: AuthPrompt; focus: boolean; onAnswer: (value: string) => void }) {
  const [value, setValue] = useState("");
  if (prompt.type === "select") {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[12.5px] text-fg">{prompt.message}</p>
        <div className="flex flex-col gap-1">
          {prompt.options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              autoFocus={focus && index === 0}
              onClick={() => onAnswer(option.id)}
              className="flex flex-col items-start rounded-lg border border-line px-3 py-2 text-left hover:border-line-strong hover:bg-raised focus-visible:border-line-strong focus-visible:outline-none"
            >
              <span className="text-[12.5px] text-fg">{option.label}</span>
              {option.description && <span className="text-[11.5px] text-faint">{option.description}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }
  // GitHub Copilot asks for an Enterprise domain, blank for github.com; a key or a code cannot be blank.
  const required = prompt.type !== "text";
  const submit = () => {
    if (!required || value.trim()) onAnswer(prompt.type === "secret" ? value.trim() : value);
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="text-[12.5px] text-fg" htmlFor={`prompt-${prompt.n}`}>
        {prompt.message}
      </label>
      <div className="flex gap-2">
        <input
          id={`prompt-${prompt.n}`}
          type={prompt.type === "secret" ? "password" : "text"}
          autoFocus={focus}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={prompt.placeholder}
          onChange={(event) => setValue(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-line bg-sunken px-2.5 py-1.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-faint focus:border-line-strong"
        />
        <button
          type="submit"
          disabled={required && !value.trim()}
          className="shrink-0 rounded-lg border border-accent bg-accent px-3 py-1 text-[12px] font-medium text-white enabled:hover:opacity-90 disabled:opacity-40"
        >
          {prompt.type === "secret" ? "Save" : "Continue"}
        </button>
      </div>
    </form>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />} {copied ? "Copied" : label}
    </Button>
  );
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
