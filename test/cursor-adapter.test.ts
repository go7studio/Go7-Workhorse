import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import { capabilitiesFor } from "../src/lib/provider-capabilities";
import { usageProviderForSession, leftoverForCard, byProvider, cursorLaneEvents } from "../src/lib/usage";
import { cursorUsageLane, cursorWatchLane, isCursorInnerTask } from "../src/lib/cursor-lane";
import { asProviderId, normalizeSession } from "../src/lib/session";
import { isVendorFailureReply, vendorSendTarget, vendorFailedMessage, previewOnlyReply } from "../src/lib/vendor-bridge";
import { resetCursorBases } from "../src/lib/cursor-catalog";
import { applyVendorCatalog, defaultModel, modelName, modelsFor, resetVendorCatalog } from "../src/lib/models";
import { commandsForSession, vendorSkillOrigin } from "../src/lib/commands";
import { catalogSkills, skillHomes } from "../src/lib/skills-catalog";
import { parseProviderId, resolveSpawnSpec, toolsForDeskRole, admitSpawn } from "../src/lib/subagents";
import { evaluateWatchHold, leftoverPercentForKey, deskCallCatalog } from "../src/lib/watch";
import { normalizeSettings } from "../src/lib/settings";
import { buildCursorLaunchSpec, cursorSpawnArgs, resolveCursorModel } from "../electron/cursor-launch";
import { withDeskToolEnv } from "../electron/desk-path";
import { cursorAboutLoggedIn, detectCursorLogin, resolveCursorBinary, resolveCursorPrefixArgs } from "../electron/cursor-login";
import { cursorModelsCommand } from "../electron/vendor-models";
import { CursorSessionHost, spawnCursorProcess } from "../electron/cursor-host";
import {
  cursorStateDatabasePath,
  fetchCursorPlanUsage,
  parseCursorPlanUsage,
  readCursorAuthToken,
} from "../electron/cursor-plan";
import { cursorExtensionResult, extractToolEvent } from "../electron/grok-agent";
import { CURSOR_SESSION_RULES, WORKHORSE_SESSION_RULES } from "../src/lib/workhorse-rules";
import { buildSessionPreface } from "../src/lib/context-preface";
import { normalizeRoutingDecision } from "../src/lib/routing";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeAcp(script: {
  methods: string[];
  loadFail?: boolean;
  nextId?: string;
  askPermission?: boolean;
  configOptions?: unknown[];
  configs?: Array<{ configId?: string; value?: string }>;
}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill() {
      child.emit("exit", 0, null);
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  let buffer = "";
  let created = 0;
  stdin.on("data", (chunk: Buffer | string) => {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: { sessionId?: string; configId?: string; value?: string };
      };
      if (message.id === undefined) continue;
      script.methods.push(message.method ?? "");
      if (message.method === "session/set_config_option") {
        script.configs?.push({ configId: message.params?.configId, value: message.params?.value });
      }
      if (message.method === "initialize") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
        continue;
      }
      if (message.method === "session/load") {
        if (script.loadFail) {
          stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "unknown session" } })}\n`);
          continue;
        }
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: message.params?.sessionId } })}\n`,
        );
        continue;
      }
      if (message.method === "session/new") {
        created += 1;
        const sessionId = script.nextId ?? `new-${created}`;
        const result: Record<string, unknown> = { sessionId };
        if (script.configOptions) result.configOptions = script.configOptions;
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        continue;
      }
      if (message.method === "session/prompt") {
        if (script.askPermission) {
          stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 9000,
              method: "session/request_permission",
              params: { toolCall: { title: "Read", rawInput: { path: "/tmp/x" } }, options: [{ optionId: "allow-once" }] },
            })}\n`,
          );
        }
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })}\n`);
        continue;
      }
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
    }
  });
  return child;
}

test("cursorUsageLane table", () => {
  assert.equal(cursorUsageLane("composer-2.5"), "cursor-models");
  assert.equal(cursorUsageLane("composer-2.5-fast"), "cursor-models");
  assert.equal(cursorUsageLane("composer"), "cursor-models");
  assert.equal(cursorUsageLane("grok-4.6"), "cursor-models");
  assert.equal(cursorUsageLane("grok-4.5-fast"), "cursor-models");
  assert.equal(cursorUsageLane("claude-4-sonnet"), "other-models");
  assert.equal(cursorUsageLane("gpt-5.4"), "other-models");
  assert.equal(cursorUsageLane("gemini-3-pro"), "other-models");
  assert.equal(cursorUsageLane("auto-smart", { optimize_for: "cost" }), "auto-cost");
  assert.equal(cursorUsageLane("auto-smart", { optimize_for: "balanced" }), "auto-routed");
  assert.equal(cursorUsageLane("auto-smart", { optimize_for: "intelligence" }), "auto-routed");
  assert.equal(cursorUsageLane(""), "unknown");
  assert.equal(cursorUsageLane(undefined), "unknown");
  assert.equal(cursorWatchLane("composer-2.5"), "cursor:cursor-models");
  assert.equal(cursorWatchLane("claude-opus"), "cursor:other-models");
});

