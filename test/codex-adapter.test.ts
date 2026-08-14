import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  classifyAcpUpdate,
  parseAcpUsage,
  parseGrokUsage,
  pickPermissionOptionId,
} from "../electron/grok-agent";
import { CodexSessionHost, codexLaunchKey, spawnCodexProcess } from "../electron/codex-host";
import {
  buildCodexLaunchSpec,
  resolveCodexAgentMode,
  resolveCodexApprovalPolicy,
  resolveCodexEffort,
  resolveCodexModel,
  resolveCodexSandboxMode,
} from "../electron/codex-launch";
import {
  CODEX_ACP_NOT_INSTALLED,
  detectCodexLogin,
  resolveCodexAcpCommand,
  resolveCodexAcpLaunch,
} from "../electron/codex-login";
import { defaultModel } from "../src/lib/models";
import { buildGrokLaunchSpec } from "../electron/grok-launch";
import { byProvider, finalizeTurnUsage, normalizeUsage, repairInflatedTurn } from "../src/lib/usage";
import { previewOnlyReply, vendorSendTarget } from "../src/lib/vendor-bridge";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeAcp(script: { methods: string[]; loadFail?: boolean; nextId?: string }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill() {
      this.killed = true;
      this.emit("exit", 0, null);
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
      const message = JSON.parse(line) as { id?: number; method?: string; params?: { sessionId?: string } };
      if (message.id === undefined) continue;
      script.methods.push(message.method ?? "");
      if (message.method === "initialize") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
        continue;
      }
      if (message.method === "session/load") {
        if (script.loadFail) {
          stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "unknown session" } })}\n`,
          );
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
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId } })}\n`);
        continue;
      }
      if (message.method === "session/prompt") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })}\n`);
        continue;
      }
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
    }
  });
  return child;
}

test("vendorSendTarget routes grok/codex/claude/custom live", () => {
  assert.equal(vendorSendTarget("grok"), "grok");
  assert.equal(vendorSendTarget("codex"), "codex");
  assert.equal(vendorSendTarget("claude"), "claude");
  assert.equal(vendorSendTarget("custom"), "custom");
  const preview = previewOnlyReply("Claude", "Demo", [], "hi");
  assert.match(preview, /Preview only/);
  assert.doesNotMatch(preview, /recordUsage/);
});

test("store send() does not cross-talk vendors", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  assert.match(store, /vendorSendTarget\(session\.provider\)/);
  assert.match(store, /codexPrompt/);
  assert.match(store, /grokPrompt/);
  assert.match(store, /claudePrompt/);
  assert.match(store, /customPrompt/);
  assert.match(store, /Preview only/);
  const live = store.slice(store.indexOf('live === "codex"'), store.indexOf("Preview only"));
  assert.match(live, /codexPrompt/);
  assert.doesNotMatch(live, /Preview only/);
  const grokCall = store.slice(store.indexOf("window.workhorse.grokPrompt"), store.indexOf("Preview only"));
  assert.doesNotMatch(grokCall, /codexPrompt/);
  const preview = store.slice(store.lastIndexOf("Preview only"), store.lastIndexOf("Preview only") + 500);
  assert.doesNotMatch(preview, /codexPrompt/);
  assert.doesNotMatch(preview, /grokPrompt/);
  assert.match(main, /new CodexSessionHost/);
  assert.match(main, /new ClaudeSessionHost/);
  assert.match(main, /ipcMain\.handle\("codex:prompt"/);
  assert.match(main, /ipcMain\.handle\("claude:prompt"/);
  assert.match(main, /ipcMain\.handle\("grok:prompt"/);
  const preloadSrc = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const preloadBuilt = readFileSync(path.join(ROOT, "dist-electron", "preload.mjs"), "utf8");
  assert.match(preloadSrc, /detectCodexLogin/);
  assert.match(preloadBuilt, /detectCodexLogin/);
  assert.match(preloadBuilt, /codex:detect-login/);
  assert.match(preloadSrc, /listVendorModels/);
  assert.match(preloadBuilt, /models:list/);
  assert.match(main, /ipcMain\.handle\("models:list"/);
  assert.doesNotMatch(main, /spawn\(["']grok/);
  assert.match(settings, /refreshCodexLogin/);
  assert.match(settings, />\s*Recheck\s*</);
  assert.match(settings, /Codex ACP adapter or login not found/);
});

test("buildCodexLaunchSpec never spawns grok and maps model sandbox mode MCP", () => {
  const previous = {
    url: process.env.WORKHORSE_BRIDGE_URL,
    token: process.env.WORKHORSE_BRIDGE_TOKEN,
    state: process.env.WORKHORSE_STATE_PATH,
    script: process.env.WORKHORSE_MCP_SCRIPT,
  };
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "workhorse-codex-"));
  const script = path.join(tempDir, "workhorse-mcp.js");
  writeFileSync(script, "export {}\n");
  process.env.WORKHORSE_BRIDGE_URL = "http://127.0.0.1:9";
  process.env.WORKHORSE_BRIDGE_TOKEN = "token";
  process.env.WORKHORSE_STATE_PATH = path.join(tempDir, "state.json");
  process.env.WORKHORSE_MCP_SCRIPT = script;
  try {
    const acp = path.join(tempDir, "codex-acp.exe");
    writeFileSync(acp, "");
    const spec = buildCodexLaunchSpec({
      model: "gpt-5.4",
      effort: "high",
      cwd: ROOT,
      mode: "ask",
      sandbox: "workspace",
      securityPolicy: { network: "allowed", root: "blocked" },
      mcpServers: [{ name: "figma", command: "npx", args: ["figma"] }],
      detect: {
        env: { CODEX_ACP_BIN: acp, PATH: tempDir },
        pathDirs: [tempDir],
        existsSync: (file) => file === acp || file === script,
        platform: "win32",
      },
    });
    assert.equal(spec.command, acp);
    assert.notEqual(spec.command, "grok");
    assert.ok(!spec.argv.includes("grok"));
    assert.ok(!spec.argv.includes("--reasoning-effort"));
    assert.equal(spec.model, "gpt-5.4");
    assert.equal(spec.effort, "high");
    assert.equal(spec.env?.NO_BROWSER, "1");
    assert.equal(spec.sandboxMode, "workspace-write");
    assert.equal(spec.approvalPolicy, "on-request");
    const config = JSON.parse(spec.env?.CODEX_CONFIG ?? "{}") as { sandbox_workspace_write?: { network_access?: boolean } };
    assert.equal(config.sandbox_workspace_write?.network_access, true);
    assert.ok(spec.sessionParams.mcpServers.some((item) => item.name === "figma"));
    assert.ok(spec.sessionParams.mcpServers.some((item) => item.name === "workhorse"));

    assert.throws(
      () =>
        buildCodexLaunchSpec({
          model: "codex",
          effort: "low",
          cwd: ROOT,
          mode: "always-approve",
          sandbox: "off",
          detect: { env: { PATH: "" }, pathDirs: [], existsSync: () => false, platform: "win32" },
        }),
      /Codex ACP is not installed/,
    );

    const yolo = buildCodexLaunchSpec({
      model: "codex",
      effort: "low",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "off",
      detect: {
        env: { CODEX_ACP_BIN: acp, PATH: "" },
        pathDirs: [],
        existsSync: (file) => file === acp || file === script,
        platform: "win32",
      },
    });
    assert.equal(yolo.model, "codex");
    assert.equal(yolo.command, acp);
    assert.notEqual(yolo.command, "grok");
    assert.notEqual(yolo.command, "codex-acp.cmd");
    assert.equal(yolo.alwaysApprove, true);
    assert.equal(yolo.sessionParams._meta?.yoloMode, true);
    assert.equal(yolo.sandboxMode, "danger-full-access");
    assert.equal(yolo.approvalPolicy, "never");
    assert.equal(yolo.agentMode, "agent-full-access");

    const plan = buildCodexLaunchSpec({
      model: "gpt-5.4",
      effort: "medium",
      cwd: ROOT,
      mode: "plan",
      sandbox: "strict",
      detect: {
        env: { CODEX_ACP_BIN: acp, PATH: "" },
        pathDirs: [],
        existsSync: (file) => file === acp,
      },
    });
    assert.equal(plan.sessionParams._meta?.planMode, true);
    assert.equal(plan.sandboxMode, "read-only");
    assert.equal(plan.agentMode, "read-only");

    const accept = buildCodexLaunchSpec({
      model: "gpt-5.4",
      effort: "xhigh",
      cwd: ROOT,
      mode: "accept-edits",
      sandbox: "read-only",
      detect: {
        env: { CODEX_ACP_BIN: acp, PATH: "" },
        pathDirs: [],
        existsSync: (file) => file === acp,
      },
    });
    assert.equal(accept.sessionParams._meta?.autoMode, true);
    assert.equal(accept.sandboxMode, "read-only");

    const grok = buildGrokLaunchSpec({
      model: "grok-4.6",
      effort: "medium",
      cwd: ROOT,
      mode: "ask",
    });
    assert.equal(grok.command, "grok");
  } finally {
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.WORKHORSE_BRIDGE_TOKEN;
    else process.env.WORKHORSE_BRIDGE_TOKEN = previous.token;
    if (previous.state === undefined) delete process.env.WORKHORSE_STATE_PATH;
    else process.env.WORKHORSE_STATE_PATH = previous.state;
    if (previous.script === undefined) delete process.env.WORKHORSE_MCP_SCRIPT;
    else process.env.WORKHORSE_MCP_SCRIPT = previous.script;
  }
});

test("Codex ACP resolve never returns a phantom cmd and requires ACP plus login", () => {
  assert.equal(defaultModel("codex").id, "gpt-5.6-sol");
  const missing = resolveCodexAcpLaunch({
    env: { PATH: "" },
    pathDirs: [],
    existsSync: () => false,
    moduleDirs: [],
    platform: "win32",
  });
  assert.equal(missing, null);
  assert.equal(
    resolveCodexAcpCommand({
      env: { PATH: "" },
      pathDirs: [],
      existsSync: () => false,
      moduleDirs: [],
      platform: "win32",
    }),
    null,
  );

  const phantomCmd = path.join("C:\\missing", "codex-acp.cmd");
  assert.equal(
    resolveCodexAcpCommand({
      env: { CODEX_ACP_BIN: phantomCmd, PATH: "" },
      existsSync: () => false,
      pathDirs: [],
      moduleDirs: [],
      platform: "win32",
    }),
    null,
  );

  const pkgRoot = ROOT;
  const pkgJson = path.join(pkgRoot, "node_modules", "@agentclientprotocol", "codex-acp", "package.json");
  const pkgBin = path.join(pkgRoot, "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js");
  const node = path.join("C:\\node", "node.exe");
  const desktop = path.join("C:\\desk", "codex.exe");
  const launch = resolveCodexAcpLaunch({
    env: { PATH: "" },
    pathDirs: [],
    moduleDirs: [pkgRoot],
    nodeBinary: node,
    existsSync: (file) => file === pkgJson || file === pkgBin || file === node,
    readFile: (file) => (file === pkgJson ? readFileSync(pkgJson, "utf8") : ""),
    platform: "win32",
  });
  assert.ok(launch);
  assert.equal(launch?.command, node);
  assert.deepEqual(launch?.argv, [pkgBin]);
  assert.equal(launch?.acpFile, pkgBin);
  assert.notEqual(launch?.command, "codex-acp.cmd");
  assert.notEqual(launch?.command, "grok");

  const spec = buildCodexLaunchSpec({
    model: "gpt-5.6-sol",
    effort: "medium",
    cwd: ROOT,
    mode: "ask",
    detect: {
      env: { PATH: "" },
      pathDirs: [],
      moduleDirs: [pkgRoot],
      nodeBinary: node,
      existsSync: (file) => file === pkgJson || file === pkgBin || file === node || file === desktop,
      readFile: (file) => (file === pkgJson ? readFileSync(pkgJson, "utf8") : ""),
      platform: "win32",
      homedir: "C:\\nouser",
    },
  });
  assert.equal(spec.command, node);
  assert.deepEqual(spec.argv, [pkgBin]);
  assert.equal(spec.model, "gpt-5.6-sol");
  assert.equal(spec.env?.NO_BROWSER, "1");
  assert.match(spec.env?.CODEX_CONFIG ?? "", /gpt-5\.6-sol/);

  const withCli = buildCodexLaunchSpec({
    model: "gpt-5.6-terra",
    effort: "high",
    cwd: ROOT,
    mode: "ask",
    detect: {
      env: { PATH: "", CODEX_PATH: desktop },
      pathDirs: [],
      moduleDirs: [pkgRoot],
      nodeBinary: node,
      existsSync: (file) => file === pkgJson || file === pkgBin || file === node || file === desktop,
      readFile: (file) => (file === pkgJson ? readFileSync(pkgJson, "utf8") : ""),
      platform: "win32",
    },
  });
  assert.equal(withCli.env?.CODEX_PATH, desktop);
  assert.equal(withCli.model, "gpt-5.6-terra");
  assert.notEqual(withCli.command, desktop);

  const shim = path.join(pkgRoot, "node_modules", ".bin", "codex.cmd");
  const hashed = path.join("C:\\desk-root", "OpenAI", "Codex", "bin", "hash1", "codex.exe");
  const prefersDesktopHashed = buildCodexLaunchSpec({
    model: "gpt-5.6-sol",
    effort: "low",
    cwd: ROOT,
    mode: "ask",
    detect: {
      env: { PATH: path.dirname(shim), LOCALAPPDATA: "C:\\desk-root" },
      pathDirs: [path.dirname(shim)],
      moduleDirs: [pkgRoot],
      nodeBinary: node,
      homedir: "C:\\nouser",
      existsSync: (file) =>
        file === pkgJson ||
        file === pkgBin ||
        file === node ||
        file === shim ||
        file === path.join("C:\\desk-root", "OpenAI", "Codex", "bin") ||
        file === hashed,
      listDir: (dir) => (dir === path.join("C:\\desk-root", "OpenAI", "Codex", "bin") ? ["hash1"] : []),
      readFile: (file) => (file === pkgJson ? readFileSync(pkgJson, "utf8") : ""),
      platform: "win32",
    },
  });
  assert.equal(prefersDesktopHashed.env?.CODEX_PATH, hashed);
  assert.notEqual(prefersDesktopHashed.env?.CODEX_PATH, shim);
});

test("resolveCodex mappings lock documented flags", () => {
  assert.equal(resolveCodexModel("gpt-5.4"), "gpt-5.4");
  assert.equal(resolveCodexModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(resolveCodexModel("codex"), "codex");
  assert.equal(resolveCodexEffort("extra"), "xhigh");
  assert.equal(resolveCodexSandboxMode("off"), "danger-full-access");
  assert.equal(resolveCodexSandboxMode("workspace"), "workspace-write");
  assert.equal(resolveCodexSandboxMode("strict"), "read-only");
  assert.equal(resolveCodexApprovalPolicy("always-approve"), "never");
  assert.equal(resolveCodexAgentMode("plan", "off"), "read-only");
});

test("detectCodexLogin requires binary plus artifact and never marks Grok", () => {
  const home = "/tmp/wh-codex-home";
  const binDir = "/tmp/wh-codex-bin";
  const acp = path.join(binDir, "codex-acp.exe");
  const auth = path.join(home, ".codex", "auth.json");
  const none = detectCodexLogin({
    homedir: home,
    pathDirs: [],
    env: { PATH: "" },
    existsSync: () => false,
    platform: "win32",
  });
  assert.equal(none.connected, false);
  assert.equal(none.binary, null);

  const noAuth = detectCodexLogin({
    homedir: home,
    pathDirs: [binDir],
    env: { PATH: binDir },
    existsSync: (file) => file === acp,
    platform: "win32",
  });
  assert.equal(noAuth.connected, false);
  assert.equal(noAuth.binary, acp);

  const withAuth = detectCodexLogin({
    homedir: home,
    pathDirs: [binDir],
    env: { PATH: binDir },
    existsSync: (file) => file === acp || file === auth,
    platform: "win32",
  });
  assert.equal(withAuth.connected, true);
  assert.equal(withAuth.binary, acp);

  const withKey = detectCodexLogin({
    homedir: home,
    pathDirs: [binDir],
    env: { PATH: binDir, CODEX_API_KEY: "sk-test" },
    existsSync: (file) => file === acp,
    platform: "win32",
  });
  assert.equal(withKey.connected, true);
  assert.equal("claude" in withKey, false);
  assert.equal("grok" in withKey, false);

  const envWins = resolveCodexAcpCommand({
    env: { CODEX_ACP_BIN: "/opt/custom-acp" },
    existsSync: (file) => file === "/opt/custom-acp",
    pathDirs: [],
  });
  assert.equal(envWins, "/opt/custom-acp");

  const localApp = path.join(home, "AppData", "Local");
  const desktopRoot = path.join(localApp, "OpenAI", "Codex", "bin");
  const desktopExe = path.join(desktopRoot, "8e8bf206e63ac436", "codex.exe");
  const desktop = detectCodexLogin({
    homedir: home,
    pathDirs: [],
    env: { PATH: "", LOCALAPPDATA: localApp },
    existsSync: (file) => file === desktopRoot || file === desktopExe || file === auth,
    listDir: (dir) => (dir === desktopRoot ? ["8e8bf206e63ac436"] : []),
    platform: "win32",
  });
  assert.equal(desktop.connected, false);
  assert.equal(desktop.cliBinary, desktopExe);
  assert.equal(desktop.acpBinary, null);
  assert.equal(desktop.binary, null);

  const desktopPlusAcp = detectCodexLogin({
    homedir: home,
    pathDirs: [binDir],
    env: { PATH: binDir, LOCALAPPDATA: localApp },
    existsSync: (file) => file === acp || file === desktopRoot || file === desktopExe || file === auth,
    listDir: (dir) => (dir === desktopRoot ? ["8e8bf206e63ac436"] : []),
    platform: "win32",
  });
  assert.equal(desktopPlusAcp.connected, true);
  assert.equal(desktopPlusAcp.binary, acp);
  assert.equal(desktopPlusAcp.cliBinary, desktopExe);
});

test("CodexSessionHost new/load/fail/launch-key and missing binary", async () => {
  const methods: string[] = [];
  const host = new CodexSessionHost(() => fakeAcp({ methods, nextId: "c-new" }));
  const opened: string[] = [];
  const result = await host.prompt(
    {
      sessionId: "work-c1",
      text: "hello",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
    },
    (event) => {
      if (event.type === "vendor-session") opened.push(event.opened);
    },
  );
  host.disposeAll();
  assert.deepEqual(methods, ["initialize", "session/new", "session/prompt"]);
  assert.equal(result.vendorSessionId, "c-new");
  assert.equal(result.opened, "session/new");
  assert.deepEqual(opened, ["session/new"]);

  const loaded: string[] = [];
  const loadHost = new CodexSessionHost(() => fakeAcp({ methods: loaded }));
  const loadResult = await loadHost.prompt(
    {
      sessionId: "work-c2",
      text: "again",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "saved-c",
    },
    () => undefined,
  );
  loadHost.dispose("work-c2");
  const afterDispose: string[] = [];
  const resumed = await loadHost.prompt(
    {
      sessionId: "work-c2",
      text: "resume",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "saved-c",
    },
    (event) => {
      if (event.type === "vendor-session") afterDispose.push(event.opened);
    },
  );
  loadHost.disposeAll();
  assert.ok(loaded.includes("session/load"));
  assert.equal(resumed.opened, "session/load");
  assert.deepEqual(afterDispose, ["session/load"]);

  const recovered: string[] = [];
  const failHost = new CodexSessionHost(() => fakeAcp({ methods: recovered, loadFail: true, nextId: "recovered-c" }));
  const failed = await failHost.prompt(
    {
      sessionId: "work-c3",
      text: "hi",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "gone",
    },
    () => undefined,
  );
  failHost.disposeAll();
  assert.ok(recovered.includes("session/new"));
  assert.equal(failed.opened, "session/new");
  assert.equal(failed.vendorSessionId, "recovered-c");

  const keys: string[] = [];
  const keyHost = new CodexSessionHost(() => fakeAcp({ methods: keys, nextId: "second-c" }));
  await keyHost.prompt(
    {
      sessionId: "work-c4",
      text: "one",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      cwd: ROOT,
    },
    () => undefined,
  );
  const afterKey = await keyHost.prompt(
    {
      sessionId: "work-c4",
      text: "two",
      model: "codex",
      effort: "high",
      mode: "ask",
      cwd: ROOT,
      vendorSessionId: "second-c",
    },
    () => undefined,
  );
  keyHost.disposeAll();
  assert.equal(afterKey.opened, "session/new");

  const baseKey = {
    model: "gpt-5.4" as const,
    effort: "medium" as const,
    cwd: ROOT,
    sandbox: "workspace" as const,
    mcpServers: [] as { name: string; command: string; args: string[] }[],
  };
  assert.notEqual(
    codexLaunchKey({ ...baseKey, mode: "ask" }),
    codexLaunchKey({ ...baseKey, mode: "always-approve" }),
  );
  assert.notEqual(codexLaunchKey({ ...baseKey, mode: "ask" }), codexLaunchKey({ ...baseKey, mode: "plan" }));
  assert.notEqual(
    codexLaunchKey({ ...baseKey, mode: "ask" }),
    codexLaunchKey({ ...baseKey, mode: "accept-edits" }),
  );

  const modeMethods: string[] = [];
  const modeHost = new CodexSessionHost(() => fakeAcp({ methods: modeMethods, nextId: "mode-c" }));
  await modeHost.prompt(
    {
      sessionId: "work-c5",
      text: "ask",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      sandbox: "workspace",
      cwd: ROOT,
    },
    () => undefined,
  );
  const afterMode = await modeHost.prompt(
    {
      sessionId: "work-c5",
      text: "yolo",
      model: "gpt-5.4",
      effort: "medium",
      mode: "always-approve",
      sandbox: "workspace",
      cwd: ROOT,
      vendorSessionId: "mode-c",
    },
    () => undefined,
  );
  modeHost.disposeAll();
  assert.equal(afterMode.opened, "session/new");
  assert.equal(modeMethods.filter((method) => method === "session/new").length, 2);

  const reuseMethods: string[] = [];
  const reuseHost = new CodexSessionHost(() => fakeAcp({ methods: reuseMethods, nextId: "reuse-c" }));
  await reuseHost.prompt(
    {
      sessionId: "work-c6",
      text: "one",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      sandbox: "workspace",
      cwd: ROOT,
    },
    () => undefined,
  );
  const reused = await reuseHost.prompt(
    {
      sessionId: "work-c6",
      text: "two",
      model: "gpt-5.4",
      effort: "medium",
      mode: "ask",
      sandbox: "workspace",
      cwd: ROOT,
      vendorSessionId: "reuse-c",
    },
    () => undefined,
  );
  reuseHost.disposeAll();
  assert.equal(reused.opened, "session/new");
  assert.equal(reuseMethods.filter((method) => method === "session/new").length, 1);
  assert.equal(reuseMethods.filter((method) => method === "session/prompt").length, 2);

  const missing = path.join(ROOT, "definitely-missing-codex-acp.exe");
  assert.throws(
    () =>
      buildCodexLaunchSpec({
        model: "gpt-5.4",
        effort: "medium",
        cwd: ROOT,
        mode: "ask",
        detect: { env: { CODEX_ACP_BIN: missing }, existsSync: () => false, pathDirs: [] },
      }),
    /Codex ACP is not installed/,
  );
  assert.throws(
    () =>
      spawnCodexProcess({
        command: "codex-acp.cmd",
        argv: [],
        cwd: ROOT,
        model: "gpt-5.6-sol",
        effort: "medium",
        alwaysApprove: false,
        sandbox: "off",
        sandboxMode: "danger-full-access",
        approvalPolicy: "on-request",
        agentMode: "agent-full-access",
        initializeParams: {
          protocolVersion: 1,
          clientInfo: { name: "go7-workhorse", title: "Workhorse", version: "0.1.0" },
          clientCapabilities: { sessionLoad: true, permissionPrompts: true },
        },
        sessionParams: { cwd: ROOT, mcpServers: [] },
      }),
    new RegExp(CODEX_ACP_NOT_INSTALLED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("shared ACP usage parser and finalize do not double-count Codex turns", () => {
  const turn = parseAcpUsage({
    sessionUpdate: "turn_completed",
    usage: { inputTokens: 527934, outputTokens: 5202, cachedReadTokens: 461440 },
  });
  assert.equal(turn?.inputTokens, 66494);
  assert.equal(turn?.cacheReadTokens, 461440);
  assert.equal(turn?.outputTokens, 5202);
  assert.equal(parseGrokUsage === parseAcpUsage, true);

  const exclusive = parseAcpUsage({
    input_tokens: 17050,
    output_tokens: 2040,
    cache_read_input_tokens: 96768,
  });
  assert.equal(exclusive?.inputTokens, 17050);
  assert.equal(exclusive?.cacheReadTokens, 96768);

  const folded = finalizeTurnUsage([
    { provider: "codex", model: "gpt-5.4", inputTokens: 66494, outputTokens: 5202, cacheReadTokens: 461440 },
    {
      provider: "codex",
      model: "gpt-5.4",
      inputTokens: turn!.inputTokens,
      outputTokens: turn!.outputTokens,
      cacheReadTokens: turn!.cacheReadTokens,
    },
  ]);
  assert.equal(folded.inputTokens, 66494);
  assert.equal(folded.outputTokens, 5202);
  assert.notEqual(folded.inputTokens, 594428);
  assert.notEqual(folded.outputTokens, 10404);

  const repaired = repairInflatedTurn({
    inputTokens: 594428,
    outputTokens: 10404,
    cacheReadTokens: 461440,
  });
  assert.equal(repaired.inputTokens, 66494);

  const hydrated = normalizeUsage([
    {
      id: "use_c",
      at: Date.now(),
      provider: "codex",
      model: "gpt-5.4",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
  assert.equal(hydrated[0].provider, "codex");
  const groups = byProvider(hydrated);
  const codex = groups.find((row) => row.provider === "codex");
  assert.equal(codex?.inputTokens, 100);
  assert.equal(codex?.outputTokens, 20);
});

test("Codex permissions and tool rows reuse ACP extractors", () => {
  const options = [
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ];
  assert.equal(pickPermissionOptionId(options, "once"), "allow-once");
  assert.equal(pickPermissionOptionId(options, "session"), "allow-always");
  assert.equal(pickPermissionOptionId(options, "deny"), "reject-once");
  const tool = classifyAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Read file",
    status: "pending",
    content: [{ type: "content", content: { type: "text", text: "src/a.ts" } }],
  });
  assert.equal(tool.kind, "tool");
  if (tool.kind !== "tool") throw new Error("expected tool");
  assert.equal(tool.tool.toolCallId, "call-1");
  const update = classifyAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    title: "Read file",
  });
  assert.equal(update.kind, "tool");
});
