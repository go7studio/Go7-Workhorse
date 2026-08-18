import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chooseRoutingDecision,
  effortForRoutingTier,
  inferRoutingTier,
  rankRoutingCandidates,
  routingIdentityExcluded,
  routingProfileForModel,
  weeklyDrawState,
  type RoutingCandidate,
} from "../src/lib/routing";
import type { RoutingSettings } from "../src/lib/types";
import { resolveSpawnSpec } from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const settings: RoutingSettings = {
  enabled: true,
  capacityAware: true,
  preferExcess: true,
  allowLocal: true,
  reservePercent: 15,
};

function candidate(model: string, usedPercent = 20, patch: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    provider: "codex",
    model,
    label: model,
    connected: true,
    profile: routingProfileForModel("codex", model),
    capacity: { usedPercent, resetsAt: "2026-08-17T00:00:00.000Z" },
    ...patch,
  };
}

test("routing tiers keep quick work light and deep work strong", () => {
  assert.equal(inferRoutingTier("Quick: list these names"), "quick");
  assert.equal(inferRoutingTier("Architect and review this production migration end-to-end"), "deep");

  const rows = [candidate("gpt-5.6-sol"), candidate("gpt-5.6-terra"), candidate("gpt-5.6-luna")];
  const quick = chooseRoutingDecision(rows, { prompt: "Quick: classify this", now: Date.parse("2026-08-13T00:00:00Z") }, settings);
  const deep = chooseRoutingDecision(rows, { prompt: "Architect a production migration", now: Date.parse("2026-08-13T00:00:00Z") }, settings);
  assert.equal(quick?.model, "gpt-5.6-luna");
  assert.equal(quick?.effort, "low");
  assert.equal(deep?.model, "gpt-5.6-sol");
  assert.equal(deep?.effort, "high");
  assert.equal(effortForRoutingTier("codex", "gpt-5.6-terra", "balanced"), "medium");
  assert.equal(effortForRoutingTier("codex", "gpt-5.6-luna", "quick", "high"), "high");
});

test("routing exclusions match provider, model, label, and bot identity", () => {
  const kimi = candidate("hf:moonshotai/Kimi-K3", 20, {
    provider: "custom",
    label: "Kimi K3",
    customBotId: "custom-kimi",
  });
  assert.equal(routingIdentityExcluded(kimi, ["minimax"]), false);
  assert.equal(routingIdentityExcluded(kimi, ["kimi"]), true);
  assert.equal(routingIdentityExcluded(candidate("gpt-5.6-sol"), ["codex"]), true);
  assert.equal(routingIdentityExcluded(candidate("gpt-5.6-sol"), ["gpt-5.6-sol"]), true);
});

test("capacity can move balanced work to a model with spare allowance", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [candidate("gpt-5.6-sol", 90), candidate("gpt-5.6-terra", 25), candidate("gpt-5.6-luna", 20)];
  const ranked = rankRoutingCandidates(rows, { prompt: "Implement this form", tier: "balanced", now }, settings);
  assert.notEqual(ranked[0]?.model, "gpt-5.6-sol");
  assert.ok((ranked.find((row) => row.model === "gpt-5.6-sol")?.score ?? 0) < ranked[0].score);
});

test("spare preference can be disabled without ignoring overdraw", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [candidate("gpt-5.6-terra", 20), candidate("gpt-5.6-terra-alt", 40)];
  const withoutPreference = rankRoutingCandidates(
    rows,
    { prompt: "Implement this form", tier: "balanced", now },
    { ...settings, preferExcess: false, reservePercent: 0 },
  );
  assert.equal(withoutPreference[0]?.score, withoutPreference[1]?.score);
  const overdrawn = [candidate("gpt-5.6-terra", 20), candidate("gpt-5.6-terra-alt", 80)];
  const protectedRows = rankRoutingCandidates(
    overdrawn,
    { prompt: "Implement this form", tier: "balanced", now },
    { ...settings, preferExcess: false, reservePercent: 0 },
  );
  assert.ok(protectedRows[0].score > protectedRows[1].score);
});

