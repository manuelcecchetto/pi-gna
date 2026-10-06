// Settings > Appearance's custom theme (src/shared/themes.ts): fonts and colors for every project, and for the project
// on screen also its own mode, wallpaper and logo. Each control sends a one-field patch; agents send the same ones with
// set_theme.
import { RotateCcw } from "./icons";
import { useEffect, useRef, useState } from "react";
import { projectOf } from "../../../shared/board";
import { THEMES, type Theme, WALLPAPERS } from "../../../shared/settings";
import { COLOR_KEYS, effectiveTheme, type ColorKey, FONT_SIZE, MODES, type Mode, scopeTheme, type ThemeScope, type ThemeSpec } from "../../../shared/themes";
import { THEME_PRESETS } from "../../../shared/theme-presets";
import { baseName } from "../lib/format";
import { WALLPAPER_LABELS } from "../lib/wallpapers";
import { applyTheme, useApp } from "../state/app";
import { Card, ConfirmButton, NumberField, Row, Segmented } from "./SettingsControls";

const COLOR_LABELS: Record<ColorKey, string> = { primary: "Primary", secondary: "Secondary", accent: "Accent", background: "Background", panel: "Panel", fg: "Text" };
const COLOR_ABOUT: Record<ColorKey, string> = {
  primary: "Buttons, selection and focus",
  secondary: "Links",
  accent: "Text selection",
  background: "The canvas and sidebar",
  panel: "Cards and fields",
  fg: "Text, and its muted shades",
};
/** The defaults in styles.css, shown while a color is unset. */
const DEFAULTS: Record<Mode, Record<ColorKey, string>> = {
  dark: { primary: "#5b8def", secondary: "#5b8def", accent: "#5b8def", background: "#1b1b1d", panel: "#222225", fg: "#ececef" },
  light: { primary: "#2f6fe4", secondary: "#2f6fe4", accent: "#2f6fe4", background: "#fcfcfb", panel: "#f4f4f3", fg: "#1d1d20" },
};
const MODE_LABELS: Record<Mode, string> = { light: "Light", dark: "Dark" };
const BASES = ["inherit", ...THEMES] as const;
const BASE_LABELS: Record<(typeof BASES)[number], string> = { inherit: "Inherit", system: "System", light: "Light", dark: "Dark" };

/** Text saved when you leave the field or press Enter; empty resets. */
function TextField({ value, placeholder, onCommit, mono }: { value: string; placeholder: string; onCommit: (value: string | null) => Promise<boolean>; mono?: boolean }) {
  const [text, setText] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => setText(value), [value]);
  const revision = useRef(0);
  const commit = async () => {
    if (cancelled.current) { cancelled.current = false; return; }
    const next = text.trim();
    const at = revision.current;
    if (next !== value && !(await onCommit(next === "" ? null : next)) && at === revision.current) setText(value);
  };
  return (
    <input
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => { revision.current++; setText(event.target.value); }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        else if (event.key === "Escape") {
          event.stopPropagation();
          cancelled.current = true;
          setText(value);
          event.currentTarget.blur();
        }
      }}
      className={`w-56 shrink-0 rounded-lg border border-line bg-transparent px-2 py-1 text-[12px] text-fg outline-none placeholder:text-faint focus:border-line-strong ${mono ? "font-mono" : ""}`}
    />
  );
}

function ColorField({ mode, name, value, inherited, onChange }: { mode: Mode; name: ColorKey; value?: string; inherited?: string; onChange: (value: string | null) => void }) {
  const shown = value ?? inherited ?? DEFAULTS[mode][name];
  const hex = /^#[0-9a-f]{6}$/i.test(shown) ? shown : "#000000";
  return (
    <div className="flex items-center gap-2 py-1" title={COLOR_ABOUT[name]}>
      <label className="relative size-6 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line-strong" style={{ background: shown }}>
        <input
          type="color"
          aria-label={`${MODE_LABELS[mode]} ${COLOR_LABELS[name]}`}
          value={hex}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-fg">{COLOR_LABELS[name]}</div>
        <div className={`font-mono text-[11px] ${value ? "text-muted" : "text-faint"}`}>{value ?? (inherited ? `${inherited} (palette)` : "default")}</div>
      </div>
      {value && (
        <button type="button" title="Back to the default" onClick={() => onChange(null)} className="rounded-md p-1 text-faint hover:bg-raised hover:text-fg">
          <RotateCcw size={11} />
        </button>
      )}
    </div>
  );
}

