import assert from "node:assert/strict";
import { test } from "node:test";
import { findListedBot, runCustomBotSetup, type PublicBotCard } from "../src/lib/bot-setup";
import { EMPTY_CUSTOM_DRAFT } from "../src/lib/custom-bots";

/**
 * Bot setup answers "already on the desk" instead of creating a bot that is
 * there. It matched on the model alone, or the name alone, so the same model
 * at a second provider came back as the first provider's bot and was never
 * created, and nothing told the caller its URL had been ignored.
 */

const minimax: PublicBotCard = {
  id: "bot_minimax",
  name: "MiniMax",
  model: "MiniMax-M3",
  color: "#ff375f",
  baseUrl: "https://api.minimax.io/anthropic",
  api: "anthropic-messages",
  contextWindow: 1_000_000,
};

test("a listed bot is the same endpoint and the same model", () => {
  assert.equal(findListedBot([minimax], { baseUrl: "https://api.minimax.io/anthropic/", model: "minimax-m3" }), minimax);
  assert.equal(findListedBot([minimax], { baseUrl: "https://openrouter.ai/api/v1", model: "MiniMax-M3" }), undefined, "same model, other provider");
  assert.equal(findListedBot([minimax], { baseUrl: "https://api.minimax.io/anthropic", model: "MiniMax-M2.7" }), undefined, "same provider, other model");
});

test("the same model at a second provider is created, not answered with the first", async () => {
  let created = 0;
  const result = await runCustomBotSetup(
    { baseUrl: "https://openrouter.ai/api/v1", model: "MiniMax-M3", apiKey: "sk-or-test", name: "MiniMax" },
    {
      detect: () => ({ connected: false, source: "none", config: EMPTY_CUSTOM_DRAFT }),
      probe: async () => ({ ok: true, message: "API ok" }),
      create: async (draft) => {
        created += 1;
        return { ...minimax, id: "bot_openrouter", baseUrl: draft.baseUrl };
      },
      listed: () => [minimax],
    },
  );
  assert.equal(result.ok, true);
  assert.equal(created, 1);
  if (result.ok) {
    assert.equal(result.alreadyOnDesk === true, false);
    assert.equal(result.bot.baseUrl, "https://openrouter.ai/api/v1");
  }
});
