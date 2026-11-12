import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addBotChoices } from "../src/ui/AddBot.tsx";
import { normalizeSettings } from "../src/lib/settings";
import { routingCandidatesForDesk } from "../src/lib/routing";
import { deskCallCatalog } from "../src/lib/watch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Google Gemini login cannot be saved, routed, or offered", () => {
  const settings = normalizeSettings({
    llms: { gemini: { connected: true, enabled: true, needsAuth: true, launchable: true, available: true } },
  });
  assert.equal(settings.llms.gemini.connected, false);
  assert.equal(settings.llms.gemini.enabled, false);
  assert.equal(settings.llms.gemini.needsAuth, false);
  assert.equal(settings.llms.gemini.launchable, false);
  assert.match(settings.llms.gemini.launchBlocker ?? "", /Google Gemini login was removed/);

  settings.llms.grok = { connected: true, enabled: true, launchable: true };
  settings.llms.gemini = { connected: true, enabled: true, launchable: true };
  assert.equal(routingCandidatesForDesk(settings).some((row) => row.provider === "gemini"), false);
  assert.equal(
    deskCallCatalog({ settings, usage: [], plans: {}, permits: {} }).some((row) => row.provider === "gemini"),
    false,
  );
  assert.deepEqual(
    addBotChoices({
      grok: { connected: false },
      codex: { connected: false },
      claude: { connected: false },
      cursor: { connected: false },
      gemini: { connected: false },
    }).map((item) => item.id),
    ["grok", "codex", "claude", "cursor", "grok-bot", "dgx-spark", "own"],
  );
});

test("the desktop process does not launch the Antigravity CLI", () => {
  const electron = readdirSync(path.join(ROOT, "electron")).filter((name) => name.endsWith(".ts"));
  assert.equal(electron.some((name) => name.startsWith("agy-")), false);
  const blob = electron.map((name) => readFileSync(path.join(ROOT, "electron", name), "utf8")).join("\n");
  assert.doesNotMatch(blob, /AgySessionHost|readAgyUsageStdout|readInstalledAgyModels|from "\.\/agy-/);
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.doesNotMatch(store, /geminiPrompt\(|detectGeminiLogin|geminiPlanUsage\(/);
});
