export const LOCAL_CAPABILITY_PROTOCOL = "1.0" as const;

export const LOCAL_JOB_STATES = [
  "queued",
  "loading",
  "running",
  "validating",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type LocalJobState = (typeof LOCAL_JOB_STATES)[number];

export type LocalArtifact = {
  id: string;
  jobId: string | null;
  kind: string;
  role: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  validation: Record<string, unknown>;
  createdAt: string;
};

export type LocalRequiredOutput = {
  role: string;
  kind: string;
  mediaTypes: string[];
  required: boolean;
};

export type LocalContinuation = {
  id: string;
  capability: string;
  tool: string;
  inputBindings: Array<{ name: string; artifactId: string; sha256: string; mediaType: string }>;
  requiredOutputs: LocalRequiredOutput[];
  constraints: Record<string, unknown>;
  authorization: { mode: "explicit"; approvedByRequest: boolean };
  autoStartEligible: boolean;
  idempotencyKey: string;
};

export type LocalJobResult = {
  protocolVersion: typeof LOCAL_CAPABILITY_PROTOCOL;
  jobId: string;
  traceId: string;
  route: { visitedSystems: string[]; hopCount: number };
  artifacts: LocalArtifact[];
  continuations: LocalContinuation[];
  data: Record<string, unknown>;
};

export type LocalJob = {
  protocolVersion: typeof LOCAL_CAPABILITY_PROTOCOL;
  id: string;
  requestId: string;
  traceId: string;
  origin: string;
  idempotencyKey: string;
  capability: string;
  priority: number;
  status: LocalJobState;
  profileId: string | null;
  cancelRequested: boolean;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result?: LocalJobResult;
  error?: { code: string; message: string; retryable: boolean };
};

export type LocalJobRequest = {
  protocolVersion: typeof LOCAL_CAPABILITY_PROTOCOL;
  requestId: string;
  traceId: string;
  idempotencyKey: string;
  origin: string;
  visitedSystems: string[];
  hopCount: number;
  capability: string;
  priority: number;
  deadline?: string | null;
  inputs: Array<{ artifactId: string; role?: string; sha256?: string }>;
  requiredOutputs: LocalRequiredOutput[];
  constraints: Record<string, unknown>;
  workflow: { autoContinue: boolean; approvedCapabilities: string[]; maxContinuations: number };
  metadata: Record<string, unknown>;
};

export type LocalCapabilities = {
  protocolVersion: typeof LOCAL_CAPABILITY_PROTOCOL;
  brokerVersion: string;
  brokerId: string;
  capabilities: Array<{
    id: string;
    profileId: string;
    description: string;
    inputKinds: string[];
    outputRoles: string[];
    estimatedMemoryGb: number;
    asynchronous: true;
  }>;
  limits: { maxJsonBytes: number; maxArtifactBytes: number; maxHops: number };
};

export class LocalContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_ID = /^job_[a-f0-9]{32}$/;
const ARTIFACT_ID = /^art_[a-f0-9]{32}$/;
const CONTINUATION_ID = /^cont_[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9]*){1,7}$/;
const TOOL = /^[a-z][a-z0-9_]*(?:\.[a-z0-9][a-z0-9_]*){1,7}$/;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalContractError("invalid_type", `${field} must be an object`);
  return value as Record<string, unknown>;
}

function strict(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new LocalContractError("unknown_field", `${field} has unknown fields: ${unknown.join(", ")}`);
}

function string(value: unknown, field: string, pattern?: RegExp, max = 4096): string {
  if (typeof value !== "string" || !value || value.length > max || (pattern && !pattern.test(value))) {
    throw new LocalContractError("invalid_string", `${field} is invalid`);
  }
  return value;
}

function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new LocalContractError("invalid_number", `${field} is invalid`);
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new LocalContractError("invalid_boolean", `${field} must be boolean`);
  return value;
}

function strings(value: unknown, field: string, pattern?: RegExp, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max) throw new LocalContractError("invalid_array", `${field} is invalid`);
  return value.map((item, index) => string(item, `${field}[${index}]`, pattern, 256));
}

function jsonObject(value: unknown, field: string, maxBytes = 64 * 1024): Record<string, unknown> {
  const result = object(value, field);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maxBytes) throw new LocalContractError("too_large", `${field} is too large`);
  return result;
}

