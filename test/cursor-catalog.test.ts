import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collapseCursorCatalog,
  cursorFamilyId,
  cursorSlugForEffort,
  isCursorAutoModel,
  parseCursorModelsOutput,
  parseCursorVariant,
  reconcileCursorModels,
  resetCursorBases,
  CURSOR_DEFAULT_WINDOW,
} from "../src/lib/cursor-catalog";
import { cursorWatchLane } from "../src/lib/cursor-lane";
import { applyVendorCatalog, modelsFor, modelsForPicker, MODEL_CATALOG, resetVendorCatalog } from "../src/lib/models";
import {
  chooseRoutingDecision,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingProfileForModel,
  type RoutingCandidate,
} from "../src/lib/routing";
import { normalizeSettings } from "../src/lib/settings";
import type { RoutingSettings } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(path.join(ROOT, "test", "fixtures", "cursor-agent-models.txt"), "utf8");

afterEach(() => {
  resetCursorBases();
  resetVendorCatalog();
});

const routingSettings: RoutingSettings = {
  enabled: true,
  capacityAware: true,
  preferExcess: true,
  allowLocal: true,
  reservePercent: 15,
};

function fixtureRows() {
  return parseCursorModelsOutput(FIXTURE);
}

function fixtureBases() {
  return collapseCursorCatalog(fixtureRows());
}

function cursorCandidate(
  model: string,
  laneUsed: { composer: number; api: number },
): RoutingCandidate {
  const lane = cursorWatchLane(model);
  const used = lane === "cursor:cursor-models" ? laneUsed.composer : laneUsed.api;
  return {
    provider: "cursor",
    model,
    label: model,
    connected: true,
    profile: routingProfileForModel("cursor", model),
    capacity: {
      usedPercent: used,
      period: "monthly",
      resetsAt: "2026-09-18T00:00:00.000Z",
    },
  };
}

function candidatesFromBases(
  bases: ReturnType<typeof fixtureBases>,
  laneUsed: { composer: number; api: number },
): RoutingCandidate[] {
  return bases.map((row) => cursorCandidate(row.id, laneUsed));
}

test("the checked-in cursor-agent models fixture parses as identity, 204 ids, 200k unless a row reports a window", () => {
  const parsed = fixtureRows();
  assert.equal(parsed.length, 204);
  const millionName = parsed.find((row) => /1M/i.test(row.name));
  assert.ok(millionName, "fixture still has a display name that says 1M");
  assert.equal(millionName?.contextWindow, CURSOR_DEFAULT_WINDOW);
  assert.ok(parsed.every((row) => row.contextWindow === CURSOR_DEFAULT_WINDOW));
  const opus = parseCursorVariant("claude-opus-5-thinking-high-fast", "Claude Opus 5 1M Thinking Fast");
  assert.equal(opus.family, "claude-opus-5");
  assert.equal(opus.effort, "high");
  assert.equal(opus.fast, true);
  assert.equal(opus.thinking, true);
  assert.equal(opus.contextWindow, CURSOR_DEFAULT_WINDOW);
  assert.match(opus.name, /Claude Opus 5/);
  assert.doesNotMatch(opus.name, /1M/);
});

test("collapse yields family bases with effort and fast as fields, not extra rows", () => {
  const parsed = fixtureRows();
  const bases = collapseCursorCatalog(parsed);
  assert.ok(bases.length < parsed.length, `bases ${bases.length} should be under 204`);
  assert.equal(bases.length, 33, `bases ${bases.length} should be the fixture's family count`);
  assert.ok(bases.length !== 204);
  const composer = bases.find((row) => row.id === "composer-2.5");
  assert.ok(composer);
  assert.ok(composer?.aliases?.includes("composer-2.5-fast"));
  const grok = bases.find((row) => row.id === "cursor-grok-4.6");
  assert.ok(grok);
  assert.ok(grok?.aliases?.includes("cursor-grok-4.6-high"));
  assert.equal(cursorFamilyId("cursor-grok-4.6-high-fast"), "cursor-grok-4.6");
  assert.equal(cursorFamilyId("gpt-5.3-codex-low-fast"), "gpt-5.3-codex");
  for (const row of bases) {
    assert.equal(row.contextWindow, CURSOR_DEFAULT_WINDOW);
  }
});

test("live overlay keeps families beyond the stock four; empty live still falls back to stock", () => {
  const live = reconcileCursorModels(fixtureRows(), MODEL_CATALOG.cursor);
  const ids = live.map((row) => row.id);
  assert.ok(ids.includes("composer-2.5"));
  assert.ok(ids.includes("auto"));
  assert.ok(ids.includes("cursor-grok-4.6"));
  assert.ok(ids.includes("cursor-grok-4.5"));
  assert.ok(ids.includes("claude-opus-5"));
  assert.ok(ids.includes("gpt-5.6-sol"));
  assert.ok(ids.includes("gemini-3.7-flash"));
  assert.ok(ids.includes("kimi-k3"));
  assert.ok(ids.includes("glm-5.2"));
  assert.ok(live.length > 4, "stock four is not a delete-filter");
  const empty = reconcileCursorModels([], MODEL_CATALOG.cursor);
  assert.deepEqual(
    empty.map((row) => row.id).sort(),
    ["auto", "composer-2.5", "cursor-grok-4.5", "cursor-grok-4.6"].sort(),
  );
});

