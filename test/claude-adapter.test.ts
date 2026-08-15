import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { findClaudeDesktopRoot, pickClaudeCodeOauth } from "../electron/claude-desktop-auth";
import {
  CLAUDE_ACP_NOT_INSTALLED,
  CLAUDE_CLI_NOT_INSTALLED,
  detectClaudeLogin,
  hasClaudeLoginArtifact,
  isElectronAcpCommand,
  oauthNotExpired,
  resolveClaudeAcpLaunch,
} from "../electron/claude-login";
import { isInsideAsar, runningInElectron } from "../electron/desk-path";
import {
  buildClaudeLaunchSpec,
  resolveClaudeEffort,
  resolveClaudeModel,
  resolveClaudePermissionMode,
} from "../electron/claude-launch";
import { fetchClaudePlanUsage, parseClaudePlanUsage, usedPercentFromUtilization } from "../electron/claude-plan";
import { previewOnlyReply, vendorSendTarget } from "../src/lib/vendor-bridge";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("vendorSendTarget routes claude live like grok and codex", () => {
  assert.equal(vendorSendTarget("claude"), "claude");
  assert.equal(vendorSendTarget("grok"), "grok");
  const preview = previewOnlyReply("Claude", "Demo", [], "hi");
  assert.match(preview, /Preview only/);
});

