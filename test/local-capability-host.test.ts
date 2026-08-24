import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { LocalCapabilityHostClient, LocalCapabilityHostError, parseLocalCapabilityHosts, type HostFs, type LocalCapabilityHostConfig } from "../electron/local-capability-host";

const jobId = "job_0123456789abcdef0123456789abcdef";
const artifactId = "art_0123456789abcdef0123456789abcdef";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

class FakeFs {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  readFileSync(file: string) { const value = this.files.get(file); if (!value) throw new Error("ENOENT"); return Buffer.from(value); }
  writeFileSync(file: string, value: string | Uint8Array, options?: { flag?: string }) { if (options?.flag === "wx" && this.files.has(file)) throw new Error("EEXIST"); this.files.set(file, Buffer.from(value)); }
  appendFileSync(file: string, value: string | Uint8Array) { const current = this.readFileSync(file); this.files.set(file, Buffer.concat([current, Buffer.from(value)])); }
  mkdirSync(dir: string) { this.dirs.add(dir); }
  renameSync(from: string, to: string) { const value = this.readFileSync(from); this.files.set(to, value); this.files.delete(from); }
  unlinkSync(file: string) { if (!this.files.delete(file)) throw new Error("ENOENT"); }
  existsSync(file: string) { return this.files.has(file) || this.dirs.has(file); }
}