/** Color inputs fire on every drag step: only the last value of a burst is sent. */
function useDebounced(send: (patch: unknown) => void, scope: string) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const cancel = () => { for (const timer of timers.current.values()) clearTimeout(timer); timers.current.clear(); };
  useEffect(() => cancel, [scope]);
  return {
    cancel,
    send: (key: string, patch: unknown) => {
      clearTimeout(timers.current.get(key));
      timers.current.set(key, setTimeout(() => { timers.current.delete(key); send(patch); }, 250));
    },
  };
}

export function ThemeEditor({ cwd }: { cwd: string }) {
  const themes = useApp((state) => state.themes);
  const settings = useApp((state) => state.settings);
  const projects = useApp((state) => state.projects);
  const current = cwd && cwd !== window.studio.homeDir ? projectOf(cwd) : undefined;
  const [target, setTarget] = useState(current && themes.projects[current] ? current : "global");
  const project = target === "global" ? undefined : target;
  const choices = [...new Set([
    ...projects.map((item) => projectOf(item.cwd)),
    ...Object.keys(themes.projects),
    ...(current ? [current] : []),
    ...(project ? [project] : []),
  ])].filter((path) => path !== window.studio.homeDir).sort((a, b) => baseName(a).localeCompare(baseName(b)) || a.localeCompare(b));
  const scope: ThemeScope = project ? { project } : "global";
  const theme: ThemeSpec = scopeTheme(themes, scope);
  const set = (patch: unknown) => applyTheme({ type: "set", scope, patch });
  const colors = useDebounced(set, JSON.stringify(scope));
  const resolved = effectiveTheme(themes, settings, scope === "global" ? undefined : project);
  const selected = theme.preset ?? (scope === "global" ? "original" : themes.global.preset ?? "original");
  const wallpaper = theme.wallpaper;
  const wallpaperChoice = !wallpaper ? "inherit" : "builtin" in wallpaper ? wallpaper.builtin : "image";

  return (
    <Card
      key={JSON.stringify(scope)}
      title="Project themes"
      note={
        <>
          Fonts use installed family names on each device (unavailable fonts fall back to the system font). Images are files inside the project, by their path from its folder. Agents can change all of this with their{" "}
          <span className="font-mono">set_theme</span> tool: ask a chat to theme the project.
        </>
      }
    >
      <Row title="Applies to" about={project ? `Only ${project}. Changes appear when this project is active.` : "Every project without its own value."}>
        <select aria-label="Applies to" value={target} onChange={(event) => { colors.cancel(); setTarget(event.target.value); }} className="max-w-64 truncate rounded-lg border border-line bg-panel px-2 py-1 text-[12px] text-fg outline-none">
          <option value="global">All projects</option>
          {choices.map((path) => <option key={path} value={path}>{choices.some((other) => other !== path && baseName(other) === baseName(path)) ? path : baseName(path)}</option>)}
        </select>
      </Row>
      <div className="px-3 py-3">
        <div className="mb-2 flex items-center justify-between text-[12px] text-muted">
          <span>{scope !== "global" && !theme.preset ? "Inherited palette" : "Palette"}{theme.colors || theme.font ? " · customized" : ""} · light and dark</span>
          {scope !== "global" && theme.preset && <button type="button" className="text-accent" onClick={() => { colors.cancel(); void set({ preset: null, font: null, colors: null }); }}>Use global</button>}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {THEME_PRESETS.map((preset) => {
            const palette = { ...DEFAULTS.dark, ...preset.colors.dark };
            return <button key={preset.id} type="button" aria-pressed={selected === preset.id} title={preset.about} onClick={() => { colors.cancel(); void set({ preset: preset.id, font: null, colors: null }); }} className={`rounded-lg border p-2 text-left hover:bg-raised ${selected === preset.id ? "border-accent" : "border-line"}`}>
              <div className="mb-1.5 flex gap-1" aria-hidden="true">{(["background", "primary", "secondary", "accent"] as const).map((key) => <span key={key} className="h-3 flex-1 rounded-sm border border-line" style={{ background: palette[key] }} />)}</div>
              <div className="text-[12px] text-fg">{preset.name}</div>
            </button>;
          })}
        </div>
        <p className="mt-2 text-[11px] text-faint">Original is the default. Picking a palette resets custom fonts and colors, not your mode, wallpaper or logo.</p>
      </div>
      {scope !== "global" && (
        <Row title="Mode" about="Inherit uses the Theme above.">
          <Segmented value={theme.base ?? "inherit"} options={BASES} labels={BASE_LABELS} onChange={(base) => set({ base: base === "inherit" ? null : (base as Theme) })} />
        </Row>
      )}
      <Row title="Interface font" about="Default: the system font.">
        <TextField value={theme.font?.ui ?? ""} placeholder="System" onCommit={(ui) => set({ font: { ui } })} />
      </Row>
      <Row title="Code font" about="Default: SF Mono.">
        <TextField value={theme.font?.mono ?? ""} placeholder="SF Mono" onCommit={(mono) => set({ font: { mono } })} mono />
      </Row>
      <Row title="Text size" about={`Base size in px, ${FONT_SIZE.min} to ${FONT_SIZE.max}.`} onReset={theme.font?.size ? () => set({ font: { size: null } }) : undefined}>
        <NumberField value={theme.font?.size ?? 14} min={FONT_SIZE.min} max={FONT_SIZE.max} onCommit={(size) => set({ font: { size } })} />
      </Row>
      <div className="grid grid-cols-2 gap-6 px-3 py-2.5">
        {MODES.map((mode) => (
          <div key={mode}>
            <div className="mb-1 text-[12px] font-medium text-muted">{MODE_LABELS[mode]}</div>
            {COLOR_KEYS.map((name) => (
              <ColorField key={name} mode={mode} name={name} value={theme.colors?.[mode]?.[name]} inherited={resolved.colors[mode][name]} onChange={(value) => colors.send(`${mode}.${name}`, { colors: { [mode]: { [name]: value } } })} />
            ))}
          </div>
        ))}
      </div>
      {scope !== "global" && (
        <>
          <Row title="Wallpaper" about="Inherit uses the Wallpaper above; an image is a file in the project.">
            <select
              value={wallpaperChoice}
              onChange={(event) => {
                const next = event.target.value;
                if (next === "inherit") set({ wallpaper: null });
                else if (next !== "image") set({ wallpaper: { builtin: next } });
              }}
              className="shrink-0 rounded-lg border border-line bg-panel px-2 py-1 text-[12px] text-fg outline-none"
            >
              <option value="inherit">Inherit</option>
              {WALLPAPERS.map((id) => (
                <option key={id} value={id}>
                  {WALLPAPER_LABELS[id]}
                </option>
              ))}
              {wallpaperChoice === "image" && <option value="image">Image</option>}
            </select>
          </Row>
          <Row title="Wallpaper image" about="Path from the project's folder, e.g. assets/backdrop.png.">
            <TextField value={wallpaper && "path" in wallpaper ? wallpaper.path : ""} placeholder="None" onCommit={(path) => set({ wallpaper: path === null ? null : { path } })} mono />
          </Row>
          <Row title="Logo" about="Shown on a new chat and beside the project in the sidebar.">
            <TextField value={theme.logo?.path ?? ""} placeholder="None" onCommit={(path) => set({ logo: path === null ? null : { path } })} mono />
          </Row>
        </>
      )}
      <Row title="Reset" about={scope === "global" ? "Forget the palette, fonts and colors for all projects." : "Forget this project's theme."}>
        <ConfirmButton label="Reset" confirm="Reset theme" onConfirm={() => { colors.cancel(); void applyTheme({ type: "reset", scope }); }} />
      </Row>
    </Card>
  );
}
