// Providers on the phone: sign in to pi's model providers with credentials that only ever travel phone -> host. An API
// key is typed here, goes to `providers.answer` over TLS and is saved by pi in the Mac's auth.json; the host never sends
// one back (AuthState holds names and statuses). Account sign-ins show their link or device code on the phone, and a flow
// that can only finish in the Mac's browser says so.
import { CodeText } from "../renderer/src/components/CodeText";
import { Check, ExternalLink, LoaderCircle, Search, TriangleAlert } from "../renderer/src/components/icons";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { accountLabel, answered, type LoginView, startLogin, updateLogin } from "../renderer/src/lib/login";
import { type AuthMethod, type AuthPrompt, type AuthProvider, type AuthState, authStatus, CLAUDE_BRIDGE, searchProviders, splitProviders } from "../shared/auth";
import type { HostClient } from "./client/host-client";
import { isWebUrl, loginGuide, pageHost } from "./login-view";
import { Sheet } from "./Sheets";
import { toast } from "./toasts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const SETTLE_MS = 1500;

function copy(text: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast("Copied"),
    () => toast("Could not copy", "warning"),
  );
}

const button = "flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-line px-3.5 text-[14px] text-fg active:bg-raised disabled:opacity-40";

export function ProvidersSection({ client }: { client: HostClient }) {
  const [state, setState] = useState<AuthState>();
  const [query, setQuery] = useState("");
  const [login, setLogin] = useState<LoginView | null>(null);
  const [signOut, setSignOut] = useState<AuthProvider | null>(null);
  // The running login, so a result that arrives after Cancel or after another login started is ignored.
  const running = useRef(0);
  const seq = useRef(0);

  const reload = useCallback(() => {
    client.call("providers.list", {}).then(setState, (error: unknown) => setState({ providers: [], error: message(error) }));
  }, [client]);
  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  useEffect(() => client.onLoginUpdate((update) => setLogin((view) => (view && !view.error ? updateLogin(view, update) : view))), [client]);
  // Leaving the section ends the login on the host.
  useEffect(
    () => () => {
      if (running.current) void client.call("providers.cancel", {}).catch(() => undefined);
    },
    [client],
  );

  const signIn = async (provider: AuthProvider, method: AuthMethod) => {
    const token = ++seq.current;
    running.current = token;
    setLogin(startLogin(provider, method));
    const result = await client.call("providers.login", { provider: provider.id, method }).catch((error: unknown) => ({ ok: false as const, cancelled: false, error: message(error) }));
    if (running.current !== token) return;
    running.current = 0;
    if (result.ok) {
      setLogin(null);
      toast(method === "oauth" ? `Signed in to ${provider.name}. New chats can use its models.` : `Saved the ${provider.apiKey?.name ?? "API key"}.`);
    } else if (result.cancelled) setLogin(null);
    else setLogin((view) => view && { ...view, prompts: [], progress: undefined, error: result.error });
    reload();
  };
  const cancel = useCallback(() => {
    if (running.current) void client.call("providers.cancel", {}).catch(() => undefined);
    running.current = 0;
    setLogin(null);
  }, [client]);
  const answer = useCallback(
    (prompt: AuthPrompt, value: string) => {
      void client.call("providers.answer", { n: prompt.n, value }).catch((error: unknown) => toast(message(error), "error"));
      setLogin((view) => view && answered(view, prompt.n));
    },
    [client],
  );
  const confirmSignOut = async (provider: AuthProvider) => {
    setSignOut(null);
    try {
      await client.call("providers.logout", { provider: provider.id });
      toast(provider.stored === "oauth" ? `Signed out of ${provider.name}` : `Removed the saved ${provider.apiKey?.name ?? "API key"}`);
    } catch (error) {
      toast(message(error), "error");
    }
    reload();
  };

  if (!state) {
    return (
      <p className="flex items-center gap-2 px-5 pt-4 text-[13px] text-faint">
        <LoaderCircle size={14} className="animate-spin" /> Asking pi for its providers…
      </p>
    );
  }
  if (state.error) {
    return (
      <div className="mx-4 mt-4 flex flex-col gap-2 rounded-xl border border-warn/40 p-3 text-[13px] text-fg" data-testid="providers-error">
        <p className="break-words">
          <CodeText text={state.error} />
        </p>
        <p className="text-muted">pi-gna signs in with the pi on the Mac's PATH, the one its chats run.</p>
        <button type="button" className={button} onClick={reload}>
          Try again
        </button>
      </div>
    );
  }
  const { accounts, keys, piClaude } = splitProviders(state.providers);
  const shown = searchProviders(keys, query);
  const busy = login !== null && !login.error;
  return (
    <div data-testid="providers">
      <p className="px-5 pt-3 text-[12px] leading-relaxed text-faint">Keys and logins are saved by pi on the Mac. This phone sends them and never receives them back.</p>
      <Group title="Accounts">
        {accounts.map((provider) => {
          const status = authStatus(provider, "oauth");
          return (
            <ProviderRow key={provider.id} id={provider.id} title={provider.name} about={provider.account ?? accountLabel(provider)} status={status.tone === "off" ? undefined : status.text}>
              {provider.stored === "oauth" ? (
                <button type="button" className={button} onClick={() => setSignOut(provider)} data-testid={`signout-${provider.id}`}>
                  Sign out
                </button>
              ) : (
                <button type="button" className={button} disabled={busy} onClick={() => void signIn(provider, "oauth")} data-testid={`signin-${provider.id}`}>
                  Sign in
                </button>
              )}
            </ProviderRow>
          );
        })}
        {piClaude && (
          <ProviderRow id="anthropic" title="pi's own Claude login" about="Saved for the anthropic provider; claude-bridge uses Claude Code's login instead, the safer way." status="Signed in">
            <button type="button" className={button} onClick={() => setSignOut(piClaude)}>
              Sign out
            </button>
          </ProviderRow>
        )}
      </Group>
      <Group title="API keys">
        <label className="flex items-center gap-2 px-3.5 py-2">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search providers"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
          />
        </label>
        {shown.map((provider) => {
          const status = authStatus(provider, "api_key");
          const saved = provider.stored === "api_key";
          return (
            <ProviderRow key={provider.id} id={provider.id} title={provider.name} about={provider.apiKey?.name} status={status.tone === "off" ? undefined : status.text}>
              {saved && (
                <button type="button" className={button} onClick={() => setSignOut(provider)} data-testid={`remove-${provider.id}`}>
                  Remove
                </button>
              )}
              {provider.apiKey?.login ? (
                <button type="button" className={button} disabled={busy} onClick={() => void signIn(provider, "api_key")} data-testid={`addkey-${provider.id}`}>
                  {saved ? "Replace" : "Add key"}
                </button>
              ) : (
                !provider.status && <span className="text-[12px] text-faint">Set on the Mac</span>
              )}
            </ProviderRow>
          );
        })}
        {!shown.length && <p className="px-3.5 py-3 text-[13px] text-faint">No provider matches “{query}”.</p>}
      </Group>
      {login && <LoginSheet view={login} onAnswer={answer} onCancel={cancel} />}
      {signOut && (
        <Sheet title={signOut.stored === "oauth" ? `Sign out of ${signOut.name}?` : "Remove the saved key?"} onClose={() => setSignOut(null)} testId="confirm-signout">
          <div className="px-4 pb-2">
            {signOut.id === CLAUDE_BRIDGE && <p className="pb-3 text-[13.5px] text-muted">This signs Claude Code out on the whole Mac, in the terminal too.</p>}
            {signOut.stored === "api_key" && <p className="pb-3 text-[13.5px] text-muted">pi forgets the key saved for {signOut.name}. A key from the Mac's environment stays.</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setSignOut(null)} className="min-h-12 flex-1 rounded-xl border border-line text-[15px] text-fg">
                Keep
              </button>
              <button type="button" onClick={() => void confirmSignOut(signOut)} className="min-h-12 flex-1 rounded-xl bg-bad text-[15px] font-medium text-white" data-testid="confirm-signout-go">
                {signOut.stored === "oauth" ? "Sign out" : "Remove"}
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-4 pt-4">
      <h2 className="mb-1.5 px-1 text-[12px] font-medium uppercase tracking-wide text-faint">{title}</h2>
      <div className="flex flex-col divide-y divide-line rounded-xl border border-line">{children}</div>
    </section>
  );
}

function ProviderRow({ id, title, about, status, children }: { id: string; title: string; about?: string; status?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-3.5 py-2.5" data-testid={`provider-${id}`}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] text-fg">{title}</div>
        {about && <div className="truncate text-[12px] text-faint">{about}</div>}
        {status && (
          <div className="truncate text-[12px] text-muted" data-testid={`status-${id}`}>
            {status}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

// ── A running login ──────────────────────────────────────────────────────────

function LoginSheet({ view, onAnswer, onCancel }: { view: LoginView; onAnswer: (prompt: AuthPrompt, value: string) => void; onCancel: () => void }) {
  const [settled, setSettled] = useState(false);
  const link = view.url?.url;
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [link]);
  const { provider, method } = view;
  const guide = loginGuide(view, settled);
  const waiting = !view.error && view.prompts.length === 0;
  return (
    <Sheet title={method === "oauth" ? `Sign in to ${provider.name}` : (provider.apiKey?.name ?? `${provider.name} API key`)} onClose={onCancel} testId="login-sheet">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-3">
        {view.device && (
          <div className="flex flex-col gap-2" data-testid="login-device">
            <p className="text-[13.5px] text-fg">
              Enter this code at <span className="font-mono text-[13px]">{pageHost(view.device.verificationUri)}</span>:
            </p>
            <span className="selectable self-start rounded-lg bg-sunken px-3 py-2 font-mono text-[22px] tracking-[0.2em] text-fg" data-testid="login-code">
              {view.device.userCode}
            </span>
            <div className="flex gap-2">
              <button type="button" className={button} onClick={() => copy(view.device?.userCode ?? "")}>
                Copy
              </button>
              {isWebUrl(view.device.verificationUri) && (
                <a className={`${button} bg-accent text-white`} href={view.device.verificationUri} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> Open page
                </a>
              )}
            </div>
          </div>
        )}
        {link && guide !== "mac" && isWebUrl(link) && (
          <div className="flex flex-col gap-2" data-testid="login-link">
            <p className="text-[13.5px] text-fg">
              Sign in at <span className="font-mono text-[13px]">{pageHost(link)}</span>, then paste what the page gives you below.
            </p>
            {view.url?.instructions && <p className="text-[12.5px] leading-relaxed text-faint">{view.url.instructions}</p>}
            <div className="flex gap-2">
              <a className={`${button} bg-accent text-white`} href={link} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Open sign-in page
              </a>
              <button type="button" className={button} onClick={() => copy(link)}>
                Copy link
              </button>
            </div>
          </div>
        )}
        {guide === "mac" && (
          <p className="rounded-xl border border-warn/40 p-3 text-[13.5px] text-fg" data-testid="login-mac">
            Finish this sign-in on the Mac. {provider.name} redirects to a page that only the Mac's browser can reach, and it is waiting there.
          </p>
        )}
        {view.notes.map((note, index) => (
          <p key={index} className="text-[13px] leading-relaxed text-muted">
            {note.message}
            {note.links?.filter((l) => isWebUrl(l.url)).map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="ml-1.5 text-accent">
                {l.label ?? pageHost(l.url)}
              </a>
            ))}
          </p>
        ))}
        {view.prompts.map((prompt, index) => (
          <PromptField key={prompt.n} prompt={prompt} focus={index === view.prompts.length - 1} onAnswer={(value) => onAnswer(prompt, value)} />
        ))}
        {view.error ? (
          <div className="flex items-start gap-2 rounded-xl border border-bad/40 p-3 text-[13.5px] text-fg" data-testid="login-error">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-bad" />
            <p className="min-w-0 flex-1 break-words">
              <CodeText text={view.error} />
            </p>
          </div>
        ) : (
          waiting && (
            <p className="flex items-center gap-2 text-[13px] text-faint">
              <LoaderCircle size={13} className="animate-spin" />
              {view.progress ?? (view.url ? "Waiting for the sign-in…" : "Starting…")}
            </p>
          )
        )}
        <button type="button" className={button} onClick={onCancel} data-testid="login-cancel">
          {view.error ? "Close" : "Cancel"}
        </button>
      </div>
    </Sheet>
  );
}

/** One question of a login: a choice, or a line of text; an API key or a pasted code is masked and never echoed. */
function PromptField({ prompt, focus, onAnswer }: { prompt: AuthPrompt; focus: boolean; onAnswer: (value: string) => void }) {
  const [value, setValue] = useState("");
  if (prompt.type === "select") {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-[13.5px] text-fg">{prompt.message}</p>
        {prompt.options.map((option) => (
          <button key={option.id} type="button" onClick={() => onAnswer(option.id)} className="flex min-h-12 flex-col items-start justify-center rounded-xl border border-line px-3 py-2 text-left active:bg-raised" data-testid="login-option">
            <span className="text-[14px] text-fg">{option.label}</span>
            {option.description && <span className="text-[12px] text-faint">{option.description}</span>}
          </button>
        ))}
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
      <label className="text-[13.5px] text-fg" htmlFor={`prompt-${prompt.n}`}>
        {prompt.message}
      </label>
      <div className="flex gap-2">
        <input
          id={`prompt-${prompt.n}`}
          type={prompt.type === "secret" ? "password" : "text"}
          autoFocus={focus}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          placeholder={prompt.placeholder}
          onChange={(event) => setValue(event.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-sunken px-3 font-mono text-[14px] text-fg outline-none placeholder:text-faint"
          data-testid="login-input"
        />
        <button type="submit" disabled={required && !value.trim()} className="flex min-h-11 items-center gap-1.5 rounded-xl bg-accent px-4 text-[14px] font-medium text-white disabled:opacity-40" data-testid="login-submit">
          <Check size={15} /> {prompt.type === "secret" ? "Save" : "Continue"}
        </button>
      </div>
    </form>
  );
}
