import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSHOP_UNKNOWN,
  deriveJob,
  feedAgeLabel,
  fmtClock,
  fmtFixed,
  fmtHours,
  fmtInt,
  fmtTokens,
  fmtWall,
  paintJobFlag,
  parseJobDoc,
  unknownJob,
  feedTone,
  gaugePercent,
  inferTone,
  latestJsonBasename,
  modelsState,
  paintJobStatus,
  paintModelsLine,
  paintQwenParked,
  paintWatts,
  stripLine,
  unknownMetrics,
} from "../src/lib/workshop";

test("paintQwenParked maps parked/up/unknown", () => {
  assert.equal(paintQwenParked(true), "parked");
  assert.equal(paintQwenParked(false), "up");
  assert.equal(paintQwenParked(WORKSHOP_UNKNOWN), WORKSHOP_UNKNOWN);
});

test("paintModelsLine lists ids or train-exclusive plain words", () => {
  const base = unknownMetrics();
  assert.equal(paintModelsLine({ ...base, models: ["qwen3.8-27b"] }), "qwen3.8-27b");
  assert.equal(
    paintModelsLine({
      ...base,
      oneWriter: true,
      exclusiveSidecar: { probeUnit: "active", qwenParked: true },
      infer: [{ path: "/v1/models", status: "down", detail: "http-502" }],
      models: WORKSHOP_UNKNOWN,
      localComputeEmptyCapabilities: true,
    }),
    "infer down / train exclusive · http-502",
  );
  assert.equal(
    paintModelsLine({
      ...base,
      oneWriter: true,
      exclusiveSidecar: { probeUnit: "active", qwenParked: true },
      infer: [{ path: "/v1/models", status: "down" }],
      models: WORKSHOP_UNKNOWN,
    }),
    "infer down / train exclusive",
  );
  assert.equal(paintModelsLine(null), WORKSHOP_UNKNOWN);
});

test("paintModelsLine names empty Local Compute capabilities when not train-exclusive", () => {
  const base = unknownMetrics();
  assert.equal(
    paintModelsLine({
      ...base,
      oneWriter: false,
      localComputeEmptyCapabilities: true,
      infer: [{ path: "/v1/models", status: "unknown", detail: "no-host" }],
      models: WORKSHOP_UNKNOWN,
    }),
    "Local Compute host has no allowed capabilities",
  );
});

test("paintJobStatus derives from writer + feed", () => {
  const base = unknownMetrics();
  assert.equal(paintJobStatus(base, false), WORKSHOP_UNKNOWN);
  assert.equal(paintJobStatus({ ...base, oneWriter: true }, true), "running (one writer)");
  assert.equal(paintJobStatus({ ...base, oneWriter: false }, true), "not exclusive");
});

test("stripLine paints GPU · watts · writer · models", () => {
  const base = unknownMetrics();
  assert.equal(
    stripLine({
      ...base,
      gpuUtilPercent: 41,
      powerWatts: 220,
      oneWriter: true,
      models: ["qwen3.8-27b"],
    }),
    "41% · 220W · one · qwen3.8-27b",
  );
  assert.equal(stripLine(null), `${WORKSHOP_UNKNOWN} · ${WORKSHOP_UNKNOWN} · ${WORKSHOP_UNKNOWN} · ${WORKSHOP_UNKNOWN}`);
});

test("modelsState is the four Models card states, same words as paintModelsLine", () => {
  const base = unknownMetrics();
  assert.deepEqual(modelsState(null), { kind: "unknown", line: WORKSHOP_UNKNOWN });
  assert.deepEqual(modelsState({ ...base, models: ["qwen3.8-27b", "bloom-560m-soak"] }), {
    kind: "loaded",
    ids: ["qwen3.8-27b", "bloom-560m-soak"],
  });
  assert.deepEqual(
    modelsState({
      ...base,
      oneWriter: true,
      exclusiveSidecar: { probeUnit: "active", qwenParked: true },
      infer: [{ path: "/v1/models", status: "down", detail: "http-502" }],
    }),
    { kind: "train-exclusive", line: "infer down / train exclusive · http-502" },
  );
  assert.deepEqual(
    modelsState({ ...base, oneWriter: false, localComputeEmptyCapabilities: true }),
    { kind: "empty-caps", line: "Local Compute host has no allowed capabilities" },
  );
});