test("cursor is its own provider identity, not grok", () => {
  assert.equal(vendorSendTarget("cursor"), "cursor");
  assert.notEqual(vendorSendTarget("cursor"), "grok");
  assert.notEqual(vendorSendTarget("cursor"), "preview");
  assert.equal(asProviderId("cursor"), "cursor");
  assert.equal(usageProviderForSession({ provider: "cursor" }), "cursor");
  assert.equal(capabilitiesFor("cursor").transport, "acp");
  assert.notEqual(capabilitiesFor("cursor").conversation.rewind, capabilitiesFor("grok").conversation.rewind);
  assert.equal(capabilitiesFor("mystery").transport, "acp");
  assert.equal(capabilitiesFor("mystery"), capabilitiesFor("grok"));
  const events = [
    { id: "1", at: 1, provider: "cursor" as const, model: "composer-2.5", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, lane: "cursor-models" as const },
    { id: "2", at: 2, provider: "grok" as const, model: "grok-4.6", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];
  const groups = byProvider(events);
  assert.equal(groups.find((item) => item.provider === "cursor")?.inputTokens, 10);
  assert.equal(groups.find((item) => item.provider === "grok")?.inputTokens, 5);
  assert.equal(cursorLaneEvents(events, "cursor:cursor-models").length, 1);
});

test("vendorFailedMessage prefixes Cursor, never Preview only", () => {
  assert.match(vendorFailedMessage("cursor", "no binary"), /^Cursor agent failed:/);
  assert.doesNotMatch(vendorFailedMessage("cursor", "no binary"), /Preview only/);
  assert.match(previewOnlyReply("Cursor", "Demo", [], "hi"), /Preview only/);
  const rejected = vendorFailedMessage(
    "cursor",
    "Cursor agent exited (1): Cannot use this model: cursor-grok-4.6-medium. Available models: auto, composer-2.5, hundreds-more",
  );
  assert.equal(rejected, "Cursor cannot use “cursor-grok-4.6-medium”. Choose another model.");
  assert.doesNotMatch(rejected, /Available models|hundreds-more/);
  assert.equal(isVendorFailureReply(rejected), true);
  assert.equal(isVendorFailureReply("Cursor agent failed: connection closed"), true);
  assert.equal(isVendorFailureReply("Cursor inspected the failure and fixed it."), false);
});

test("buildCursorLaunchSpec never spawns grok or Cursor.app", () => {
  resetCursorBases();
  assert.equal(resolveCursorModel("cursor-grok-4.6", "medium"), "cursor-grok-4.6-high");
  const spec = buildCursorLaunchSpec({
    model: "composer-2.5",
    effort: "medium",
    cwd: "/proj",
    mode: "ask",
    mcpServers: [{ name: "figma", command: "figma-mcp", args: [] }],
    detect: {
      env: { CURSOR_ACP_BIN: "/opt/cursor-agent" },
      existsSync: (file) => file === "/opt/cursor-agent",
      pathDirs: [],
      homedir: "/no-home",
      platform: "linux",
    },
  });
  assert.equal(spec.command, "/opt/cursor-agent");
  assert.deepEqual(spec.argv, ["--model", "composer-2.5", "acp"]);
  assert.equal(spec.cwd, "/proj");
  assert.equal(spec.model, "composer-2.5");
  assert.equal(spec.sessionParams._meta?.rules, CURSOR_SESSION_RULES);
  assert.notEqual(spec.sessionParams._meta?.rules, WORKHORSE_SESSION_RULES);
  assert.match(spec.sessionParams._meta?.rules ?? "", /You are the Cursor Agent/);
  assert.match(spec.sessionParams._meta?.rules ?? "", /Grok, Claude, Codex, and Cursor/);
  assert.doesNotMatch(spec.sessionParams._meta?.rules ?? "", /Grok Build/);
  assert.doesNotMatch(spec.sessionParams._meta?.rules ?? "", /\/goal is Grok/);
  assert.doesNotMatch(spec.sessionParams._meta?.rules ?? "", /Run Grok/);
  assert.doesNotMatch(spec.sessionParams._meta?.rules ?? "", /update_goal/);
  assert.doesNotMatch(spec.sessionParams._meta?.rules ?? "", /shipped vendors are Grok, Codex, and Claude, plus/);
  const other = buildCursorLaunchSpec({
    model: "claude-4-sonnet",
    effort: "high",
    cwd: "/proj",
    mode: "ask",
    detect: {
      env: { CURSOR_ACP_BIN: "/opt/cursor-agent" },
      existsSync: (file) => file === "/opt/cursor-agent",
      pathDirs: [],
      homedir: "/no-home",
      platform: "linux",
    },
  });
  assert.deepEqual(other.argv, ["--model", "claude-4-sonnet", "acp"]);
  assert.deepEqual(cursorSpawnArgs(other).args, ["--model", "claude-4-sonnet", "acp"]);
  // Cursor was the only vendor spawned with the raw process environment, so a
  // Finder-launched app left its tools unable to find git, node or ripgrep.
  assert.equal(cursorSpawnArgs(other).env.PATH, withDeskToolEnv({ ...process.env }).PATH);
  assert.ok(spec.sessionParams.mcpServers.some((item) => item.name === "figma"));
  assert.notEqual(spec.command.toLowerCase(), "grok");
  assert.doesNotMatch(spec.command, /Cursor\.app/i);
  const legacyAuto = buildCursorLaunchSpec({
    ...spec,
    mode: "ask",
    model: "auto-smart",
    detect: {
      env: { CURSOR_ACP_BIN: "/opt/cursor-agent" },
      existsSync: (file) => file === "/opt/cursor-agent",
      pathDirs: [],
      homedir: "/no-home",
      platform: "linux",
    },
  });
  assert.equal(legacyAuto.model, "auto");
  assert.deepEqual(legacyAuto.argv, ["--model", "auto", "acp"]);
  assert.throws(
    () =>
      spawnCursorProcess({
        ...spec,
        command: "grok",
        argv: ["acp"],
      }),
    /grok/i,
  );
  assert.throws(
    () =>
      spawnCursorProcess({
        ...spec,
        command: "/Applications/Cursor.app",
        argv: ["acp"],
      }),
    /Cursor\.app/i,
  );
  assert.throws(
    () =>
      spawnCursorProcess({
        ...spec,
        command: "",
        argv: ["acp"],
      }),
    /not installed/i,
  );
});

test("cursorAboutLoggedIn reads the official about table", () => {
  assert.equal(cursorAboutLoggedIn("User Email          Not logged in"), false);
  assert.equal(cursorAboutLoggedIn("User Email          someone@example.test\nSubscription Tier   Ultra"), true);
  assert.equal(cursorAboutLoggedIn("CLI Version         2026.08.11-e8db854"), undefined);
});

test("detectCursorLogin requires binary plus login, not Cursor.app", () => {
  const missing = detectCursorLogin({
    env: {},
    homedir: "/no-home",
    platform: "linux",
    existsSync: () => false,
    pathDirs: [],
  });
  assert.equal(missing.connected, false);
  assert.equal(missing.binary, null);

  const appOnly = detectCursorLogin({
    env: {},
    homedir: "/no-home",
    platform: "linux",
    existsSync: (file) => file === "/Applications/Cursor.app",
    pathDirs: [],
  });
  assert.equal(appOnly.connected, false);

  const binaryNoAuth = detectCursorLogin({
    env: { CURSOR_ACP_BIN: "/opt/agent" },
    homedir: "/no-home",
    platform: "linux",
    existsSync: (file) => file === "/opt/agent",
    pathDirs: [],
  });
  assert.equal(binaryNoAuth.connected, false);
  assert.equal(binaryNoAuth.needsAuth, true);
  assert.equal(binaryNoAuth.binary, "/opt/agent");

  const withKey = detectCursorLogin({
    env: { CURSOR_ACP_BIN: "/opt/agent", CURSOR_API_KEY: "ck-test" },
    homedir: "/no-home",
    platform: "linux",
    existsSync: (file) => file === "/opt/agent",
    pathDirs: [],
  });
  assert.equal(withKey.connected, true);
});

test("Cursor discovery finds the official Windows CLI folder, never Cursor.exe", () => {
  const local = "C:\\Users\\desk\\AppData\\Local";
  const node = `${local}\\cursor-agent\\versions\\2026.08.11-e8db854\\node.exe`;
  const script = `${local}\\cursor-agent\\versions\\2026.08.11-e8db854\\index.js`;
  const ide = `${local}\\Programs\\cursor\\Cursor.exe`;
  const files = new Set([node, script, ide]);
  const detect = {
    env: { LOCALAPPDATA: local },
    platform: "win32" as const,
    homedir: "C:\\Users\\desk",
    pathDirs: [] as string[],
    existsSync: (file: string) => files.has(file),
    readdir: (dir: string) =>
      dir === `${local}\\cursor-agent\\versions` ? ["2026.08.11-e8db854"] : [],
  };
  assert.equal(resolveCursorBinary(detect), node);
  const spec = buildCursorLaunchSpec({
    model: "composer-2.5",
    effort: "medium",
    cwd: "C:\\proj",
    mode: "ask",
    detect: { ...detect, probeAuth: () => true },
  });
  assert.equal(spec.command, node);
  assert.deepEqual(spec.argv, [script, "--model", "composer-2.5", "acp"]);
  assert.equal(
    resolveCursorBinary({
      env: { LOCALAPPDATA: local },
      platform: "win32",
      homedir: "C:\\Users\\desk",
      pathDirs: [],
      existsSync: (file) => file === ide,
    }),
    null,
  );
});

test("reading the Cursor model list spawns the same node+script a launch does", () => {
  const local = "C:\\Users\\desk\\AppData\\Local";
  const node = `${local}\\cursor-agent\\versions\\2026.08.11-e8db854\\node.exe`;
  const script = `${local}\\cursor-agent\\versions\\2026.08.11-e8db854\\index.js`;
  const files = new Set([node, script]);
  const detect = {
    env: { LOCALAPPDATA: local },
    platform: "win32" as const,
    homedir: "C:\\Users\\desk",
    pathDirs: [] as string[],
    existsSync: (file: string) => files.has(file),
    readdir: (dir: string) =>
      dir === `${local}\\cursor-agent\\versions` ? ["2026.08.11-e8db854"] : [],
  };
  // `cursor-agent models` is the only source of real launch slugs. On Windows
  // the CLI is node.exe plus an index.js, so a reader that takes the binary
  // and drops the script runs `node models`, exits non-zero, and leaves the
  // desk on the stock four rows with no effort variants for the whole session.
  assert.equal(resolveCursorBinary(detect), node);
  assert.deepEqual(resolveCursorPrefixArgs(detect), [script]);
  assert.deepEqual(cursorModelsCommand(detect), { command: node, args: [script, "models"] });
  // The launch and the model-list read must agree on the whole command, or
  // the picker and the launcher disagree about which slugs exist.
  const spec = buildCursorLaunchSpec({
    model: "composer-2.5",
    effort: "medium",
    cwd: "C:\\proj",
    mode: "ask",
    detect: { ...detect, probeAuth: () => true },
  });
  assert.equal(cursorModelsCommand(detect)?.command, spec.command);
  assert.equal(cursorModelsCommand(detect)?.args[0], spec.argv[0]);
});

test("Cursor discovery prefers cursor-agent and rejects an unrelated agent binary", () => {
  const files = new Set(["/bin/agent", "/bin/cursor-agent"]);
  assert.equal(
    resolveCursorBinary({
      env: { PATH: "/bin" },
      platform: "linux",
      homedir: "/no-home",
      pathDirs: ["/bin"],
      existsSync: (file) => files.has(file),
    }),
    "/bin/cursor-agent",
  );
  assert.equal(
    resolveCursorBinary({
      env: { PATH: "/bin" },
      platform: "linux",
      homedir: "/no-home",
      pathDirs: ["/bin"],
      existsSync: (file) => file === "/bin/agent",
      probeBinary: () => false,
    }),
    null,
  );
  // Windows discovery is a different path: cursor-agent.exe under a win32 join.
  // Proving it here beats only proving the POSIX case does not break.
  const winBin = path.win32.join("C:\\bin", "cursor-agent.exe");
  const winFiles = new Set([path.win32.join("C:\\bin", "agent.exe"), winBin]);
  assert.equal(
    resolveCursorBinary({
      platform: "win32",
      env: { PATH: "C:\\bin" },
      homedir: "C:\\no-home",
      pathDirs: ["C:\\bin"],
      existsSync: (file) => winFiles.has(file),
    }),
    winBin,
  );
  assert.equal(
    resolveCursorBinary({
      platform: "win32",
      env: { PATH: "C:\\bin" },
      homedir: "C:\\no-home",
      pathDirs: ["C:\\bin"],
      existsSync: (file) => file === path.win32.join("C:\\bin", "agent.exe"),
      probeBinary: () => false,
    }),
    null,
  );
});

test("Cursor auth probe overrides a stale config artifact", () => {
  const detected = detectCursorLogin({
    env: { CURSOR_ACP_BIN: "/opt/cursor-agent" },
    homedir: "/no-home",
    platform: "linux",
    existsSync: (file) => file === "/opt/cursor-agent" || file === "/no-home/.cursor/cli-config.json",
    pathDirs: [],
    probeAuth: () => false,
  });
  assert.equal(detected.connected, false);
  assert.equal(detected.needsAuth, true);
});

test("CursorSessionHost new/load/launch-key", async () => {
  const methods: string[] = [];
  const host = new CursorSessionHost(() => fakeAcp({ methods, nextId: "cur-new" }));
  const opened: string[] = [];
  const result = await host.prompt(
    {
      sessionId: "work-u1",
      text: "hello",
      model: "composer-2.5",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
    },
    (event) => {
      if (event.type === "vendor-session") opened.push(event.opened);
    },
  );
  host.disposeAll();
  assert.deepEqual(methods, ["initialize", "session/new", "session/set_config_option", "session/prompt"]);
  assert.equal(result.vendorSessionId, "cur-new");
  assert.deepEqual(opened, ["session/new"]);

  const loaded: string[] = [];
  const loadHost = new CursorSessionHost(() => fakeAcp({ methods: loaded }));
  await loadHost.prompt(
    {
      sessionId: "work-u2",
      text: "again",
      model: "composer-2.5",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "saved-u",
    },
    () => undefined,
  );
  loadHost.dispose("work-u2");
  const after: string[] = [];
  await loadHost.prompt(
    {
      sessionId: "work-u2",
      text: "resume",
      model: "composer-2.5",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "saved-u",
    },
    () => undefined,
  );
  loadHost.disposeAll();
  assert.ok(after.concat(loaded).includes("session/load") || loaded.includes("session/load"));

  const keys: string[] = [];
  const keyHost = new CursorSessionHost(() => fakeAcp({ methods: keys, nextId: "second-u" }));
  await keyHost.prompt(
    { sessionId: "work-u3", text: "a", model: "composer-2.5", effort: "medium", mode: "ask", cwd: ROOT },
    () => undefined,
  );
  await keyHost.prompt(
    { sessionId: "work-u3", text: "b", model: "claude-4-sonnet", effort: "high", mode: "ask", cwd: ROOT },
    () => undefined,
  );
  keyHost.disposeAll();
  assert.equal(keys.filter((item) => item === "session/new").length, 2);
});

test("CursorSessionHost recreates a runtime whose stdin died between turns", async () => {
  const methods: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const host = new CursorSessionHost(() => {
    const child = fakeAcp({ methods, nextId: "cursor-recovered" });
    children.push(child);
    return child;
  });
  const input = {
    sessionId: "work-restart",
    text: "before update",
    model: "composer-2.5",
    effort: "medium" as const,
    mode: "ask" as const,
    cwd: ROOT,
  };
  const first = await host.prompt(input, () => undefined);
  assert.equal(first.vendorSessionId, "cursor-recovered");
  children[0]!.emit("exit", 1, null);

  const second = await host.prompt(
    { ...input, text: "after update", vendorSessionId: first.vendorSessionId },
    () => undefined,
  );
  host.disposeAll();

  assert.equal(children.length, 2);
  assert.equal(methods.filter((method) => method === "initialize").length, 2);
  assert.equal(methods.filter((method) => method === "session/load").length, 1);
  assert.equal(second.opened, "session/load");
});

test("session/request_permission is tagged cursor by the store path", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /owner\?\.provider === "cursor"/);
  assert.match(store, /cursorAnswerPermission/);
  assert.match(store, /cursorPrompt/);
  assert.doesNotMatch(store.slice(store.indexOf('live === "cursor"'), store.indexOf('live === "cursor"') + 800), /Preview only/);
});

