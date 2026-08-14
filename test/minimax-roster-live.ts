import { readFileSync } from "node:fs";
import { streamCustomHttp } from "../electron/custom-http";
import { handleWorkhorseRpc } from "../electron/workhorse-mcp";
import { CUSTOM_HTTP_SESSION_RULES } from "../src/lib/workhorse-rules";

const statePath = process.env.WORKHORSE_STATE_PATH;
if (!statePath) {
  console.log("FAIL: WORKHORSE_STATE_PATH is not set");
  process.exit(1);
}

const state = JSON.parse(readFileSync(statePath, "utf8")) as {
  settings?: { customBots?: Array<{ name: string; model: string; baseUrl: string; apiKey: string; api?: string; contextWindow?: number }> };
};
const bot = (state.settings?.customBots ?? []).find((item) => /minimax/i.test(`${item.name}${item.model}`));
if (!bot?.apiKey || !bot.baseUrl) {
  console.log("FAIL: no MiniMax slot in saved state");
  process.exit(1);
}

const listed = (await handleWorkhorseRpc({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "workhorse_list_bots", arguments: {} },
})) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };

if (listed.error?.message) {
  console.log(`FAIL: list_bots ${listed.error.message}`);
  process.exit(1);
}

const roster = listed.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
console.log("--- ROSTER ---");
console.log(roster.slice(0, 2500));
if (!/Grok/i.test(roster) || !/Codex/i.test(roster) || !/Claude/i.test(roster) || !/MiniMax/i.test(roster)) {
  console.log("FAIL: roster missing a vendor");
  process.exit(1);
}

const config = {
  baseUrl: bot.baseUrl,
  model: bot.model,
  apiKey: bot.apiKey,
  api: bot.api === "openai-completions" ? ("openai-completions" as const) : ("anthropic-messages" as const),
  contextWindow: bot.contextWindow,
};

const first = await streamCustomHttp(config, {
  messages: [{ role: "user", text: "What bots do you have access to? Use workhorse_list_bots, then answer in plain English." }],
  preface: CUSTOM_HTTP_SESSION_RULES,
  effort: "low",
});
console.log("--- FIRST TOOLS ---");
console.log((first.toolUses ?? []).map((item) => item.name).join(", ") || "(none)");

let reply = first.text ?? "";
const botTool = (first.toolUses ?? []).find((item) => item.name.includes("list_bots"));
if (botTool) {
  const second = await streamCustomHttp(config, {
    messages: [
      { role: "user", text: "What bots do you have access to? Use workhorse_list_bots, then answer in plain English." },
      { role: "assistant", text: first.text ?? "", toolUses: first.toolUses },
      { role: "user", text: "", toolResults: [{ id: botTool.id, name: botTool.name, content: roster }] },
    ],
    preface: CUSTOM_HTTP_SESSION_RULES,
    effort: "low",
  });
  reply = second.text ?? "";
  console.log("--- SECOND TOOLS ---");
  console.log((second.toolUses ?? []).map((item) => item.name).join(", ") || "(none)");
}

console.log("--- REPLY ---");
console.log(reply.slice(0, 2000));
const ok = /Grok/i.test(reply) && /MiniMax/i.test(reply) && !/only one bot/i.test(reply);
console.log(ok ? "PASS: MiniMax named desk vendors" : "WARN: reply did not clearly name vendors");
