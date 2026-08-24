import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseLocalArtifact,
  parseLocalCapabilities,
  parseLocalJob,
  parseLocalJobRequest,
  type LocalArtifact,
  type LocalCapabilities,
  type LocalJob,
  type LocalJobRequest,
} from "../src/lib/local-capability-contract";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const CONTINUATION_CLAIM_TTL_MS = 10 * 60_000;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class LocalCapabilityHostError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalCapabilityHostError";
  }
}

export type LocalCapabilityHostConfig = {
  id: string;
  baseUrl: string;
  tokenFile: string;
  timeoutMs?: number;
  maxJsonBytes?: number;
  maxArtifactBytes?: number;
};

type HostConfig = Required<LocalCapabilityHostConfig> & { url: URL };

export type HostFs = Pick<typeof fs, "readFileSync" | "writeFileSync" | "appendFileSync" | "mkdirSync" | "renameSync" | "unlinkSync" | "existsSync"> & Partial<Pick<typeof fs, "openSync" | "fsyncSync" | "closeSync" | "statSync">>;

export type LocalCapabilityHostClock = {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type LocalCapabilityHostClientOptions = {
  hosts?: LocalCapabilityHostConfig[];
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  fetchImpl?: typeof fetch;
  fsImpl?: HostFs;
  clock?: LocalCapabilityHostClock;
};

type Journal = {
  version: 1;
  observedJobs: Record<string, { hostId: string; job: LocalJob; observedAt: string }>;
  materializations: Record<string, { hostId: string; artifactId: string; sha256: string; sizeBytes: number; path: string; materializedAt: string }>;
  continuations: Record<string, {
    hostId: string;
    jobId: string;
    continuationId: string;
    idempotencyKey: string;
    observedAt: string;
    state: "observed" | "dispatching" | "dispatched";
    claimedAt?: string;
    workerId?: string;
    dispatchedAt?: string;
  }>;
};

function error(code: string, message: string): never {
  throw new LocalCapabilityHostError(code, message);
}

function positiveInteger(value: unknown, field: string, ceiling: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > ceiling) error("invalid_config", `${field} must be a positive integer`);
  return value as number;
}

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function parseHost(value: unknown): HostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) error("invalid_config", "local host config must be an object");
  const row = value as Record<string, unknown>;
  const allowed = new Set(["id", "baseUrl", "tokenFile", "timeoutMs", "maxJsonBytes", "maxArtifactBytes"]);
  const unknown = Object.keys(row).filter((key) => !allowed.has(key));
  if (unknown.length) error("invalid_config", `local host config has unknown fields: ${unknown.join(", ")}`);
  if (typeof row.id !== "string" || !HOST_ID.test(row.id)) error("invalid_config", "local host id is invalid");
  if (typeof row.baseUrl !== "string" || typeof row.tokenFile !== "string" || !row.tokenFile.trim()) error("invalid_config", "local host baseUrl and tokenFile are required");
  let url: URL;
  try { url = new URL(row.baseUrl); } catch { error("invalid_config", "local host baseUrl is invalid"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))) {
    error("invalid_config", "local host must use HTTPS (HTTP is allowed only on loopback) and cannot contain credentials, query, or fragment");
  }
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return {
    id: row.id,
    baseUrl: url.toString().replace(/\/$/, ""),
    tokenFile: row.tokenFile,
    timeoutMs: positiveInteger(row.timeoutMs, "timeoutMs", 120_000) ?? DEFAULT_TIMEOUT_MS,
    maxJsonBytes: positiveInteger(row.maxJsonBytes, "maxJsonBytes", 64 * 1024 * 1024) ?? DEFAULT_MAX_JSON_BYTES,
    maxArtifactBytes: positiveInteger(row.maxArtifactBytes, "maxArtifactBytes", 2 ** 40) ?? DEFAULT_MAX_ARTIFACT_BYTES,
    url,
  };
}

