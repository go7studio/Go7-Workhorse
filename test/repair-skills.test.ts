import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseOpenClawMinimax } from "../electron/custom-login";
import { knownContextWindow, probeCustomHttp } from "../electron/custom-http";
import { commandsForSession } from "../src/lib/commands";
import { estimateChatContext } from "../src/lib/context-stats";
import {
  CUSTOM_HISTORY_MAX_CHARS,
  customHistoryCharCap,
  customReplaySlice,
} from "../src/lib/custom-history";
import {
  catalogSkills,
  requiredSkillNotInstalled,
  settleSpawnSkillReads,
  skillHomes,
} from "../src/lib/skills-catalog";
import type { ChatMessage } from "../src/lib/types";
import { setupPaintsTide } from "../src/lib/usage";
import { prepareVendorSend } from "../src/lib/vendor-send";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

let seq = 0;
const msg = (role: ChatMessage["role"], text: string, kind?: ChatMessage["kind"]): ChatMessage =>
  ({ id: `m${(seq += 1)}`, role, text, createdAt: seq, ...(kind ? { kind } : {}) }) as ChatMessage;

function writeSkill(dir: string, name: string, description: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

test("workhorse skills sit on every vendor palette and a slash loads the file", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-repair-skills-"));
  writeSkill(path.join(home, ".workhorse", "skills", "desk"), "desk", "Desk control", "Talk to other chats.");
  writeSkill(path.join(home, ".workhorse", "skills", "setup"), "setup", "Setup", "Add a bot.");
  writeSkill(
    path.join(home, ".workhorse", "skills", "workhorse-workshop-pack"),
    "workhorse-workshop-pack",
    "Pack",
    "Design a pack.",
  );
  writeSkill(path.join(home, ".workhorse", "skills", "local-note"), "local-note", "Local", "Not on every palette.");
  writeSkill(path.join(home, ".grok", "skills", "pdf"), "pdf", "PDFs", "Make a PDF.");
  const rows = catalogSkills({ homedir: home, env: {} });
  for (const provider of ["grok", "codex", "claude", "cursor", "custom"] as const) {
    const palette = commandsForSession({ provider }, rows);
    for (const name of ["/desk", "/setup", "/workhorse-workshop-pack"]) {
      const row = palette.find((command) => command.name === name);
      assert.ok(row, `${provider} ${name}`);
      assert.equal(row?.run, "skill", `${provider} ${name}`);
      assert.match(row?.skillBody ?? "", /---/);
    }
  }
  const grok = commandsForSession({ provider: "grok" }, rows);
  assert.equal(grok.some((command) => command.name === "/local-note"), false);
  assert.equal(commandsForSession({ provider: "custom" }, rows).some((command) => command.name === "/local-note"), true);
  assert.equal(grok.find((command) => command.name === "/pdf")?.run, "grok");
  assert.equal(commandsForSession({ provider: "codex" }, rows).some((command) => command.name === "/pdf"), false);

  const desk = grok.find((command) => command.name === "/desk");
  const sent = prepareVendorSend({ provider: "grok", text: "/desk list the chats", match: desk });
  assert.equal(sent.skipVendor, false);
  assert.match(sent.vendorText, /^\/desk list the chats/);
  assert.match(sent.vendorText, /The desk loaded these skills/);
  assert.match(sent.vendorText, /Talk to other chats/);
  assert.doesNotMatch(sent.vendorText, /Follow its SKILL\.md exactly/);
  assert.equal(prepareVendorSend({ provider: "grok", text: "/goal ship it" }).vendorText, "/goal ship it");

  const missing = prepareVendorSend({
    provider: "cursor",
    text: "/pdf make one",
    match: { id: "skill-cursor-pdf", name: "/pdf", hint: "pdf", run: "skill", source: "skill" },
  });
  assert.equal(missing.skipVendor, true);
  assert.match(missing.error ?? "", /Required skill not installed: pdf/);
  assert.doesNotMatch(missing.vendorText, /Follow its SKILL\.md exactly/);
  assert.doesNotMatch(missing.vendorText, /The desk loaded these skills/);

  const codex = commandsForSession({ provider: "codex" }, rows).find((command) => command.name === "/setup");
  const codexSent = prepareVendorSend({ provider: "codex", text: "/setup add a bot", match: codex });
  assert.match(codexSent.vendorText, /Add a bot/);
  assert.match(codexSent.vendorText, /workhorse:setup/);

  const store = read("src/lib/store.tsx");
  assert.match(store, /prep\.error && prep\.skipVendor/);
});

