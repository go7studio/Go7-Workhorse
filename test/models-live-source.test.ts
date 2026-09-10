import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  advertisedModelIds,
  advertisedModelKey,
  claudeAdvertisedRows,
  claudeModelDisplayName,
  sameVendorModelCache,
  vendorModelCacheFrom,
} from "../src/lib/advertised-models";
import { applyVendorCatalog, findChoice, findChoiceOnProvider, MODEL_CATALOG, resetVendorCatalog, unlistedChoice } from "../src/lib/models";
import { deskCallCatalog } from "../src/lib/watch";
import { deskVendorCachePath, listVendorModels, readDeskCatalog, rememberDeskCatalog, rememberVendorModels } from "../electron/vendor-models";
import { modelNotOffered } from "../electron/grok-agent";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Source pins normalise line endings: a Windows checkout reads CRLF, and a pin
// that spans a line break must not depend on how git checked the file out.
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// Captured from @agentclientprotocol/claude-agent-acp 0.66.0 on 2026-09-02:
// session/new answers with configOptions, and the model option lists what
// Claude Code offers today. "default" is the agent's own fallback, not a model.
const SESSION_NEW = {
  sessionId: "sess_probe",
  modes: {},
  configOptions: [
    { id: "mode", currentValue: "default", options: [{ value: "auto" }, { value: "default" }] },
    {
      id: "model",
      currentValue: "claude-fable-5-1",
      options: [{ value: "default" }, { value: "opus[1m]" }, { value: "claude-fable-5-2" }, { value: "sonnet" }, { value: "haiku" }],
    },
    { id: "effort", currentValue: "default", options: [{ value: "low" }, { value: "high" }] },
  ],
};

test("the model list Claude advertises at session start is read, minus the agent's own default", () => {
  assert.deepEqual(advertisedModelIds(SESSION_NEW), ["opus[1m]", "claude-fable-5-2", "sonnet", "haiku"]);
  assert.deepEqual(advertisedModelIds({ sessionId: "x" }), []);
  assert.deepEqual(advertisedModelIds(null), []);
  assert.deepEqual(advertisedModelIds({ configOptions: [{ id: "model", options: ["sonnet", { value: "" }, 7] }] }), ["sonnet"]);
});

test("a full id the seed never listed becomes a row of its own; an alias adds nothing", () => {
  const rows = claudeAdvertisedRows(MODEL_CATALOG.claude, advertisedModelIds(SESSION_NEW));
  // An alias is a bare family word; any other id that names a family is a model.
  const bedrock = claudeAdvertisedRows(MODEL_CATALOG.claude, ["us.anthropic.claude-fable-5-2", "fable-5-2", "opus", "haiku[1m]", "gpt-9"]);
  assert.deepEqual(
    bedrock.filter((row) => !MODEL_CATALOG.claude.some((seed) => seed.id === row.id)).map((row) => row.id),
    ["us.anthropic.claude-fable-5-2", "fable-5-2"],
    "ids without the claude- prefix still earn rows; bare aliases and foreign ids do not",
  );
  const added = rows.filter((row) => !MODEL_CATALOG.claude.some((seed) => seed.id === row.id));
  assert.deepEqual(added.map((row) => row.id), ["claude-fable-5-2"], "only the id the seed lacks is new");
  assert.equal(added[0]?.name, "Fable 5.2");
  assert.equal(added[0]?.contextWindow, 1_000_000, "sized from its family");
  assert.equal(added[0]?.effort, true);
  assert.equal(rows.length, MODEL_CATALOG.claude.length + 1);
  assert.deepEqual(claudeAdvertisedRows(MODEL_CATALOG.claude, ["claude-opus-5"]).length, MODEL_CATALOG.claude.length, "a seed id is not doubled");
});

