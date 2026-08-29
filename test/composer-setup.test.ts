import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { COMMANDS } from "../src/lib/commands";
import { formatChatSidebar } from "../src/lib/session";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

test("the composer chip omits Always and still names Ask", () => {
  assert.equal(
    formatChatSidebar({ provider: "grok", model: "grok-4.6", effort: "high", mode: "always-approve" }),
    "Grok 4.6 · High",
  );
  assert.equal(
    formatChatSidebar({
      provider: "cursor",
      model: "cursor-grok-4.6-high",
      effort: "medium",
      mode: "ask",
    }),
    "Cursor Grok 4.6 · Medium · Ask",
  );
  assert.equal(
    formatChatSidebar({
      provider: "cursor",
      model: "composer-2.5",
      effort: "high",
      mode: "always-approve",
      routingMode: "auto",
    }),
    "Auto · High",
  );
  const composer = read("src/ui/Composer.tsx");
  const chip = composer.slice(
    composer.indexOf("className={`setup-trigger"),
    composer.indexOf("className={`setup-trigger") + 1400,
  );
  assert.match(chip, /formatChatSidebar\(/);
  assert.doesNotMatch(chip, /shortModeLabel/);
});

test("opening chat settings does not persist a default effort", () => {
  const setup = read("src/ui/SessionSetup.tsx");
  for (const effect of setup.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)) {
    assert.doesNotMatch(effect[1], /setSessionEffort/);
  }
  assert.match(setup, /withEffort\(session\.provider, session\.model, session\.effort/);
  assert.match(setup, /setSessionEffort\(next\.id/);
});

test("/providers names the vendor and model sheet", () => {
  const providers = COMMANDS.find((command) => command.id === "providers");
  const home = COMMANDS.find((command) => command.id === "new");
  assert.ok(providers);
  assert.ok(home);
  assert.equal(home.hint, "Back to this project’s home");
  assert.notEqual(providers.hint, home.hint);
  assert.match(providers.hint, /vendor/i);
  assert.match(providers.hint, /model/i);
  assert.doesNotMatch(providers.hint, /home/i);
});

test("the model chip is wide enough for Cursor Grok 4.6 · Medium · Ask", () => {
  const css = read("src/styles/app.css");
  const trigger = css.match(/\.setup-trigger \{([^}]+)\}/)?.[1] ?? "";
  const max = Number(trigger.match(/max-width:\s*(\d+)px/)?.[1]);
  assert.ok(max >= 272 && max <= 360, `compact chip max-width, got ${max}`);
});
