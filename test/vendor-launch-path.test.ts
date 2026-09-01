import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_ACP_NOT_ON_PATH,
  CLAUDE_CLI_NOT_ON_PATH,
  detectClaudeLogin,
  resolveClaudeAcpLaunch,
} from "../electron/claude-login";
import {
  CODEX_ACP_NOT_ON_PATH,
  CODEX_CLI_NOT_ON_PATH,
  detectCodexLogin,
  resolveCodexCliBinary,
} from "../electron/codex-login";
import { CURSOR_CLI_NOT_ON_PATH, detectCursorLogin, resolveCursorBinary } from "../electron/cursor-login";
import { GROK_CLI_NOT_ON_PATH, detectGrokLogin } from "../electron/grok-login";
import { normalizeSettings, vendorLaunchGate } from "../src/lib/settings";
import {
  chooseRoutingDecision,
  describeRoutingMiss,
  rankRoutingCandidates,
  routingCandidatesForDesk,
} from "../src/lib/routing";
import type { Settings } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What a desk started from Finder or launchd actually inherits. Not a fixture
 * choice: launchd hands a GUI app this exact PATH, which is why a vendor
 * installed by Homebrew or an npm global is invisible to the desk and visible
 * in every terminal the owner tries it in.
 */
const FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const HOME = "/Users/someone";
const BREW_BIN = "/opt/homebrew/bin";

/** Only these files exist. Everything else — including this machine — does not. */
function onlyOnDisk(...files: string[]): (filePath: string) => boolean {
  const present = new Set(files);
  return (filePath) => present.has(filePath);
}

test("a Finder-launched desk finds Codex, Cursor and Grok outside the bare PATH", () => {
  const codex = resolveCodexCliBinary({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(`${BREW_BIN}/codex`),
  });
  assert.equal(codex, `${BREW_BIN}/codex`, "Codex CLI must be found off the desk's installer directories");

  const cursor = resolveCursorBinary({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(`${BREW_BIN}/cursor-agent`),
  });
  assert.equal(cursor, `${BREW_BIN}/cursor-agent`, "Cursor CLI must be found off the desk's installer directories");

  const grok = detectGrokLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(`${BREW_BIN}/grok`),
    readFile: () => "",
  });
  assert.equal(grok.binary, `${BREW_BIN}/grok`, "Grok CLI must be found off the desk's installer directories");
  assert.equal(grok.launchable, true);
  assert.equal(grok.connected, false, "a binary with no login artifact is launchable, not connected");
});

test("a bare PATH with nothing installed still resolves to nothing", () => {
  const codex = resolveCodexCliBinary({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: () => false,
  });
  assert.equal(codex, null);
  const grok = detectGrokLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: () => false,
    readFile: () => "",
  });
  assert.equal(grok.binary, null);
  assert.equal(grok.launchable, false);
  assert.equal(grok.launchBlocker, GROK_CLI_NOT_ON_PATH);
});

test("Codex with an ACP server, a login and no CLI is connected and not launchable", () => {
  const acp = `${HOME}/.local/bin/codex-acp`;
  const auth = `${HOME}/.codex/auth.json`;
  const detected = detectCodexLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(acp, auth),
    readFile: () => "",
  });
  assert.equal(detected.connected, true, "the login artifact is on disk");
  assert.equal(detected.acpBinary, acp);
  assert.equal(detected.cliBinary, null, "no codex binary anywhere the desk can see");
  // codex-launch.ts reads cliBinary as CODEX_PATH and throws CODEX_CLI_NOT_INSTALLED
  // without it. Before this field, that throw was the first anyone heard of it —
  // a second after Auto had already assigned the slice.
  assert.equal(detected.launchable, false);
  assert.equal(detected.launchBlocker, CODEX_CLI_NOT_ON_PATH);

  const whole = detectCodexLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(acp, auth, `${BREW_BIN}/codex`),
    readFile: () => "",
  });
  assert.equal(whole.connected, true);
  assert.equal(whole.launchable, true);
  assert.equal(whole.launchBlocker, undefined);
});

/**
 * A desk whose Codex link came back from a detect that said it cannot start,
 * built the way the store builds it: through vendorLaunchGate and then through
 * the normalizer that used to drop both fields.
 */
function deskWithBlockedCodex(blocker = CODEX_CLI_NOT_ON_PATH): Settings {
  return normalizeSettings({
    llms: {
      codex: { connected: true, ...vendorLaunchGate({ launchable: false, launchBlocker: blocker }) },
      claude: { connected: true },
    },
  });
}

const REQUEST = { prompt: "Refactor the launch adapter", tier: "balanced" as const };

