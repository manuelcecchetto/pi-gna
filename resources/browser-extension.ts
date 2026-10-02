// pi extension loaded into every pi studio session (`pi -e`). Registers browser_* tools that drive
// the pane the user is watching, through pi studio's token-gated localhost bridge.
// Policy: loopback/dev-server URLs are always allowed; any other origin asks the user once per session.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isLocalUrl, normalizeAddress } from "../src/shared/browser";

interface BridgeResult {
  url: string;
  title: string;
  text?: string;
  image?: string;
}

const BRIDGE = process.env.PI_STUDIO_BRIDGE;
const TOKEN = process.env.PI_STUDIO_TOKEN;

const ABOUT =
  "The browser is a pane inside pi studio that the user can see; use it to check local dev servers and web pages. ";

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
    content: [{ type: "text" as const, text: [result.title, result.url, result.text ? `\n${result.text}` : ""].filter(Boolean).join("\n") }],
    details: { url: result.url, title: result.title },
  });

  pi.registerTool({
    name: "browser_open",
    label: "Open in browser",
    description: `${ABOUT}Open a URL (for example http://localhost:5173) in the pi studio browser and return a snapshot of the page with numbered element refs for browser_click and browser_type.`,
    parameters: Type.Object({
      url: Type.String({ description: "URL to open; bare localhost:PORT works" }),
      newTab: Type.Optional(Type.Boolean({ description: "Open in a new tab instead of reusing this session's tab" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const target = normalizeAddress(params.url);
      if (!(await allowed(target, ctx))) throw new Error(`Opening ${target} was blocked by the user.`);
      // Redirects can land on another origin; guard the final URL too.
      return reply(await guard(await call({ action: "open", url: target, newTab: params.newTab }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser snapshot",
    description: `${ABOUT}Return a text outline of the current page: headings, text and interactive elements with [ref] numbers. Refs change after navigation; take a new snapshot when an action reports the page changed.`,
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return reply(await call({ action: "snapshot" }, signal));
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser click",
    description: `${ABOUT}Click the element with the given ref from the latest browser_snapshot.`,
    parameters: Type.Object({ ref: Type.Number({ description: "Element ref from browser_snapshot" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "click", ref: params.ref }, signal), ctx, signal));
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
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "type", ...params }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "Browser key press",
    description: `${ABOUT}Press a key in the page, e.g. Enter, Escape, Tab, ArrowDown, PageDown, or a chord like Meta+A.`,
    parameters: Type.Object({ key: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "press", key: params.key }, signal), ctx, signal));
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
          { type: "text" as const, text: `Screenshot of ${result.url}` },
        ],
        details: { url: result.url, title: result.title },
      };
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser evaluate",
    description: `${ABOUT}Run JavaScript in the current page and return the result (promises are awaited, values JSON-serialized). Useful for reading state, computed styles or DOM details.`,
    parameters: Type.Object({ expression: Type.String({ description: "JavaScript expression or statements; the last value is returned" }) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return reply(await guard(await call({ action: "evaluate", expression: params.expression }, signal), ctx, signal));
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser console",
    description: `${ABOUT}Return recent console messages, page errors and failed loads from the current tab.`,
    parameters: Type.Object({ clear: Type.Optional(Type.Boolean({ description: "Clear the log after reading" })) }),
    async execute(_id, params, signal) {
      return reply(await call({ action: "console", clear: params.clear }, signal));
    },
  });
}
