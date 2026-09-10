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
 *
 * The witness alone was not enough, and the first cut of it proved that: it
 * asked only whether the recorded new string was somewhere in the tree, so
 * "If they ask to delete all chats not in a project, call delete_chat with
 * scope=loose" passed as "For every chat not in a project, call delete_chat
 * with scope=loose", which is a standing order to wipe them. Every rewording
 * now carries a keeps note, and a rewording with no note fails.
 *
 * The second cut of the note was prose, and prose could say anything. "Keeps
 * the ban on searching or smoke-testing after a question" read as a true note
 * beside a replacement with no searching left in it. A note is now spans
 * quoted out of the replacement, word for word, so it can only name a fact the
 * new sentence really carries. What a span still cannot settle is whether it
 * is the RIGHT fact — a reviewer decides whether those spans are the ones that
 * made the old rule safe, and writing them down is what makes that a minute's
 * work rather than a re-read of the whole file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { admitSpawn } from "../src/lib/subagents";
import type { CrewMode } from "../src/lib/types";
import {
  AUDITOR_SESSION_RULES,
  CURSOR_SESSION_RULES,
  CUSTOM_HTTP_SESSION_RULES,
  CUSTOM_HTTP_WORKER_RULES,
  DESK_SPAWN_LAW,
  HELPER_SESSION_RULES,
  MISSION_MODE_HINT,
  SPAWN_GATE_LAW,
  SPAWN_LAW_MISSING_ERROR,
  SPAWN_TURN_HINT,
  WORKER_SESSION_RULES,
  WORKHORSE_SESSION_RULES,
  turnCarriesSpawnLaw,
  withCrewModeHint,
  withSpawnHint,
  type DeskRole,
} from "../src/lib/workhorse-rules";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Witness = {
  beforeChars: Record<string, number>;
  before: Record<string, string[]>;
  /** `keeps` is one or more spans quoted verbatim out of `now`. */
  rewordings: { was: string; now: string; keeps: string[] }[];
};

/**
 * Short enough for "call it" and "pass the id", long enough that a note cannot
 * be built out of "the" and "a" and still look like it named something.
 */
const MIN_SPAN = 6;

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

test("every keep-note is quoted out of the new sentence", () => {
  const beforeSentences = new Set(Object.values(witness.before).flat());
  const silent: string[] = [];
  const orphans: string[] = [];
  const unquoted: string[] = [];
  const padded: string[] = [];

  for (const item of witness.rewordings) {
    if (!beforeSentences.has(item.was)) orphans.push(item.was);
    const spans = Array.isArray(item.keeps) ? item.keeps : [];
    if (spans.length === 0) {
      silent.push(item.was);
      continue;
    }
    spans.forEach((span, index) => {
      // A span is a quotation, so it carries its own punctuation and spacing.
      if (typeof span !== "string" || span.trim() !== span || span.length < MIN_SPAN) {
        padded.push(`${item.was}\n    not a quotable phrase -> ${JSON.stringify(span)}`);
        return;
      }
      // The whole point: a note can only name what the replacement says.
      if (!item.now.includes(span)) {
        unquoted.push(`${item.was}\n    quotes ${JSON.stringify(span)}, absent from -> ${item.now}`);
      }
      // One fact written twice, or a phrase sitting inside a longer one, is
      // how a thin note starts to look thorough.
      if (spans.some((other, at) => at !== index && other.includes(span))) {
        padded.push(`${item.was}\n    span repeats another -> ${JSON.stringify(span)}`);
      }
    });
  }

  assert.deepEqual(
    silent,
    [],
    `rewordings with no note of what the new sentence keeps:\n${silent.join("\n")}`,
  );
  assert.deepEqual(orphans, [], `rewordings for a sentence no block ever carried:\n${orphans.join("\n")}`);
  assert.deepEqual(unquoted, [], `keep-notes quoting text the new sentence does not have:\n${unquoted.join("\n")}`);
  assert.deepEqual(padded, [], `keep-notes padded with sub-spans or scraps:\n${padded.join("\n")}`);
});