function requiredOutput(value: unknown, field: string): LocalRequiredOutput {
  const row = object(value, field);
  strict(row, ["role", "kind", "mediaTypes", "required"], field);
  const mediaTypes = strings(row.mediaTypes, `${field}.mediaTypes`, undefined, 8);
  if (!mediaTypes.length) throw new LocalContractError("invalid_output", `${field}.mediaTypes is empty`);
  return {
    role: string(row.role, `${field}.role`, ID, 64),
    kind: string(row.kind, `${field}.kind`, ID, 64),
    mediaTypes,
    required: boolean(row.required, `${field}.required`),
  };
}

export function parseLocalArtifact(value: unknown): LocalArtifact {
  const row = object(value, "artifact");
  strict(row, ["id", "jobId", "kind", "role", "mediaType", "sha256", "sizeBytes", "metadata", "validation", "createdAt"], "artifact");
  return {
    id: string(row.id, "artifact.id", ARTIFACT_ID, 36),
    jobId: row.jobId === null || row.jobId === undefined ? null : string(row.jobId, "artifact.jobId", JOB_ID, 36),
    kind: string(row.kind, "artifact.kind", ID, 64),
    role: string(row.role, "artifact.role", ID, 64),
    mediaType: string(row.mediaType, "artifact.mediaType", undefined, 128),
    sha256: string(row.sha256, "artifact.sha256", SHA256, 64),
    sizeBytes: integer(row.sizeBytes, "artifact.sizeBytes", 0, 2 ** 40),
    metadata: jsonObject(row.metadata, "artifact.metadata"),
    validation: jsonObject(row.validation, "artifact.validation"),
    createdAt: string(row.createdAt, "artifact.createdAt", undefined, 64),
  };
}

function parseContinuation(value: unknown): LocalContinuation {
  const row = object(value, "continuation");
  strict(row, ["id", "capability", "tool", "inputBindings", "requiredOutputs", "constraints", "authorization", "autoStartEligible", "idempotencyKey"], "continuation");
  if (!Array.isArray(row.inputBindings) || row.inputBindings.length > 16) throw new LocalContractError("invalid_continuation", "continuation inputBindings are invalid");
  const inputBindings = row.inputBindings.map((entry, index) => {
    const binding = object(entry, `continuation.inputBindings[${index}]`);
    strict(binding, ["name", "artifactId", "sha256", "mediaType"], `continuation.inputBindings[${index}]`);
    return {
      name: string(binding.name, "binding.name", ID, 64),
      artifactId: string(binding.artifactId, "binding.artifactId", ARTIFACT_ID, 36),
      sha256: string(binding.sha256, "binding.sha256", SHA256, 64),
      mediaType: string(binding.mediaType, "binding.mediaType", undefined, 128),
    };
  });
  if (!Array.isArray(row.requiredOutputs) || row.requiredOutputs.length > 16) throw new LocalContractError("invalid_continuation", "continuation requiredOutputs are invalid");
  const authorization = object(row.authorization, "continuation.authorization");
  strict(authorization, ["mode", "approvedByRequest"], "continuation.authorization");
  if (authorization.mode !== "explicit") throw new LocalContractError("invalid_authorization", "continuation authorization mode is not explicit");
  return {
    id: string(row.id, "continuation.id", CONTINUATION_ID, 140),
    capability: string(row.capability, "continuation.capability", CAPABILITY, 128),
    tool: string(row.tool, "continuation.tool", TOOL, 128),
    inputBindings,
    requiredOutputs: row.requiredOutputs.map((entry, index) => requiredOutput(entry, `continuation.requiredOutputs[${index}]`)),
    constraints: jsonObject(row.constraints, "continuation.constraints"),
    authorization: { mode: "explicit", approvedByRequest: boolean(authorization.approvedByRequest, "continuation.authorization.approvedByRequest") },
    autoStartEligible: boolean(row.autoStartEligible, "continuation.autoStartEligible"),
    idempotencyKey: string(row.idempotencyKey, "continuation.idempotencyKey", ID, 128),
  };
}