test("detectClaudeLogin requires ACP plus a real login artifact", () => {
  const missing = detectClaudeLogin({
    env: {},
    homedir: path.join(ROOT, "does-not-exist"),
    existsSync: () => false,
    pathDirs: [],
    moduleDirs: [],
    keychainHasLogin: () => false,
  });
  assert.equal(missing.connected, false);
  assert.equal(missing.acpBinary, null);

  const acp = path.join(ROOT, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js");
  const withPackage = detectClaudeLogin({
    env: {},
    homedir: path.join(ROOT, "does-not-exist"),
    existsSync: (file) =>
      file === acp || file.endsWith(`${path.sep}package.json`) || /node(\.exe)?$/i.test(file),
    readFile: (file) =>
      file.endsWith("package.json")
        ? JSON.stringify({ bin: { "claude-agent-acp": "dist/index.js" } })
        : "",
    pathDirs: [],
    moduleDirs: [ROOT],
    nodeBinary: process.execPath,
    keychainHasLogin: () => false,
  });
  assert.equal(withPackage.connected, false);
  assert.ok(withPackage.acpBinary);

  assert.equal(
    hasClaudeLoginArtifact("C:\\claude", "C:\\home", () => false, () => "", { ANTHROPIC_API_KEY: "sk-test" }),
    true,
  );
  assert.equal(
    hasClaudeLoginArtifact(
      "C:\\claude",
      "C:\\home",
      (file) => file === path.join("C:\\claude", ".credentials.json"),
      () => JSON.stringify({ claudeAiOauth: { accessToken: "tok-xxxxxxxx" } }),
      {},
      "win32",
    ),
    true,
  );
  const picked = pickClaudeCodeOauth({
    "id:https://api.anthropic.com:user:profile": { token: "short" },
    "id:https://api.anthropic.com:user:inference user:sessions:claude_code": {
      token: "claude-code-token-xxxxxxxx",
      refreshToken: "refresh-xxxxxxxx",
      expiresAt: Date.now() + 60_000,
    },
  });
  assert.equal(picked?.accessToken, "claude-code-token-xxxxxxxx");
  assert.equal(picked?.source, "desktop");
  assert.equal(
    hasClaudeLoginArtifact(
      "C:\\claude",
      "C:\\home",
      (file) => file === path.join("C:\\claude", ".credentials.json"),
      () => JSON.stringify({ mcpOAuth: { figma: {} } }),
      {},
      "win32",
    ),
    false,
  );
});

test("buildClaudeLaunchSpec never spawns grok and maps permission modes", () => {
  const previous = {
    url: process.env.WORKHORSE_BRIDGE_URL,
    token: process.env.WORKHORSE_BRIDGE_TOKEN,
  };
  process.env.WORKHORSE_BRIDGE_URL = "http://127.0.0.1:9";
  process.env.WORKHORSE_BRIDGE_TOKEN = "token";
  try {
    assert.equal(resolveClaudeModel(""), "claude-sonnet-5");
    assert.equal(resolveClaudeModel("opus"), "claude-opus-5");
    assert.equal(resolveClaudeModel("claude-sonnet"), "claude-sonnet-5");
    assert.equal(resolveClaudeModel("Fable 5"), "claude-fable-5");
    assert.equal(resolveClaudeModel("fable"), "claude-fable-5");
    assert.equal(resolveClaudeModel("claude-fable-5"), "claude-fable-5");
    assert.equal(resolveClaudeModel("claude-fable-5[1m]"), "claude-fable-5");
    assert.notEqual(resolveClaudeModel("Fable 5"), "claude-opus-5");
    assert.notEqual(resolveClaudeModel("Fable 5"), "claude-sonnet-5");
    assert.equal(resolveClaudeEffort("extra"), "xhigh");
    assert.equal(resolveClaudeEffort("ultra"), "max");
    assert.equal(resolveClaudePermissionMode("always-approve"), "bypassPermissions");
    assert.equal(resolveClaudePermissionMode("accept-edits"), "acceptEdits");
    assert.equal(resolveClaudePermissionMode("plan"), "plan");
    assert.equal(resolveClaudePermissionMode("always-approve", "read-only"), "default");

    const spec = buildClaudeLaunchSpec({
      model: "claude-opus-5",
      effort: "high",
      cwd: ROOT,
      mode: "ask",
    });
    assert.ok(!/grok/i.test(spec.command));
    assert.ok(!spec.argv.some((arg) => /grok/i.test(arg)));
    assert.ok(!spec.argv.includes("--sandbox"));
    assert.equal(spec.model, "claude-opus-5");
    assert.equal(spec.env?.ANTHROPIC_MODEL, "claude-opus-5");
    assert.equal(spec.effort, "high");
    assert.equal(spec.sessionParams._meta?.model, "claude-opus-5");
    assert.equal(spec.sessionParams._meta?.permissionMode, "default");
    assert.match(spec.argv.join(" ") + spec.command, /claude-agent-acp|index\.js/);

    const fable = buildClaudeLaunchSpec({
      model: "Fable 5",
      effort: "high",
      cwd: ROOT,
      mode: "always-approve",
    });
    assert.equal(fable.model, "claude-fable-5");
    assert.equal(fable.env?.ANTHROPIC_MODEL, "claude-fable-5");
    assert.equal(fable.sessionParams._meta?.model, "claude-fable-5");
    assert.equal(fable.sessionParams._meta?.claudeCode?.options?.thinking?.display, "summarized");
    assert.equal(fable.sessionParams._meta?.claudeCode?.options?.thinking?.type, "adaptive");
    assert.equal(fable.sessionParams._meta?.claudeCode?.options?.effort, "high");
    assert.notEqual(fable.env?.ANTHROPIC_MODEL, "claude-opus-5");
    assert.notEqual(fable.env?.ANTHROPIC_MODEL, "claude-sonnet-5");
    assert.match(
      readFileSync(path.join(ROOT, "electron", "claude-host.ts"), "utf8"),
      /ANTHROPIC_MODEL/,
    );

    const yolo = buildClaudeLaunchSpec({
      model: "claude-sonnet-5",
      effort: "medium",
      cwd: ROOT,
      mode: "always-approve",
    });
    assert.equal(yolo.sessionParams._meta?.yoloMode, true);
    assert.equal(yolo.permissionMode, "bypassPermissions");

    const boxed = buildClaudeLaunchSpec({
      model: "claude-sonnet-5",
      effort: "medium",
      cwd: ROOT,
      mode: "always-approve",
      sandbox: "read-only",
    });
    assert.equal(boxed.sandbox, "read-only");
    assert.equal(boxed.sessionParams._meta?.sandbox, "read-only");
    assert.equal(boxed.permissionMode, "default");
    assert.ok(!boxed.sessionParams._meta?.yoloMode);
    assert.ok(!boxed.argv.includes("--sandbox"));
  } finally {
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.WORKHORSE_BRIDGE_TOKEN;
    else process.env.WORKHORSE_BRIDGE_TOKEN = previous.token;
  }
});

test("Claude is wired through store IPC and no longer preview", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const addBot = readFileSync(path.join(ROOT, "src", "ui", "AddBot.tsx"), "utf8");
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  assert.match(store, /live === "claude"/);
  assert.match(store, /claudePrompt/);
  assert.match(store, /refreshClaudeLogin/);
  assert.doesNotMatch(store.slice(store.indexOf('live === "claude"'), store.indexOf('live === "codex"')), /Preview only/);
  assert.match(main, /ipcMain\.handle\("claude:prompt"/);
  assert.match(main, /detectClaudeLogin/);
  assert.match(preload, /claude:detect-login/);
  assert.match(preload, /claudePrompt/);
  assert.match(settings, /"claude"/);
  assert.match(settings, /refreshClaudeLogin/);
  assert.match(addBot, /refreshClaudeLogin/);
  assert.doesNotMatch(addBot, /Hidden on the desk until the adapter is live/);
  assert.match(setup, /"claude"/);
  assert.match(CLAUDE_ACP_NOT_INSTALLED, /claude-agent-acp/);
  assert.ok(resolveClaudeAcpLaunch({ moduleDirs: [ROOT] }));
});

test("parseClaudePlanUsage reads weekly leftover the same way as SuperGrok", () => {
  assert.equal(usedPercentFromUtilization(7), 7);
  assert.equal(usedPercentFromUtilization(0.61), 61);
  const plan = parseClaudePlanUsage({
    five_hour: { utilization: 23, resets_at: "2026-08-13T19:39:59Z" },
    seven_day: { utilization: 7, resets_at: "2026-08-20T05:59:59Z" },
  });
  assert.equal(plan?.usedPercent, 7);
  assert.equal(plan?.leftPercent, 93);
  assert.equal(plan?.period, "weekly");
  assert.equal(plan?.resetsAt, "2026-08-20T05:59:59Z");
  assert.equal(plan?.products[0]?.label, "Current session");
  assert.equal(plan?.products[0]?.usagePercent, 23);
  assert.equal(plan?.products[1]?.label, "All models");

  const desktop = parseClaudePlanUsage({
    five_hour: { utilization: 23, resets_at: "2026-08-13T19:39:59Z" },
    seven_day: { utilization: 7, resets_at: "2026-08-20T05:59:59Z" },
    limits: [
      { kind: "session", percent: 23, resets_at: "2026-08-13T19:39:59Z" },
      { kind: "weekly_all", percent: 7, resets_at: "2026-08-20T05:59:59Z" },
      {
        kind: "weekly_scoped",
        percent: 12,
        resets_at: "2026-08-20T06:00:00Z",
        scope: { model: { display_name: "Fable" } },
      },
    ],
  });
  assert.deepEqual(
    desktop?.products.map((row) => `${row.label}:${row.usagePercent}`),
    ["Current session:23", "All models:7", "Fable:12"],
  );
  assert.equal(desktop?.usedPercent, 7);
});

test("fetchClaudePlanUsage sends the claude-code User-Agent", async () => {
  const seen: string[] = [];
  const plan = await fetchClaudePlanUsage({
    token: "test-token",
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("user-agent") ?? "");
      return new Response(
        JSON.stringify({
          limits: [
            { kind: "session", percent: 23 },
            { kind: "weekly_all", percent: 7 },
          ],
        }),
        { status: 200 },
      );
    },
  });
  assert.match(seen[0] ?? "", /^claude-code\//);
  assert.equal(plan?.usedPercent, 7);
});