test("paintWatts rounds for the glance; gaugePercent clamps or is null", () => {
  assert.equal(paintWatts(65.73), "66 W");
  assert.equal(paintWatts(220), "220 W");
  assert.equal(paintWatts(WORKSHOP_UNKNOWN), WORKSHOP_UNKNOWN);
  assert.equal(paintWatts(Number.NaN), WORKSHOP_UNKNOWN);
  assert.equal(gaugePercent(96), 96);
  assert.equal(gaugePercent(140), 100);
  assert.equal(gaugePercent(-3), 0);
  assert.equal(gaugePercent(WORKSHOP_UNKNOWN), null);
});

test("latestJsonBasename paints the file, never the path", () => {
  assert.equal(latestJsonBasename("/home/go7-dgx-spark/workloads/llm/checkpoints/base/shared_v3/latest.json"), "latest.json");
  assert.equal(latestJsonBasename("C:\\spark\\runs\\latest.json"), "latest.json");
  assert.equal(latestJsonBasename("latest.json"), "latest.json");
  assert.equal(latestJsonBasename(WORKSHOP_UNKNOWN), WORKSHOP_UNKNOWN);
  assert.equal(latestJsonBasename(""), WORKSHOP_UNKNOWN);
});

test("feedTone and inferTone: down is mute, stale is warn, absent is mute", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  assert.equal(feedTone(true, "2026-09-04T11:59:40.000Z", now), "ok");
  assert.equal(feedTone(true, "2026-09-04T11:50:00.000Z", now), "warn");
  assert.equal(feedTone(false, "2026-09-04T11:59:40.000Z", now), "mute");
  assert.equal(inferTone("ok"), "ok");
  assert.equal(inferTone("unauthorized"), "warn");
  assert.equal(inferTone("down"), "mute");
  assert.equal(inferTone("unknown"), "mute");
});

/** A soak snapshot shaped like the collector's `job` object. Numbers are round on purpose. */
const SOAK_JOB_DOC = {
  lease: { kind: "pretrain", pid: 4242, yaml: "configs/mb64_probe_v1.yaml", startedUtc: "2026-09-02 17:47Z", pidMatch: true },
  live: { step: 84_000, tokensSeen: 2_064_384_000, trainLoss: 2.56, tokPerParam: 4.13, elapsedS: 156_000, last8TokS: 13_600, logAsOf: "2026-09-04T13:10:00.000Z" },
  durable: {
    step: 80_000, tokensSeen: 1_966_080_000, tokPerParam: 3.93, targetTokens: 2_500_000_000, targetTokPerParam: 5,
    tokensPerStep: 24_576, paramCount: 500_000_000, trainLoss: 2.61, valLoss: null, jobComplete: false, undertrainedFlag: true,
    runName: "shared_v40_v9_500m_bf16_mb64_probe_v1", savedAt: "2026-09-04T10:56:00.000Z",
  },
  fence: [{ unit: "qwen38-sglang", active: false }, { unit: "bloom-v40-500m", active: false }],
  flags: ["gpu-idle", "not-a-flag"],
  gpuName: "NVIDIA GB10",
};

test("parseJobDoc keeps what the collector says and makes the rest unknown", () => {
  const job = parseJobDoc(SOAK_JOB_DOC);
  assert.equal(job.lease.pid, 4242);
  assert.equal(job.lease.pidMatch, true);
  assert.equal(job.live.step, 84_000);
  assert.equal(job.live.last8TokS, 13_600);
  assert.equal(job.durable.step, 80_000);
  assert.equal(job.durable.valLoss, WORKSHOP_UNKNOWN);
  assert.equal(job.durable.jobComplete, false);
  assert.equal(job.durable.undertrainedFlag, true);
  assert.deepEqual(job.fence.map((f) => f.unit), ["qwen38-sglang", "bloom-v40-500m"]);
  assert.deepEqual(job.flags, ["gpu-idle"]);
  assert.equal(job.gpuName, "NVIDIA GB10");
  assert.deepEqual(parseJobDoc(undefined), unknownJob());
  assert.deepEqual(parseJobDoc("nope"), unknownJob());
});

test("deriveJob ships the widget formulas from live tokens and the last-8 rate", () => {
  const d = deriveJob(parseJobDoc(SOAK_JOB_DOC));
  assert.equal(d.tokPerParam, 4.13);
  assert.equal(d.targetTokPerParam, 5);
  assert.ok(typeof d.pct === "number" && Math.abs(d.pct - 82.575) < 0.01, `pct ${d.pct}`);
  assert.equal(d.remainTokens, 2_500_000_000 - 2_064_384_000);
  assert.ok(typeof d.hoursToFloor === "number" && Math.abs(d.hoursToFloor - 435_616_000 / 13_600 / 3600) < 1e-9);
  assert.ok(typeof d.secPerIt === "number" && Math.abs(d.secPerIt - 24_576 / 13_600) < 1e-9);
  assert.equal(d.stepsAhead, 4_000);
});

