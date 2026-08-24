import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_CAPABILITY_PROTOCOL,
  LocalContractError,
  parseLocalCapabilities,
  parseLocalJob,
  parseLocalJobRequest,
  validateLocalCapabilityInvocation,
  validateLocalConstraints,
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
  assert.throws(
    () => parseLocalJobRequest({ ...request(), requiredOutputs: [request().requiredOutputs[0], request().requiredOutputs[0]] }),
    (error: unknown) => error instanceof LocalContractError && error.code === "invalid_outputs",
  );
});

test("capability discovery rejects ambiguous duplicate ids and output roles", () => {
  const descriptor = {
    id: "image.generate",
    profileId: "gpu.image",
    description: "Generate an image",
    inputKinds: ["text"],
    outputRoles: ["image"],
    estimatedMemoryGb: 16,
    asynchronous: true,
  };
  const manifest = {
    protocolVersion: "1.0",
    brokerVersion: "1.0.0",
    brokerId: "host.test",
    capabilities: [descriptor, descriptor],
    limits: { maxJsonBytes: 1024, maxArtifactBytes: 2048, maxHops: 8 },
  };
  assert.throws(() => parseLocalCapabilities(manifest), /ids must be unique/);
  assert.throws(
    () => parseLocalCapabilities({ ...manifest, capabilities: [{ ...descriptor, outputRoles: ["image", "image"] }] }),
    /output roles must be unique/,
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
  const legacy = parseLocalCapabilities(value).capabilities[0];
  assert.equal(legacy?.profileId, "gpu.qwen3.8");
  assert.equal(legacy?.invocation, undefined, "summary-only 1.0 descriptors remain parseable but are not generically callable");
  assert.equal(legacy?.continuations, undefined, "legacy descriptors do not imply a continuation");
  assert.throws(() => parseLocalCapabilities({ ...value, capabilities: [{ ...value.capabilities[0], asynchronous: false }] }), LocalContractError);
});

function typedManifest() {
  return {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    brokerVersion: "1.1.0",
    brokerId: "runtime.test",
    capabilities: [{
      id: "image.upscale",
      profileId: "gpu.upscale",
      description: "Upscale one image",
      inputKinds: ["image"],
      outputRoles: ["image", "report"],
      invocation: {
        inputs: [{ role: "source", kind: "image", mediaTypes: ["image/png", "image/jpeg"], required: true, minItems: 1, maxItems: 1 }],
        outputs: [
          { role: "image", kind: "image", mediaTypes: ["image/png"], required: true },
          { role: "report", kind: "report", mediaTypes: ["application/json"], required: false },
        ],
        constraintsSchema: {
          type: "object",
          properties: {
            scale: { type: "integer", description: "Integer scale factor", enum: [2, 4], default: 2, minimum: 2, maximum: 4 },
            sharpen: { type: "boolean", default: false },
          },
          required: ["scale"],
          additionalProperties: false,
        },
      },
      continuations: [{
        capability: "image.review",
        tool: "image.review_asset",
        outputs: [{ role: "review", kind: "report", mediaTypes: ["application/json"], required: true }],
        constraintsSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      }],
      estimatedMemoryGb: 12,
      asynchronous: true,
    }],
    limits: { maxJsonBytes: 1048576, maxArtifactBytes: 1073741824, maxHops: 8 },
  };
}

test("capability discovery parses an exact generic invocation and continuation contract", () => {
  const descriptor = parseLocalCapabilities(typedManifest()).capabilities[0]!;
  assert.deepEqual(descriptor.invocation?.inputs[0], {
    role: "source",
    kind: "image",
    mediaTypes: ["image/png", "image/jpeg"],
    required: true,
    minItems: 1,
    maxItems: 1,
  });
  assert.deepEqual(descriptor.invocation?.constraintsSchema.required, ["scale"]);
  assert.equal(descriptor.continuations?.[0]?.tool, "image.review_asset");
});

test("typed capability descriptors reject ambiguity and inconsistent summaries", () => {
  const duplicateInputs = typedManifest();
  duplicateInputs.capabilities[0]!.invocation.inputs.push({ ...duplicateInputs.capabilities[0]!.invocation.inputs[0]! });
  assert.throws(() => parseLocalCapabilities(duplicateInputs), /input roles must be unique/);

  const badCardinality = typedManifest();
  badCardinality.capabilities[0]!.invocation.inputs[0]!.required = false;
  assert.throws(() => parseLocalCapabilities(badCardinality), /required\/cardinality is inconsistent/);

  const duplicateMedia = typedManifest();
  duplicateMedia.capabilities[0]!.invocation.outputs[0]!.mediaTypes = ["image/png", "image/png"];
  assert.throws(() => parseLocalCapabilities(duplicateMedia), /mediaTypes must be unique/);

  const mismatchedSummary = typedManifest();
  mismatchedSummary.capabilities[0]!.outputRoles = ["image"];
  assert.throws(() => parseLocalCapabilities(mismatchedSummary), /summary does not match/);

  const duplicateContinuations = typedManifest();
  duplicateContinuations.capabilities[0]!.continuations.push(structuredClone(duplicateContinuations.capabilities[0]!.continuations[0]!));
  assert.throws(() => parseLocalCapabilities(duplicateContinuations), /continuation identities must be unique/);
});

test("constraint schemas are closed, bounded, and reject malformed schema entries", () => {
  const missingProperty = typedManifest();
  missingProperty.capabilities[0]!.invocation.constraintsSchema.required = ["missing"];
  assert.throws(() => parseLocalCapabilities(missingProperty), /required must contain unique property names/);

  const openObject = typedManifest();
  openObject.capabilities[0]!.invocation.constraintsSchema.additionalProperties = true;
  assert.throws(() => parseLocalCapabilities(openObject), /additionalProperties must be false/);

  const invalidDefault = typedManifest();
  invalidDefault.capabilities[0]!.invocation.constraintsSchema.properties.scale.default = 3;
  assert.throws(() => parseLocalCapabilities(invalidDefault), /default is invalid/);

  const outOfBoundsDefault = typedManifest();
  const scale = outOfBoundsDefault.capabilities[0]!.invocation.constraintsSchema.properties.scale as { enum?: number[]; default: number };
  delete scale.enum;
  scale.default = 5;
  assert.throws(() => parseLocalCapabilities(outOfBoundsDefault), /above its maximum/);

  const descriptor = parseLocalCapabilities(typedManifest()).capabilities[0]!;
  assert.doesNotThrow(() => validateLocalConstraints(descriptor.invocation!.constraintsSchema, { scale: 4, sharpen: true }));
  assert.throws(() => validateLocalConstraints(descriptor.invocation!.constraintsSchema, { scale: 3 }), /not an allowed value/);
  assert.throws(() => validateLocalConstraints(descriptor.invocation!.constraintsSchema, { scale: 2, surprise: true }), /unknown fields/);
});

test("generic invocation validation enforces typed inputs, outputs, and constraints", () => {
  const descriptor = parseLocalCapabilities(typedManifest()).capabilities[0]!;
  const valid = {
    inputs: [{ role: "source", kind: "image", mediaType: "image/jpeg" }],
    requiredOutputs: [{ role: "image", kind: "image", mediaTypes: ["image/png"], required: true }],
    constraints: { scale: 2 },
  };
  assert.doesNotThrow(() => validateLocalCapabilityInvocation(descriptor, valid));
  assert.throws(() => validateLocalCapabilityInvocation(descriptor, { ...valid, inputs: [] }), /requires 1-1 artifact/);
  assert.throws(
    () => validateLocalCapabilityInvocation(descriptor, { ...valid, inputs: [{ role: "source", kind: "image", mediaType: "image/gif" }] }),
    /does not match the source contract/,
  );
  assert.throws(() => validateLocalCapabilityInvocation(descriptor, { ...valid, requiredOutputs: [] }), /required output role image is missing/);

  const legacy = parseLocalCapabilities({ ...typedManifest(), capabilities: [{
    ...typedManifest().capabilities[0]!,
    invocation: undefined,
    continuations: undefined,
  }] }).capabilities[0]!;
  assert.throws(() => validateLocalCapabilityInvocation(legacy, valid), (error: unknown) =>
    error instanceof LocalContractError && error.code === "invocation_contract_unavailable");
});
