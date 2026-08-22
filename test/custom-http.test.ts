import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applyAnthropicEvent,
  applyOpenAiChunk,
  buildAnthropicBody,
  buildOpenAiBody,
  customMaxTokens,
  customMessagesUrl,
  customStreamError,
  decodeSse,
  mergeCustomUsageSnapshot,
  parseCustomUsage,
  sanitizeCustomReply,
  streamCustomHttp,
} from "../electron/custom-http";

test("OpenAI-compatible tool calls wait for all streamed argument fragments", async () => {
  const seen: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const pending = new Map();
  const first = applyOpenAiChunk(
    {
      choices: [{ delta: { tool_calls: [{ index: 0, id: "spawn-1", function: { name: "workhorse_spawn_agent", arguments: "{\"pro" } }] } }],
    },
    { onToolUse: (tool) => seen.push(tool) },
    pending,
  );
  assert.equal(first.tool, undefined);
  assert.equal(seen.length, 0);
  applyOpenAiChunk(
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "mpt\":\"inspect safely\",\"wait\":false}" } }] } }] },
    { onToolUse: (tool) => seen.push(tool) },
    pending,
  );
  assert.equal(seen.length, 0);
  const finished = applyOpenAiChunk(
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { onToolUse: (tool) => seen.push(tool) },
    pending,
  );
  assert.equal(finished.tool?.name, "workhorse_spawn_agent");
  assert.deepEqual(seen, [{ id: "spawn-1", name: "workhorse_spawn_agent", input: { prompt: "inspect safely", wait: false } }]);

  const streamed = await streamCustomHttp(
    { baseUrl: "https://api.minimax.io/v1", apiKey: "sk-test", model: "MiniMax-M3", api: "openai-completions" },
    { messages: [{ role: "user", text: "delegate" }] },
    {},
    async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"child-a","function":{"name":"workhorse_spawn_agent","arguments":"{\\"pro"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mpt\\":\\"read only\\",\\"wait\\":false}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.deepEqual(streamed.toolUses, [
    { id: "child-a", name: "workhorse_spawn_agent", input: { prompt: "read only", wait: false } },
  ]);
});

test("DeepSeek thinking tool loops replay reasoning and meter cache provenance", async () => {
  const body = buildOpenAiBody({
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
    effort: "xhigh",
    messages: [
      { role: "user", text: "inspect" },
      {
        role: "assistant",
        text: "",
        reasoning: "I need the file list.",
        toolUses: [{ id: "call_1", name: "list_dir", input: { path: "." } }],
      },
      { role: "user", text: "", toolResults: [{ id: "call_1", name: "list_dir", content: "README.md" }] },
    ],
  }) as Record<string, any>;
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.messages[1].reasoning_content, "I need the file list.");
  const off = buildOpenAiBody({ model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", effort: "off", messages: [] }) as Record<string, any>;
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.reasoning_effort, undefined);
  assert.deepEqual(parseCustomUsage({ usage: {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 100,
  } }), { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 0 });

  let calls = 0;
  const host = new CustomSessionHost(
    async (_config, input) => {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          thought: "The directory must be listed.",
          toolUses: [{ id: "call_1", name: "list_dir", input: { path: "." } }],
        };
      }
      const assistant = input.messages.find((message) => message.role === "assistant" && message.toolUses?.length);
      assert.equal(assistant?.reasoning, "The directory must be listed.");
      return { text: "Done." };
    },
    { executeTool: async (use) => ({ id: use.id, name: use.name, content: "README.md" }) },
  );
  const reply = await host.prompt({
    sessionId: "deepseek-loop",
    text: "inspect",
    model: "deepseek-v4-pro",
    effort: "high",
    cwd: path.resolve("fixture-workspace"),
    mode: "always-approve",
    sandbox: "off",
    history: [],
    config: { baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-v4-pro", api: "openai-completions" },
  }, () => undefined);
  assert.equal(calls, 2);
  assert.equal(reply.text, "Done.");
});
import {
  detectCustomLogin,
  fillEmptyCustomBotKeys,
  hydrateDetectedCustomCredentials,
  openClawKeyForBaseUrl,
  parseOpenClawMinimax,
} from "../electron/custom-login";
import {
  customPlanRemainsUrl,
  fetchCustomPlanUsage,
  grokBotLeftoverPath,
  leftoverFromRemainingPercent,
  parseCustomPlanUsage,
  parseGrokBotPlanUsage,
  weeklyIsUnlimited,
} from "../electron/custom-plan";
import { knownContextWindow, probeCustomHttp } from "../electron/custom-http";
import { applyUpdateCustomBot, botFromDraft, draftReady, EMPTY_CUSTOM_DRAFT, inferCustomApi } from "../src/lib/custom-bots";
import {
  contextFromModelList,
  detectProviderFromKey,
  knownContextWindow as catalogWindow,
} from "../src/lib/provider-catalog";
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
import {
  CUSTOM_TURN_SAFETY_DEFAULTS,
  CustomSessionHost,
  compactCustomTurnTranscript,
  customPrefaceForLimits,
  looksLikeDispatchCheckBack,
  looksLikeUnfinishedDeskTurn,
  looksLikeWaitingOnUser,
  shouldEndDispatchTurn,
  spawnDispatchStarted,
  workerHasDeliverableReport,
} from "../electron/custom-host";
import { buildSessionPreface } from "../src/lib/context-preface";
import { handleWorkhorseRpc } from "../electron/workhorse-mcp";
import {
  executeCustomTool,
  limitCustomToolResult,
  resolveWorkspacePath,
  MAX_CUSTOM_TOOL_RESULT_CHARS,
} from "../electron/custom-tools";
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
  const mmReply = sanitizeCustomReply(
    "Sweeping the D drive now.</mm:think>Searching D:\\\\ for space* folders.</mm:think>Done. Allocated Space Battle.",
  );
  assert.doesNotMatch(mmReply, /<\/?mm:think>/i);
  assert.doesNotMatch(mmReply, /Sweeping the D drive/);
  assert.match(mmReply, /Done\. Allocated Space Battle/);
  const { peelThinkTags } = await import("../src/lib/markdown");
  const streamed = peelThinkTags(
    "Look at the D drive, should be there. <mm:think>searching D:\\\\Godot</mm:think>\nAllocated Space Battle at D:\\\\Godot\\\\Projects\\\\demo-game.",
  );
  assert.match(streamed.thought, /searching D:/);
  assert.match(streamed.body, /Allocated Space Battle/);
  assert.doesNotMatch(streamed.body, /mm:think/i);
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

