#!/usr/bin/env node
// The phone's context meter outside a live run on screen: a chat joined while it runs, one that finished while the phone
// was away, and one stopped from the phone.
import { sleep, check, until, agentEnds, openPhone, openChatOnPhone, scenario } from "./harness.mjs";

await scenario("mobile meter", async (ctx) => {
  const { A } = ctx;
  const handle = await ctx.openChat();
  const stream = A.events([handle]);
  await until("the fixture stream", () => stream.frames.some((frame) => frame.event === "hello"));
  const ends = () => agentEnds(stream.events, `chat:${handle}`);

  const ui = await openPhone(ctx);
  const { phone, tap, exists, shot } = ui;
  const meter = () => exists('button[aria-label^="Context usage"]');
  const reopen = async () => {
    await until("the chats screen", () => tap("Earlier question 1"), 20_000, 250);
    await until("the chat", () => exists('[data-testid="send"]'));
  };
  await openChatOnPhone(ui);
  await until("the meter on a chat opened idle", meter);
  check(true, "the meter shows on a chat opened idle");

  // Leave while a run streams, come back after it ended.
  await A.ok("chat.send", { handle, text: "away run [lines=40][delay=50]", mode: "send" });
  await until("the run to start", () => exists('[data-testid="stop"]'));
  await tap("Back");
  await until("the run to end", () => ends() === 1, 30_000);
  await sleep(500);
  await reopen();
  await until("the meter after returning to a finished chat", meter, 10_000).catch(() => undefined);
  await shot("returned");
  check(await meter(), "the meter shows after returning to a chat that finished while away");

  // Join while a run streams: the meter shows then and once it ends.
  await tap("Back");
  await A.ok("chat.send", { handle, text: "joined run [lines=200][delay=50]", mode: "send" });
  await reopen();
  await until("the run on screen", () => exists('[data-testid="stop"]'));
  await until("the meter while a joined run streams", meter, 10_000).catch(() => undefined);
  check((await meter()) && ends() === 1, "the meter shows while a run joined mid-way streams");
  await until("the run to end", () => ends() === 2, 30_000);
  await until("the meter after a run that was joined mid-way", meter, 10_000).catch(() => undefined);
  await shot("joined-finished");
  check(await meter(), "the meter shows once a run joined mid-way finishes");

  // Stop from the phone.
  await A.ok("chat.send", { handle, text: "stopped run [lines=300][delay=50]", mode: "send" });
  await until("the stop button", () => exists('[data-testid="stop"]'));
  await phone.eval(`document.querySelector('[data-testid="stop"]').click()`);
  await until("the stop confirmation", () => exists('[data-testid="confirm-stop"]'));
  await phone.eval(`document.querySelector('[data-testid="confirm-stop"]').click()`);
  await until("the run to stop", async () => !(await exists('[data-testid="stop"]')));
  await until("the meter after Stop", meter, 10_000).catch(() => undefined);
  await shot("stopped");
  check(await meter(), "the meter shows after Stop");
  stream.drop();
});
