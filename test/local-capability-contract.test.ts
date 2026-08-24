import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_CAPABILITY_PROTOCOL,
  LocalContractError,
  parseLocalCapabilities,
  parseLocalJob,
  parseLocalJobRequest,
} from "../src/lib/local-capability-contract";

const hex = (char: string) => char.repeat(32);
const sha = (char: string) => char.repeat(64);

function request() {
  return {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    requestId: "req_contract_1",
    traceId: "trace_contract_1",
    idempotencyKey: "idem_contract_1",
    origin: "workhorse",
    visitedSystems: ["workhorse"],
    hopCount: 1,
    capability: "asset.3d.generate",
    priority: 50,
    deadline: null,
    inputs: [],
    requiredOutputs: [{ role: "game_model", kind: "model", mediaTypes: ["model/gltf-binary"], required: true }],
    constraints: { targetFaces: 100000 },
    workflow: { autoContinue: false, approvedCapabilities: ["blender.asset.prepare"], maxContinuations: 1 },
    metadata: { prompt: "A low-poly sign" },
  };
}

function completedJob() {
  const id = `job_${hex("a")}`;
  const traceId = "trace_contract_1";
  return {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    id,
    requestId: "req_contract_1",
    traceId,
    origin: "workhorse",
    idempotencyKey: "idem_contract_1",
    capability: "asset.3d.generate",
    priority: 50,
    status: "completed",
    profileId: "gpu.hunyuan3d",
    cancelRequested: false,
    attempt: 1,
    createdAt: "2026-08-23T12:00:00Z",
    updatedAt: "2026-08-23T12:01:00Z",
    startedAt: "2026-08-23T12:00:01Z",
    finishedAt: "2026-08-23T12:01:00Z",
    result: {
      protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
      jobId: id,
      traceId,
      route: { visitedSystems: ["workhorse", "dgx-spark"], hopCount: 2 },
      artifacts: [{
        id: `art_${hex("b")}`,
        jobId: id,
        kind: "model",
        role: "generated_model",
        mediaType: "model/gltf-binary",
        sha256: sha("c"),
        sizeBytes: 1234,
        metadata: { filename: "shape.glb" },
        validation: { valid: true },
        createdAt: "2026-08-23T12:01:00Z",
      }],
      continuations: [{
        id: "cont_contract_1",
        capability: "asset.3d.prepare",
        tool: "blender.asset.prepare",
        inputBindings: [{ name: "source", artifactId: `art_${hex("b")}`, sha256: sha("c"), mediaType: "model/gltf-binary" }],
        requiredOutputs: [{ role: "game_model", kind: "model", mediaTypes: ["model/gltf-binary"], required: true }],
        constraints: { targetFaces: 100000 },
        authorization: { mode: "explicit", approvedByRequest: true },
        autoStartEligible: false,
        idempotencyKey: "cont_contract_1",
      }],
      data: { profileId: "gpu.hunyuan3d" },
    },
    links: {},
  };
}

test("local capability request parser rejects unknown fields and route cycles", () => {
  assert.equal(parseLocalJobRequest(request()).capability, "asset.3d.generate");
  assert.throws(() => parseLocalJobRequest({ ...request(), surprise: true }), (error: unknown) => error instanceof LocalContractError && error.code === "unknown_field");
  assert.throws(
    () => parseLocalJobRequest({ ...request(), visitedSystems: ["workhorse", "workhorse"], hopCount: 2 }),
    (error: unknown) => error instanceof LocalContractError && error.code === "route_cycle",
  );
});

test("local job parser verifies result identity, routes, artifacts, and continuations", () => {
  const parsed = parseLocalJob(completedJob());
  assert.equal(parsed.result?.artifacts[0]?.mediaType, "model/gltf-binary");
  assert.equal(parsed.result?.continuations[0]?.authorization.approvedByRequest, true);
  const stale = completedJob();
  stale.result.jobId = `job_${hex("d")}`;
  assert.throws(() => parseLocalJob(stale), (error: unknown) => error instanceof LocalContractError && error.code === "stale_completion");
});

test("local capabilities parser is strict and only accepts asynchronous profiles", () => {
  const value = {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    brokerVersion: "0.1.0",
    brokerId: "dgx-spark",
    capabilities: [{
      id: "text.chat.generate",
      profileId: "gpu.qwen3.8",
      description: "Qwen text generation",
      inputKinds: ["text"],
      outputRoles: ["response"],
      estimatedMemoryGb: 48,
      asynchronous: true,
    }],
    limits: { maxJsonBytes: 1048576, maxArtifactBytes: 1073741824, maxHops: 8 },
  };
  assert.equal(parseLocalCapabilities(value).capabilities[0]?.profileId, "gpu.qwen3.8");
  assert.throws(() => parseLocalCapabilities({ ...value, capabilities: [{ ...value.capabilities[0], asynchronous: false }] }), LocalContractError);
});
