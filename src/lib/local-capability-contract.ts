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

export type LocalCapabilityInputContract = {
  role: string;
  kind: string;
  mediaTypes: string[];
  required: boolean;
  minItems: number;
  maxItems: number;
};

/**
 * A deliberately small, strict JSON-Schema-like vocabulary for capability
 * constraints. It supports harness form/tool construction without executable
 * references or open-ended object properties.
 */
export type LocalConstraintSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, LocalConstraintSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: LocalConstraintSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  enum?: Array<string | number | boolean>;
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

export type LocalCapabilityInvocationContract = {
  inputs: LocalCapabilityInputContract[];
  outputs: LocalRequiredOutput[];
  constraintsSchema: LocalConstraintSchema;
};

export type LocalCapabilityContinuationContract = {
  capability: string;
  tool: string;
  outputs: LocalRequiredOutput[];
  constraintsSchema: LocalConstraintSchema;
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
    /** Missing means a legacy summary and is not safe for generic invocation. */
    invocation?: LocalCapabilityInvocationContract;
    /** Missing or empty means this capability has no discoverable continuation. */
    continuations?: LocalCapabilityContinuationContract[];
    estimatedMemoryGb: number;
    asynchronous: true;
  }>;
  limits: { maxJsonBytes: number; maxArtifactBytes: number; maxHops: number };
};

export type LocalCapabilityDescriptor = LocalCapabilities["capabilities"][number];

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
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/(?:[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*|\*)$/;

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

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new LocalContractError("invalid_number", `${field} is invalid`);
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
  if (new Set(mediaTypes).size !== mediaTypes.length || mediaTypes.some((mediaType) => !MEDIA_TYPE.test(mediaType))) {
    throw new LocalContractError("invalid_output", `${field}.mediaTypes must be unique valid media types`);
  }
  return {
    role: string(row.role, `${field}.role`, ID, 64),
    kind: string(row.kind, `${field}.kind`, ID, 64),
    mediaTypes,
    required: boolean(row.required, `${field}.required`),
  };
}

function scalarMatches(value: unknown, type: LocalConstraintSchema["type"]): value is string | number | boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function optionalDescription(row: Record<string, unknown>, field: string): Pick<LocalConstraintSchema, "description"> {
  return row.description === undefined ? {} : { description: string(row.description, `${field}.description`, undefined, 1024) };
}

