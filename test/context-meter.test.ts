import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { estimateChatContext, formatRetainedPct, retainedContextStats } from "../src/lib/context-stats";
import { placeContextPop } from "../src/ui/ContextMeter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("context pop sits under the meter instead of stretching from the viewport right edge", () => {
  const meter = { top: 120, bottom: 160, left: 900, right: 980, width: 80, height: 40 };
  const placed = placeContextPop({
    meter,
    pop: { width: 292, height: 220 },
    viewport: { width: 1280, height: 800 },
  });
  assert.equal(placed.top, 168);
  assert.ok(placed.left + 292 <= 1280 - 12);
  const tight = placeContextPop({
    meter: { top: 600, bottom: 640, left: 1000, right: 1080, width: 80, height: 40 },
    pop: { width: 292, height: 220 },
    viewport: { width: 1100, height: 700 },
  });
  assert.ok(tight.top < 600);
  assert.ok(tight.left + 292 <= 1100 - 12);
});

test("Usage and Settings context meters are catalog size, not a live chat", () => {
  const usage = readFileSync(path.join(ROOT, "src", "ui", "UsagePane.tsx"), "utf8");
  assert.match(usage, /referenceOnly/);
  assert.match(usage, /modelsFor\(focused.provider\)/);
  assert.doesNotMatch(usage, /matchProvider=\{focused.provider\}/);
  assert.match(usage, /usage-limits-windows/);
  assert.match(usage, /usage-limits-foot/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.usage-limits-windows,\s*\.usage-limits-foot\s*\{[^}]*justify-content:\s*center/);
  assert.match(css, /\.usage-limit-note\s*\{[^}]*text-align:\s*center/);
  assert.match(css, /\.usage-limit-note\s*\{[^}]*width:\s*100%/);
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  assert.match(settings, /referenceOnly fallbackWindow=\{modelsFor\(id\)\[0\]\?\.contextWindow\}/);
  assert.match(settings, /referenceOnly fallbackWindow=\{bot.contextWindow\}/);
  const meter = readFileSync(path.join(ROOT, "src", "ui", "ContextMeter.tsx"), "utf8");
  assert.match(meter, /if \(referenceOnly\) return;/);
  assert.match(meter, /context-meter quiet/);
  assert.match(css, /\.context-meter\.quiet/);
  assert.match(css, /\.context-meter\.quiet:hover[\s\S]*background:\s*none/);
  assert.doesNotMatch(
    meter.slice(meter.indexOf("fallbackWindow && fallbackWindow > 0"), meter.indexOf("if (!session || !estimate || !stats) return null")),
    /<button/,
  );
  assert.match(meter, /left: anchor.left/);
  assert.doesNotMatch(meter, /right: anchor.right/);
});

test("ContextMeter populates Cursor retained context without a Grok-only live session-info call", () => {
  const estimate = estimateChatContext({
    contextUsed: 0,
    windowSize: 200_000,
    messages: [
      { text: "hello there from a composer chat with real occupying tokens ".repeat(80), kind: undefined },
      { text: "pong from composer with enough characters to count occupancy ".repeat(80), kind: undefined },
    ],
  });
  assert.ok(estimate.used > 0);
  assert.equal(estimate.used, estimate.occupying.find((row) => row.id === "messages")?.tokens);
  const liveZero = {
    ...estimate,
    used: 0,
    usagePct: 0,
    source: "live" as const,
  };
  const stats = retainedContextStats(estimate, liveZero);
  assert.equal(stats.used, estimate.used);
  assert.ok(stats.usagePct > 0);
  const liveFull = { ...estimate, used: 80_000, usagePct: 40, source: "live" as const };
  assert.equal(retainedContextStats(estimate, liveFull).used, 80_000);

  const meter = readFileSync(path.join(ROOT, "src", "ui", "ContextMeter.tsx"), "utf8");
  assert.match(meter, /retainedContextStats/);
  assert.match(meter, /estimateChatContext/);
  assert.doesNotMatch(
    meter,
    /if \(!session \|\| session\.provider !== "grok"\) return;[\s\S]*estimateChatContext/,
  );
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /settleTurnUsage/);
  assert.match(store, /backfillCursorUsage/);
  assert.match(store, /draft\.source === "estimate" && draft\.provider !== "cursor"/);
  assert.match(store, /estimateMessageTokens/);
  assert.match(meter, /formatRetainedPct/);
});

test("a six-message Cursor chat does not keep retained context at 0 of 200k", () => {
  const stats = estimateChatContext({
    contextUsed: 0,
    windowSize: 200_000,
    messages: [
      { text: "What are you and where are you?", kind: undefined },
      { text: "PONG", kind: undefined },
      { text: "owned by SpaceXAI and Cursor.", kind: undefined },
      { text: "Workhorse is the desktop multiplexer running this conversation.", kind: undefined },
      { text: "No project folder is linked to this chat right now.", kind: undefined },
      { text: "follow up", kind: undefined },
    ],
  });
  const messages = stats.occupying.find((row) => row.id === "messages");
  assert.ok((messages?.tokens ?? 0) > 0);
  assert.equal(stats.used, messages?.tokens);
  assert.notEqual(stats.used, 0);
  assert.equal(formatRetainedPct(stats.used, stats.usagePct), stats.usagePct < 1 ? "<1%" : `${stats.usagePct}%`);
  assert.equal(formatRetainedPct(0, 0), "0%");
  assert.equal(formatRetainedPct(123, 0), "<1%");
});
