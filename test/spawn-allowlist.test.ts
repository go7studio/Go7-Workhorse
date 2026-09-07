import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeSession } from "../src/lib/session";
import {
  filterCandidatesBySpawnAllowlist,
  filterCatalogBySpawnAllowlist,
  isGrokBotCustom,
  normalizeSpawnAllowlist,
  orchestrateChipLabel,
  rootSessionOf,
  spawnAllowlistBlockedError,
  spawnAllowlistForCaller,
  spawnAllowlistIdForCatalogRow,
  spawnAllowlistIdForSpec,
  spawnAllowlistNames,
  spawnIdentityAllowed,
  spawnPickerRows,
  spawnSpecDisplayName,
  toggleSpawnAllowlistId,
} from "../src/lib/spawn-allowlist";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import { withCrewModeHint } from "../src/lib/workhorse-rules";
import type { CustomBot, Session } from "../src/lib/types";
import type { DeskCallRow } from "../src/lib/watch";
import type { RoutingCandidate } from "../src/lib/routing";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const bot = (id: string, name: string, extra: Partial<CustomBot> = {}): CustomBot => ({
  id,
  name,
  color: "#0071e3",
  baseUrl: "https://api.example.com/v1",
  model: `${id}-model`,
  apiKey: "sk-test",
  api: "openai-completions",
  contextWindow: 128_000,
  createdAt: 1,
  enabled: true,
  ...extra,
});

const settings = {
  ...DEFAULT_SETTINGS,
  llms: {
    ...DEFAULT_SETTINGS.llms,
    grok: { connected: true },
    claude: { connected: true },
    codex: { connected: true, enabled: false },
    cursor: { connected: true },
  },
  customBots: [
    bot("mini", "MiniMax"),
    bot("grokbot", "Grok Bot", { baseUrl: "http://127.0.0.1:8787", model: "grok-bot" }),
  ],
};

test("spawn allowlist normalizes empty and junk to all bots", () => {
  assert.equal(normalizeSpawnAllowlist(undefined), undefined);
  assert.equal(normalizeSpawnAllowlist([]), undefined);
  assert.equal(normalizeSpawnAllowlist(["nope", ""]), undefined);
  assert.deepEqual(normalizeSpawnAllowlist(["claude", "claude", "cursor:other-models", "bot:mini"]), [
    "claude",
    "cursor",
    "bot:mini",
  ]);
});

test("a new chat has no spawn allowlist after normalizeSession", () => {
  const saved = {
    id: "sess_new",
    projectId: null,
    provider: "grok",
    model: "grok-4.6",
    title: "New chat",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    messages: [],
    contextUsed: 0,
  };
  assert.equal(normalizeSession(saved)?.spawnAllowlist, undefined);
  const kept = normalizeSession({ ...saved, spawnAllowlist: ["claude", "bot:mini"] });
  assert.deepEqual(kept?.spawnAllowlist, ["claude", "bot:mini"]);
  assert.deepEqual(
    normalizeSession(JSON.parse(JSON.stringify(kept)))?.spawnAllowlist,
    ["claude", "bot:mini"],
  );
});

test("the picker lists connected stock vendors and custom bots, not Grok Bot", () => {
  const rows = spawnPickerRows(settings);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["grok", "claude", "cursor", "bot:mini"],
  );
  assert.equal(rows.some((row) => row.id === "codex"), false);
  assert.equal(isGrokBotCustom(settings.customBots[1]!), true);
});

test("unchecking the last bot snaps back to all", () => {
  const available = ["grok", "claude", "cursor"];
  assert.deepEqual(toggleSpawnAllowlistId(undefined, "claude", available), ["grok", "cursor"]);
  assert.equal(toggleSpawnAllowlistId(["grok", "cursor"], "grok", available)?.join(), "cursor");
  assert.equal(toggleSpawnAllowlistId(["cursor"], "cursor", available), undefined);
  assert.equal(toggleSpawnAllowlistId(["grok", "claude"], "cursor", available), undefined);
});

test("Cursor catalog lanes and custom bots map to stable spawn ids", () => {
  const composer: Pick<DeskCallRow, "id" | "provider" | "kind"> = {
    id: "cursor:cursor-models",
    provider: "cursor",
    kind: "vendor",
  };
  const api: Pick<DeskCallRow, "id" | "provider" | "kind"> = {
    id: "cursor:other-models",
    provider: "cursor",
    kind: "vendor",
  };
  const custom: Pick<DeskCallRow, "id" | "provider" | "kind"> = {
    id: "bot:mini",
    provider: "custom",
    kind: "custom",
  };
  assert.equal(spawnAllowlistIdForCatalogRow(composer), "cursor");
  assert.equal(spawnAllowlistIdForCatalogRow(api), "cursor");
  assert.equal(spawnAllowlistIdForCatalogRow(custom), "bot:mini");
  assert.equal(spawnAllowlistIdForSpec({ provider: "cursor" }), "cursor");
  assert.equal(spawnAllowlistIdForSpec({ provider: "custom", customBotId: "mini" }), "bot:mini");
});