function parseConstraintSchema(value: unknown, field: string, depth = 0): LocalConstraintSchema {
  if (depth > 4) throw new LocalContractError("invalid_schema", `${field} is nested too deeply`);
  const row = object(value, field);
  const type = row.type;
  if (type !== "object" && type !== "array" && type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
    throw new LocalContractError("invalid_schema", `${field}.type is invalid`);
  }
  const description = optionalDescription(row, field);
  if (type === "object") {
    strict(row, ["type", "description", "properties", "required", "additionalProperties"], field);
    const rawProperties = object(row.properties, `${field}.properties`);
    const entries = Object.entries(rawProperties);
    if (entries.length > 64) throw new LocalContractError("invalid_schema", `${field}.properties has too many entries`);
    const properties: Record<string, LocalConstraintSchema> = {};
    for (const [name, schema] of entries) {
      string(name, `${field}.properties key`, ID, 64);
      properties[name] = parseConstraintSchema(schema, `${field}.properties.${name}`, depth + 1);
    }
    const required = strings(row.required, `${field}.required`, ID, 64);
    if (new Set(required).size !== required.length || required.some((name) => !Object.prototype.hasOwnProperty.call(properties, name))) {
      throw new LocalContractError("invalid_schema", `${field}.required must contain unique property names`);
    }
    if (row.additionalProperties !== false) throw new LocalContractError("invalid_schema", `${field}.additionalProperties must be false`);
    return { type, ...description, properties, required, additionalProperties: false };
  }
  if (type === "array") {
    strict(row, ["type", "description", "items", "minItems", "maxItems", "uniqueItems"], field);
    const minItems = row.minItems === undefined ? 0 : integer(row.minItems, `${field}.minItems`, 0, 32);
    const maxItems = row.maxItems === undefined ? 32 : integer(row.maxItems, `${field}.maxItems`, 0, 32);
    if (minItems > maxItems) throw new LocalContractError("invalid_schema", `${field} item bounds are invalid`);
    return {
      type,
      ...description,
      items: parseConstraintSchema(row.items, `${field}.items`, depth + 1),
      minItems,
      maxItems,
      uniqueItems: row.uniqueItems === undefined ? false : boolean(row.uniqueItems, `${field}.uniqueItems`),
    };
  }
  const scalarAllowed = ["type", "description", "enum", "default"];
  if (type === "number" || type === "integer") scalarAllowed.push("minimum", "maximum");
  if (type === "string") scalarAllowed.push("minLength", "maxLength");
  strict(row, scalarAllowed, field);
  const result: LocalConstraintSchema = { type, ...description };
  if (row.enum !== undefined) {
    if (!Array.isArray(row.enum) || row.enum.length === 0 || row.enum.length > 64 || row.enum.some((item) => !scalarMatches(item, type))) {
      throw new LocalContractError("invalid_schema", `${field}.enum is invalid`);
    }
    const values = row.enum as Array<string | number | boolean>;
    const keys = values.map((item) => `${typeof item}:${JSON.stringify(item)}`);
    if (new Set(keys).size !== keys.length) throw new LocalContractError("invalid_schema", `${field}.enum values must be unique`);
    result.enum = values;
  }
  if (row.default !== undefined) {
    if (!scalarMatches(row.default, type) || (result.enum && !result.enum.some((item) => Object.is(item, row.default)))) {
      throw new LocalContractError("invalid_schema", `${field}.default is invalid`);
    }
    result.default = row.default;
  }
  if (type === "number" || type === "integer") {
    if (row.minimum !== undefined) result.minimum = number(row.minimum, `${field}.minimum`);
    if (row.maximum !== undefined) result.maximum = number(row.maximum, `${field}.maximum`);
    if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) {
      throw new LocalContractError("invalid_schema", `${field} numeric bounds are invalid`);
    }
    if (type === "integer" && ((result.minimum !== undefined && !Number.isInteger(result.minimum)) || (result.maximum !== undefined && !Number.isInteger(result.maximum)))) {
      throw new LocalContractError("invalid_schema", `${field} integer bounds must be integers`);
    }
  }
  if (type === "string") {
    if (row.minLength !== undefined) result.minLength = integer(row.minLength, `${field}.minLength`, 0, 65_536);
    if (row.maxLength !== undefined) result.maxLength = integer(row.maxLength, `${field}.maxLength`, 0, 65_536);
    if (result.minLength !== undefined && result.maxLength !== undefined && result.minLength > result.maxLength) {
      throw new LocalContractError("invalid_schema", `${field} string bounds are invalid`);
    }
  }
  const declaredValues = [...(result.enum ?? []), ...(result.default === undefined ? [] : [result.default])];
  for (const declared of declaredValues) {
    if (typeof declared === "number") {
      if (result.minimum !== undefined && declared < result.minimum) throw new LocalContractError("invalid_schema", `${field} declares a value below its minimum`);
      if (result.maximum !== undefined && declared > result.maximum) throw new LocalContractError("invalid_schema", `${field} declares a value above its maximum`);
    }
    if (typeof declared === "string") {
      if (result.minLength !== undefined && declared.length < result.minLength) throw new LocalContractError("invalid_schema", `${field} declares a value below its minimum length`);
      if (result.maxLength !== undefined && declared.length > result.maxLength) throw new LocalContractError("invalid_schema", `${field} declares a value above its maximum length`);
    }
  }
  return result;
}

function capabilityInput(value: unknown, field: string): LocalCapabilityInputContract {
  const row = object(value, field);
  strict(row, ["role", "kind", "mediaTypes", "required", "minItems", "maxItems"], field);
  const mediaTypes = strings(row.mediaTypes, `${field}.mediaTypes`, undefined, 8);
  if (!mediaTypes.length || new Set(mediaTypes).size !== mediaTypes.length || mediaTypes.some((mediaType) => !MEDIA_TYPE.test(mediaType))) {
    throw new LocalContractError("invalid_capability", `${field}.mediaTypes must be unique valid media types`);
  }
  const required = boolean(row.required, `${field}.required`);
  const minItems = integer(row.minItems, `${field}.minItems`, 0, 32);
  const maxItems = integer(row.maxItems, `${field}.maxItems`, 1, 32);
  if (minItems > maxItems || required !== (minItems > 0)) {
    throw new LocalContractError("invalid_capability", `${field} required/cardinality is inconsistent`);
  }
  return {
    role: string(row.role, `${field}.role`, ID, 64),
    kind: string(row.kind, `${field}.kind`, ID, 64),
    mediaTypes,
    required,
    minItems,
    maxItems,
  };
}

function uniqueOutputs(value: unknown, field: string): LocalRequiredOutput[] {
  if (!Array.isArray(value) || value.length > 32) throw new LocalContractError("invalid_capability", `${field} is invalid`);
  const outputs = value.map((entry, index) => requiredOutput(entry, `${field}[${index}]`));
  if (new Set(outputs.map((output) => output.role)).size !== outputs.length) {
    throw new LocalContractError("invalid_capability", `${field} roles must be unique`);
  }
  return outputs;
}

