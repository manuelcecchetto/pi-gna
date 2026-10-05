// Scripts injected into browser tabs. Plain strings (not serialized functions) so bundler helpers
// never leak into page context. They run in an isolated world: they share the DOM with the page but
// not its JavaScript globals, so a page cannot tamper with them or forge results.

export const ISOLATED_WORLD = 4317;

/**
 * Compact outline of the page for the model: interactive elements get numbered refs (stored as
 * data-pi-ref so later actions can find them), headings and short text blocks give context.
 */
export const SNAPSHOT = String.raw`(() => {
  const LIMIT = 12000;
  for (const el of document.querySelectorAll("[data-pi-ref]")) el.removeAttribute("data-pi-ref");
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const TEXT = /^(P|LI|TD|TH|PRE|BLOCKQUOTE|DT|DD|FIGCAPTION|CAPTION|LABEL|SPAN|DIV)$/;
  const clean = (s, n = 90) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  const role = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "input") return (el.type || "text") === "text" ? "textbox" : el.type;
    if (tag === "textarea") return "textbox";
    return tag;
  };
  const name = (el) =>
    clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") ||
      el.getAttribute("title") || el.innerText || el.getAttribute("alt") || (el.querySelector("img") && el.querySelector("img").alt) || el.getAttribute("name") || "");
  const lines = [];
  let size = 0;
  let ref = 0;
  let truncated = false;
  const push = (line) => {
    if (size > LIMIT) { truncated = true; return; }
    lines.push(line);
    size += line.length + 1;
  };
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode; el; el = walker.nextNode()) {
    if (el.closest("[data-pi-skip]") || !(el instanceof HTMLElement)) continue;
    if (el.matches(INTERACTIVE)) {
      if (!visible(el) || el.closest("[data-pi-ref]")) continue;
      ref += 1;
      el.setAttribute("data-pi-ref", String(ref));
      let line = "[" + ref + "] " + role(el) + ' "' + name(el) + '"';
      if (el.tagName === "A") line += " -> " + clean(el.getAttribute("href"), 80);
      if ("value" in el && el.value && el.tagName !== "BUTTON") line += " value=" + JSON.stringify(clean(String(el.value), 60));
      if (el.checked) line += " checked";
      if (el.disabled) line += " disabled";
      push(line);
    } else if (/^H[1-6]$/.test(el.tagName)) {
      if (visible(el)) push("#".repeat(Number(el.tagName[1])) + " " + clean(el.innerText, 120));
    } else if (TEXT.test(el.tagName)) {
      // Leaf-ish text only: skip containers whose text is mostly their children's.
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
      if (clean(own).length >= 3 && visible(el) && !el.closest(INTERACTIVE)) push("  " + clean(el.innerText, 160));
    }
  }
  if (truncated) lines.push("… (snapshot truncated; scroll or use browser_evaluate for more)");
  return { url: location.href, title: document.title, text: lines.join("\n"), refs: ref };
})()`;

