import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveCursorModel } from "../electron/cursor-launch";
import { buildGrokLaunchSpec } from "../electron/grok-launch";
import { rememberCursorBases, type CursorCatalogRow } from "../src/lib/cursor-catalog";
import { supportsFastMode } from "../src/lib/models";
import {
  applySessionModelChange,
  formatChatSidebar,
  normalizeSession,
  vendorBrainChanged,
  vendorSessionForSend,
} from "../src/lib/session";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("supportsFastMode is only for Grok, Claude, and Cursor", () => {
  assert.equal(supportsFastMode("grok", "grok-4.7"), true);
  assert.equal(supportsFastMode("claude", "claude-sonnet-5"), true);
  assert.equal(supportsFastMode("cursor", "composer-2.5"), true);
  assert.equal(supportsFastMode("codex", "gpt-5.6-sol"), false);
  assert.equal(supportsFastMode("gemini", "gemini-3.8-flash-high"), false);
  assert.equal(supportsFastMode("custom", "MiniMax-M3"), false);
});

test("normalizeSession keeps Fast on, and toggling Fast drops the vendor session", () => {
  const saved = normalizeSession({
    id: "sess_fast",
    provider: "grok",
    model: "grok-4.7",
    effort: "high",
    fastMode: true,
    mode: "ask",
    vendorSessionId: "grok-acp-1",
    vendorProvider: "grok",
    status: "idle",
    messages: [],
  });
  assert.ok(saved);
  assert.equal(saved!.fastMode, true);

  const off = applySessionModelChange(saved!, {
    provider: "grok",
    model: "grok-4.7",
    effort: "high",
    fastMode: false,
  });
  assert.equal(off.fastMode, undefined);
  assert.equal(off.vendorSessionId, undefined);
  assert.equal(vendorSessionForSend(off), undefined);

  const kept = applySessionModelChange(saved!, {
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
  });
  assert.equal(kept.fastMode, true, "a model change that still supports Fast keeps it");
  assert.equal(kept.vendorSessionId, undefined, "a new model still drops the old vendor session");
});

test("sidebar shows Fast when the chat has it on", () => {
  assert.equal(
    formatChatSidebar({ provider: "cursor", model: "composer-2.5", effort: "high", mode: "always-approve", fastMode: true }),
    "Composer 2.5 · High · Fast",
  );
  assert.equal(
    formatChatSidebar({ provider: "grok", model: "grok-4.7", effort: "medium", mode: "ask", fastMode: true }),
    "Grok 4.7 · Medium · Fast · Ask",
  );
});

test("vendorBrainChanged catches Composer to Cursor Grok and Fast flips", () => {
  const prior = {
    provider: "cursor" as const,
    model: "composer-2.5",
    effort: "high" as const,
    customBotId: undefined,
    fastMode: undefined,
  };
  assert.equal(
    vendorBrainChanged(prior, {
      provider: "cursor",
      model: "grok-4.7-high",
      effort: "high",
      customBotId: undefined,
      fastMode: undefined,
    }),
    true,
  );
  assert.equal(
    vendorBrainChanged(prior, {
      ...prior,
      fastMode: true,
    }),
    true,
  );
  assert.equal(vendorBrainChanged(prior, prior), false);
});

test("Cursor launch picks a -fast slug when Fast is on", () => {
  const rows: CursorCatalogRow[] = [
    {
      id: "composer-2.5",
      name: "Composer 2.5",
      effort: true,
      contextWindow: 200_000,
      aliases: ["composer-2.5-fast"],
      launchIds: ["composer-2.5", "composer-2.5-fast"],
    },
  ];
  rememberCursorBases(rows);
  assert.equal(resolveCursorModel("composer-2.5", "medium", { fast: true }), "composer-2.5-fast");
  assert.equal(resolveCursorModel("composer-2.5", "medium", { fast: false }), "composer-2.5");
});

test("Grok launch spec carries Fast so ACP can set the config option", () => {
  const on = buildGrokLaunchSpec({
    model: "grok-4.7",
    effort: "high",
    cwd: ROOT,
    mode: "ask",
    fastMode: true,
  });
  assert.equal(on.fastMode, true);
  const off = buildGrokLaunchSpec({
    model: "grok-4.7",
    effort: "high",
    cwd: ROOT,
    mode: "ask",
  });
  assert.equal(off.fastMode, undefined);
});

test("spawn reuse cancels and clears the vendor session when the brain changes", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /vendorBrainChanged\(priorWorker, nextBrain\)/);
  assert.match(store, /if \(priorWorker && brainChanged\) cancelVendorSession\(priorWorker\)/);
  assert.match(store, /spawnSeed === "fresh" \|\| brainChanged/);
  assert.match(store, /setSessionFastMode/);
  assert.match(store, /fastMode: true as const/);
  const setup = readFileSync(path.join(ROOT, "src", "ui", "SessionSetup.tsx"), "utf8");
  assert.match(setup, /supportsFastMode\(session\.provider, session\.model\)/);
  assert.match(setup, /setSessionFastMode\(true\)/);
  const cursorLaunch = readFileSync(path.join(ROOT, "electron", "cursor-launch.ts"), "utf8");
  assert.match(cursorLaunch, /fast: input\.fastMode === true/);
  const grokHost = readFileSync(path.join(ROOT, "electron", "grok-host.ts"), "utf8");
  assert.match(grokHost, /fastMode: input\.fastMode/);
});

test("Next queue offers Edit so a queued prompt can return to the composer", () => {
  const composer = readFileSync(path.join(ROOT, "src", "ui", "Composer.tsx"), "utf8");
  assert.match(composer, /editQueuedPrompt/);
  assert.match(composer, /prompt-queue-edit/);
  assert.match(composer, /setComposerDraft\(sessionId, text, nextImages, true\)/);
  assert.match(composer, /dropQueued\(id\)/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "chat.2.css"), "utf8");
  assert.match(css, /\.prompt-queue-edit/);
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  assert.match(features, /Edit puts it back in/);
});
