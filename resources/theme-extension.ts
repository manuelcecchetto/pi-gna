// pi extension loaded into every pi-gna session (`pi -e`). Registers set_theme: the agent changes how pi-gna looks,
// for this project (the default) or for every project, with one patch of the fields to change. Main checks every
// field (src/shared/themes.ts) and replies with the whole resulting theme. Calls go through pi-gna's token-gated
// localhost bridge, which knows the calling chat (and so its project) from its token.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { COLOR_KEYS, FONT_SIZE, IMAGE_EXTENSIONS, IMAGE_MAX_BYTES, type ThemeRequest, type ThemeResponse } from "../src/shared/themes";
import { THEMES, WALLPAPERS } from "../src/shared/settings";

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

const MB = (bytes: number) => `${bytes / 1024 / 1024} MB`;
const resettable = "null resets it to the default";
const palette = (mode: string) =>
  Type.Optional(
    Type.Union([Type.Null(), Type.Object(Object.fromEntries(COLOR_KEYS.map((key) => [key, Type.Optional(Type.Union([Type.String(), Type.Null()]))])), { additionalProperties: false })], {
      description: `Colors in ${mode} mode: ${COLOR_KEYS.join(", ")} (primary is the main accent: buttons, links, selection; background is the canvas, panel the cards and sidebar, fg the text). Each #rrggbb or rgb()/hsl()/oklch(); ${resettable}`,
    }),
  );

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;

  pi.registerTool({
    name: "set_theme",
    label: "Set theme",
    description:
      "Change how pi-gna looks: appearance mode, fonts, colors for light and dark mode, the wallpaper behind a new chat and the project's logo. Pass only the fields to change: missing fields stay as they are, null resets a field. Scope project (the default) themes only this project (its card worktrees too) over the global theme; scope global themes every project. Call it with no fields to read the current theme. Returns the full resulting theme.",
    promptGuidelines: [
      "Use set_theme only when the user asks to change how pi-gna or this project looks. Keep colors readable: fg must contrast with background and panel in each mode, and set both light and dark palettes unless the user wants one mode. Wallpaper and logo images are files inside the project (path relative to it); create or find the file first. Fonts are installed family names on each device (missing fonts fall back to the system font); nothing is downloaded.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], { description: "project (default): only this project; global: every project without its own value" })),
      base: Type.Optional(Type.Union([Type.Union(THEMES.map((theme) => Type.Literal(theme))), Type.Null()], { description: `Appearance mode: ${THEMES.join(", ")} (system follows each device); ${resettable}` })),
      font: Type.Optional(
        Type.Union([
          Type.Null(),
          Type.Object(
            {
              ui: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Family name of an installed font for the interface, e.g. Inter" })),
              mono: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Family name of an installed monospace font for code, e.g. JetBrains Mono" })),
              size: Type.Optional(Type.Union([Type.Integer({ minimum: FONT_SIZE.min, maximum: FONT_SIZE.max }), Type.Null()], { description: `Base text size in px (${FONT_SIZE.min}-${FONT_SIZE.max}, default 14)` })),
            },
            { additionalProperties: false },
          ),
        ]),
      ),
      colors: Type.Optional(Type.Union([Type.Null(), Type.Object({ light: palette("light"), dark: palette("dark") }, { additionalProperties: false })])),
      wallpaper: Type.Optional(
        Type.Union(
          [
            Type.Literal("none"),
            Type.Null(),
            Type.Object({ builtin: Type.Optional(Type.Union([...WALLPAPERS.map((id) => Type.Literal(id)), Type.Null()])) }, { additionalProperties: false }),
            Type.Object({ path: Type.Optional(Type.Union([Type.String(), Type.Null()])) }, { additionalProperties: false }),
          ],
          {
            description: `Behind a new chat: "none", { "builtin": one of ${WALLPAPERS.join(", ")} }, or (project scope) { "path": an image in the project, relative to it (${IMAGE_EXTENSIONS.join(", ")}, at most ${MB(IMAGE_MAX_BYTES.wallpaper)}) }; ${resettable}`,
          },
        ),
      ),
      logo: Type.Optional(
        Type.Union([Type.Null(), Type.Object({ path: Type.Optional(Type.Union([Type.String(), Type.Null()])) }, { additionalProperties: false })], {
          description: `Project scope only: the project's logo, an image in the project, relative to it (${IMAGE_EXTENSIONS.join(", ")}, at most ${MB(IMAGE_MAX_BYTES.logo)}), shown on a new chat and in the sidebar; null removes it`,
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const body: ThemeRequest = params;
      const response = await fetch(`${BRIDGE}/theme`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
        signal,
      });
      const data = (await response.json()) as ThemeResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `pi-gna returned ${response.status}`);
      return { content: [{ type: "text" as const, text: data.text }], details: {} };
    },
  });
}
