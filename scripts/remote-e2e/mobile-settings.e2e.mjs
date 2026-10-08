#!/usr/bin/env node
// The phone's Settings: sections, the host-side effect of each change, the Mac-only things hidden, revoking the other device.
import { sleep, log, check, until, openPhone, scenario } from "./harness.mjs";

await scenario("mobile settings", async (ctx) => {
  const { A } = ctx;
  const { phone, shot, text, exists, present } = await openPhone(ctx);
  await settingsChecks({ phone, A, shot, text, exists, present });
});

/** The phone's Settings (T33): sections, host-side effect of each change, the Mac-only things hidden. */
async function settingsChecks({ phone, A, shot, text, exists, present }) {
  log("mobile settings parity");
  const click = (testId) => phone.eval(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
  const clickText = (testId, label) => phone.eval(`(() => { const e = [...document.querySelectorAll('[data-testid="${testId}"]')].find((x) => x.innerText.includes(${JSON.stringify(label)})); if (!e) return false; e.click(); return true; })()`);
  const tapBack = () => phone.eval(`document.querySelector('[aria-label="Back"]').click()`);
  /**
   * Flip a switch from the phone and wait for the host to have the other value. A switch sends the opposite of what it
   * shows, so it is tapped only once it shows the host's value: a tap before the phone has the settings, or a quick
   * second tap before it has the host's answer, sends the value the host already has.
   */
  const flip = async (name, read) => {
    const from = await read();
    const state = `document.querySelector(${JSON.stringify(`[role="switch"][aria-label="${name}"]`)})?.getAttribute("aria-checked")`;
    await until(`${name} showing the host's value`, async () => (await phone.eval(state)) === String(from));
    await phone.eval(`document.querySelector(${JSON.stringify(`[role="switch"][aria-label="${name}"]`)}).click()`);
    await until(`${name} switched on the host`, async () => (await read()) === !from);
    return !from;
  };
  const visuals = async () => (await A.ok("settings.get")).visuals;
  // Unset, pi retries.
  const retry = async () => (await A.ok("settings.pi")).values["retry.enabled"] ?? true;
  const laments = async () => (await A.ok("settings.get")).features.laments;
  for (let i = 0; i < 4 && !(await exists('[data-testid="open-settings"]')); i++) {
    await tapBack();
    await sleep(400);
  }
  await until("the projects screen", () => exists('[data-testid="open-settings"]'));
  await click("open-settings");
  await until("the sections", () => exists('[data-testid="section-general"]'));
  const list = await text();
  check(["General", "Appearance", "Models", "Agent", "Features", "Computer use", "Remote access", "Updates", "Providers"].every((l) => list.includes(l)) && (await exists('[data-testid="section-providers"]')) && !(await exists('[data-testid="section-shortcuts"]')), "the sections list has everything but Shortcuts (Providers arrived with T34)");
  await shot("17-settings");

  await click("section-appearance");
  await until("appearance", () => exists('[data-testid="settings-appearance"]'));
  await clickText("choice-Mac theme", "Mac theme");
  await until("the theme sheet", () => exists('[data-testid="choice-sheet"]'));
  check(await clickText("choice-option", "dark"), "the phone picks the dark theme");
  await until("the theme on the host", async () => (await A.ok("settings.get")).theme === "dark");
  check(true, "the Mac's theme setting changed from the phone");
  await shot("18-appearance");
  await A.ok("settings.apply", { op: { type: "theme", theme: "system" }, baseRev: (await A.ok("settings.get")).rev });
  await tapBack();

  await until("sections", () => exists('[data-testid="section-agent"]'));
  await click("section-agent");
  await until("agent", () => exists('[data-testid="settings-agent"]'));
  await flip("Inline visuals", visuals);
  check(true, "Inline visuals (Beta) switched from the phone");
  check((await flip("Retry automatically", retry)) === false, "a pi setting (retry) was written to pi's settings.json");
  await shot("19-agent");
  await flip("Retry automatically", retry);
  await flip("Inline visuals", visuals);
  await tapBack();

  await click("section-features");
  await until("features", () => exists('[data-testid="settings-features"]'));
  await flip("Laments", laments);
  check(true, "a feature switch changed on the host");
  await flip("Laments", laments);
  await tapBack();

  await click("section-computer");
  await until("computer", () => exists('[data-testid="settings-computer"]'));
  await until("permission status", async () => /Granted|Not granted|Unknown/.test(await text()));
  check(!(await text()).includes("Open System Settings"), "computer use shows no System Settings button");
  await shot("20-computer");
  await tapBack();

  await click("section-remote");
  await until("remote", () => exists('[data-testid="settings-remote"]'));
  await until("devices", () => exists('[data-testid="device-row"]'));
  const rows = await phone.eval(`document.querySelectorAll('[data-testid="device-row"]').length`);
  const revokes = await phone.eval(`document.querySelectorAll('[data-testid="revoke-device"]').length`);
  check((await text()).includes("(this device)") && revokes === rows - 1, "the device list marks this device and offers Revoke only for the others", { rows, revokes });
  await click("revoke-device");
  await click("revoke-device");
  await until("the other device revoked on the host", async () => (await A.ok("devices.list")).length === rows - 1);
  check(true, "Revoke on the phone removes the other device on the host");
  check(await exists('[data-testid="sign-out"]'), "Sign out is in Remote access");
  await shot("21-remote");
  await tapBack();

  await click("section-updates");
  await until("updates", () => exists('[data-testid="settings-updates"]'));
  check((await text()).includes("up to date") || (await text()).includes("available"), "Updates shows the status");
  await tapBack();
}