function invocationContract(value: unknown, field: string): LocalCapabilityInvocationContract {
  const row = object(value, field);
  strict(row, ["inputs", "outputs", "constraintsSchema"], field);
  if (!Array.isArray(row.inputs) || row.inputs.length > 32) throw new LocalContractError("invalid_capability", `${field}.inputs is invalid`);
  const inputs = row.inputs.map((entry, index) => capabilityInput(entry, `${field}.inputs[${index}]`));
  if (new Set(inputs.map((input) => input.role)).size !== inputs.length) {
    throw new LocalContractError("invalid_capability", `${field}.input roles must be unique`);
  }
  return {
    inputs,
    outputs: uniqueOutputs(row.outputs, `${field}.outputs`),
    constraintsSchema: parseConstraintSchema(row.constraintsSchema, `${field}.constraintsSchema`),
  };
}

function continuationContract(value: unknown, field: string): LocalCapabilityContinuationContract {
  const row = object(value, field);
  strict(row, ["capability", "tool", "outputs", "constraintsSchema"], field);
  return {
    capability: string(row.capability, `${field}.capability`, CAPABILITY, 128),
    tool: string(row.tool, `${field}.tool`, TOOL, 128),
    outputs: uniqueOutputs(row.outputs, `${field}.outputs`),
    constraintsSchema: parseConstraintSchema(row.constraintsSchema, `${field}.constraintsSchema`),
  };
}

function mediaTypeAccepted(mediaType: string, accepted: readonly string[]): boolean {
  return accepted.some((candidate) => candidate === mediaType || (candidate.endsWith("/*") && mediaType.startsWith(candidate.slice(0, -1))));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** Validate a concrete constraints object against a parsed capability schema. */
export function validateLocalConstraints(schema: LocalConstraintSchema, value: unknown, field = "constraints"): void {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalContractError("invalid_constraints", `${field} must be an object`);
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const unknown = Object.keys(record).filter((name) => !Object.prototype.hasOwnProperty.call(properties, name));
    if (unknown.length) throw new LocalContractError("invalid_constraints", `${field} has unknown fields: ${unknown.join(", ")}`);
    for (const name of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, name)) throw new LocalContractError("invalid_constraints", `${field}.${name} is required`);
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(record, name)) validateLocalConstraints(child, record[name], `${field}.${name}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new LocalContractError("invalid_constraints", `${field} must be an array`);
    const minItems = schema.minItems ?? 0;
    const maxItems = schema.maxItems ?? 32;
    if (value.length < minItems || value.length > maxItems) throw new LocalContractError("invalid_constraints", `${field} item count is invalid`);
    if (schema.uniqueItems) {
      const encoded = value.map((item) => JSON.stringify(item));
      if (new Set(encoded).size !== encoded.length) throw new LocalContractError("invalid_constraints", `${field} items must be unique`);
    }
    value.forEach((item, index) => validateLocalConstraints(schema.items!, item, `${field}[${index}]`));
    return;
  }
  if (!scalarMatches(value, schema.type)) throw new LocalContractError("invalid_constraints", `${field} must be ${schema.type}`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new LocalContractError("invalid_constraints", `${field} is not an allowed value`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new LocalContractError("invalid_constraints", `${field} is below its minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new LocalContractError("invalid_constraints", `${field} is above its maximum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new LocalContractError("invalid_constraints", `${field} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new LocalContractError("invalid_constraints", `${field} is too long`);
  }
}

export type LocalCapabilityInvocationValue = {
  inputs: Array<{ role?: string; kind: string; mediaType: string }>;
  requiredOutputs: LocalRequiredOutput[];
  constraints: Record<string, unknown>;
};

/**
 * Generic invocation enforcement shared by MCP, CLI, and future callers. It
 * rejects legacy summary-only descriptors because guessing a family contract
 * is not a safe compatibility mode.
 */