test("a spawn skill with no text is not installed and does not start the vendor", () => {
  const settled = settleSpawnSkillReads([
    {
      name: "desk",
      text: "---\nname: desk\n---\n\nDo the desk thing.",
      origin: "workhorse",
      skillName: "desk",
    },
    { name: "gone", text: "" },
    { name: "front", text: "---\nname: front\n---\n" },
  ]);
  assert.deepEqual(settled.missing, ["gone", "front"]);
  assert.deepEqual(settled.loaded, [{ name: "workhorse:desk", body: "Do the desk thing." }]);
  assert.match(requiredSkillNotInstalled(["gone"]), /Required skill not installed: gone/);
  assert.match(requiredSkillNotInstalled(["gone", "front"]), /Required skills not installed: gone, front/);

  const store = read("src/lib/store.tsx");
  const start = store.indexOf("const loaded: Array<{ name: string; body: string }> = [];");
  const until = store.indexOf("reply = await promptVendor(", start);
  const slice = store.slice(start, until);
  assert.ok(start > 0 && until > start);
  assert.match(slice, /settleSpawnSkillReads/);
  assert.match(slice, /requiredSkillNotInstalled/);
  assert.match(slice, /return "";/);
});

test("custom history uses the real window and the estimate uses that slice", () => {
  assert.equal(customHistoryCharCap(undefined), CUSTOM_HISTORY_MAX_CHARS);
  assert.equal(customHistoryCharCap(0), CUSTOM_HISTORY_MAX_CHARS);
  const wideCap = customHistoryCharCap(200_000);
  const narrowCap = customHistoryCharCap(3_000);
  assert.ok(wideCap > CUSTOM_HISTORY_MAX_CHARS);
  assert.ok(narrowCap < CUSTOM_HISTORY_MAX_CHARS);
  assert.ok(wideCap / 4 < 200_000, "a reserve is left so the model can answer");
  assert.doesNotMatch(read("src/lib/custom-history.ts"), /128_?000|204_?800/);

  const long = Array.from({ length: 20 }, (_, index) => [
    msg("user", `q${index}-` + "q".repeat(2500)),
    msg("assistant", `a${index}-` + "a".repeat(2500)),
  ]).flat();
  const chars = (rows: { text: string }[]) => rows.reduce((sum, row) => sum + row.text.length, 0);
  const blind = customReplaySlice(long);
  const wide = customReplaySlice(long, 200_000);
  const narrow = customReplaySlice(long, 3_000);
  assert.ok(chars(wide) > chars(blind));
  assert.ok(chars(narrow) < chars(blind));
  assert.ok(chars(wide) <= wideCap);
  assert.ok(chars(narrow) <= narrowCap);

  const mixed = [
    msg("user", "keep"),
    msg("system", "tool ".repeat(4000), "tool"),
    msg("system", "thought ".repeat(4000), "thought"),
    msg("assistant", "answer"),
  ];
  const slice = customReplaySlice(mixed, 128_000);
  assert.deepEqual(slice, [
    { role: "user", text: "keep" },
    { role: "assistant", text: "answer" },
  ]);
  const estimate = estimateChatContext({
    contextUsed: 0,
    windowSize: 128_000,
    messages: slice.map((item) => ({ text: item.text })),
  });
  assert.equal(
    estimate.occupying.find((row) => row.id === "messages")?.tokens,
    Math.round(("keep".length + "answer".length) / 4),
  );

  const store = read("src/lib/store.tsx");
  const meter = read("src/ui/ContextMeter.tsx");
  assert.match(store, /history: customReplaySlice\(\s*session\.messages/);
  assert.match(store, /contextWindowFor\(\s*"custom"/);
  assert.match(meter, /session\.provider === "custom"/);
  assert.match(meter, /customReplaySlice\(session\.messages, windowSize\)/);
});

test("a probe omits a context window nobody published", async () => {
  const pong = () =>
    new Response(JSON.stringify({ id: "msg", content: [{ type: "text", text: "pong" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fromReply = await probeCustomHttp(
    { baseUrl: "https://example.invalid/v1", apiKey: "sk-test", model: "box-model" },
    async () =>
      new Response(JSON.stringify({ context_window: 32_000, content: [{ type: "text", text: "pong" }] }), {
        status: 200,
      }),
  );
  assert.equal(fromReply.contextWindow, 32_000);

  const fromList = await probeCustomHttp(
    { baseUrl: "https://example.invalid/v1", apiKey: "sk-test", model: "box-model" },
    async (url) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "box-model", context_length: 50_000 }] }), { status: 200 });
      }
      return pong();
    },
  );
  assert.equal(fromList.contextWindow, 50_000);

  assert.equal(knownContextWindow("MiniMax-M3"), 1_000_000);
  const omitted = await probeCustomHttp(
    { baseUrl: "https://api.minimax.io/anthropic", apiKey: "sk-test", model: "MiniMax-M3" },
    async (url) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "other", context_length: 50_000 }] }), { status: 200 });
      }
      return pong();
    },
  );
  assert.equal(omitted.ok, true);
  assert.equal("contextWindow" in omitted, false);
  assert.equal(omitted.contextWindow ?? 256_000, 256_000, "a hand-typed or catalog number stays put");

  const http = read("electron/custom-http.ts");
  const probeAt = http.indexOf("export async function probeCustomHttp");
  const probeFn = http.slice(probeAt, probeAt + 5000);
  assert.match(probeFn, /contextWindow \? \{ contextWindow \}/);
  assert.doesNotMatch(probeFn, /128_000/);
  assert.doesNotMatch(probeFn, /knownContextWindow\(/);
});

