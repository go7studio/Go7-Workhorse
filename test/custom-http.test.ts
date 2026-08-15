import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applyAnthropicEvent,
  buildAnthropicBody,
  customMaxTokens,
  customMessagesUrl,
  customStreamError,
  decodeSse,
  parseCustomUsage,
  sanitizeCustomReply,
  streamCustomHttp,
} from "../electron/custom-http";
import { detectCustomLogin, parseOpenClawMinimax } from "../electron/custom-login";
import { customPlanRemainsUrl, leftoverFromRemainingPercent, parseCustomPlanUsage } from "../electron/custom-plan";
import { knownContextWindow, probeCustomHttp } from "../electron/custom-http";
import { applyUpdateCustomBot, botFromDraft, draftReady, EMPTY_CUSTOM_DRAFT } from "../src/lib/custom-bots";
import {
  applyDeleteCustomBot,
  applyInstallCustomBot,
  assembleCustomBotDraft,
  publicBotCard,
  publicDetectCard,
  resolveBotColor,
  runCustomBotSetup,
} from "../src/lib/bot-setup";
import { defaultModel } from "../src/lib/models";
import { isBareVendorOrModel, resolveModelHint, resolveSpawnSpec } from "../src/lib/subagents";
import { CustomSessionHost, customPrefaceForLimits } from "../electron/custom-host";
import { buildSessionPreface } from "../src/lib/context-preface";
import { handleWorkhorseRpc } from "../electron/workhorse-mcp";
import {
  CUSTOM_HTTP_PEER_HINT,
  CUSTOM_HTTP_SESSION_RULES,
  looksLikePeerRequest,
  withCustomPeerHint,
} from "../src/lib/workhorse-rules";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MiniMax leftover toolcall JSON is stripped from the visible reply", async () => {
  const dirty =
    '<toolcall>{"name":"workhorselistbots","arguments":{}}</toolcall>\nSure — a tiny snake game: arrow keys move, eat the dots.';
  const clean = sanitizeCustomReply(dirty);
  assert.doesNotMatch(clean, /<toolcall/i);
  assert.doesNotMatch(clean, /workhorselistbots/);
  assert.match(clean, /snake game/);
  assert.ok(clean.trim().length > 0);

  const chunks: string[] = [];
  const result = await streamCustomHttp(
    { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3", api: "anthropic-messages" },
    { messages: [{ role: "user", text: "Make a game for me" }] },
    { onChunk: (text) => chunks.push(text) },
    async () =>
      new Response(
        [
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"<toolcall>{\\"name\\":\\"workhorselistbots\\"}</toolcall>"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Here is a pong sketch."}}',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.doesNotMatch(result.text, /<toolcall/i);
  assert.doesNotMatch(result.text, /workhorselistbots/);
  assert.match(result.text, /pong sketch/);
  assert.doesNotMatch(chunks.join(""), /workhorselistbots/);

  const http = buildSessionPreface({
    cwd: "C:\\proj\\app",
    folders: ["C:\\proj\\app"],
    references: [],
    surface: "http",
    mode: "ask",
    sandbox: "off",
  });
  assert.match(http, /You have tools/);
  assert.doesNotMatch(http, /You have no tools/);
  assert.match(http, /list_dir/);
  assert.match(http, /Working directory: C:\\proj\\app/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /surface: session\.provider === "custom" \? "http"/);
  const leaked = customPrefaceForLimits(
    "Use workhorse_list_bots now.\n\nThis chat’s live desk limits for THIS turn:\n- Permission: Ask\n- Sandbox: Off",
    "ask",
    "off",
  );
  assert.match(leaked, /workhorse_list_bots/);
  assert.match(leaked, /live desk limits/);
});

test("MiniMax stream splits thinking from text and keeps a leftover SSE event", async () => {
  const leftover = applyAnthropicEvent(
    {
      type: "message",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "hello workspace" },
      ],
    },
    {},
  );
  assert.equal(leftover.thought, "plan");
  assert.equal(leftover.text, "hello workspace");
  const { events, rest } = decodeSse('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n');
  assert.deepEqual(events, []);
  assert.match(rest, /text_delta/);

  const chunks: string[] = [];
  const thoughts: string[] = [];
  const result = await streamCustomHttp(
    { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3", api: "anthropic-messages" },
    { messages: [{ role: "user", text: "hi" }], preface: "Stay in the folder." },
    {
      onChunk: (text) => chunks.push(text),
      onThought: (text) => thoughts.push(text),
    },
    async () =>
      new Response(
        [
          'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"wait"}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.deepEqual(thoughts, ["wait"]);
  assert.deepEqual(chunks, ["pong"]);
  assert.equal(result.text, "pong");

  const pending = { json: "", block: "thinking" };
  const leaked = applyAnthropicEvent(
    { type: "content_block_delta", delta: { type: "text_delta", text: "secret plan" } },
    {},
    pending,
  );
  assert.equal(leaked.thought, "secret plan");
  assert.equal(leaked.text, "");
  assert.doesNotMatch(sanitizeCustomReply("<think>hide this</think>Visible answer."), /hide this/);
  assert.match(sanitizeCustomReply("<think>hide this</think>Visible answer."), /Visible answer/);
  const asked = sanitizeCustomReply(
    "Grok is held.\n<Ask><question>How do you want to proceed with Grok?</question><options><item><label>Use native Grok</label><description>Flip it on in Settings.</description></item></options></Ask>",
  );
  assert.doesNotMatch(asked, /<Ask>|<question>|<label>|label>/i);
  assert.match(asked, /How do you want to proceed with Grok\?/);
  assert.match(asked, /Use native Grok/);
  assert.doesNotMatch(
    sanitizeCustomReply("<item>label>Use native Grok</label><description>Flip it on.</description></item>"),
    /label>/i,
  );
});

test("custom host preface names workspace and live limits", async () => {
  const preface = buildSessionPreface({
    cwd: "C:\\proj\\app",
    folders: ["C:\\proj\\app"],
    references: [],
    mode: "ask",
    sandbox: "read-only",
    surface: "http",
    desk: { title: "MiniMax desk", projectName: "Walk Test", sidebar: "MiniMax M3 · Medium · Ask", preview: "hi" },
  });
  assert.match(preface, /You have tools/);
  assert.match(preface, /list_dir/);
  assert.match(preface, /Working directory: C:\\proj\\app/);
  assert.match(preface, /Title: MiniMax desk/);
  assert.match(preface, /Read-only/);
  assert.match(preface, /workhorse_create_project/);
  assert.match(
    buildSessionPreface({
      cwd: "C:\\proj\\app",
      folders: ["C:\\proj\\app", "C:\\proj\\docs"],
      references: [],
      mode: "ask",
      sandbox: "off",
      surface: "http",
    }),
    /full machine access, subject to Permission/,
  );
  const seen: { preface?: string; text?: string } = {};
  const host = new CustomSessionHost(async (_config, input, handlers) => {
    seen.preface = input.preface;
    seen.text = input.messages.at(-1)?.text;
    handlers.onChunk?.("This chat is read-only.");
    return { text: "This chat is read-only." };
  });
  const reply = await host.prompt(
    {
      sessionId: "s1",
      text: "Write SHOULD-NOT.txt please",
      model: "MiniMax-M3",
      effort: "low",
      cwd: "C:\\proj\\app",
      mode: "ask",
      sandbox: "read-only",
      preface,
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    () => undefined,
  );
  assert.match(seen.preface ?? "", /Working directory: C:\\proj\\app/);
  assert.match(seen.preface ?? "", /You cannot write files this turn/);
  assert.match(seen.text ?? "", /workhorse_request_permission/);
  assert.equal(reply.text, "This chat is read-only.");
});

test("custom HTTP sandbox stamps live desk limits", () => {
  const boxed = customPrefaceForLimits(undefined, "ask", "read-only");
  assert.match(boxed, /Read-only/);
  assert.match(boxed, /You cannot write files this turn/);
  const already = customPrefaceForLimits(boxed, "ask", "off");
  assert.equal(already, boxed);
  const opened = customPrefaceForLimits("system", "ask", "off");
  assert.match(opened, /Writes are allowed this turn/);
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  assert.match(setup, /<strong>File access<\/strong>/);
  assert.match(setup, /Full access means the sandbox is off/);
  assert.doesNotMatch(
    setup,
    /provider === "grok" \|\| session.provider === "codex"/,
  );
});

test("OpenClaw MiniMax import fills Custom without a phantom preview", () => {
  const parsed = parseOpenClawMinimax({
    models: {
      providers: {
        minimax: {
          apiKey: "sk-test",
          baseUrl: "https://api.minimax.io/anthropic",
          models: [
            { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextWindow: 204800, reasoning: true },
            { id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 1000000, reasoning: true },
          ],
        },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed?.config.connected, false);
  assert.equal(parsed?.config.name, "MiniMax M3");
  assert.equal(parsed?.config.model, "MiniMax-M3");
  assert.equal(parsed?.config.api, "anthropic-messages");
  assert.deepEqual(
    parsed?.models.map((model) => model.id),
    ["MiniMax-M2.7", "MiniMax-M3"],
  );

  const missing = detectCustomLogin({
    homedir: path.join(ROOT, "does-not-exist"),
    existsSync: () => false,
    readFile: () => {
      throw new Error("should not read");
    },
  });
  assert.equal(missing.connected, false);

  const fromFile = detectCustomLogin({
    homedir: "C:\\home",
    existsSync: (file) => file === path.join("C:\\home", ".openclaw", "openclaw.json"),
    readFile: () =>
      JSON.stringify({
        models: {
          providers: {
            minimax: { apiKey: "sk-test", baseUrl: "https://api.minimax.io/anthropic" },
          },
        },
      }),
  });
  assert.equal(fromFile.connected, true);
  assert.equal(fromFile.source, "openclaw");
  assert.equal(fromFile.config.apiKey, "sk-test");
});

test("parseCustomPlanUsage reads MiniMax weekly leftover percent", () => {
  assert.equal(leftoverFromRemainingPercent(100), 100);
  assert.equal(leftoverFromRemainingPercent(0.86), 86);
  assert.equal(
    customPlanRemainsUrl("https://api.minimax.io/anthropic"),
    "https://api.minimax.io/v1/token_plan/remains",
  );
  const plan = parseCustomPlanUsage(
    {
      model_remains: [
        {
          model_name: "video",
          current_weekly_remaining_percent: 40,
          weekly_end_time: 1786924800000,
        },
        {
          model_name: "general",
          current_interval_remaining_percent: 86,
          current_weekly_remaining_percent: 100,
          weekly_end_time: 1786924800000,
        },
      ],
    },
    "MiniMax-M3",
  );
  assert.equal(plan?.leftPercent, 100);
  assert.equal(plan?.usedPercent, 0);
  assert.equal(plan?.period, "weekly");
  assert.ok(plan?.resetsAt);
});

test("MiniMax Anthropic request and stream usage parse", async () => {
  assert.equal(
    customMessagesUrl("https://api.minimax.io/anthropic", "anthropic-messages"),
    "https://api.minimax.io/anthropic/v1/messages",
  );
  const body = buildAnthropicBody({
    model: "MiniMax-M3",
    preface: "Stay in the project.",
    effort: "high",
    messages: [{ role: "user", text: "pong" }],
  });
  assert.equal(body.model, "MiniMax-M3");
  assert.equal(body.stream, true);
  assert.equal(body.system, "Stay in the project.");
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.equal(body.max_tokens, 8192 + 4096);
  assert.ok((body.max_tokens as number) > 8192);
  assert.equal(customMaxTokens("MiniMax-M3", "high"), 12288);
  assert.equal(customMaxTokens("MiniMax-M3", "off"), 4096);
  assert.deepEqual(buildAnthropicBody({ model: "MiniMax-M3", effort: "off", messages: [] }).thinking, {
    type: "disabled",
  });
  assert.deepEqual(buildAnthropicBody({ model: "MiniMax-M2.7", effort: "low", messages: [] }).thinking, {
    type: "enabled",
    budget_tokens: 2048,
  });

  const chunks: string[] = [];
  const thoughts: string[] = [];
  applyAnthropicEvent(
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "wait" } },
    { onThought: (text) => thoughts.push(text) },
  );
  applyAnthropicEvent(
    { type: "content_block_delta", delta: { type: "text_delta", text: "pong" } },
    { onChunk: (text) => chunks.push(text) },
  );
  assert.deepEqual(thoughts, ["wait"]);
  assert.deepEqual(chunks, ["pong"]);
  const usage = parseCustomUsage({ usage: { input_tokens: 12, output_tokens: 3 } });
  assert.equal(usage?.inputTokens, 12);
  assert.equal(usage?.outputTokens, 3);
  const start = applyAnthropicEvent(
    {
      type: "message_start",
      message: {
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1366 },
      },
    },
    {},
  );
  assert.equal(start.usage?.cacheReadTokens, 1366);
  const delta = applyAnthropicEvent(
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 1252,
        output_tokens: 213,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 114,
      },
    },
    {},
  );
  assert.equal(delta.usage?.inputTokens, 1252);
  assert.equal(delta.usage?.outputTokens, 213);
  assert.equal(delta.usage?.cacheReadTokens, 114);

  const streamed: { inputTokens: number; outputTokens: number }[] = [];
  const streamedResult = await streamCustomHttp(
    { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3", api: "anthropic-messages" },
    { messages: [{ role: "user", text: "hi" }] },
    { onUsage: (next) => streamed.push({ inputTokens: next.inputTokens, outputTokens: next.outputTokens }) },
    async () =>
      new Response(
        [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":10}}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":80,"output_tokens":12,"cache_read_input_tokens":10}}',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.equal(streamedResult.usage?.inputTokens, 80);
  assert.equal(streamedResult.usage?.outputTokens, 12);
  assert.ok(streamed.some((item) => item.inputTokens === 80 && item.outputTokens === 12));

  const hostEvents: Array<{ type: string; inputTokens?: number; outputTokens?: number; model?: string }> = [];
  const host = new CustomSessionHost(async (_config, _input, handlers) => {
    handlers.onUsage?.({ inputTokens: 80, outputTokens: 12, cacheReadTokens: 10, cacheWriteTokens: 0 });
    return {
      text: "pong",
      usage: { inputTokens: 80, outputTokens: 12, cacheReadTokens: 10, cacheWriteTokens: 0 },
    };
  });
  await host.prompt(
    {
      sessionId: "s-usage",
      projectId: "p1",
      text: "hi",
      model: "MiniMax-M3",
      effort: "low",
      cwd: "C:\\proj\\app",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    (event) => {
      if (event.type === "usage") {
        hostEvents.push({
          type: event.type,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          model: event.model,
        });
      }
    },
  );
  assert.ok(hostEvents.some((event) => event.inputTokens === 80 && event.outputTokens === 12 && event.model === "MiniMax-M3"));
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /usageProviderForSession\(owner\)/);
  assert.match(store, /customBotId: owner\?\.customBotId/);
  assert.equal(defaultModel("custom").id, "MiniMax-M3");
  assert.equal(knownContextWindow("MiniMax-M3"), 1_000_000);
  const draft = {
    ...EMPTY_CUSTOM_DRAFT,
    name: "Mini",
    baseUrl: "https://api.minimax.io/anthropic",
    model: "MiniMax-M3",
    apiKey: "sk-test",
    tested: true,
  };
  assert.equal(draftReady(draft), true);
  assert.equal(draftReady({ ...draft, tested: false }), false);
  assert.equal(botFromDraft(draft).name, "Mini");

  const probe = await probeCustomHttp(
    { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3" },
    async () =>
      new Response(JSON.stringify({ id: "msg", content: [{ type: "text", text: "pong" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  assert.equal(probe.ok, true);
  assert.equal(probe.contextWindow, 1_000_000);
});

test("Custom is wired through Settings store and IPC", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const addBot = readFileSync(path.join(ROOT, "src", "ui", "AddBot.tsx"), "utf8");
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  assert.match(store, /live === "custom"/);
  assert.match(store, /customPrompt/);
  assert.doesNotMatch(store.slice(store.indexOf('live === "custom"'), store.indexOf('live === "codex"')), /Preview only/);
  assert.match(settings, /openAddBot/);
  assert.match(settings, /Add bot/);
  assert.match(settings, /deleteCustomBot/);
  assert.match(settings, /updateCustomBot/);
  assert.match(settings, /BotForm/);
  assert.doesNotMatch(addBot, /Prefill MiniMax/);
  assert.match(addBot, /Your own/);
  assert.match(addBot, /createCustomBot/);
  assert.match(addBot, /probeCustomDraft/);
  assert.match(addBot, /ask Grok or Codex in chat to set one up/);
  assert.match(setup, /"custom"/);
  assert.match(main, /ipcMain\.handle\("custom:prompt"/);
  assert.match(main, /detectCustomLogin/);
  assert.match(preload, /custom:detect/);
  assert.match(preload, /customPrompt/);
  const preview = store.slice(store.lastIndexOf("Preview only"), store.lastIndexOf("Preview only") + 400);
  assert.doesNotMatch(preview, /customPrompt/);
  assert.match(store, /installCustomBot/);
  assert.match(store, /mode === "bots"/);
});

test("a Workhorse agent can assemble, test, and create a custom desk slot", async () => {
  assert.equal(resolveBotColor("green"), "#30d158");
  const detected = detectCustomLogin({
    homedir: "C:\\home",
    existsSync: (file) => file === path.join("C:\\home", ".openclaw", "openclaw.json"),
    readFile: () =>
      JSON.stringify({
        models: {
          providers: {
            minimax: { apiKey: "sk-openclaw-test", baseUrl: "https://api.minimax.io/anthropic" },
          },
        },
      }),
  });
  const card = publicDetectCard(detected);
  assert.equal(card.found, true);
  assert.equal(card.source, "openclaw");
  assert.equal(card.model, "MiniMax-M3");
  assert.equal(card.keyHint, "…test");
  assert.doesNotMatch(JSON.stringify(card), /sk-openclaw-test/);

  const missing = assembleCustomBotDraft({}, { connected: false, source: "none", config: EMPTY_CUSTOM_DRAFT });
  assert.match(missing.error ?? "", /No MiniMax key/);

  const assembled = assembleCustomBotDraft({ importFrom: "openclaw", name: "MiniMax", color: "green" }, detected);
  assert.equal(assembled.error, undefined);
  assert.equal(assembled.imported, true);
  assert.equal(assembled.draft.model, "MiniMax-M3");
  assert.equal(assembled.draft.api, "anthropic-messages");
  assert.equal(assembled.draft.color, "#30d158");

  const created = applyInstallCustomBot([], { ...assembled.draft, tested: true });
  assert.equal(created.created, true);
  assert.equal(created.bot.name, "MiniMax");
  assert.equal(created.bot.model, "MiniMax-M3");
  assert.equal("apiKey" in publicBotCard(created.bot), false);
  const again = applyInstallCustomBot(created.bots, assembled.draft);
  assert.equal(again.created, false);
  assert.equal(again.bot.id, created.bot.id);
  const gone = applyDeleteCustomBot(again.bots, "MiniMax");
  assert.equal(gone.removed?.id, created.bot.id);
  assert.equal(gone.bots.length, 0);

  const renamed = applyUpdateCustomBot(created.bots, created.bot.id, {
    name: "MiniMax desk",
    color: "#ff375f",
    model: "MiniMax-M2.7",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(renamed[0]?.name, "MiniMax desk");
  assert.equal(renamed[0]?.color, "#ff375f");
  assert.equal(renamed[0]?.model, "MiniMax-M2.7");
  assert.equal(renamed[0]?.api, "openai-completions");
  assert.equal(applyUpdateCustomBot(created.bots, "missing", { name: "Nope" })[0]?.name, created.bot.name);

  const setup = await runCustomBotSetup({ importFrom: "auto", name: "Mini" }, {
    detect: () => detected,
    probe: async () => ({ ok: true, message: "API ok", contextWindow: 1_000_000, model: "MiniMax-M3" }),
    create: async (draft) => publicBotCard(applyInstallCustomBot([], draft).bot),
  });
  assert.equal(setup.ok, true);
  if (setup.ok) {
    assert.equal(setup.imported, true);
    assert.equal(setup.created, true);
    assert.equal(setup.bot.name, "Mini");
    assert.equal(setup.bot.model, "MiniMax-M3");
    assert.equal(setup.bot.contextWindow, 1_000_000);
    assert.match(setup.howToUse, /Vendor/);
  }

  const already = await runCustomBotSetup({ importFrom: "auto" }, {
    detect: () => detected,
    probe: async () => {
      throw new Error("should not probe when the bot is already on the desk");
    },
    create: async () => {
      throw new Error("should not create when the bot is already on the desk");
    },
    listed: () => [setup.ok ? setup.bot : created.bot],
  });
  assert.equal(already.ok, true);
  if (already.ok) {
    assert.equal(already.alreadyOnDesk, true);
    assert.equal(already.created, false);
  }

  const spawned = resolveSpawnSpec(
    { fromSessionId: "p", prompt: "hi", chat: "MiniMax" },
    [],
    { provider: "grok", effort: "high" },
    [{ id: created.bot.id, name: "MiniMax", model: "MiniMax-M3" }],
  );
  assert.equal(spawned.provider, "custom");
  assert.equal(spawned.customBotId, created.bot.id);

  const listed = await handleWorkhorseRpc({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  const names = ((listed as { result?: { tools?: { name: string }[] } })?.result?.tools ?? []).map((tool) => tool.name);
  assert.ok(names.includes("workhorse_setup_custom_bot"));
  assert.ok(names.includes("workhorse_detect_custom"));
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-bridge.ts"), "utf8"), /\/bots/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /workhorse_setup_custom_bot/);
});

test("custom HTTP request includes tools and parses tool_use then gates by sandbox", async () => {
  const { customHttpTools, customToolPolicy, parseAnthropicToolUseBlock, parseLeftoverToolCalls } = await import(
    "../electron/custom-tools"
  );
  const { CUSTOM_HTTP_SESSION_RULES } = await import("../src/lib/workhorse-rules");
  const body = buildAnthropicBody({
    model: "MiniMax-M3",
    messages: [{ role: "user", text: "list the folder" }],
  });
  const tools = body.tools as { name: string }[];
  assert.ok(tools.some((tool) => tool.name === "list_dir"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_list_skills"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_list_tools"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_ask_chat"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_spawn_agent"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_create_project"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_request_permission"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_request_vendor"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_list_projects"));
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_list_skills/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_ask_chat/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_spawn_agent/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_create_project/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_request_permission/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /only RAISES access/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /USER DECLINED/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /said no/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /does not need Allow/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /not limited by this chat’s Permission or Sandbox/);
  assert.doesNotMatch(CUSTOM_HTTP_SESSION_RULES, /pops a card|auto-approve|fetch failed/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Never offer to dial limits back/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_list_tools/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Do not refuse/);
  assert.ok(tools.some((tool) => tool.name === "run_command"));
  assert.ok(customHttpTools().some((tool) => tool.name === "read_file"));

  const parsed = parseAnthropicToolUseBlock({
    type: "tool_use",
    id: "call_1",
    name: "list_dir",
    input: { path: "C:\\\\proj" },
  });
  assert.equal(parsed?.name, "list_dir");
  assert.equal(parsed?.id, "call_1");

  const leftover = parseLeftoverToolCalls(
    '<toolcall>{"name":"run_command","arguments":{"command":"git status"}}</toolcall>Done.',
  );
  assert.equal(leftover[0]?.name, "run_command");
  assert.equal(leftover[0]?.input.command, "git status");

  const allow = customToolPolicy(
    { id: "t1", name: "run_command", input: { command: "git status" } },
    { mode: "always-approve", sandbox: "off" },
  );
  assert.equal(allow, "once");
  const blockedStrict = customToolPolicy(
    { id: "t2", name: "run_command", input: { command: "git status" } },
    { mode: "always-approve", sandbox: "strict" },
  );
  assert.equal(blockedStrict, "deny");
  const blockedPlan = customToolPolicy(
    { id: "t3", name: "write_file", input: { path: "a.txt", content: "x" } },
    { mode: "plan", sandbox: "off" },
  );
  assert.equal(blockedPlan, "deny");
  const readOk = customToolPolicy(
    { id: "t4", name: "list_dir", input: { path: "." } },
    { mode: "ask", sandbox: "off" },
  );
  assert.equal(readOk, "once");

  const event = applyAnthropicEvent(
    { type: "content_block_start", content_block: { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.ts" } } },
    {},
  );
  assert.equal(event.tool?.name, "read_file");

  const streamed = await streamCustomHttp(
    { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3", api: "anthropic-messages" },
    { messages: [{ role: "user", text: "list files" }] },
    {},
    async () =>
      new Response(
        [
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tu2","name":"list_dir","input":{"path":"."}}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Looking around."}}\n\n',
          'data: {"type":"message_stop"}',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.equal(streamed.toolUses[0]?.name, "list_dir");
  assert.match(streamed.text, /Looking around/);
  assert.match(
    customStreamError({ type: "error", error: { type: "authentication_error", message: "invalid api key" } }) ?? "",
    /invalid api key/,
  );
  await assert.rejects(
    () =>
      streamCustomHttp(
        { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3", api: "anthropic-messages" },
        { messages: [{ role: "user", text: "hi" }] },
        {},
        async () =>
          new Response('data: {"type":"error","error":{"message":"account locked"}}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    /account locked/,
  );

  assert.doesNotMatch(CUSTOM_HTTP_SESSION_RULES, /You have no tools/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /You have tools/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /not Workhorse\/MiniMax/);
  assert.doesNotMatch(CUSTOM_HTTP_SESSION_RULES, /Workhorse\/MiniMax, Grok/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /list_dir/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Sandbox is Off \(machine-wide/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /exact name/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Do not wait on another chat/);
  const listDir = customHttpTools().find((tool) => tool.name === "list_dir");
  assert.match(listDir?.description ?? "", /Omit path to list this chat/);
  assert.match(listDir?.description ?? "", /Sandbox is Off \(machine-wide\)/);

  const { looksLikePeerRequest, withCustomPeerHint, CUSTOM_HTTP_PEER_HINT } = await import(
    "../src/lib/workhorse-rules"
  );
  assert.equal(looksLikePeerRequest("Please call a Grok bot"), true);
  assert.equal(looksLikePeerRequest("talk to the other chat"), true);
  assert.equal(looksLikePeerRequest("Codex Sol please"), true);
  assert.equal(looksLikePeerRequest("Sol"), true);
  assert.equal(looksLikePeerRequest("list the folder"), false);
  assert.equal(withCustomPeerHint("Codex Sol please").startsWith(CUSTOM_HTTP_PEER_HINT), true);
  assert.match(CUSTOM_HTTP_PEER_HINT, /roleplay|fake sub-agent/i);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Never pretend/);

  const { executeCustomTool } = await import("../electron/custom-tools");
  const catalog = await executeCustomTool(
    { id: "cat1", name: "workhorse_list_tools", input: {} },
    { mode: "always-approve", sandbox: "off", cwd: ROOT },
  );
  assert.equal(catalog.isError, undefined);
  assert.match(catalog.content, /workhorse_ask_chat/);
  assert.match(catalog.content, /workhorse_spawn_agent/);
  assert.match(catalog.content, /list_dir/);

  const { normalizeCustomToolName } = await import("../electron/custom-tools");
  assert.equal(normalizeCustomToolName("workhorseaskchat"), "workhorse_ask_chat");
  assert.equal(normalizeCustomToolName("workhorsespawnagent"), "workhorse_spawn_agent");
  const listed = await executeCustomTool(
    { id: "ex1", name: "list_dir", input: { path: ROOT } },
    { mode: "always-approve", sandbox: "off", cwd: ROOT },
  );
  assert.equal(listed.isError, undefined);
  assert.match(listed.content, /package.json/);
  const cwdDefault = await executeCustomTool(
    { id: "ex2", name: "list_dir", input: {} },
    { mode: "always-approve", sandbox: "off", cwd: ROOT },
  );
  assert.equal(cwdDefault.isError, undefined);
  assert.match(cwdDefault.content, /package.json/);
  const relative = await executeCustomTool(
    { id: "ex3", name: "list_dir", input: { path: "src" } },
    { mode: "always-approve", sandbox: "off", cwd: ROOT },
  );
  assert.equal(relative.isError, undefined);
  assert.match(relative.content, /lib/);

  let rounds = 0;
  const host = new CustomSessionHost(async (_config, input, handlers) => {
    rounds += 1;
    if (rounds === 1) {
      handlers.onChunk?.("Checking the folder.");
      return {
        text: "Checking the folder.",
        toolUses: [{ id: "h1", name: "list_dir", input: { path: ROOT } }],
      };
    }
    handlers.onChunk?.("I see package.json.");
    return { text: "I see package.json." };
  });
  const events: { type: string; title?: string }[] = [];
  const reply = await host.prompt(
    {
      sessionId: "tools1",
      text: "What is in this folder?",
      model: "MiniMax-M3",
      effort: "low",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    (event) => {
      if (event.type === "tool") events.push({ type: event.type, title: event.title });
    },
  );
  assert.equal(rounds, 2);
  assert.ok(events.some((event) => event.title === "list_dir"));
  assert.match(reply.text, /package.json|Checking the folder/);
});

test("API bots treat vendor names as summons and resolve Sol to Codex not MiniMax", () => {
  const phrases = ["Codex Sol please", "Sol", "call Grok", "spawn Codex", "Please call a Grok bot", "talk to the other chat"];
  for (const phrase of phrases) {
    assert.equal(looksLikePeerRequest(phrase), true, phrase);
    assert.equal(withCustomPeerHint(phrase).startsWith(CUSTOM_HTTP_PEER_HINT), true, phrase);
  }
  assert.equal(looksLikePeerRequest("list the folder"), false);
  assert.equal(withCustomPeerHint("list the folder"), "list the folder");
  assert.match(CUSTOM_HTTP_PEER_HINT, /workhorse_spawn_agent/);
  assert.match(CUSTOM_HTTP_PEER_HINT, /roleplay|fake sub-agent/i);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Never pretend/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Hi I’m Sol|Hi I'm Sol|workhorse_spawn_agent returns a real reply/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8"), /Never invent a reply/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8"), /withCustomPeerHint/);

  assert.equal(isBareVendorOrModel("Sol"), true);
  assert.equal(isBareVendorOrModel("Codex Sol"), true);
  assert.equal(isBareVendorOrModel("What do you have access to"), false);

  const sol = resolveModelHint("Sol");
  const terra = resolveModelHint("Terra");
  const grok = resolveModelHint("Grok");
  const codex = resolveModelHint("Codex");
  assert.equal(sol?.provider, "codex");
  assert.equal(terra?.provider, "codex");
  assert.equal(grok?.provider, "grok");
  assert.equal(codex?.provider, "codex");
  assert.equal(sol?.model, defaultModel("codex").id);

  const miniParent = { provider: "custom" as const, effort: "medium" as const };
  const miniBots = [{ id: "bot_minimax", name: "MiniMax", model: "MiniMax-M3" }];
  const decoy = {
    id: "sess_mini",
    title: "Contact the grok bot please just...",
    provider: "custom" as const,
    model: "MiniMax-M3",
    effort: "medium" as const,
    customBotId: "bot_minimax",
  };
  const fromSol = resolveSpawnSpec(
    { fromSessionId: "mini", prompt: "say hi", chat: "Sol" },
    [decoy],
    miniParent,
    miniBots,
  );
  assert.equal(fromSol.provider, sol?.provider);
  assert.equal(fromSol.model, sol?.model);
  assert.notEqual(fromSol.provider, "custom");
  assert.equal(fromSol.customBotId, undefined);

  const fromTerra = resolveSpawnSpec(
    { fromSessionId: "mini", prompt: "hi", chat: "OpenAI Terra" },
    [decoy],
    miniParent,
    miniBots,
  );
  assert.equal(fromTerra.provider, terra?.provider);
  assert.equal(fromTerra.model, terra?.model);

  const fromGrok = resolveSpawnSpec(
    { fromSessionId: "mini", prompt: "hi", provider: "grok" },
    [decoy],
    miniParent,
    miniBots,
  );
  assert.equal(fromGrok.provider, grok?.provider);
  assert.equal(fromGrok.model, grok?.model);

  const fromCodex = resolveSpawnSpec(
    { fromSessionId: "mini", prompt: "hi", chat: "Codex" },
    [decoy],
    miniParent,
    miniBots,
  );
  assert.equal(fromCodex.provider, codex?.provider);

  const fromModelNick = resolveSpawnSpec(
    { fromSessionId: "mini", prompt: "say hi", provider: "codex", model: "Sol" },
    [decoy],
    miniParent,
    miniBots,
  );
  assert.equal(fromModelNick.provider, "codex");
  assert.equal(fromModelNick.model, resolveModelHint("Sol")?.model);
  assert.equal(fromModelNick.model, defaultModel("codex").id);
  assert.notEqual(fromModelNick.model, "Sol");
});
