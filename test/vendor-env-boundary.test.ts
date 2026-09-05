import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildClaudeLaunchSpec, claudeSpawnArgs } from "../electron/claude-launch";
import { detectClaudeLogin } from "../electron/claude-login";
import { setStoredClaudeTokenReader, storedClaudeToken } from "../electron/claude-stored-token";
import { codexSpawnArgs } from "../electron/codex-launch";
import { cursorSpawnArgs } from "../electron/cursor-launch";
import { VENDOR_LOGIN_ENV_NAMES, withDeskToolEnv, withoutWorkhorsePrivateEnv } from "../electron/desk-path";
import type { CodexLaunchSpec } from "../electron/codex-launch";
import type { GrokLaunchSpec } from "../electron/grok-launch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Not a real token. The law under test is that no vendor child may read
 * another vendor's login, so the value only has to be findable.
 */
const CLAUDE_TOKEN = "sk-ant-oat01-FAKE-FOR-TEST";
const BRIDGE_TOKEN = "bridge-fake-for-test";

const HOME = "/Users/someone";
const BIN = "/opt/homebrew/bin";
const ACP = `${BIN}/claude-agent-acp`;
const CLI = `${BIN}/claude`;

const onDisk = (...files: string[]) => (file: string) => files.includes(file.split(path.sep).join("/"));

const detect = {
  homedir: HOME,
  platform: "darwin" as NodeJS.Platform,
  env: { PATH: "/usr/bin:/bin", CLAUDE_ACP_BIN: ACP },
  existsSync: onDisk(ACP, CLI),
  readFile: () => "",
  keychainHasLogin: () => false,
};

function claudeSpec(storedToken: () => string | null) {
  return buildClaudeLaunchSpec({
    model: "claude-sonnet-5",
    effort: "medium",
    cwd: HOME,
    mode: "ask",
    detect,
    storedToken,
  });
}

/** Codex and Cursor read `spec.command`/`argv`/`cwd`/`env`; nothing else is needed to build their env. */
const plainSpec = { command: "codex", argv: ["acp"], cwd: HOME } as unknown as CodexLaunchSpec;
const cursorSpec = { command: "cursor-agent", argv: ["--acp"], cwd: HOME } as unknown as GrokLaunchSpec;

/**
 * The seam this covers: not a shared file and not a shared login directory, but
 * the desk's own `process.env`. Workhorse holds the user's Claude token in its
 * encrypted vault; it used to copy that token onto `process.env`, which every
 * vendor child inherits, so a Codex, Cursor or Grok chat could print it — and
 * so could every MCP server and shell those agents started. BIBLE.md:57,
 * "Logins, context, tools, and sandboxes never pool across vendors."
 */
