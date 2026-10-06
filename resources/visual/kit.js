/* pi-gna visual frame runtime: no dependencies, no network. Protocol: docs/DESIGN.md "Visuals". */
(function () {
  var host = document.getElementById("visual");
  var send = function (m) {
    parent.postMessage(m, "*");
  };

  function applyTokens(t) {
    if (!t || typeof t !== "object") return;
    if (t["--theme-mode"] === "light" || t["--theme-mode"] === "dark") document.documentElement.dataset.themeMode = t["--theme-mode"];
    for (var k in t) {
      if (typeof t[k] === "string" && /^--[\w-]+$/.test(k)) document.documentElement.style.setProperty(k, t[k]);
    }
  }

  var shown;
  function render(html) {
    shown = html;
    host.innerHTML = html;
    // innerHTML never runs scripts: recreate them in document order.
    var scripts = host.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var s = document.createElement("script");
      for (var j = 0; j < old.attributes.length; j++) s.setAttribute(old.attributes[j].name, old.attributes[j].value);
      s.text = old.text;
      old.parentNode.replaceChild(s, old);
    }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "render") {
      applyTokens(d.tokens || d.vars);
      // The parent re-sends render until acked (ready, load, heartbeats). Running the same fragment twice would redeclare
      // its top-level const/let in the shared global scope and throw, so a repeat is only acked.
      var html = typeof d.html === "string" ? d.html : "";
      if (html !== shown) {
        render(html);
        initTabs();
        reportHeight(); // at once: the observer waits for a frame, which a hidden window never draws
      }
      send({ type: "rendered" });
    } else if (d.type === "tokens") applyTokens(d.tokens || d.vars);
    else if (d.type === "ping") send({ type: "heartbeat" });
  });

  var last = -1;
  var pending = false;
  function reportHeight() {
    var px = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (px !== last) {
      last = px;
      send({ type: "height", px: px });
    }
  }
  new ResizeObserver(function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      reportHeight();
    });
  }).observe(document.documentElement);

  document.addEventListener(
    "click",
    function (e) {
      var a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      e.preventDefault();
      send({ type: "open-link", href: a.href || a.getAttribute("href") });
    },
    true,
  );

  // Tabs: the clicked button gets .on, its data-show panel (an id) is shown and its siblings' panels hidden, and the group
  // fires a bubbling "tab" event whose detail is the button's value (or text) for fragment scripts.
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest(".tabs > button");
    if (!b) return;
    var group = b.parentNode;
    var buttons = group.querySelectorAll(":scope > button");
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i] === b;
      buttons[i].classList.toggle("on", on);
      var id = buttons[i].getAttribute("data-show");
      var panel = id && document.getElementById(id);
      if (panel) panel.hidden = !on;
    }
    var value = b.value || b.textContent.trim();
    group.setAttribute("data-value", value);
    group.dispatchEvent(new CustomEvent("tab", { bubbles: true, detail: value }));
  });
  function initTabs() {
    var groups = document.querySelectorAll(".tabs");
    for (var i = 0; i < groups.length; i++) {
      var buttons = groups[i].querySelectorAll(":scope > button");
      var on = groups[i].querySelector(":scope > button.on") || buttons[0];
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].classList.toggle("on", buttons[j] === on);
        var id = buttons[j].getAttribute("data-show");
        var panel = id && document.getElementById(id);
        if (panel) panel.hidden = buttons[j] !== on;
      }
    }
  }

  // Tooltips: any element with data-tip (SVG marks included); the text follows the pointer and stays inside the frame.
  var tip = document.createElement("div");
  tip.className = "kit-tip";
  tip.hidden = true;
  document.body.appendChild(tip);
  var scripted = false; // kit.tip owns the tooltip until it is called with null
  function placeTip(x, y) {
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(x + 12, innerWidth - w - 4)) + "px";
    tip.style.top = Math.max(4, y + 14 + h > innerHeight ? y - h - 8 : y + 14) + "px";
  }
  document.addEventListener("pointermove", function (e) {
    if (scripted) return;
    var el = e.target && e.target.closest && e.target.closest("[data-tip]");
    if (!el) {
      tip.hidden = true;
      return;
    }
    tip.className = "kit-tip";
    tip.textContent = el.getAttribute("data-tip");
    tip.hidden = false;
    placeTip(e.clientX, e.clientY);
  });
  document.addEventListener("pointerleave", function () {
    scripted = false;
    tip.hidden = true;
  });

  // Helpers for fragment scripts: palette, heat ramp and compact numbers that follow the theme tokens.
  var HEAT = ["--heat-0", "--heat-1", "--heat-2", "--heat-3", "--heat-4"];
  window.kit = {
    /** The i-th categorical color (wraps after 8), as a CSS value. */
    color: function (i) {
      return "var(--c" + ((((Math.floor(i) || 0) % 8) + 8) % 8 + 1) + ")";
    },
    /** A color on the cool-to-hot ramp for t in [0, 1], as a CSS value. */
    heat: function (t) {
      t = Math.max(0, Math.min(1, Number(t) || 0)) * (HEAT.length - 1);
      var i = Math.min(HEAT.length - 2, Math.floor(t));
      var p = Math.round((t - i) * 100);
      return "color-mix(in oklab, var(" + HEAT[i] + ") " + (100 - p) + "%, var(" + HEAT[i + 1] + "))";
    },
    /** Show a rich tooltip (HTML, e.g. rows with <i class="sw" style="--c:...">) at viewport x, y; null hides it. */
    tip: function (html, x, y) {
      scripted = html != null;
      tip.hidden = !scripted;
      if (!scripted) return;
      tip.className = "kit-tip rich";
      tip.innerHTML = String(html);
      placeTip(Number(x) || 0, Number(y) || 0);
    },
    /** 1234567 -> "1.23M", 4695 -> "4,695", 0.4123 -> "0.41". */
    fmt: function (n) {
      n = Number(n);
      if (!isFinite(n)) return String(n);
      var a = Math.abs(n);
      if (a >= 1e9) return +(n / 1e9).toPrecision(3) + "B";
      if (a >= 1e6) return +(n / 1e6).toPrecision(3) + "M";
      if (a >= 1e4) return +(n / 1e3).toPrecision(3) + "k";
      return a >= 1 || a === 0 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(+n.toPrecision(2));
    },
  };

  window.addEventListener("error", function (e) {
    send({ type: "error", message: String(e.message || e.error || "error") });
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    send({ type: "error", message: String((r && r.message) || r) });
  });

  setInterval(function () {
    send({ type: "heartbeat" });
  }, 1000);
  send({ type: "ready" });
})();
