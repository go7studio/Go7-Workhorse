import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareModels,
  groupModelIds,
  makerLabel,
  modelChipLabel,
  parseModelId,
  visibleModelGroups,
} from "../src/lib/model-groups";

// Ids in the shapes Synthetic's /models actually answers with.
const SYNTHETIC = [
  "hf:Qwen/Qwen2.5-7B",
  "syn:small:text",
  "hf:moonshotai/Kimi-K2",
  "hf:zai-org/GLM-5.2",
  "hf:meta-llama/Llama-3.1-405B",
  "syn:large:text",
  "hf:Qwen/Qwen3.6-27B",
  "hf:moonshotai/Kimi-K3",
  "syn:large:vision",
  "hf:deepseek-ai/DeepSeek-V3",
];

test("an id is read as maker, family, version and size", () => {
  const kimi = parseModelId("hf:moonshotai/Kimi-K3");
  assert.equal(kimi.scheme, "hf");
  assert.equal(kimi.maker, "moonshotai");
  assert.equal(kimi.version, 3);
  assert.equal(kimi.alias, false);

  // A parameter count is a size, not a version — 3.6 at 27B, not version 27.
  const qwen = parseModelId("hf:Qwen/Qwen3.6-27B");
  assert.equal(qwen.version, 3.6);
  assert.equal(qwen.params, 27);

  const llama = parseModelId("hf:meta-llama/Llama-3.1-405B");
  assert.equal(llama.version, 3.1);
  assert.equal(llama.params, 405);

  // An alias routes to whatever is best today; it has no version of its own.
  const alias = parseModelId("syn:large:text");
  assert.equal(alias.alias, true);
  assert.equal(alias.version, undefined);

  // A bare id still parses.
  const bare = parseModelId("gpt-4o");
  assert.equal(bare.maker, undefined);
  assert.equal(bare.alias, false);
});

test("newest first, then biggest, and never a wobble", () => {
  const sorted = [
    parseModelId("hf:moonshotai/Kimi-K2"),
    parseModelId("hf:moonshotai/Kimi-K3"),
  ].sort(compareModels);
  assert.deepEqual(sorted.map((model) => model.id), ["hf:moonshotai/Kimi-K3", "hf:moonshotai/Kimi-K2"]);

  // Same version, bigger wins.
  const bySize = [parseModelId("hf:x/M-2-7B"), parseModelId("hf:x/M-2-70B")].sort(compareModels);
  assert.deepEqual(bySize.map((model) => model.id), ["hf:x/M-2-70B", "hf:x/M-2-7B"]);

  // Nothing to separate them: stable by id, so the list never reorders itself.
  const tie = [parseModelId("hf:x/b"), parseModelId("hf:x/a")].sort(compareModels);
  assert.deepEqual(tie.map((model) => model.id), ["hf:x/a", "hf:x/b"]);
});

test("grouped by maker, aliases first, newest maker next, older models never at the front", () => {
  const groups = groupModelIds(SYNTHETIC);
  // GLM 5.2, Qwen 3.6, Llama 3.1, then the two on 3 broken alphabetically.
  assert.deepEqual(
    groups.map((group) => group.label),
    ["Automatic", "Z.ai", "Qwen", "Meta", "DeepSeek", "Moonshot AI"],
  );

  // Aliases lead: they route to the current best, so they are the safe pick.
  assert.equal(groups[0]!.key, "alias");
  assert.deepEqual(groups[0]!.models.map((model) => model.id), ["syn:large:text", "syn:large:vision", "syn:small:text"]);

  // Each maker leads with its newest — a 2.5 checkpoint never sits above 3.6.
  const qwen = groups.find((group) => group.label === "Qwen")!;
  assert.deepEqual(qwen.models.map((model) => model.id), ["hf:Qwen/Qwen3.6-27B", "hf:Qwen/Qwen2.5-7B"]);
  const moonshot = groups.find((group) => group.label === "Moonshot AI")!;
  assert.equal(moonshot.models[0]!.id, "hf:moonshotai/Kimi-K3");

  // Makers are ordered by their frontier: GLM 5.2 above Qwen 3.6 above Kimi 3.
  assert.ok(groups.findIndex((g) => g.label === "Z.ai") < groups.findIndex((g) => g.label === "Qwen"));
  assert.ok(groups.findIndex((g) => g.label === "Qwen") < groups.findIndex((g) => g.label === "Moonshot AI"));
  // A tie on version is broken by name, so the order is the same every render.
  assert.ok(groups.findIndex((g) => g.label === "DeepSeek") < groups.findIndex((g) => g.label === "Moonshot AI"));
});