test("session setup paints no leftover percent when the meter is unknown", () => {
  assert.equal(setupPaintsTide("grok", undefined), false);
  assert.equal(setupPaintsTide("claude", undefined), false);
  assert.equal(setupPaintsTide("codex", undefined), false);
  assert.equal(setupPaintsTide("custom", undefined), false);
  assert.equal(setupPaintsTide("grok", { leftPercent: 12 }), true);
  assert.equal(setupPaintsTide("custom", { leftPercent: 80 }), true);
  assert.equal(setupPaintsTide("cursor", undefined), true, "Cursor keeps the budget fallback");
  assert.equal(setupPaintsTide("gemini", undefined), true);

  const setup = read("src/ui/SessionSetup.tsx");
  assert.match(setup, /setupPaintsTide/);
  assert.match(setup, /vendorTidePercent/);
  assert.match(setup, /cursorWatchLane\(session\.model\)/);
  assert.match(setup, /cursor: cursorPlan/);
  assert.match(setup, /tide-unknown/);
  assert.match(read("src/styles/chat.3.css"), /\.session-setup\.tide-unknown \.setup-tide/);
  const pane = read("src/ui/UsagePane.tsx");
  assert.match(pane, /unknown=\{missing\?\.unknown\}/);
  assert.match(pane, /unknown=\{missingPlan\?\.unknown\}/);
});

