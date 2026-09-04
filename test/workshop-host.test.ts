import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createWorkshopHost } from "../electron/workshop-host";
import { WORKSHOP_UNKNOWN } from "../src/lib/workshop";
import type { LocalComputeHostSettings } from "../src/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const host: LocalComputeHostSettings = {
  id: "spark", label: "Spark", baseUrl: "https://spark.example.test",
  tokenFile: "/private/spark.token", enabled: true,
  allowedCallerRoles: ["desk"], allowedCapabilities: [], allowedContinuations: [],
};

function fakeFetch(routes: Record<string, { status: number; body?: string }>): typeof fetch {
  return (async (input) => {
    const url = String(input);
    const key = Object.keys(routes).find((item) => url.endsWith(item));
    const hit = key ? routes[key] : { status: 404, body: "" };
    return new Response(hit.body ?? "", { status: hit.status });
  }) as typeof fetch;
}

test("ungated read is unknown and token never leaves the host", async () => {
  let authorization = "";
  const workshop = createWorkshopHost({
    packsRoot: () => path.join(ROOT, "workshop", "packs"),
    getSettings: () => ({ packs: [] }),
    getHosts: () => [host],
    readToken: () => "private-token",
    fetchImpl: (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const miss = await workshop.read("box-monitor", "read.box.metrics");
  assert.deepEqual(miss, { unknown: true });
  assert.equal(authorization, "");
});

test("granted read paints unknown when the feed is missing or stale", async () => {
  const workshop = createWorkshopHost({
    packsRoot: () => path.join(ROOT, "workshop", "packs"),
    getSettings: () => ({ packs: [{ id: "box-monitor", on: true, grants: ["read.box.metrics", "read.fs.sidecar"] }] }),
    getHosts: () => [host],
    readToken: () => "private-token",
    now: () => Date.parse("2026-09-03T20:10:00.000Z"),
    fetchImpl: fakeFetch({
      "/healthz": { status: 200, body: "ok" },
      "/readyz": { status: 401, body: "" },
      "/v1/models": { status: 200, body: "{\"data\":[]}" },
      "/workshop/v0/feed": { status: 404, body: "" },
    }),
  });
  const snap = await workshop.read("box-monitor", "read.box.metrics");
  assert.ok(snap && !("unknown" in snap) && !("tail" in snap));
  if ("gpuUtilPercent" in snap) {
    assert.equal(snap.gpuUtilPercent, WORKSHOP_UNKNOWN);
    assert.equal(snap.infer.find((tile) => tile.path === "/readyz")?.status, "unauthorized");
    assert.equal(snap.infer.find((tile) => tile.path === "/healthz")?.status, "ok");
    assert.equal(snap.last8Toks, WORKSHOP_UNKNOWN);
    assert.doesNotMatch(JSON.stringify(snap), /private-token|hours to 5/i);
  }
});

test("fresh feed fills granted metrics and refuses last-8 invention", async () => {
  const workshop = createWorkshopHost({
    packsRoot: () => path.join(ROOT, "workshop", "packs"),
    getSettings: () => ({ packs: [{ id: "box-monitor", on: true, grants: ["read.box.metrics"] }] }),
    getHosts: () => [host],
    readToken: () => "private-token",
    now: () => Date.parse("2026-09-03T20:00:30.000Z"),
    fetchImpl: fakeFetch({
      "/healthz": { status: 200, body: "ok" },
      "/readyz": { status: 200, body: "ok" },
      "/v1/models": { status: 200, body: "{\"data\":[]}" },
      "/workshop/v0/feed": { status: 200, body: JSON.stringify({
        schema: "go7-workshop-feed/v0",
        asOf: "2026-09-03T20:00:00.000Z",
        gpuUtilPercent: 41,
        powerWatts: 220,
        oneWriter: true,
        trainNameMatchCount: 1,
        tokPerParam: 0.4,
        last8Toks: 13653,
      }) },
    }),
  });
  const snap = await workshop.read("box-monitor", "read.box.metrics");
  assert.ok(snap && "gpuUtilPercent" in snap);
  if ("gpuUtilPercent" in snap) {
    assert.equal(snap.gpuUtilPercent, 41);
    assert.equal(snap.oneWriter, true);
    assert.equal(snap.trainNameMatchCount, 1);
    assert.equal(snap.last8Toks, WORKSHOP_UNKNOWN);
  }
});


test("feedStatus exposes asOf when feed is present", async () => {
  const workshop = createWorkshopHost({
    packsRoot: () => path.join(ROOT, "workshop", "packs"),
    getSettings: () => ({ packs: [{ id: "box-monitor", on: true, grants: ["read.box.metrics"] }] }),
    getHosts: () => [host],
    readToken: () => "private-token",
    now: () => Date.parse("2026-09-03T20:00:30.000Z"),
    fetchImpl: fakeFetch({
      "/healthz": { status: 200, body: "ok" },
      "/readyz": { status: 200, body: "ok" },
      "/v1/models": { status: 200, body: "{\"data\":[]}" },
      "/workshop/v0/feed": {
        status: 200,
        body: JSON.stringify({
          schema: "go7-workshop-feed/v0",
          asOf: "2026-09-03T20:00:00.000Z",
          gpuUtilPercent: 41,
          oneWriter: true,
        }),
      },
    }),
  });
  const status = await workshop.feedStatus("box-monitor");
  assert.equal(status.present, true);
  assert.equal(status.asOf, "2026-09-03T20:00:00.000Z");
});