test("Anthropic thinking, tool use, and text stay on their own channels", () => {
  const pending: { id?: string; name?: string; json: string; block?: string } = { json: "" };
  const trace: Array<{ kind: string; text?: string; tool?: string }> = [];
  const handlers = {
    onThought: (text: string) => trace.push({ kind: "thought", text }),
    onChunk: (text: string) => trace.push({ kind: "message", text }),
    onToolUse: (tool: { name: string }) => trace.push({ kind: "tool", tool: tool.name }),
  };

  applyAnthropicEvent(
    { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
    handlers,
    pending,
  );
  applyAnthropicEvent(
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "I should list the chats first." } },
    handlers,
    pending,
  );
  applyAnthropicEvent({ type: "content_block_stop" }, handlers, pending);
  applyAnthropicEvent(
    {
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tu-list", name: "list_chats", input: {} },
    },
    handlers,
    pending,
  );
  applyAnthropicEvent({ type: "content_block_stop" }, handlers, pending);
  applyAnthropicEvent(
    { type: "content_block_start", content_block: { type: "thinking" } },
    handlers,
    pending,
  );
  applyAnthropicEvent(
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Three are live." } },
    handlers,
    pending,
  );
  applyAnthropicEvent({ type: "content_block_stop" }, handlers, pending);
  applyAnthropicEvent(
    { type: "content_block_start", content_block: { type: "text" } },
    handlers,
    pending,
  );
  applyAnthropicEvent(
    { type: "content_block_delta", delta: { type: "text_delta", text: "Here are the three live chats." } },
    handlers,
    pending,
  );

  assert.deepEqual(
    trace.map((item) => item.kind),
    ["thought", "tool", "thought", "message"],
  );
  assert.equal(trace[0]?.text, "I should list the chats first.");
  assert.equal(trace[1]?.tool, "list_chats");
  assert.equal(trace[2]?.text, "Three are live.");
  assert.equal(trace[3]?.text, "Here are the three live chats.");
  assert.equal(pending.block, "text");
});

test("custom streams finish on Anthropic message_stop even when the socket stays open", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ].join(""),
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await streamCustomHttp(
    { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3", api: "anthropic-messages" },
    { messages: [{ role: "user", text: "finish" }] },
    {},
    async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );

  assert.equal(result.text, "done");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.usage?.outputTokens, 1);
  assert.equal(cancelled, true);
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
    handlers?.onChunk?.("This chat is read-only.");
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

