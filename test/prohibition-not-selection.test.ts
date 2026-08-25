/**
 * matchCustomBot already refuses a bot the query only mentions — its comment
 * says plainly that forbidding one is not selecting it. The inheritance guard
 * did not use that standard. It asked only whether the words appeared, so a
 * brief reading "Provider must be grok/grok-4.6. Do not use Grok Bot" counted
 * as naming the bot, kept the parent chat's slot, and ran the slice on the one
 * vendor it forbade.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSpawnSpec } from "../src/lib/subagents";
import type { Session } from "../src/lib/types";

const BOTS = [
  { id: "bot_loop", name: "Grok Bot", model: "grok-bot" },
  { id: "bot_kimi", name: "Kimi K3", model: "hf:moonshotai/Kimi-K3" },
];

const loopbackChat = {
  id: "sess_parent",
  title: "Parent",
  provider: "custom",
  model: "grok-bot",
  customBotId: "bot_loop",
  effort: "medium",
} as unknown as Session;

const slice = (description: string) =>
  resolveSpawnSpec({ fromSessionId: "sess_parent", prompt: "do the work", description } as never, [], loopbackChat, BOTS as never);

test("a brief that forbids the bot does not inherit its slot", () => {
  const spec = slice("Provider and model must be grok/grok-4.6. Do not use Grok Bot or unrelated folders.");
  assert.notEqual(spec.customBotId, "bot_loop", "a prohibition is not a selection");
  assert.equal(spec.provider, "grok");
});

test("the two rules either side of it still hold", () => {
  // A plain worker slice never inherits the slot — that rule already existed
  // and this must not weaken it.
  assert.notEqual(slice("Refine the hero topology").customBotId, "bot_loop");
  // And naming it on purpose still works, because that chat may dispatch.
  assert.equal(slice("Grok Bot").customBotId, "bot_loop");
});