test("ungrouped ids fall to the end rather than scattering", () => {
  const groups = groupModelIds(["gpt-4o", "hf:moonshotai/Kimi-K3", "syn:large:text"]);
  assert.equal(groups[0]!.label, "Automatic");
  assert.equal(groups[groups.length - 1]!.label, "Other");
  assert.deepEqual(groups[groups.length - 1]!.models.map((model) => model.id), ["gpt-4o"]);
});

test("maker and chip labels read like names, not slugs", () => {
  assert.equal(makerLabel("moonshotai"), "Moonshot AI");
  assert.equal(makerLabel("zai-org"), "Z.ai");
  assert.equal(makerLabel("deepseek-ai"), "DeepSeek");
  assert.equal(makerLabel("meta-llama"), "Meta");
  assert.equal(makerLabel("some-new-lab"), "Some New Lab");
  assert.equal(makerLabel("ibm"), "IBM");

  assert.equal(modelChipLabel(parseModelId("hf:moonshotai/Kimi-K3")), "Kimi-K3");
  assert.equal(modelChipLabel(parseModelId("syn:large:text")), "large:text");
  assert.equal(modelChipLabel(parseModelId("gpt-4o")), "gpt-4o");
});

test("duplicates and blanks never reach the list", () => {
  const groups = groupModelIds(["hf:x/A-1", " hf:x/A-1 ", "", "   "]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.models.length, 1);
  assert.deepEqual(groupModelIds([]), []);
});

test("OpenRouter auto is an automatic route and maker catalogs stay frontier-first", () => {
  const groups = groupModelIds([
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-4.1",
    "openrouter/auto",
    "openai/gpt-5.4",
    "anthropic/claude-opus-4.8",
  ]);
  assert.equal(groups[0]!.label, "Automatic");
  assert.equal(groups[0]!.models[0]!.id, "openrouter/auto");
  assert.deepEqual(
    groups.find((group) => group.label === "OpenAI")!.models.map((model) => model.id),
    ["openai/gpt-5.4", "openai/gpt-4.1"],
  );
  assert.deepEqual(
    groups.find((group) => group.label === "Anthropic")!.models.map((model) => model.id),
    ["anthropic/claude-opus-4.8", "anthropic/claude-sonnet-4.5"],
  );
});

test("large catalogs are bounded, searchable, and keep approved models visible", () => {
  const ids = [
    "openrouter/auto",
    ...Array.from({ length: 10 }, (_, index) => `openai/gpt-${index + 1}`),
    "anthropic/claude-opus-4.8",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3.1-pro",
    "xai/grok-4.6",
    "zai-org/glm-5.2",
    "moonshotai/kimi-k3",
    "deepseek/deepseek-v3.2",
  ];
  const groups = groupModelIds(ids);
  const view = visibleModelGroups(groups, {
    approved: ["openai/gpt-1", "deepseek/deepseek-v3.2"],
    maxGroups: 4,
    maxModelsPerGroup: 3,
  });
  assert.ok(view.hiddenCount > 0);
  assert.ok(view.groups.length >= 4);
  assert.equal(view.groups[0]!.label, "Automatic");
  assert.ok(view.groups.flatMap((group) => group.models).some((model) => model.id === "openai/gpt-1"));
  assert.ok(view.groups.flatMap((group) => group.models).some((model) => model.id === "deepseek/deepseek-v3.2"));

  const search = visibleModelGroups(groups, { query: "anthropic", maxGroups: 1, maxModelsPerGroup: 1 });
  assert.equal(search.groups.length, 1);
  assert.equal(search.groups[0]!.label, "Anthropic");
  assert.equal(search.groups[0]!.models[0]!.id, "anthropic/claude-opus-4.8");
  assert.equal(search.hiddenCount, 1);

  const expanded = visibleModelGroups(groups, { expanded: true });
  assert.equal(expanded.hiddenCount, 0);
  assert.equal(expanded.totalCount, ids.length);
});
