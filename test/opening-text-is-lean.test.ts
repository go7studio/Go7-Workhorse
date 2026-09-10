/*
 * Every chat opens with what it needs and nothing it does not.
 *
 * The desk bible used to reach every chat whole, spawn law included, whether
 * or not that chat could ever spawn. A one-command probe turn on Haiku cost
 * 12,004 tokens before it read the command. S11 split it into a core and a
 * spawn law, and the spawn law now travels only to a chat that can use it.
 *
 * Two tests, and they belong together. The first is the witness: it lists
 * every rule sentence as it stood before the split and proves each one still
 * reaches the same chat, word for word or through a rewording recorded in the
 * fixture. The second puts a ceiling on the opening text. The ceiling is only
 * safe to write because the witness sits beside it — on its own, a character
 * budget is an invitation to delete a rule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDITOR_SESSION_RULES,
  CURSOR_SESSION_RULES,
  CUSTOM_HTTP_SESSION_RULES,
  CUSTOM_HTTP_WORKER_RULES,
  DESK_SPAWN_LAW,
  HELPER_SESSION_RULES,
  MISSION_MODE_HINT,
  SPAWN_TURN_HINT,
  WORKER_SESSION_RULES,
  WORKHORSE_SESSION_RULES,
  withCrewModeHint,
  withSpawnHint,
} from "../src/lib/workhorse-rules";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Witness = {
  beforeChars: Record<string, number>;
  before: Record<string, string[]>;
  rewordings: { was: string; now: string }[];
};

const witness: Witness = JSON.parse(
  readFileSync(path.join(ROOT, "test", "fixtures", "opening-text-rules.json"), "utf8"),
);

/**
 * The two blocks a chat on that surface can still receive: its core, which
 * opens every chat, and the spawn law, which arrives on a spawn-shaped turn or
 * an Orchestrate or Mission pin. A rule that survives nowhere else is lost.
 */
const BLOCKS: Record<string, string> = {
  WORKHORSE_SESSION_RULES: `${WORKHORSE_SESSION_RULES}\n${DESK_SPAWN_LAW}`,
  CUSTOM_HTTP_SESSION_RULES: `${CUSTOM_HTTP_SESSION_RULES}\n${DESK_SPAWN_LAW}`,
  SPAWN_TURN_HINT: `${SPAWN_TURN_HINT}\n${DESK_SPAWN_LAW}`,
};

test("no rule sentence was lost when the opening text was split", () => {
  const rewordings = new Map(witness.rewordings.map((item) => [item.was, item.now]));
  const lost: string[] = [];
  const stale: string[] = [];
  let verbatim = 0;
  let reworded = 0;

  for (const [source, sentences] of Object.entries(witness.before)) {
    const blocks = BLOCKS[source];
    assert.ok(blocks, `${source} has no block set to check against`);
    for (const sentence of sentences) {
      if (blocks.includes(sentence)) {
        verbatim += 1;
        continue;
      }
      const now = rewordings.get(sentence);
      if (!now) {
        lost.push(`[${source}] ${sentence}`);
        continue;
      }
      // A recorded rewording is only a record if the text it names is really
      // in the tree. Without this, the fixture could drift into fiction.
      if (!blocks.includes(now)) stale.push(`[${source}] ${sentence}\n    recorded as -> ${now}`);
      else reworded += 1;
    }
  }

  assert.deepEqual(lost, [], `rule sentences that reach no block any more:\n${lost.join("\n")}`);
  assert.deepEqual(stale, [], `rewordings whose replacement is not in the tree:\n${stale.join("\n")}`);
  assert.equal(verbatim + reworded, Object.values(witness.before).reduce((sum, list) => sum + list.length, 0));
});

test("the five named laws survive word for word", () => {
  // The spawn law, the permission and sandbox rules, forgery rejection,
  // missions running without a click, and the vendor boundary. These are not
  // open to rewording, so they are checked against the block that carries them
  // rather than against the fixture.
  assert.match(DESK_SPAWN_LAW, /Do not pass permission or sandbox on a spawn\./);
  assert.match(DESK_SPAWN_LAW, /every worker you hire copies that seat/);
  assert.match(DESK_SPAWN_LAW, /Grok 4\.6 is ACP Grok or Cursor Grok, never Grok Bot\./);

  for (const core of [WORKHORSE_SESSION_RULES, CUSTOM_HTTP_SESSION_RULES]) {
    assert.match(core, /workhorse_request_permission only RAISES access/);
    assert.match(core, /Never call it to lower Permission or Sandbox\./);
    assert.match(core, /Never offer to dial limits back\./);
    assert.match(core, /If a tool result starts with USER DECLINED/);
  }

  assert.match(CUSTOM_HTTP_SESSION_RULES, /Never pretend to be Grok, Codex, Claude, Sol, Terra, or another bot\./);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /Never invent a sub-agent reply/);
  assert.match(CUSTOM_HTTP_SESSION_RULES, /You are this chat’s bot until workhorse_spawn_agent returns a real reply\./);

  assert.match(MISSION_MODE_HINT, /adaptive sequential mission-board tracking/);
  assert.match(MISSION_MODE_HINT, /workhorse_continue_mission with previousWorkerIds/);

  for (const core of [WORKHORSE_SESSION_RULES, CUSTOM_HTTP_SESSION_RULES]) {
    assert.match(core, /Grok, Claude, Codex, and Cursor/);
    assert.match(core, /MiniMax/);
  }
  assert.match(WORKHORSE_SESSION_RULES, /Custom HTTP bots are live desk slots the user added/);
});