test("unsupported media is excluded and an opted-in local model can win", () => {
  const remote = candidate("gpt-5.6-terra");
  const local = candidate("local-whisper", 0, {
    provider: "custom",
    customBotId: "bot_local",
    profile: routingProfileForModel("custom", "local-whisper", {
      local: true,
      inputs: { text: true, images: false, documents: false, audio: true, video: false },
    }),
  });
  const decision = chooseRoutingDecision(
    [remote, local],
    {
      prompt: "Transcribe this recording",
      attachments: [{ id: "audio", name: "note.mp3", mimeType: "audio/mpeg", data: "AA==", kind: "audio" }],
    },
    settings,
  );
  assert.equal(decision?.customBotId, "bot_local");
});

test("weekly draw state reports excess and overdraw consistently", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const spare = weeklyDrawState({ usedPercent: 20, resetsAt: "2026-08-17T00:00:00Z" }, now);
  const heavy = weeklyDrawState({ usedPercent: 80, resetsAt: "2026-08-17T00:00:00Z" }, now);
  assert.ok((spare.delta ?? 0) > 0);
  assert.ok((heavy.delta ?? 0) < 0);
});

test("automatic custom spawns preserve the selected bot identity", () => {
  const spec = resolveSpawnSpec(
    { fromSessionId: "parent", prompt: "Transcribe", provider: "custom", model: "same-model", customBotId: "audio-bot" },
    [],
    null,
    [
      { id: "text-bot", name: "Text", model: "same-model" },
      { id: "audio-bot", name: "Audio", model: "same-model" },
    ],
  );
  assert.equal(spec.customBotId, "audio-bot");
});

test("Watch-held candidates cannot win automatic routing", () => {
  const decision = chooseRoutingDecision(
    [candidate("gpt-5.6-sol", 10, { connected: false }), candidate("gpt-5.6-terra", 30)],
    { prompt: "Review this production change", tier: "deep" },
    settings,
  );
  assert.equal(decision?.model, "gpt-5.6-terra");
});

test("explicit provider, model, and bot exclusions are hard routing bounds", () => {
  const decision = chooseRoutingDecision(
    [
      candidate("MiniMax-M3", 5, { provider: "custom", customBotId: "minimax", label: "MiniMax M3" }),
      candidate("gpt-5.6-luna", 30),
    ],
    { prompt: "Quickly inspect one manifest", tier: "quick", exclude: ["MiniMax"] },
    settings,
  );
  assert.equal(decision?.model, "gpt-5.6-luna");
});

test("the Routing pane shows the two settings that hang off leftover weighing as dependent", () => {
  // preferExcess and reservePercent are only read inside the capacityAware
  // branch of rankRoutingCandidates, so with it off they do nothing. The pane
  // says so by disabling them, instead of offering two live-looking controls.
  const base: RoutingCandidate[] = [
    candidate("a", 10, { capacity: { usedPercent: 90, resetsAt: "2026-08-17T00:00:00Z" } }),
    candidate("b", 10, { capacity: { usedPercent: 10, resetsAt: "2026-08-17T00:00:00Z" } }),
  ];
  const now = Date.parse("2026-08-13T00:00:00Z");
  const off = { ...settings, capacityAware: false };
  const untouched = rankRoutingCandidates(base, { prompt: "", tier: "balanced", now }, off).map((row) => row.score);
  const flipped = rankRoutingCandidates(
    base,
    { prompt: "", tier: "balanced", now },
    { ...off, preferExcess: !off.preferExcess, reservePercent: 50 },
  ).map((row) => row.score);
  assert.deepEqual(flipped, untouched);

  const pane = readFileSync(path.join(ROOT, "src", "ui", "RoutingPane.tsx"), "utf8");
  assert.match(pane, /const weighs = routing\.capacityAware/);
  assert.match(pane, /label="Prefer spare"[\s\S]{0,200}disabled=\{!weighs\}/);
  assert.match(pane, /Weekly reserve[\s\S]{0,600}disabled=\{!weighs\}/);
  assert.match(pane, /role="switch"/);
  assert.doesNotMatch(pane, /type="checkbox"/);
});

test("Settings draws one bar on every tab and no second title", () => {
  // Usage used to draw its own "Usage" heading and tab row, so choosing it
  // shifted the page; the window title already says Settings.
  const settingsUi = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const usage = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(settingsUi, /className="settings-bar"/);
  assert.match(usage, /className="settings-bar"/);
  assert.doesNotMatch(settingsUi, /<h2>Settings<\/h2>/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /^\.switch \{/m);
  assert.doesNotMatch(css, /\.watch-toggle/);
});