const now = { now: () => 1_700_000_000_000, setTimeout: () => 1, clearTimeout: () => {} };
function response(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}
function binaryResponse(value: Buffer, status = 206): Response {
  return new Response(new Uint8Array(value), { status, headers: {
    "content-type": "application/octet-stream",
    "content-length": String(value.length),
    "content-range": `bytes 0-${Math.max(0, value.length - 1)}/${value.length}`,
  } });
}
function artifact(bytes: Buffer) {
  return { id: artifactId, jobId: null, kind: "file", role: "output", mediaType: "application/octet-stream", sha256: sha(bytes), sizeBytes: bytes.length, metadata: {}, validation: {}, createdAt: "2026-01-01T00:00:00.000Z" };
}
function job(status = "queued") { return { protocolVersion: "1.0", id: jobId, requestId: "req_1", traceId: "trace_1", origin: "workhorse", idempotencyKey: "idem_1", capability: "image.upscale", priority: 1, status, profileId: null, cancelRequested: false, attempt: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", startedAt: null, finishedAt: null }; }
function completed3d(bytes: Buffer, approved = true) {
  return {
    ...job("completed"),
    capability: "asset.3d.generate",
    profileId: "gpu.hunyuan3d",
    finishedAt: "2026-01-01T00:01:00.000Z",
    result: {
      protocolVersion: "1.0",
      jobId,
      traceId: "trace_1",
      route: { visitedSystems: ["workhorse", "dgx-spark"], hopCount: 2 },
      artifacts: [],
      continuations: [{
        id: "cont_0123456789abcdef0123456789abcdef",
        capability: "asset.3d.prepare.blender",
        tool: "blender.prepare_game_asset",
        inputBindings: [{ name: "sourceModel", artifactId, sha256: sha(bytes), mediaType: "model/gltf-binary" }],
        requiredOutputs: [
          { role: "game_model", kind: "model3d", mediaTypes: ["model/gltf-binary"], required: true },
          { role: "preview", kind: "image", mediaTypes: ["image/png"], required: true },
          { role: "blender_report", kind: "report", mediaTypes: ["application/json"], required: true },
        ],
        constraints: { targetFaces: 100000, targetEngine: "godot" },
        authorization: { mode: "explicit", approvedByRequest: approved },
        autoStartEligible: false,
        idempotencyKey: `${jobId}:blender:v1`,
      }],
      data: {},
    },
  };
}
function client(fake: FakeFs, fetchImpl: typeof fetch, hosts: LocalCapabilityHostConfig[] = [{ id: "spark", baseUrl: "https://broker.test/api", tokenFile: "/token" }]) {
  fake.files.set("/token", Buffer.from("secret-token\n"));
  return new LocalCapabilityHostClient({ hosts, stateDir: "/state", fsImpl: fake as unknown as HostFs, fetchImpl, clock: now });
}

test("host configuration validates multi-host and conservative fallback URLs", () => {
  assert.deepEqual(parseLocalCapabilityHosts({ WORKHORSE_LOCAL_HOSTS_JSON: JSON.stringify([{ id: "spark", baseUrl: "https://broker.test", tokenFile: "/token" }]) }).map((host) => host.id), ["spark"]);
  assert.equal(parseLocalCapabilityHosts({ WORKHORSE_LOCAL_HOST_URL: "http://localhost:9000", WORKHORSE_LOCAL_HOST_TOKEN_FILE: "/token" })[0]?.id, "local");
  assert.throws(() => parseLocalCapabilityHosts({ WORKHORSE_LOCAL_HOSTS_JSON: JSON.stringify([{ id: "spark", baseUrl: "http://broker.test", tokenFile: "/token" }]) }), LocalCapabilityHostError);
  assert.throws(() => parseLocalCapabilityHosts({ WORKHORSE_LOCAL_HOST_URL: "https://broker.test" }), /set together/);
});

test("broker requests use the token file, auth header, and base-scoped endpoints without leaking the token", async () => {
  const fake = new FakeFs();
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (input, init) => { seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") }); return response(job()); }) as typeof fetch;
  const host = client(fake, fetchImpl);
  await host.status("spark", jobId);
  assert.deepEqual(seen, [{ url: `https://broker.test/api/v1/jobs/${jobId}`, auth: "Bearer secret-token" }]);
  assert.doesNotMatch(JSON.stringify(host.journalSnapshot()), /secret-token/);
});

test("base64 uploads use the broker's raw-byte contract with provenance and a content digest", async () => {
  const fake = new FakeFs();
  const bytes = Buffer.from("hello");
  let seen: { url: string; headers: Headers; body: string } | undefined;
  const host = client(fake, (async (input, init) => {
    seen = { url: String(input), headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array).toString("utf8") };
    return response({ protocolVersion: "1.0", artifact: artifact(bytes) });
  }) as typeof fetch);
  await host.uploadBase64("spark", { kind: "text", role: "prompt", mediaType: "text/plain", base64: bytes.toString("base64"), origin: "chat" });
  assert.equal(seen?.url, "https://broker.test/api/v1/artifacts?kind=text&role=prompt&mediaType=text%2Fplain");
  assert.equal(seen?.body, "hello");
  assert.equal(seen?.headers.get("x-origin"), "chat");
  assert.equal(seen?.headers.get("x-content-sha256"), sha(bytes));
});

test("broker response caps reject oversized JSON before parsing", async () => {
  const fake = new FakeFs();
  const host = client(fake, (async () => response({ padding: "x".repeat(2048) }, 200, { "content-length": "2049" })) as typeof fetch, [{ id: "spark", baseUrl: "https://broker.test", tokenFile: "/token", maxJsonBytes: 1024 }]);
  await assert.rejects(() => host.capabilities("spark"), (cause: unknown) => cause instanceof LocalCapabilityHostError && cause.code === "too_large");
});

test("observed jobs journal atomically and remain available to a restarted client", async () => {
  const fake = new FakeFs();
  const first = client(fake, (async () => response(job("cancelled"))) as typeof fetch);
  await first.status("spark", jobId);
  const journalFile = "/state/local-capability-host-journal.json";
  assert.ok(fake.files.has(journalFile));
  assert.equal([...fake.files.keys()].some((file) => file.includes(".tmp-")), false);
  const restarted = client(fake, (async () => response(job("cancelled"))) as typeof fetch);
  assert.equal(restarted.journalSnapshot().observedJobs[`spark:${jobId}`]?.job.status, "cancelled");
});

test("materialization rejects traversal-shaped IDs, verifies hash, and commits only atomically into the managed cache", async () => {
  const fake = new FakeFs();
  const bytes = Buffer.from("verified local artifact");
  const validArtifact = artifact(bytes);
  const requests: string[] = [];
  const fetchImpl = (async (input) => {
    const url = String(input); requests.push(url);
    return url.endsWith("/content") ? binaryResponse(bytes) : response({ protocolVersion: "1.0", artifact: validArtifact });
  }) as typeof fetch;
  const host = client(fake, fetchImpl);
  const output = await host.materialize("spark", artifactId);
  assert.equal(output, path.resolve("/state/local-capability-cache/spark", artifactId));
  assert.deepEqual(fake.readFileSync(output), bytes);
  assert.equal([...fake.files.keys()].some((file) => file.includes(".tmp-")), false);
  assert.equal((await host.materialize("spark", artifactId)), output, "materialization journal makes repeat calls idempotent");
  assert.equal(requests.filter((value) => value.endsWith("/content")).length, 1);
  await assert.rejects(() => host.materialize("spark", "art_../../escape"), /artifact id is invalid/);

  const bad = client(new FakeFs(), (async (input) => String(input).endsWith("/content") ? binaryResponse(bytes) : response({ protocolVersion: "1.0", artifact: { ...validArtifact, sha256: "0".repeat(64) } })) as typeof fetch);
  await assert.rejects(() => bad.materialize("spark", artifactId), (cause: unknown) => cause instanceof LocalCapabilityHostError && cause.code === "integrity");
});

test("materialization rejects a dishonest Content-Range response", async () => {
  const fake = new FakeFs();
  const bytes = Buffer.from("range checked bytes");
  const validArtifact = artifact(bytes);
  const host = client(fake, (async (input) => {
    if (!String(input).endsWith("/content")) return response({ protocolVersion: "1.0", artifact: validArtifact });
    return new Response(new Uint8Array(bytes), {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "content-range": `bytes 1-${bytes.length}/${bytes.length + 1}`,
      },
    });
  }) as typeof fetch);
  await assert.rejects(
    () => host.materialize("spark", artifactId),
    (cause: unknown) => cause instanceof LocalCapabilityHostError && cause.code === "invalid_response",
  );
});

test("materialization ignores a journal path outside its managed cache", async () => {
  const fake = new FakeFs();
  const bytes = Buffer.from("fresh managed copy");
  const validArtifact = artifact(bytes);
  fake.files.set("/outside/attacker-selected", bytes);
  fake.files.set("/state/local-capability-host-journal.json", Buffer.from(JSON.stringify({
    version: 1,
    observedJobs: {},
    continuations: {},
    materializations: {
      [`spark:${artifactId}`]: {
        hostId: "spark",
        artifactId,
        sha256: validArtifact.sha256,
        sizeBytes: validArtifact.sizeBytes,
        path: "/outside/attacker-selected",
        materializedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  })));
  let downloads = 0;
  const host = client(fake, (async (input) => {
    if (String(input).endsWith("/content")) {
      downloads += 1;
      return binaryResponse(bytes);
    }
    return response({ protocolVersion: "1.0", artifact: validArtifact });
  }) as typeof fetch);
  const output = await host.materialize("spark", artifactId);
  assert.equal(output, path.resolve("/state/local-capability-cache/spark", artifactId));
  assert.equal(downloads, 1, "the untrusted journal path is never reused");
});

test("authorized Blender continuations are allowlisted, claimed durably, and replay the visible worker id", async () => {
  const fake = new FakeFs();
  const bytes = Buffer.from("glb bytes");
  const model = { ...artifact(bytes), kind: "model3d", role: "shape_model", mediaType: "model/gltf-binary" };
  const fetchImpl = (async (input) => {
    const url = String(input);
    if (url.endsWith("/content")) return binaryResponse(bytes);
    if (url.includes("/v1/artifacts/")) return response({ protocolVersion: "1.0", artifact: model });
    return response(completed3d(bytes));
  }) as typeof fetch;
  const first = client(fake, fetchImpl);
  const prepared = await first.prepareContinuation("spark", jobId, "cont_0123456789abcdef0123456789abcdef");
  assert.equal(prepared.files.length, 1);
  await assert.rejects(
    () => first.prepareContinuation("spark", jobId, "cont_0123456789abcdef0123456789abcdef"),
    (cause: unknown) => cause instanceof LocalCapabilityHostError && cause.code === "continuation_in_progress",
  );
  first.recordContinuationDispatch("spark", jobId, `${jobId}:blender:v1`, "worker_visible_1");
  const restarted = client(fake, fetchImpl);
  const replay = await restarted.prepareContinuation("spark", jobId, "cont_0123456789abcdef0123456789abcdef");
  assert.equal(replay.replayWorkerId, "worker_visible_1");

  const denied = client(new FakeFs(), (async () => response(completed3d(bytes, false))) as typeof fetch);
  await assert.rejects(
    () => denied.prepareContinuation("spark", jobId, "cont_0123456789abcdef0123456789abcdef"),
    (cause: unknown) => cause instanceof LocalCapabilityHostError && cause.code === "continuation_forbidden",
  );
});

test("two helpers sharing one journal cannot both claim the same continuation", async () => {
  const fake = new FakeFs();
  const bytes = Buffer.from("shared claim glb");
  const model = { ...artifact(bytes), kind: "model3d", role: "shape_model", mediaType: "model/gltf-binary" };
  const fetchImpl = (async (input) => {
    const url = String(input);
    if (url.endsWith("/content")) return binaryResponse(bytes);
    if (url.includes("/v1/artifacts/")) return response({ protocolVersion: "1.0", artifact: model });
    return response(completed3d(bytes));
  }) as typeof fetch;
  const first = client(fake, fetchImpl);
  const second = client(fake, fetchImpl);
  const results = await Promise.allSettled([
    first.prepareContinuation("spark", jobId, "cont_0123456789abcdef0123456789abcdef"),
    second.prepareContinuation("spark", jobId, "cont_0123456789abcdef0123456789abcdef"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejected?.reason instanceof LocalCapabilityHostError);
  assert.equal(rejected.reason.code, "continuation_in_progress");
});

test("an expired continuation claim can be reopened after a crash with no worker", async () => {
  const fake = new FakeFs();
  const bytes = Buffer.from("expired claim glb");
  const model = { ...artifact(bytes), kind: "model3d", role: "shape_model", mediaType: "model/gltf-binary" };
  let currentTime = 1_700_000_000_000;
  const liveClock = { now: () => currentTime, setTimeout: () => 1, clearTimeout: () => {} };
  const fetchImpl = (async (input) => {
    const url = String(input);
    if (url.endsWith("/content")) return binaryResponse(bytes);
    if (url.includes("/v1/artifacts/")) return response({ protocolVersion: "1.0", artifact: model });
    return response(completed3d(bytes));
  }) as typeof fetch;
  fake.files.set("/token", Buffer.from("secret-token\n"));
  const host = new LocalCapabilityHostClient({
    hosts: [{ id: "spark", baseUrl: "https://broker.test/api", tokenFile: "/token" }],
    stateDir: "/state",
    fsImpl: fake as unknown as HostFs,
    fetchImpl,
    clock: liveClock,
  });
  const continuationId = "cont_0123456789abcdef0123456789abcdef";
  await host.prepareContinuation("spark", jobId, continuationId);
  assert.equal(host.recoverStaleContinuationDispatch("spark", jobId, `${jobId}:blender:v1`), false, "an active claim cannot be stolen");
  currentTime += 10 * 60_000 + 1;
  assert.equal(host.recoverStaleContinuationDispatch("spark", jobId, `${jobId}:blender:v1`), true);
  const retried = await host.prepareContinuation("spark", jobId, continuationId);
  assert.equal(retried.files.length, 1, "the expired claim is safely claimed again");
});
