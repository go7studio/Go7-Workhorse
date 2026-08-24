import {
  LOCAL_CAPABILITY_PROTOCOL,
  parseLocalJobRequest,
  type LocalArtifact,
  type LocalJobRequest,
  type LocalRequiredOutput,
} from "./local-capability-contract";

export type LocalRequestIdentity = {
  requestId: string;
  traceId: string;
  idempotencyKey: string;
};

export type LocalCapabilityInvocation = {
  capability: string;
  inputs?: Array<{ artifact: LocalArtifact; role?: string }>;
  requiredOutputs?: LocalRequiredOutput[];
  constraints?: Record<string, unknown>;
  workflow?: Partial<LocalJobRequest["workflow"]>;
  metadata?: Record<string, unknown>;
  priority?: number;
  deadline?: string | null;
};

/**
 * One generic request path serves every advertised host capability. Product
 * code does not infer model families or output contracts: the caller selects
 * a live descriptor and supplies its typed artifact/output bindings. Named
 * compatibility helpers below only fill this structure for older clients.
 */
export function buildLocalCapabilityRequest(
  identity: LocalRequestIdentity,
  invocation: LocalCapabilityInvocation,
): LocalJobRequest {
  const workflow = invocation.workflow ?? {};
  return parseLocalJobRequest({
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    requestId: identity.requestId,
    traceId: identity.traceId,
    idempotencyKey: identity.idempotencyKey,
    origin: "workhorse",
    visitedSystems: ["workhorse"],
    hopCount: 1,
    capability: invocation.capability,
    priority: invocation.priority ?? 50,
    deadline: invocation.deadline ?? null,
    inputs: (invocation.inputs ?? []).map(({ artifact, role }) => input(artifact, role)),
    requiredOutputs: invocation.requiredOutputs ?? [],
    constraints: invocation.constraints ?? {},
    workflow: {
      autoContinue: workflow.autoContinue ?? false,
      approvedCapabilities: workflow.approvedCapabilities ?? [],
      maxContinuations: workflow.maxContinuations ?? 0,
    },
    metadata: { submittedBy: "workhorse-link", ...(invocation.metadata ?? {}) },
  });
}

function input(artifact: LocalArtifact, role?: string) {
  return { artifactId: artifact.id, ...(role ? { role } : {}), sha256: artifact.sha256 };
}

export function buildLocalChatRequest(
  identity: LocalRequestIdentity,
  prompt: LocalArtifact,
  options: { systemPrompt?: string; maxTokens?: number; temperature?: number; enableThinking?: boolean } = {},
): LocalJobRequest {
  if (prompt.mediaType !== "text/plain") throw new Error("chat prompt artifact must be text/plain");
  return buildLocalCapabilityRequest(identity, {
    capability: "text.chat.generate",
    inputs: [{ artifact: prompt, role: "prompt" }],
    requiredOutputs: [
      { role: "text_output", kind: "text", mediaTypes: ["text/plain"], required: true },
      { role: "provider_response", kind: "report", mediaTypes: ["application/json"], required: true },
    ],
    constraints: {
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 1024,
      systemPrompt: options.systemPrompt ?? "",
      timeoutSeconds: 600,
      enableThinking: options.enableThinking ?? false,
    },
  });
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
  const mode = options.mode ?? "shape";
  const approved = options.authorizeBlenderContinuation === true;
  return buildLocalCapabilityRequest(identity, {
    capability: "asset.3d.generate",
    priority: options.priority,
    inputs: [{ artifact: sourceImage, role: "source_image" }],
    requiredOutputs: [
      { role: "shape_model", kind: "model3d", mediaTypes: ["model/gltf-binary"], required: true },
      { role: "mesh_report", kind: "report", mediaTypes: ["application/json"], required: true },
      ...(mode === "pbr" ? [{ role: "pbr_model", kind: "model3d", mediaTypes: ["model/gltf-binary"], required: true as const }] : []),
    ],
    constraints: {
      mode,
      seed: options.seed ?? 42,
      maxFaces: options.maxFaces ?? 1_000_000,
      targetEngine: options.targetEngine ?? "godot",
      requireWatertight: options.requireWatertight ?? false,
    },
    workflow: {
      autoContinue: false,
      approvedCapabilities: approved ? ["asset.3d.prepare.blender"] : [],
      maxContinuations: approved ? 1 : 0,
    },
  });
}