test("the same model advertised with a window tag or a dotted version is one row, not three", () => {
  // Captured from the desk's own cache on 2026-09-07: Claude Code listed
  // "claude-fable-5-1[1m]" and "claude-fable-5.1" side by side.
  const seeded = claudeAdvertisedRows(MODEL_CATALOG.claude, ["claude-fable-5-1[1m]", "claude-fable-5.1", "claude-fable-5-1"]);
  assert.equal(seeded.length, MODEL_CATALOG.claude.length, "the seed already lists Fable 5.1 once");
  assert.equal(seeded.filter((row) => row.name === "Fable 5.1").length, 1);
  const fresh = claudeAdvertisedRows(MODEL_CATALOG.claude, ["claude-fable-5-2[1m]", "claude-fable-5.2"]);
  const added = fresh.filter((row) => !MODEL_CATALOG.claude.some((seed) => seed.id === row.id));
  assert.deepEqual(added.map((row) => row.id), ["claude-fable-5-2"], "one row, spelled without the tag the launcher drops anyway");
  assert.equal(advertisedModelKey("Claude-Fable-5.1[1m]"), "fable-5-1");
  assert.equal(advertisedModelKey("fable-5-1"), advertisedModelKey("claude-fable-5-1"), "the bare family form is the same id without the vendor word");
  assert.equal(advertisedModelKey("claude-fable-5-1[2m]"), "fable-5-1", "any bracketed window tag folds, not only [1m]");
  assert.equal(advertisedModelKey("us.anthropic.claude-fable-5-1"), "us.anthropic.claude-fable-5-1", "a foreign prefix stays its own key");
  const bare = claudeAdvertisedRows(MODEL_CATALOG.claude, ["fable-5-1", "claude-fable-5-1[2m]", "opus[2m]"]);
  assert.equal(bare.length, MODEL_CATALOG.claude.length, "neither the bare form nor a [2m] tag doubles a seed row; an alias with any tag adds nothing");
  assert.deepEqual(claudeAdvertisedRows(MODEL_CATALOG.claude, ["fable-5-2", "claude-fable-5-2[1m]"]).slice(MODEL_CATALOG.claude.length).map((row) => row.id), ["fable-5-2"], "an unknown model advertised bare and prefixed is one row, in the spelling that came first");
});

test("a harness may name a model the way people write it", () => {
  assert.deepEqual(findChoice("Fable 5.1"), { provider: "claude", model: "claude-fable-5-1", effort: "medium", sandbox: "off" });
  assert.equal(findChoiceOnProvider("claude", "Fable 5.1")?.model, "claude-fable-5-1");
  assert.equal(findChoiceOnProvider("cursor", "Fable 5.1"), null, "stock Cursor has no Fable until cursor-agent models overlays it");
  applyVendorCatalog({
    cursor: [
      ...MODEL_CATALOG.cursor,
      { id: "claude-fable-5-1", name: "Claude Fable 5.1", effort: true, contextWindow: 1_000_000 },
    ],
  });
  assert.equal(findChoiceOnProvider("cursor", "Fable 5.1")?.model, "claude-fable-5-1");
  assert.equal(findChoiceOnProvider("cursor", "claude-fable-5-1")?.model, "claude-fable-5-1");
  resetVendorCatalog();
  assert.deepEqual(findChoice("GPT-6 Astra"), { provider: "codex", model: "gpt-6-astra", effort: "medium", sandbox: "off" });
  assert.equal(findChoice("gpt_6_astra")?.model, "gpt-6-astra");
  assert.equal(findChoice("GPT-5.6 Sol")?.model, "gpt-5.6-sol", "a space where the catalog has a hyphen still matches");
  assert.notEqual(findChoice("gpt-56-sol")?.model, "gpt-5.6-sol", "dots are not folded: 5.6 is not 56");
  assert.equal(findChoice("gpt-56-sol")?.unlisted, true, "so it goes to the vendor as its own id, and the vendor's refusal is the gate");
});