test("list_bots and Auto candidates stay inside this chat’s allowlist", () => {
  const rows: Array<Pick<DeskCallRow, "id" | "provider" | "kind" | "name">> = [
    { id: "grok", provider: "grok", kind: "vendor", name: "Grok" },
    { id: "claude", provider: "claude", kind: "vendor", name: "Claude" },
    { id: "cursor:cursor-models", provider: "cursor", kind: "vendor", name: "Cursor · Composer" },
    { id: "cursor:other-models", provider: "cursor", kind: "vendor", name: "Cursor · API" },
    { id: "bot:mini", provider: "custom", kind: "custom", name: "MiniMax" },
  ];
  const filtered = filterCatalogBySpawnAllowlist(rows, ["claude", "cursor"]);
  assert.deepEqual(
    filtered.map((row) => row.id),
    ["claude", "cursor:cursor-models", "cursor:other-models"],
  );
  const candidates: Array<Pick<RoutingCandidate, "provider" | "model" | "customBotId">> = [
    { provider: "grok", model: "grok-4.6" },
    { provider: "claude", model: "opus" },
    { provider: "cursor", model: "composer-2.5" },
    { provider: "custom", model: "mini-model", customBotId: "mini" },
  ];
  assert.deepEqual(
    filterCandidatesBySpawnAllowlist(candidates, ["claude"]).map((item) => item.provider),
    ["claude"],
  );
  assert.equal(spawnIdentityAllowed(["claude"], "grok"), false);
  assert.equal(spawnIdentityAllowed(undefined, "grok"), true);
  assert.match(spawnAllowlistBlockedError("Grok"), /does not include Grok/);
  assert.equal(spawnSpecDisplayName({ provider: "claude" }), "Claude");
});

test("nested workers read the root chat’s allowlist", () => {
  const sessions = [
    { id: "orch", parentId: undefined, spawnAllowlist: ["claude"] },
    { id: "w1", parentId: "orch", spawnAllowlist: undefined },
    { id: "h1", parentId: "w1", spawnAllowlist: undefined },
  ];
  assert.equal(rootSessionOf(sessions, "h1")?.id, "orch");
  assert.deepEqual(spawnAllowlistForCaller(sessions, "h1"), ["claude"]);
  assert.equal(spawnAllowlistForCaller(sessions, "missing"), undefined);
});

test("Orchestrate hint names the forced bots; the chip shows the count", () => {
  assert.equal(orchestrateChipLabel(undefined), "Orchestrate");
  assert.equal(orchestrateChipLabel(["claude", "cursor"]), "Orchestrate · 2");
  assert.deepEqual(spawnAllowlistNames(["claude"], settings), ["Claude"]);
  const hinted = withCrewModeHint("Do the work.", "orchestrate", undefined, ["Claude", "Cursor"]);
  assert.match(hinted, /Spawn only from: Claude, Cursor/);
  assert.doesNotMatch(withCrewModeHint("Do the work.", "orchestrate"), /Spawn only from:/);
});

test("the composer gear and spawn gate are wired, and new chats do not copy the list", () => {
  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(composer, /onContextMenu/);
  assert.match(composer, /composer-crew-gear/);
  assert.match(composer, /Choose bots for this chat/);
  assert.match(composer, /All bots/);
  assert.match(composer, /setSpawnAllowlist/);
  assert.match(composer, /setCrewMode\(toggleCrewMode/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.composer-crew-gear/);
  assert.match(css, /\.composer-spawn-menu/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /filterCatalogBySpawnAllowlist/);
  assert.match(store, /spawnAllowlistBlockedError/);
  assert.match(store, /setSpawnAllowlist/);
  const start = store.slice(store.indexOf("const startSession"), store.indexOf("const setSessionModel"));
  assert.doesNotMatch(start, /spawnAllowlist/);
  assert.match(readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8"), /gear on that chip/);
});

test("Session persists spawnAllowlist on the type", () => {
  const sample: Pick<Session, "spawnAllowlist"> = { spawnAllowlist: ["grok"] };
  assert.deepEqual(sample.spawnAllowlist, ["grok"]);
});
