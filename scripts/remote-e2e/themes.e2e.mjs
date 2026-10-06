#!/usr/bin/env node
// Themes: the desktop applies a project theme (tokens, images, a live VisualFrame), remote clients may read but not set it, and the
// phone follows the project's forced light/dark mode over the emulated OS setting.
import { log, check, until, project, png, showSession, openPhone, scenario } from "./harness.mjs";

await scenario("themes", async (ctx) => {
  const { A, desktop } = ctx;
  await themeChecks({ A, desktop, project });
  const { phone, shot, tap, present } = await openPhone(ctx);
  await until("the projects screen", present("project"), 30_000, 250);
  const setBase = (base) => desktop.eval(`window.studio.themes.apply({ type: "set", scope: { project: ${JSON.stringify(project)} }, patch: { base: ${JSON.stringify(base)} } })`);
  await phone.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await setBase("light");
  await tap("project");
  await until("the project chats screen", present("Earlier question 1"));
  await until("project light mode over dark OS", () => phone.eval(`document.documentElement.dataset.themeMode === "light"`), 10_000, 150);
  check(true, "mobile active project forces light while its emulated OS is dark");
  await shot("themes-project-light");
  await phone.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await setBase("dark");
  await until("project dark mode over light OS", () => phone.eval(`document.documentElement.dataset.themeMode === "dark"`), 10_000, 150);
  check(true, "mobile active project forces dark while its emulated OS is light");
  await shot("themes-project-dark");
});

/** Desktop theme application plus remote read/image allowlisting; no theme mutation is exposed remotely. */
async function themeChecks({ A, desktop, project }) {
  log("themes: desktop apply, remote read allowlist, project images and live visual tokens");
  const denied = await A.call("themes.active", { project });
  check(denied.status === 403, "remote themes.active is forbidden", denied.status);
  const initial = await A.ok("themes.get");
  check(!!initial && typeof initial === "object", "remote themes.get is allowed");

  // Activate the seeded project first so ThemeRoot has a project scope; this is the desktop Settings bridge.
  await showSession(desktop, "Tools demo");
  // This is the same desktop bridge invoked by Settings > Appearance; deliberately call through the desktop API.
  await desktop.eval(`window.studio.themes.apply({ type: "set", scope: { project: ${JSON.stringify(project)} }, patch: { base: "dark", font: { ui: "Arial", size: 18 }, colors: { dark: { primary: "#d34a6f", background: "#17121a" } }, wallpaper: { path: "assets/theme-wallpaper.png" }, logo: { path: "assets/theme-logo.png" } } })`);
  await until("desktop theme saved", async () => (await A.ok("themes.get")).projects?.[project]?.font?.size === 18);
  const wallpaper = await A.ok("themes.image", { project, kind: "wallpaper" });
  const logo = await A.ok("themes.image", { project, kind: "logo" });
  check(typeof wallpaper === "string" && wallpaper.startsWith("data:image/png;base64,"), "remote themes.image delivers project wallpaper data");
  check(typeof logo === "string" && logo.startsWith("data:image/png;base64,"), "remote themes.image delivers project logo data");
  await until("desktop theme tokens", () => desktop.eval(`getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#d34a6f" && getComputedStyle(document.documentElement).getPropertyValue("--app-font-size").trim() === "18px"`), 10_000, 150);
  check(true, "desktop theme settings update live color and font tokens");

  // The frame is sandboxed, so its fixture reports computed tokens through the actual postMessage boundary.
  await desktop.eval(`window.__visualThemeProofs = []; window.addEventListener("message", (event) => { if (event.data?.type === "theme-proof") window.__visualThemeProofs.push(event.data); });`);
  await desktop.eval(`window.studio.themes.apply({ type: "set", scope: { project: ${JSON.stringify(project)} }, patch: { base: "light", colors: { light: { primary: "#38a878" } }, font: { ui: "Georgia", size: 19 } } })`);
  await until("VisualFrame computed theme update", () => desktop.eval(`window.__visualThemeProofs.some((proof) => proof.mode === "light" && proof.accent === "#38a878" && proof.size === "19px" && proof.runs === 1)`), 10_000, 150);
  check(true, "inline VisualFrame computes the new forced mode, palette and font in-place without rerunning its sentinel", await desktop.eval(`window.__visualThemeProofs.at(-1)`));

  // Restore project mode to system for the rest of the remote scenario.
  await desktop.eval(`window.studio.themes.apply({ type: "set", scope: { project: ${JSON.stringify(project)} }, patch: { base: null } })`);
}
