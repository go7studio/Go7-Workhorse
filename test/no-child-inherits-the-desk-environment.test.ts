import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setupTokenEnv } from "../electron/claude-auth";
import { buildClaudeLaunchSpec, claudeSpawnArgs } from "../electron/claude-launch";
import { keychainToolEnv } from "../electron/claude-plan";
import { codexAppServerEnv } from "../electron/codex-app-server";
import { cursorProbeEnv } from "../electron/cursor-login";
import { deskGitEnv, deskHelperEnv, deskToolEnv } from "../electron/desk-path";
import { shimKeepaliveEnv, shimSpawnEnv } from "../electron/grok-bot-shim-host";
import { mcpSpawnEnvironment } from "../electron/mcp-tool-bridge";
import { groupRunEnv, processToolEnv } from "../electron/process-registry";
import { projectGitEnv } from "../electron/project-diff";
import { cursorModelsEnv } from "../electron/vendor-models";
import { runtimeProbeEnv } from "../electron/workhorse-mcp";
import { worktreeGitEnv } from "../electron/worktree-host";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(ROOT, "electron", file), "utf8");

/**
 * None of these is real. The law under test is that a name on the desk's own
 * environment does not reach a child, so the values only have to be findable.
 */
const BRIDGE_TOKEN = "bridge-fake-for-test";
const CLAUDE_TOKEN = "sk-ant-oat01-FAKE-FOR-TEST";
const ANTHROPIC_KEY = "sk-ant-api03-FAKE-FOR-TEST";