export function validateLocalCapabilityInvocation(
  descriptor: LocalCapabilityDescriptor,
  invocation: LocalCapabilityInvocationValue,
): void {
  const contract = descriptor.invocation;
  if (!contract) throw new LocalContractError("invocation_contract_unavailable", `capability ${descriptor.id} has no typed invocation contract`);
  const counts = new Map<string, number>();
  for (const [index, input] of invocation.inputs.entries()) {
    const role = input.role?.trim() ?? "";
    const expected = contract.inputs.find((candidate) => candidate.role === role);
    if (!expected) throw new LocalContractError("invalid_invocation_input", `inputs[${index}].role is not advertised by ${descriptor.id}`);
    if (input.kind !== expected.kind || !mediaTypeAccepted(input.mediaType, expected.mediaTypes)) {
      throw new LocalContractError("invalid_invocation_input", `inputs[${index}] does not match the ${role} contract`);
    }
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  for (const expected of contract.inputs) {
    const count = counts.get(expected.role) ?? 0;
    if (count < expected.minItems || count > expected.maxItems) {
      throw new LocalContractError("invalid_invocation_input", `input role ${expected.role} requires ${expected.minItems}-${expected.maxItems} artifact(s)`);
    }
  }
  if (new Set(invocation.requiredOutputs.map((output) => output.role)).size !== invocation.requiredOutputs.length) {
    throw new LocalContractError("invalid_invocation_output", "invocation output roles must be unique");
  }
  for (const [index, output] of invocation.requiredOutputs.entries()) {
    const expected = contract.outputs.find((candidate) => candidate.role === output.role);
    if (!expected || output.kind !== expected.kind || output.required !== expected.required || !sameStrings(output.mediaTypes, expected.mediaTypes)) {
      throw new LocalContractError("invalid_invocation_output", `requiredOutputs[${index}] does not match the ${output.role} contract`);
    }
  }
  for (const expected of contract.outputs) {
    if (expected.required && !invocation.requiredOutputs.some((output) => output.role === expected.role)) {
      throw new LocalContractError("invalid_invocation_output", `required output role ${expected.role} is missing`);
    }
  }
  validateLocalConstraints(contract.constraintsSchema, invocation.constraints);
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
    strict(item, ["id", "profileId", "description", "inputKinds", "outputRoles", "invocation", "continuations", "estimatedMemoryGb", "asynchronous"], `capabilities[${index}]`);
    if (item.asynchronous !== true) throw new LocalContractError("invalid_capability", "local capabilities must be asynchronous");
    const inputKinds = strings(item.inputKinds, "capability.inputKinds", ID);
    const outputRoles = strings(item.outputRoles, "capability.outputRoles", ID);
    if (new Set(inputKinds).size !== inputKinds.length || new Set(outputRoles).size !== outputRoles.length) {
      throw new LocalContractError("invalid_capability", "local capability input kinds and output roles must be unique");
    }
    const invocation = item.invocation === undefined ? undefined : invocationContract(item.invocation, `capabilities[${index}].invocation`);
    if (invocation) {
      const detailedInputKinds = new Set(invocation.inputs.map((input) => input.kind));
      const detailedOutputRoles = new Set(invocation.outputs.map((output) => output.role));
      if (
        detailedInputKinds.size !== inputKinds.length ||
        inputKinds.some((kind) => !detailedInputKinds.has(kind)) ||
        detailedOutputRoles.size !== outputRoles.length ||
        outputRoles.some((role) => !detailedOutputRoles.has(role))
      ) {
        throw new LocalContractError("invalid_capability", "capability summary does not match its typed invocation contract");
      }
    }
    if (item.continuations !== undefined && (!Array.isArray(item.continuations) || item.continuations.length > 16)) {
      throw new LocalContractError("invalid_capability", `capabilities[${index}].continuations is invalid`);
    }
    const continuations = item.continuations === undefined
      ? undefined
      : item.continuations.map((entry, continuationIndex) => continuationContract(entry, `capabilities[${index}].continuations[${continuationIndex}]`));
    if (continuations) {
      const identities = continuations.map((continuation) => `${continuation.capability}\u0000${continuation.tool}`);
      if (new Set(identities).size !== identities.length) {
        throw new LocalContractError("invalid_capability", "capability continuation identities must be unique");
      }
    }
    return {
      id: string(item.id, "capability.id", CAPABILITY, 128),
      profileId: string(item.profileId, "capability.profileId", ID, 128),
      description: string(item.description, "capability.description", undefined, 1024),
      inputKinds,
      outputRoles,
      ...(invocation ? { invocation } : {}),
      ...(continuations ? { continuations } : {}),
      estimatedMemoryGb: integer(item.estimatedMemoryGb, "capability.estimatedMemoryGb", 0, 1024),
      asynchronous: true as const,
    };
  });
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) {
    throw new LocalContractError("invalid_capabilities", "local capability ids must be unique");
  }
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
  const requiredOutputs = row.requiredOutputs.map((value, index) => requiredOutput(value, `request.requiredOutputs[${index}]`));
  if (new Set(requiredOutputs.map((output) => output.role)).size !== requiredOutputs.length) {
    throw new LocalContractError("invalid_outputs", "request output roles must be unique");
  }
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
    requiredOutputs,
    constraints: jsonObject(row.constraints, "request.constraints"),
    workflow: {
      autoContinue: boolean(workflow.autoContinue, "request.workflow.autoContinue"),
      approvedCapabilities: strings(workflow.approvedCapabilities, "request.workflow.approvedCapabilities", CAPABILITY, 16),
      maxContinuations: integer(workflow.maxContinuations, "request.workflow.maxContinuations", 0, 16),
    },
    metadata: jsonObject(row.metadata, "request.metadata"),
  };
}
