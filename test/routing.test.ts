import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseRoutingDecision,
  inferRoutingTier,
  rankRoutingCandidates,
  routingProfileForModel,
  weeklyDrawState,
  type RoutingCandidate,
} from "../src/lib/routing";
import type { RoutingSettings } from "../src/lib/types";
import { resolveSpawnSpec } from "../src/lib/subagents";

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
  assert.equal(deep?.model, "gpt-5.6-sol");
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