function parseResult(value: unknown): LocalJobResult {
  const row = object(value, "job.result");
  strict(row, ["protocolVersion", "jobId", "traceId", "route", "artifacts", "continuations", "data"], "job.result");
  if (row.protocolVersion !== LOCAL_CAPABILITY_PROTOCOL) throw new LocalContractError("unsupported_protocol", "job result protocol is unsupported");
  if (!Array.isArray(row.artifacts) || row.artifacts.length > 64) throw new LocalContractError("invalid_artifacts", "job artifacts are invalid");
  if (!Array.isArray(row.continuations) || row.continuations.length > 16) throw new LocalContractError("invalid_continuations", "job continuations are invalid");
  const route = object(row.route, "job.result.route");
  strict(route, ["visitedSystems", "hopCount"], "job.result.route");
  const visitedSystems = strings(route.visitedSystems, "job.result.route.visitedSystems", ID, 8);
  const hopCount = integer(route.hopCount, "job.result.route.hopCount", 1, 8);
  if (hopCount !== visitedSystems.length || new Set(visitedSystems).size !== visitedSystems.length) throw new LocalContractError("route_cycle", "job result route is invalid");
  return {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    jobId: string(row.jobId, "job.result.jobId", JOB_ID, 36),
    traceId: string(row.traceId, "job.result.traceId", ID, 128),
    route: { visitedSystems, hopCount },
    artifacts: row.artifacts.map(parseLocalArtifact),
    continuations: row.continuations.map(parseContinuation),
    data: jsonObject(row.data, "job.result.data"),
  };
}

export function parseLocalJob(value: unknown): LocalJob {
  const row = object(value, "job");
  strict(row, ["protocolVersion", "id", "requestId", "traceId", "origin", "idempotencyKey", "capability", "priority", "status", "profileId", "cancelRequested", "attempt", "createdAt", "updatedAt", "startedAt", "finishedAt", "result", "error", "links"], "job");
  if (row.protocolVersion !== LOCAL_CAPABILITY_PROTOCOL) throw new LocalContractError("unsupported_protocol", "job protocol is unsupported");
  if (!LOCAL_JOB_STATES.includes(row.status as LocalJobState)) throw new LocalContractError("invalid_status", "job status is invalid");
  const job: LocalJob = {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    id: string(row.id, "job.id", JOB_ID, 36),
    requestId: string(row.requestId, "job.requestId", ID, 128),
    traceId: string(row.traceId, "job.traceId", ID, 128),
    origin: string(row.origin, "job.origin", ID, 128),
    idempotencyKey: string(row.idempotencyKey, "job.idempotencyKey", ID, 128),
    capability: string(row.capability, "job.capability", CAPABILITY, 128),
    priority: integer(row.priority, "job.priority", 0, 100),
    status: row.status as LocalJobState,
    profileId: row.profileId === null || row.profileId === undefined ? null : string(row.profileId, "job.profileId", ID, 128),
    cancelRequested: boolean(row.cancelRequested, "job.cancelRequested"),
    attempt: integer(row.attempt, "job.attempt", 0, 100),
    createdAt: string(row.createdAt, "job.createdAt", undefined, 64),
    updatedAt: string(row.updatedAt, "job.updatedAt", undefined, 64),
    startedAt: row.startedAt === null || row.startedAt === undefined ? null : string(row.startedAt, "job.startedAt", undefined, 64),
    finishedAt: row.finishedAt === null || row.finishedAt === undefined ? null : string(row.finishedAt, "job.finishedAt", undefined, 64),
  };
  if (row.result !== undefined) job.result = parseResult(row.result);
  if (row.error !== undefined) {
    const error = object(row.error, "job.error");
    strict(error, ["code", "message", "retryable", "field"], "job.error");
    job.error = { code: string(error.code, "job.error.code", ID, 128), message: string(error.message, "job.error.message", undefined, 4096), retryable: boolean(error.retryable, "job.error.retryable") };
  }
  if (job.status === "completed" && !job.result) throw new LocalContractError("missing_result", "completed job has no result");
  if (job.result && (job.result.jobId !== job.id || job.result.traceId !== job.traceId)) throw new LocalContractError("stale_completion", "job result identity does not match the job");
  return job;
}

