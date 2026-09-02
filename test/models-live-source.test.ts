import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  advertisedModelIds,
  claudeAdvertisedRows,
  claudeModelDisplayName,
  sameVendorModelCache,
  vendorModelCacheFrom,
} from "../src/lib/advertised-models";
import { findChoice, MODEL_CATALOG, unlistedChoice } from "../src/lib/models";
import { deskVendorCachePath, listVendorModels, rememberVendorModels } from "../electron/vendor-models";
import { modelNotOffered } from "../electron/grok-agent";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

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
      options: [{ value: "default" }, { value: "opus[1m]" }, { value: "claude-fable-5-1" }, { value: "sonnet" }, { value: "haiku" }],
    },
    { id: "effort", currentValue: "default", options: [{ value: "low" }, { value: "high" }] },
  ],
};

test("the model list Claude advertises at session start is read, minus the agent's own default", () => {
  assert.deepEqual(advertisedModelIds(SESSION_NEW), ["opus[1m]", "claude-fable-5-1", "sonnet", "haiku"]);
  assert.deepEqual(advertisedModelIds({ sessionId: "x" }), []);
  assert.deepEqual(advertisedModelIds(null), []);
  assert.deepEqual(advertisedModelIds({ configOptions: [{ id: "model", options: ["sonnet", { value: "" }, 7] }] }), ["sonnet"]);
});

test("a full id the seed never listed becomes a row of its own; an alias adds nothing", () => {
  const rows = claudeAdvertisedRows(MODEL_CATALOG.claude, advertisedModelIds(SESSION_NEW));
  // An alias is a bare family word; any other id that names a family is a model.
  const bedrock = claudeAdvertisedRows(MODEL_CATALOG.claude, ["us.anthropic.claude-fable-5-1", "fable-5-2", "opus", "haiku[1m]", "gpt-9"]);
  assert.deepEqual(
    bedrock.filter((row) => !MODEL_CATALOG.claude.some((seed) => seed.id === row.id)).map((row) => row.id),
    ["us.anthropic.claude-fable-5-1", "fable-5-2"],
    "ids without the claude- prefix still earn rows; bare aliases and foreign ids do not",
  );
  const added = rows.filter((row) => !MODEL_CATALOG.claude.some((seed) => seed.id === row.id));
  assert.deepEqual(added.map((row) => row.id), ["claude-fable-5-1"], "only the id the seed lacks is new");
  assert.equal(added[0]?.name, "Fable 5.1");
  assert.equal(added[0]?.contextWindow, 1_000_000, "sized from its family");
  assert.equal(added[0]?.effort, true);
  assert.equal(rows.length, MODEL_CATALOG.claude.length + 1);
  assert.deepEqual(claudeAdvertisedRows(MODEL_CATALOG.claude, ["claude-opus-5"]).length, MODEL_CATALOG.claude.length, "a seed id is not doubled");
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
  assert.deepEqual(unlistedChoice("claude-fable-5-1"), { provider: "claude", model: "claude-fable-5-1", effort: "medium", sandbox: "off", unlisted: true });
  assert.equal(unlistedChoice("gpt-5.7-sol")?.provider, "codex");
  assert.equal(unlistedChoice("grok-4.7")?.provider, "grok");
  assert.equal(unlistedChoice("composer-3")?.provider, "cursor");
  assert.equal(unlistedChoice("mystery-9"), null, "no family, no vendor, no choice");
  assert.equal(unlistedChoice("claude fable"), null);
  assert.equal(findChoice("claude-fable-5-1")?.unlisted, true, "/model falls through to the vendor's word");
  assert.equal(findChoice("Fable 5")?.unlisted, undefined, "a listed name still resolves to its row");
});

test("the advertised list flows from the session start to the desk cache and the picker", () => {
  const host = read("electron/claude-host.ts");
  assert.match(host, /advertisedModelIds\(started\.sessionNew\)/);
  assert.match(host, /type: "vendor-models", sessionId: input\.sessionId, provider: "claude", models/);
  const main = read("electron/main.ts");
  assert.match(main, /payload\.type === "vendor-models"\) rememberVendorModels\(app\.getPath\("userData"\), payload\.provider, payload\.models\)/);
  assert.doesNotMatch(main, /rememberVendorModels\(app\.getPath\("userData"\), "claude", \[input\.model\]\)/, "a finished turn is not the vendor accepting the model");
  assert.match(main, /listVendorModels\(\{ userData: app\.getPath\("userData"\) \}\)/);
  const store = read("src/lib/store.tsx");
  assert.match(store, /event\.type === "vendor-models"\) \{\s*refreshVendorModels\(\);/);
  const setup = read("src/ui/SessionSetup.tsx");
  assert.match(setup, /formatWindow\(contextWindowFor\(session\.provider, session\.model\)\)/, "an unlisted id still shows a window");
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
