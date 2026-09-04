import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSHOP_UNKNOWN,
  feedAgeLabel,
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

test("feedAgeLabel formats seconds/minutes from asOf", () => {
  const now = Date.parse("2026-09-04T12:00:12.000Z");
  assert.equal(feedAgeLabel("2026-09-04T12:00:00.000Z", now), "feed · 12s ago");
  assert.equal(feedAgeLabel("2026-09-04T11:55:00.000Z", now), "feed · 5m ago");
  assert.equal(feedAgeLabel(undefined, now), WORKSHOP_UNKNOWN);
  assert.equal(feedAgeLabel("not-a-date", now), WORKSHOP_UNKNOWN);
});