test("Watch holds per Cursor lane", () => {
  const settings = normalizeSettings({
    llms: { cursor: { connected: true } },
    watch: { lockDaily: true },
  });
  const plans = {
    cursor: {
      usedPercent: 50,
      leftPercent: 50,
      period: "monthly" as const,
      prepaidBalance: 0,
      products: [
        { product: "cursor-models", label: "Cursor Models", usagePercent: 10 },
        { product: "other-models", label: "Other Models", usagePercent: 100 },
      ],
    },
  };
  const composer = evaluateWatchHold({
    session: { provider: "cursor", model: "composer-2.5" },
    settings,
    plans,
    permits: {},
    now: Date.parse("2026-08-17T12:00:00"),
  });
  assert.equal(composer, null);

  const composerSpent = evaluateWatchHold({
    session: { provider: "cursor", model: "composer-2.5" },
    settings,
    plans: {
      cursor: {
        ...plans.cursor,
        products: [
          { product: "cursor-models", label: "Cursor Models", usagePercent: 100 },
          { product: "other-models", label: "Other Models", usagePercent: 10 },
        ],
      },
    },
    permits: {},
    now: Date.parse("2026-08-17T12:00:00"),
  });
  assert.equal(composerSpent?.reason, "spent");

  const otherSpent = evaluateWatchHold({
    session: { provider: "cursor", model: "claude-4-sonnet" },
    settings,
    plans,
    permits: {},
    now: Date.parse("2026-08-17T12:00:00"),
  });
  assert.equal(otherSpent?.reason, "spent");

  assert.equal(leftoverPercentForKey("cursor:cursor-models", {}, settings), undefined);
  const unknownPlan = leftoverForCard({ focus: "cursor:cursor-models", provider: "cursor", key: "cursor:cursor-models" }, {});
  assert.equal(unknownPlan, undefined);

  const rows = deskCallCatalog({
    settings: { ...settings, usageBudgets: {} },
    usage: [],
    plans,
    permits: {},
  });
  const names = rows.filter((row) => row.provider === "cursor").map((row) => row.name);
  assert.ok(names.includes("Cursor · Composer"));
  assert.ok(names.includes("Cursor · API"));
  assert.notEqual(rows.find((row) => row.id === "cursor:cursor-models")?.leftoverPercent, rows.find((row) => row.id === "cursor:other-models")?.leftoverPercent);
});

