#!/usr/bin/env node
// Fake llama-server for tests: answers /health and /completion like llama.cpp's server, behind the same Bearer key,
// appends each completion request to $FAKE_LLAMA_LOG, and with $FAKE_LLAMA_FAIL set exits at once (a GPU build that
// cannot run here).
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
if (process.env.FAKE_LLAMA_FAIL && process.argv[1]?.includes(process.env.FAKE_LLAMA_FAIL)) {
  process.stderr.write("ggml_vulkan: no devices found\n");
  process.exit(1);
}
const key = arg("api-key");
createServer((req, res) => {
  if (req.url === "/health") return res.writeHead(200).end('{"status":"ok"}');
  if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (process.env.FAKE_LLAMA_LOG) appendFileSync(process.env.FAKE_LLAMA_LOG, `${body}\n`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: " the composer scroll" }));
  });
}).listen(Number(arg("port")), arg("host"));
