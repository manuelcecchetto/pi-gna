// pi extension loaded into every pi-gna session (`pi -e`). Registers browser_* tools that drive
// the pane the user is watching, through pi-gna's token-gated localhost bridge.
// Policy: loopback/dev-server URLs are always allowed; any other origin asks the user once per session.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isLocalUrl, type MediaEmulation, mediaLine, normalizeAddress, viewportAction, viewportLine } from "../src/shared/browser";
import { parseLocalTarget } from "../src/shared/preview";
import { DEVICE_PRESETS } from "../src/shared/viewport";
import type { ViewportSpec } from "../src/shared/viewport";

interface BridgeResult {
  url: string;
  title: string;
  text?: string;
  image?: string;
  tab?: string;
  viewport?: ViewportSpec;
  media?: MediaEmulation;
}

const BRIDGE = process.env.PIGNA_BRIDGE;
const TOKEN = process.env.PIGNA_TOKEN;

// pi runs one message's tool calls in parallel unless one of them is sequential. The bridge would then run them
// in the order their requests arrive (browser_open checks the URL policy first, so a screenshot sent with it
// overtook it and captured the previous page); sequential keeps the order the agent wrote them in.
const SEQUENTIAL = "sequential" as const;

const ABOUT =
  "The browser is a pane inside pi-gna that the user can see; use it to check local dev servers and web pages. ";