test("family profiles fill Composer, Auto, Gemini, Kimi, GLM, GPT-5.x and keep opus/sol/grok-4.6 at 5", () => {
  const triple = (model: string) => {
    const profile = routingProfileForModel("cursor", model);
    return [profile.intelligence, profile.speed, profile.cost] as const;
  };
  assert.deepEqual(triple("claude-opus-5"), [5, 2, 5]);
  assert.deepEqual(triple("gpt-5.6-sol"), [5, 2, 5]);
  assert.deepEqual(triple("cursor-grok-4.6"), [5, 2, 5]);
  assert.deepEqual(triple("claude-sonnet-5"), [4, 4, 3]);
  assert.deepEqual(triple("gpt-5.6-terra"), [4, 4, 3]);
  assert.deepEqual(triple("cursor-grok-4.5"), [4, 4, 3]);
  assert.deepEqual(triple("claude-haiku-4-5"), [3, 5, 1]);
  assert.deepEqual(triple("gpt-5.6-luna"), [3, 5, 1]);
  assert.deepEqual(triple("gpt-5.4-mini"), [3, 5, 1]);
  assert.deepEqual(triple("gpt-5-mini"), [3, 5, 1]);
  assert.deepEqual(triple("gemini-3.7-flash"), [3, 5, 2]);
  assert.deepEqual(triple("gemini-3.1-pro"), [3, 5, 2]);
  assert.notDeepEqual(triple("gemini-3.1-pro"), [3, 5, 1], "gemini must not match the mini token");
  assert.notDeepEqual(triple("composer-2.5"), [4, 3, 3]);
  assert.notDeepEqual(triple("auto"), [4, 3, 3]);
  assert.notDeepEqual(triple("kimi-k3"), [4, 3, 3]);
  assert.notDeepEqual(triple("glm-5.2"), [4, 3, 3]);
  assert.notDeepEqual(triple("gpt-5.5"), [4, 3, 3]);
  assert.notDeepEqual(triple("gpt-5.4"), [4, 3, 3]);
  assert.notDeepEqual(triple("gpt-5.3-codex"), [4, 3, 3]);
  assert.deepEqual(triple("gpt-5.4-mini"), [3, 5, 1], "mini stays light and is not smashed into GPT-5.4");
});

test("Composer-family and API-family Cursor rows still map to two leftover rings", () => {
  assert.equal(cursorWatchLane("composer-2.5"), "cursor:cursor-models");
  assert.equal(cursorWatchLane("cursor-grok-4.6"), "cursor:cursor-models");
  assert.equal(cursorWatchLane("claude-opus-5"), "cursor:other-models");
  assert.equal(cursorWatchLane("gpt-5.6-sol"), "cursor:other-models");
  assert.equal(cursorWatchLane("auto"), "cursor:other-models");
  assert.equal(cursorWatchLane("gemini-3.7-flash"), "cursor:other-models");
});

test("Auto ranks collapsed bases, not 204 spellings; Quick/Balanced/Deep are stable; leftover moves Balanced", () => {
  const bases = fixtureBases();
  assert.ok(bases.length < 204);
  const even = { composer: 20, api: 20 };
  const rows = candidatesFromBases(bases, even);
  assert.equal(rows.length, bases.length);
  const pick = (tier: "quick" | "balanced" | "deep") =>
    chooseRoutingDecision(rows, { prompt: "task", tier, now: Date.parse("2026-08-19T00:00:00Z") }, routingSettings);
  const first = { quick: pick("quick")?.model, balanced: pick("balanced")?.model, deep: pick("deep")?.model };
  const second = { quick: pick("quick")?.model, balanced: pick("balanced")?.model, deep: pick("deep")?.model };
  assert.deepEqual(second, first);
  assert.ok(first.quick && first.balanced && first.deep);
  const deepProfile = routingProfileForModel("cursor", first.deep!);
  assert.equal(deepProfile.intelligence, 5);

  const winnerLane = cursorWatchLane(first.balanced!);
  const loaded =
    winnerLane === "cursor:cursor-models" ? { composer: 92, api: 12 } : { composer: 12, api: 92 };
  const moved = chooseRoutingDecision(
    candidatesFromBases(bases, loaded),
    { prompt: "task", tier: "balanced", now: Date.parse("2026-08-19T00:00:00Z") },
    routingSettings,
  );
  assert.ok(moved?.model);
  assert.notEqual(moved?.model, first.balanced);

  const off = chooseRoutingDecision(
    candidatesFromBases(bases, loaded),
    { prompt: "task", tier: "balanced", now: Date.parse("2026-08-19T00:00:00Z") },
    { ...routingSettings, capacityAware: false },
  );
  const on = chooseRoutingDecision(
    candidatesFromBases(bases, loaded),
    { prompt: "task", tier: "balanced", now: Date.parse("2026-08-19T00:00:00Z") },
    routingSettings,
  );
  assert.notEqual(on?.model, off?.model, "leftover on must be able to move Balanced vs leftover off");

  const ranked = rankRoutingCandidates(rows, { prompt: "task", tier: "deep", now: Date.parse("2026-08-19T00:00:00Z") }, routingSettings);
  assert.equal(ranked.length, bases.length);
  assert.ok(!ranked.some((row) => /-fast$/.test(row.model) || /-(low|high|xhigh|max)$/.test(row.model)));

  const slug = cursorSlugForEffort(first.deep!, pick("deep")?.effort ?? "high", { rows: bases });
  assert.equal(cursorFamilyId(slug), first.deep);
});

