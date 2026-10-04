/* pi-gna visual frame runtime: no dependencies, no network. Protocol: docs/DESIGN.md "Visuals". */
(function () {
  var host = document.getElementById("visual");
  var send = function (m) {
    parent.postMessage(m, "*");
  };

  function applyTokens(t) {
    if (!t || typeof t !== "object") return;
    for (var k in t) {
      if (typeof t[k] === "string" && /^--[\w-]+$/.test(k)) document.documentElement.style.setProperty(k, t[k]);
    }
  }

  function render(html) {
    host.innerHTML = typeof html === "string" ? html : "";
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
      render(d.html);
    } else if (d.type === "tokens") applyTokens(d.tokens || d.vars);
    else if (d.type === "ping") send({ type: "heartbeat" });
  });

  var last = -1;
  var pending = false;
  new ResizeObserver(function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      var px = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (px !== last) {
        last = px;
        send({ type: "height", px: px });
      }
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