export function parseLocalCapabilities(value: unknown): LocalCapabilities {
  const row = object(value, "capabilities");
  strict(row, ["protocolVersion", "brokerVersion", "brokerId", "capabilities", "limits"], "capabilities");
  if (row.protocolVersion !== LOCAL_CAPABILITY_PROTOCOL) throw new LocalContractError("unsupported_protocol", "capability protocol is unsupported");
  if (!Array.isArray(row.capabilities) || row.capabilities.length > 128) throw new LocalContractError("invalid_capabilities", "capability list is invalid");
  const capabilities = row.capabilities.map((value, index) => {
    const item = object(value, `capabilities[${index}]`);
    strict(item, ["id", "profileId", "description", "inputKinds", "outputRoles", "estimatedMemoryGb", "asynchronous"], `capabilities[${index}]`);
    if (item.asynchronous !== true) throw new LocalContractError("invalid_capability", "local capabilities must be asynchronous");
    return {
      id: string(item.id, "capability.id", CAPABILITY, 128),
      profileId: string(item.profileId, "capability.profileId", ID, 128),
      description: string(item.description, "capability.description", undefined, 1024),
      inputKinds: strings(item.inputKinds, "capability.inputKinds", ID),
      outputRoles: strings(item.outputRoles, "capability.outputRoles", ID),
      estimatedMemoryGb: integer(item.estimatedMemoryGb, "capability.estimatedMemoryGb", 0, 1024),
      asynchronous: true as const,
    };
  });
  const limits = object(row.limits, "capabilities.limits");
  strict(limits, ["maxJsonBytes", "maxArtifactBytes", "maxHops"], "capabilities.limits");
  return {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    brokerVersion: string(row.brokerVersion, "capabilities.brokerVersion", undefined, 64),
    brokerId: string(row.brokerId, "capabilities.brokerId", ID, 128),
    capabilities,
    limits: {
      maxJsonBytes: integer(limits.maxJsonBytes, "limits.maxJsonBytes", 1, 64 * 1024 * 1024),
      maxArtifactBytes: integer(limits.maxArtifactBytes, "limits.maxArtifactBytes", 1, 2 ** 40),
      maxHops: integer(limits.maxHops, "limits.maxHops", 1, 32),
    },
  };
}

export function parseLocalJobRequest(value: unknown): LocalJobRequest {
  const row = object(value, "request");
  strict(row, ["protocolVersion", "requestId", "traceId", "idempotencyKey", "origin", "visitedSystems", "hopCount", "capability", "priority", "deadline", "inputs", "requiredOutputs", "constraints", "workflow", "metadata"], "request");
  if (row.protocolVersion !== LOCAL_CAPABILITY_PROTOCOL) throw new LocalContractError("unsupported_protocol", "request protocol is unsupported");
  const visitedSystems = strings(row.visitedSystems, "request.visitedSystems", ID, 8);
  const hopCount = integer(row.hopCount, "request.hopCount", 0, 7);
  if (hopCount !== visitedSystems.length || new Set(visitedSystems).size !== visitedSystems.length) throw new LocalContractError("route_cycle", "request route is invalid");
  if (!Array.isArray(row.inputs) || row.inputs.length > 32) throw new LocalContractError("invalid_inputs", "request inputs are invalid");
  const inputs = row.inputs.map((value, index) => {
    const input = object(value, `request.inputs[${index}]`);
    strict(input, ["artifactId", "role", "sha256"], `request.inputs[${index}]`);
    return {
      artifactId: string(input.artifactId, "input.artifactId", ARTIFACT_ID, 36),
      ...(input.role === undefined ? {} : { role: string(input.role, "input.role", ID, 64) }),
      ...(input.sha256 === undefined ? {} : { sha256: string(input.sha256, "input.sha256", SHA256, 64) }),
    };
  });
  if (!Array.isArray(row.requiredOutputs) || row.requiredOutputs.length > 32) throw new LocalContractError("invalid_outputs", "request outputs are invalid");
  const workflow = object(row.workflow, "request.workflow");
  strict(workflow, ["autoContinue", "approvedCapabilities", "maxContinuations"], "request.workflow");
  return {
    protocolVersion: LOCAL_CAPABILITY_PROTOCOL,
    requestId: string(row.requestId, "request.requestId", ID, 128),
    traceId: string(row.traceId, "request.traceId", ID, 128),
    idempotencyKey: string(row.idempotencyKey, "request.idempotencyKey", ID, 128),
    origin: string(row.origin, "request.origin", ID, 128),
    visitedSystems,
    hopCount,
    capability: string(row.capability, "request.capability", CAPABILITY, 128),
    priority: integer(row.priority, "request.priority", 0, 100),
    deadline: row.deadline === null || row.deadline === undefined ? null : string(row.deadline, "request.deadline", undefined, 64),
    inputs,
    requiredOutputs: row.requiredOutputs.map((value, index) => requiredOutput(value, `request.requiredOutputs[${index}]`)),
    constraints: jsonObject(row.constraints, "request.constraints"),
    workflow: {
      autoContinue: boolean(workflow.autoContinue, "request.workflow.autoContinue"),
      approvedCapabilities: strings(workflow.approvedCapabilities, "request.workflow.approvedCapabilities", CAPABILITY, 16),
      maxContinuations: integer(workflow.maxContinuations, "request.workflow.maxContinuations", 0, 16),
    },
    metadata: jsonObject(row.metadata, "request.metadata"),
  };
}
