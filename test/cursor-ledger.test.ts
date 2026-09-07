import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  fetchCursorLedgerEvents,
  judgeCursorLedgerJoin,
  parseCursorLedgerEvents,
} from "../electron/cursor-plan";
import {
  applyCursorLedger,
  chatSpend,
  cursorLaneEvents,
  joinCursorLedgerEvents,
  settleTurnUsage,
  type CursorLedgerSession,
} from "../src/lib/usage";
import type { UsageEvent } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AT = Date.parse("2026-09-06T16:00:00.000Z");

const sessionA: CursorLedgerSession = {
  id: "sess-a",
  vendorSessionId: "acp-a",
  model: "composer-2.5",
  projectId: "proj-1",
};
const sessionB: CursorLedgerSession = {
  id: "sess-b",
  vendorSessionId: "acp-b",
  model: "composer-2.5",
  projectId: "proj-1",
};
const worker: CursorLedgerSession = {
  id: "sess-w",
  vendorSessionId: "acp-w",
  model: "composer-2.5",
  projectId: "proj-1",
};

function dashboardEvent(input: {
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  at?: number;
  model?: string;
}): Record<string, unknown> {
  return {
    timestamp: String(input.at ?? AT),
    conversationId: input.conversationId,
    model: input.model ?? "composer-2.5",
    tokenUsage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      totalCents: 12,
    },
  };
}

