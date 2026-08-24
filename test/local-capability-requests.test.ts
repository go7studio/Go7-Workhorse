import assert from "node:assert/strict";
import { test } from "node:test";
import type { LocalArtifact } from "../src/lib/local-capability-contract";
import { buildLocal3dRequest, buildLocalChatRequest } from "../src/lib/local-capability-requests";

const identity = { requestId: "req_builder_1", traceId: "trace_builder_1", idempotencyKey: "idem_builder_1" };
const artifact = (mediaType: string): LocalArtifact => ({
  id: `art_${"a".repeat(32)}`,
  jobId: null,
  kind: mediaType.startsWith("image/") ? "image" : "text",
  role: "input",
  mediaType,
  sha256: "b".repeat(64),
  sizeBytes: 12,
  metadata: {},
  validation: {},
  createdAt: "2026-08-23T12:00:00Z",
});

test("chat builder binds a verified prompt and defaults thinking off", () => {
  const request = buildLocalChatRequest(identity, artifact("text/plain"), { maxTokens: 64 });
  assert.equal(request.capability, "text.chat.generate");
  assert.deepEqual(request.visitedSystems, ["workhorse"]);
  assert.equal(request.hopCount, 1);
  assert.equal(request.inputs[0]?.sha256, "b".repeat(64));
  assert.equal(request.constraints.enableThinking, false);
  assert.equal(request.constraints.maxTokens, 64);
});

test("3D builder is image-to-3D and authorizes but never silently runs Blender", () => {
  const request = buildLocal3dRequest(identity, artifact("image/png"), { mode: "pbr", authorizeBlenderContinuation: true, maxFaces: 100000 });
  assert.equal(request.capability, "asset.3d.generate");
  assert.equal(request.requiredOutputs.length, 3);
  assert.deepEqual(request.workflow, { autoContinue: false, approvedCapabilities: ["asset.3d.prepare.blender"], maxContinuations: 1 });
  assert.equal(request.constraints.maxFaces, 100000);
  assert.throws(() => buildLocal3dRequest(identity, artifact("text/plain")), /must be an image/);
});