const TAB = "Window tab id from browser_window; default is your current tab";
const REF = "Element ref from browser_snapshot";

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
    content: [
      {
        type: "text" as const,
        text: [result.title, result.url, result.viewport ? viewportLine(result.viewport) : "", mediaLine(result.media), result.text ? `\n${result.text}` : ""].filter(Boolean).join("\n"),
      },
    ],
    details: { url: result.url, title: result.title },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_open",
    label: "Open in browser",
    description: `${ABOUT}Open a URL (for example http://localhost:5173) in the pi-gna browser and return a snapshot of the page with numbered element refs for browser_click and browser_type. A local file path (absolute, ~/, relative to the project, file://, optionally path:line) opens a rendered preview tab for pdf, images, docx, pptx, xlsx, markdown, html and code; browser_snapshot, browser_screenshot and browser_evaluate work on it like any page.`,
    parameters: Type.Object({
      url: Type.String({ description: "URL to open (bare localhost:PORT works), or a local file path to preview" }),
      newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of reusing this session's tab" })),
      tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      // A local file is previewed, not browsed: no origin to approve, and the result's URL is the file.
      if (parseLocalTarget(params.url, ctx.cwd, homedir())) {
        return reply(await call({ action: "open", url: params.url, cwd: ctx.cwd, newTab: params.newTab, tab: params.tab }, signal));
      }
      const target = normalizeAddress(params.url);
      if (!(await allowed(target, ctx))) throw new Error(`Opening ${target} was blocked by the user.`);
      // Redirects can land on another origin; guard the final URL too.
      return reply(await guard(await call({ action: "open", url: target, newTab: params.newTab, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
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
    executionMode: SEQUENTIAL,
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
    executionMode: SEQUENTIAL,
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
    executionMode: SEQUENTIAL,
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
    executionMode: SEQUENTIAL,
    name: "browser_screenshot",
    label: "Browser screenshot",
    description: `${ABOUT}Capture what the browser pane currently shows (the viewport) as an image. Pass save to also write it as a JPEG file, for example to show it to the user in your reply with ![caption](path).`,
    parameters: Type.Object({
      tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
      save: Type.Optional(Type.String({ description: "Also save the screenshot to this path (absolute, ~/ or relative to the working directory); .jpg is added unless it ends in .jpg or .jpeg" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await call({ action: "screenshot", tab: params.tab }, signal);
      const saved = params.save && result.image ? await saveScreenshot(params.save, result.image, ctx.cwd) : undefined;
      return {
        content: [
          { type: "image" as const, data: result.image ?? "", mimeType: "image/jpeg" },
          { type: "text" as const, text: [`Screenshot of ${result.url}`, result.viewport ? viewportLine(result.viewport) : "", saved ? `Saved to ${saved}` : ""].filter(Boolean).join("\n") },
        ],
        details: { url: result.url, title: result.title },
      };
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_evaluate",
    label: "Browser evaluate",
    description: `${ABOUT}Run JavaScript in the current page like the DevTools console and return the result (top-level await works, promises are awaited, values JSON-serialized). Useful for reading state, computed styles or DOM details.`,
    parameters: Type.Object({ expression: Type.String({ description: "JavaScript expression or statements; the last value is returned" }), tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "evaluate", expression: params.expression, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
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
    executionMode: SEQUENTIAL,
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
    executionMode: SEQUENTIAL,
    name: "browser_console",
    label: "Browser console",
    description: `${ABOUT}Return recent console messages, page errors and failed loads from the current tab.`,
    parameters: Type.Object({ clear: Type.Optional(Type.Boolean({ description: "Clear the log after reading" })), tab: Type.Optional(Type.String({ description: "Window tab id from browser_window; default is your current tab" })),
}),
    async execute(_id, params, signal) {
      return reply(await call({ action: "console", clear: params.clear, tab: params.tab }, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_page_tool",
    label: "Browser page tool",
    description: `${ABOUT}Call a tool the page itself provides through WebMCP (document.modelContext); browser_snapshot lists them under "Page tools". Without name it lists the page's tools with their input schemas. A page tool does what the page's own UI would (fill a form, apply a filter, add to a cart) and is usually more reliable than clicking through it; its name, description and result come from the page.`,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Tool name from the page's list; omit to list the tools" })),
      input: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Arguments matching the tool's input schema" })),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      // Some models send the arguments as a JSON string.
      const input = typeof params.input === "string" ? (JSON.parse(params.input) as Record<string, unknown>) : params.input;
      return reply(await guard(await call({ action: "page_tool", name: params.name, input, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_wait_for",
    label: "Browser wait",
    description: `${ABOUT}Wait until the page meets every condition given: visible text appears (text), text disappears (textGone), an element matching a CSS selector is visible (selector), or the URL contains a string (url). Returns a fresh snapshot once met; fails with what is still missing after the timeout. Use it after an action that loads data, instead of sleeping.`,
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: "Text that must be visible on the page" })),
      textGone: Type.Optional(Type.String({ description: "Text that must no longer be visible" })),
      selector: Type.Optional(Type.String({ description: "CSS selector of an element that must be visible" })),
      url: Type.Optional(Type.String({ description: "Substring the page URL must contain" })),
      timeout: Type.Optional(Type.Number({ description: "Milliseconds to wait (default 10000, at most 60000)" })),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "wait_for", ...params }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_dialog",
    label: "Browser dialog",
    description: `${ABOUT}Answer the alert or confirm dialog the page is showing (an action reports when one opens; the page is paused until it is answered). accept: true presses OK, false presses Cancel.`,
    parameters: Type.Object({
      accept: Type.Boolean({ description: "true for OK, false for Cancel" }),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "dialog", accept: params.accept, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_upload",
    label: "Browser upload",
    description: `${ABOUT}Give local files to the page: ref is an <input type=file> from browser_snapshot, or the button that opens the page's file picker (no picker opens; its input gets the files). Paths are absolute, ~/ or relative to the working directory.`,
    parameters: Type.Object({
      ref: Type.Number({ description: REF }),
      files: Type.Array(Type.String(), { description: "Paths of the files to upload" }),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const files = await Promise.all(params.files.map((file) => existingFile(file, ctx.cwd)));
      return reply(await guard(await call({ action: "upload", ref: params.ref, files, tab: params.tab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_hover",
    label: "Browser hover",
    description: `${ABOUT}Move the mouse over an element to reveal hover menus and tooltips, then take a browser_snapshot.`,
    parameters: Type.Object({
      ref: Type.Union([Type.Number(), Type.String()], { description: `${REF}, or a CSS selector for an element without a ref` }),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal) {
      return reply(await call({ action: "hover", ref: params.ref, tab: params.tab }, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_select",
    label: "Browser select",
    description: `${ABOUT}Choose options of a native <select> by value or visible label (several for a multiple select). A custom dropdown is not a <select>: click it open and click the option.`,
    parameters: Type.Object({
      ref: Type.Number({ description: REF }),
      values: Type.Array(Type.String(), { description: "Option values or labels" }),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "select", ...params }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_drag",
    label: "Browser drag",
    description: `${ABOUT}Drag one element onto another (HTML drag and drop, sortable lists, sliders). Both must be visible once the first is scrolled into view. A drop zone usually has no ref: give its CSS selector.`,
    parameters: Type.Object({
      from: Type.Union([Type.Number(), Type.String()], { description: "Ref of the element to drag, or its CSS selector" }),
      to: Type.Union([Type.Number(), Type.String()], { description: "Ref or CSS selector of the element to drop onto" }),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "drag", ...params }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_scroll",
    label: "Browser scroll",
    description: `${ABOUT}Scroll with the mouse wheel: the page, or the scrollable area under an element (ref). Positive deltaY scrolls down, positive deltaX right; default 600px down. Lazy lists and infinite scroll load on this.`,
    parameters: Type.Object({
      ref: Type.Optional(Type.Number({ description: "Scroll the area under this element; default the page" })),
      deltaY: Type.Optional(Type.Number({ description: "Pixels down (negative scrolls up)" })),
      deltaX: Type.Optional(Type.Number({ description: "Pixels right (negative scrolls left)" })),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal) {
      return reply(await call({ action: "scroll", ...params }, signal));
    },
  });

  pi.registerTool({
    executionMode: SEQUENTIAL,
    name: "browser_emulate",
    label: "Browser emulate",
    description: `${ABOUT}Emulate media features on your tab: colorScheme light or dark (prefers-color-scheme, to check a dark mode), reducedMotion reduce (prefers-reduced-motion). "system" clears one; reset clears all. It stays until cleared, and the user sees the page the same way. Use browser_screenshot afterwards.`,
    parameters: Type.Object({
      colorScheme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark"), Type.Literal("system")])),
      reducedMotion: Type.Optional(Type.Union([Type.Literal("reduce"), Type.Literal("no-preference"), Type.Literal("system")])),
      reset: Type.Optional(Type.Boolean({ description: "Clear every emulated feature" })),
      tab: Type.Optional(Type.String({ description: TAB })),
    }),
    async execute(_id, params, signal) {
      const { reset, tab, ...set } = params;
      const defined = Object.fromEntries(Object.entries(set).filter(([, value]) => value !== undefined));
      return reply(await call({ action: "emulate", reset, set: reset ? undefined : defined, tab }, signal));
    },
  });
}

/** An existing file's absolute path, `path` resolved like a shell path against `cwd`; throws when there is none. */
async function existingFile(path: string, cwd: string): Promise<string> {
  const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
  const file = resolve(cwd, expanded);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`No file at ${file}`);
  return file;
}

/** Write a screenshot's JPEG bytes to `path` (resolved like a shell path against `cwd`) and return where it went. */
async function saveScreenshot(path: string, base64: string, cwd: string): Promise<string> {
  const expanded = path.startsWith("~/") ? homedir() + path.slice(1) : path;
  const file = resolve(cwd, /\.jpe?g$/i.test(expanded) ? expanded : `${expanded}.jpg`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(base64, "base64"));
  return file;
}
