import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  attachmentRequirements,
  chooseRoutingDecision,
  describeRoutingMiss,
  detectsImageGenerationIntent,
  effortForRoutingTier,
  inferRoutingTier,
  mergeInputRequirements,
  outcomesFromLearningEvents,
  rankRoutingCandidates,
  routingCandidatesForDesk,
  routingDecisionEvidence,
  routingIdentityExcluded,
  routingProfileForModel,
  shouldRouteSessionTurn,
  shouldShadowRouteSessionTurn,
  spawnEffortFor,
  weeklyDrawState,
  type RoutingCandidate,
} from "../src/lib/routing";
import { applyVendorCatalog, modelsFor, resetVendorCatalog } from "../src/lib/models";
import { normalizeSettings } from "../src/lib/settings";
import type { RoutingSettings } from "../src/lib/types";
import { listedChatFollowThrough, resolveSpawnSpec } from "../src/lib/subagents";
import { customBotModels } from "../src/lib/custom-bots";

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

test("a second orchestrate of the same bot keeps thinking unless effort was asked for", () => {
  const deep = inferRoutingTier("Give each spawn the review task");
  assert.equal(deep, "deep", "slice prose with 'review' still reads as deep work");
  assert.equal(
    spawnEffortFor({ provider: "grok", model: "grok-4.6", tier: deep, requested: "medium", routed: "high" }),
    "medium",
    "the user's medium wins over a deep slice",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: deep,
      routed: "high",
      reused: "medium",
    }),
    "medium",
    "calling Wren again without effort does not bump medium to high",
  );
  assert.equal(
    spawnEffortFor({ provider: "grok", model: "grok-4.6", tier: deep, routed: "high" }),
    "high",
    "a new auto-routed worker still takes the slice's thinking level",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: deep,
      inherited: "medium",
    }),
    "medium",
    "a named bot with no effort inherits the parent instead of re-deriving from 'review'",
  );
  assert.equal(
    spawnEffortFor({
      provider: "grok",
      model: "grok-4.6",
      tier: deep,
      requested: "high",
      reused: "medium",
    }),
    "high",
    "an explicit change of thinking level still takes",
  );
});

test("automatic routing applies only to a person's visible turn", () => {
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "Review this", hideUser: false }), true);
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "ORCHESTRATION CALL", hideUser: true }), false);
  assert.equal(
    shouldRouteSessionTurn({
      routingMode: "auto",
      text: "If unanswered, proceed with: REST",
      hideUser: true,
    }),
    false,
    "a hideUser plan continue must keep the parent pick, not re-rank the default text",
  );
  assert.equal(shouldRouteSessionTurn({ routingMode: "auto", text: "/goal status", hideUser: false }), false);
  assert.equal(shouldRouteSessionTurn({ routingMode: "manual", text: "Review this", hideUser: false }), false);
  assert.equal(
    shouldShadowRouteSessionTurn({ learningEnabled: true, routingMode: "manual", text: "Review this" }),
    true,
  );
  assert.equal(
    shouldShadowRouteSessionTurn({ learningEnabled: false, routingMode: "manual", text: "Review this" }),
    false,
  );
  assert.equal(
    shouldShadowRouteSessionTurn({ learningEnabled: true, routingMode: "manual", text: "/goal status" }),
    false,
  );
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

test("a monthly Cursor window is not scored as a 7-day one", () => {
  // Old weeklyDrawState hard-coded 7 days. Reset 574h out made elapsed clamp
  // to 0, expectedUsedPercent 0, delta -8 — OVERSPENT while inside a month.
  // This uses only weeklyDrawState, which existed before the repair.
  const now = Date.parse("2026-08-19T00:00:00Z");
  const reset = new Date(now + 574 * 60 * 60 * 1000).toISOString();
  const draw = weeklyDrawState({ usedPercent: 8, resetsAt: reset }, now);
  assert.ok((draw.expectedUsedPercent ?? 0) > 8, `expected used should beat 8%, got ${draw.expectedUsedPercent}`);
  assert.ok((draw.delta ?? 0) > 0, `monthly Cursor must look inside budget, got delta ${draw.delta}`);
});

