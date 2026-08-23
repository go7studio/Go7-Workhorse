/**
 * A worker was reported as "Workhorse translated my Grok Build selection into
 * grok-bot — a harness mapping bug". No such alias exists: grok-build is a Grok
 * CLI model and grok-bot is a custom bot. What did happen is worse and quieter,
 * and it took three separate faults to produce.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveModelHint, resolveSpawnSpec } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

const BOTS = [
  { id: "bot_kimi", name: "Kimi K3", model: "hf:moonshotai/Kimi-K3" },
  { id: "bot_grok", name: "Grok Bot", model: "grok-bot" },
];

const parent = (provider: string, model: string) =>
  ({ id: "sess_parent", title: "Parent", provider, model, effort: "medium" }) as unknown as Session;

const ask = (bot: string, on: Session) =>
  resolveSpawnSpec({ fromSessionId: "sess_parent", prompt: "do a thing", bot } as never, [], on, BOTS as never);

test("a named bot decides the worker, not whichever chat asked for it", () => {
  // `bot` was not on SpawnRequest at all, so it was dropped without a word and
  // the worker inherited the parent chat's vendor. The same spawn landed on
  // grok-4.6 under one parent and cursor/composer-2.5 under another — which is
  // exactly what "my explicit selection was translated" looks like from outside.
  for (const on of [parent("grok", "grok-4.6"), parent("cursor", "composer-2.5"), parent("codex", "gpt-5.6-sol")]) {
    assert.deepEqual(
      { p: ask("Grok Build", on).provider, m: ask("Grok Build", on).model },
      { p: "grok", m: "grok-build" },
      "a named model must not depend on the parent chat",
    );
  }
});

test("a bot named on this desk beats a catalog model that shares a word", () => {
  const on = parent("grok", "grok-4.6");
  // "Grok Bot" shares "grok" with every Grok model, and the catalog claimed it
  // first — answering with a different vendor than the one asked for.
  assert.equal(ask("Grok Bot", on).customBotId, "bot_grok");
  assert.equal(ask("grok-bot", on).customBotId, "bot_grok", "its model id names it too");
  assert.equal(ask("Kimi K3", on).customBotId, "bot_kimi");

  // And the correction must not swing the other way: matchCustomBot is fuzzy,
  // so letting it decide sent every grok-ish request to the Grok Bot instead.
  assert.equal(ask("Grok Build", on).model, "grok-build");
  assert.equal(ask("Grok 4.6", on).model, "grok-4.6");
  assert.equal(ask("Grok 4.6", on).customBotId, undefined);
});

test("a brief that forbids a bot does not select it", () => {
  /*
   * The one that actually bit. A worker brief read:
   *
   *   "Provider/model must be grok/grok-4.6; stop without edits on any
   *    grok-bot routing. Do not use Grok Bot or unrelated project folders."
   *
   * and the desk ran it on Grok Bot. The description feeds the hint query, and
   * matchCustomBot matched the word "grok" inside the prohibition. The worker
   * ran on the one vendor the brief forbade, then died when that vendor's shim
   * was down — which reads as "Workhorse translated my model selection".
   */
  const brief =
    "Folder must be exactly /tmp/work. Provider/model must be grok/grok-4.6; stop without edits on " +
    "any grok-bot routing. Do not use Grok Bot or unrelated project folders.";
  const on = parent("cursor", "composer-2.5");
  const spec = resolveSpawnSpec(
    { fromSessionId: "sess_parent", prompt: "do the work", description: brief } as never,
    [],
    on,
    BOTS as never,
  );
  assert.notEqual(spec.customBotId, "bot_grok", "a prohibition is not a selection");
  assert.equal(spec.provider, "grok");
  assert.equal(spec.model, "grok-4.6", "the brief named the model it wanted");
});

test("naming a bot in prose still picks it", () => {
  // The gate must not cost the ordinary case: a short brief that names a bot
  // is still how you ask for one.
  const on = parent("grok", "grok-4.6");
  const say = (description: string) =>
    resolveSpawnSpec({ fromSessionId: "sess_parent", prompt: "x", description } as never, [], on, BOTS as never);
  assert.equal(say("Kimi K3").customBotId, "bot_kimi");
  assert.equal(say("use the Kimi K3 bot").customBotId, "bot_kimi", "filler words do not disqualify it");
  // ...and a paragraph that merely mentions it does not.
  assert.equal(
    say("Audit the K3 export path and report every mismatch you find in the manifest").customBotId,
    undefined,
    "a passing mention in a task description is not a selection",
  );
});

test("the model that matches the most of the name wins", () => {
  // The scan took the first model matching ANY token, so "5" found
  // claude-fable-5 before claude-opus-5 and stopped there.
  assert.deepEqual(resolveModelHint("Claude Opus 5"), { provider: "claude", model: "claude-opus-5" });
  assert.deepEqual(resolveModelHint("Grok Build"), { provider: "grok", model: "grok-build" });
  assert.deepEqual(resolveModelHint("Codex Terra"), { provider: "codex", model: "gpt-5.6-terra" });
});

test("a routing decision is recorded only when routing is what ran", () => {
  // Two live sessions ran on custom/grok-bot while carrying a routingDecision
  // of grok/grok-4.6. That record is what turns a shim outage into an
  // afternoon spent hunting a mapping bug that was never there.
  const store = readFileSync(new URL("../src/lib/store.tsx", import.meta.url), "utf8");
  assert.match(store, /routedWorkerIsRouted/, "the spawn must ask whether routing actually decided this worker");
  assert.match(
    store,
    /routeDecision\.provider === spec\.provider[\s\S]{0,200}routeDecision\.model === spec\.model/,
    "it must compare the decision against the worker that was built",
  );
  // The flag existing is not the fix — the spread has to be gated on it. An
  // earlier version of this test only grepped for the name, and passed happily
  // while the condition was replaced with `true`.
  assert.match(
    store,
    /\.\.\.\(routedWorkerIsRouted\s*\n?\s*\? \{ routingMode: "auto" as const, routingDecision: routeDecision \?\? undefined \}\s*\n?\s*: \{ routingMode: "manual" as const \}\)/,
    "the record must be gated on whether routing decided this worker",
  );
});