test("findClaudeDesktopRoot uses Application Support on macOS, not AppData", () => {
  // Build the expected path the same way the code does, so the assertion
  // holds on Windows where path.join uses a backslash.
  const macRoot = path.join("/Users/me", "Library", "Application Support", "Claude");
  const mac = findClaudeDesktopRoot({
    platform: "darwin",
    homedir: "/Users/me",
    existsSync: (file) => file === path.join(macRoot, "config.json"),
  });
  assert.equal(mac, macRoot);
  const missing = findClaudeDesktopRoot({
    platform: "darwin",
    homedir: "/Users/me",
    existsSync: () => false,
  });
  assert.equal(missing, null);
  const store = findClaudeDesktopRoot({
    platform: "win32",
    homedir: "C:\\Users\\me",
    env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
    existsSync: (file) =>
      file.endsWith("Packages") ||
      file.replace(/\\/g, "/").endsWith("LocalCache/Roaming/Claude/config.json") ||
      file.replace(/\\/g, "/").endsWith("LocalCache/Roaming/Claude/Local State"),
    listDir: (dir) => (dir.replace(/\\/g, "/").endsWith("Packages") ? ["Claude_abc"] : []),
  });
  assert.match((store ?? "").replace(/\\/g, "/"), /Claude_abc\/LocalCache\/Roaming\/Claude$/);
});