/** Loads a strict multi-host configuration, or the deliberately narrow single-host fallback. */
export function parseLocalCapabilityHosts(env: NodeJS.ProcessEnv = process.env): LocalCapabilityHostConfig[] {
  const configured = env.WORKHORSE_LOCAL_HOSTS_JSON?.trim();
  if (configured) {
    let rows: unknown;
    try { rows = JSON.parse(configured); } catch { error("invalid_config", "WORKHORSE_LOCAL_HOSTS_JSON is not valid JSON"); }
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 32) error("invalid_config", "WORKHORSE_LOCAL_HOSTS_JSON must contain 1 to 32 hosts");
    const hosts = rows.map(parseHost);
    if (new Set(hosts.map((host) => host.id)).size !== hosts.length) error("invalid_config", "local host ids must be unique");
    return hosts.map(({ url: _url, ...host }) => host);
  }
  const baseUrl = env.WORKHORSE_LOCAL_HOST_URL?.trim();
  const tokenFile = env.WORKHORSE_LOCAL_HOST_TOKEN_FILE?.trim();
  if (!baseUrl && !tokenFile) return [];
  if (!baseUrl || !tokenFile) error("invalid_config", "WORKHORSE_LOCAL_HOST_URL and WORKHORSE_LOCAL_HOST_TOKEN_FILE must be set together");
  const host = parseHost({ id: env.WORKHORSE_LOCAL_HOST_ID?.trim() || "local", baseUrl, tokenFile, timeoutMs: env.WORKHORSE_LOCAL_HOST_TIMEOUT_MS ? Number(env.WORKHORSE_LOCAL_HOST_TIMEOUT_MS) : undefined });
  const { url: _url, ...result } = host;
  return [result];
}

function journalFrom(value: unknown): Journal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, observedJobs: {}, materializations: {}, continuations: {} };
  const row = value as Partial<Journal>;
  if (row.version !== 1 || !row.observedJobs || !row.materializations || !row.continuations) return { version: 1, observedJobs: {}, materializations: {}, continuations: {} };
  return row as Journal;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), "utf8");
}

export class LocalCapabilityHostClient {
  private readonly hosts = new Map<string, HostConfig>();
  private readonly fetchImpl: typeof fetch;
  private readonly fs: HostFs;
  private readonly clock: LocalCapabilityHostClock;
  private readonly journalFile: string;
  private journal: Journal;

  constructor(options: LocalCapabilityHostClientOptions) {
    if (!options.stateDir || !path.isAbsolute(options.stateDir)) error("invalid_config", "stateDir must be an absolute path");
    const configs = options.hosts ?? parseLocalCapabilityHosts(options.env);
    for (const config of configs.map(parseHost)) {
      if (this.hosts.has(config.id)) error("invalid_config", "local host ids must be unique");
      this.hosts.set(config.id, config);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fs = options.fsImpl ?? fs;
    this.clock = options.clock ?? { now: () => Date.now(), setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) };
    this.journalFile = path.join(options.stateDir, "local-capability-host-journal.json");
    this.journal = this.readJournal();
  }

  hostIds(): string[] { return [...this.hosts.keys()]; }

  async capabilities(hostId: string): Promise<LocalCapabilities> {
    return parseLocalCapabilities(await this.json(hostId, "GET", "/v1/capabilities"));
  }

