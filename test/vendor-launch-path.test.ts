import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_CLI_NOT_ON_PATH,
  detectCodexLogin,
  resolveCodexCliBinary,
} from "../electron/codex-login";
import { CURSOR_CLI_NOT_ON_PATH, detectCursorLogin, resolveCursorBinary } from "../electron/cursor-login";
import { GROK_CLI_NOT_ON_PATH, detectGrokLogin } from "../electron/grok-login";
import { normalizeSettings } from "../src/lib/settings";
import {
  chooseRoutingDecision,
  describeRoutingMiss,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  type VendorLaunchState,
} from "../src/lib/routing";
import type { Settings } from "../src/lib/types";

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
 * `launchable` is not on LlmLink yet — src/lib/types.ts and the link normalizer
 * in src/lib/settings.ts belong to another lane, and normalizeSettings drops
 * keys it does not know. The gate is spread on afterwards so this test measures
 * routing's half of the contract, which is the half that ships here.
 */
function deskWithBlockedCodex(blocker = CODEX_CLI_NOT_ON_PATH): Settings {
  const desk = normalizeSettings({
    llms: { codex: { connected: true }, claude: { connected: true } },
  });
  const gate: VendorLaunchState = { launchable: false, launchBlocker: blocker };
  const blocked = { ...desk.llms.codex, ...gate };
  return { ...desk, llms: { ...desk.llms, codex: blocked } };
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
