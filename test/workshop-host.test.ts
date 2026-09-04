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


test("sidecar grant carries the job section; last-8 is the live window rate, never the top-level field", async () => {
  const workshop = createWorkshopHost({
    packsRoot: () => path.join(ROOT, "workshop", "packs"),
    getSettings: () => ({ packs: [{ id: "box-monitor", on: true, grants: ["read.box.metrics", "read.fs.sidecar"] }] }),
    getHosts: () => [host],
    readToken: () => "private-token",
    now: () => Date.parse("2026-09-03T20:00:30.000Z"),
    fetchImpl: fakeFetch({
      "/healthz": { status: 200, body: "ok" },
      "/readyz": { status: 502, body: "" },
      "/v1/models": { status: 502, body: "" },
      "/workshop/v0/feed": { status: 200, body: JSON.stringify({
        schema: "go7-workshop-feed/v0",
        asOf: "2026-09-03T20:00:00.000Z",
        gpuUtilPercent: 96,
        oneWriter: true,
        last8Toks: 99_999,
        latestJson: "/home/op/workloads/creative-llm/checkpoints/base/run/latest.json",
        exclusiveSidecar: { probeUnit: "active", qwenParked: true },
        job: {
          lease: { kind: "pretrain", pid: 4242, yaml: "mb64_probe_v1.yaml", startedUtc: "2026-09-02 17:47Z", pidMatch: true },
          live: { step: 84_000, tokensSeen: 2_064_384_000, trainLoss: 2.56, tokPerParam: 4.13, elapsedS: 156_000, last8TokS: 13_600 },
          durable: { step: 80_000, tokensSeen: 1_966_080_000, targetTokens: 2_500_000_000, tokensPerStep: 24_576, paramCount: 500_000_000, jobComplete: false, undertrainedFlag: true, runName: "run" },
          fence: [{ unit: "qwen38-sglang", active: false }],
          flags: ["two-trainers"],
          gpuName: "NVIDIA GB10",
        },
      }) },
    }),
  });
  const side = await workshop.read("box-monitor", "read.fs.sidecar");
  assert.ok(side && "job" in side);
  if ("job" in side) {
    assert.equal(side.job.lease.pid, 4242);
    assert.equal(side.job.live.step, 84_000);
    assert.equal(side.job.durable.step, 80_000);
    assert.equal(side.job.durable.jobComplete, false);
    assert.deepEqual(side.job.flags, ["two-trainers"]);
    assert.equal(side.last8Toks, 13_600, "rate comes from job.live, not the top-level field");
    assert.equal(side.exclusiveSidecar.probeUnit, "active");
    // Box grant alone never paints the rate.
    const box = await workshop.read("box-monitor", "read.box.metrics");
    assert.ok(box && "last8Toks" in box);
    if ("last8Toks" in box) assert.equal(box.last8Toks, WORKSHOP_UNKNOWN);
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