test("parseCursorPlanUsage official shape; missing is unknown", () => {
  const parsed = parseCursorPlanUsage({
    resetsAt: "2026-09-01T00:00:00.000Z",
    cursorModels: { usagePercent: 12 },
    otherModels: { usagePercent: 40 },
    onDemandUsd: 3.2,
  });
  assert.ok(parsed);
  assert.equal(parsed?.period, "monthly");
  assert.equal(parsed?.products.find((item) => item.product === "cursor-models")?.usagePercent, 12);
  assert.equal(parsed?.products.find((item) => item.product === "other-models")?.usagePercent, 40);
  assert.equal(parseCursorPlanUsage({ hello: true }), undefined);
  assert.equal(parseCursorPlanUsage(null), undefined);
});

test("parseCursorPlanUsage reads dashboard planUsage percents", () => {
  const parsed = parseCursorPlanUsage({
    billingCycleEnd: "1789241010000",
    planUsage: { autoPercentUsed: 18.4165, apiPercentUsed: 46.312 },
  });
  assert.equal(Math.round(parsed?.products.find((item) => item.product === "cursor-models")?.usagePercent ?? 0), 18);
  assert.equal(Math.round(parsed?.products.find((item) => item.product === "other-models")?.usagePercent ?? 0), 46);
  assert.equal(parsed?.resetsAt, new Date(1789241010000).toISOString());
});

