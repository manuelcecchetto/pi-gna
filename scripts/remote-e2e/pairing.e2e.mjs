#!/usr/bin/env node
// Pairing: the Mac issues a code, each phone claims it, the Mac's Allow sets the device cookie; an unpaired client gets 401.
import { log, check, Phone, pairPhone, scenario } from "./harness.mjs";

await scenario("pairing", async (ctx) => {
  const { A, B, desktop } = ctx;
  log("pairing");
  const pairedA = await pairPhone(A, desktop);
  check(pairedA.deviceName === "iPhone A", "the Mac's approval prompt names device A", pairedA);
  await pairPhone(B, desktop);
  check((await A.json("GET", "/api/hello")).value.authenticated === true, "A is authenticated after pairing");
  check((await B.json("GET", "/api/hello")).value.authenticated === true, "B is authenticated after pairing");
  const devices = await A.ok("devices.list");
  check(devices.length === 2, "two devices are paired", devices);
  check((await new Phone(ctx.ports.remote, "X", "alice@example.com").call("chat.list")).status === 401, "an unpaired client is refused");
}, { pair: false });
