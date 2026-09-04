import assert from "node:assert/strict";
import test from "node:test";
import { WORKSHOP_UNKNOWN, unknownMetrics, type WorkshopMetricsSnapshot } from "../src/lib/workshop";
import { mergePortsInto, mergeSidecarInto } from "../src/ui/workshop-live";

test("mergeSidecarInto never clobbers GPU/watts/writer", () => {
  const current: WorkshopMetricsSnapshot = {
    ...unknownMetrics(),
    gpuUtilPercent: 41,
    powerWatts: 220,
    oneWriter: true,
  };
  const side: WorkshopMetricsSnapshot = {
    ...unknownMetrics(),
    exclusiveSidecar: { probeUnit: "active", qwenParked: true },
    latestJson: "latest.json",
  };
  const merged = mergeSidecarInto(current, side);
  assert.equal(merged.gpuUtilPercent, 41);
  assert.equal(merged.powerWatts, 220);
  assert.equal(merged.oneWriter, true);
  assert.equal(merged.exclusiveSidecar.probeUnit, "active");
  assert.equal(merged.latestJson, "latest.json");
});

test("mergePortsInto keeps box meters and adopts models/infer/empty-caps", () => {
  const current: WorkshopMetricsSnapshot = {
    ...unknownMetrics(),
    gpuUtilPercent: 10,
    models: WORKSHOP_UNKNOWN,
    infer: [],
  };
  const ports: WorkshopMetricsSnapshot = {
    ...unknownMetrics(),
    models: ["qwen3.8-27b"],
    infer: [{ path: "/healthz", status: "ok" }],
    localComputeEmptyCapabilities: true,
  };
  const merged = mergePortsInto(current, ports);
  assert.equal(merged.gpuUtilPercent, 10);
  assert.deepEqual(merged.models, ["qwen3.8-27b"]);
  assert.equal(merged.infer[0]?.status, "ok");
  assert.equal(merged.localComputeEmptyCapabilities, true);
});