test("a connected vendor that cannot start is never a routing candidate", () => {
  const desk = deskWithBlockedCodex();
  const pool = routingCandidatesForDesk(desk);
  assert.ok(
    pool.some((row) => row.provider === "codex"),
    "the blocked vendor still produces rows, or the miss text has nothing to name",
  );
  assert.ok(
    pool.filter((row) => row.provider === "codex").every((row) => row.launchable === false),
    "every row from a blocked link carries the block",
  );

  const ranked = rankRoutingCandidates(pool, REQUEST, desk.routing);
  assert.ok(ranked.length > 0, "the launchable vendors still rank");
  assert.equal(
    ranked.some((row) => row.provider === "codex"),
    false,
    "a vendor that cannot start must not be ranked",
  );
  const decision = chooseRoutingDecision(pool, REQUEST, desk.routing);
  assert.ok(decision);
  assert.notEqual(decision.provider, "codex");
});

test("the routing miss text names the launch blocker", () => {
  const desk = deskWithBlockedCodex();
  const onlyCodex = routingCandidatesForDesk(desk).filter((row) => row.provider === "codex");
  assert.equal(chooseRoutingDecision(onlyCodex, REQUEST, desk.routing), null);
  const miss = describeRoutingMiss(onlyCodex, REQUEST, desk.routing);
  assert.match(miss, /Codex CLI not on the desk's PATH/);
  assert.doesNotMatch(miss, /no connected vendors/, "the vendor is connected; it cannot start");

  // A blocked vendor beside a working one is a note on the miss, not the miss.
  const mixed = routingCandidatesForDesk(desk).filter(
    (row) => row.provider === "codex" || row.provider === "claude",
  );
  const withImage = { ...REQUEST, requirements: { video: true } };
  const mixedMiss = describeRoutingMiss(mixed, withImage, desk.routing);
  assert.match(mixedMiss, /no vendor accepts video/);
  assert.match(mixedMiss, /skipped: Codex CLI not on the desk's PATH/);
});

test("a blocked link with no reason still gets one", () => {
  const desk = deskWithBlockedCodex("   ");
  const pool = routingCandidatesForDesk(desk).filter((row) => row.provider === "codex");
  assert.match(describeRoutingMiss(pool, REQUEST, desk.routing), /codex cannot start on this desk/);
});

test("an ordinary desk is untouched: no link says launchable, nothing is skipped", () => {
  const desk = normalizeSettings({ llms: { codex: { connected: true }, claude: { connected: true } } });
  const pool = routingCandidatesForDesk(desk);
  assert.equal(pool.some((row) => row.launchable !== undefined), false);
  const decision = chooseRoutingDecision(pool, REQUEST, desk.routing);
  assert.ok(decision);
  assert.doesNotMatch(describeRoutingMiss([], REQUEST, desk.routing), /skipped/);
});

test("Cursor is not launchable when the only thing found is the editor", () => {
  const editor = "/Applications/Cursor.app/Contents/MacOS/cursor";
  const detected = detectCursorLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH, CURSOR_ACP_BIN: editor },
    existsSync: onlyOnDisk(editor),
    readFile: () => "",
    probeAuth: () => undefined,
  });
  assert.equal(detected.binary, null, "the editor is not a spawnable ACP command");
  assert.equal(detected.launchable, false);
  assert.equal(detected.launchBlocker, CURSOR_CLI_NOT_ON_PATH);

  const agent = `${BREW_BIN}/cursor-agent`;
  const working = detectCursorLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH, CURSOR_API_KEY: "sk-test" },
    existsSync: onlyOnDisk(agent),
    readFile: () => "",
    probeAuth: () => true,
  });
  assert.equal(working.binary, agent);
  assert.equal(working.launchable, true);
  assert.equal(working.launchBlocker, undefined);
});

/**
 * Everything below follows the field across the desk, not around it. The tests
 * above build a link by hand; these start at a real detect result and go
 * through the two places the field used to be dropped — the store's read and
 * the settings normalizer — before asking routing what it does.
 */

test("vendorLaunchGate carries a detect's launch half and nothing else", () => {
  assert.deepEqual(
    vendorLaunchGate({ connected: true, binary: "/x", launchable: false, launchBlocker: CODEX_CLI_NOT_ON_PATH }),
    { launchable: false, launchBlocker: CODEX_CLI_NOT_ON_PATH },
  );
  // Launchable again clears the stored reason, or the row keeps naming a
  // binary the person has just installed.
  assert.deepEqual(vendorLaunchGate({ launchable: true, launchBlocker: "stale" }), {
    launchable: true,
    launchBlocker: undefined,
  });
  // A bridge that is not there says nothing, and the stored answer stands. A
  // missing preload must never read as "this vendor is broken".
  assert.deepEqual(vendorLaunchGate({ connected: false }), {});
  assert.deepEqual(vendorLaunchGate(undefined), {});
  assert.deepEqual(vendorLaunchGate(null), {});
});