test("the loose-chat delete keeps its condition", () => {
  // The one this whole fixture exists for. A standing order to call
  // scope=loose, rather than a rule about what to do when the user asks for
  // it, empties every chat outside a project on a turn that never asked.
  for (const core of [WORKHORSE_SESSION_RULES, CUSTOM_HTTP_SESSION_RULES]) {
    assert.match(
      core,
      /If they ask to delete or remove all chats not in a project \(loose chats\), call workhorse_delete_chat with scope=loose now/,
    );
    assert.doesNotMatch(core, /For every chat not in a project \(loose chats\), call workhorse_delete_chat/);
  }
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
    assert.match(core, /blocking a write or command you must run now\./);
    assert.match(core, /Never call it to lower Permission \(Always → Ask\) or Sandbox \(Off → Workspace\)\./);
    assert.match(core, /Never offer to dial limits back\./);
    assert.match(core, /If a tool result starts with USER DECLINED/);
    assert.match(core, /Do not retry and do not guess why\./);
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

test("a chat that never got the spawn law is refused at the door", () => {
  // The core still names workhorse_spawn_agent, and the detector below it
  // only fires on the phrasings someone thought of. These are the ones it
  // misses, and each of them is an ordinary way to ask for workers.
  const missed = [
    "hire two reviewers",
    "please have Claude review this file",
    "bring in someone to check the migration",
    "get a reviewer on this",
    "ask Grok to look at the diff",
  ];
  for (const text of missed) {
    assert.equal(withSpawnHint(text), text, `${text} now reaches the detector — move it to the covered set`);
  }

  // Asking the model not to make the call was the first cut of this and it
  // could not work: a model cannot see which system text it did not receive.
  // The desk refuses instead. Widening the detector would close these five
  // phrasings and leave the sixth open; this closes the call.
  const spawn = (turn: { text: string; crewModes?: string[] }) =>
    admitSpawn({ parent: { parentId: null }, prompt: "review the auth diff", folder: "/proj", turn });

  const refused = spawn({ text: "hire two reviewers" });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.error, SPAWN_LAW_MISSING_ERROR);
  // The refusal is the chat's next line, so it has to say what to do next.
  assert.match(SPAWN_LAW_MISSING_ERROR, /say the desk can put workers on this and ask the user to confirm/);

  // And the cases it must not break: either pin, and a turn that asked.
  assert.equal(spawn({ text: "review this", crewModes: ["orchestrate"] }).ok, true);
  assert.equal(spawn({ text: "review this", crewModes: ["mission"] }).ok, true);
  assert.equal(spawn({ text: "review this", crewModes: ["orchestrate", "mission"] }).ok, true);
  assert.equal(spawn({ text: "Spawn two agents to review this." }).ok, true);

  // A worker never receives the law and still has its one helper, so the
  // refusal is not what turns a nested spawn away.
  const helper = admitSpawn({
    parent: { parentId: "root", hidden: true },
    prompt: "check the migration independently",
    folder: "/proj",
    allowNested: true,
    turn: { text: "ROLE: worker\nFOLDER: /proj\n\ndo the slice" },
  });
  assert.equal(helper.ok, true);

  // The gate line is the announcement, on every surface that holds the tool.
  for (const core of [WORKHORSE_SESSION_RULES, CUSTOM_HTTP_SESSION_RULES, CURSOR_SESSION_RULES]) {
    assert.ok(core.includes(SPAWN_GATE_LAW), "a core names workhorse_spawn_agent without the gate on it");
  }
  assert.match(SPAWN_GATE_LAW, /The desk refuses workhorse_spawn_agent on a turn that did not bring you the desk spawn law/);
  assert.match(SPAWN_GATE_LAW, /say the desk can put workers on this and ask the user to confirm/);
  // And no core may order the call the desk refuses. That sentence rode the
  // custom HTTP core one line under the gate; it belongs with the spawn law,
  // which reaches only a turn that may spawn.
  for (const core of [WORKHORSE_SESSION_RULES, CUSTOM_HTTP_SESSION_RULES, CURSOR_SESSION_RULES]) {
    assert.doesNotMatch(core, /you did not spawn anyone/);
  }
  assert.match(DESK_SPAWN_LAW, /If you did not call that tool this turn, you did not spawn anyone: call it\./);
});

test("one predicate decides who gets the law and who may spawn", () => {
  // The injector and the refusal read the same function. Two of these
  // disagreeing means a chat is handed the law and then turned away, or
  // spawns having never seen it.
  const cases: Array<{ text: string; crewMode?: CrewMode[]; role?: DeskRole; carried: boolean }> = [
    { text: "Read the config and tell me what it sets.", carried: false },
    { text: "hire two reviewers", carried: false },
    { text: "Spawn two agents to review this.", carried: true },
    { text: "Read the config.", crewMode: ["orchestrate"], carried: true },
    { text: "Read the config.", crewMode: ["mission"], carried: true },
    { text: "Spawn two agents to review this.", role: "worker", carried: false },
    { text: "Read the config.", crewMode: ["orchestrate"], role: "helper", carried: false },
  ];
  for (const item of cases) {
    assert.equal(
      turnCarriesSpawnLaw({ text: item.text, crewMode: item.crewMode, role: item.role }),
      item.carried,
      `turnCarriesSpawnLaw disagrees about: ${item.text}`,
    );
    const injected =
      withSpawnHint(item.text, item.role).includes(DESK_SPAWN_LAW) ||
      withCrewModeHint(item.text, item.crewMode, item.role).includes(DESK_SPAWN_LAW);
    assert.equal(injected, item.carried, `the injectors disagree about: ${item.text}`);
  }
});

test("both spawn doors hand the turn to the refusal", () => {
  // A door that forgets the turn admits everybody, quietly. Only the tool a
  // model calls itself is held to the law: workhorse_delegate, a mission pass
  // and a plan step reach the same code and are the desk's own dispatch.
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const block = store.match(/const admitted = admitSpawn\(\{[\s\S]*?\n\s*\}\);/);
  assert.ok(block, "the store still admits spawns through admitSpawn");
  assert.match(block![0], /turn: payload\.spawnTool \? spawnTurnOf\(caller\) : undefined,/);
  assert.match(store, /if \(!admitted\.ok\) \{\s*\n\s*await replyAsk\(\{ error: admitted\.error \}\);/);

  const mcp = readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8");
  assert.match(mcp, /turn: input\.spawnTool \? spawnTurnOf\(caller\) : undefined,/);
  assert.match(mcp, /if \(!admitted\.ok\) throw new Error\(admitted\.error\);/);
  // Set on the spawn tool and nowhere else, and never for a Link harness,
  // which never opened with a desk core and never had the law to lose.
  assert.equal((mcp.match(/^\s*spawnTool: !isLinkProfile\(\),$/gm) ?? []).length, 1);
  // One place it is set, one hand-off to the bridge, and nothing else.
  assert.equal((mcp.match(/^\s*spawnTool: /gm) ?? []).length, 2);
});

test("the opening text stays under its ceiling for every role", () => {
  // Ceilings, never equalities: a pinned character count is a test that breaks
  // on every honest edit. Each one sits above today's measurement with room to
  // reword, and the witness above is what stops a ceiling being met by
  // deleting a rule.
  //
  // The three core ceilings were 6,000 and are 6,500. The gate on this branch
  // found rules that had been compressed until they said something else, and
  // putting their conditions back cost characters. A size target is the one
  // thing here that may give way: it is a number we chose, and every rule it
  // sits over is one a chat obeys.
  const ceilings: Record<string, number> = {
    WORKHORSE_SESSION_RULES: 6500,
    CUSTOM_HTTP_SESSION_RULES: 6500,
    CURSOR_SESSION_RULES: 6500,
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
  // One floor each rather than one for all three: the custom HTTP core comes
  // down least because it carries the desk tool roster by name, and a single
  // shared floor would either be a lie about the other two or pressure to
  // drop that roster again.
  const floors: Record<string, number> = {
    WORKHORSE_SESSION_RULES: 0.35,
    CUSTOM_HTTP_SESSION_RULES: 0.25,
    CURSOR_SESSION_RULES: 0.35,
  };
  for (const [name, floor] of Object.entries(floors)) {
    const cut = 1 - now[name].length / witness.beforeChars[name];
    assert.ok(cut > floor, `${name} only came down ${Math.round(cut * 100)}%`);
  }

  // The worst case still improves: a desk chat that does ask for workers pays
  // the core and the turn hint together, and that pair is smaller than the
  // bible plus the old hint it replaces.
  const worstNow = WORKHORSE_SESSION_RULES.length + SPAWN_TURN_HINT.length;
  const worstBefore = witness.beforeChars.WORKHORSE_SESSION_RULES + witness.beforeChars.SPAWN_TURN_HINT;
  assert.ok(worstNow < worstBefore, `a spawn turn now costs ${worstNow}, was ${worstBefore}`);
});