test("deriveJob never invents an ETA from the sidecar rate or a missing target", () => {
  const noRate = parseJobDoc({ ...SOAK_JOB_DOC, live: { ...SOAK_JOB_DOC.live, last8TokS: null } });
  const d1 = deriveJob(noRate);
  assert.equal(d1.hoursToFloor, WORKSHOP_UNKNOWN);
  assert.equal(d1.secPerIt, WORKSHOP_UNKNOWN);
  assert.ok(typeof d1.pct === "number", "pct still known from tokens and target");
  const noTarget = parseJobDoc({ ...SOAK_JOB_DOC, durable: { ...SOAK_JOB_DOC.durable, targetTokens: null } });
  const d2 = deriveJob(noTarget);
  assert.equal(d2.pct, WORKSHOP_UNKNOWN);
  assert.equal(d2.remainTokens, WORKSHOP_UNKNOWN);
  assert.equal(d2.hoursToFloor, WORKSHOP_UNKNOWN);
  // Live log absent: falls back to the durable save, and tpp comes from tokens / params.
  const noLive = parseJobDoc({ ...SOAK_JOB_DOC, live: undefined });
  const d3 = deriveJob(noLive);
  assert.equal(d3.tokPerParam, 1_966_080_000 / 500_000_000);
  assert.equal(d3.stepsAhead, WORKSHOP_UNKNOWN);
  assert.deepEqual(deriveJob(unknownJob()), {
    tokPerParam: WORKSHOP_UNKNOWN, targetTokPerParam: WORKSHOP_UNKNOWN, pct: WORKSHOP_UNKNOWN, remainTokens: WORKSHOP_UNKNOWN,
    hoursToFloor: WORKSHOP_UNKNOWN, secPerIt: WORKSHOP_UNKNOWN, stepsAhead: WORKSHOP_UNKNOWN,
  });
});

test("formatters: tokens, ints, hours, wall, clock", () => {
  assert.equal(fmtTokens(2_087_976_960), "2.09B");
  assert.equal(fmtTokens(411_800_000), "412M");
  assert.equal(fmtTokens(2_500_000), "2.5M");
  assert.equal(fmtTokens(24_576), "24.6K");
  assert.equal(fmtTokens(WORKSHOP_UNKNOWN), WORKSHOP_UNKNOWN);
  assert.equal(fmtInt(84_960), "84,960");
  assert.equal(fmtInt(null), WORKSHOP_UNKNOWN);
  assert.equal(fmtFixed(4.176, 2), "4.18");
  assert.equal(fmtHours(8.43), "8.4 h");
  assert.equal(fmtHours(0.4), "24 min");
  assert.equal(fmtHours(30.2), "30 h");
  assert.equal(fmtHours(-1), WORKSHOP_UNKNOWN);
  const now = Date.parse("2026-09-04T13:47:00.000Z");
  assert.equal(fmtWall("2026-09-02 17:47Z", now), "44 h");
  assert.equal(fmtWall("2026-09-04T13:20:00.000Z", now), "27 min");
  assert.equal(fmtWall("garbage", now), WORKSHOP_UNKNOWN);
  assert.equal(fmtClock("2026-09-04T10:56:00.000Z", "en-US", "America/New_York"), "06:56");
  assert.equal(fmtClock(undefined), WORKSHOP_UNKNOWN);
  assert.equal(paintJobFlag("two-trainers"), "two trainers");
  assert.equal(paintJobFlag("step-backwards"), "step back");
});

test("feedAgeLabel formats seconds/minutes from asOf", () => {
  const now = Date.parse("2026-09-04T12:00:12.000Z");
  assert.equal(feedAgeLabel("2026-09-04T12:00:00.000Z", now), "feed · 12s ago");
  assert.equal(feedAgeLabel("2026-09-04T11:55:00.000Z", now), "feed · 5m ago");
  assert.equal(feedAgeLabel(undefined, now), WORKSHOP_UNKNOWN);
  assert.equal(feedAgeLabel("not-a-date", now), WORKSHOP_UNKNOWN);
});