test("a packaged ACP script runs on Electron, never a system node", () => {
  // The installed-app failure: app.asar is a file to a plain node, so it
  // died with MODULE_NOT_FOUND on any machine that had node on PATH.
  const asarScript =
    "/Applications/Workhorse.app/Contents/Resources/app.asar/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
  const systemNode = "/opt/homebrew/bin/node";
  const packaged = "/Applications/Workhorse.app/Contents/MacOS/Workhorse";
  const onDisk = (file: string) => file === asarScript || file === systemNode || file === packaged;

  const launch = resolveClaudeAcpLaunch({
    env: { CLAUDE_ACP_BIN: asarScript, PATH: "" },
    pathDirs: ["/opt/homebrew/bin"],
    existsSync: onDisk,
    execPath: packaged,
    electron: true,
  });
  assert.equal(launch?.command, packaged);
  assert.notEqual(launch?.command, systemNode);
  assert.deepEqual(launch?.argv, [asarScript]);

  // The spec must then tell that binary to behave as node. A packaged build
  // is named after the product, so the check cannot be on the file name.
  assert.equal(isElectronAcpCommand(packaged, packaged, true), true);
  assert.equal(isElectronAcpCommand(packaged, packaged, false), false);

  // A checkout on disk is readable by node, so nothing changes there.
  const devScript = "/Users/me/proj/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
  const devLaunch = resolveClaudeAcpLaunch({
    env: { CLAUDE_ACP_BIN: devScript, PATH: "" },
    pathDirs: ["/opt/homebrew/bin"],
    existsSync: (file) => file === devScript || file === systemNode || file === packaged,
    execPath: packaged,
    electron: true,
  });
  assert.equal(devLaunch?.command, systemNode);
});

test("isInsideAsar spots archives but not the unpacked copy", () => {
  assert.equal(isInsideAsar("/a/Resources/app.asar/node_modules/x/dist/index.js"), true);
  assert.equal(isInsideAsar("C:\\a\\Resources\\app.asar\\node_modules\\x\\dist\\index.js"), true);
  // Unpacked files are real on disk, so a plain node can read them.
  assert.equal(isInsideAsar("/a/Resources/app.asar.unpacked/node_modules/x/dist/index.js"), false);
  assert.equal(isInsideAsar("/Users/me/proj/node_modules/x/dist/index.js"), false);
  assert.equal(runningInElectron({ node: "22" } as NodeJS.ProcessVersions), false);
  assert.equal(runningInElectron({ electron: "37" } as unknown as NodeJS.ProcessVersions), true);
});

test("a packaged build names the missing CLI instead of spawning into the archive", () => {
  const previous = { url: process.env.WORKHORSE_BRIDGE_URL, token: process.env.WORKHORSE_BRIDGE_TOKEN };
  process.env.WORKHORSE_BRIDGE_URL = "http://127.0.0.1:9";
  process.env.WORKHORSE_BRIDGE_TOKEN = "token";
  try {
    const packaged = "/Applications/Workhorse.app/Contents/MacOS/Workhorse";
    const asarAcp =
      "/Applications/Workhorse.app/Contents/Resources/app.asar/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    // No Claude CLI anywhere on this machine.
    const detect = {
      env: { CLAUDE_ACP_BIN: asarAcp, PATH: "" },
      homedir: "/Users/nobody",
      pathDirs: [],
      moduleDirs: [],
      existsSync: (file: string) => file === asarAcp || file === packaged,
      execPath: packaged,
      electron: true,
    };
    assert.throws(
      () => buildClaudeLaunchSpec({ model: "claude-opus-5", effort: "high", cwd: ROOT, mode: "ask", detect }),
      (error: Error) => error.message === CLAUDE_CLI_NOT_INSTALLED,
    );

    // A checkout can still fall back to the CLI inside the package, so it must not throw.
    const devAcp = "/Users/me/proj/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    const node = "/opt/homebrew/bin/node";
    const spec = buildClaudeLaunchSpec({
      model: "claude-opus-5",
      effort: "high",
      cwd: ROOT,
      mode: "ask",
      detect: {
        env: { CLAUDE_ACP_BIN: devAcp, PATH: "" },
        homedir: "/Users/nobody",
        pathDirs: ["/opt/homebrew/bin"],
        moduleDirs: [],
        existsSync: (file: string) => file === devAcp || file === node,
        execPath: packaged,
        electron: true,
      },
    });
    assert.equal(spec.command, node);
    assert.equal(spec.env?.CLAUDE_CODE_EXECUTABLE, undefined);
  } finally {
    if (previous.url === undefined) delete process.env.WORKHORSE_BRIDGE_URL;
    else process.env.WORKHORSE_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.WORKHORSE_BRIDGE_TOKEN;
    else process.env.WORKHORSE_BRIDGE_TOKEN = previous.token;
  }
});