test("the spawn law reaches a chat that can spawn, and no other", () => {
  const plain = "Read the config and tell me what it sets.";
  const spawnAsk = "Spawn two agents to review this.";

  // An ordinary turn on an unpinned chat: core only.
  assert.equal(withSpawnHint(plain), plain);
  assert.equal(withCrewModeHint(plain), plain);
  assert.ok(!WORKHORSE_SESSION_RULES.includes(DESK_SPAWN_LAW));
  assert.ok(!CUSTOM_HTTP_SESSION_RULES.includes(DESK_SPAWN_LAW));

  // A spawn-shaped turn, and each pin, carry the law.
  assert.ok(withSpawnHint(spawnAsk).includes(DESK_SPAWN_LAW));
  assert.ok(withCrewModeHint(plain, "orchestrate").includes(DESK_SPAWN_LAW));
  assert.ok(withCrewModeHint(plain, "mission").includes(DESK_SPAWN_LAW));
  assert.ok(withCrewModeHint(plain, ["orchestrate", "mission"]).includes(DESK_SPAWN_LAW));

  // A worker is not an orchestrator, pin or no pin.
  for (const role of ["worker", "auditor", "helper"] as const) {
    assert.equal(withSpawnHint(spawnAsk, role), spawnAsk);
    assert.equal(withCrewModeHint(plain, "orchestrate", role), plain);
  }
});

test("the opening text stays under its ceiling for every role", () => {
  // Ceilings, never equalities: a pinned character count is a test that breaks
  // on every honest edit. Each one sits above today's measurement with room to
  // reword, and the witness above is what stops a ceiling being met by
  // deleting a rule.
  const ceilings: Record<string, number> = {
    WORKHORSE_SESSION_RULES: 6000,
    CUSTOM_HTTP_SESSION_RULES: 6000,
    CURSOR_SESSION_RULES: 6000,
    SPAWN_TURN_HINT: 4200,
    WORKER_SESSION_RULES: 900,
    AUDITOR_SESSION_RULES: 600,
    HELPER_SESSION_RULES: 500,
    CUSTOM_HTTP_WORKER_RULES: 1000,
  };
  const now: Record<string, string> = {
    WORKHORSE_SESSION_RULES,
    CUSTOM_HTTP_SESSION_RULES,
    CURSOR_SESSION_RULES,
    SPAWN_TURN_HINT,
    WORKER_SESSION_RULES,
    AUDITOR_SESSION_RULES,
    HELPER_SESSION_RULES,
    CUSTOM_HTTP_WORKER_RULES,
  };

  for (const [name, text] of Object.entries(now)) {
    assert.ok(
      text.length <= ceilings[name],
      `${name} is ${text.length} characters, over its ${ceilings[name]} ceiling`,
    );
  }

  // Nothing a chat opens with may grow. The spawn turn hint is the one block
  // that did grow, and on purpose: it used to be a shorter, drifted copy of
  // rules the core also carried, and it now carries the whole law once.
  for (const [name, text] of Object.entries(now)) {
    if (name === "SPAWN_TURN_HINT") continue;
    assert.ok(
      text.length <= witness.beforeChars[name],
      `${name} grew from ${witness.beforeChars[name]} to ${text.length} characters`,
    );
  }
  assert.ok(SPAWN_TURN_HINT.length > witness.beforeChars.SPAWN_TURN_HINT);

  // The three blocks S11 set out to shrink really did shrink, and by a lot.
  for (const name of ["WORKHORSE_SESSION_RULES", "CUSTOM_HTTP_SESSION_RULES", "CURSOR_SESSION_RULES"]) {
    const cut = 1 - now[name].length / witness.beforeChars[name];
    assert.ok(cut > 0.35, `${name} only came down ${Math.round(cut * 100)}%`);
  }

  // The worst case still improves: a desk chat that does ask for workers pays
  // the core and the turn hint together, and that pair is smaller than the
  // bible plus the old hint it replaces.
  const worstNow = WORKHORSE_SESSION_RULES.length + SPAWN_TURN_HINT.length;
  const worstBefore = witness.beforeChars.WORKHORSE_SESSION_RULES + witness.beforeChars.SPAWN_TURN_HINT;
  assert.ok(worstNow < worstBefore, `a spawn turn now costs ${worstNow}, was ${worstBefore}`);
});
