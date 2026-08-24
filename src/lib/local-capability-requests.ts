import { LOCAL_CAPABILITY_PROTOCOL, parseLocalJobRequest, type LocalArtifact, type LocalJobRequest } from "./local-capability-contract";

export type LocalRequestIdentity = {
  requestId: string;
  traceId: string;
  idempotencyKey: string;
};

function envelope(identity: LocalRequestIdentity, capability: string): LocalJobRequest {
  return {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    requestId: identity.requestId,
    traceId: identity.traceId,
    idempotencyKey: identity.idempotencyKey,
    origin: "workhorse",
    visitedSystems: ["workhorse"],
    hopCount: 1,
    capability,
    priority: 50,
    deadline: null,
    inputs: [],
    requiredOutputs: [],
    constraints: {},
    workflow: { autoContinue: false, approvedCapabilities: [], maxContinuations: 0 },
    metadata: { submittedBy: "workhorse-link" },
  };
}

function input(artifact: LocalArtifact, role: string) {
  return { artifactId: artifact.id, role, sha256: artifact.sha256 };
}

export function buildLocalChatRequest(
  identity: LocalRequestIdentity,
  prompt: LocalArtifact,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number; enableThinking?: boolean } = {},
): LocalJobRequest {
  if (prompt.mediaType !== "text/plain") throw new Error("chat prompt artifact must be text/plain");
  const request = envelope(identity, "text.chat.generate");
  request.inputs = [input(prompt, "prompt")];
  request.requiredOutputs = [
    { role: "text_output", kind: "text", mediaTypes: ["text/plain"], required: true },
    { role: "provider_response", kind: "report", mediaTypes: ["application/json"], required: true },
  ];
  request.constraints = {
    temperature: options.temperature ?? 0.2,
    maxTokens: options.maxTokens ?? 1024,
    systemPrompt: options.systemPrompt ?? "",
    timeoutSeconds: 600,
    enableThinking: options.enableThinking ?? false,
  };
  return parseLocalJobRequest(request);
}

export function buildLocal3dRequest(
  identity: LocalRequestIdentity,
  sourceImage: LocalArtifact,
  options: {
    mode?: "shape" | "pbr";
    priority?: number;
    seed?: number;
    maxFaces?: number;
    targetEngine?: "generic" | "blender" | "godot" | "unity" | "unreal";
    requireWatertight?: boolean;
    authorizeBlenderContinuation?: boolean;
  } = {},
): LocalJobRequest {
  if (!sourceImage.mediaType.startsWith("image/")) throw new Error("3D generation source artifact must be an image");
  const request = envelope(identity, "asset.3d.generate");
  const mode = options.mode ?? "shape";
  const approved = options.authorizeBlenderContinuation === true;
  request.priority = options.priority ?? 50;
  request.inputs = [input(sourceImage, "source_image")];
  request.requiredOutputs = [
    { role: "shape_model", kind: "model3d", mediaTypes: ["model/gltf-binary"], required: true },
    { role: "mesh_report", kind: "report", mediaTypes: ["application/json"], required: true },
    ...(mode === "pbr" ? [{ role: "pbr_model", kind: "model3d", mediaTypes: ["model/gltf-binary"], required: true as const }] : []),
  ];
  request.constraints = {
    mode,
    seed: options.seed ?? 42,
    maxFaces: options.maxFaces ?? 1_000_000,
    targetEngine: options.targetEngine ?? "godot",
    requireWatertight: options.requireWatertight ?? false,
  };
  request.workflow = {
    autoContinue: false,
    approvedCapabilities: approved ? ["asset.3d.prepare.blender"] : [],
    maxContinuations: approved ? 1 : 0,
  };
  return parseLocalJobRequest(request);
}

