import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  findClaudeOauthToken,
  NEEDS_TERMINAL_MESSAGE,
  runClaudeSetupToken,
  setupTokenEnv,
} from "../electron/claude-auth";
import { ptyRunner, PTY_RELAY, stripTerminalCodes, wantsEnter } from "../electron/claude-pty";
import { claudeTokenComplaint, CLAUDE_SETUP_TOKEN_COMMAND, looksLikeClaudeToken } from "../src/lib/claude-token";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/** Not a real token. Only the shape is under test. */
const TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKE0123456789";
const ESC = "\u001b";

/**
 * Captured from `claude setup-token` 2.1.257 through the desk's own relay on
 * 2026-09-07: the real escape traffic, with no token in it because the flow
 * was stopped before anyone approved it.
 */
const CAPTURE = readFileSync(path.join(ROOT, "test", "fixtures", "claude-setup-token-pty.txt"), "utf8");

test("the terminal stream is stripped before anything is read out of it", () => {
  assert.ok(CAPTURE.includes(ESC), "the fixture is the raw terminal traffic");
  const plain = stripTerminalCodes(CAPTURE);
  assert.doesNotMatch(plain, new RegExp(ESC), "no escape survives");
  assert.match(plain.replace(/\s+/g, ""), /long-lived\(1-year\)authtokensetup/i, "the CLI's own words come through");
  assert.equal(findClaudeOauthToken(CAPTURE), null, "a run nobody approved carries no token");

  // The CLI places each word with a cursor escape rather than a space, and a
  // token can sit either side of one. Removing the escape must join the halves.
  const split = `${ESC}[2Gtoken:${ESC}[9G${TOKEN.slice(0, 20)}${ESC}[40G${TOKEN.slice(20)}${ESC}[0m\r\n`;
  assert.equal(findClaudeOauthToken(split), TOKEN, "a token written around a cursor move is still one token");
  assert.equal(findClaudeOauthToken(`${ESC}]0;a title${ESC}\\plain ${TOKEN}`), TOKEN, "a window title is not the token");
  assert.equal(findClaudeOauthToken("nothing here"), null);
  assert.equal(findClaudeOauthToken("sk-ant-short"), null);
});

test("the ENTER prompt is recognised even though the CLI writes no spaces", () => {
  assert.equal(wantsEnter(`${ESC}[2Gpress${ESC}[8GENTER${ESC}[14Gto${ESC}[17Gopen`), true);
  assert.equal(wantsEnter("Authenticate your account at (press ENTER to open in browser):"), true);
  assert.equal(wantsEnter(CAPTURE), false, "the browser opened on its own, so nothing was asked");
});

test("a desk that cannot make a terminal says so at once, and never spawns", () => {
  const noPython = { platform: "darwin" as NodeJS.Platform, pathDirs: ["/usr/bin"], existsSync: () => false };
  assert.equal(ptyRunner(["claude", "setup-token"], noPython), null);
  assert.equal(ptyRunner(["claude"], { platform: "win32", pathDirs: ["C:\\bin"], existsSync: () => true }), null, "Windows has no pty module");

  let spawned = 0;
  return runClaudeSetupToken({
    cli: "/bin/claude",
    pty: noPython,
    spawnFn: (() => {
      spawned += 1;
      throw new Error("must not spawn");
    }) as never,
  }).then((result) => {
    assert.equal(spawned, 0, "nothing is launched when there is no terminal to launch it in");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "needs_terminal");
    assert.equal(result.message, NEEDS_TERMINAL_MESSAGE);
  });
});

test("the runner picks a real python, never the Mac's install-prompt stub", () => {
  const onDisk = (...files: string[]) => (file: string) => files.includes(file);
  const stubOnly = ptyRunner(["claude"], {
    platform: "darwin",
    pathDirs: ["/usr/bin"],
    existsSync: onDisk("/usr/bin/python3"),
  });
  assert.equal(stubOnly, null, "clicking sign-in must not pop the developer-tools dialog");

  const withTools = ptyRunner(["claude", "setup-token"], {
    platform: "darwin",
    pathDirs: ["/usr/bin"],
    existsSync: onDisk("/usr/bin/python3", "/Library/Developer/CommandLineTools/usr/bin/python3"),
  });
  assert.equal(withTools?.command, "/usr/bin/python3", "with the tools installed it is a real python");

  const homebrew = ptyRunner(["claude", "setup-token"], {
    platform: "darwin",
    pathDirs: ["/opt/homebrew/bin", "/usr/bin"],
    existsSync: onDisk("/opt/homebrew/bin/python3", "/usr/bin/python3"),
  });
  assert.equal(homebrew?.command, "/opt/homebrew/bin/python3", "a python of its own is preferred, stub or not");
  assert.deepEqual(homebrew?.args, ["-c", PTY_RELAY, "claude", "setup-token"], "the child runs inside the relay");
  assert.match(PTY_RELAY, /pty\.fork\(\)/, "a real pseudo-terminal");
  assert.match(PTY_RELAY, /TIOCSWINSZ/, "sized wide so a long token is never wrapped");
});