test("readCursorAuthToken prefers env then injected Cursor state db", () => {
  assert.equal(readCursorAuthToken({ env: { CURSOR_API_KEY: "ck-test" } }), "ck-test");
  const mac = cursorStateDatabasePath({ homedir: "/tmp/wh-mac", platform: "darwin" });
  assert.equal(mac.replace(/\\/g, "/"), "/tmp/wh-mac/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  const win = cursorStateDatabasePath({
    homedir: "C:\\Users\\x",
    env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
    platform: "win32",
  });
  assert.match(win.replace(/\\/g, "/"), /AppData\/Roaming\/Cursor\/User\/globalStorage\/state\.vscdb$/);
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-cursor-state-"));
  const dbPath = cursorStateDatabasePath({ homedir: dir, env: {}, platform: "darwin" });
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursorAuth/accessToken", "jwt-from-state");
  db.close();
  assert.equal(
    readCursorAuthToken({ homedir: dir, env: {}, platform: "darwin", readFile: () => { throw new Error("no json"); } }),
    "jwt-from-state",
  );
});

test("fetchCursorPlanUsage reads official JSON when a token is present", async () => {
  const plan = await fetchCursorPlanUsage({
    token: "ck-test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          cursorModels: { usagePercent: 12 },
          otherModels: { usagePercent: 40 },
        }),
        { status: 200 },
      ),
  });
  assert.equal(plan?.products.find((item) => item.product === "cursor-models")?.usagePercent, 12);
  assert.equal(plan?.products.find((item) => item.product === "other-models")?.usagePercent, 40);
  const missing = await fetchCursorPlanUsage({
    readOfficial: async () => undefined,
  });
  assert.equal(missing, undefined);
});