test("custom host keeps going when MiniMax says it will search more", async () => {
  assert.ok(CUSTOM_TURN_SAFETY_DEFAULTS.emergencyModelCalls > 32);
  assert.equal(looksLikeUnfinishedDeskTurn("Let me search more broadly for it."), true);
  assert.equal(looksLikeUnfinishedDeskTurn("Here is the folder: D:\\godot\\demo-game"), false);
  assert.equal(looksLikeUnfinishedDeskTurn("ok", "max_tokens"), true);
  assert.equal(looksLikeWaitingOnUser("Say which and I'll proceed."), true);
  assert.equal(looksLikeUnfinishedDeskTurn("Say which and I'll proceed."), false);
  assert.equal(looksLikeUnfinishedDeskTurn("Which direction?"), false);
  assert.equal(looksLikeUnfinishedDeskTurn("Want me to take a look inside the folder?"), false);
  assert.equal(
    looksLikeUnfinishedDeskTurn(
      "Where to go next — pick one and I'll proceed:\n1. Attach this chat\n2. List the scenes\nWhich direction?",
    ),
    false,
  );
  assert.equal(looksLikeDispatchCheckBack("I'll check back. Status snapshot in a moment."), true);
  assert.equal(looksLikeUnfinishedDeskTurn("I'll check back. Status snapshot in a moment."), false);
  assert.equal(looksLikeUnfinishedDeskTurn("I will wait for the workers."), false);
  assert.equal(looksLikeUnfinishedDeskTurn("Let me search more broadly for it."), true);
  const calls: string[] = [];
  const host = new CustomSessionHost(async (_config, input) => {
    const last = input.messages.at(-1)?.text ?? "";
    calls.push(last);
    if (calls.length === 1) {
      return { text: "I don't see a godot folder. Let me search more broadly for it." };
    }
    return { text: "Found it at D:\\godot\\projects\\demo-game" };
  });
  const reply = await host.prompt(
    {
      sessionId: "s-search",
      text: "Can you find the godot folder with the space battles game in it please",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: "C:\\Users\\someone",
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    () => undefined,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /Continue/);
  assert.match(reply.text, /demo-game/);
});

test("custom host ends the parent turn after wait=false spawn and does not continue I'll-check-back", async () => {
  const started = JSON.stringify(
    {
      started: true,
      title: "Scripts scrape",
      childSessionId: "sess_worker",
      folder: "D:\\Godot\\Projects\\demo-game",
    },
    null,
    2,
  );
  assert.equal(spawnDispatchStarted({ name: "workhorse_spawn_agent", content: started }), true);
  assert.equal(shouldEndDispatchTurn([{ name: "workhorse_spawn_agent", content: started }]), true);
  assert.equal(
    shouldEndDispatchTurn([{ name: "workhorse_spawn_agent", content: "HUD is in main_hud.gd." }]),
    false,
  );
  assert.equal(shouldEndDispatchTurn([{ name: "workhorse_list_bots", content: "[]" }]), false);

  let spawnCalls = 0;
  const spawnHost = new CustomSessionHost(
    async () => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        return {
          text: "Four workers are out on the Spaceship battles folder.",
          toolUses: [
            {
              id: "spawn-1",
              name: "workhorse_spawn_agent",
              input: { prompt: "Read project.godot", wait: false, description: "Structure" },
            },
          ],
        };
      }
      return { text: "I'll check back. Status snapshot in a moment." };
    },
    {
      executeTool: async (use) => ({
        id: use.id,
        name: use.name,
        content: started,
      }),
    },
  );
  const events: Array<{ type: string; stopReason?: string }> = [];
  const spawnReply = await spawnHost.prompt(
    {
      sessionId: "s-dispatch-end",
      text: "Please do a deep scrape of this project with subagents",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: "D:\\Godot\\Projects\\demo-game",
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    (event) => events.push({ type: event.type, stopReason: "stopReason" in event ? event.stopReason : undefined }),
  );
  assert.equal(spawnCalls, 1);
  assert.equal(spawnReply.stopReason, "end_turn");
  assert.match(spawnReply.text ?? "", /Four workers are out/);
  assert.doesNotMatch(spawnReply.text ?? "", /Status snapshot in a moment/);
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.at(-1)?.stopReason, "end_turn");

  let checkBackCalls = 0;
  const checkBackHost = new CustomSessionHost(async () => {
    checkBackCalls += 1;
    return { text: "I'll check back. Status snapshot in a moment." };
  });
  const checkBackReply = await checkBackHost.prompt(
    {
      sessionId: "s-check-back",
      text: "Please do a deep scrape of this project with subagents",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: "D:\\Godot\\Projects\\demo-game",
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    () => undefined,
  );
  assert.equal(checkBackCalls, 1);
  assert.equal(checkBackReply.stopReason, "end_turn");
  assert.match(checkBackReply.text ?? "", /I'll check back/);
});

test("custom host does not keep going when MiniMax asks the user to pick", async () => {
  let calls = 0;
  const host = new CustomSessionHost(async () => {
    calls += 1;
    return {
      text: "Where to go next — pick one and I'll proceed:\n1. Attach this chat\n2. Run a smoke test\nWhich direction?",
    };
  });
  const reply = await host.prompt(
    {
      sessionId: "s-pick",
      text: "List the scene tree so I can map the codebase",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: "D:\\godot\\Projects\\demo-game",
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    () => undefined,
  );
  assert.equal(calls, 1);
  assert.match(reply.text ?? "", /Which direction/);
});

test("custom host continues productive work beyond the old 32-round ceiling", async () => {
  let calls = 0;
  const host = new CustomSessionHost(async () => {
    calls += 1;
    if (calls <= 40) {
      return {
        text: `Productive step ${calls}.`,
        toolUses: [{ id: `step-${calls}`, name: "workhorse_list_tools", input: { step: calls } }],
      };
    }
    return { text: "Finished all 40 productive steps." };
  });
  const reply = await host.prompt(
    {
      sessionId: "s-long-productive",
      text: "Complete a long desk task",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    () => undefined,
  );
  assert.equal(calls, 41);
  assert.equal(reply.stopReason, "end_turn");
  assert.match(reply.text, /Finished all 40/);
});

test("custom host safety-pauses an identical tool and result loop", async () => {
  let calls = 0;
  const events: Array<{ type: string; stopReason?: string; text?: string }> = [];
  const host = new CustomSessionHost(
    async () => {
      calls += 1;
      return {
        text: "Checking the same catalog again.",
        toolUses: [{ id: `repeat-${calls}`, name: "workhorse_list_tools", input: {} }],
      };
    },
    { repeatedToolRounds: 3 },
  );
  const reply = await host.prompt(
    {
      sessionId: "s-repeat",
      text: "Find it",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    (event) => events.push(event),
  );
  assert.equal(calls, 3);
  assert.equal(reply.stopReason, "safety_pause");
  assert.match(reply.text, /same tool action/i);
  assert.equal(events.at(-1)?.stopReason, "safety_pause");
});

test("custom host streams an empty-turn safety pause without duplicate-leading whitespace", async () => {
  let calls = 0;
  const events: Array<{ type: string; stopReason?: string; text?: string }> = [];
  const host = new CustomSessionHost(
    async () => {
      calls += 1;
      return {
        text: "",
        toolUses: [{ id: `repeat-empty-${calls}`, name: "workhorse_list_tools", input: {} }],
      };
    },
    { repeatedToolRounds: 2 },
  );
  const reply = await host.prompt(
    {
      sessionId: "s-repeat-empty",
      text: "Find it",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    (event) => events.push(event),
  );
  const chunks = events.filter((event) => event.type === "chunk" && event.text);
  assert.equal(calls, 2);
  assert.equal(reply.stopReason, "safety_pause");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, chunks[0].text?.trimStart());
  assert.equal(reply.text, chunks[0].text);
});

test("custom host does not halt a worker that already wrote a report", async () => {
  const report = `${"res://scenes/main.tscn exists. ".repeat(20)}Let me check one more preload.`;
  assert.equal(workerHasDeliverableReport(report), true);
  assert.equal(looksLikeUnfinishedDeskTurn(report, undefined, "worker"), false);
  assert.equal(looksLikeUnfinishedDeskTurn("Let me search more broadly for it."), true);

  let calls = 0;
  const host = new CustomSessionHost(
    async () => {
      calls += 1;
      return {
        text: report,
        toolUses: [{ id: `miss-${calls}`, name: "read_file", input: { path: `missing-${calls}.txt` } }],
      };
    },
    {
      failedToolRounds: 3,
      repeatedToolRounds: 99,
      executeTool: async (use) => ({ id: use.id, name: use.name, content: "missing", isError: true }),
    },
  );
  const reply = await host.prompt(
    {
      sessionId: "s-worker-done",
      parentId: "orch",
      hidden: true,
      role: "worker",
      text: "ROLE: worker\nFOLDER: D:\\Godot\\Projects\\demo-game\n\nScrape assets.",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    () => undefined,
  );
  assert.equal(reply.stopReason, "end_turn");
  assert.doesNotMatch(reply.text ?? "", /Workhorse paused/);
  assert.match(reply.text ?? "", /res:\/\/scenes\/main.tscn/);
});

test("custom host safety-pauses sustained distinct tool failures", async () => {
  let calls = 0;
  const host = new CustomSessionHost(
    async () => {
      calls += 1;
      return {
        text: `Trying candidate ${calls}.`,
        toolUses: [{ id: `fail-${calls}`, name: "read_file", input: { path: `missing-${calls}.txt` } }],
      };
    },
    { failedToolRounds: 3, repeatedToolRounds: 99 },
  );
  const reply = await host.prompt(
    {
      sessionId: "s-failures",
      text: "Read candidates",
      model: "MiniMax-M3",
      effort: "medium",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
    },
    () => undefined,
  );
  assert.equal(calls, 3);
  assert.equal(reply.stopReason, "safety_pause");
  assert.match(reply.text, /repeated tool failures/i);
});

test("custom host continues changing max-token output but pauses empty promises", async () => {
  let tokenCalls = 0;
  const tokenHost = new CustomSessionHost(async () => {
    tokenCalls += 1;
    return tokenCalls <= 8
      ? { text: `Useful answer segment ${tokenCalls}.`, stopReason: "max_tokens" }
      : { text: "Useful answer complete." };
  });
  const common = {
    text: "Write a long answer",
    model: "MiniMax-M3",
    effort: "medium" as const,
    cwd: ROOT,
    mode: "always-approve" as const,
    sandbox: "off" as const,
    history: [],
    config: { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk", model: "MiniMax-M3" },
  };
  const tokenReply = await tokenHost.prompt({ ...common, sessionId: "s-token-parts" }, () => undefined);
  assert.equal(tokenCalls, 9);
  assert.equal(tokenReply.stopReason, "end_turn");

  let promiseCalls = 0;
  const promiseHost = new CustomSessionHost(
    async () => {
      promiseCalls += 1;
      return { text: "Let me keep looking and try another search." };
    },
    { unfulfilledContinuations: 3 },
  );
  const promiseReply = await promiseHost.prompt({ ...common, sessionId: "s-empty-promises" }, () => undefined);
  assert.equal(promiseCalls, 3);
  assert.equal(promiseReply.stopReason, "safety_pause");
  assert.match(promiseReply.text, /without calling a tool/i);
});

test("custom host compacts old tool transcript into a continuation checkpoint", () => {
  const base = [{ role: "user" as const, text: "Original task" }];
  const loop = Array.from({ length: 12 }, (_, index) => [
    {
      role: "assistant" as const,
      text: `Step ${index}`,
      toolUses: [{ id: `tool-${index}`, name: "read_file", input: { path: `file-${index}.txt` } }],
    },
    {
      role: "user" as const,
      text: "",
      toolResults: [{ id: `tool-${index}`, name: "read_file", content: "x".repeat(1_000) }],
    },
  ]).flat();
  const compacted = compactCustomTurnTranscript([...base, ...loop], base.length, 3_000);
  assert.ok(compacted.length < base.length + loop.length);
  assert.match(compacted[base.length - 1]?.text ?? "", /continuation checkpoint/i);
  assert.notEqual(compacted[base.length]?.role, "user");
  assert.ok(compacted.at(-1)?.toolResults?.length);
});

test("custom shell tools honor the session cancellation signal", async () => {
  const abort = new AbortController();
  const started = Date.now();
  const running = executeCustomTool(
    {
      id: "cancel-command",
      name: "run_command",
      input: { command: `"${process.execPath}" -e "setTimeout(() => process.exit(0), 5000)"` },
    },
    { mode: "always-approve", sandbox: "off", cwd: ROOT, signal: abort.signal },
  );
  setTimeout(() => abort.abort(), 50);
  const result = await running;
  assert.equal(result.isError, true);
  assert.match(result.content, /cancel/i);
  assert.ok(Date.now() - started < 2_000);
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
  assert.match(setup, /label: "Full access"/);
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

  const currentPortalShape = parseOpenClawMinimax({
    models: {
      providers: {
        "fireworks-kimi": {
          apiKey: "sk-other",
          baseUrl: "https://example.invalid/v1",
          models: [{ id: "Kimi-K3", name: "Kimi K3" }],
        },
        "minimax-portal": {
          apiKey: "sk-portal",
          baseUrl: "https://api.minimax.io/anthropic/v1",
          models: [{ id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 1_000_000 }],
        },
      },
    },
  });
  assert.equal(currentPortalShape?.config.apiKey, "sk-portal");
  assert.equal(currentPortalShape?.config.model, "MiniMax-M3");
  assert.equal(currentPortalShape?.config.api, "anthropic-messages");

  const rehydrated = hydrateDetectedCustomCredentials(
    {
      settings: {
        llms: { custom: { baseUrl: "", model: "", apiKey: "" } },
        customBots: [
          {
            id: "m3",
            baseUrl: "https://api.minimax.io/anthropic/v1/",
            model: "MiniMax-M3",
            apiKey: "",
            credentialId: "custom-bot-m3",
          },
          { id: "other", baseUrl: "https://example.invalid/v1", model: "other", apiKey: "" },
        ],
      },
    },
    {
      connected: true,
      source: "openclaw",
      config: currentPortalShape!.config,
      models: currentPortalShape!.models,
    },
  );
  assert.equal(rehydrated.settings.customBots[0].apiKey, "sk-portal");
  assert.equal(rehydrated.settings.customBots[1].apiKey, "");
});

test("openClawKeyForBaseUrl matches MiniMax and Synthetic hosts from OpenClaw on Windows", () => {
  const windowsHome = "C:\\home";
  const openClawPath = path.join(windowsHome, ".openclaw", "openclaw.json");
  const input = {
    homedir: windowsHome,
    env: {},
    existsSync: (file: string) => file === openClawPath,
    readFile: (file: string) => {
      assert.equal(file, openClawPath);
      return JSON.stringify({
        models: {
          providers: {
            "fireworks-kimi": { apiKey: "sk-other", baseUrl: "https://example.invalid/v1" },
            "minimax-portal": { apiKey: "sk-portal", baseUrl: "https://api.minimax.io/anthropic/v1" },
            "synthetic-k3": { apiKey: "syn_test", baseUrl: "https://api.synthetic.new/openai/v1" },
          },
        },
      });
    },
  };
  assert.equal(openClawKeyForBaseUrl("https://api.minimax.io/v1", input), "sk-portal");
  assert.equal(openClawKeyForBaseUrl("https://api.synthetic.new/openai/v1", input), "syn_test");
  assert.equal(openClawKeyForBaseUrl("https://api.groq.com/openai/v1", input), "");
  assert.equal(
    openClawKeyForBaseUrl("https://api.minimax.io/v1", {
      homedir: windowsHome,
      env: { MINIMAX_API_KEY: "sk-env" },
      existsSync: () => {
        throw new Error("Windows env MiniMax key should not read OpenClaw");
      },
      readFile: () => {
        throw new Error("should not read");
      },
    }),
    "sk-env",
  );
  const missing = openClawKeyForBaseUrl("https://api.minimax.io/v1", {
    homedir: path.join(ROOT, "does-not-exist"),
    env: {},
    existsSync: () => false,
    readFile: () => {
      throw new Error("should not read");
    },
  });
  assert.equal(missing, "");
  const filled = fillEmptyCustomBotKeys(
    {
      settings: {
        customBots: [
          { id: "mini", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M3", apiKey: "", credentialId: "custom-bot-mini" },
          { id: "kimi", baseUrl: "https://api.synthetic.new/openai/v1", model: "hf:moonshotai/Kimi-K3", apiKey: "" },
          { id: "keep", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M3", apiKey: "sk-keep" },
        ],
      },
    },
    input,
  );
  assert.equal(filled.settings.customBots[0].apiKey, "sk-portal");
  assert.equal(filled.settings.customBots[1].apiKey, "syn_test");
  assert.equal(filled.settings.customBots[2].apiKey, "sk-keep");
});

test("parseCustomPlanUsage reads MiniMax weekly leftover percent", () => {
  assert.equal(leftoverFromRemainingPercent(100), 100);
  assert.equal(leftoverFromRemainingPercent(0.86), 86);
  assert.equal(
    customPlanRemainsUrl("https://api.minimax.io/anthropic"),
    "https://www.minimax.io/v1/token_plan/remains",
  );
  assert.equal(
    customPlanRemainsUrl("https://api.minimax.io/v1"),
    "https://www.minimax.io/v1/token_plan/remains",
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
  assert.equal(plan?.products[0]?.label, "5h");
  assert.equal(plan?.products[0]?.usagePercent, 14);
  assert.equal(plan?.products[1]?.label, "Weekly");
  assert.equal(plan?.products[1]?.usagePercent, 0);
  assert.equal(plan?.products[1]?.unlimited, undefined);
});

test("parseCustomPlanUsage keeps 5h and marks unlimited weekly", () => {
  assert.equal(
    weeklyIsUnlimited(
      { current_weekly_remaining_percent: 0, current_interval_remaining_percent: 83 },
      {},
      0,
      83,
    ),
    false,
  );
  assert.equal(
    weeklyIsUnlimited({ current_weekly_status: 3 }, {}, undefined, 83),
    true,
  );
  assert.equal(
    weeklyIsUnlimited({ current_weekly_status: 3, current_weekly_remaining_percent: 100 }, {}, 100, 27),
    false,
  );
  const unlimited = parseCustomPlanUsage({
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: 83,
        current_weekly_remaining_percent: 0,
        interval_end_time: Date.now() + 44 * 60 * 1000,
        weekly_unlimited: true,
      },
    ],
  });
  assert.equal(unlimited?.leftPercent, 100);
  assert.equal(unlimited?.usedPercent, 0);
  assert.equal(unlimited?.products[0]?.label, "5h");
  assert.equal(unlimited?.products[0]?.usagePercent, 17);
  assert.equal(unlimited?.products[1]?.unlimited, true);
  assert.equal(unlimited?.products[1]?.usagePercent, 0);

  const flagged = parseCustomPlanUsage({
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: 90,
        current_weekly_remaining_percent: "Unlimited",
      },
    ],
  });
  assert.equal(flagged?.products[1]?.unlimited, true);
  assert.equal(flagged?.leftPercent, 100);

  const spentWeekly = parseCustomPlanUsage({
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: 83,
        current_weekly_remaining_percent: 0,
      },
    ],
  });
  assert.equal(spentWeekly?.products[1]?.unlimited, undefined);
  assert.equal(spentWeekly?.leftPercent, 0);
  assert.equal(spentWeekly?.usedPercent, 100);
  assert.equal(spentWeekly?.products[0]?.usagePercent, 17);
  assert.equal(spentWeekly?.products[1]?.usagePercent, 100);

  const percentOnly = parseCustomPlanUsage({
    model_remains: [
      {
        model_name: "general",
        current_interval_remaining_percent: 99,
        current_weekly_remaining_percent: 99,
        remains_time: 14998196,
        weekly_remains_time: 547798196,
      },
    ],
  });
  assert.equal(percentOnly?.leftPercent, 99);
  assert.equal(percentOnly?.products[0]?.usagePercent, 1);
  assert.ok(percentOnly?.products[0]?.resetsAt);
  assert.ok(percentOnly?.resetsAt);

  const tokenPlan = parseCustomPlanUsage({
    model_remains: [
      {
        model_name: "general",
        start_time: 1782381600000,
        end_time: 1782399600000,
        remains_time: 2669853,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_remaining_percent: 31,
        current_interval_status: 1,
        current_weekly_total_count: 0,
        current_weekly_usage_count: 0,
        current_weekly_remaining_percent: 69,
        current_weekly_status: 1,
        weekly_start_time: 1782086400000,
        weekly_end_time: 1782691200000,
        weekly_remains_time: 294269853,
      },
    ],
  });
  assert.equal(tokenPlan?.leftPercent, 69);
  assert.equal(tokenPlan?.usedPercent, 31);
  assert.equal(tokenPlan?.products[0]?.label, "5h");
  assert.equal(tokenPlan?.products[0]?.usagePercent, 69);
  assert.equal(tokenPlan?.products[0]?.unlimited, undefined);
  assert.ok(tokenPlan?.products[0]?.resetsAt);
  assert.equal(tokenPlan?.products[1]?.label, "Weekly");
  assert.equal(tokenPlan?.products[1]?.usagePercent, 31);
  assert.equal(tokenPlan?.products[1]?.unlimited, undefined);

  const liveGeneral = parseCustomPlanUsage({
    model_remains: [
      {
        model_name: "general",
        current_interval_status: 1,
        current_interval_remaining_percent: 27,
        current_weekly_status: 3,
        current_weekly_remaining_percent: 100,
        current_weekly_total_count: 0,
        current_interval_total_count: 0,
        end_time: Date.now() + 37 * 60 * 1000,
        weekly_end_time: Date.now() + 4 * 24 * 60 * 60 * 1000,
      },
    ],
  });
  assert.equal(liveGeneral?.leftPercent, 100);
  assert.equal(liveGeneral?.usedPercent, 0);
  assert.equal(liveGeneral?.products[0]?.usagePercent, 73);
  assert.equal(liveGeneral?.products[1]?.unlimited, undefined);
  assert.equal(liveGeneral?.products[1]?.usagePercent, 0);
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
  assert.deepEqual(streamed, [{ inputTokens: 80, outputTokens: 12 }]);

  const hostEvents: Array<{
    type: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    source?: string;
    contextUsed?: number;
  }> = [];
  const host = new CustomSessionHost(async (_config, _input, handlers) => {
    handlers?.onUsage?.({ inputTokens: 80, outputTokens: 12, cacheReadTokens: 10, cacheWriteTokens: 0 });
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
          source: event.source,
          contextUsed: event.contextUsed,
        });
      }
    },
  );
  // One HTTP call = one `request` bill, then a `gauge` with what the model
  // holds (fresh + cached) so the context ring is right without booking tokens.
  assert.deepEqual(hostEvents, [
    { type: "usage", inputTokens: 80, outputTokens: 12, model: "MiniMax-M3", source: "request", contextUsed: undefined },
    { type: "usage", inputTokens: 0, outputTokens: 0, model: "MiniMax-M3", source: "gauge", contextUsed: 90 },
  ]);

  let rounds = 0;
  const roundHost = new CustomSessionHost(async () => {
    rounds += 1;
    if (rounds === 1) {
      return {
        text: "checking",
        usage: { inputTokens: 500_000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        toolUses: [{ id: "t1", name: "list_dir", input: { path: "." } }],
      };
    }
    return {
      text: "done",
      usage: { inputTokens: 520_000, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  });
  const roundUsage: { inputTokens: number; source?: string; contextUsed?: number }[] = [];
  await roundHost.prompt(
    {
      sessionId: "s-kimi",
      text: "hi",
      model: "hf:moonshotai/Kimi-K3",
      effort: "low",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      history: [],
      config: { baseUrl: "https://api.synthetic.new/openai/v1", apiKey: "syn_k", model: "hf:moonshotai/Kimi-K3" },
    },
    (event) => {
      if (event.type === "usage") roundUsage.push({ inputTokens: event.inputTokens, source: event.source, contextUsed: event.contextUsed });
    },
  );
  assert.equal(rounds, 2);
  // Both requests in the tool loop go out as their own bill. The old host kept
  // only the last one ([520_000]) and let the store guess; a 21-request Kimi
  // turn then stored 3.59M as one event. The store adds `request` reports.
  assert.deepEqual(roundUsage, [
    { inputTokens: 500_000, source: "request", contextUsed: undefined },
    { inputTokens: 520_000, source: "request", contextUsed: undefined },
    { inputTokens: 0, source: "gauge", contextUsed: 520_000 },
  ]);
  assert.equal(customPlanRemainsUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/key");
  const openRouter = parseCustomPlanUsage({ data: { usage: 2, limit: 10, limit_remaining: 8 } });
  assert.equal(openRouter?.usedPercent, 20);
  assert.equal(openRouter?.leftPercent, 80);
  assert.equal(customPlanRemainsUrl("https://api.synthetic.new/openai/v1"), "https://api.synthetic.new/v2/quotas");
  assert.equal(customPlanRemainsUrl("https://synthetic.new"), "https://api.synthetic.new/v2/quotas");
  const synthetic = parseCustomPlanUsage({
    subscription: { limit: 135, requests: 27, renewsAt: "2025-09-21T14:36:14.288Z" },
  });
  assert.equal(synthetic?.usedPercent, 20);
  assert.equal(synthetic?.leftPercent, 80);
  assert.equal(synthetic?.products[0]?.product, "session");
  assert.equal(synthetic?.products[0]?.label, "5h");
  assert.equal(synthetic?.resetsAt, "2025-09-21T14:36:14.288Z");
  const synWeekly = parseCustomPlanUsage({
    subscription: { limit: 500, requests: 0, renewsAt: "2026-08-17T06:26:17.610Z" },
    weeklyTokenLimit: { percentRemaining: 57.25, nextRegenAt: "2026-08-17T03:58:52.000Z" },
    rollingFiveHourLimit: { remaining: 500, max: 500, nextTickAt: "2026-08-17T01:37:24.000Z" },
  });
  assert.equal(synWeekly?.leftPercent, 57.25);
  assert.equal(synWeekly?.products[0]?.product, "session");
  assert.equal(synWeekly?.products[0]?.usagePercent, 0);
  assert.equal(synWeekly?.products[1]?.product, "weekly");
  assert.equal(synWeekly?.products[1]?.usagePercent, 42.75);
  assert.equal(parseCustomPlanUsage({ subscription: { limit: 0, requests: 0 } }), undefined);
  assert.equal(parseCustomPlanUsage({ subscription: { requests: 3 } }), undefined);
  assert.equal(customPlanRemainsUrl("https://api.groq.com/openai/v1"), undefined);
  assert.equal(customPlanRemainsUrl("https://api.together.ai/v1"), undefined);
  assert.equal(customPlanRemainsUrl("https://api.fireworks.ai/inference/v1"), undefined);
  assert.equal(customPlanRemainsUrl("https://router.huggingface.co/v1"), undefined);
  assert.equal(customPlanRemainsUrl("https://api.cerebras.ai/v1"), undefined);
  assert.equal(customPlanRemainsUrl("https://api.deepseek.com"), "https://api.deepseek.com/user/balance");
  assert.equal(customPlanRemainsUrl("https://api.novita.ai/openai"), "https://api.novita.ai/openapi/v1/billing/balance/detail");
  assert.equal(customPlanRemainsUrl("https://api.aimlapi.com/v1"), "https://api.aimlapi.com/v2/billing");
  const seen: string[] = [];
  const miniPlan = await fetchCustomPlanUsage({
    baseUrl: "https://api.minimax.io/anthropic",
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          model_remains: [{ model_name: "general", current_weekly_remaining_percent: 86, current_interval_remaining_percent: 90 }],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(seen[0], "https://www.minimax.io/v1/token_plan/remains");
  assert.equal(miniPlan?.leftPercent, 86);
  const deepseekPlan = await fetchCustomPlanUsage({
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: "8.00" }],
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(seen.at(-1), "https://api.deepseek.com/user/balance");
  assert.equal(deepseekPlan?.prepaidBalance, 8);
  assert.equal(Number.isFinite(deepseekPlan?.leftPercent), false);
  const synPlan = await fetchCustomPlanUsage({
    baseUrl: "https://api.synthetic.new/openai/v1",
    apiKey: "syn_test",
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ subscription: { limit: 500, requests: 50, renewAt: "2026-08-16T12:00:00Z" } }), {
        status: 200,
      });
    },
  });
  assert.equal(seen.at(-1), "https://api.synthetic.new/v2/quotas");
  assert.equal(synPlan?.leftPercent, 90);
  assert.equal(synPlan?.products[0]?.product, "session");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  // The ingest asks which bot the report belongs to before it asks which
  // session it arrived under; a worker's report lands under its
  // orchestrator's session, so the session alone filed Kimi as Cursor.
  assert.match(store, /usageHomeForReport\(event, owner/);
  assert.match(store, /customBotId: home\.customBotId/);
  assert.match(store, /customBotId: session.customBotId/);
  const customHostSrc = readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8");
  assert.match(customHostSrc, /customBotId: input.customBotId/);
  const { leftoverMissingCopy, leftoverForCard } = await import("../src/lib/usage");
  assert.equal(
    leftoverMissingCopy({ hasKey: false, fetchKnown: false, canLoad: true, planName: "Kimi K3" }),
    "This key isn't stored. Paste it on the bot in Settings to track leftover.",
  );
  assert.equal(
    leftoverMissingCopy({ hasKey: true, fetchKnown: true, canLoad: true, planName: "Kimi K3" }),
    "Couldn't read weekly leftover for this key.",
  );
  assert.match(leftoverMissingCopy({ hasKey: true, fetchKnown: false, canLoad: true, planName: "Kimi K3" }), /Loading weekly plan usage/);
  const cardPlan = leftoverForCard(
    { focus: "bot:bot_syn", provider: "custom", key: "bot_syn" },
    { custom: { bot_syn: { usedPercent: 20, leftPercent: 80, period: "weekly", prepaidBalance: 0, products: [] } } },
  );
  assert.equal(cardPlan?.leftPercent, 80);
  assert.equal(defaultModel("custom").id, "MiniMax-M3");
  assert.equal(knownContextWindow("MiniMax-M3"), 1_000_000);
  assert.equal(catalogWindow("hf:moonshotai/Kimi-K3"), 524_288);
  assert.equal(detectProviderFromKey("sk-cp-abc")?.id, "minimax");
  assert.equal(detectProviderFromKey("syn_abc")?.id, "synthetic");
  assert.equal(detectProviderFromKey("sk-or-v1-abc")?.id, "openrouter");
  assert.equal(inferCustomApi("https://api.minimax.io/v1"), "openai-completions");
  assert.equal(inferCustomApi("https://api.minimax.io/anthropic"), "anthropic-messages");
  assert.equal(
    contextFromModelList({ data: [{ id: "hf:moonshotai/Kimi-K3", context_length: 524288 }] }, "hf:moonshotai/Kimi-K3"),
    524288,
  );
  const fromKey = assembleCustomBotDraft(
    { apiKey: "sk-cp-test-key" },
    { connected: false, source: "none", config: EMPTY_CUSTOM_DRAFT },
  );
  assert.equal(fromKey.error, undefined);
  assert.equal(fromKey.draft.model, "MiniMax-M3");
  assert.equal(fromKey.draft.baseUrl, "https://api.minimax.io/v1");
  assert.equal(fromKey.draft.contextWindow, 1_000_000);
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

test("Grok Bot weekly leftover reads the local account-menu fixture and missing stays unknown", async () => {
  const now = Date.parse("2026-08-22T03:10:00.000Z");
  const fixturePath = grokBotLeftoverPath(path.join("fixture", "Go7 Workhorse"));
  assert.equal(fixturePath, path.join("fixture", "Go7 Workhorse", "grok-bot-leftover.json"));
  const plan = await fetchCustomPlanUsage({
    baseUrl: "http://127.0.0.1:8787/v1",
    apiKey: "",
    grokBotLeftoverPath: fixturePath,
    fetchImpl: async () => {
      throw new Error("Grok Bot leftover must not poll a network meter");
    },
    readFileImpl: async (filePath, encoding) => {
      assert.equal(filePath, fixturePath);
      assert.equal(encoding, "utf8");
      return JSON.stringify({
        weekly: { usedPercent: 27, resetsAt: "2026-08-28T12:00:00-04:00", asOf: "2026-08-22T03:00:00.000Z" },
      });
    },
    now,
  });
  assert.equal(plan?.usedPercent, 27);
  assert.equal(plan?.leftPercent, 73);
  assert.equal(plan?.period, "weekly");
  assert.equal(plan?.resetsAt, "2026-08-28T16:00:00.000Z");
  assert.equal(plan?.observedAt, "2026-08-22T03:00:00.000Z");
  assert.equal(plan?.prepaidBalance, 0);
  assert.equal(plan?.products[0]?.product, "weekly");
  assert.equal(plan?.products[0]?.usagePercent, 27);

  const onePercentUsed = parseGrokBotPlanUsage(
    { usedPercent: 1, resetsAt: "2026-08-28T16:00:00.000Z", asOf: "2026-08-22T03:00:00.000Z" },
    now,
  );
  assert.equal(onePercentUsed?.leftPercent, 99, "1 means 1% used, not a 0–1 fraction");
  assert.equal(
    parseGrokBotPlanUsage(
      { leftPercent: 9, resetsAt: "2026-08-28T16:00:00.000Z", asOf: "2026-08-22T03:00:00.000Z" },
      now,
    ),
    undefined,
  );
  assert.equal(
    parseGrokBotPlanUsage({ usedPercent: 27, resetsAt: "not-a-date", asOf: "2026-08-22T03:00:00.000Z" }, now),
    undefined,
  );
  assert.equal(
    parseGrokBotPlanUsage({ usedPercent: 27, resetsAt: "2026-08-28T16:00:00.000Z" }, now),
    undefined,
    "missing asOf stays unknown",
  );
  assert.equal(
    parseGrokBotPlanUsage(
      { usedPercent: 27, resetsAt: "2026-08-28T16:00:00.000Z", asOf: "not-a-date" },
      now,
    ),
    undefined,
    "malformed asOf stays unknown",
  );
  assert.equal(
    parseGrokBotPlanUsage(
      { usedPercent: 27, resetsAt: "2026-08-28T16:00:00.000Z", asOf: "2026-08-21T03:09:59.999Z" },
      now,
    ),
    undefined,
    "a reading older than 24 hours stays unknown",
  );
  assert.equal(
    parseGrokBotPlanUsage(
      { usedPercent: 27, resetsAt: "2026-08-22T03:10:00.000Z", asOf: "2026-08-22T03:00:00.000Z" },
      now,
    ),
    undefined,
    "an expired reset stays unknown immediately",
  );

  const missing = await fetchCustomPlanUsage({
    baseUrl: "http://127.0.0.1:8787/v1",
    apiKey: "local",
    grokBotLeftoverPath: fixturePath,
    readFileImpl: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(missing, undefined);
});

test("Grok Bot probe fails closed when the local shim is down", async () => {
  const probe = await probeCustomHttp(
    { baseUrl: "http://127.0.0.1:8787/v1", apiKey: "local", model: "grok-bot", api: "openai-completions" },
    async () => {
      throw new Error("fetch failed");
    },
  );
  assert.equal(probe.ok, false);
  assert.equal(probe.message, "Grok Bot shim is down. Do not guess another host.");
  const remote = await probeCustomHttp(
    { baseUrl: "https://api.minimax.io/v1", apiKey: "sk-test", model: "MiniMax-M3", api: "openai-completions" },
    async () => {
      throw new Error("fetch failed");
    },
  );
  assert.equal(remote.ok, false);
  assert.equal(remote.message, "fetch failed");
  const ollama = await probeCustomHttp(
    { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local", model: "llama", api: "openai-completions" },
    async () => {
      throw new Error("fetch failed");
    },
  );
  assert.equal(ollama.ok, false);
  assert.equal(ollama.message, "fetch failed");
});

test("custom usage streaming keeps one authoritative request snapshot", () => {
  const start = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 307_821,
    cacheWriteTokens: 0,
  };
  const finish = {
    inputTokens: 150_575,
    outputTokens: 796,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  assert.deepEqual(mergeCustomUsageSnapshot(start, finish), {
    inputTokens: 150_575,
    outputTokens: 796,
    cacheReadTokens: 307_821,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(mergeCustomUsageSnapshot(finish, finish), finish);
});

test("custom tool results are capped before another model request", () => {
  const raw = `HEAD:${"x".repeat(90_000)}:TAIL`;
  const limited = limitCustomToolResult({ id: "large", name: "run_command", content: raw });
  assert.equal(limited.content.length, MAX_CUSTOM_TOOL_RESULT_CHARS);
  assert.match(limited.content, /^HEAD:/);
  assert.match(limited.content, /Workhorse truncated/);
  assert.match(limited.content, /:TAIL$/);
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
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "BotForm.tsx"), "utf8"), /providerPresetsByBilling/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "BotForm.tsx"), "utf8"), /detectProviderFromKey/);
  assert.match(addBot, /Your own/);
  assert.match(addBot, /createCustomBot/);
  assert.match(addBot, /probeCustomDraft/);
  assert.match(setup, /"custom"/);
  assert.match(main, /ipcMain\.handle\("custom:prompt"/);
  assert.doesNotMatch(main, /custom:complete-title/);
  assert.match(main, /detectCustomLogin/);
  assert.match(main, /openClawKeyForBaseUrl/);
  assert.match(main, /fillEmptyCustomBotKeys/);
  assert.match(preload, /custom:detect/);
  assert.doesNotMatch(preload, /completeChatTitle/);
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
    { provider: "grok", model: "grok-4.6", effort: "high" },
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
  const workerBody = buildAnthropicBody({
    model: "MiniMax-M3",
    messages: [{ role: "user", text: "list the folder" }],
    role: "worker",
  });
  const workerToolNames = (workerBody.tools as { name: string }[]).map((tool) => tool.name);
  assert.ok(workerToolNames.includes("workhorse_spawn_agent"));
  assert.ok(workerToolNames.includes("workhorse_await_agents"));
  assert.ok(!workerToolNames.includes("workhorse_request_vendor"));
  assert.ok(workerToolNames.includes("list_dir"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_list_skills"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_list_tools"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_ask_chat"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_spawn_agent"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_await_agents"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_create_project"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_move_chat"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_rename_chat"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_rename_project"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_delete_chat"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_delete_project"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_request_permission"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_request_vendor"));
  assert.ok(customHttpTools().some((tool) => tool.name === "workhorse_list_projects"));
  const workerCatalog = customHttpTools([], { role: "worker" }).map((tool) => tool.name);
  assert.ok(workerCatalog.includes("workhorse_spawn_agent"));
  assert.ok(workerCatalog.includes("workhorse_await_agents"));
  assert.ok(!workerCatalog.includes("workhorse_request_vendor"));
  assert.ok(!workerCatalog.includes("workhorse_list_bots"));
  assert.ok(workerCatalog.includes("list_dir"));
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_list_skills/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_ask_chat/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_spawn_agent/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_create_project/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_move_chat/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_rename_chat/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_rename_project/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Do not delete and recreate/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Visible sidebar names/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /the rename did not take/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /puts THIS chat/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /search likely folders first/i);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Documents, Desktop, and Projects/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /If they name a drive or folder/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Do not ask the user for a path when a matching folder exists/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Never delete this chat on a bulk list/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /onlyThis=true only when the user asked to delete this chat alone/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /After you ask the user to pick, stop/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /scope=loose/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Do not offer A\/B\/C/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /workhorse_request_permission/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /only RAISES access/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /USER DECLINED/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /said no/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Do not ask which vendor/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /that vendor is a no-go/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Do not call workhorse_request_vendor/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /API key is on the desk/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /If a vendor is not on the list/);
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
  assert.equal(allow, "session");
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
  assert.equal(streamed.toolUses?.[0]?.name, "list_dir");
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
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Only claim it exists if list_projects shows that name/);
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
  const host = new CustomSessionHost(async (_config, _input, handlers) => {
    rounds += 1;
    if (rounds === 1) {
      handlers?.onChunk?.("Checking the folder.");
      return {
        text: "Checking the folder.",
        toolUses: [{ id: "h1", name: "list_dir", input: { path: ROOT } }],
      };
    }
    handlers?.onChunk?.("I see package.json.");
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
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8"), /withSpawnHint/);
  assert.match(readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8"), /withCrewModeHint/);

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

  const miniParent = { provider: "custom" as const, model: "MiniMax-M3", effort: "medium" as const };
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


/**
 * A worker reads a file carrying hostile instructions and follows them. It
 * needs no other foothold, so this is the shortest real attack on the app —
 * and comparing normalized strings let it through: a symlink sitting inside
 * the workspace passed `startsWith` while pointing anywhere.
 */
test("the sandbox contains the real path, not the spelling of it", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wh-contain-"));
  const workspace = path.join(tmp, "workspace");
  const secrets = path.join(tmp, "secrets");
  mkdirSync(workspace);
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "key.txt"), "not for the agent");
  symlinkSync(secrets, path.join(workspace, "escape"));

  // A file inside the workspace is still fine.
  writeFileSync(path.join(workspace, "notes.md"), "ok");
  assert.equal(
    resolveWorkspacePath("notes.md", workspace, [], "workspace"),
    path.join(workspace, "notes.md"),
  );

  // Reading through the link must not pass, though every string in it starts
  // with the workspace.
  assert.throws(
    () => resolveWorkspacePath("escape/key.txt", workspace, [], "workspace"),
    /outside the workspace/,
    "a symlink read escaped the sandbox",
  );

  // Nor may a write to a file that does not exist yet, under the same link.
  assert.throws(
    () => resolveWorkspacePath("escape/planted.txt", workspace, [], "workspace"),
    /outside the workspace/,
    "a symlink write escaped the sandbox",
  );

  // Sandbox off is an explicit choice and still means off.
  assert.equal(
    resolveWorkspacePath("escape/key.txt", workspace, [], "off"),
    path.join(workspace, "escape", "key.txt"),
  );

  // Windows treats these as one directory, so containment has to as well, or
  // the sandbox refuses a path the filesystem considers inside it.
  const cased = { realpath: (value: string) => value, platform: "win32" as NodeJS.Platform };
  assert.equal(
    resolveWorkspacePath(path.join(path.sep, "Work", "repo", "file.ts"), path.join(path.sep, "work", "repo"), [], "workspace", cased),
    path.join(path.sep, "Work", "repo", "file.ts"),
  );
  assert.throws(
    () => resolveWorkspacePath(path.join(path.sep, "Work", "repo", "file.ts"), path.join(path.sep, "work", "repo"), [], "workspace", { ...cased, platform: "linux" }),
    /outside the workspace/,
    "case folding must not leak onto a case-sensitive platform",
  );
});