test("a vendor inside 24h of reset does not take the full flat -70 reserve", () => {
  // Old rankRoutingCandidates always did score -= 70 when usedPercent sat in
  // the reserve band. A 90% vendor resetting in 3h dropped by 70 points.
  // The repaired math spends that vendor down, so the score stays well above 40.
  const now = Date.parse("2026-08-19T00:00:00Z");
  const inThreeHours = new Date(now + 3 * 60 * 60 * 1000).toISOString();
  const spendDown = candidate("kimi-k3", 90, {
    provider: "custom",
    customBotId: "bot_kimi",
    capacity: { usedPercent: 90, resetsAt: inThreeHours },
  });
  const ranked = rankRoutingCandidates(
    [spendDown],
    { prompt: "Review this change", tier: "balanced", now },
    { ...settings, preferExcess: false, reservePercent: 15 },
  );
  assert.ok(
    (ranked[0]?.score ?? 0) > 40,
    `hours-to-reset vendor must not eat a flat -70, got ${ranked[0]?.score}`,
  );
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

test("prompt words UI visual design do not require image input", () => {
  assert.equal(attachmentRequirements([]).images, undefined);
  assert.equal(
    mergeInputRequirements([], undefined).images,
    undefined,
  );
  const textOnly = candidate("text-bot", 10, {
    provider: "custom",
    customBotId: "bot_text",
    profile: routingProfileForModel("custom", "text-bot", {
      inputs: { text: true, images: false, documents: false, audio: false, video: false },
    }),
  });
  const decision = chooseRoutingDecision(
    [textOnly],
    { prompt: "Polish the Mission Control UI visual design" },
    settings,
  );
  assert.equal(decision?.customBotId, "bot_text");
});

test("no capable route is null with reasons, not a silent fallback winner", () => {
  const textOnly = candidate("text-bot", 10, {
    provider: "custom",
    customBotId: "bot_text",
    profile: routingProfileForModel("custom", "text-bot", {
      inputs: { text: true, images: false, documents: false, audio: false, video: false },
    }),
  });
  const request = {
    prompt: "Look at this screenshot",
    attachments: [{ id: "img", name: "ui.png", mimeType: "image/png", data: "AA==", kind: "image" as const }],
  };
  assert.equal(chooseRoutingDecision([textOnly], request, settings), null);
  assert.match(describeRoutingMiss([textOnly], request, settings), /images/);
});

afterEach(() => {
  resetVendorCatalog();
});

test("one family table covers Grok 4.6, Fable, Codex 5.x, Kimi, GLM, MiniMax, Composer, Gemini", () => {
  const triple = (provider: "grok" | "claude" | "codex" | "cursor" | "custom", model: string) => {
    const profile = routingProfileForModel(provider, model);
    return [profile.intelligence, profile.speed, profile.cost] as const;
  };
  assert.deepEqual(triple("grok", "grok-4.6"), [10, 2, 5]);
  assert.deepEqual(triple("claude", "claude-fable-5"), [10, 2, 5]);
  assert.deepEqual(triple("claude", "claude-opus-5"), [10, 3, 4]);
  assert.notDeepEqual(triple("codex", "gpt-5.5"), [4, 3, 3]);
  assert.notDeepEqual(triple("codex", "gpt-5.4"), [4, 3, 3]);
  assert.notDeepEqual(triple("codex", "gpt-5.3-codex"), [4, 3, 3]);
  assert.notDeepEqual(triple("custom", "hf:moonshotai/Kimi-K3"), [3, 3, 3]);
  assert.notDeepEqual(triple("custom", "hf:zai-org/GLM-5.2"), [3, 3, 3]);
  assert.notDeepEqual(triple("custom", "MiniMax-M3"), [3, 3, 3]);
  assert.notDeepEqual(triple("cursor", "composer-2.5"), [4, 3, 3]);
  assert.deepEqual(triple("cursor", "gemini-3.1-pro"), [8, 4, 3]);
  assert.deepEqual(triple("cursor", "gpt-5.4-mini"), [5, 5, 1]);
});

test("two approved models on one bot inherit family scores unless that model is overridden", () => {
  const desk = normalizeSettings({
    customBots: [
      {
        id: "bot_syn",
        name: "Synthetic",
        color: "#bf5af2",
        baseUrl: "https://api.synthetic.new/openai/v1",
        model: "hf:moonshotai/Kimi-K3",
        models: ["hf:moonshotai/Kimi-K3", "hf:zai-org/GLM-5.2"],
        apiKey: "syn_x",
        api: "openai-completions",
        contextWindow: 128_000,
        createdAt: 1,
        routingProfile: { intelligence: 5, speed: 2, cost: 5 },
      },
    ],
  });
  const pool = routingCandidatesForDesk(desk);
  const kimi = pool.find((row) => row.model === "hf:moonshotai/Kimi-K3");
  const glm = pool.find((row) => row.model === "hf:zai-org/GLM-5.2");
  // The stored override is authored on the user 1–5 scale; 5 means frontier
  // and reads back as 10 on routing's internal scale.
  assert.equal(kimi?.profile.intelligence, 10);
  assert.ok(glm);
  assert.notEqual(glm?.profile.intelligence, 5);
  assert.notDeepEqual(
    [glm?.profile.intelligence, glm?.profile.speed, glm?.profile.cost],
    [3, 3, 3],
  );
});

test("spawn route= beats keyword inference; auditor, builder, size, attachments, and parent tier teach the job", () => {
  assert.equal(inferRoutingTier("Quick: list these names", [], { parentTier: "deep" }), "deep");
  assert.equal(inferRoutingTier("Architect a production migration", [], { parentTier: "quick" }), "quick");
  assert.equal(inferRoutingTier("Quick: list these names", [], { role: "auditor" }), "deep");
  assert.equal(inferRoutingTier("Quick: list these names", [], { role: "builder" }), "balanced");
  assert.equal(inferRoutingTier("Quick: list these names", [], { role: "worker" }), "balanced");
  assert.equal(inferRoutingTier("x".repeat(1300)), "deep");
  assert.equal(
    inferRoutingTier("Please handle this file", [
      { id: "doc", name: "spec.pdf", mimeType: "application/pdf", data: "AA==", kind: "document" },
    ]),
    "balanced",
  );
  const deep = chooseRoutingDecision(
    [candidate("gpt-5.6-sol"), candidate("gpt-5.6-luna")],
    { prompt: "Quick: list these names", tier: "deep" },
    settings,
  );
  assert.equal(deep?.model, "gpt-5.6-sol");
  const quick = chooseRoutingDecision(
    [candidate("gpt-5.6-sol"), candidate("gpt-5.6-luna")],
    { prompt: "Architect a production migration end-to-end", tier: "quick" },
    settings,
  );
  assert.equal(quick?.model, "gpt-5.6-luna");

  const parentAutoTier = "quick" as const;
  const workerSpawn = {
    prompt: "Quick: list these names",
    role: "worker" as const,
    parentTier: parentAutoTier,
  };
  const auditorSpawn = {
    prompt: "Quick: list these names",
    role: "auditor" as const,
    parentTier: parentAutoTier,
  };
  const longWorker = {
    prompt: "x".repeat(1300),
    role: "worker" as const,
    parentTier: parentAutoTier,
  };
  assert.equal(
    inferRoutingTier(workerSpawn.prompt, [], { role: workerSpawn.role, parentTier: workerSpawn.parentTier }),
    "balanced",
  );
  assert.equal(
    inferRoutingTier(auditorSpawn.prompt, [], { role: auditorSpawn.role, parentTier: auditorSpawn.parentTier }),
    "deep",
  );
  assert.equal(
    inferRoutingTier(longWorker.prompt, [], { role: longWorker.role, parentTier: longWorker.parentTier }),
    "deep",
  );

  const rows = [candidate("gpt-5.6-sol"), candidate("gpt-5.6-luna")];
  const workerPick = chooseRoutingDecision(rows, {
    prompt: workerSpawn.prompt,
    role: workerSpawn.role,
    parentTier: workerSpawn.parentTier,
  }, settings);
  assert.equal(workerPick?.taskTier, "balanced");
  assert.equal(workerPick?.effort, "medium");
  const auditorPick = chooseRoutingDecision(rows, {
    prompt: auditorSpawn.prompt,
    role: auditorSpawn.role,
    parentTier: auditorSpawn.parentTier,
  }, settings);
  assert.equal(auditorPick?.taskTier, "deep");
  assert.equal(auditorPick?.model, "gpt-5.6-sol");
});

test("verified worker outcomes tilt a close fit but leftover still splits two families that both fit", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const spare = candidate("gpt-5.6-terra", 15);
  const heavy = candidate("gpt-5.5", 85);
  const leftover = chooseRoutingDecision(
    [spare, heavy],
    {
      prompt: "Implement this form",
      tier: "balanced",
      now,
      outcomes: [
        { provider: "codex", model: "gpt-5.6-terra", verifiedSuccesses: 0, verifiedFailures: 6 },
        { provider: "codex", model: "gpt-5.5", verifiedSuccesses: 6, verifiedFailures: 0 },
      ],
    },
    settings,
  );
  assert.equal(leftover?.model, "gpt-5.6-terra");

  const closeSpare = candidate("gpt-5.6-terra", 24);
  const closeHeavy = candidate("gpt-5.5", 28);
  const tilted = chooseRoutingDecision(
    [closeSpare, closeHeavy],
    {
      prompt: "Implement this form",
      tier: "balanced",
      now,
      outcomes: [
        { provider: "codex", model: "gpt-5.6-terra", verifiedSuccesses: 0, verifiedFailures: 6 },
        { provider: "codex", model: "gpt-5.5", verifiedSuccesses: 6, verifiedFailures: 0 },
      ],
    },
    settings,
  );
  assert.equal(tilted?.model, "gpt-5.5");

  const tallies = outcomesFromLearningEvents([
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.6-terra",
      payload: { status: "failed", evidenceClass: "infrastructure-failure", signals: { adapterTerminal: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.6-terra",
      payload: { status: "failed", evidenceClass: "verified-failure", signals: { testsFailed: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.5",
      payload: { status: "completed", signals: { userAccepted: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.5",
      payload: { status: "completed", signals: { agentClaimed: true } },
    },
    {
      kind: "outcome",
      provider: "codex",
      model: "gpt-5.5",
      payload: { status: "completed", evidenceClass: "verified-success", signals: { adapterTerminal: true } },
    },
    { kind: "outcome", provider: "codex", model: "gpt-5.5", payload: { status: "completed" } },
  ]);
  assert.equal(tallies.find((row) => row.model === "gpt-5.6-terra")?.verifiedFailures, 1);
  assert.equal(tallies.find((row) => row.model === "gpt-5.5")?.verifiedSuccesses, 1);
});

test("routing evidence is versioned, bounded, and never stores the prompt", () => {
  const rows = [candidate("gpt-5.6-sol"), candidate("gpt-5.6-terra"), candidate("gpt-5.6-luna")];
  const secretPrompt = "Review API_SECRET_7f91 and implement the production migration";
  const evidence = routingDecisionEvidence({
    candidates: rows,
    request: {
      prompt: secretPrompt,
      attachments: [{ id: "img", name: "screen.png", mimeType: "image/png", data: "ignored", kind: "image" }],
      contextNeed: 64_000,
    },
    settings,
    selected: { provider: "codex", model: "gpt-5.6-terra" },
    mode: "shadow",
    source: "chat",
  });
  assert.ok(evidence);
  assert.equal(evidence.routingEvidenceVersion, 1);
  assert.equal(evidence.policyVersion, "fit-capacity-outcomes-v1");
  assert.equal(evidence.mode, "shadow");
  assert.equal(evidence.task.domain, "coding");
  assert.equal(evidence.task.attachmentKinds.image, 1);
  assert.equal(evidence.task.contextNeed, "medium");
  assert.equal(evidence.eligibleCandidateCount, 3);
  assert.equal(typeof evidence.margin, "number");
  assert.doesNotMatch(JSON.stringify(evidence), /API_SECRET_7f91/);
});

test("Workhorse Auto omits Cursor Auto from the pool; a named Cursor Auto id stays on the catalog", () => {
  applyVendorCatalog({
    cursor: [
      { id: "auto", name: "Auto (Cursor)", effort: true, contextWindow: 200_000 },
      { id: "composer-2.5", name: "Composer 2.5", effort: true, contextWindow: 200_000 },
      { id: "cursor-grok-4.6", name: "Cursor Grok 4.6", effort: true, contextWindow: 200_000 },
    ],
  });
  const desk = normalizeSettings({ llms: { cursor: { connected: true } } });
  const pool = routingCandidatesForDesk(desk);
  assert.equal(pool.some((row) => row.model === "auto" || row.model === "auto-smart"), false);
  assert.ok(pool.some((row) => row.model === "composer-2.5"));
  assert.ok(modelsFor("cursor").some((row) => row.id === "auto"));
});

test("Auto chat turns and unnamed spawn call the same ranker; no new Settings tab or New-chat brain picker", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const settingsUi = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const welcome = readFileSync(path.join(ROOT, "src", "ui", "Welcome.tsx"), "utf8");
  assert.match(store, /routingCandidatesForDesk/);
  assert.match(store, /chooseRoutingDecision/);
  assert.match(store, /parentTier: hideUser \? session\.routingDecision\?\.taskTier/);
  assert.doesNotMatch(store, /parentTier: caller\.routingDecision/);
  assert.match(store, /outcomesFromLearningEvents/);
  assert.match(store, /shouldAutoRouteSpawn/);
  assert.match(store, /constrainRouteCandidatesForSpawn/);
  assert.match(settingsUi, /id: "routing"/);
  assert.doesNotMatch(settingsUi, /id: "models"/);
  assert.doesNotMatch(welcome, /brain picker|pick a model before/i);
});


test("Grok 4.6 is ACP Grok; Auto workers never allocate grok-bot", () => {
  const grokAcp: RoutingCandidate = {
    provider: "grok",
    model: "grok-4.6",
    label: "Grok 4.6",
    connected: true,
    profile: routingProfileForModel("grok", "grok-4.6"),
    capacity: { usedPercent: 50, resetsAt: "2026-08-25T00:00:00.000Z" },
  };
  const grokBot: RoutingCandidate = {
    provider: "custom",
    model: "grok-bot",
    label: "Grok Bot",
    customBotId: "bot_grokbot",
    connected: true,
    profile: routingProfileForModel("custom", "grok-bot"),
    capacity: { usedPercent: 5, resetsAt: "2026-08-25T00:00:00.000Z" },
  };
  const now = Date.parse("2026-08-13T00:00:00Z");
  const deep = chooseRoutingDecision(
    [grokAcp, grokBot],
    { prompt: "Architect a production migration", tier: "deep", role: "worker", now },
    settings,
  );
  assert.equal(deep?.provider, "grok");
  assert.equal(deep?.model, "grok-4.6");
  assert.equal(deep?.customBotId, undefined);
  const rankedWorker = rankRoutingCandidates(
    [grokAcp, grokBot],
    { prompt: "Architect a production migration", tier: "deep", role: "worker", now },
    settings,
  );
  assert.equal(rankedWorker.some((row) => row.model === "grok-bot"), false);
  const dispatch = chooseRoutingDecision(
    [grokBot],
    { prompt: "Summarize this log", now },
    settings,
  );
  assert.equal(dispatch?.model, "grok-bot");
  const stolen = chooseRoutingDecision(
    [grokAcp, grokBot],
    { prompt: "Keep going", current: { provider: "grok", model: "grok-4.6" }, now },
    settings,
  );
  assert.equal(stolen?.provider, "grok");
  assert.equal(stolen?.model, "grok-4.6");
  const excluded = rankRoutingCandidates(
    [grokAcp, grokBot],
    { prompt: "Quick: list names", exclude: ["grok-bot"], now },
    settings,
  );
  assert.equal(excluded.some((row) => row.model === "grok-bot"), false);
  assert.ok(excluded.some((row) => row.model === "grok-4.6"));
  const spec = resolveSpawnSpec(
    { fromSessionId: "p", prompt: "fix", provider: "grok", model: "grok-4.6", customBotId: "bot_grokbot", description: "Idle chat labels" },
    [],
    { provider: "grok", model: "grok-4.6", effort: "high" },
    [{ id: "bot_grokbot", name: "Grok Bot", model: "grok-bot" }],
  );
  assert.equal(spec.provider, "grok");
  assert.equal(spec.model, "grok-4.6");
  assert.equal(spec.customBotId, undefined);
  assert.deepEqual(
    customBotModels({
      model: "grok-bot",
      models: ["grok-bot", "MiniMax-M3", "hf:moonshotai/Kimi-K3"],
      baseUrl: "http://127.0.0.1:8787/v1",
    }),
    ["grok-bot"],
  );
  assert.equal(listedChatFollowThrough({ status: "idle" }).next, undefined);
  assert.equal(listedChatFollowThrough({ status: "completed", parentId: "p", worker: "Wren" }).next, "done");
  assert.equal(listedChatFollowThrough({ status: "idle", parentId: "p" }).next, "failed");
});

test("auto-route spawn fails closed when no candidate qualifies", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const gate = store.slice(
    store.indexOf("const routeDecision = routeSpawn"),
    store.indexOf("const spawnProvider"),
  );
  assert.match(gate, /no capable route/);
  assert.match(gate, /describeRoutingMiss/);
});

test("an auditor slice routes deep, and a harness can ask for one", () => {
  // store.tsx has read payload.role since c748c34, but nothing sent it, so the
  // auditor branch could never be true and every check was sized from its own
  // prompt. A one-line gate command reads as "quick" — the cheapest model on
  // the desk grading another model's work.
  assert.equal(inferRoutingTier("Quick: run npm test and report"), "quick");
  assert.equal(inferRoutingTier("Quick: run npm test and report", [], { role: "auditor" }), "deep");

  // The tier is all role does here. Independence from the builder is a separate
  // decision: plan admission makes it with pickAuditorVendor, and a harness
  // makes it by naming the builder in exclude. Pinned so the tool description
  // cannot quietly start claiming more than the code does.
  const source = readFileSync(new URL("../electron/workhorse-mcp.ts", import.meta.url), "utf8");
  assert.match(source, /role: \{ type: "string"/, "spawn must offer role");
  assert.equal(
    [...source.matchAll(/^\s*role: spawnInput\.role,$/gm)].length,
    2,
    "both spawn payloads must carry role, or delegate and spawn_agent disagree",
  );
});

test("image-generation intent is conservative and does not treat input images as generation", () => {
  assert.equal(detectsImageGenerationIntent("generate a detailed image of a chicken wing"), true);
  assert.equal(detectsImageGenerationIntent("draw me a picture of a lighthouse"), true);
  assert.equal(detectsImageGenerationIntent("imagine an illustration of a fox"), true);
  assert.equal(detectsImageGenerationIntent("analyze this image and list the objects"), false);
  assert.equal(detectsImageGenerationIntent("describe the attached photo"), false);
  assert.equal(detectsImageGenerationIntent("what is in this screenshot"), false);
  assert.equal(detectsImageGenerationIntent("Implement this form"), false);
  assert.equal(detectsImageGenerationIntent("Polish the Mission Control UI visual design"), false);
});

test("Auto prefers Grok for image-generation prompts when Grok is connected", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [
    candidate("gpt-5.4", 10, { provider: "codex", label: "GPT-5.4" }),
    candidate("grok-4.6", 30, { provider: "grok", label: "Grok 4.6" }),
  ];
  const decision = chooseRoutingDecision(
    rows,
    { prompt: "generate a detailed image of a chicken wing", now },
    settings,
  );
  assert.equal(decision?.provider, "grok");
  assert.equal(decision?.model, "grok-4.6");
  assert.match(decision?.reason ?? "", /image generation/);
});

test("analyzing an attached image does not force image-gen preference toward Grok", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [
    candidate("gpt-5.6-luna", 10),
    candidate("grok-4.6", 40, { provider: "grok", label: "Grok 4.6" }),
  ];
  const withoutIntent = chooseRoutingDecision(
    rows,
    { prompt: "Quick: classify this", tier: "quick", now },
    settings,
  );
  const analyzeImage = chooseRoutingDecision(
    rows,
    {
      prompt: "analyze this image and list the objects",
      attachments: [{ id: "img", name: "wing.png", mimeType: "image/png", data: "AA==", kind: "image" }],
      now,
    },
    settings,
  );
  assert.equal(withoutIntent?.model, "gpt-5.6-luna");
  assert.equal(analyzeImage?.model, withoutIntent?.model);
  assert.notEqual(analyzeImage?.provider, "grok");
});

test("non-image prompts keep the same ranking winners as before image-gen preference", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  const rows = [
    candidate("gpt-5.6-sol", 20),
    candidate("gpt-5.6-terra", 20),
    candidate("gpt-5.6-luna", 20),
    candidate("grok-4.6", 20, { provider: "grok", label: "Grok 4.6" }),
  ];
  const quick = chooseRoutingDecision(rows, { prompt: "Quick: classify this", now }, settings);
  const deep = chooseRoutingDecision(
    rows,
    { prompt: "Architect a production migration", now },
    settings,
  );
  assert.equal(quick?.model, "gpt-5.6-luna");
  assert.equal(deep?.model, "gpt-5.6-sol");
});