/** A child that behaves like a spawned process, so no terminal is involved. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (text: string) => void };
    kill: () => void;
    killed: boolean;
    typed: string[];
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.typed = [];
  child.stdin = { write: (text: string) => child.typed.push(text) };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

const withPython = {
  platform: "linux" as NodeJS.Platform,
  pathDirs: ["/usr/bin"],
  existsSync: (file: string) => file === "/usr/bin/python3",
};

test("a silent start is called what it is, instead of holding a spinner for five minutes", async () => {
  const child = fakeChild();
  const result = await runClaudeSetupToken({
    cli: "/bin/claude",
    pty: withPython,
    quietMs: 5,
    timeoutMs: 60_000,
    spawnFn: (() => child) as never,
  });
  assert.equal(result.reason, "needs_terminal");
  assert.equal(result.message, NEEDS_TERMINAL_MESSAGE);
  assert.equal(child.killed, true, "and the silent process is stopped");
});

test("output keeps the flow alive, the prompt is answered, and the token comes back", async () => {
  const child = fakeChild();
  const streamed: string[] = [];
  const flow = runClaudeSetupToken({
    cli: "/bin/claude",
    pty: withPython,
    quietMs: 30,
    timeoutMs: 60_000,
    onOutput: (chunk) => streamed.push(chunk),
    spawnFn: (() => child) as never,
  });
  child.stdout.emit("data", Buffer.from(`${ESC}[2GAuthenticate${ESC}[15Gyour${ESC}[20Gaccount`));
  await new Promise((done) => setTimeout(done, 60));
  assert.equal(child.killed, false, "a flow that is talking is not a silent one");
  child.stdout.emit("data", Buffer.from(`${ESC}[2Gpress${ESC}[8GENTER${ESC}[14Gto${ESC}[17Gopen`));
  child.stdout.emit("data", Buffer.from(`${ESC}[2Gtoken:${ESC}[9G${TOKEN}\r\n`));
  child.emit("exit", 0);
  const result = await flow;
  assert.deepEqual(result, { ok: true, token: TOKEN });
  assert.deepEqual(child.typed, ["\n"], "the desk answers the prompt on the person's behalf");

  // What is streamed to the renderer is what a person could read over a
  // shoulder. The token is not that: the desk stores it and the card reads the
  // result, so the stream carries the words and never the credential.
  const streamedText = streamed.join("");
  assert.doesNotMatch(streamedText, /sk-ant-/, "the minted token never crosses to the renderer");
  assert.match(streamedText, /\[token hidden\]/, "and its place is marked");
  assert.match(streamedText.replace(/\s+/g, ""), /Authenticateyouraccount/, "the words do cross");
  assert.doesNotMatch(streamedText, new RegExp(ESC), "stripped of escapes on the way");
});

test("a token split across two chunks is never half-shown", async () => {
  const child = fakeChild();
  const streamed: string[] = [];
  const flow = runClaudeSetupToken({
    cli: "/bin/claude",
    pty: withPython,
    quietMs: 200,
    timeoutMs: 60_000,
    onOutput: (chunk) => streamed.push(chunk),
    spawnFn: (() => child) as never,
  });
  child.stdout.emit("data", Buffer.from(`token: ${TOKEN.slice(0, 18)}`));
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(streamed.join(""), "", "an unfinished line is held back, because half a token cannot be redacted");
  child.stdout.emit("data", Buffer.from(`${TOKEN.slice(18)}\n`));
  child.emit("exit", 0);
  assert.equal((await flow).token, TOKEN, "the desk still gets the whole token");
  assert.doesNotMatch(streamed.join(""), /FAKEFAKE/, "and the renderer never saw a piece of it");
});

test("a token printed as the clock runs out is a sign-in that worked", async () => {
  const child = fakeChild();
  const flow = runClaudeSetupToken({
    cli: "/bin/claude",
    pty: withPython,
    quietMs: 500,
    timeoutMs: 40,
    spawnFn: (() => child) as never,
  });
  child.stdout.emit("data", Buffer.from(`token: ${TOKEN}\n`));
  const result = await flow;
  assert.deepEqual(result, { ok: true, token: TOKEN }, "approved a moment before the deadline still counts");
  assert.equal(child.killed, true, "and the terminal is closed either way");
});

test("a start that only draws is still a start that said nothing", async () => {
  const child = fakeChild();
  const flow = runClaudeSetupToken({
    cli: "/bin/claude",
    pty: withPython,
    quietMs: 30,
    timeoutMs: 60_000,
    spawnFn: (() => child) as never,
  });
  child.stdout.emit("data", Buffer.from(`${ESC}[2J${ESC}[H${ESC}[?25l`));
  assert.equal((await flow).reason, "needs_terminal", "escapes are not words the person can act on");
});

test("a python that is a link to the Mac stub is still the stub", () => {
  const runner = ptyRunner(["claude", "setup-token"], {
    platform: "darwin",
    pathDirs: ["/Users/someone/bin"],
    existsSync: (file) => file === "/Users/someone/bin/python3" || file === "/usr/bin/python3",
    realpathSync: (file) => (file === "/Users/someone/bin/python3" ? "/usr/bin/python3" : file),
  });
  assert.equal(runner, null, "a link to the stub would pop the same dialog");

  const real = ptyRunner(["claude", "setup-token"], {
    platform: "darwin",
    pathDirs: ["/Users/someone/bin"],
    existsSync: (file) => file === "/Users/someone/bin/python3",
    realpathSync: (file) => (file === "/Users/someone/bin/python3" ? "/opt/python/3.13/bin/python3" : file),
  });
  assert.equal(real?.command, "/Users/someone/bin/python3", "a link to a real python is a real python");

  const broken = ptyRunner(["claude", "setup-token"], {
    platform: "darwin",
    pathDirs: ["/Users/someone/bin"],
    existsSync: (file) => file === "/Users/someone/bin/python3",
    realpathSync: () => {
      throw new Error("ELOOP");
    },
  });
  assert.equal(broken?.command, "/Users/someone/bin/python3", "a link it cannot follow is judged by its own path");
});

test("a flow that ends with words but no token says so, and one that ends silent asks for a terminal", async () => {
  const noisy = fakeChild();
  const failing = runClaudeSetupToken({ cli: "/bin/claude", pty: withPython, quietMs: 500, spawnFn: (() => noisy) as never });
  noisy.stdout.emit("data", Buffer.from("Authentication failed: Invalid authorization code"));
  noisy.emit("exit", 1);
  const failed = await failing;
  assert.equal(failed.reason, "failed");
  assert.match(failed.message ?? "", /Sign-in ended without a token \(1\)/);

  const mute = fakeChild();
  const quiet = runClaudeSetupToken({ cli: "/bin/claude", pty: withPython, quietMs: 500, spawnFn: (() => mute) as never });
  mute.emit("exit", 0);
  assert.equal((await quiet).reason, "needs_terminal", "an exit with nothing printed is the no-terminal case again");
});

test("a pasted token is checked before it is stored, and the complaint says what to do", () => {
  assert.equal(looksLikeClaudeToken(TOKEN), true);
  assert.equal(claudeTokenComplaint(TOKEN), null);
  assert.equal(looksLikeClaudeToken(`  ${TOKEN}  `), true, "a paste carries whitespace");
  assert.equal(looksLikeClaudeToken("sk-ant-short"), false);
  assert.equal(looksLikeClaudeToken(""), false);
  assert.match(claudeTokenComplaint("") ?? "", /Paste the token/);
  assert.match(claudeTokenComplaint(`token: ${TOKEN}`) ?? "", /only the sk-ant/);
  assert.match(claudeTokenComplaint("nonsense") ?? "", /starts with sk-ant-/);
  assert.equal(CLAUDE_SETUP_TOKEN_COMMAND, "claude setup-token");
});

test("the desk stores a pasted token, logs the attempt, and never logs the token", () => {
  const main = read("electron/main.ts");
  const store = main.slice(main.indexOf("const keepClaudeToken"), main.indexOf('ipcMain.handle("claude:prompt"'));
  assert.match(store, /if \(!looksLikeClaudeToken\(token\)\) \{/, "a pasted value is checked in the main process too");
  assert.match(store, /resetClaudeTokenRejection\(\);/, "a new token clears the refusal the desk was holding");
  assert.match(store, /mainLog\.record\("claude-auth", "token stored"\)/, "the attempt leaves a trace");
  assert.match(store, /mainLog\.record\("claude-auth", "setup-token started"\)/);
  assert.match(store, /setup-token \$\{result\.reason \?\? "failed"\}/, "and so does the reason it did not finish");
  assert.doesNotMatch(store, /record\([^)]*token\b[^)]*\$\{(?:token|result\.token)\}/, "never the value");

  const settings = read("src/ui/Settings.tsx");
  assert.match(settings, /\{id === "claude" \? \(\n\s*<ClaudeSignIn/, "the way in is always on the Claude card, not only when a call has already failed");
  const grid = settings.slice(settings.indexOf('className="llm-brain-open"'), settings.indexOf("{settings.customBots.map"));
  assert.match(grid, /setLlmFocus\("claude"\);\n\s*startClaudeAuth\(\);/, "the grid button opens the card it reports into");
  assert.match(grid, /claudeAuth\.stage === "running" \? "Signing in…" : "Log in"/, "and says what it is doing");
  assert.match(settings, /running \? "Signing in…"/, "the button says what is happening");
  assert.match(settings, /auth\.stage === "paste"/, "and the paste path appears when the desk cannot make a terminal");
  assert.match(settings, /type="password"/, "a token is not typed in the clear");
});

test("the sign-in child gets the person's environment, not the desk's", () => {
  const env = setupTokenEnv({ PATH: "/usr/bin", WORKHORSE_BRIDGE_TOKEN: "bridge", HOME: "/Users/someone" });
  assert.equal(env.WORKHORSE_BRIDGE_TOKEN, undefined, "the desk's own secrets stay behind");
  assert.match(String(env.PATH), /\/usr\/bin/, "the person's own PATH reaches the CLI");
  assert.equal(env.NO_BROWSER, "");
});
