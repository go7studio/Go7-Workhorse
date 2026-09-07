import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildClaudeLaunchSpec, claudeSpawnArgs } from "../electron/claude-launch";
import { detectClaudeLogin } from "../electron/claude-login";
import { claudeTokenProblem, forgetClaudeRefusalWithoutToken, markClaudeTokenRejected, resetClaudeTokenRejection, setStoredClaudeTokenReader, storedClaudeToken } from "../electron/claude-stored-token";
import { claudeAuthFailure } from "../src/lib/claude-auth-failure";
import { normalizeSettings, vendorLaunchGate } from "../src/lib/settings";
import { deskCallCatalog, formatDeskRoster, spawnIsNoGo } from "../src/lib/watch";
import { routingCandidatesForDesk } from "../src/lib/routing";
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

/**
 * Seen 2026-09-07: the desk's own setup-token credential expired, every Claude
 * call failed with "OAuth session expired and could not be refreshed", and the
 * card still read On · Local login with the sign-in button hidden — detection
 * counted the dead token as a login and never asked whether it worked.
 */
test("a login the vendor refused is not a login until a different token is stored", async () => {
  const refused = "OAuth session expired and could not be refreshed";
  const dead = detectClaudeLogin({ ...detect, storedToken: () => CLAUDE_TOKEN, tokenProblem: refused });
  assert.equal(dead.connected, false, "a refused token is not a login, whatever artifact exists");
  assert.equal(dead.needsAuth, true, "so the card offers Log in with Claude");
  assert.equal(dead.authProblem, refused);
  assert.equal(dead.launchable, true, "the binaries are still there; only the login is the problem");
  const fine = detectClaudeLogin({ ...detect, storedToken: () => CLAUDE_TOKEN, tokenProblem: null });
  assert.equal(fine.connected, true);
  assert.equal(fine.authProblem, undefined);

  // The memory is keyed to the token that was refused: a new token clears it
  // on its own, and no reader is touched on this machine.
  try {
    markClaudeTokenRejected(refused, "token-one");
    assert.equal(claudeTokenProblem("token-one"), refused);
    assert.equal(claudeTokenProblem("token-two"), null, "a different token is a fresh start");
    assert.equal(claudeTokenProblem(null), null);
    markClaudeTokenRejected("not logged in", null);
    assert.equal(claudeTokenProblem(null), "not logged in", "a refused CLI login with no desk token is remembered too");
    assert.equal(claudeTokenProblem("token-three"), null);
    markClaudeTokenRejected("   ", "token-one");
    assert.equal(claudeTokenProblem("token-one"), null, "a blank reason is no refusal");
  } finally {
    resetClaudeTokenRejection();
  }
  assert.equal(claudeTokenProblem("token-one"), null);

  // The classifier is narrow: only a refused login sends the person to sign in.
  const desk = new Error("Error invoking remote method 'claude:prompt': Error: Internal error: Failed to authenticate: OAuth session expired and could not be refreshed");
  assert.equal(claudeAuthFailure(desk), refused, "the reason is the vendor's own line, without the plumbing");
  assert.equal(claudeAuthFailure("Not logged in. Run claude login."), "Not logged in. Run claude login.");
  assert.equal(claudeAuthFailure(new Error("authentication_error: invalid x-api-key")), "authentication_error: invalid x-api-key");
  assert.equal(claudeAuthFailure(new Error("Rate limit reached for this hour")), null);
  assert.equal(claudeAuthFailure(new Error("Prompt is too long: 1,200,000 tokens > 1,000,000")), null);
  assert.equal(claudeAuthFailure(new Error("read ECONNRESET")), null);
  assert.equal(claudeAuthFailure(undefined), null);

  // The reason survives settings normalisation and reaches the card.
  const settings = normalizeSettings({ llms: { claude: { connected: true, needsAuth: true, authProblem: ` ${refused} ` } } });
  assert.equal(settings.llms.claude.authProblem, refused);
  assert.equal(normalizeSettings({ llms: { claude: { connected: true, authProblem: "   " } } }).llms.claude.authProblem, undefined);
  const { llmCardHint, llmDetailCopy } = await import("../src/lib/llm-copy");
  // On the desk the card stays connected (it exists); detection drops available and raises needsAuth.
  const link = { connected: true, enabled: true, available: false, needsAuth: true, authProblem: refused };
  assert.equal(llmCardHint("claude", link), "Sign in again");
  assert.match(llmDetailCopy("claude", link), /refused the desk's login: OAuth session expired and could not be refreshed\. Log in with Claude mints a new one\./);
  assert.equal(llmCardHint("claude", { connected: true, enabled: true, available: true }), "Local login", "a working login reads as before");

  // The refusal is remembered where it passes through main, and the renderer
  // re-detects the moment a call is refused, so no Recheck is needed.
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8").replace(/\r\n/g, "\n");
  const handler = main.slice(main.indexOf('ipcMain.handle("claude:prompt"'), main.indexOf('ipcMain.handle("claude:answer-permission"'));
  assert.match(handler, /const problem = claudeAuthFailure\(error\);\n\s+if \(problem\) markClaudeTokenRejected\(problem\);\n\s+throw error;/, "a refused login is remembered, and the error still reaches the chat");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.equal((store.match(/if \(claudeAuthFailure\(error\)\) refreshClaudeLogin\(\);/g) ?? []).length, 2, "both Claude prompt paths re-detect on a refusal");
  assert.match(store, /authProblem: \(detected as \{ authProblem\?: string \}\)\.authProblem,/, "the reason reaches settings.llms.claude");
});

/**
 * Gate findings on the first cut: the card said Sign in again while routing
 * and Link still offered the vendor, because the store never writes
 * `connected` from detection; and a refusal of the CLI login (no desk token)
 * stayed until a restart.
 */
test("a vendor with no usable login is not callable, and Recheck clears a refusal of the CLI login", async () => {
  const refused = "OAuth session expired and could not be refreshed";
  // No usable login is a launch gate, whatever binaries are on disk.
  assert.deepEqual(vendorLaunchGate({ launchable: true, needsAuth: true, authProblem: refused }), {
    launchable: false,
    launchBlocker: `The desk's login was refused: ${refused}. Sign in again`,
  });
  assert.deepEqual(vendorLaunchGate({ needsAuth: true }), { launchable: false, launchBlocker: "Not signed in. Sign in, then Recheck" });
  assert.deepEqual(vendorLaunchGate({ launchable: true, needsAuth: false }), { launchable: true, launchBlocker: undefined });
  assert.deepEqual(vendorLaunchGate({}), {}, "a detect that reports nothing still returns nothing");

  const settings = normalizeSettings({
    llms: {
      claude: { connected: true, enabled: true, available: false, needsAuth: true, authProblem: refused, launchable: false, launchBlocker: `The desk's login was refused: ${refused}. Sign in again` },
      codex: { connected: true, enabled: true, available: true, launchable: true },
    },
  });
  // The call catalog Link and canCall read says no, and why.
  const rows = deskCallCatalog({ settings, usage: [], plans: {}, permits: {} });
  const claude = rows.find((row) => row.provider === "claude");
  assert.equal(claude?.canCall, false, "a refused login is not a callable vendor");
  assert.equal(claude?.status, "cannot_start", "its own code: attached and on, but nothing can launch");
  assert.match(claude?.reason ?? "", /login was refused: OAuth session expired and could not be refreshed\. Sign in again/);
  const codex = rows.find((row) => row.provider === "codex");
  assert.notEqual(codex?.reason ?? "", claude?.reason, "the gate is per vendor");
  // The Link roster keeps the vendor and says why, instead of hiding it as unattached.
  const roster = formatDeskRoster(rows);
  assert.match(roster, /- Claude — .*login was refused: OAuth session expired and could not be refreshed\. Sign in again/);
  assert.doesNotMatch(roster.split("\n").find((line) => line.startsWith("- Claude")) ?? "", /you can call this/);
  // A refused spawn tells the harness to skip, not to ask for Allow.
  assert.match(spawnIsNoGo(claude) ?? "", /login was refused: .* Sign in again Skip it\. Do not ask the user to Allow\./);
  // The card copy for every unsigned state names the way in, and never says Install.
  const { llmDetailCopy } = await import("../src/lib/llm-copy");
  const unsigned = { connected: true, enabled: true, available: false, needsAuth: true, launchable: false, launchBlocker: "Not signed in. Sign in, then Recheck" };
  assert.equal(llmDetailCopy("claude", unsigned), "Not signed in. Log in with Claude mints a token for this desk.");
  assert.equal(llmDetailCopy("cursor", unsigned), "Sign in to Cursor Agent, then Recheck.");
  assert.equal(llmDetailCopy("codex", unsigned), "Not signed in. Sign in, then Recheck.");
  for (const id of ["claude", "cursor", "codex", "grok"] as const) assert.doesNotMatch(llmDetailCopy(id, unsigned), /Install/);
  assert.equal(llmDetailCopy("claude", { connected: true, enabled: true, available: true, launchable: false, launchBlocker: "claude-agent-acp is not on PATH" }), "claude-agent-acp is not on PATH. Install it, then Recheck.", "a missing binary still says Install");
  // Routing carries the gate on every Claude candidate, so Auto never picks it and the miss names it.
  const candidates = routingCandidatesForDesk(settings).filter((candidate) => candidate.provider === "claude");
  assert.ok(candidates.length > 0, "the vendor still appears, so the miss can name it");
  assert.ok(candidates.every((candidate) => candidate.launchable === false && /login was refused/.test(candidate.launchBlocker ?? "")));
  assert.ok(routingCandidatesForDesk(settings).filter((candidate) => candidate.provider === "codex").every((candidate) => candidate.launchable !== false));

  // Recheck clears a refusal of the CLI login (no desk token); one keyed to a
  // desk token stays until a different token is stored.
  try {
    markClaudeTokenRejected("not logged in", null);
    forgetClaudeRefusalWithoutToken();
    assert.equal(claudeTokenProblem(null), null, "Recheck after `claude login` is the person's word");
    markClaudeTokenRejected(refused, "token-one");
    forgetClaudeRefusalWithoutToken();
    assert.equal(claudeTokenProblem("token-one"), refused, "a refused desk token does not clear on Recheck");
  } finally {
    resetClaudeTokenRejection();
  }
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8").replace(/\r\n/g, "\n");
  const detectHandler = main.slice(main.indexOf('ipcMain.handle("claude:detect-login"'), main.indexOf('ipcMain.handle("claude:setup-token"'));
  assert.match(detectHandler, /input\.recheck === true\) forgetClaudeRefusalWithoutToken\(\);/, "only Recheck's word clears it, not the desk's own re-detect");
  const settingsUi = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8").replace(/\r\n/g, "\n");
  assert.match(settingsUi, /store\.refreshClaudeLogin\(\{ recheck: true \}\)/, "the Recheck button says so");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(preload, /ipcRenderer\.invoke\("claude:detect-login", input \?\? \{\}\)/);
});