test("skill homes follow GROK_HOME, CODEX_HOME, and Claude config, else the home directory", () => {
  const home = path.join(os.tmpdir(), "wh-repair-skill-homes");
  const project = path.join(home, "repo");
  const grokHome = path.join(home, "grok-override");
  const codexHome = path.join(home, "codex-override");
  const claudeHome = path.join(home, "claude-override");
  const claudeOther = path.join(home, "claude-home");
  const homes = skillHomes({
    homedir: home,
    projectFolders: [project],
    env: {
      GROK_HOME: grokHome + path.sep,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      CLAUDE_HOME: claudeOther,
    },
  });
  assert.ok(homes.some((item) => item.origin === "grok" && item.root === path.join(grokHome, "skills")));
  assert.ok(homes.some((item) => item.origin === "grok" && item.root === path.join(grokHome, "bundled", "skills")));
  assert.ok(homes.some((item) => item.origin === "grok" && item.source === "plugin" && item.root === path.join(grokHome, "plugins")));
  assert.ok(homes.some((item) => item.origin === "codex" && item.root === path.join(codexHome, "skills")));
  assert.ok(homes.some((item) => item.origin === "codex" && item.source === "plugin" && item.root === path.join(codexHome, "plugins")));
  assert.ok(homes.some((item) => item.origin === "claude" && item.root === path.join(claudeHome, "skills")));
  assert.equal(
    homes.some((item) => item.origin === "claude" && item.root === path.join(claudeOther, "skills")),
    false,
  );
  assert.ok(homes.some((item) => item.origin === "cursor" && item.root === path.join(home, ".cursor", "skills")));
  assert.ok(homes.some((item) => item.origin === "grok" && item.root === path.join(project, ".grok", "skills")));

  const claudeFallback = skillHomes({
    homedir: home,
    env: { CLAUDE_HOME: claudeOther },
  });
  assert.ok(claudeFallback.some((item) => item.origin === "claude" && item.root === path.join(claudeOther, "skills")));

  const plain = skillHomes({ homedir: home, env: {} });
  assert.ok(plain.some((item) => item.origin === "grok" && item.root === path.join(home, ".grok", "skills")));
  assert.ok(plain.some((item) => item.origin === "codex" && item.root === path.join(home, ".codex", "skills")));
  assert.ok(plain.some((item) => item.origin === "claude" && item.root === path.join(home, ".claude", "skills")));
});

test("OpenClaw MiniMax uses the seed window and omits a window with no seed", () => {
  const parsed = parseOpenClawMinimax({
    models: {
      providers: {
        minimax: {
          apiKey: "sk-test",
          baseUrl: "https://api.minimax.io/anthropic",
          models: [
            { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
            { id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 32_000 },
            { id: "private-minimax", name: "Private" },
          ],
        },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed?.models.find((model) => model.id === "MiniMax-M2.7")?.contextWindow, 204_800);
  assert.equal(parsed?.models.find((model) => model.id === "MiniMax-M3")?.contextWindow, 32_000);
  const unknown = parsed?.models.find((model) => model.id === "private-minimax");
  assert.equal(unknown === undefined || "contextWindow" in unknown, false);
  assert.notEqual(unknown?.contextWindow, 204_800);

  const onlyUnknown = parseOpenClawMinimax({
    models: {
      providers: {
        minimax: {
          apiKey: "sk-test",
          baseUrl: "https://api.minimax.io/anthropic",
          models: [{ id: "private-minimax", name: "Private" }],
        },
      },
    },
  });
  assert.equal("contextWindow" in (onlyUnknown?.config ?? {}), false);
  assert.notEqual(onlyUnknown?.config.contextWindow, 204_800);

  const login = read("electron/custom-login.ts");
  const fn = login.slice(login.indexOf("export function parseOpenClawMinimax"), login.indexOf("export function detectCustomLogin"));
  assert.doesNotMatch(fn, /: 204_800/);
  assert.match(fn, /minimaxSeedWindow/);
});