test("an expired or unusable credential is not a login", () => {
  const home = "/Users/me";
  const claudeHome = "/Users/me/.claude";
  const credPath = path.join(claudeHome, ".credentials.json");
  const now = 1_755_000_000_000;
  const creds = (extra: Record<string, unknown>) =>
    JSON.stringify({ claudeAiOauth: { accessToken: "tok-xxxxxxxx", ...extra } });

  // The case that shipped: a token three months dead still read as connected.
  assert.equal(
    hasClaudeLoginArtifact(claudeHome, home, (f) => f === credPath, () => creds({ expiresAt: now - 1 }), {}, "darwin", now, () => false),
    false,
  );
  assert.equal(
    hasClaudeLoginArtifact(claudeHome, home, (f) => f === credPath, () => creds({ expiresAt: now + 60_000 }), {}, "darwin", now, () => false),
    true,
  );
  // No expiry recorded means unknown, not dead.
  assert.equal(
    hasClaudeLoginArtifact(claudeHome, home, (f) => f === credPath, () => creds({}), {}, "darwin", now, () => false),
    true,
  );
  // An explicit key still wins over a dead file.
  assert.equal(
    hasClaudeLoginArtifact(
      claudeHome, home, (f) => f === credPath, () => creds({ expiresAt: now - 1 }),
      { ANTHROPIC_API_KEY: "sk-test" }, "darwin", now, () => false,
    ),
    true,
  );

  // Claude Desktop logged in, but its token is DPAPI-encrypted. Off Windows we
  // cannot read it, so it is not a login this desk can use.
  const macConfig = path.join(home, "Library", "Application Support", "Claude", "config.json");
  assert.equal(
    hasClaudeLoginArtifact(
      claudeHome, home, (f) => f === macConfig,
      () => JSON.stringify({ "oauth:tokenCacheV2": "cache-value" }), {}, "darwin", now, () => false,
    ),
    false,
  );

  assert.equal(oauthNotExpired({ expiresAt: now - 1 }, now), false);
  assert.equal(oauthNotExpired({ expiresAt: now + 1 }, now), true);
  assert.equal(oauthNotExpired({}, now), true);
  assert.equal(oauthNotExpired(null, now), false);
});

test("a Mac login lives in the keychain, not in the credentials file", () => {
  const home = "/Users/me";
  const claudeHome = "/Users/me/.claude";
  const credPath = path.join(claudeHome, ".credentials.json");
  const now = 1_755_000_000_000;
  // The real shape on a Mac: the CLI writes the keychain and leaves an old
  // file behind. Reading only the file calls a signed-in user signed out.
  const staleFile = () => JSON.stringify({ claudeAiOauth: { accessToken: "tok-xxxxxxxx", expiresAt: now - 1 } });

  assert.equal(
    hasClaudeLoginArtifact(claudeHome, home, (f) => f === credPath, staleFile, {}, "darwin", now, () => true),
    true,
  );
  assert.equal(
    hasClaudeLoginArtifact(claudeHome, home, (f) => f === credPath, staleFile, {}, "darwin", now, () => false),
    false,
  );
  // Windows keeps using the file, so the keychain probe must not be consulted.
  let asked = false;
  hasClaudeLoginArtifact(claudeHome, home, () => false, () => "", {}, "win32", now, () => {
    asked = true;
    return true;
  });
  assert.equal(asked, false);
});