/** The three names no child may carry out of `process.env`. */
const PRIVATE_NAMES = ["WORKHORSE_BRIDGE_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/**
 * The desk's environment as it really is while the app runs: a bridge token
 * the MCP calls authenticate with, and the Claude login the vault put there.
 * Restored by every caller, because the test runner shares one process.
 */
function withDeskSecretsOnProcessEnv<T>(body: () => T): T {
  const before = PRIVATE_NAMES.map((name) => [name, process.env[name]] as const);
  process.env.WORKHORSE_BRIDGE_TOKEN = BRIDGE_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_TOKEN;
  process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY;
  try {
    return body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function assertCarriesNoDeskSecret(label: string, env: NodeJS.ProcessEnv): void {
  for (const name of PRIVATE_NAMES) {
    assert.equal(env[name], undefined, `${label} carried ${name} to its child`);
  }
  const found = Object.entries(env)
    .filter(([, value]) => value === BRIDGE_TOKEN || value === CLAUDE_TOKEN || value === ANTHROPIC_KEY)
    .map(([name]) => name);
  assert.deepEqual(found, [], `${label} carried a desk secret under ${found.join(", ")}`);
}

/**
 * The seam this covers. PR #248 took the Claude token off `process.env` and
 * put the terminal and the run_command shell behind a filter. It left every
 * other child alone: the worktree sweep's `git`, the diff panes' `git`, the
 * reaper's `ps` and `taskkill`, the Cursor probes, the model listing, the
 * runtime detection, the MCP device probes, the keychain reads — and two
 * detached children, the Grok Bot shim and the macOS update script, which
 * outlive the desk and so hold whatever they were handed with nobody left
 * watching. Each one inherited the whole environment, so each one could read
 * the bridge token that authenticates calls into Workhorse and the Claude
 * login the desk keeps in its vault for one vendor only.
 *
 * Logins, tools and sandboxes never pool across vendors. A child gets either
 * the filter — the person's PATH and shell without the desk's private names —
 * or a named list, and a detached child always gets the list.
 */
test("no builder behind a desk child hands it the desk's own secrets", () => {
  withDeskSecretsOnProcessEnv(() => {
    // What the child used to get, so a passing run below means something.
    assert.throws(
      () => assertCarriesNoDeskSecret("a raw inherit", { ...process.env }),
      /carried WORKHORSE_BRIDGE_TOKEN/,
      "the check itself cannot see a raw process.env, so it proves nothing",
    );

    /*
     * Each call below is the shape its own spawn uses. That is the whole point
     * of the list: calling a builder with no argument when the live path hands
     * it one tests an env the child never receives. `cursorModelsEnv` is where
     * that mattered — `listVendorModels()` defaults its `env` to `process.env`
     * and passes it down, so the live call overlays the environment onto
     * itself, and a no-argument call looked clean while the child was handed
     * the desk's whole environment.
     */
    const builders: Array<[string, NodeJS.ProcessEnv]> = [
      // The filter: person-facing programs that need PATH and shell settings.
      ["deskToolEnv", deskToolEnv()],
      ["deskGitEnv", deskGitEnv()],
      ["worktree-host worktreeGitEnv", worktreeGitEnv()],
      ["project-diff projectGitEnv", projectGitEnv()],
      ["process-registry groupRunEnv", groupRunEnv()],
      ["cursor-login cursorProbeEnv", cursorProbeEnv()],
      // listVendorModels() → readInstalledCursorModels(process.env) → here.
      ["vendor-models cursorModelsEnv", cursorModelsEnv(process.env)],
      ["codex-app-server codexAppServerEnv", codexAppServerEnv()],
      ["workhorse-mcp runtimeProbeEnv", runtimeProbeEnv()],
      ["claude-auth setupTokenEnv", setupTokenEnv()],
      // The named list: the desk's own helpers, and every detached child.
      ["deskHelperEnv", deskHelperEnv()],
      ["process-registry processToolEnv", processToolEnv()],
      ["claude-plan keychainToolEnv", keychainToolEnv()],
      // grok-bot-shim-host passes the user-data path, and only that.
      ["grok-bot-shim shimSpawnEnv", shimSpawnEnv("/tmp/workhorse-user-data")],
      ["grok-bot-shim shimKeepaliveEnv", shimKeepaliveEnv()],
      // Already a named list before this change; it stays one. The live call
      // passes the saved server row, whose `env` the person configured.
      ["mcp-tool-bridge mcpSpawnEnvironment", mcpSpawnEnvironment({ env: { MY_SERVER_FLAG: "1" } })],
    ];
    for (const [label, env] of builders) assertCarriesNoDeskSecret(label, env);
  });
});

/**
 * The bug this test exists to keep out. Filtering the base and then overlaying
 * `extra` reads as safe and is not, because `extra` is sometimes the very
 * environment that was just filtered — `listVendorModels()` defaults its `env`
 * to `process.env` and hands it down to the `cursor-agent models` child. So
 * the filter runs over the merge, and an overlay cannot restore a private name
 * however the caller spells it.
 */
test("an overlay cannot put back what the filter took out", () => {
  withDeskSecretsOnProcessEnv(() => {
    for (const [label, env] of [
      ["deskToolEnv over itself", deskToolEnv(process.env, process.env)],
      ["deskGitEnv over itself", deskGitEnv(process.env, process.env)],
      ["cursorModelsEnv, the live argument", cursorModelsEnv(process.env)],
      ["cursorModelsEnv, a named poison", cursorModelsEnv({ ANTHROPIC_API_KEY: ANTHROPIC_KEY })],
    ] as const) {
      assertCarriesNoDeskSecret(label, env);
    }
    // The overlay still does its job for a name that is nobody's login.
    assert.equal(deskToolEnv(process.env, { NO_BROWSER: "" }).NO_BROWSER, "");
    assert.equal(worktreeGitEnv().GIT_OPTIONAL_LOCKS, "0");
    // And git's own setting is not a caller's to turn off.
    assert.equal(deskGitEnv(process.env, { GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT, "0");
  });
});

/** A filtered child still has to be able to run: PATH survives the filter. */
test("the filter keeps what a person's program needs", () => {
  withDeskSecretsOnProcessEnv(() => {
    process.env.WORKHORSE_STATE_PATH = "/tmp/should-not-travel";
    const tool = deskToolEnv();
    assert.ok((tool.PATH ?? "").length > 0, "a vendor CLI cannot resolve without PATH");
    assert.equal(tool.WORKHORSE_STATE_PATH, undefined, "a WORKHORSE_ name reached a vendor child");
    delete process.env.WORKHORSE_STATE_PATH;
  });
});

/**
 * Git is a person's program. An allowlist would drop their SSH agent and
 * their credential helper, and the sweep would then sit at a password prompt
 * nobody is watching — so it takes the filter, plus the one setting the desk
 * owns.
 */
test("a git child keeps SSH and credentials and never gets a terminal prompt", () => {
  withDeskSecretsOnProcessEnv(() => {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GIT_SSH_COMMAND: "ssh -i /dev/null",
      GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
    };
    for (const [label, env] of [
      ["deskGitEnv", deskGitEnv(base)],
      ["worktreeGitEnv", worktreeGitEnv(base)],
      ["projectGitEnv", projectGitEnv(base)],
    ] as const) {
      assert.equal(env.GIT_TERMINAL_PROMPT, "0", `${label} let git stop and ask for a password`);
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/ssh-agent.sock", `${label} dropped the person's SSH agent`);
      assert.equal(env.GIT_SSH_COMMAND, "ssh -i /dev/null", `${label} dropped GIT_SSH_COMMAND`);
      assert.equal(env.GIT_CONFIG_GLOBAL, "/tmp/gitconfig", `${label} dropped the person's git config`);
      assertCarriesNoDeskSecret(label, env);
    }
    assert.equal(worktreeGitEnv(base).GIT_OPTIONAL_LOCKS, "0");
  });
});

/**
 * An allowlist is a list of names, not a spread with a few names taken off.
 * A helper gets what it needs to start and nothing that belongs to anyone.
 */
test("a named list admits by name, so an unknown name never travels", () => {
  const helper = deskHelperEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/someone",
    SystemRoot: "C:\\Windows",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    LC_TIME: "en_GB.UTF-8",
    AWS_SECRET_ACCESS_KEY: "not-the-desk's-to-pass-on",
    OPENAI_API_KEY: "nor-this",
    WORKHORSE_BRIDGE_TOKEN: BRIDGE_TOKEN,
  });
  assert.equal(helper.PATH, "/usr/bin:/bin", "powershell.exe and reg.exe resolve through PATH");
  assert.equal(helper.HOME, "/Users/someone");
  assert.equal(helper.SystemRoot, "C:\\Windows", "a Windows helper loads its runtime from SystemRoot");
  assert.equal(helper.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(helper.LC_TIME, "en_GB.UTF-8", "LC_* is how the person's locale reaches a helper");
  assert.equal(helper.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(helper.OPENAI_API_KEY, undefined);
  assert.equal(helper.WORKHORSE_BRIDGE_TOKEN, undefined);

  // The shim names the two it needs. Nothing else Workhorse-shaped goes with it.
  const shim = shimSpawnEnv("/Users/someone/workhorse", {
    PATH: "/usr/bin:/bin",
    WORKHORSE_BRIDGE_TOKEN: BRIDGE_TOKEN,
    WORKHORSE_MCP_SCRIPT: "/somewhere/workhorse-mcp.js",
  });
  assert.equal(shim.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(shim.WORKHORSE_USER_DATA, "/Users/someone/workhorse");
  assert.equal(shim.WORKHORSE_BRIDGE_TOKEN, undefined);
  assert.equal(shim.WORKHORSE_MCP_SCRIPT, undefined);
});

/**
 * The one exception, and the reason there is a filter at all: Claude's own
 * launch spec puts the Claude token back, on the one process it belongs to.
 * If this ever stops carrying it, the filter has gone too far and Claude
 * cannot sign in.
 */
test("the Claude launch spec is the only env that carries the Claude token", () => {
  const HOME = "/Users/someone";
  const BIN = "/opt/homebrew/bin";
  const ACP = `${BIN}/claude-agent-acp`;
  const CLI = `${BIN}/claude`;
  withDeskSecretsOnProcessEnv(() => {
    const spec = buildClaudeLaunchSpec({
      model: "claude-sonnet-5",
      effort: "medium",
      cwd: HOME,
      mode: "ask",
      detect: {
        homedir: HOME,
        platform: "darwin",
        env: { PATH: "/usr/bin:/bin", CLAUDE_ACP_BIN: ACP },
        existsSync: (file: string) => [ACP, CLI].includes(file.split(path.sep).join("/")),
        readFile: () => "",
        keychainHasLogin: () => false,
      },
      storedToken: () => CLAUDE_TOKEN,
    });
    const claude = claudeSpawnArgs(spec).env;
    assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN, "Claude lost its own login");
    assert.equal(claude.WORKHORSE_BRIDGE_TOKEN, undefined, "Claude read the desk's bridge token");
  });
});

/**
 * Two modules import `electron`, so no test can load them and call their
 * builders. Their call sites are read instead, which is what the rest of the
 * suite does for `main.ts`.
 */
test("the two modules a test cannot load still pass a builder at every child", () => {
  const update = source("app-update.ts");
  assert.match(update, /import \{ deskGitEnv, deskHelperEnv, deskToolEnv \} from "\.\/desk-path"/);
  // The installer's own children keep the allowlist, including the detached one.
  assert.match(update, /env: NodeJS\.ProcessEnv = deskHelperEnv\(\),/);
  assert.match(update, /spawn\("\/bin\/bash", \[helper\], \{[\s\S]*?env: deskHelperEnv\(\),/);
  /*
   * Updating a source checkout is a different job: `git fetch` over SSH needs
   * the person's agent, and `npm install` needs a PATH that can find npm.
   * Every command on that path takes the git env, not the allowlist.
   */
  assert.match(update, /function sourceUpdateEnv\(\): NodeJS\.ProcessEnv \{\s*return deskGitEnv\(deskToolEnv\(\)\);/);
  for (const command of [
    /await run\("git", \["fetch", "origin", "tag", tag, "--force"\], root, 120_000, sourceEnv\)/,
    /await run\("git", \["fetch", "origin", "--tags", "--force"\], root, 120_000, sourceEnv\)/,
    /await run\("git", \["merge", "--ff-only", tag\], root, 120_000, sourceEnv\)/,
    /await run\("git", \["checkout", tag\], root, 120_000, sourceEnv\)/,
    /await run\(npm, \["install"\], root, 300_000, sourceEnv\)/,
  ]) {
    assert.match(update, command);
  }
  assert.doesNotMatch(update, /\.\.\.process\.env/);

  const main = source("main.ts");
  assert.match(main, /runInProcessGroup\(file, args, \{[\s\S]*?env: deskToolEnv\(\),/);
  assert.equal(
    main.match(/spawnSync\(file, args, \{[\s\S]*?env: deskToolEnv\(\),/g)?.length,
    2,
    "runtime detection and the MCP install both spawn, and both need the filter",
  );
  assert.doesNotMatch(main, /\.\.\.process\.env/);
});

/**
 * The check that survives the next new call site: no module under electron/
 * may hand a child the whole environment again, however it spells it.
 */
test("no spawn under electron/ passes process.env raw", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(path.join(ROOT, "electron")).filter((name) => name.endsWith(".ts"))) {
    const text = source(file);
    if (/env:\s*process\.env\b/.test(text)) offenders.push(`${file} (env: process.env)`);
    if (/env:\s*\{\s*\.\.\.process\.env/.test(text)) offenders.push(`${file} (env: { ...process.env })`);
  }
  assert.deepEqual(offenders, [], "these hand a child the desk's whole environment");
});
