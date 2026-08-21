import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_SETTINGS, isSettingsSection, normalizeSettings } from "../src/lib/settings";
import type { CustomBot, GrokPlanUsage, Settings } from "../src/lib/types";
import {
  CAPACITY_SNAPSHOT_VERSION,
  CAPACITY_STALE_AFTER_MS,
  DAY_SHARE_PERCENT,
  dayKey,
  DEFAULT_WATCH,
  deskCallBlockFor,
  callableDeskRows,
  deskCallCatalog,
  deskCallPromptable,
  deskCallRowFor,
  occupancyCannotHoldSend,
  evaluateWatchHold,
  formatDeskRoster,
  formatPlanLine,
  projectCapacitySnapshot,
  type DeskCallRow,
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
  watchDayFill,
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

/** Watch reads all five links. A fixture names the one or two it is about. */
const links = (over: Partial<Settings["llms"]> = {}): Settings["llms"] => ({
  ...structuredClone(DEFAULT_SETTINGS.llms),
  ...over,
});

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

test("monthly Cursor watch uses the billing month, not 7 days", () => {
  const now = Date.parse("2026-08-17T12:00:00");
  const reset = "2026-09-12T00:00:00.000Z";
  const idx = weekDayIndex(reset, now, "monthly");
  assert.ok(idx.days >= 28 && idx.days <= 31);
  assert.notEqual(idx.days, 7);
  assert.ok(idx.day >= 1 && idx.day < idx.days);
  assert.deepEqual(weekDayIndex(reset, now), { day: 1, days: 7 });
  const settings = {
    watch: DEFAULT_WATCH,
    customBots: [] as CustomBot[],
    usageBudgets: {},
    llms: links({ cursor: { connected: true } }),
  };
  const statuses = watchVendorStatuses({
    settings,
    usage: [],
    plans: {
      cursor: {
        usedPercent: 32.5,
        leftPercent: 67.5,
        period: "monthly",
        prepaidBalance: 0,
        resetsAt: reset,
        products: [
          { product: "cursor-models", label: "Cursor Models", usagePercent: 19, resetsAt: reset },
          { product: "other-models", label: "Other Models", usagePercent: 46, resetsAt: reset },
        ],
      },
    },
    permits: {},
    now,
  });
  const composer = statuses.find((row) => row.key === "cursor:cursor-models");
  assert.equal(composer?.weekDay?.days, idx.days);
  assert.equal(composer?.weekDay?.day, idx.day);
  assert.ok((composer?.allowedPercent ?? 0) < 40);
  assert.equal(watchDayFill({ usedPercent: 19, allowedPercent: 19, weekDay: { days: 31 } }), 0.19);
  assert.equal(watchDayFill({ usedPercent: 46, allowedPercent: 19, weekDay: { days: 31 } }), 0.46);
  assert.equal(watchDayFill({ usedPercent: 51, allowedPercent: 71, weekDay: { days: 7 } }), 51 / 71);
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
    llms: links({ grok: { connected: true } }),
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
      llms: links({
        grok: { connected: true },
        claude: { connected: true, enabled: false },
        codex: { connected: true },
      }),
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
      llms: links({ grok: { connected: true } }),
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
  assert.equal(
    leftoverPercentForKey(
      "bot:bot_minimax",
      {
        custom: {
          bot_minimax: plan(100, {
            products: [
              { product: "session", label: "5h", usagePercent: 81 },
              { product: "weekly", label: "Weekly", usagePercent: 0, unlimited: true },
            ],
          }),
        },
      },
      { customBots: [bot] },
    ),
    undefined,
  );
  assert.equal(
    leftoverPercentForKey(
      "bot:bot_minimax",
      {
        custom: {
          bot_minimax: plan(100, {
            products: [
              { product: "session", label: "5h", usagePercent: 69 },
              { product: "weekly", label: "Weekly", usagePercent: 31 },
            ],
          }),
        },
      },
      { customBots: [bot] },
    ),
    69,
  );
  assert.equal(
    leftoverPercentForKey(
      "bot:bot_minimax",
      {
        custom: {
          bot_minimax: plan(100, {
            products: [
              { product: "session", label: "5h", usagePercent: 73 },
              { product: "weekly", label: "Weekly", usagePercent: 0 },
            ],
          }),
        },
      },
      { customBots: [bot] },
    ),
    100,
  );

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
  assert.match(pane, /cursor: store.cursorPlan/);
  assert.match(pane, /over=\{row\.overPercent/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "FuelRing.tsx"), "utf8"), /fuel-over/);
  assert.match(readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8"), /\.watch-day-track i\.cursor/);
  assert.match(pane, /watchDayFill/);
  assert.match(pane, /Daily bank/);
  assert.match(pane, /Desktop notification/);
  assert.doesNotMatch(pane, /Windows notification/);
  assert.match(pane, /aria-checked=\{watch\.desktopNotify\}/);
  assert.match(pane, /desktopNotify/);
  assert.match(pane, /setPicking/);
  assert.match(pane, /toggleWatchLockKey/);
  assert.match(pane, /\$\{Math\.round\(used\)\} \/ \$\{allowed\}%/);
  assert.doesNotMatch(pane, /Roams free/);
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
    llms: links({ grok: { connected: true }, codex: { connected: true } }),
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
    llms: links({ grok: { connected: true }, claude: { connected: true, enabled: false } }),
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
  assert.match(roster, /plan total|plan remaining|not this prompt|not this spawn/);
  assert.match(roster, /leftoverMeans/);
  assert.match(roster, /leave provider, model, and effort unset/);
  assert.match(roster, /Workhorse chooses from callable bots by task fit and capacity/);
  assert.match(
    formatPlanLine({ leftoverPercent: 43, usedPercent: 57, period: "weekly" }),
    /43% leftover of this week's plan overall \(57% used this week so far/,
  );
  assert.match(formatPlanLine({ leftoverPercent: 43, usedPercent: 57, period: "weekly" }), /not this prompt/);
  assert.match(
    formatPlanLine({ leftoverPercent: 51, usedPercent: 49, period: "monthly" }),
    /51% leftover of this month's plan overall \(49% used this month so far/,
  );
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

test("desk roster assigns Cursor Auto to the API pool it actually uses", () => {
  const rows = deskCallCatalog({
    settings: {
      watch: { ...DEFAULT_WATCH, lockDaily: false },
      customBots: [],
      usageBudgets: {},
      llms: links({ cursor: { connected: true } }),
    },
    usage: [],
    plans: {},
    permits: {},
  });
  const composer = rows.find((row) => row.id === "cursor:cursor-models");
  const api = rows.find((row) => row.id === "cursor:other-models");
  assert.equal(composer?.models?.some((model) => model.id === "auto"), false);
  assert.equal(api?.models?.some((model) => model.id === "auto"), true);
  assert.equal(api?.model, "auto");
});

test("available LLMs include a keyed custom bot when stock vendors are a no-go", () => {
  const now = Date.parse("2026-08-13T18:00:00");
  const reset = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
  const rows = deskCallCatalog({
    settings: {
      watch: { ...DEFAULT_WATCH, lockDaily: true, dailyLimitPercent: 15 },
      customBots: [bot],
      usageBudgets: {},
      llms: links({
        grok: { connected: true },
        claude: { connected: true, enabled: false },
        codex: { connected: true },
      }),
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

test("the daily-over banner is a short used-vs-expected line", () => {
  // Screenshot case: Grok day 3 of 7, 61% used vs 43% expected → 18% over.
  const grokNow = Date.parse("2026-08-13T18:00:00");
  const grokReset = new Date(grokNow + 5 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(weekDayIndex(grokReset, grokNow), { day: 3, days: 7 });
  assert.equal(Math.round(rollingAllowed(DAY_SHARE_PERCENT, 3)), 43);

  const grokDaily = watchVendorStatuses({
    settings: {
      watch: DEFAULT_WATCH,
      customBots: [],
      usageBudgets: {},
      llms: { grok: { connected: true }, claude: { connected: false }, codex: { connected: false } },
    },
    usage: [],
    plans: { grok: plan(39, { resetsAt: grokReset }) },
    permits: {},
    now: grokNow,
  })
    .find((row) => row.key === "grok")
    ?.notices.find((notice) => notice.kind === "daily");
  assert.equal(grokDaily?.title, "Grok is 18% over pace");
  assert.equal(grokDaily?.detail, "Day 3/7 · 61% used · 43% expected");

  // Cursor · API, monthly: day 9 of ~31, 61% used vs ~29% expected → ~32% over.
  const cursorNow = Date.parse("2026-08-20T12:00:00");
  const cursorReset = "2026-09-12T00:00:00.000Z";
  const cursorCycle = weekDayIndex(cursorReset, cursorNow, "monthly");
  const cursorExpected = Math.round(rollingAllowed(DAY_SHARE_PERCENT, cursorCycle.day, cursorCycle.days));
  const cursorOver = Math.round(Math.max(0, 61 - rollingAllowed(DAY_SHARE_PERCENT, cursorCycle.day, cursorCycle.days)));
  const cursorDaily = watchVendorStatuses({
    settings: {
      watch: DEFAULT_WATCH,
      customBots: [],
      usageBudgets: {},
      llms: {
        grok: { connected: false },
        claude: { connected: false },
        codex: { connected: false },
        cursor: { connected: true },
      },
    },
    usage: [],
    plans: {
      cursor: {
        usedPercent: 61,
        leftPercent: 39,
        period: "monthly",
        prepaidBalance: 0,
        resetsAt: cursorReset,
        products: [
          { product: "cursor-models", label: "Cursor Models", usagePercent: 10, resetsAt: cursorReset },
          { product: "other-models", label: "Other Models", usagePercent: 61, resetsAt: cursorReset },
        ],
      },
    },
    permits: {},
    now: cursorNow,
  })
    .find((row) => row.key === "cursor:other-models")
    ?.notices.find((notice) => notice.kind === "daily");
  assert.equal(cursorDaily?.title, `Cursor · API is ${cursorOver}% over pace`);
  assert.equal(cursorDaily?.detail, `Day ${cursorCycle.day}/${cursorCycle.days} · 61% used · ${cursorExpected}% expected`);

  const watchSource = readFileSync(path.join(ROOT, "src", "lib", "watch.ts"), "utf8");
  assert.doesNotMatch(watchSource, /over the expected pace/);
  assert.doesNotMatch(watchSource, /what is left covers the days remaining/);
  assert.doesNotMatch(watchSource, /% expected by now/);
});

test("a full context window never holds a send the way a spent daily bank does", () => {
  const now = Date.parse("2026-08-18T12:00:00");
  const grokReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
  const settings = {
    watch: { ...DEFAULT_WATCH, lockDaily: true },
    customBots: [bot],
    usageBudgets: {},
    llms: links({ grok: { connected: true } }),
  };
  assert.equal(occupancyCannotHoldSend(99_000, 100_000), null);
  const unlocked = evaluateWatchHold({
    session: { provider: "grok", id: "sess_full_window" },
    settings: { ...settings, watch: { ...settings.watch, lockDaily: false } },
    plans: { grok: plan(80, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.equal(unlocked, null, "occupancy is not in the hold reasons");
  const spent = evaluateWatchHold({
    session: { provider: "grok", id: "sess_spent" },
    settings,
    plans: { grok: plan(0, { resetsAt: grokReset }) },
    permits: {},
    now,
  });
  assert.equal(spent?.reason, "spent");
  assert.notEqual(spent?.reason, undefined);
});

test("a vaulted custom bot is callable without a plaintext key", () => {
  const vaulted: CustomBot = { ...bot, apiKey: "", credentialId: "cred_kimi" };
  const rows = deskCallCatalog({
    settings: {
      watch: { ...DEFAULT_WATCH, lockDaily: false },
      customBots: [vaulted],
      usageBudgets: {},
      llms: links(),
    },
    usage: [],
    plans: { custom: { bot_minimax: plan(73) } },
    permits: {},
  });
  const row = rows.find((item) => item.id === "bot:bot_minimax");
  assert.equal(row?.canCall, true);
  assert.notEqual(row?.status, "not_connected");
  const snap = projectCapacitySnapshot(rows, {
    now: Date.parse("2026-08-19T12:00:00.000Z"),
    plans: { custom: { bot_minimax: plan(73) } },
    settings: { customBots: [vaulted] },
  });
  const kimi = snap.rows.find((item) => item.id === "bot:bot_minimax");
  assert.equal(kimi?.availability.canCall, true);
  assert.notEqual(kimi?.availability.status, "not_connected");
  assert.equal(kimi?.meter.remainingPercent, 73);
  assert.doesNotMatch(JSON.stringify(snap), /sk-|cred_kimi/);
});

function capacityRow(partial: Partial<DeskCallRow> & Pick<DeskCallRow, "id" | "name" | "provider" | "kind">): DeskCallRow {
  return {
    canCall: true,
    status: "ok",
    ...partial,
  };
}

test("projectCapacitySnapshot is version 1, omits unknown percents, and never infers used", () => {
  const now = Date.parse("2026-08-19T17:42:00.000Z");
  const snapshot = projectCapacitySnapshot(
    [
      capacityRow({
        id: "grok",
        name: "Grok",
        provider: "grok",
        kind: "vendor",
        leftoverPercent: 68,
        models: [
          { id: "grok-4.6", name: "Grok 4.6" },
          { id: "grok-build", name: "Grok Build" },
        ],
      }),
      capacityRow({
        id: "codex",
        name: "Codex",
        provider: "codex",
        kind: "vendor",
        leftoverPercent: 40,
        usedPercent: 55,
        resetsAt: "2026-08-23T00:00:00.000Z",
      }),
      capacityRow({
        id: "claude",
        name: "Claude",
        provider: "claude",
        kind: "vendor",
      }),
    ],
    { now },
  );
  assert.equal(snapshot.version, CAPACITY_SNAPSHOT_VERSION);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.asOf, "2026-08-19T17:42:00.000Z");
  assert.equal(snapshot.freshness, "fresh");
  const grok = snapshot.rows.find((row) => row.id === "grok");
  assert.equal(grok?.meter.status, "known");
  assert.equal(grok?.meter.remainingPercent, 68);
  assert.equal(grok?.meter.usedPercent, undefined);
  assert.equal("usedPercent" in (grok?.meter ?? {}), false);
  const claude = snapshot.rows.find((row) => row.id === "claude");
  assert.equal(claude?.meter.status, "unknown");
  assert.equal(claude?.meter.remainingPercent, undefined);
  assert.equal(claude?.meter.usedPercent, undefined);
  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /"usedPercent":32/);
  assert.doesNotMatch(encoded, /"total"/);
  assert.equal("total" in snapshot, false);
});

test("projectCapacitySnapshot keeps Cursor pools and one custom-account row, drops harness ids", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  const reset = "2026-09-01T00:00:00.000Z";
  const settings = {
    watch: { ...DEFAULT_WATCH, lockDaily: false },
    customBots: [
      {
        ...bot,
        model: "MiniMax-M2.5",
      },
    ],
    usageBudgets: {},
    llms: links({ cursor: { connected: true } }),
  };
  const plans = {
    cursor: {
      usedPercent: 50,
      leftPercent: 50,
      period: "monthly" as const,
      resetsAt: reset,
      prepaidBalance: 0,
      products: [
        { product: "cursor-models", label: "Cursor Models", usagePercent: 10 },
        { product: "other-models", label: "Other Models", usagePercent: 40 },
      ],
    },
    custom: {
      bot_minimax: plan(55, { resetsAt: reset }),
    },
  };
  const catalog = deskCallCatalog({
    settings,
    usage: [],
    plans,
    permits: {},
    now,
  });
  const traps: DeskCallRow[] = [
    ...catalog,
    capacityRow({
      id: "openclaw/main",
      name: "OpenClaw",
      provider: "grok",
      kind: "vendor",
    }),
    {
      id: "hermes/research",
      name: "Hermes",
      provider: "hermes" as DeskCallRow["provider"],
      kind: "vendor",
      canCall: true,
      status: "ok",
    },
  ];
  const snapshot = projectCapacitySnapshot(traps, {
    now,
    fetchedAt: now,
    plans,
    settings,
  });
  const cursor = snapshot.rows.filter((row) => row.provider === "cursor");
  assert.equal(cursor.length, 2);
  assert.ok(cursor.some((row) => row.id === "cursor:cursor-models"));
  assert.ok(cursor.some((row) => row.id === "cursor:other-models"));
  assert.notEqual(cursor[0]?.meter.remainingPercent, cursor[1]?.meter.remainingPercent);
  const custom = snapshot.rows.filter((row) => row.kind === "custom");
  assert.equal(custom.length, 1);
  assert.equal(custom[0]?.id, "bot:bot_minimax");
  assert.ok((custom[0]?.models.length ?? 0) >= 2);
  assert.equal(
    snapshot.rows.some((row) => row.id.includes("openclaw") || row.id.includes("hermes") || row.provider === ("hermes" as DeskCallRow["provider"])),
    false,
  );
  const summed = snapshot.rows.reduce((sum, row) => sum + (row.meter.remainingPercent ?? 0), 0);
  assert.equal("total" in snapshot, false);
  assert.ok(summed > 0);
});

test("projectCapacitySnapshot freshness uses the six-hour cache age", () => {
  const now = Date.parse("2026-08-19T18:00:00.000Z");
  const rows = [
    capacityRow({ id: "grok", name: "Grok", provider: "grok", kind: "vendor", leftoverPercent: 20 }),
  ];
  const stale = projectCapacitySnapshot(rows, {
    now,
    fetchedAt: now - CAPACITY_STALE_AFTER_MS - 1,
  });
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.asOf, new Date(now - CAPACITY_STALE_AFTER_MS - 1).toISOString());
  const fresh = projectCapacitySnapshot(rows, { now, fetchedAt: now - 60_000 });
  assert.equal(fresh.freshness, "fresh");
  const unknown = projectCapacitySnapshot(
    [capacityRow({ id: "grok", name: "Grok", provider: "grok", kind: "vendor" })],
    { now },
  );
  assert.equal(unknown.freshness, "unknown");
  assert.equal(unknown.rows[0]?.meter.status, "unknown");
});

test("projectCapacitySnapshot does not copy free-text reasons or trap fields", () => {
  const row = {
    ...capacityRow({
      id: "grok",
      name: "Grok",
      provider: "grok",
      kind: "vendor",
      leftoverPercent: 12,
      reason: "see chat Secret Title in /Users/foo/userData/workhorse-state.json with Bearer sk-secret",
      status: "spent",
      canCall: false,
    }),
    apiKey: "sk-trap",
    baseUrl: "https://api.example.invalid/v1",
  } as DeskCallRow;
  const snapshot = projectCapacitySnapshot([row], { now: Date.parse("2026-08-19T12:00:00.000Z") });
  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /sk-/);
  assert.doesNotMatch(encoded, /Bearer/);
  assert.doesNotMatch(encoded, /userData/);
  assert.doesNotMatch(encoded, /workhorse-state\.json/);
  assert.doesNotMatch(encoded, /Secret Title/);
  assert.equal(snapshot.rows[0]?.availability.reasonCode, "spent");
  assert.equal(snapshot.rows[0]?.availability.canCall, false);
  assert.equal("reason" in snapshot.rows[0]!, false);
});
