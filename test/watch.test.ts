import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isSettingsSection, normalizeSettings } from "../src/lib/settings";
import type { CustomBot, GrokPlanUsage } from "../src/lib/types";
import {
  DAY_SHARE_PERCENT,
  dayKey,
  DEFAULT_WATCH,
  deskCallBlockFor,
  callableDeskRows,
  deskCallCatalog,
  deskCallPromptable,
  deskCallRowFor,
  evaluateWatchHold,
  formatDeskRoster,
  formatWeeklyPlanLine,
  vendorCallBlocked,
  isVendorDeclinedResult,
  vendorDeclinedForBot,
  vendorGrantedForChat,
  vendorOverrideNeeded,
  spawnAllowed,
  spawnIsNoGo,
  isDesktopWatchNotice,
  leftoverPercentForKey,
  normalizeWatch,
  pruneWatchPermits,
  rollingAllowed,
  toggleWatchLockKey,
  watchBarDetail,
  watchBarTitle,
  watchHoldMessage,
  watchKeyForSession,
  watchLocksKey,
  watchPicksKey,
  watchVendorStatuses,
  weekDayIndex,
} from "../src/lib/watch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bot: CustomBot = {
  id: "bot_minimax",
  name: "MiniMax",
  color: "#0071e3",
  baseUrl: "https://api.minimax.io/anthropic",
  model: "MiniMax-M2.5",
  apiKey: "sk-test",
  api: "anthropic-messages",
  contextWindow: 200_000,
  createdAt: 1,
};

const plan = (left: number, extra?: Partial<GrokPlanUsage>): GrokPlanUsage => ({
  usedPercent: 100 - left,
  leftPercent: left,
  period: "weekly",
  prepaidBalance: 0,
  products: [],
  ...extra,
});

test("watch is one daily limit, off until you turn it on", () => {
  const empty = normalizeWatch(undefined);
  assert.equal(empty.lockDaily, false);
  assert.equal(empty.desktopNotify, true);
  assert.equal(empty.dailyLimitPercent, 100 / 7);
  assert.equal(empty.dailyLimitPercent, DAY_SHARE_PERCENT);
  const settings = normalizeSettings({ llms: { grok: { connected: true } } });
  assert.equal(settings.watch.lockDaily, false);
  assert.equal(settings.watch.desktopNotify, true);
  assert.equal(settings.watch.dailyLimitPercent, 100 / 7);
  assert.equal(isSettingsSection("watch"), true);
  assert.equal(normalizeWatch({ desktopNotify: true }).desktopNotify, true);
  assert.equal(normalizeWatch({ desktopNotify: false }).desktopNotify, false);
  assert.equal(isDesktopWatchNotice({ kind: "daily" }), true);
  assert.equal(isDesktopWatchNotice({ kind: "spent" }), true);
  assert.equal(isDesktopWatchNotice({ kind: "reset" }), false);
});

test("weekDayIndex treats the next local date as the next Watch day", () => {
  const now = Date.parse("2026-08-13T18:00:00");
  const reset = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(weekDayIndex(reset, now), { day: 2, days: 7 });
  const first = Date.parse("2026-08-13T18:00:00");
  const weekEnd = new Date(Date.parse("2026-08-20T18:00:00")).toISOString();
  assert.deepEqual(weekDayIndex(weekEnd, first), { day: 1, days: 7 });
  assert.deepEqual(weekDayIndex(weekEnd, Date.parse("2026-08-14T00:10:00")), { day: 2, days: 7 });
  assert.deepEqual(weekDayIndex("2026-08-20T12:00:00", Date.parse("2026-08-14T00:52:00")), { day: 2, days: 7 });
});