test("a blocked detect result crosses link() and routing refuses the vendor", () => {
  const acp = `${HOME}/.local/bin/codex-acp`;
  const auth = `${HOME}/.codex/auth.json`;
  const detected = detectCodexLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(acp, auth),
    readFile: () => "",
  });
  assert.equal(detected.connected, true);
  assert.equal(detected.launchable, false);

  // The store's read, then the normalizer that used to drop what it read.
  const desk = normalizeSettings({
    llms: {
      codex: { connected: true, ...vendorLaunchGate(detected) },
      claude: { connected: true },
    },
  });
  assert.equal(desk.llms.codex.launchable, false, "link() must carry launchable");
  assert.equal(desk.llms.codex.launchBlocker, CODEX_CLI_NOT_ON_PATH, "link() must carry the reason");

  const pool = routingCandidatesForDesk(desk);
  assert.equal(
    rankRoutingCandidates(pool, REQUEST, desk.routing).some((row) => row.provider === "codex"),
    false,
    "a link that says it cannot start must not rank",
  );
  const decision = chooseRoutingDecision(pool, REQUEST, desk.routing);
  assert.ok(decision);
  assert.notEqual(decision.provider, "codex");

  const onlyCodex = pool.filter((row) => row.provider === "codex");
  assert.equal(chooseRoutingDecision(onlyCodex, REQUEST, desk.routing), null);
  assert.match(describeRoutingMiss(onlyCodex, REQUEST, desk.routing), /Codex CLI not on the desk's PATH/);
});

test("a vendor that can start again loses its blocker through link()", () => {
  const desk = normalizeSettings({
    llms: { codex: { connected: true, ...vendorLaunchGate({ launchable: true, launchBlocker: "stale" }) } },
  });
  assert.equal(desk.llms.codex.launchable, true);
  assert.equal(desk.llms.codex.launchBlocker, undefined);
  assert.equal(
    routingCandidatesForDesk(desk).some((row) => row.launchable === false),
    false,
  );
});

test("a stored link that never heard of launchable still routes", () => {
  const desk = normalizeSettings({ llms: { codex: { connected: true } } });
  assert.equal(desk.llms.codex.launchable, undefined, "absent means launchable, for state written before the field");
  assert.equal(desk.llms.codex.launchBlocker, undefined);
  assert.ok(chooseRoutingDecision(routingCandidatesForDesk(desk), REQUEST, desk.routing));
});

test("Claude reports the same split: an ACP server and a login, no CLI", () => {
  const acp = `${BREW_BIN}/claude-agent-acp`;
  const blocked = detectClaudeLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH, CLAUDE_ACP_BIN: acp, ANTHROPIC_API_KEY: "sk-test" },
    existsSync: onlyOnDisk(acp),
    readFile: () => "",
    keychainHasLogin: () => false,
  });
  assert.equal(blocked.connected, true, "the API key is a login");
  assert.equal(blocked.cliBinary, null);
  assert.equal(blocked.launchable, false);
  assert.equal(blocked.launchBlocker, CLAUDE_CLI_NOT_ON_PATH);

  const whole = detectClaudeLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH, CLAUDE_ACP_BIN: acp, ANTHROPIC_API_KEY: "sk-test" },
    existsSync: onlyOnDisk(acp, `${BREW_BIN}/claude`),
    readFile: () => "",
    keychainHasLogin: () => false,
  });
  assert.equal(whole.cliBinary, `${BREW_BIN}/claude`);
  assert.equal(whole.launchable, true);
  assert.equal(whole.launchBlocker, undefined);
});

/**
 * The test above hands Claude its ACP server through CLAUDE_ACP_BIN, which is
 * an override and skips the search entirely. This is the search. The CLI lookup
 * has read the desk's installer directories since the Finder-PATH bug; the ACP
 * lookup beside it had not, so the same desk reported the server missing
 * instead of the CLI — the right shape of complaint about the wrong half.
 */
test("a Finder-launched desk finds the Claude ACP server outside the bare PATH", () => {
  const acp = `${BREW_BIN}/claude-agent-acp`;
  const launch = resolveClaudeAcpLaunch({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(acp),
  });
  assert.equal(launch?.acpFile, acp, "the ACP server must be found off the desk's installer directories");
  assert.equal(launch?.command, acp);

  // And the whole detect agrees: both halves found, so Claude can start.
  const detected = detectClaudeLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH, ANTHROPIC_API_KEY: "sk-test" },
    existsSync: onlyOnDisk(acp, `${BREW_BIN}/claude`),
    readFile: () => "",
    keychainHasLogin: () => false,
  });
  assert.equal(detected.acpBinary, acp);
  assert.equal(detected.cliBinary, `${BREW_BIN}/claude`);
  assert.equal(detected.connected, true);
  assert.equal(detected.launchable, true);
  assert.equal(detected.launchBlocker, undefined);
});