test("chat picker is a short subset of the same catalog Auto ranks", () => {
  const live = reconcileCursorModels(fixtureRows(), MODEL_CATALOG.cursor);
  applyVendorCatalog({ cursor: live });
  const ranked = modelsFor("cursor");
  const chips = modelsForPicker("cursor");
  assert.ok(ranked.length > 4);
  assert.ok(chips.length <= 4);
  assert.ok(chips.length > 0);
  for (const chip of chips) {
    assert.ok(
      ranked.some((row) => row.id === chip.id),
      `picker chip ${chip.id} must be a catalog row`,
    );
  }
  assert.ok(chips.some((row) => row.id === "composer-2.5"));
  assert.ok(chips.some((row) => row.id === "auto"));
});

test("collapsed family ranking is smaller and not slower than ranking the 204-id fixture", () => {
  const rawRows = fixtureRows();
  assert.equal(rawRows.length, 204);
  const bases = collapseCursorCatalog(rawRows);
  assert.ok(bases.length < 204);
  assert.equal(bases.length, 33);

  const desk = normalizeSettings({ llms: { cursor: { connected: true } } });
  applyVendorCatalog({ cursor: rawRows });
  const rawPool = routingCandidatesForDesk(desk);
  assert.equal(rawPool.some((row) => isCursorAutoModel(row.model)), false);
  assert.ok(rawPool.length > 100, `uncollapsed desk pool ${rawPool.length}`);

  applyVendorCatalog({ cursor: bases });
  const collapsedPool = routingCandidatesForDesk(desk);
  assert.equal(collapsedPool.some((row) => isCursorAutoModel(row.model)), false);
  assert.ok(collapsedPool.length < 204);
  assert.ok(collapsedPool.length < rawPool.length);
  assert.equal(collapsedPool.length, bases.filter((row) => !isCursorAutoModel(row.id)).length);

  const request = { prompt: "Implement this form", tier: "balanced" as const, now: Date.parse("2026-08-19T00:00:00Z") };
  const collapsedPick = chooseRoutingDecision(collapsedPool, request, routingSettings);
  assert.ok(collapsedPick);
  assert.equal(isCursorAutoModel(collapsedPick.model), false);
  const rawPick = chooseRoutingDecision(rawPool, request, routingSettings);
  assert.ok(rawPick);
  assert.equal(isCursorAutoModel(rawPick.model), false);

  const rankOnce = (candidates: typeof rawPool) => rankRoutingCandidates(candidates, request, routingSettings);
  rankOnce(rawPool);
  rankOnce(collapsedPool);

  const rounds = 40;
  const timeMs = (candidates: typeof rawPool) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < rounds; i += 1) rankOnce(candidates);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  const rawMs = timeMs(rawPool) + timeMs(rawPool);
  const collapsedMs = timeMs(collapsedPool) + timeMs(collapsedPool);
  assert.ok(
    collapsedMs <= rawMs,
    `collapsed ${collapsedMs.toFixed(2)}ms must not exceed 204-id ${rawMs.toFixed(2)}ms over ${rounds * 2} ranks (pool ${collapsedPool.length} vs ${rawPool.length})`,
  );
});

test("desk Auto and spawn score modelsFor; compiler pick is documented as a separate ephemeral scorer", () => {
  const routing = readFileSync(path.join(ROOT, "src", "lib", "routing.ts"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  const compiler = readFileSync(path.join(ROOT, "src", "lib", "learning-policy.ts"), "utf8");
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const welcome = readFileSync(path.join(ROOT, "src", "ui", "Welcome.tsx"), "utf8");
  assert.match(routing, /for \(const model of modelsFor\(provider\)\)/);
  assert.match(store, /routingCandidatesForDesk/);
  assert.match(store, /chooseRoutingDecision/);
  assert.match(setup, /modelsForPicker\(session\.provider\)/);
  assert.match(compiler, /Ephemeral compiler pick for Learning, not desk Auto/);
  assert.match(compiler, /rankRoutingCandidates/);
  assert.doesNotMatch(settings, /id: "models"/);
  assert.doesNotMatch(welcome, /brain picker|pick a model before/i);
});