test("the Link helper lists what the desk lists: the desk saves what it serves, the helper reads that", () => {
  const codexCache = JSON.stringify({
    models: [
      { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", context_window: 272_000, max_context_window: 872_000, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
      { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", context_window: 272_000, max_context_window: 872_000 },
    ],
  });
  const home = path.join(ROOT, "does-not-exist");
  const served = listVendorModels({
    env: { CODEX_HOME: path.join(home, ".codex") },
    homedir: home,
    existsSync: (file) => file === path.join(home, ".codex", "models_cache.json"),
    readFile: (file) => (file === path.join(home, ".codex", "models_cache.json") ? codexCache : ""),
    cursorModelsOutput: null,
  });
  assert.deepEqual(served.codex.map((row) => row.id), ["gpt-6-astra", "gpt-5.6-sol"], "listed rows in the vendor's order; hidden rows stay hidden");
  const userData = mkdtempSync(path.join(os.tmpdir(), "wh-desk-catalog-"));
  try {
    assert.equal(readDeskCatalog(userData), undefined, "nothing served yet, nothing to read");
    assert.equal(rememberDeskCatalog(userData, served), true);
    assert.equal(rememberDeskCatalog(userData, served), false, "the same lists write nothing");
    const lists = readDeskCatalog(userData);
    assert.deepEqual(lists?.codex?.map((row) => row.id), ["gpt-6-astra", "gpt-5.6-sol"]);
    assert.equal(lists?.codex?.[0]?.contextWindow, 872_000, "the vendor's max window, not the session cap");
    assert.deepEqual(lists?.codex?.[0]?.reasoningLevels?.map((level) => level.id), ["low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.equal(Object.keys(lists ?? {}).sort().join(","), "claude,codex,cursor,grok", "custom slots stay with the desk");
    assert.ok(lists?.cursor?.some((row) => row.id === "composer-2.5"), "Cursor keeps its stock rows without a CLI call");
    try {
      applyVendorCatalog(lists ?? {});
      const rows = deskCallCatalog({
        settings: { usageBudgets: {}, llms: { codex: { connected: true, enabled: true } } as never, customBots: [] },
        usage: [],
        plans: {},
        permits: {},
      });
      const codex = rows.find((row) => row.provider === "codex");
      assert.deepEqual(codex?.models?.map((model) => model.id), ["gpt-6-astra", "gpt-5.6-sol"], "capacity and roster rows carry the live list");
      assert.equal(findChoice("GPT-6 Astra")?.model, "gpt-6-astra");
    } finally {
      resetVendorCatalog();
    }
    assert.equal(readDeskCatalog(userData, () => true, () => "{not json"), undefined, "a torn file is no list");
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
  const helper = read("electron/workhorse-mcp.ts");
  assert.match(helper, /function queryCapacity\(args: Record<string, unknown>\): string \{\n  refreshLinkVendorCatalog\(\);/, "capacity reads overlay first");
  assert.match(helper, /function deskRoster\(\) \{\n  refreshLinkVendorCatalog\(\);/, "roster reads overlay first");
  assert.match(helper, /if \(lists\) applyVendorCatalog\(lists\);\n    else resetVendorCatalog\(\);/, "a missing or torn file resets the overlay to the seed, not the last good read");
  assert.doesNotMatch(helper, /listVendorModels|models_cache/, "the helper never reads a vendor home itself");
  const main = read("electron/main.ts");
  assert.match(main, /rememberDeskCatalog\(app\.getPath\("userData"\), lists\);/, "the desk saves what it serves");
});

test("a display name comes from the id, not from a release", () => {
  assert.equal(claudeModelDisplayName("claude-fable-5-1"), "Fable 5.1");
  assert.equal(claudeModelDisplayName("claude-opus-5"), "Opus 5");
  assert.equal(claudeModelDisplayName("claude-haiku-4-5"), "Haiku 4.5");
  assert.equal(claudeModelDisplayName("opus[1m]"), "Opus");
  assert.equal(claudeModelDisplayName("something-else"), "something-else");
});

test("the desk's own cache is the vendor's latest word and survives a reboot", () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), "wh-models-"));
  try {
    assert.equal(rememberVendorModels(userData, "claude", ["opus[1m]", "claude-fable-5-1"]), true);
    assert.equal(rememberVendorModels(userData, "claude", ["opus[1m]", "claude-fable-5-1"]), false, "the same list writes nothing");
    assert.equal(rememberVendorModels(userData, "claude", ["opus[1m]", "claude-fable-5-2"]), true, "a new list replaces the old");
    const cache = JSON.parse(readFileSync(deskVendorCachePath(userData, "claude"), "utf8")) as { models: { slug: string }[] };
    assert.deepEqual(cache.models.map((row) => row.slug), ["opus[1m]", "claude-fable-5-2"], "a model the vendor stopped offering is gone");
    assert.equal(rememberVendorModels(userData, "claude", ["opus[1m]", "claude-fable-5-1"]), true);
    const listed = listVendorModels({ userData, env: {}, homedir: path.join(ROOT, "does-not-exist"), existsSync: (file) => file.startsWith(userData), readFile: (file) => readFileSync(file, "utf8") });
    assert.ok(listed.claude.some((row) => row.id === "claude-fable-5-1" && row.name === "Fable 5.1"), "the next boot lists what Claude advertised");
    assert.ok(listed.claude.some((row) => row.id === "claude-fable-5"), "the seed stays");
    assert.equal(listed.claude.some((row) => row.id === "opus[1m]"), false, "an alias never becomes a row");
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
  assert.deepEqual(vendorModelCacheFrom(["a", "a", " "]).models.map((row) => row.slug), ["a"]);
  assert.equal(sameVendorModelCache(undefined, vendorModelCacheFrom([])), true);
  assert.equal(sameVendorModelCache(vendorModelCacheFrom(["a"]), vendorModelCacheFrom(["a", "b"])), false);
});

test("passing userData no longer silences the Cursor listing", () => {
  const src = read("electron/vendor-models.ts");
  assert.doesNotMatch(src, /Object\.keys\(input\)\.length === 0/, "the old 'any input means a test' guard hid the live Cursor read");
  const withCursor = listVendorModels({ userData: path.join(ROOT, "does-not-exist"), cursorModelsOutput: "Available models\n\ncomposer-2.5 - Composer 2.5\ncursor-grok-4.6-high - Cursor Grok 4.6\n", env: {}, homedir: path.join(ROOT, "does-not-exist"), existsSync: () => false, readFile: () => "" });
  assert.ok(withCursor.cursor.some((row) => row.id === "composer-2.5"));
});

test("a typed id the list does not know is a choice when it names a vendor", () => {
  assert.deepEqual(unlistedChoice("claude-fable-5-2"), { provider: "claude", model: "claude-fable-5-2", effort: "medium", sandbox: "off", unlisted: true });
  assert.equal(unlistedChoice("gpt-5.7-sol")?.provider, "codex");
  assert.equal(unlistedChoice("grok-4.7")?.provider, "grok");
  assert.equal(unlistedChoice("composer-3")?.provider, "cursor");
  assert.equal(unlistedChoice("mystery-9"), null, "no family, no vendor, no choice");
  assert.equal(unlistedChoice("claude fable"), null);
  assert.equal(findChoice("claude-fable-5-2")?.unlisted, true, "/model falls through to the vendor's word");
  assert.equal(findChoice("claude-fable-5-1")?.unlisted, undefined, "Fable 5.1 is a seed row now");
  assert.equal(findChoice("Fable 5")?.unlisted, undefined, "a listed name still resolves to its row");
});

test("the advertised list flows from the session start to the desk cache and the picker", () => {
  const host = read("electron/claude-host.ts");
  assert.match(host, /advertisedModelIds\(started\.sessionNew\)/);
  assert.match(host, /type: "vendor-models", sessionId: input\.sessionId, provider: "claude", models/);
  const main = read("electron/main.ts");
  assert.match(main, /payload\.type === "vendor-models"\) rememberVendorModels\(app\.getPath\("userData"\), payload\.provider, payload\.models\)/);
  assert.doesNotMatch(main, /rememberVendorModels\(app\.getPath\("userData"\), "claude", \[input\.model\]\)/, "a finished turn is not the vendor accepting the model");
  // The custom half of the same list is checked by calling the shipped function
  // rather than by reading main.ts: a catalog handed in comes back as the
  // window on that bot's rows.
  const withCatalog = listVendorModels({
    env: {},
    homedir: path.join(ROOT, "does-not-exist"),
    existsSync: () => false,
    readFile: () => "",
    cursorModelsOutput: null,
    customBots: [
      {
        bot: { id: "bot_syn", model: "hf:zai-org/GLM-5.2", models: ["hf:zai-org/GLM-5.2"] },
        catalog: { models: [{ id: "hf:zai-org/GLM-5.2", contextWindow: 200_000 }], fetchedAt: 1 },
      },
    ],
  });
  const glm = withCatalog.custom.find((row) => row.id === "hf:zai-org/GLM-5.2");
  assert.equal(glm?.contextWindow, 200_000, "the host's window reaches the desk catalog");
  assert.equal(glm?.hostListed, true);
  assert.equal(glm?.customBotId, "bot_syn", "and stays attached to the slot that published it");
  const store = read("src/lib/store.tsx");
  assert.match(store, /event\.type === "vendor-models"\) \{\s*refreshVendorModels\(\);/);
  // The chat-setup header's own window is behaviour, not source: the formula it
  // renders is asserted against two live slots in custom-host-catalog.test.ts.
});

test("a typed model is put to the vendor before the turn, and a refusal names it", () => {
  assert.equal(modelNotOffered("Claude", "claude-bogus-9"), "Claude does not offer claude-bogus-9. Pick a listed model.");
  assert.equal(modelNotOffered(undefined, "x"), "The vendor does not offer x. Pick a listed model.");
  const agent = read("electron/grok-agent.ts");
  const config = agent.slice(agent.indexOf("private async applySessionConfig"), agent.indexOf("async prompt(text: string"));
  assert.match(config, /const unlisted = want\.id === "model" && this\.spec\.unlistedModel === true;/);
  assert.match(config, /&& !unlisted\) continue;/, "an unlisted model is not skipped past the config call");
  assert.match(config, /if \(unlisted\) throw new Error\(modelNotOffered\(this\.spec\.agentLabel, want\.value\)\);/, "the vendor's refusal ends the session with the model's name");
  const main = read("electron/main.ts");
  assert.match(main, /unlistedModel: !claudeModelListed\(raw\.model\)/, "main decides listed from the seed plus what Claude advertised");
  const host = read("electron/claude-host.ts");
  assert.match(host, /unlistedModel: input\.unlistedModel,/);
  const launch = read("electron/claude-launch.ts");
  assert.match(launch, /unlistedModel: input\.unlistedModel === true,/);
});

// --- from the Lane 8 gate (Cursor Grok 4.6) ---

test("the agent's own echo cannot excuse a typed model from the vendor's answer", () => {
  const agent = read("electron/grok-agent.ts");
  const config = agent.slice(agent.indexOf("private async applySessionConfig"), agent.indexOf("async prompt(text: string"));
  assert.match(
    config,
    /const unlisted = want\.id === "model" && this\.spec\.unlistedModel === true;\s*\/\/[\s\S]*?if \(option\.currentValue === want\.value && !unlisted\) continue;/,
    "currentValue is the launch talking to itself; a typed model must still be put to the vendor",
  );
  const skipAt = config.indexOf("option.currentValue === want.value");
  const unlistedAt = config.indexOf("const unlisted =");
  assert.ok(unlistedAt < skipAt, "the unlisted flag has to be known before the skip is considered");
});

test("listed is decided on what the launch will actually send", () => {
  const main = read("electron/main.ts");
  const check = main.slice(main.indexOf("const claudeModelListed"), main.indexOf("ipcMain.removeHandler(\"grok:plan-usage\")"));
  assert.match(check, /const resolved = resolveClaudeModel\(model\)\.toLowerCase\(\);/, "a family alias resolves before it is judged");
  assert.match(check, /id === raw \|\| id === resolved/, "and either spelling counts as listed");
  assert.match(check, /cursorModelsOutput: null/, "this question must never spawn the Cursor CLI");
});

test("a vendor that answers with nothing does not wipe the list it gave before", () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), "wh-models-empty-"));
  try {
    assert.equal(rememberVendorModels(userData, "claude", ["claude-fable-5-1"]), true);
    assert.equal(rememberVendorModels(userData, "claude", []), false, "an empty answer is a blip, not an instruction to forget");
    const cache = JSON.parse(readFileSync(deskVendorCachePath(userData, "claude"), "utf8")) as { models: { slug: string }[] };
    assert.deepEqual(cache.models.map((row) => row.slug), ["claude-fable-5-1"]);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