/** Scroll the ref into view and return its center in viewport coordinates, or null. */
export function locate(ref: number): string {
  return String.raw`(() => {
    const el = document.querySelector('[data-pi-ref="${ref}"]');
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** Focus a ref for typing, optionally selecting its content so inserted text replaces it. */
export function focusForTyping(ref: number, clear: boolean): string {
  return String.raw`(() => {
    const el = document.querySelector('[data-pi-ref="${ref}"]');
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (${clear}) {
      if (typeof el.select === "function") el.select();
      else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    return true;
  })()`;
}

/** Element description shared by the desktop picker and the remote one: selector, label, trimmed HTML, rect. */
const ELEMENT_HELPERS = String.raw`  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const selectorOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const infoOf = (target) => {
    const rect = target.getBoundingClientRect();
    const label = (target.getAttribute("aria-label") || target.innerText || target.getAttribute("placeholder") || target.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const clone = target.cloneNode(true);
    clone.removeAttribute("data-pi-ref");
    for (const el of clone.querySelectorAll("[data-pi-ref]")) el.removeAttribute("data-pi-ref");
    return {
      selector: selectorOf(target),
      label: describe(target) + (label ? ' "' + label + '"' : ""),
      html: clone.outerHTML.slice(0, 800),
      rect: { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height },
      url: location.href,
      title: document.title,
    };
  };`;

/** The element under a point of the page (comment mode from a remote viewer), as `infoOf` describes it; null when none. */
export const pickAt = (x: number, y: number) => String.raw`(() => {
  ${ELEMENT_HELPERS}
  const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
  return el && el !== document.documentElement && el !== document.body ? infoOf(el) : null;
})()`;

/**
 * Element picker. Resolves with the picked element and the user's comment, or undefined when
 * stopped (window.__piAnnotateStop). The overlay lives in a shadow root so page CSS cannot touch it.
 */
export const ANNOTATE = String.raw`new Promise((resolve) => {
  if (window.__piAnnotateStop) window.__piAnnotateStop();
  const host = document.createElement("div");
  host.setAttribute("data-pi-skip", "");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = '<style>' +
    '.box{position:fixed;border:2px solid #5b8def;background:rgba(91,141,239,.12);border-radius:4px;pointer-events:none;transition:all .05s}' +
    '.tag{position:fixed;font:11px ui-monospace,Menlo,monospace;background:#5b8def;color:#fff;padding:2px 6px;border-radius:4px;pointer-events:none;white-space:nowrap}' +
    '.card{position:fixed;pointer-events:auto;width:280px;background:#222225;color:#ececef;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px;box-shadow:0 12px 40px -12px rgba(0,0,0,.6);font:13px -apple-system,system-ui,sans-serif}' +
    'textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;background:#161618;color:#ececef;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:6px 8px;font:13px -apple-system,system-ui,sans-serif;outline:none}' +
    '.row{display:flex;gap:6px;margin-top:8px;justify-content:flex-end}' +
    'button{font:12px -apple-system,system-ui,sans-serif;border-radius:7px;padding:4px 10px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#a1a1aa;cursor:pointer}' +
    'button.primary{background:#5b8def;border-color:#5b8def;color:#fff}' +
    '</style><div class="box" hidden></div><div class="tag" hidden></div>';
  const box = root.querySelector(".box");
  const tag = root.querySelector(".tag");
  document.documentElement.appendChild(host);
  let target = null;
  let card = null;

  ${ELEMENT_HELPERS}
  const place = (el) => {
    const r = el.getBoundingClientRect();
    box.hidden = false;
    box.style.left = r.left - 2 + "px";
    box.style.top = r.top - 2 + "px";
    box.style.width = r.width + 4 + "px";
    box.style.height = r.height + 4 + "px";
    tag.hidden = false;
    tag.textContent = describe(el);
    tag.style.left = Math.max(4, r.left) + "px";
    tag.style.top = Math.max(4, r.top - 22) + "px";
  };
  const onMove = (event) => {
    if (card) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === host) return;
    target = el;
    place(el);
  };
  const cleanup = () => {
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("keydown", onKey, true);
    host.remove();
    window.__piAnnotateStop = undefined;
  };
  const finish = (value) => {
    cleanup();
    resolve(value);
  };
  const openCard = () => {
    const r = target.getBoundingClientRect();
    card = document.createElement("div");
    card.className = "card";
    card.innerHTML = '<textarea placeholder="What should change here?"></textarea><div class="row"><button>Cancel</button><button class="primary">Add comment</button></div>';
    card.style.left = Math.min(innerWidth - 292, Math.max(8, r.left)) + "px";
    card.style.top = (r.bottom + 150 < innerHeight ? r.bottom + 8 : Math.max(8, r.top - 150)) + "px";
    root.appendChild(card);
    const area = card.querySelector("textarea");
    const [cancel, add] = card.querySelectorAll("button");
    const submit = () => {
      const comment = area.value.trim();
      if (!comment) return;
      finish({ ...infoOf(target), comment });
    };
    cancel.addEventListener("click", (e) => { e.stopPropagation(); card.remove(); card = null; });
    add.addEventListener("click", (e) => { e.stopPropagation(); submit(); });
    area.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { card.remove(); card = null; }
    });
    setTimeout(() => area.focus(), 0);
  };
  const onClick = (event) => {
    if (card) {
      // Clicks inside the (closed) shadow root are retargeted to the host element.
      if (event.target === host) return;
      event.preventDefault();
      event.stopPropagation();
      card.remove();
      card = null;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target) openCard();
  };
  const onKey = (event) => {
    if (event.key === "Escape" && !card) finish(undefined);
  };
  addEventListener("mousemove", onMove, true);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey, true);
  window.__piAnnotateStop = () => finish(undefined);
})`;

export const STOP_ANNOTATE = `window.__piAnnotateStop && window.__piAnnotateStop()`;
