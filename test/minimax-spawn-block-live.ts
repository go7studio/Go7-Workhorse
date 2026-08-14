import { readFileSync } from "node:fs";
import { streamCustomHttp } from "../electron/custom-http";
import { handleWorkhorseRpc } from "../electron/workhorse-mcp";
import { CUSTOM_HTTP_SESSION_RULES } from "../src/lib/workhorse-rules";

const statePath = process.env.WORKHORSE_STATE_PATH;
if (!statePath) {
  console.log("FAIL: WORKHORSE_STATE_PATH is not set");
  process.exit(1);
}

const started = Date.now();
const spawn = (await handleWorkhorseRpc({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "workhorse_spawn_agent", arguments: { provider: "grok", prompt: "Say hi" } },
})) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
const ms = Date.now() - started;
const spawnText = spawn.error?.message || spawn.result?.content?.[0]?.text || JSON.stringify(spawn);
console.log(`SPAWN_MS=${ms}`);
console.log(`SPAWN=${spawnText.slice(0, 500)}`);
if (ms > 5000) {
  console.log("FAIL: spawn did not fail fast");
  process.exit(1);
}
if (!/bank|callable|Watch|leftover|turned off/i.test(spawnText)) {
  console.log("FAIL: spawn was not blocked");
  process.exit(1);
}

const state = JSON.parse(readFileSync(statePath, "utf8")) as {
  settings?: { customBots?: Array<{ name: string; model: string; baseUrl: string; apiKey: string; api?: string; contextWindow?: number }> };
};
const bot = (state.settings?.customBots ?? []).find((item) => /minimax/i.test(`${item.name}${item.model}`));
if (!bot?.apiKey) {
  console.log("FAIL: no MiniMax slot");
  process.exit(1);
}

const config = {
  baseUrl: bot.baseUrl,
  model: bot.model,
  apiKey: bot.apiKey,
  api: bot.api === "openai-completions" ? ("openai-completions" as const) : ("anthropic-messages" as const),
  contextWindow: bot.contextWindow,
};
const prompt =
  "Call a Grok model for me. Use workhorse_list_bots first. If Grok is not callable, do not spawn it — tell me why in plain English.";
const first = await streamCustomHttp(config, {
  messages: [{ role: "user", text: prompt }],
  preface: CUSTOM_HTTP_SESSION_RULES,
  effort: "low",
});
console.log(`TOOLS1=${(first.toolUses ?? []).map((item) => item.name).join(",") || "(none)"}`);

const list = (first.toolUses ?? []).find((item) => item.name.includes("list_bots"));
const rosterRpc = (await handleWorkhorseRpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "workhorse_list_bots", arguments: {} },
})) as { result?: { content?: Array<{ text?: string }> } };
const roster = rosterRpc.result?.content?.[0]?.text ?? "";
let reply = first.text ?? "";
if (list) {
  const second = await streamCustomHttp(config, {
    messages: [
      { role: "user", text: prompt },
      { role: "assistant", text: first.text ?? "", toolUses: first.toolUses },
      { role: "user", text: "", toolResults: [{ id: list.id, name: list.name, content: roster }] },
    ],
    preface: CUSTOM_HTTP_SESSION_RULES,
    effort: "low",
  });
  reply = second.text ?? "";
  const names = (second.toolUses ?? []).map((item) => item.name);
  console.log(`TOOLS2=${names.join(",") || "(none)"}`);
  if (names.some((name) => name.includes("spawn"))) console.log("WARN: MiniMax still tried to spawn");
}
console.log(`REPLY=${reply.slice(0, 1600)}`);
const good = /not callable|daily bank|Watch|paused|cannot|over/i.test(reply) && !/I spawned|I called Grok/i.test(reply);
console.log(good ? "PASS: MiniMax refused dead Grok" : "WARN: MiniMax reply still looks like it will call Grok");
