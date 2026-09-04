import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKSHOP_UNKNOWN,
  paintJobStatus,
  paintModelsLine,
  paintQwenParked,
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
  assert.equal(paintModelsLine({ ...base, models: ["a", "b"] }), "a, b");
  assert.equal(
    paintModelsLine({
      ...base,
      oneWriter: true,
      exclusiveSidecar: { probeUnit: "active", qwenParked: true },
      infer: [{ path: "/v1/models", status: "down", detail: "http-502" }],
      models: WORKSHOP_UNKNOWN,
    }),
    "infer down (train exclusive)",
  );
  assert.equal(
    paintModelsLine({
      ...base,
      oneWriter: true,
      exclusiveSidecar: { probeUnit: "inactive", qwenParked: false },
      infer: [{ path: "/v1/models", status: "unauthorized" }],
      models: WORKSHOP_UNKNOWN,
    }),
    "infer down (train exclusive)",
  );
  assert.equal(paintModelsLine(null), WORKSHOP_UNKNOWN);
});

test("paintJobStatus derives from writer + feed", () => {
  const base = unknownMetrics();
  assert.equal(paintJobStatus(base, false), WORKSHOP_UNKNOWN);
  assert.equal(paintJobStatus({ ...base, oneWriter: true }, true), "running (one writer)");
  assert.equal(paintJobStatus({ ...base, oneWriter: false }, true), "not exclusive");
});
