/**
 * The desk's two halves disagreed about the same bot. Usage and Watch have
 * always asked isLocalEndpoint whether a bot is on this machine; routing only
 * ever read the model's name. So a Qwen served from http://127.0.0.1:11434 and
 * named "qwen3.8-spark" was a paid remote row to Auto and an unmetered local
 * one to the rings — and "Allow local models" did not exclude the single box it
 * exists for.
 *
 * Only the flag moves. Two independent reviews landed on the same line here:
 * fit decides who is right for the task, and free is a tie-break, never a
 * merit. Nothing below asserts a local model winning something it does not fit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rankRoutingCandidates, routingCandidatesForDesk } from "../src/lib/routing";
import { normalizeSettings } from "../src/lib/settings";
import type { Settings } from "../src/lib/types";

const bot = (over: Record<string, unknown>) => ({
  id: "bot_spark",
  name: "Spark",
  color: "#30d158",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3.8-spark",
  models: ["qwen3.8-spark"],
  apiKey: "sk_local",
  api: "openai-completions",
  contextWindow: 128_000,
  createdAt: 1,
  ...over,
});

const settingsWith = (bots: unknown[], allowLocal = true): Settings =>
  normalizeSettings({ customBots: bots, routing: { auto: true, allowLocal } }) as Settings;

const routingFor = (settings: Settings) => settings.routing;

const sparkRow = (settings: Settings) =>
  routingCandidatesForDesk(settings).find((row) => row.customBotId === "bot_spark");

test("a bot on this machine is local because of its address, not its name", () => {
  assert.equal(sparkRow(settingsWith([bot({})]))?.profile.local, true);
  // The same model name served from someone else's API is not local.
  assert.equal(sparkRow(settingsWith([bot({ baseUrl: "https://api.example.com/v1" })]))?.profile.local, false);
  // And a bot whose name says nothing is still local when it is.
  assert.equal(sparkRow(settingsWith([bot({ name: "fast-coder", model: "fast-coder" })]))?.profile.local, true);
});

test("the capability the owner declared is left alone", () => {
  // Tagging a box local must not restamp it as a 4/4/1 toy. Qwen 3.8 is not a
  // 3B model, and forcing the small-family profile onto it would be a
  // downgrade dressed up as a fix.
  const plain = sparkRow(settingsWith([bot({})]))!;
  const remote = sparkRow(settingsWith([bot({ baseUrl: "https://api.example.com/v1" })]))!;
  assert.equal(plain.profile.intelligence, remote.profile.intelligence);
  assert.equal(plain.profile.speed, remote.profile.speed);
  assert.equal(plain.profile.cost, remote.profile.cost);
});

test("Allow local models now excludes the box it is named after", () => {
  // The switch was answering about model names, so the one bot a person would
  // switch off was the one it could not see.
  const off = routingCandidatesForDesk(settingsWith([bot({})], false));
  const ranked = rankRoutingCandidates(
    off,
    { prompt: "classify these rows" },
    routingFor(settingsWith([bot({})], false)),
  );
  assert.equal(ranked.some((row) => row.customBotId === "bot_spark"), false);
});

test("no gauge means no gauge, so a meterless box gets no spare-capacity credit", () => {
  // Found by probe during review: a local bot reporting 0% used outscored a
  // metered model that fit better — the dead-gauge subsidy, applied to a box
  // that simply has no meter. An unmetered row carries no usedPercent at all.
  const row = sparkRow(settingsWith([bot({})]))!;
  assert.deepEqual(row.capacity, {}, "a local row must not claim 0% used");
});

test("free stays a tie-break: fit still decides", () => {
  // The rule both reviews defended. A local box does not take work it does not
  // fit just because it costs nothing.
  const settings = settingsWith([bot({}), bot({ id: "bot_big", name: "Deep", model: "deep-model", baseUrl: "https://api.example.com/v1", routingProfile: { intelligence: 5, speed: 3, cost: 3 } })]);
  const ranked = rankRoutingCandidates(
    routingCandidatesForDesk(settings),
    { prompt: "Architect and review this production migration end-to-end", tier: "deep" },
    routingFor(settings),
  );
  assert.notEqual(ranked[0]?.customBotId, "bot_spark", "a local box must not win deep work on price");
});
