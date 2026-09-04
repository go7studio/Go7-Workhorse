import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createWorkshopHost, gatewayUrl, listInstalledPacks, readCapped, sourceShareKey } from "../electron/workshop-host";
import {
  fingerprintsForSources,
  sourceFingerprint,
  type JsonSource,
  type PackSource,
  type ProbeResult,
  type WorkshopSettings,
} from "../src/lib/workshop-pack";
import type { LocalComputeHostSettings } from "../src/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "workshop");
const TOKEN = "private-token-0xdeadbeef";
const NOW = Date.parse("2026-09-04T12:00:30.000Z");

const spark: LocalComputeHostSettings = {
  id: "spark", label: "Spark", baseUrl: "https://spark.example.test",
  tokenFile: path.join("private", "spark.token"), enabled: true,
  allowedCallerRoles: ["desk"], allowedCapabilities: [], allowedContinuations: [],
};

const FIXTURE_SOURCES: PackSource[] = [
  { id: "feed", kind: "json", path: "feed", pollMs: 2000, freshMs: 120000, asOf: "/asOf", schema: "sample-feed/v1", maxBytes: 65536 },
  { id: "infer", kind: "probes", probes: ["healthz", "readyz", "models"], pollMs: 5000 },
];

const onSettings = (sources = ["feed", "infer"], hostId = "spark"): WorkshopSettings => ({
  packs: [{
    id: "sample-box",
    on: true,
    hostId,
    sources,
    sourceFingerprints: fingerprintsForSources("sample-box", FIXTURE_SOURCES, sources),
  }],
});

const freshFeed = () => JSON.stringify({
  schema: "sample-feed/v1", asOf: "2026-09-04T12:00:00.000Z", loadPercent: 41, watts: 220, oneWriter: true,
  job: { done: 10, total: 20 }, flags: ["idle"],
});

type Route = { status: number; body?: string; headers?: Record<string, string> };

function fakeFetch(routes: Record<string, Route>, seen: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    seen.push({ url, init });
    const key = Object.keys(routes).find((item) => new URL(url).pathname === item);
    const hit = key ? routes[key] : { status: 404, body: "" };
    return new Response(hit.body ?? "", { status: hit.status, headers: hit.headers });
  }) as typeof fetch;
}