  /** Uploads one artifact as raw bytes. The broker owns artifact IDs and metadata validation. */
  async uploadBase64(hostId: string, input: { kind: string; role: string; mediaType: string; base64: string; origin: string }): Promise<LocalArtifact> {
    if (typeof input.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) error("invalid_input", "artifact base64 is invalid");
    const bytes = Buffer.from(input.base64, "base64");
    const host = this.host(hostId);
    if (bytes.byteLength > host.maxArtifactBytes) error("too_large", "artifact exceeds host size limit");
    if (![input.kind, input.role, input.mediaType, input.origin].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256)) error("invalid_input", "artifact upload metadata is invalid");
    const query = new URLSearchParams({ kind: input.kind, role: input.role, mediaType: input.mediaType });
    const uploaded = await this.request(hostId, "POST", `/v1/artifacts?${query.toString()}`, bytes, {
      "Content-Type": "application/octet-stream",
      "X-Origin": input.origin,
      "X-Content-SHA256": createHash("sha256").update(bytes).digest("hex"),
    });
    if (!uploaded || typeof uploaded !== "object" || Array.isArray(uploaded)) error("invalid_response", "artifact upload response is invalid");
    const row = uploaded as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== "protocolVersion" && key !== "artifact") || row.protocolVersion !== "1.0") error("invalid_response", "artifact upload response is invalid");
    return parseLocalArtifact(row.artifact);
  }

  /** Keeps chat text on the same artifact path as every other broker input. */
  async uploadText(hostId: string, input: { text: string; origin: string; role?: string }): Promise<LocalArtifact> {
    if (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > this.host(hostId).maxArtifactBytes) error("invalid_input", "prompt text is invalid");
    return this.uploadBase64(hostId, {
      kind: "text",
      role: input.role ?? "prompt",
      mediaType: "text/plain",
      base64: Buffer.from(input.text, "utf8").toString("base64"),
      origin: input.origin,
    });
  }

  /** Uploads chat text first, then submits the resulting immutable artifact reference. */
  async submitPrompt(hostId: string, input: { text: string; origin: string; request: LocalJobRequest; role?: string }): Promise<LocalJob> {
    const prompt = await this.uploadText(hostId, { text: input.text, origin: input.origin, role: input.role });
    return this.submit(hostId, { ...input.request, inputs: [...input.request.inputs, { artifactId: prompt.id, role: prompt.role, sha256: prompt.sha256 }] });
  }

  /** Image-to-3D accepts a verified image artifact, never a free-form text prompt. */
  async generate3d(hostId: string, input: { sourceArtifactId: string; request: Omit<LocalJobRequest, "capability" | "inputs">; role?: string }): Promise<LocalJob> {
    const source = await this.artifact(hostId, input.sourceArtifactId);
    if (!source.mediaType.toLowerCase().startsWith("image/")) error("invalid_input", "image-to-3D requires an image artifact");
    return this.submit(hostId, {
      ...input.request,
      capability: "asset.3d.generate",
      inputs: [{ artifactId: source.id, role: input.role ?? "source", sha256: source.sha256 }],
    });
  }

  async submit(hostId: string, request: LocalJobRequest): Promise<LocalJob> {
    const parsed = parseLocalJobRequest(request);
    const job = parseLocalJob(await this.json(hostId, "POST", "/v1/jobs", parsed));
    this.observe(hostId, job);
    return job;
  }

  async status(hostId: string, jobId: string): Promise<LocalJob> {
    const job = parseLocalJob(await this.json(hostId, "GET", `/v1/jobs/${this.id(jobId, "job")}`));
    this.observe(hostId, job);
    return job;
  }

  async cancel(hostId: string, jobId: string): Promise<LocalJob> {
    const job = parseLocalJob(await this.json(hostId, "POST", `/v1/jobs/${this.id(jobId, "job")}/cancel`, {}));
    this.observe(hostId, job);
    return job;
  }

  async artifact(hostId: string, artifactId: string): Promise<LocalArtifact> {
    const value = await this.json(hostId, "GET", `/v1/artifacts/${this.id(artifactId, "artifact")}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) error("invalid_response", "artifact response is invalid");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== "protocolVersion" && key !== "artifact") || row.protocolVersion !== "1.0") error("invalid_response", "artifact response is invalid");
    return parseLocalArtifact(row.artifact);
  }

  async downloadChunks(hostId: string, artifactId: string): Promise<Buffer[]> {
    const artifact = await this.artifact(hostId, artifactId);
    if (artifact.sizeBytes === 0) return [];
    const decoded: Buffer[] = [];
    const chunkBytes = 4 * 1024 * 1024;
    for (let offset = 0; offset < artifact.sizeBytes; offset += chunkBytes) {
      const length = Math.min(chunkBytes, artifact.sizeBytes - offset);
      const chunk = await this.binary(hostId, `/v1/artifacts/${artifact.id}/content`, length, {
        Range: `bytes=${offset}-${offset + length - 1}`,
        "X-Expected-Content-Range": `bytes ${offset}-${offset + length - 1}/${artifact.sizeBytes}`,
      });
      if (chunk.byteLength !== length) error("invalid_response", "artifact byte range length does not match metadata");
      decoded.push(chunk);
    }
    const size = decoded.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (size !== artifact.sizeBytes || size > this.host(hostId).maxArtifactBytes) error("invalid_response", "artifact chunk size does not match metadata");
    return decoded;
  }

  async prepareContinuation(hostId: string, jobId: string, continuationId: string): Promise<{
    replayWorkerId?: string;
    job: LocalJob;
    continuation: NonNullable<LocalJob["result"]>["continuations"][number];
    files: string[];
  }> {
    const job = await this.status(hostId, jobId);
    if (job.status !== "completed" || !job.result) error("continuation_unavailable", "continuation job is not completed");
    const continuation = job.result.continuations.find((candidate) => candidate.id === continuationId);
    if (!continuation) error("continuation_unavailable", "continuation was not returned by this job");
    if (continuation.capability !== "asset.3d.prepare.blender" || continuation.tool !== "blender.prepare_game_asset") {
      error("continuation_forbidden", "continuation capability is not allowlisted");
    }
    if (continuation.authorization.mode !== "explicit" || !continuation.authorization.approvedByRequest) {
      error("continuation_forbidden", "continuation was not explicitly authorized by the originating request");
    }
    if (continuation.inputBindings.length !== 1 || continuation.inputBindings[0]?.name !== "sourceModel" || continuation.inputBindings[0]?.mediaType !== "model/gltf-binary") {
      error("continuation_forbidden", "Blender continuation input contract is not allowlisted");
    }
    const required = new Map(continuation.requiredOutputs.map((output) => [output.role, output]));
    const expectedOutputs: Array<[string, string, string]> = [
      ["game_model", "model3d", "model/gltf-binary"],
      ["preview", "image", "image/png"],
      ["blender_report", "report", "application/json"],
    ];
    if (required.size !== expectedOutputs.length || expectedOutputs.some(([role, kind, mediaType]) => {
      const output = required.get(role);
      return !output || output.kind !== kind || !output.required || output.mediaTypes.length !== 1 || output.mediaTypes[0] !== mediaType;
    })) error("continuation_forbidden", "Blender continuation output contract is not allowlisted");
    const targetFaces = continuation.constraints.targetFaces;
    const targetEngine = continuation.constraints.targetEngine;
    if (!Number.isInteger(targetFaces) || (targetFaces as number) < 100 || (targetFaces as number) > 1_000_000 || !["generic", "blender", "godot", "unity", "unreal"].includes(String(targetEngine))) {
      error("continuation_forbidden", "Blender continuation constraints are not allowlisted");
    }
    const claim = this.withJournalLock(() => {
      this.journal = this.readJournal();
      const key = `${hostId}:${job.id}:${continuation.idempotencyKey}`;
      const previous = this.journal.continuations[key];
      if (previous?.state === "dispatched" && previous.workerId) return { replayWorkerId: previous.workerId };
      if (previous?.state === "dispatching") error("continuation_in_progress", "continuation dispatch was already claimed; reconcile it against visible Workhorse workers before retrying");
      this.journal.continuations[key] = {
        hostId,
        jobId: job.id,
        continuationId: continuation.id,
        idempotencyKey: continuation.idempotencyKey,
        observedAt: previous?.observedAt ?? new Date(this.clock.now()).toISOString(),
        state: "dispatching",
        claimedAt: new Date(this.clock.now()).toISOString(),
      };
      this.saveJournal();
      return {};
    });
    if (claim.replayWorkerId) return { replayWorkerId: claim.replayWorkerId, job, continuation, files: [] };
    try {
      const files: string[] = [];
      for (const binding of continuation.inputBindings) {
        const artifact = await this.artifact(hostId, binding.artifactId);
        if (artifact.sha256 !== binding.sha256 || artifact.mediaType !== binding.mediaType) error("stale_completion", "continuation artifact binding no longer matches metadata");
        files.push(await this.materialize(hostId, artifact.id));
      }
      return { job, continuation, files };
    } catch (cause) {
      this.releaseContinuationDispatch(hostId, job.id, continuation.idempotencyKey);
      throw cause;
    }
  }

  continuationRecord(hostId: string, jobId: string, continuationId: string): Journal["continuations"][string] | undefined {
    this.journal = this.readJournal();
    return Object.values(this.journal.continuations).find((record) => record.hostId === hostId && record.jobId === jobId && record.continuationId === continuationId);
  }

  /** Reopens only an expired claim that has no visible worker to reconcile. */
  recoverStaleContinuationDispatch(hostId: string, jobId: string, idempotencyKey: string): boolean {
    return this.withJournalLock(() => {
      this.journal = this.readJournal();
      const key = `${hostId}:${jobId}:${idempotencyKey}`;
      const record = this.journal.continuations[key];
      const claimedAt = record?.claimedAt ? Date.parse(record.claimedAt) : Number.NaN;
      if (record?.state !== "dispatching" || !Number.isFinite(claimedAt) || this.clock.now() - claimedAt <= CONTINUATION_CLAIM_TTL_MS) return false;
      this.journal.continuations[key] = { ...record, state: "observed", claimedAt: undefined };
      this.saveJournal();
      return true;
    });
  }

  recordContinuationDispatch(hostId: string, jobId: string, idempotencyKey: string, workerId: string): void {
    this.withJournalLock(() => {
      this.journal = this.readJournal();
      const key = `${hostId}:${jobId}:${idempotencyKey}`;
      const record = this.journal.continuations[key];
      if (!record || record.state !== "dispatching") error("continuation_state", "continuation dispatch was not claimed");
      if (!workerId.trim() || workerId.length > 256) error("continuation_state", "continuation worker id is invalid");
      this.journal.continuations[key] = { ...record, state: "dispatched", workerId: workerId.trim(), dispatchedAt: new Date(this.clock.now()).toISOString() };
      this.saveJournal();
    });
  }

  releaseContinuationDispatch(hostId: string, jobId: string, idempotencyKey: string): void {
    this.withJournalLock(() => {
      this.journal = this.readJournal();
      const key = `${hostId}:${jobId}:${idempotencyKey}`;
      const record = this.journal.continuations[key];
      if (record?.state === "dispatching") {
        this.journal.continuations[key] = { ...record, state: "observed", claimedAt: undefined };
        this.saveJournal();
      }
    });
  }

  /** Materializes only beneath Workhorse's managed state cache; callers never choose an output path. */
  async materialize(hostId: string, artifactId: string): Promise<string> {
    const artifact = await this.artifact(hostId, artifactId);
    const cacheRoot = path.resolve(path.dirname(this.journalFile), "local-capability-cache", hostId);
    this.journal = this.readJournal();
    const existing = this.journal.materializations[`${hostId}:${artifact.id}`];
    if (
      existing &&
      path.resolve(existing.path).startsWith(`${cacheRoot}${path.sep}`) &&
      existing.sha256 === artifact.sha256 &&
      existing.sizeBytes === artifact.sizeBytes &&
      this.fs.existsSync(existing.path)
    ) return existing.path;
    const output = path.resolve(cacheRoot, artifact.id);
    if (!output.startsWith(`${cacheRoot}${path.sep}`)) error("unsafe_path", "managed cache path is unsafe");
    const temp = `${output}.tmp-${process.pid}-${this.clock.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chunks = await this.downloadChunks(hostId, artifact.id);
    const hash = createHash("sha256");
    let size = 0;
    this.fs.mkdirSync(cacheRoot, { recursive: true });
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        size += chunk.byteLength;
        if (size > artifact.sizeBytes || size > this.host(hostId).maxArtifactBytes) error("too_large", "artifact chunk data is too large");
        hash.update(chunk);
        if (index === 0) this.fs.writeFileSync(temp, chunk, { flag: "wx", mode: 0o600 });
        else this.fs.appendFileSync(temp, chunk);
      }
      if (chunks.length === 0) this.fs.writeFileSync(temp, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      this.fsync(temp);
      if (size !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256) error("integrity", "artifact hash or size verification failed");
      this.fs.renameSync(temp, output);
      this.withJournalLock(() => {
        this.journal = this.readJournal();
        this.journal.materializations[`${hostId}:${artifact.id}`] = { hostId, artifactId: artifact.id, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, path: output, materializedAt: new Date(this.clock.now()).toISOString() };
        this.saveJournal();
      });
      return output;
    } catch (cause) {
      try { this.fs.unlinkSync(temp); } catch { /* best effort for rejected bytes */ }
      throw cause;
    }
  }

  journalSnapshot(): Readonly<Journal> { return JSON.parse(JSON.stringify(this.journal)) as Journal; }

  private host(hostId: string): HostConfig {
    const host = this.hosts.get(hostId);
    if (!host) error("unknown_host", "local capability host is not configured");
    return host;
  }

  private id(value: string, kind: "job" | "artifact"): string {
    const valid = kind === "job" ? /^job_[a-f0-9]{32}$/ : /^art_[a-f0-9]{32}$/;
    if (!valid.test(value)) error("invalid_input", `${kind} id is invalid`);
    return encodeURIComponent(value);
  }

  private endpoint(host: HostConfig, pathname: string): URL {
    const base = host.baseUrl.endsWith("/") ? host.baseUrl : `${host.baseUrl}/`;
    const url = new URL(pathname.replace(/^\//, ""), base);
    if (url.origin !== host.url.origin || !url.pathname.startsWith(host.url.pathname === "/" ? "/" : `${host.url.pathname}/`)) error("unsafe_endpoint", "local host endpoint escaped its configured base URL");
    return url;
  }

  private token(host: HostConfig): string {
    let token: string;
    try {
      if (process.platform !== "win32" && this.fs.statSync && (this.fs.statSync(host.tokenFile).mode & 0o077) !== 0) {
        error("token_unavailable", "local host token file must not be readable by group or other users");
      }
      token = asBuffer(this.fs.readFileSync(host.tokenFile)).toString("utf8").trim();
    } catch (cause) {
      if (cause instanceof LocalCapabilityHostError) throw cause;
      error("token_unavailable", "local host token file cannot be read");
    }
    if (!token || token.length > 16_384 || /[\r\n]/.test(token)) error("token_unavailable", "local host token file is invalid");
    return token;
  }

  private async json(hostId: string, method: string, pathname: string, body?: unknown): Promise<unknown> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return this.request(hostId, method, pathname, encoded, encoded ? { "Content-Type": "application/json" } : {});
  }

  private async request(hostId: string, method: string, pathname: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<unknown> {
    const host = this.host(hostId);
    if (body && Buffer.byteLength(body) > (headers["Content-Type"] === "application/json" ? host.maxJsonBytes : host.maxArtifactBytes)) error("too_large", "request body exceeds host limit");
    const abort = new AbortController();
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.clock.setTimeout(() => { abort.abort(); reject(new LocalCapabilityHostError("timeout", "local host request timed out")); }, host.timeoutMs);
    });
    try {
      const response = await Promise.race([this.fetchImpl(this.endpoint(host, pathname), {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${this.token(host)}`, ...headers },
        body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
        signal: abort.signal,
      }), timeout]);
      const bytes = await Promise.race([this.readResponse(response, host.maxJsonBytes), timeout]);
      if (!response.ok) error("broker_error", `local host returned HTTP ${response.status}`);
      try { return JSON.parse(bytes.toString("utf8")); } catch { error("invalid_response", "local host returned invalid JSON"); }
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer);
    }
  }

  private async binary(hostId: string, pathname: string, maximum: number, headers: Record<string, string>): Promise<Buffer> {
    const host = this.host(hostId);
    const abort = new AbortController();
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.clock.setTimeout(() => { abort.abort(); reject(new LocalCapabilityHostError("timeout", "local host request timed out")); }, host.timeoutMs);
    });
    try {
      const expectedContentRange = headers["X-Expected-Content-Range"];
      const outboundHeaders = { ...headers };
      delete outboundHeaders["X-Expected-Content-Range"];
      const response = await Promise.race([this.fetchImpl(this.endpoint(host, pathname), {
        method: "GET",
        headers: { Accept: "application/octet-stream", Authorization: `Bearer ${this.token(host)}`, ...outboundHeaders },
        signal: abort.signal,
      }), timeout]);
      const bytes = await Promise.race([this.readResponse(response, maximum), timeout]);
      if (!response.ok) error("broker_error", `local host returned HTTP ${response.status}`);
      if (expectedContentRange && (response.status !== 206 || response.headers.get("content-range") !== expectedContentRange)) {
        error("invalid_response", "local host byte range response did not match the requested range");
      }
      return bytes;
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer);
    }
  }

  private async readResponse(response: Response, maxBytes: number): Promise<Buffer> {
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) error("too_large", "local host response exceeds limit");
    const body = response.body as unknown as AsyncIterable<Uint8Array> | null;
    if (body && Symbol.asyncIterator in Object(body)) {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const value of body) {
        const chunk = Buffer.from(value);
        length += chunk.byteLength;
        if (length > maxBytes) error("too_large", "local host response exceeds limit");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) error("too_large", "local host response exceeds limit");
    return bytes;
  }

  private observe(hostId: string, job: LocalJob): void {
    this.withJournalLock(() => {
      this.journal = this.readJournal();
      const observedAt = new Date(this.clock.now()).toISOString();
      this.journal.observedJobs[`${hostId}:${job.id}`] = { hostId, job, observedAt };
      for (const continuation of job.result?.continuations ?? []) {
        const key = `${hostId}:${job.id}:${continuation.idempotencyKey}`;
        const previous = this.journal.continuations[key];
        this.journal.continuations[key] = previous ?? { hostId, jobId: job.id, continuationId: continuation.id, idempotencyKey: continuation.idempotencyKey, observedAt, state: "observed" };
      }
      this.saveJournal();
    });
  }

  private withJournalLock<T>(action: () => T): T {
    const lockFile = `${this.journalFile}.lock`;
    const acquire = () => this.fs.writeFileSync(lockFile, String(this.clock.now()), { flag: "wx", mode: 0o600 });
    try {
      acquire();
    } catch {
      let stale = false;
      try {
        const createdAt = Number(asBuffer(this.fs.readFileSync(lockFile)).toString("utf8"));
        stale = Number.isFinite(createdAt) && this.clock.now() - createdAt > 5 * 60_000;
      } catch { /* active or unreadable lock */ }
      if (!stale) error("journal_busy", "local capability journal is being updated by another helper");
      try { this.fs.unlinkSync(lockFile); } catch { error("journal_busy", "stale local capability journal lock could not be recovered"); }
      try { acquire(); } catch { error("journal_busy", "local capability journal is being updated by another helper"); }
    }
    try {
      return action();
    } finally {
      try { this.fs.unlinkSync(lockFile); } catch { /* process cleanup will recover a stale lock */ }
    }
  }

  private readJournal(): Journal {
    try { return journalFrom(JSON.parse(asBuffer(this.fs.readFileSync(this.journalFile)).toString("utf8"))); } catch { return { version: 1, observedJobs: {}, materializations: {}, continuations: {} }; }
  }

  private saveJournal(): void {
    this.atomicWrite(this.journalFile, JSON.stringify(this.journal));
  }

  private atomicWrite(file: string, content: string): void {
    this.fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${this.clock.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      this.fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
      this.fsync(temp);
      this.fs.renameSync(temp, file);
    } catch (cause) {
      try { this.fs.unlinkSync(temp); } catch { /* best effort */ }
      throw cause;
    }
  }

  private fsync(file: string): void {
    if (!this.fs.openSync || !this.fs.fsyncSync || !this.fs.closeSync) return;
    const handle = this.fs.openSync(file, "r");
    try { this.fs.fsyncSync(handle); } finally { this.fs.closeSync(handle); }
  }
}