test("unused days stack so day 4 can spend 60% and day 2 locks only past 30%", () => {
  assert.equal(rollingAllowed(15, 4), 60);
  assert.equal(rollingAllowed(15, 2), 30);
  assert.equal(rollingAllowed(DAY_SHARE_PERCENT, 7), 100);
  assert.equal(rollingAllowed(DAY_SHARE_PERCENT, 4), (100 / 7) * 4);

  const now = Date.parse("2026-08-13T18:00:00");
  const day = dayKey(now);
  const grokReset = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
  const miniReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
  const settings = {
    watch: { ...DEFAULT_WATCH, lockDaily: true, dailyLimitPercent: 15 },
    customBots: [bot],
    usageBudgets: {},
    llms: { grok: { connected: true }, claude: { connected: false }, codex: { connected: false } },
  };

  const off = evaluateWatchHold({
    session: { provider: "grok" },
    settings: { ...settings, watch: { ...settings.watch, lockDaily: false } },
    plans: { grok: plan(58, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.equal(off, null);

  const spent = evaluateWatchHold({
    session: { provider: "grok" },
    settings: { ...settings, watch: { ...settings.watch, lockDaily: false } },
    plans: { grok: plan(0, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.equal(spent, null);

  const spentLocked = evaluateWatchHold({
    session: { provider: "grok" },
    settings,
    plans: { grok: plan(0, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.ok(spentLocked);
  assert.equal(spentLocked?.reason, "spent");
  assert.match(watchHoldMessage(spentLocked!), /Switch to another model/);
  assert.match(watchHoldMessage(spentLocked!), /no leftover/);

  const hold = evaluateWatchHold({
    session: { provider: "grok" },
    settings,
    plans: { grok: plan(58, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.ok(hold);
  assert.equal(hold?.usedPercent, 42);
  assert.equal(hold?.allowedPercent, 30);
  assert.equal(hold?.overPercent, 12);
  assert.equal(
    evaluateWatchHold({
      session: { provider: "grok" },
      settings,
      plans: { grok: plan(58, { resetsAt: grokReset }) },
      permits: { grok: { day } },
      now,
    }),
    null,
  );

  const statuses = watchVendorStatuses({
    settings,
    usage: [],
    plans: {
      grok: plan(58, { resetsAt: grokReset }),
      custom: { bot_minimax: plan(100, { resetsAt: miniReset }) },
    },
    permits: {},
    now,
  });
  const grok = statuses.find((row) => row.key === "grok");
  const mini = statuses.find((row) => row.key === "bot:bot_minimax");
  assert.equal(grok?.weekDay?.day, 2);
  assert.equal(grok?.allowedPercent, 30);
  assert.equal(grok?.usedPercent, 42);
  assert.equal(grok?.overPercent, 12);
  assert.equal(grok?.holding, true);
  assert.equal(mini?.weekDay?.day, 4);
  assert.equal(mini?.allowedPercent, 60);
  assert.equal(mini?.usedPercent, 0);
  assert.equal(mini?.holding, false);
});

test("Watch hides bots that are disabled on the desk", () => {
  const now = Date.parse("2026-08-13T18:00:00");
  const statuses = watchVendorStatuses({
    settings: {
      watch: { ...DEFAULT_WATCH },
      usageBudgets: {},
      llms: {
        grok: { connected: true },
        claude: { connected: true, enabled: false },
        codex: { connected: true },
      },
      customBots: [{ ...bot, enabled: false }],
    },
    usage: [],
    plans: { grok: plan(50), claude: plan(91), codex: plan(99), custom: { bot_minimax: plan(100) } },
    permits: {},
    now,
  });
  assert.deepEqual(
    statuses.map((row) => row.key),
    ["grok", "codex"],
  );
});

test("leftover numbers stay visible on cards without a second hold setting", () => {
  const now = Date.parse("2026-08-13T18:00:00");
  const statuses = watchVendorStatuses({
    settings: {
      watch: { ...DEFAULT_WATCH, lockDaily: false },
      usageBudgets: {},
      llms: { grok: { connected: true }, claude: { connected: false }, codex: { connected: false } },
      customBots: [bot],
    },
    usage: [],
    plans: {
      grok: plan(0, { resetsAt: new Date(now + 60 * 60 * 1000).toISOString() }),
      custom: { bot_minimax: plan(9) },
    },
    permits: {},
    now,
  });
  const grok = statuses.find((row) => row.key === "grok");
  const mini = statuses.find((row) => row.key === "bot:bot_minimax");
  assert.ok(grok?.notices.some((notice) => notice.kind === "spent"));
  assert.equal(grok?.holding, false);
  assert.equal(mini?.holding, false);
  assert.equal(leftoverPercentForKey("bot:bot_minimax", { custom: { bot_minimax: plan(9) } }, { customBots: [bot] }), 9);

  const pruned = pruneWatchPermits(
    { grok: { day: "2026-08-12" }, "bot:bot_minimax": { day: dayKey(now) } },
    now,
  );
  assert.equal(pruned.grok, undefined);
  assert.deepEqual(pruned["bot:bot_minimax"], { day: dayKey(now) });
});

test("Watch settings and send hold are wired through the desk", () => {
  const settings = readFileSync(path.join(ROOT, "src", "ui", "Settings.tsx"), "utf8");
  const pane = readFileSync(path.join(ROOT, "src", "ui", "WatchPane.tsx"), "utf8");
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(settings, /id: "watch"/);
  assert.match(pane, /FuelRing/);
  assert.match(pane, /over=\{row\.overPercent/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "FuelRing.tsx"), "utf8"), /fuel-over/);
  assert.match(pane, /Daily bank/);
  assert.match(pane, /Windows notification/);
  assert.match(pane, /On by default/);
  assert.doesNotMatch(pane, /Off by default/);
  assert.match(pane, /desktopNotify/);
  assert.match(pane, /setPicking/);
  assert.match(pane, /toggleWatchLockKey/);
  assert.match(pane, /disabled=\{!picking\}/);
  assert.match(pane, /watch-option/);
  assert.match(pane, /watch-copy/);
  assert.match(pane, /aria-pressed/);
  assert.doesNotMatch(pane, /setWatchDayBank/);
  assert.doesNotMatch(pane, /aria-label="Day bank"/);
  assert.doesNotMatch(pane, /Hold leftover when low/);
  assert.doesNotMatch(pane, /Daily share/);
  assert.doesNotMatch(pane, /dailyLimitPercent/);
  assert.doesNotMatch(pane, /Limit each day/);
  const notices = readFileSync(path.join(ROOT, "src", "ui", "WatchNotices.tsx"), "utf8");
  assert.equal(watchBarTitle({ label: "Grok", reason: "daily" }), "Grok used its daily bank");
  assert.match(watchBarDetail({ reason: "daily" }), /leftover can last later days/);
  assert.match(notices, /notifyDesktop/);
  assert.match(notices, /isDesktopWatchNotice/);
  assert.match(notices, /watchLocksKey/);
  assert.match(notices, /watch-banners/);
  assert.match(notices, /Got it/);
  assert.doesNotMatch(notices, /openSettings\("watch"\)/);
  assert.match(readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8"), /notify:desktop/);
  assert.match(readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8"), /notify:desktop/);
  assert.match(readFileSync(path.join(ROOT, "electron", "notify.ts"), "utf8"), /isFocused/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, "src", "lib", "watch.ts"), "utf8"), /used today's/);
  assert.match(store, /evaluateWatchHold/);
  assert.match(store, /watchHoldMessage/);
  assert.match(store, /vendorGrantedForChat/);
  assert.doesNotMatch(
    store.slice(store.indexOf('action === "request-vendor"'), store.indexOf('action === "list-references"')),
    /row\.canCall/,
  );
  assert.match(store, /watchDayMarks/);
  assert.match(store, /vendorCallBlocked/);
  assert.match(store, /deskCallCatalog/);
  assert.equal(
    watchHoldMessage({ label: "Grok", usedPercent: 44, allowedPercent: 30, overPercent: 14 }).includes("Grok used its daily bank"),
    true,
  );
  assert.match(
    watchHoldMessage({ label: "Grok", usedPercent: 44, allowedPercent: 30, overPercent: 14 }),
    /leftover|later days|rest of the week/,
  );
  assert.match(watchHoldMessage({ label: "Grok", usedPercent: 44, allowedPercent: 30, overPercent: 14 }), /Switch to another model/);
  assert.match(notices, /watch-hold-bar/);
  assert.match(notices, /Allow this chat/);
  assert.match(notices, /watch-hold-bar hold/);
  assert.match(notices, /Switch model/);
  assert.doesNotMatch(notices, /Allow today/);
  assert.doesNotMatch(notices, /Watch · Safety/);
  assert.doesNotMatch(notices, /permission-overlay/);
  assert.match(notices, /watchKeyForSession/);
  assert.match(notices, /if \(setupOpen \|\|/);
  assert.doesNotMatch(notices, /watchNoticeKeysForChat/);
  assert.equal(watchKeyForSession({ provider: "custom", customBotId: "bot_minimax" }), "bot:bot_minimax");
  assert.equal(watchKeyForSession({ provider: "codex" }), "codex");
  assert.notEqual(watchKeyForSession({ provider: "custom", customBotId: "bot_minimax" }), "codex");
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8"), /onSwitchModel/);
  assert.match(store, /conversation/);
  const today = dayKey();
  assert.equal(
    evaluateWatchHold({
      session: { id: "sess_g", provider: "grok" },
      settings: {
        watch: { ...DEFAULT_WATCH, lockDaily: true, dailyLimitPercent: 15 },
        customBots: [bot],
        usageBudgets: {},
        llms: { grok: { connected: true }, claude: { connected: false }, codex: { connected: false } },
      },
      plans: { grok: plan(58) },
      permits: { grok: { sessions: { sess_g: today } } },
      now: Date.parse(`${today}T12:00:00`),
    }),
    null,
  );
});

test("clicking a bot opts it into the day bank and leaves others free", () => {
  const all = ["grok", "codex", "claude"];
  const picked = toggleWatchLockKey({ ...DEFAULT_WATCH }, "codex", all);
  assert.deepEqual(picked.lockKeys, ["codex"]);
  assert.equal(picked.lockDaily, false);
  assert.equal(watchPicksKey(picked, "codex"), true);
  assert.equal(watchPicksKey(picked, "grok"), false);
  assert.equal(watchLocksKey(picked, "codex"), true);
  assert.equal(watchLocksKey(picked, "grok"), false);

  const none = toggleWatchLockKey(picked, "codex", all);
  assert.deepEqual(none.lockKeys, []);
  assert.equal(watchLocksKey(none, "codex"), false);
  assert.equal(watchLocksKey({ ...picked, lockDaily: false }, "codex"), true);

  const legacy = { ...DEFAULT_WATCH, lockDaily: true };
  assert.equal(watchPicksKey(legacy, "grok"), true);
  assert.equal(watchLocksKey(legacy, "grok"), true);
  const afterUnpick = toggleWatchLockKey(legacy, "grok", all);
  assert.deepEqual(afterUnpick.lockKeys, ["codex", "claude"]);
  assert.equal(watchLocksKey(afterUnpick, "grok"), false);
  assert.equal(watchLocksKey(afterUnpick, "codex"), true);

  const now = Date.parse("2026-08-13T18:00:00");
  const grokReset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
  const settings = {
    watch: { ...DEFAULT_WATCH, lockDaily: true, lockKeys: ["codex"] },
    customBots: [bot],
    usageBudgets: {},
    llms: { grok: { connected: true }, claude: { connected: false }, codex: { connected: true } },
  };
  assert.equal(
    evaluateWatchHold({
      session: { provider: "grok" },
      settings,
      plans: { grok: plan(0, { resetsAt: grokReset }) },
      permits: {},
      now,
    }),
    null,
  );
  assert.equal(
    evaluateWatchHold({
      session: { provider: "grok" },
      settings,
      plans: { grok: plan(58, { resetsAt: grokReset }) },
      permits: {},
      now,
    }),
    null,
  );
  const codexHold = evaluateWatchHold({
    session: { provider: "codex" },
    settings,
    plans: { codex: plan(0, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.ok(codexHold);
  assert.equal(codexHold?.reason, "spent");

  const stillHeld = evaluateWatchHold({
    session: { provider: "codex" },
    settings: { ...settings, watch: { ...DEFAULT_WATCH, lockDaily: false, lockKeys: ["codex"] } },
    plans: { codex: plan(0, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.ok(stillHeld);
  assert.equal(stillHeld?.reason, "spent");

  const allLocked = evaluateWatchHold({
    session: { provider: "grok" },
    settings: { ...settings, watch: { ...DEFAULT_WATCH, lockDaily: true } },
    plans: { grok: plan(0, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.ok(allLocked);
  assert.equal(allLocked?.reason, "spent");
});

test("deskCallCatalog marks spent and Watch-held vendors as not callable", () => {
  const now = Date.parse("2026-08-13T18:00:00");
  const reset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
  const settings = {
    watch: { ...DEFAULT_WATCH, lockDaily: true, dailyLimitPercent: 15 },
    customBots: [bot],
    usageBudgets: {},
    llms: { grok: { connected: true }, claude: { connected: true, enabled: false }, codex: { connected: false } },
  };
  const rows = deskCallCatalog({
    settings,
    usage: [],
    plans: {
      grok: plan(0, { resetsAt: reset }),
      claude: plan(80, { resetsAt: reset }),
    },
    permits: {},
    now,
  });
  const grok = rows.find((row) => row.id === "grok");
  const claude = rows.find((row) => row.id === "claude");
  const mini = rows.find((row) => row.id === "bot:bot_minimax");
  assert.equal(rows.some((row) => row.id === "codex"), true);
  assert.equal(grok?.canCall, false);
  assert.ok((grok?.models?.length ?? 0) > 1);
  assert.ok(grok?.models?.some((item) => item.id === "grok-4.6"));
  assert.equal(grok?.status, "spent");
  assert.match(grok?.reason ?? "", /no leftover|Watch safety/);
  assert.equal(claude, undefined);
  assert.doesNotMatch(formatDeskRoster(rows), /Claude/);
  assert.doesNotMatch(formatDeskRoster(rows), /turned off in Settings/);
  assert.equal(mini?.kind, "custom");
  assert.equal(mini?.name, "MiniMax");
  const unlocked = deskCallCatalog({
    settings: { ...settings, watch: { ...DEFAULT_WATCH, lockDaily: false } },
    usage: [],
    plans: { grok: plan(0, { resetsAt: reset }) },
    permits: {},
    now,
  });
  assert.equal(unlocked.find((row) => row.id === "grok")?.canCall, true);
  assert.equal(unlocked.find((row) => row.id === "codex")?.canCall, false);
  assert.equal(unlocked.find((row) => row.id === "codex")?.status, "not_connected");
  const roster = formatDeskRoster(unlocked);
  assert.match(roster, /Desk bots on this Workhorse window/);
  assert.match(roster, /Grok/);
  assert.match(roster, /models:/);
  assert.match(roster, /you can call this/);
  assert.match(formatDeskRoster(rows), /API key is on the desk|MiniMax/);
  assert.ok(callableDeskRows(unlocked).some((row) => row.id === "grok"));
  assert.ok(callableDeskRows(rows).some((row) => row.kind === "custom"));
  assert.equal(callableDeskRows(rows).some((row) => row.id === "grok"), false);
  assert.match(roster, /weekly plan total|weekly plan remaining|not this prompt|not this spawn/);
  assert.match(roster, /leftoverMeans/);
  assert.match(
    formatWeeklyPlanLine({ leftoverPercent: 43, usedPercent: 57 }),
    /43% leftover of this week's plan overall \(57% used this week so far/,
  );
  assert.match(formatWeeklyPlanLine({ leftoverPercent: 43, usedPercent: 57 }), /not this prompt/);
  assert.doesNotMatch(roster, /only one bot/);
  assert.match(deskCallBlockFor(rows, { provider: "grok" }) ?? "", /leftover|Watch|bank|Do not wait/);
  assert.equal(deskCallBlockFor(unlocked, { provider: "grok" }), null);
  assert.equal(deskCallBlockFor(rows, { name: "Claude" }), null);
  assert.equal(deskCallPromptable(grok), true);
  assert.equal(deskCallPromptable(claude), false);
  assert.equal(deskCallPromptable(unlocked.find((row) => row.id === "codex")), false);
  const banked = deskCallCatalog({
    settings: { ...settings, watch: { ...DEFAULT_WATCH, lockDaily: true, dailyLimitPercent: 15 } },
    usage: [],
    plans: { grok: plan(40, { resetsAt: reset }) },
    permits: {},
    now,
  });
  assert.equal(banked.find((row) => row.id === "grok")?.status, "day_bank");
  assert.equal(vendorOverrideNeeded(banked.find((row) => row.id === "grok")), true);
  assert.equal(vendorOverrideNeeded(unlocked.find((row) => row.id === "grok")), false);
  assert.equal(vendorOverrideNeeded({ status: "ok" } as (typeof rows)[0]), false);
  assert.match(spawnIsNoGo(banked.find((row) => row.id === "grok")) ?? "", /no-go — daily bank spent/);
  assert.equal(spawnIsNoGo(unlocked.find((row) => row.id === "grok")), null);
  assert.match(spawnIsNoGo(claude) ?? "", /not on this desk/);
  assert.equal(spawnAllowed(unlocked.find((row) => row.id === "grok")), true);
  assert.equal(spawnAllowed(banked.find((row) => row.id === "grok")), false);
  assert.equal(spawnAllowed(claude), false);
  const storeSrc = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(storeSrc, /spawnIsNoGo\(row\)/);
  assert.match(storeSrc, /vendorOverrideNeeded\(row\)/);
  const host = readFileSync(path.join(ROOT, "electron", "custom-host.ts"), "utf8");
  assert.doesNotMatch(
    host.slice(host.indexOf("const spawnTarget"), host.indexOf("if (use.name === \"workhorse_request_permission\")")),
    /workhorse_spawn_agent/,
  );
  assert.equal(deskCallRowFor(rows, { provider: "grok" })?.id, "grok");
  assert.equal(vendorGrantedForChat({ grok: { sessions: { parent: dayKey(now) } } }, "grok", "parent", now), true);
  assert.equal(vendorGrantedForChat({}, "grok", "parent", now), false);
  assert.match(vendorDeclinedForBot("Grok"), /USER DECLINED/);
  assert.match(vendorDeclinedForBot("Grok"), /said no to using Grok in this chat/);
  assert.match(vendorDeclinedForBot("Grok"), /this instance/);
  assert.equal(isVendorDeclinedResult(vendorDeclinedForBot("Grok")), true);
  assert.equal(isVendorDeclinedResult("ok"), false);
  assert.doesNotMatch(vendorDeclinedForBot("Grok"), /Settings|fetch failed|auto-approve|card/i);
  const parentAllowed = evaluateWatchHold({
    session: { provider: "grok", id: "child", parentId: "parent" },
    settings,
    plans: { grok: plan(0, { resetsAt: reset }) },
    permits: { grok: { sessions: { parent: dayKey(now) } } },
    now,
  });
  assert.equal(parentAllowed, null);
  assert.match(
    vendorCallBlocked({
      session: { provider: "grok" },
      settings,
      plans: { grok: plan(0, { resetsAt: reset }) },
      permits: {},
      now,
    }) ?? "",
    /no leftover|Watch safety/,
  );
  assert.match(
    vendorCallBlocked({
      session: { provider: "claude" },
      settings,
      plans: { claude: plan(80, { resetsAt: reset }) },
      permits: {},
      now,
    }) ?? "",
    /not on this desk/,
  );
  assert.equal(
    vendorCallBlocked({
      session: { provider: "claude" },
      settings: { ...settings, llms: { ...settings.llms, claude: { connected: true } } },
      plans: { claude: plan(80, { resetsAt: reset }) },
      permits: {},
      now,
    }),
    null,
  );
});

test("available LLMs include a keyed custom bot when stock vendors are a no-go", () => {
  const now = Date.parse("2026-08-13T18:00:00");
  const reset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
  const rows = deskCallCatalog({
    settings: {
      watch: { ...DEFAULT_WATCH, lockDaily: true, dailyLimitPercent: 15 },
      customBots: [bot],
      usageBudgets: {},
      llms: {
        grok: { connected: true },
        claude: { connected: true, enabled: false },
        codex: { connected: true },
      },
    },
    usage: [],
    plans: {
      grok: plan(36, { resetsAt: reset }),
      codex: plan(51, { resetsAt: reset }),
      claude: plan(80, { resetsAt: reset }),
    },
    permits: {},
    now,
  });
  const grok = rows.find((row) => row.id === "grok");
  const codex = rows.find((row) => row.id === "codex");
  const claude = rows.find((row) => row.id === "claude");
  const mini = rows.find((row) => row.id === "bot:bot_minimax");
  assert.equal(grok?.canCall, false);
  assert.equal(grok?.status, "day_bank");
  assert.equal(codex?.canCall, false);
  assert.equal(codex?.status, "day_bank");
  assert.equal(claude, undefined);
  assert.doesNotMatch(formatDeskRoster(rows), /Claude/);
  assert.equal(mini?.kind, "custom");
  assert.equal(mini?.canCall, true);
  assert.ok(callableDeskRows(rows).some((row) => row.id === "bot:bot_minimax"));
  assert.equal(spawnAllowed(mini), true);
  assert.equal(spawnAllowed(grok), false);
  assert.equal(spawnAllowed(claude), false);
  const roster = formatDeskRoster(rows);
  assert.match(roster, /MiniMax/);
  assert.match(roster, /API key is on the desk/);
  assert.match(roster, /Custom API bots on this desk: MiniMax/);
  assert.match(roster, /Callable now: MiniMax/);
  assert.doesNotMatch(roster, /No custom\/MiniMax bot is attached/);
  assert.doesNotMatch(roster, /no custom bot is attached to this desk/i);
  assert.doesNotMatch(roster, /Nothing is callable right now/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8"), /formatDeskRoster\(catalog\)/);
  assert.match(readFileSync(path.join(ROOT, "electron", "workhorse-mcp.ts"), "utf8"), /action: "list"/);
});