test("a vendor login reaches its own vendor and no other", () => {
  const before = { oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY, bridge: process.env.WORKHORSE_BRIDGE_TOKEN };
  // A desk with the Claude token and the bridge credential on its environment,
  // which is the state the app used to run in for its whole life.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api-FAKE-FOR-TEST";
  process.env.WORKHORSE_BRIDGE_TOKEN = BRIDGE_TOKEN;
  try {
    for (const [vendor, spawned] of [
      ["Codex", codexSpawnArgs(plainSpec)],
      ["Cursor", cursorSpawnArgs(cursorSpec)],
    ] as const) {
      for (const name of VENDOR_LOGIN_ENV_NAMES) {
        assert.equal(spawned.env[name], undefined, `${vendor} must not be handed ${name}`);
      }
      assert.equal(spawned.env.WORKHORSE_BRIDGE_TOKEN, undefined, `${vendor} must not be handed the desk bridge token`);
      assert.ok(spawned.env.PATH, `${vendor} still gets the desk PATH`);
    }

    // Grok builds the same env inline, so the filter is what to hold it to.
    const grokEnv = withDeskToolEnv(withoutWorkhorsePrivateEnv(process.env));
    assert.equal(grokEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(grokEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(grokEnv.WORKHORSE_BRIDGE_TOKEN, undefined);

    // Claude's own child is the one process that gets Claude's login.
    const claude = claudeSpawnArgs(claudeSpec(() => CLAUDE_TOKEN));
    assert.equal(claude.env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN, "Claude must still be able to sign in");
    assert.equal(claude.env.WORKHORSE_BRIDGE_TOKEN, undefined, "Claude is not handed the desk bridge token either");
  } finally {
    restore("CLAUDE_CODE_OAUTH_TOKEN", before.oauth);
    restore("ANTHROPIC_API_KEY", before.key);
    restore("WORKHORSE_BRIDGE_TOKEN", before.bridge);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("the vault token goes on the Claude spec, never on the shared environment", () => {
  const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const spec = claudeSpec(() => CLAUDE_TOKEN);
    assert.equal(spec.env?.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN);
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "building a launch must not write to the desk environment");

    // No vault token and nothing in the outer environment is no token at all,
    // rather than a stale one from another chat.
    const empty = claudeSpec(() => null);
    assert.equal(empty.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    restore("CLAUDE_CODE_OAUTH_TOKEN", before);
  }

  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.doesNotMatch(main, /process\.env\.CLAUDE_CODE_OAUTH_TOKEN\s*=/, "the desk must not carry a vendor login on process.env");
});

/** Sign-in on this desk still counts as a login once the environment stops carrying it. */
test("the desk's own stored token is a Claude login", () => {
  const signedOut = detectClaudeLogin({ ...detect, storedToken: () => null });
  assert.equal(signedOut.connected, false, "no artifact and no vault row is not a login");
  assert.equal(signedOut.needsAuth, true);

  const signedIn = detectClaudeLogin({ ...detect, storedToken: () => CLAUDE_TOKEN });
  assert.equal(signedIn.connected, true, "the token the user gave Workhorse is a login");
  assert.equal(signedIn.needsAuth, false);
});

test("the stored-token reader is registered, not read off the machine", () => {
  assert.equal(storedClaudeToken(), null, "no reader registered means no token");
  try {
    setStoredClaudeTokenReader(() => `  ${CLAUDE_TOKEN}  `);
    assert.equal(storedClaudeToken(), CLAUDE_TOKEN, "trimmed");
    setStoredClaudeTokenReader(() => "   ");
    assert.equal(storedClaudeToken(), null, "blank is no token");
    setStoredClaudeTokenReader(() => {
      throw new Error("vault locked");
    });
    assert.equal(storedClaudeToken(), null, "a locked vault is no login, not a crash");
  } finally {
    setStoredClaudeTokenReader(() => null);
  }
});

/**
 * The terminal was the one spawn on the desk that skipped the filter every
 * vendor launch uses, so `printenv WORKHORSE_BRIDGE_TOKEN` in the built-in
 * Terminal printed the credential that authenticates calls into Workhorse.
 */
test("no shell the desk starts for a person or an agent gets the desk's own environment", () => {
  // The terminal a person opens in a chat.
  const terminal = readFileSync(path.join(ROOT, "electron", "terminal-host.ts"), "utf8");
  assert.match(terminal, /env: withDeskToolEnv\(withoutWorkhorsePrivateEnv\(process\.env\)\)/);
  assert.doesNotMatch(terminal, /env: process\.env/, "the raw desk environment is what leaked the bridge token");

  // The shell a custom bot writes through run_command. It had no `env` at all,
  // so it inherited everything the desk holds.
  const tools = readFileSync(path.join(ROOT, "electron", "custom-tools.ts"), "utf8");
  assert.match(tools, /env: withDeskToolEnv\(withoutWorkhorsePrivateEnv\(process\.env\)\)/);

  const shellEnv = withDeskToolEnv(
    withoutWorkhorsePrivateEnv({
      PATH: "/usr/bin",
      HOME,
      WORKHORSE_BRIDGE_TOKEN: BRIDGE_TOKEN,
      WORKHORSE_BRIDGE_URL: "http://127.0.0.1:1",
      WORKHORSE_STATE_PATH: "/state",
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
    }),
  );
  assert.equal(shellEnv.WORKHORSE_BRIDGE_TOKEN, undefined);
  assert.equal(shellEnv.WORKHORSE_BRIDGE_URL, undefined);
  assert.equal(shellEnv.WORKHORSE_STATE_PATH, undefined);
  assert.equal(shellEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(shellEnv.HOME, HOME, "the person's own login environment stays");
});