test("fetchCursorPlanUsage posts GetCurrentPeriodUsage", async () => {
  const urls: string[] = [];
  const methods: string[] = [];
  const plan = await fetchCursorPlanUsage({
    token: "jwt",
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      methods.push(String(init?.method ?? "GET"));
      return new Response(
        JSON.stringify({
          billingCycleEnd: "1789241010000",
          planUsage: { autoPercentUsed: 18.4, apiPercentUsed: 46.3 },
        }),
        { status: 200 },
      );
    },
  });
  assert.match(urls[0] ?? "", /GetCurrentPeriodUsage/);
  assert.equal(methods[0], "POST");
  assert.equal(Math.round(plan?.products.find((item) => item.product === "cursor-models")?.usagePercent ?? 0), 18);
  assert.equal(Math.round(plan?.products.find((item) => item.product === "other-models")?.usagePercent ?? 0), 46);
});

test("desk spawn defaults to Composer 2.5; inner task is not a worker", () => {
  assert.equal(parseProviderId("cursor"), "cursor");
  assert.equal(defaultModel("cursor").id, "composer-2.5");
  assert.equal(resolveCursorModel(""), "composer-2.5");
  const spec = resolveSpawnSpec({ fromSessionId: "p", prompt: "review src", provider: "cursor" }, [], { provider: "grok", model: "grok-4.6", effort: "medium" });
  assert.equal(spec.provider, "cursor");
  assert.equal(spec.model, "composer-2.5");
  const tools = toolsForDeskRole(
    [{ name: "workhorse_list_bots" }, { name: "read_file" }, { name: "cursor/task" }],
    "worker",
  );
  assert.deepEqual(
    tools.map((item) => item.name),
    ["read_file", "cursor/task"],
  );
  assert.equal(admitSpawn({ parent: { parentId: "x", hidden: true }, prompt: "do the slice", folder: "/proj" }).ok, false);
  assert.equal(admitSpawn({ parent: { parentId: "x" }, prompt: "do the slice", folder: "/proj" }).ok, true);
  assert.equal(isCursorInnerTask({ method: "cursor/task" }), true);
  const tool = extractToolEvent({ sessionUpdate: "cursor/task", title: "Cursor task", toolCallId: "t1" });
  assert.ok(tool);
  assert.match(tool?.title ?? "", /task/i);
  assert.equal(cursorExtensionResult("cursor/ask_question")?.outcome.outcome, "skipped");
  assert.equal(cursorExtensionResult("cursor/create_plan")?.outcome.outcome, "rejected");
});

