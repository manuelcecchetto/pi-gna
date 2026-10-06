// Extension dialogs (select / confirm / input / editor) as approval cards above the composer.
import { ShieldQuestion } from "./icons";
import { useEffect, useRef, useState } from "react";
import type { ExtensionUiDialog } from "../../../shared/protocol";
import { useChatActions } from "../lib/chat-ui";
import { Ansi, Kbd, useNow } from "./primitives";

export function Dialogs({ handle, dialogs }: { handle: string; dialogs: ExtensionUiDialog[] }) {
  if (!dialogs.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {dialogs.map((dialog) => (
        <DialogCard key={dialog.id} handle={handle} dialog={dialog} />
      ))}
    </div>
  );
}

function Countdown({ timeout }: { timeout: number }) {
  const [start] = useState(() => Date.now());
  const now = useNow(250);
  const left = Math.max(0, Math.ceil((timeout - (now - start)) / 1000));
  return <span className="font-mono text-[11px] text-faint tabular-nums">{left}s</span>;
}

function DialogCard({ handle, dialog }: { handle: string; dialog: ExtensionUiDialog }) {
  const [value, setValue] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
  const [selected, setSelected] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const { respondDialog } = useChatActions();
  const cancel = () => respondDialog(handle, { type: "extension_ui_response", id: dialog.id, cancelled: true });
  const submitValue = (text: string) => respondDialog(handle, { type: "extension_ui_response", id: dialog.id, value: text });
  const confirm = (confirmed: boolean) => respondDialog(handle, { type: "extension_ui_response", id: dialog.id, confirmed });

  useEffect(() => {
    card.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      cancel();
    } else if (dialog.method === "select") {
      if (event.key === "ArrowDown") setSelected((i) => Math.min(dialog.options.length - 1, i + 1));
      else if (event.key === "ArrowUp") setSelected((i) => Math.max(0, i - 1));
      else if (event.key === "Enter") submitValue(dialog.options[selected] ?? "");
      else if (/^[1-9]$/.test(event.key) && dialog.options[Number(event.key) - 1] !== undefined) submitValue(dialog.options[Number(event.key) - 1] as string);
      else return;
      event.preventDefault();
    }
  };

  return (
    <div
      ref={card}
      onKeyDown={onKeyDown}
      className="rounded-2xl border border-accent/35 bg-panel p-3.5 shadow-[0_0_0_4px_var(--accent-soft)]"
    >
      <div className="flex items-start gap-2.5">
        <ShieldQuestion size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-fg">
            <Ansi text={dialog.title} />
          </div>
          {dialog.method === "confirm" && dialog.message && (
            <div className="selectable mt-1 whitespace-pre-wrap text-[13px] text-muted">
              <Ansi text={dialog.message} />
            </div>
          )}
        </div>
        {dialog.timeout ? <Countdown timeout={dialog.timeout} /> : null}
      </div>

      <div className="mt-3 pl-[26px] touch:pl-0">
        {dialog.method === "select" && (
          <div className="flex flex-col gap-1 outline-none" data-autofocus tabIndex={-1}>
            {dialog.options.map((option, index) => (
              <button
                key={option}
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={() => submitValue(option)}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 touch:py-3 text-left text-[13px] touch:text-[15px] ${index === selected ? "bg-raised text-fg" : "text-muted"}`}
              >
                <span className="font-mono text-[11px] text-faint">{index + 1}</span>
                <Ansi text={option} />
              </button>
            ))}
          </div>
        )}
        {dialog.method === "confirm" && (
          <div className="flex gap-2">
            <button type="button" data-autofocus onClick={() => confirm(true)} className="rounded-lg bg-accent px-3 py-1.5 touch:px-5 touch:py-2.5 text-[13px] touch:text-[15px] font-medium text-white">
              Allow
            </button>
            <button type="button" onClick={() => confirm(false)} className="rounded-lg border border-line px-3 py-1.5 touch:px-5 touch:py-2.5 text-[13px] touch:text-[15px] text-muted hover:text-fg">
              Deny
            </button>
          </div>
        )}
        {(dialog.method === "input" || dialog.method === "editor") && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitValue(value);
            }}
            className="flex flex-col gap-2"
          >
            {dialog.method === "input" ? (
              <input
                data-autofocus
                value={value}
                placeholder={dialog.placeholder}
                onChange={(event) => setValue(event.target.value)}
                className="rounded-lg border border-line bg-sunken px-2.5 py-1.5 touch:py-2.5 text-[13px] touch:text-[16px] outline-none focus:border-accent/60"
              />
            ) : (
              <textarea
                data-autofocus
                value={value}
                rows={8}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submitValue(value);
                }}
                className="rounded-lg border border-line bg-sunken px-2.5 py-1.5 font-mono text-[12.5px] touch:text-[16px] outline-none focus:border-accent/60"
              />
            )}
            <div className="flex items-center gap-2">
              <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 touch:px-5 touch:py-2.5 text-[13px] touch:text-[15px] font-medium text-white">
                Submit
              </button>
              <button type="button" onClick={cancel} className="rounded-lg border border-line px-3 py-1.5 touch:px-5 touch:py-2.5 text-[13px] touch:text-[15px] text-muted hover:text-fg">
                Cancel
              </button>
              {dialog.method === "editor" && (
                <span className="ml-auto text-[11px] text-faint">
                  <Kbd>⌘</Kbd> <Kbd>⏎</Kbd> to submit
                </span>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
