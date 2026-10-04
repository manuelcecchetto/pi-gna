// pi extension loaded into every pi-gna session (`pi -e`). Registers browser_* tools that drive
// the pane the user is watching, through pi-gna's token-gated localhost bridge.
// Policy: loopback/dev-server URLs are always allowed; any other origin asks the user once per session.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isLocalUrl, normalizeAddress, viewportAction, viewportLine } from "../src/shared/browser";
import { DEVICE_PRESETS } from "../src/shared/viewport";
import type { ViewportSpec } from "../src/shared/viewport";

interface BridgeResult {
  url: string;
  title: string;
  text?: string;
  image?: string;
  tab?: string;
  viewport?: ViewportSpec;
}

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

const ABOUT =
  "The browser is a pane inside pi-gna that the user can see; use it to check local dev servers and web pages. ";

export default function (pi: ExtensionAPI) {
  if (!BRIDGE || !TOKEN) return;
  const approved = new Set<string>();

  async function call(body: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeResult> {
    const response = await fetch(`${BRIDGE}/browser`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await response.json()) as BridgeResult & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `browser bridge returned ${response.status}`);
    return data;
  }

  async function allowed(url: string, ctx: ExtensionContext): Promise<boolean> {
    if (isLocalUrl(url)) return true;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (approved.has(parsed.origin)) return true;
    if (!ctx.hasUI) return false;
    const allow = `Allow ${parsed.host} for this session`;
    const choice = await ctx.ui.select(`pi wants to browse ${parsed.origin}`, [allow, "Deny"]);
    if (choice !== allow) return false;
    approved.add(parsed.origin);
    return true;
  }

  /** Actions can navigate (links, form posts); re-check the origin and step back if refused. */
  async function guard(result: BridgeResult, ctx: ExtensionContext, signal?: AbortSignal): Promise<BridgeResult> {
    if (await allowed(result.url, ctx)) return result;
    await call({ action: "back" }, signal);
    throw new Error(`Navigation to ${new URL(result.url).origin} was blocked by the user.`);
  }

  const reply = (result: BridgeResult) => ({
    content: [{ type: "text" as const, text: [result.title, result.url, result.viewport ? viewportLine(result.viewport) : "", result.text ? `\n${result.text}` : ""].filter(Boolean).join("\n") }],
    details: { url: result.url, title: result.title },
  });

  pi.registerTool({
    name: "browser_open",
    label: "Open in browser",
    description: `${ABOUT}Open a URL (for example http://localhost:5173) in the pi-gna browser and return a snapshot of the page with numbered element refs for browser_click and browser_type.`,
    parameters: Type.Object({
      url: Type.String({ description: "URL to open; bare localhost:PORT works" }),
      newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of reusing this session's tab" })),
      tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const target = normalizeAddress(params.url);
      if (!(await allowed(target, ctx))) throw new Error(`Opening ${target} was blocked by the user.`);
      // Redirects can land on another origin; guard the final URL too.
      return reply(await guard(await call({ action: "open", url: target, newTab: params.newTab, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser snapshot",
    description: `${ABOUT}Return a text outline of the current page: headings, text and interactive elements with [ref] numbers. Refs change after navigation; take a new snapshot when an action reports the page changed.`,
    parameters: Type.Object({ tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
}),
    async execute(_id, params, signal) {
      return reply(await call({ action: "snapshot", tab: params.tab }, signal));
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser click",
    description: `${ABOUT}Click the element with the given ref from the latest browser_snapshot.`,
    parameters: Type.Object({ ref: Type.Number({ description: "Element ref from browser_snapshot" }), tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "click", ref: params.ref, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser type",
    description: `${ABOUT}Type text into the input, textarea or editable element with the given ref. Replaces existing content unless clear is false.`,
    parameters: Type.Object({
      ref: Type.Number({ description: "Element ref from browser_snapshot" }),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter afterwards" })),
      clear: Type.Optional(Type.Boolean({ description: "Replace existing content (default true)" })),
      tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "type", ...params }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "Browser key press",
    description: `${ABOUT}Press a key in the page, e.g. Enter, Escape, Tab, ArrowDown, PageDown, or a chord like Meta+A.`,
    parameters: Type.Object({ key: Type.String(), tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "press", key: params.key, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser screenshot",
    description: `${ABOUT}Capture what the browser pane currently shows (the viewport) as an image.`,
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const result = await call({ action: "screenshot" }, signal);
      return {
        content: [
          { type: "image" as const, data: result.image ?? "", mimeType: "image/jpeg" },
          { type: "text" as const, text: [`Screenshot of ${result.url}`, result.viewport ? viewportLine(result.viewport) : ""].filter(Boolean).join("\n") },
        ],
        details: { url: result.url, title: result.title },
      };
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser evaluate",
    description: `${ABOUT}Run JavaScript in the current page and return the result (promises are awaited, values JSON-serialized). Useful for reading state, computed styles or DOM details.`,
    parameters: Type.Object({ expression: Type.String({ description: "JavaScript expression or statements; the last value is returned" }), tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "evaluate", expression: params.expression, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_viewport",
    label: "Browser viewport",
    description: `${ABOUT}Set, read or reset the emulated viewport of your browser tab (responsive testing). Presets: ${DEVICE_PRESETS.map((p) => p.id).join(", ")}. Or give width/height in CSS px; aspect ('9:19.5', '16/9' or a number, width/height) needs exactly one of width or height. dpr is the device pixel ratio (1-4); mobile switches touch, the mobile User-Agent and mobile layout together; orientation swaps the edges. It persists until you call with reset: true or the user changes it. With no arguments it returns the current viewport. Use browser_screenshot afterwards to see the result.`,
    parameters: Type.Object({
      preset: Type.Optional(Type.String({ description: `One of: ${DEVICE_PRESETS.map((p) => p.id).join(", ")}` })),
      width: Type.Optional(Type.Number({ description: "CSS px" })),
      height: Type.Optional(Type.Number({ description: "CSS px" })),
      aspect: Type.Optional(Type.String({ description: "width:height such as '9:19.5' or '16/9'; combine with width or height" })),
      dpr: Type.Optional(Type.Number({ description: "Device pixel ratio, 1-4" })),
      mobile: Type.Optional(Type.Boolean({ description: "Mobile emulation: touch, mobile User-Agent and layout" })),
      orientation: Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")])),
      reset: Type.Optional(Type.Boolean({ description: "Remove emulation and fill the pane again" })),
    }),
    async execute(_id, params, signal) {
      const result = await call({ ...viewportAction(params) }, signal);
      const text = result.viewport ? viewportLine(result.viewport) : "No viewport emulation is active (the page fills the pane).";
      return { content: [{ type: "text" as const, text }], details: { url: result.url, title: result.title } };
    },
  });

  pi.registerTool({
    name: "browser_window",
    label: "Browser window",
    description: `${ABOUT}Open, list or close standalone browser windows at an exact device size (responsive testing). op "open" creates a window with width/height in CSS px, or aspect ('9:16', '16/9' or a number) plus one of width or height, dpr (1-4), mobile (touch, mobile User-Agent and layout) and orientation; or use a preset (${DEVICE_PRESETS.map((p) => p.id).join(", ")}). It returns the window's tab id and a snapshot when a url is given, and becomes your current tab; pass that id as tab to browser_snapshot, browser_click, browser_screenshot, etc. Up to 4 windows can be open. op "close" closes the window (tab, default your current window); op "list" lists open windows.`,
    parameters: Type.Object({
      op: Type.Union([Type.Literal("open"), Type.Literal("close"), Type.Literal("list")]),
      url: Type.Optional(Type.String({ description: "URL to load in the new window (open only)" })),
      tab: Type.Optional(Type.String({ description: "Window tab id (close only)" })),
      preset: Type.Optional(Type.String({ description: `One of: ${DEVICE_PRESETS.map((p) => p.id).join(", ")}` })),
      width: Type.Optional(Type.Number({ description: "CSS px" })),
      height: Type.Optional(Type.Number({ description: "CSS px" })),
      aspect: Type.Optional(Type.String({ description: "width:height such as '9:16'; combine with width or height" })),
      dpr: Type.Optional(Type.Number({ description: "Device pixel ratio, 1-4" })),
      mobile: Type.Optional(Type.Boolean({ description: "Mobile emulation: touch, mobile User-Agent and layout" })),
      orientation: Type.Optional(Type.Union([Type.Literal("portrait"), Type.Literal("landscape")])),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { op, url, tab, ...size } = params;
      const target = url ? normalizeAddress(url) : undefined;
      if (target && !(await allowed(target, ctx))) throw new Error(`Opening ${target} was blocked by the user.`);
      const set = Object.fromEntries(Object.entries(size).filter(([, value]) => value !== undefined));
      const result = await call({ action: "window", op, url: target, tab, set: op === "open" ? set : undefined }, signal);
      return reply(op === "open" && target ? await guard(result, ctx, signal) : result);
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser console",
    description: `${ABOUT}Return recent console messages, page errors and failed loads from the current tab.`,
    parameters: Type.Object({ clear: Type.Optional(Type.Boolean({ description: "Clear the log after reading" })), tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
}),
    async execute(_id, params, signal) {
      return reply(await call({ action: "console", clear: params.clear, tab: params.tab }, signal));
    },
  });
}