test("Cursor applySessionConfig sets configId model", async () => {
  const methods: string[] = [];
  const configs: Array<{ configId?: string; value?: string }> = [];
  const host = new CursorSessionHost(() =>
    fakeAcp({
      methods,
      configs,
      nextId: "cfg-1",
      configOptions: [
        {
          id: "model",
          currentValue: "auto",
          options: [{ value: "composer-2.5" }, { value: "claude-4-sonnet" }],
        },
      ],
    }),
  );
  await host.prompt(
    {
      sessionId: "work-cfg",
      text: "hello",
      model: "claude-4-sonnet",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
    },
    () => undefined,
  );
  host.disposeAll();
  assert.ok(methods.includes("session/set_config_option"));
  assert.ok(configs.some((item) => item.configId === "model" && item.value === "claude-4-sonnet"));
});

test("Cursor session rules and routing hydrate do not treat Cursor as Grok", () => {
  assert.match(CURSOR_SESSION_RULES, /You are the Cursor Agent/);
  assert.match(CURSOR_SESSION_RULES, /Grok, Claude, Codex, and Cursor/);
  assert.doesNotMatch(CURSOR_SESSION_RULES, /Grok Build/);
  assert.doesNotMatch(CURSOR_SESSION_RULES, /Run Grok/);
  assert.doesNotMatch(CURSOR_SESSION_RULES, /\/goal is Grok/);
  assert.doesNotMatch(CURSOR_SESSION_RULES, /update_goal/);
  const preface = buildSessionPreface({ cwd: "/proj", folders: [], references: [], surface: "cursor" });
  assert.match(preface, /You are the Cursor Agent/);
  assert.doesNotMatch(preface, /Grok Build/);
  const kept = normalizeRoutingDecision({
    provider: "cursor",
    model: "composer-2.5",
    taskTier: "balanced",
    score: 4,
    reason: "Balanced",
    at: 1,
  });
  assert.equal(kept?.provider, "cursor");
  assert.equal(kept?.model, "composer-2.5");
  assert.equal(normalizeRoutingDecision({ provider: "mystery", model: "x" }), undefined);
  const persisted = normalizeSession({
    id: "cursor-old",
    provider: "cursor",
    vendorProvider: "cursor",
    model: "auto-smart",
    messages: [{ id: "m1", role: "assistant", text: "ok", provider: "cursor", model: "auto-smart" }],
  });
  assert.equal(persisted?.provider, "cursor");
  assert.equal(persisted?.vendorProvider, "cursor");
  assert.equal(persisted?.model, "auto");
  assert.equal(persisted?.messages[0]?.provider, "cursor");
  assert.equal(persisted?.messages[0]?.model, "auto");
});

test("store and main wire a live cursor path", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(store, /live === "cursor"/);
  assert.match(store, /session.provider === "cursor" \? "cursor"/);
  assert.match(store, /cursorPrompt/);
  assert.doesNotMatch(store, /live === "cursor"[\s\S]{0,200}Preview only/);
  assert.match(main, /new CursorSessionHost/);
  assert.match(main, /ipcMain\.handle\("cursor:prompt"/);
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  assert.match(preload, /cursor:prompt/);
  if (existsSync(path.join(ROOT, "docs", "GOAL-cursor.md"))) {
    assert.match(readFileSync(path.join(ROOT, "docs", "GOAL-cursor.md"), "utf8"), /Cursor Agent/);
  }
});

function writeCursorSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

test("Cursor chats catalog and slash Cursor-origin skills from disk homes", () => {
  assert.equal(vendorSkillOrigin("cursor"), "cursor");
  assert.notEqual(vendorSkillOrigin("cursor"), undefined);
  const home = mkdtempSync(path.join(os.tmpdir(), "wh-cursor-skills-"));
  const project = path.join(home, "repo");
  writeCursorSkill(path.join(home, ".cursor", "skills", "review-pr"), "review-pr", "Review pull requests");
  writeCursorSkill(path.join(project, ".cursor", "skills", "ship-app"), "ship-app", "Ship the app");
  writeCursorSkill(path.join(project, ".agents", "skills", "agents-note"), "agents-note", "Shared agent skill");
  const homes = skillHomes({ homedir: home, projectFolders: [project] });
  assert.equal(
    homes.some((item) => item.origin === "cursor" && item.root.replaceAll("\\", "/").endsWith("/.cursor/skills")),
    true,
  );
  assert.equal(
    homes.some((item) => item.origin === "cursor" && item.root.replaceAll("\\", "/").endsWith("/repo/.cursor/skills")),
    true,
  );
  const rows = catalogSkills({ homedir: home, projectFolders: [project] });
  const cursorRows = rows.filter((skill) => skill.origin === "cursor");
  assert.ok(cursorRows.some((skill) => skill.name === "review-pr"));
  assert.ok(cursorRows.some((skill) => skill.name === "ship-app"));
  assert.ok(cursorRows.some((skill) => skill.name === "agents-note"));
  assert.equal(
    cursorRows.every((skill) => skill.origin === "cursor"),
    true,
  );
  assert.equal(
    rows.some((skill) => skill.name === "review-pr" && skill.origin !== "cursor"),
    false,
  );
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SkillsPane.tsx"), "utf8");
  assert.match(pane, /id: "cursor", label: "Cursor"/);
  assert.match(pane, /if \(origin === "cursor"\) return "Cursor"/);
  const palette = commandsForSession({ provider: "cursor" }, cursorRows);
  assert.ok(palette.some((command) => command.name === "/review-pr" && command.run === "skill"));
  assert.ok(palette.some((command) => command.name === "/ship-app" && command.run === "skill"));
  assert.equal(commandsForSession({ provider: "grok" }, cursorRows).some((command) => command.name === "/review-pr"), false);
});

test("Cursor Auto is labeled as Cursor Auto; Composer and Cursor Grok stay readable", () => {
  resetVendorCatalog();
  const auto = modelName("cursor", "auto");
  assert.notEqual(auto, "Auto");
  assert.match(auto, /Auto/);
  assert.match(auto, /Cursor/);
  assert.match(modelName("cursor", "composer-2.5"), /Composer/);
  assert.match(modelName("cursor", "grok-4.6"), /Grok 4\.6/);
  assert.match(modelName("cursor", "grok-4.5"), /Grok 4\.5/);
  assert.match(modelsFor("cursor").find((model) => model.id === "auto")?.name ?? "", /Cursor/);
  applyVendorCatalog({
    cursor: [
      { id: "auto", name: "Auto", effort: true, contextWindow: 200_000 },
      { id: "composer-2.5", name: "Composer 2.5", effort: true, contextWindow: 200_000 },
      { id: "grok-4.6", name: "Grok 4.6", effort: true, contextWindow: 200_000 },
    ],
  });
  assert.notEqual(modelName("cursor", "auto"), "Auto");
  assert.match(modelName("cursor", "auto"), /Cursor/);
  assert.match(modelName("cursor", "auto-smart"), /Auto/);
  assert.match(modelName("cursor", "composer-2.5"), /Composer/);
  assert.match(modelName("cursor", "grok-4.6"), /Cursor Grok 4\.6/);
  resetVendorCatalog();
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  assert.match(setup, /modelName\(session\.provider, model\.id\)/);
});

test("Available models chips do not ellipsis-clip Cursor Grok names", () => {
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  const start = css.indexOf(".setup-models button strong");
  assert.ok(start >= 0);
  const block = css.slice(start, css.indexOf("}", start) + 1);
  assert.match(block, /white-space:\s*normal/);
  assert.doesNotMatch(block, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(block, /overflow:\s*hidden/);
  const modelsGrid = css.slice(css.indexOf(".session-setup .setup-models"), css.indexOf(".session-setup .setup-models") + 160);
  assert.match(modelsGrid, /repeat\(2,/);
  assert.doesNotMatch(modelsGrid.split("}")[0] ?? "", /repeat\(3,/);
});