test("parseCursorLedgerEvents reads public dashboard usageEvents shapes", () => {
  const parsed = parseCursorLedgerEvents({
    usageEvents: [
      dashboardEvent({ conversationId: "acp-a", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 80_000 }),
      {
        timestamp: "1750979225854",
        conversationId: "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b",
        model: "claude-4.5-sonnet",
        tokenUsage: {
          inputTokens: "126",
          outputTokens: "450",
          cacheWriteTokens: "6112",
          cacheReadTokens: "11964",
          totalCents: 20.18232,
        },
      },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.eventId, "acp-a");
  assert.equal(parsed[0]?.inputTokens, 2000);
  assert.equal(parsed[0]?.cacheReadTokens, 80_000);
  assert.equal(parsed[0]?.costUsd, 0.12);
  assert.equal(parsed[1]?.eventId, "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b");
  assert.equal(parsed[1]?.inputTokens, 126);
  assert.equal(parsed[1]?.cacheWriteTokens, 6112);
  assert.equal(parsed[1]?.identifiers.conversationId, parsed[1]?.eventId);
});

test("parseCursorLedgerEvents reads usageEventsDisplay from GetFilteredUsageEvents", () => {
  const parsed = parseCursorLedgerEvents({
    totalUsageEventsCount: 2,
    usageEventsDisplay: [
      dashboardEvent({ conversationId: "acp-a", inputTokens: 5501, outputTokens: 77, cacheReadTokens: 7392 }),
    ],
  });
  assert.equal(parsed[0]?.eventId, "acp-a");
  assert.equal(parsed[0]?.cacheReadTokens, 7392);
});

test("join books overlapping Cursor chats and drops IDE noise", () => {
  const events = parseCursorLedgerEvents({
    usageEvents: [
      dashboardEvent({ conversationId: "acp-a", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 80_000 }),
      dashboardEvent({ conversationId: "acp-b", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 20_000, at: AT + 1 }),
      dashboardEvent({ conversationId: "acp-ide", inputTokens: 9000, outputTokens: 100, cacheReadTokens: 500_000, at: AT + 2 }),
    ],
  });
  const booked = joinCursorLedgerEvents({ events, sessions: [sessionA, sessionB] });
  assert.equal(booked.length, 2);
  assert.equal(booked.find((item) => item.sessionId === "sess-a")?.cacheReadTokens, 80_000);
  assert.equal(booked.find((item) => item.sessionId === "sess-b")?.inputTokens, 1000);
  assert.equal(booked.some((item) => item.sessionId === "sess-ide" || item.id.includes("acp-ide")), false);
  const spendA = chatSpend(booked, "sess-a");
  assert.equal(spendA.cacheReadTokens, 80_000);
  assert.equal(spendA.inputTokens, 2000);
  assert.equal(spendA.outputTokens, 400);
  const composer = cursorLaneEvents(booked, "cursor:cursor-models");
  assert.equal(composer.length, 2);
  assert.equal(composer.reduce((sum, item) => sum + item.cacheReadTokens, 0), 100_000);
});

test("a same-millisecond same-model event without this desk's ACP id is dropped", () => {
  const events = parseCursorLedgerEvents({
    usageEvents: [
      dashboardEvent({ conversationId: "acp-other", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 80_000, at: AT }),
    ],
  });
  const booked = joinCursorLedgerEvents({ events, sessions: [{ ...sessionA, model: "composer-2.5" }] });
  assert.deepEqual(booked, []);
});

test("GetAggregatedUsageEvents totals without conversation ids book nothing", () => {
  const parsed = parseCursorLedgerEvents({
    aggregations: [
      {
        modelIntent: "composer-2.5",
        inputTokens: "900000",
        outputTokens: "12000",
        cacheReadTokens: "4000000",
        totalCents: 8000,
      },
    ],
    totalInputTokens: "900000",
    totalOutputTokens: "12000",
    totalCacheReadTokens: "4000000",
  });
  assert.deepEqual(parsed, []);
  assert.deepEqual(joinCursorLedgerEvents({ events: parsed, sessions: [sessionA, sessionB] }), []);
});

test("a worker ledger row books on the worker, and the desk rollup still sees it", () => {
  const events = parseCursorLedgerEvents({
    usageEvents: [
      dashboardEvent({ conversationId: "acp-a", inputTokens: 100, outputTokens: 20, cacheReadTokens: 500 }),
      dashboardEvent({ conversationId: "acp-w", inputTokens: 800, outputTokens: 90, cacheReadTokens: 12_000, at: AT + 3 }),
    ],
  });
  const parent = { ...sessionA };
  const booked = joinCursorLedgerEvents({ events, sessions: [parent, worker] });
  assert.equal(booked.find((item) => item.sessionId === "sess-w")?.cacheReadTokens, 12_000);
  assert.equal(booked.find((item) => item.sessionId === "sess-a")?.inputTokens, 100);
  assert.equal(chatSpend(booked, "sess-a").cacheReadTokens, 500);
  assert.equal(chatSpend(booked, "sess-w").inputTokens, 800);
  const desk = cursorLaneEvents(booked, "cursor:cursor-models");
  assert.equal(desk.reduce((sum, item) => sum + item.inputTokens, 0), 900);
});

test("settleTurnUsage keeps a joined ledger request over a chars/4 estimate", () => {
  const events = parseCursorLedgerEvents({
    usageEvents: [dashboardEvent({ conversationId: "acp-a", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 80_000 })],
  });
  const [ledger] = joinCursorLedgerEvents({ events, sessions: [sessionA] });
  assert.ok(ledger);
  const settled = settleTurnUsage({
    pending: [
      {
        provider: "cursor",
        model: "composer-2.5",
        inputTokens: 0,
        outputTokens: 0,
        contextUsed: 80_000,
        source: "gauge",
      },
      {
        provider: "cursor",
        model: "composer-2.5",
        sessionId: "sess-a",
        inputTokens: ledger.inputTokens,
        outputTokens: ledger.outputTokens,
        cacheReadTokens: ledger.cacheReadTokens,
        cacheWriteTokens: ledger.cacheWriteTokens,
        source: "request",
      },
    ],
    provider: "cursor",
    model: "composer-2.5",
    sessionId: "sess-a",
    estimate: { inputTokens: 12, outputTokens: 40 },
  });
  assert.equal(settled?.source, "request");
  assert.equal(settled?.inputTokens, 2000);
  assert.equal(settled?.cacheReadTokens, 80_000);
});

test("applyCursorLedger does not stack a ledger row on an ACP bill with the same fingerprint", () => {
  const existing: UsageEvent[] = [
    {
      id: "use_acp_a",
      at: AT,
      provider: "cursor",
      model: "composer-2.5",
      sessionId: "sess-a",
      lane: "cursor-models",
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 0,
      source: "request",
    },
  ];
  const incoming = joinCursorLedgerEvents({
    events: parseCursorLedgerEvents({
      usageEvents: [dashboardEvent({ conversationId: "acp-a", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 80_000 })],
    }),
    sessions: [sessionA],
  });
  const next = applyCursorLedger(existing, incoming);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.id, "use_acp_a");
});

test("applyCursorLedger replaces one estimate per new ledger row and is idempotent on id", () => {
  const estimate: UsageEvent = {
    id: "use_cursor_sess-a_0",
    at: AT - 1000,
    provider: "cursor",
    model: "composer-2.5",
    sessionId: "sess-a",
    lane: "cursor-models",
    inputTokens: 12,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: "estimate",
  };
  const incoming = joinCursorLedgerEvents({
    events: parseCursorLedgerEvents({
      usageEvents: [dashboardEvent({ conversationId: "acp-a", inputTokens: 2000, outputTokens: 400, cacheReadTokens: 80_000 })],
    }),
    sessions: [sessionA],
  });
  const once = applyCursorLedger([estimate], incoming);
  assert.equal(once.filter((item) => item.source === "estimate").length, 0);
  assert.equal(once.filter((item) => item.source === "request").length, 1);
  assert.equal(chatSpend(once, "sess-a").cacheReadTokens, 80_000);
  const twice = applyCursorLedger(once, incoming);
  assert.equal(twice.filter((item) => item.source === "request").length, 1);
});

test("fetchCursorLedgerEvents with no token returns undefined, not zeroes", async () => {
  let fetched = false;
  const missing = await fetchCursorLedgerEvents({
    token: "",
    fetchImpl: async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(missing, undefined);
  assert.equal(fetched, false);
});

test("fetchCursorLedgerEvents posts GetFilteredUsageEvents then parses the list", async () => {
  const urls: string[] = [];
  const events = await fetchCursorLedgerEvents({
    token: "jwt",
    startDate: AT - 60_000,
    endDate: AT + 60_000,
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      assert.equal(init?.method, "POST");
      return new Response(
        JSON.stringify({
          usageEvents: [dashboardEvent({ conversationId: "acp-a", inputTokens: 10, outputTokens: 2 })],
        }),
        { status: 200 },
      );
    },
  });
  assert.match(urls[0] ?? "", /GetFilteredUsageEvents/);
  assert.equal(events?.[0]?.eventId, "acp-a");
  assert.equal(events?.[0]?.inputTokens, 10);
});

test("judgeCursorLedgerJoin is MATCH on conversationId and OTHER_MATCH on one other field", () => {
  const match = judgeCursorLedgerJoin({
    events: parseCursorLedgerEvents({
      usageEvents: [
        dashboardEvent({ conversationId: "acp-a", inputTokens: 10, outputTokens: 2 }),
        dashboardEvent({ conversationId: "acp-b", inputTokens: 8, outputTokens: 1, at: AT + 1 }),
      ],
    }),
    vendorSessionIds: ["acp-a", "acp-b"],
  });
  assert.equal(match.verdict, "MATCH");
  assert.equal(match.joinField, "conversationId");

  const other = judgeCursorLedgerJoin({
    events: parseCursorLedgerEvents({
      usageEvents: [
        {
          timestamp: AT,
          composerId: "acp-a",
          tokenUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1 },
        },
      ],
    }),
    vendorSessionIds: ["acp-a"],
  });
  assert.equal(other.verdict, "OTHER_MATCH");
  assert.equal(other.joinField, "composerId");

  const none = judgeCursorLedgerJoin({
    events: parseCursorLedgerEvents({
      usageEvents: [dashboardEvent({ conversationId: "acp-ide", inputTokens: 10, outputTokens: 2 })],
    }),
    vendorSessionIds: ["acp-a"],
  });
  assert.equal(none.verdict, "NO_MATCH");
});

test("the desk joins Cursor ledger events after a turn and on leftover refresh", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const features = readFileSync(path.join(ROOT, "docs", "FEATURES.md"), "utf8");
  const plan = readFileSync(path.join(ROOT, "electron", "cursor-plan.ts"), "utf8");
  assert.match(preload, /cursor:ledger-events/);
  assert.match(main, /fetchCursorLedgerEvents/);
  assert.match(plan, /GetCurrentPeriodUsage/);
  assert.match(plan, /GetFilteredUsageEvents/);
  assert.match(store, /joinCursorLedgerEvents/);
  assert.match(store, /applyCursorLedger/);
  assert.match(store, /ingestCursorLedgerRef/);
  assert.match(store, /cursorLedgerEvents/);
  assert.match(features, /joined to this desk's ACP session id/);
  assert.match(features, /not the\s+whole Cursor account/);
});