function host(overrides: Partial<Parameters<typeof createWorkshopHost>[0]> = {}) {
  return createWorkshopHost({
    packsRoot: () => FIXTURES,
    getSettings: () => onSettings(),
    getHosts: () => [spark],
    readToken: () => TOKEN,
    now: () => NOW,
    fetchImpl: fakeFetch({}),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------
// Carried over: origin lock and byte cap

test("gatewayUrl keeps every path on the configured origin and refuses anything else", () => {
  const base = "https://spark.example.test:8443/gw";
  assert.equal(gatewayUrl(base, "/workshop/sample-box/feed")?.href, "https://spark.example.test:8443/gw/workshop/sample-box/feed");
  assert.equal(gatewayUrl("https://spark.example.test", "/healthz")?.href, "https://spark.example.test/healthz");
  assert.equal(gatewayUrl("https://spark.example.test/", "/v1/models")?.pathname, "/v1/models");
  for (const bad of [
    "https://evil.test/steal",
    "//evil.test/steal",
    "/..%2f..%2fetc",
    "/workshop/../v1/keys",
    "/workshop/./feed",
    "/feed?token=1",
    "/feed#x",
    "/feed\\x",
    "workshop/v0/feed",
    "/",
    "",
    "/feed%2e%2e",
    "/fe ed",
  ]) {
    assert.equal(gatewayUrl(base, bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(gatewayUrl("file:///etc", "/feed"), null);
  assert.equal(gatewayUrl("not a url", "/feed"), null);
});

test("readCapped refuses a body past the cap instead of truncating it", async () => {
  assert.equal(await readCapped(new Response("x".repeat(100)), 100), "x".repeat(100));
  assert.equal(await readCapped(new Response("x".repeat(101)), 100), null);
  assert.equal(await readCapped(new Response("short", { headers: { "content-length": "999999" } }), 100), null);
});

// ---------------------------------------------------------------------------------------------
// Listing

test("listing shows the fixture pack with its sources and the user's grants", () => {
  const raw = listInstalledPacks(FIXTURES);
  assert.equal(raw.length, 1);
  assert.ok(raw[0].ok && raw[0].folderId === "sample-box");

  const workshop = host({ getSettings: () => onSettings(["feed"]) });
  const listed = workshop.list();
  assert.equal(listed.length, 1);
  const [pack] = listed;
  assert.equal(pack.id, "sample-box");
  assert.equal(pack.name, "Sample box");
  assert.equal(pack.version, "1.0.0");
  assert.equal(pack.on, true);
  assert.equal(pack.hostId, "spark");
  assert.deepEqual(pack.granted, ["feed"]);
  assert.equal(pack.collector, "collector");
  assert.equal(pack.refused, undefined);
  assert.deepEqual(pack.sources.map((s) => s.id), ["feed", "infer"]);
  assert.equal(pack.sources[0].kind, "json");
  assert.equal(pack.sources[0].path, "feed");
  assert.equal(pack.sources[0].namespace, undefined);
  assert.equal(pack.sources[0].maxBytes, 65536);
  assert.deepEqual(pack.sources[1].probes, ["healthz", "readyz", "models"]);
  workshop.dispose();
});

test("an off pack lists as off with no grants and never appears in view", async () => {
  const workshop = host({ getSettings: () => ({ packs: [] }) });
  assert.equal(workshop.list()[0].on, false);
  assert.deepEqual(workshop.list()[0].granted, []);
  assert.deepEqual(await workshop.view(), []);
  assert.equal(workshop.anyOn(), false);
  workshop.dispose();
});

// ---------------------------------------------------------------------------------------------
// View

test("view returns documents and status for granted sources; the token never appears", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const workshop = host({
    fetchImpl: fakeFetch({
      "/workshop/sample-box/feed": { status: 200, body: freshFeed() },
      "/healthz": { status: 200, body: "ok" },
      "/readyz": { status: 503, body: "" },
      "/v1/models": { status: 200, body: JSON.stringify({ data: [{ id: "qwen3-8b" }, { id: "llama-3" }, { name: "no-id" }] }) },
    }, seen),
  });
  const views = await workshop.view();
  assert.equal(views.length, 1);
  const [view] = views;
  assert.equal(view.id, "sample-box");
  assert.equal(view.on, true);
  assert.equal(view.hostId, "spark");
  assert.equal(view.primarySource, "feed");
  assert.equal(view.collector, "collector");
  assert.equal(view.strip.length, 7);
  assert.equal(view.cards.length, 6);

  const feedStatus = view.documents.status?.feed;
  assert.equal(feedStatus?.present, true);
  assert.equal(feedStatus?.asOf, "2026-09-04T12:00:00.000Z");
  assert.equal(feedStatus?.fetchedAt, new Date(NOW).toISOString());
  assert.equal((view.documents.feed as { watts: number }).watts, 220);

  const infer = view.documents.infer as Record<string, ProbeResult>;
  assert.equal(view.documents.status?.infer.present, true);
  assert.equal(infer.healthz.status, "ok");
  assert.equal(infer.readyz.status, "down");
  assert.equal(infer.readyz.detail, "http-503");
  assert.equal(infer.models.status, "ok");
  assert.deepEqual(infer.models.ids, ["qwen3-8b", "llama-3"]);
  assert.equal(infer.models.count, 2);

  assert.deepEqual(view.documents.desk, { host: { label: "Spark", emptyCapabilities: true }, pack: { name: "Sample box" } });

  assert.doesNotMatch(JSON.stringify(views), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(workshop.list()), new RegExp(TOKEN));
  assert.ok(seen.length >= 4);
  for (const call of seen) {
    assert.ok(call.url.startsWith("https://spark.example.test/"), call.url);
    assert.equal(new Headers(call.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(call.init?.redirect, "error");
  }
  workshop.dispose();
});

test("ungranted source reads off and is never fetched", async () => {
  const seen: Array<{ url: string }> = [];
  const workshop = host({
    getSettings: () => onSettings(["feed"]),
    fetchImpl: fakeFetch({ "/workshop/sample-box/feed": { status: 200, body: freshFeed() } }, seen),
  });
  const [view] = await workshop.view();
  assert.deepEqual(view.documents.status?.infer, { present: false, reason: "off" });
  assert.equal(view.documents.infer, undefined);
  assert.equal(view.documents.status?.feed.present, true);
  assert.ok(seen.every((call) => call.url.endsWith("/workshop/sample-box/feed")), JSON.stringify(seen));
  workshop.dispose();
});

test("a host id that matches no enabled host reads no-host and nothing is fetched", async () => {
  const seen: Array<{ url: string }> = [];
  const workshop = host({
    getSettings: () => onSettings(["feed", "infer"], "ghost"),
    fetchImpl: fakeFetch({}, seen),
  });
  const [view] = await workshop.view();
  assert.equal(view.documents.status?.feed.reason, "no-host");
  assert.equal(view.documents.status?.infer.reason, "no-host");
  assert.equal(view.documents.desk?.host?.label, undefined);
  assert.equal(seen.length, 0);

  const disabled = host({ getHosts: () => [{ ...spark, enabled: false }], fetchImpl: fakeFetch({}, seen) });
  assert.equal((await disabled.view())[0].documents.status?.feed.reason, "no-host");
  assert.equal(seen.length, 0);
  disabled.dispose();
  workshop.dispose();
});

test("a missing token reads token and the request is never sent", async () => {
  const seen: Array<{ url: string }> = [];
  const workshop = host({ readToken: () => null, getSettings: () => onSettings(["feed"]), fetchImpl: fakeFetch({}, seen) });
  const [view] = await workshop.view();
  assert.equal(view.documents.status?.feed.reason, "token");
  assert.equal(seen.length, 0);
  workshop.dispose();
});

test("status maps http and transport failures", async () => {
  const cases: Array<[Route | "throw", string]> = [
    [{ status: 401 }, "unauthorized"],
    [{ status: 403 }, "unauthorized"],
    [{ status: 404 }, "missing"],
    [{ status: 502 }, "http-502"],
    ["throw", "unreachable"],
  ];
  for (const [route, reason] of cases) {
    const fetchImpl: typeof fetch = route === "throw"
      ? (async () => { throw new TypeError("fetch failed"); }) as typeof fetch
      : fakeFetch({ "/workshop/sample-box/feed": route });
    const workshop = host({ getSettings: () => onSettings(["feed"]), fetchImpl });
    const [view] = await workshop.view();
    assert.equal(view.documents.status?.feed.present, false);
    assert.equal(view.documents.status?.feed.reason, reason);
    assert.equal(view.documents.feed, undefined);
    workshop.dispose();
  }
});

test("stale asOf drops the document so meters paint —", async () => {
  const workshop = host({
    getSettings: () => onSettings(["feed"]),
    fetchImpl: fakeFetch({
      "/workshop/sample-box/feed": { status: 200, body: JSON.stringify({ schema: "sample-feed/v1", asOf: "2026-09-04T11:00:00.000Z", watts: 9 }) },
    }),
  });
  const [view] = await workshop.view();
  assert.equal(view.documents.status?.feed.present, false);
  assert.equal(view.documents.status?.feed.reason, "stale");
  assert.equal(view.documents.status?.feed.asOf, "2026-09-04T11:00:00.000Z");
  assert.equal(view.documents.feed, undefined);
  workshop.dispose();
});

test("fingerprint mismatch or missing fingerprints skips fetch under old grants", async () => {
  const seen: Array<{ url: string }> = [];
  const routes = {
    "/workshop/sample-box/feed": { status: 200, body: freshFeed() },
    "/workshop/v0/feed": { status: 200, body: freshFeed() },
  };
  const mismatched = host({
    getSettings: () => ({
      packs: [{
        id: "sample-box",
        on: true,
        hostId: "spark",
        sources: ["feed"],
        // Confirmed against a different namespace than the installed pack.
        sourceFingerprints: {
          feed: sourceFingerprint("sample-box", {
            id: "feed", kind: "json", path: "feed", namespace: "v0", pollMs: 2000, freshMs: 120000, maxBytes: 65536,
          }),
        },
      }],
    }),
    fetchImpl: fakeFetch(routes, seen),
  });
  assert.equal(mismatched.list()[0].on, false);
  assert.deepEqual(await mismatched.view(), []);
  assert.equal(seen.length, 0);
  mismatched.dispose();

  const legacy = host({
    getSettings: () => ({ packs: [{ id: "sample-box", on: true, hostId: "spark", sources: ["feed"] }] }),
    fetchImpl: fakeFetch(routes, seen),
  });
  // normalizeWorkshopSettings clears on without fingerprints; host also refuses.
  assert.equal(legacy.list()[0].on, false);
  assert.deepEqual(await legacy.view(), []);
  assert.equal(seen.length, 0);
  legacy.dispose();
});

test("schema mismatch, oversized, and malformed bodies are refused with their reason", async () => {
  const cases: Array<[Route, string]> = [
    [{ status: 200, body: JSON.stringify({ schema: "other/v9", asOf: "2026-09-04T12:00:00.000Z" }) }, "schema"],
    [{ status: 200, body: JSON.stringify({ schema: "sample-feed/v1", asOf: "2026-09-04T12:00:00.000Z", pad: "x".repeat(70_000) }) }, "too-large"],
    [{ status: 200, body: "{}", headers: { "content-length": "9999999" } }, "too-large"],
    [{ status: 200, body: "{not json" }, "malformed"],
    [{ status: 200, body: "[1,2,3]" }, "malformed"],
    [{ status: 200, body: JSON.stringify({ schema: "sample-feed/v1", asOf: "2026-09-04T12:00:00.000Z", s: "y".repeat(17_000) }) }, "malformed"],
  ];
  for (const [route, reason] of cases) {
    const workshop = host({ getSettings: () => onSettings(["feed"]), fetchImpl: fakeFetch({ "/workshop/sample-box/feed": route }) });
    const [view] = await workshop.view();
    assert.equal(view.documents.status?.feed.reason, reason, `expected ${reason}`);
    assert.equal(view.documents.feed, undefined);
    workshop.dispose();
  }
});

test("probes document: unauthorized and down shapes, present only when one probe is ok", async () => {
  const seen: Array<{ url: string }> = [];
  const workshop = host({
    getSettings: () => onSettings(["infer"]),
    fetchImpl: fakeFetch({ "/healthz": { status: 401 }, "/readyz": { status: 401 }, "/v1/models": { status: 401 } }, seen),
  });
  const [view] = await workshop.view();
  const infer = view.documents.infer as Record<string, ProbeResult>;
  assert.deepEqual(infer.healthz, { status: "unauthorized", detail: "http-401" });
  assert.equal(view.documents.status?.infer.present, false);
  assert.equal(view.documents.status?.infer.reason, "unauthorized");
  assert.deepEqual(seen.map((c) => new URL(c.url).pathname).sort(), ["/healthz", "/readyz", "/v1/models"]);
  assert.equal(view.documents.status?.feed.reason, "off");
  workshop.dispose();

  const down = host({
    getSettings: () => onSettings(["infer"]),
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
  });
  const [downView] = await down.view();
  const downInfer = downView.documents.infer as Record<string, ProbeResult>;
  assert.equal(downInfer.models.status, "down");
  assert.equal(downView.documents.status?.infer.reason, "unreachable");
  down.dispose();
});

test("refresh drops timers for a pack turned off and view stops listing it", async () => {
  let settings = onSettings(["feed"]);
  const workshop = host({
    getSettings: () => settings,
    fetchImpl: fakeFetch({ "/workshop/sample-box/feed": { status: 200, body: freshFeed() } }),
  });
  assert.equal((await workshop.view()).length, 1);
  settings = { packs: [{ id: "sample-box", on: false, hostId: "spark", sources: [] }] };
  workshop.refresh();
  assert.deepEqual(await workshop.view(), []);
  workshop.dispose();
});

test("collectorPath stays inside the packs root and is a real folder", () => {
  const workshop = host();
  const target = workshop.collectorPath("sample-box");
  assert.equal(target, path.join(FIXTURES, "sample-box", "collector"));
  assert.equal(workshop.collectorPath("nope"), null);
  assert.equal(workshop.collectorPath("../sample-box"), null);
  workshop.dispose();
});

test("breakout opens once, focuses on repeat, and closes", () => {
  let created = 0;
  let closed = 0;
  let focused = 0;
  const workshop = host({
    createBreakout: () => {
      created += 1;
      let destroyed = false;
      return { show() {}, focus() { focused += 1; }, close() { closed += 1; destroyed = true; }, isDestroyed: () => destroyed };
    },
  });
  assert.equal(workshop.openBreakout(), true);
  assert.equal(workshop.openBreakout(), true);
  assert.equal(created, 1);
  assert.equal(focused, 1);
  workshop.closeBreakout();
  assert.equal(closed, 1);
  assert.equal(host({}).openBreakout(), false);
  workshop.dispose();
});

// ---------------------------------------------------------------------------------------------
// Shared fetch: identical authorized URLs coalesce

const DEDUPE = path.join(ROOT, "test", "fixtures", "workshop-dedupe");

const dedupeFeed = (): JsonSource => ({
  id: "feed", kind: "json", path: "feed", namespace: "v0", pollMs: 2000, freshMs: 120000, asOf: "/asOf", schema: "sample-feed/v1", maxBytes: 65536,
});

test("two packs granting the same host URL share one GET per period", async () => {
  const seen: Array<{ url: string }> = [];
  const body = freshFeed();
  let settings: WorkshopSettings = {
    packs: [
      {
        id: "box-a", on: true, hostId: "spark", sources: ["feed"],
        sourceFingerprints: fingerprintsForSources("box-a", [{ ...dedupeFeed(), pollMs: 2000 }], ["feed"]),
      },
      {
        id: "box-b", on: true, hostId: "spark", sources: ["feed"],
        sourceFingerprints: fingerprintsForSources("box-b", [{ ...dedupeFeed(), pollMs: 5000 }], ["feed"]),
      },
    ],
  };
  const workshop = createWorkshopHost({
    packsRoot: () => DEDUPE,
    getSettings: () => settings,
    getHosts: () => [spark],
    readToken: () => TOKEN,
    now: () => NOW,
    fetchImpl: fakeFetch({ "/workshop/v0/feed": { status: 200, body } }, seen),
  });
  const views = await workshop.view();
  assert.equal(views.length, 2);
  assert.equal(views.find((v) => v.id === "box-a")?.documents.status?.feed.present, true);
  assert.equal(views.find((v) => v.id === "box-b")?.documents.status?.feed.present, true);
  assert.equal((views.find((v) => v.id === "box-a")?.documents.feed as { watts: number }).watts, 220);
  assert.equal((views.find((v) => v.id === "box-b")?.documents.feed as { watts: number }).watts, 220);
  const feedGets = seen.filter((call) => new URL(call.url).pathname === "/workshop/v0/feed");
  assert.equal(feedGets.length, 1, `expected one shared GET, got ${feedGets.length}: ${JSON.stringify(seen)}`);

  // A second view must not start another fetch while the shared timer is idle with cache.
  const before = seen.length;
  await workshop.view();
  assert.equal(seen.length, before);

  settings = { packs: settings.packs.filter((p) => p.id === "box-a") };
  workshop.refresh();
  await workshop.view();
  assert.equal((await workshop.view()).length, 1);
  workshop.dispose();
});

test("fingerprint mismatch keeps an unauthorized pack off the shared GET", async () => {
  const seen: Array<{ url: string }> = [];
  const workshop = createWorkshopHost({
    packsRoot: () => DEDUPE,
    getSettings: () => ({
      packs: [
        {
          id: "box-a", on: true, hostId: "spark", sources: ["feed"],
          sourceFingerprints: fingerprintsForSources("box-a", [dedupeFeed()], ["feed"]),
        },
        {
          id: "box-c", on: true, hostId: "spark", sources: ["feed"],
          // Confirmed against a different namespace than the installed pack — must not fetch or receive.
          sourceFingerprints: {
            feed: sourceFingerprint("box-c", {
              id: "feed", kind: "json", path: "feed", namespace: "other", pollMs: 2000, freshMs: 120000, maxBytes: 65536,
            }),
          },
        },
      ],
    }),
    getHosts: () => [spark],
    readToken: () => TOKEN,
    now: () => NOW,
    fetchImpl: fakeFetch({ "/workshop/v0/feed": { status: 200, body: freshFeed() } }, seen),
  });
  const views = await workshop.view();
  assert.equal(views.length, 1);
  assert.equal(views[0].id, "box-a");
  assert.equal(workshop.list().find((p) => p.id === "box-c")?.on, false);
  assert.equal(seen.filter((c) => new URL(c.url).pathname === "/workshop/v0/feed").length, 1);
  assert.equal(seen.filter((c) => c.url.includes("/workshop/other/")).length, 0);
  workshop.dispose();
});

test("sourceShareKey groups by host path, not pack id", () => {
  const a = sourceShareKey("box-a", "spark", dedupeFeed());
  const b = sourceShareKey("box-b", "spark", { ...dedupeFeed(), pollMs: 5000 });
  assert.equal(a, b);
  assert.notEqual(a, sourceShareKey("box-a", "other-host", dedupeFeed()));
  const { namespace: _omit, ...packDefaultNs } = dedupeFeed();
  assert.notEqual(a, sourceShareKey("box-a", "spark", { ...packDefaultNs, path: "feed" }));
});