test("a missing ACP server is its own blocker, named apart from the CLI", () => {
  const claude = detectClaudeLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH, ANTHROPIC_API_KEY: "sk-test" },
    // The CLI is installed; the stdio server the desk speaks to is not.
    existsSync: onlyOnDisk(`${BREW_BIN}/claude`),
    readFile: () => "",
    keychainHasLogin: () => false,
    moduleDirs: [],
  });
  assert.equal(claude.acpBinary, null);
  assert.equal(claude.cliBinary, `${BREW_BIN}/claude`);
  assert.equal(claude.connected, false, "no server to speak to is not a connection");
  assert.equal(claude.launchable, false);
  assert.equal(claude.launchBlocker, CLAUDE_ACP_NOT_ON_PATH);
  assert.notEqual(claude.launchBlocker, CLAUDE_CLI_NOT_ON_PATH, "the two halves get different reasons");

  const codex = detectCodexLogin({
    homedir: HOME,
    platform: "darwin",
    env: { PATH: FINDER_PATH },
    existsSync: onlyOnDisk(`${BREW_BIN}/codex`, `${HOME}/.codex/auth.json`),
    readFile: () => "",
    moduleDirs: [],
  });
  assert.equal(codex.acpBinary, null);
  assert.equal(codex.cliBinary, `${BREW_BIN}/codex`);
  assert.equal(codex.launchable, false);
  assert.equal(codex.launchBlocker, CODEX_ACP_NOT_ON_PATH);
});

/**
 * The crossing itself lives inside a React effect, which no node test can call.
 * The suite reads the source for it the way test/codex-adapter.test.ts reads
 * preload for its detect calls. Dropping the read is the mutation this catches;
 * `vendorLaunchGate` above is what proves the read does the right thing.
 */
test("the store carries the launch gate onto every vendor link", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  for (const vendor of ["grok", "codex", "claude", "cursor"]) {
    assert.match(
      store,
      new RegExp(`\\.\\.\\.vendorLaunchGate\\(${vendor}\\)`),
      `the detect effect must carry ${vendor}'s launch gate onto its link`,
    );
  }
  // Recheck is the button the blocker sends the person to, so all four of those
  // paths have to be able to clear it too.
  const rechecks = store.match(/\.\.\.vendorLaunchGate\(detected\)/g) ?? [];
  assert.equal(rechecks.length, 4, `Recheck carries the gate for ${rechecks.length} vendors, not 4`);
});

/**
 * The vendor row itself. Settings.tsx cannot be loaded here — it reaches an
 * image import that tsx has no loader for — so this reads it, the way
 * test/codex-adapter.test.ts already reads the same file for "Codex not found".
 * The row is the existing `row-meta` line, taking one more short string; no
 * component was added.
 */
test("the vendor row says the blocker instead of reporting the vendor ready", () => {
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  assert.match(
    settings,
    /if \(link\.launchable === false && link\.launchBlocker\) return/,
    "the detail row must answer with the blocker before it answers 'ready'",
  );
  const detail = settings.slice(settings.indexOf("function llmDetailCopy"));
  const blockerLine = detail.indexOf("link.launchable === false");
  const readyLine = detail.indexOf("Local Codex ready.");
  assert.ok(blockerLine > 0 && readyLine > blockerLine, "the blocker has to be reached before 'Local Codex ready.'");
  assert.match(settings, /Local Codex ready\./, "the ready copy still exists for a vendor that can start");
  assert.doesNotMatch(settings, /className="launch-blocker"/, "no new component for one string");
});

/**
 * The renderer's view of the bridge is src/vite-env.d.ts, so a hand-copied
 * shape there is what silently drops a new field. Grok and Claude were the two
 * written out by hand; Codex and Cursor already named their result types.
 */
test("the bridge types every vendor detect by its real result type", () => {
  const bridge = readFileSync(path.join(ROOT, "src", "vite-env.d.ts"), "utf8");
  assert.match(bridge, /detectGrokLogin: \(\) => Promise<import\("\.\.\/electron\/grok-login"\)\.GrokLoginDetectResult>/);
  assert.match(
    bridge,
    /detectClaudeLogin: \(\) => Promise<import\("\.\.\/electron\/claude-login"\)\.ClaudeLoginDetectResult>/,
  );
  for (const vendor of ["detectGrokLogin", "detectClaudeLogin", "detectCodexLogin", "detectCursorLogin"]) {
    assert.doesNotMatch(
      bridge,
      new RegExp(`${vendor}: \\(\\) => Promise<\\{`),
      `${vendor} must name its result type, not restate its shape`,
    );
  }
});
