import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { probeLocalComputeHost, type LocalComputeProbeDependencies } from "../electron/local-compute-registry";
import type { LocalComputeHostSettings } from "../src/lib/local-compute";

const ROOT = path.resolve(import.meta.dirname, "..");
const host: LocalComputeHostSettings = {
  id: "host-a", label: "Host A", baseUrl: "https://compute.example.test/run",
  tokenFile: path.join(path.parse(ROOT).root, "private", "host-a.token"), enabled: true,
  allowedCallerRoles: [], allowedCapabilities: [], allowedContinuations: [],
};
const capabilities = {
  protocolVersion: "1.0", brokerVersion: "2.4.0", brokerId: "runtime-a",
  capabilities: [{ id: "artifact.create", profileId: "profile-a", description: "Creates an artifact.",
    inputKinds: ["image"], outputRoles: ["primary", "report"], estimatedMemoryGb: 32, asynchronous: true,
    continuations: [{
      capability: "artifact.review", tool: "artifact.review_asset",
      outputs: [{ role: "review", kind: "document", mediaTypes: ["application/json"], required: true }],
      constraintsSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    }],
  }],
  limits: { maxJsonBytes: 1024, maxArtifactBytes: 4096, maxHops: 4 },
};

function dependencies(fetchImpl: typeof fetch, patch: Partial<LocalComputeProbeDependencies> = {}): LocalComputeProbeDependencies {
  return { readFileSync: () => Buffer.from("private-token"), statSync: () => ({ mode: 0o100600, isFile: () => true }),
    fetchImpl, platform: "darwin", now: () => 1234, timeoutMs: 100, ...patch };
}

test("Electron returns typed discovery without returning the token", async () => {
  let authorization = "";
  const result = await probeLocalComputeHost(host, dependencies((async (input, init) => {
    assert.equal(String(input), "https://compute.example.test/run/v1/capabilities");
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify(capabilities), { status: 200 });
  }) as typeof fetch));
  assert.equal(authorization, "Bearer private-token");
  assert.equal(result.status, "healthy");
  assert.equal(result.runtimeId, "runtime-a");
  assert.deepEqual(result.capabilities[0]?.outputRoles, ["primary", "report"]);
  assert.deepEqual(result.capabilities[0]?.continuations, [{
    capability: "artifact.review",
    tool: "artifact.review_asset",
    outputRoles: ["review"],
  }]);
  assert.doesNotMatch(JSON.stringify(result), /private-token|authorization/i);
});

test("Unix token files with broad permissions fail before network", async () => {
  let calls = 0;
  const result = await probeLocalComputeHost(host, dependencies((async () => { calls += 1; return new Response(); }) as typeof fetch,
    { statSync: () => ({ mode: 0o100644, isFile: () => true }) }));
  assert.equal(calls, 0);
  assert.equal(result.status, "misconfigured");
  assert.equal(result.errorCode, "token_permissions");
});

test("Windows uses its file ACL and accepts a Windows token path", async () => {
  const result = await probeLocalComputeHost({ ...host, tokenFile: "C:\\Users\\person\\host.token" }, dependencies((async () =>
    new Response(JSON.stringify(capabilities), { status: 200 })) as typeof fetch,
  { platform: "win32", statSync: () => ({ mode: 0o100666, isFile: () => true }) }));
  assert.equal(result.status, "healthy");
});

test("offline and disabled hosts never acquire discovered capabilities", async () => {
  const offline = await probeLocalComputeHost(host, dependencies((async () => { throw new TypeError("offline private-token"); }) as typeof fetch));
  assert.equal(offline.status, "unavailable");
  assert.deepEqual(offline.capabilities, []);
  assert.doesNotMatch(JSON.stringify(offline), /private-token/);
  let calls = 0;
  const disabled = await probeLocalComputeHost({ ...host, enabled: false }, dependencies((async () => { calls += 1; return new Response(); }) as typeof fetch));
  assert.equal(calls, 0);
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(disabled.capabilities, []);
});

test("capability discovery stops an oversized streamed body without Content-Length", async () => {
  const chunk = new Uint8Array(512 * 1024);
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(chunk);
      if (reads === 3) controller.close();
    },
  });
  const result = await probeLocalComputeHost(host, dependencies((async () =>
    new Response(body, { status: 200 })) as typeof fetch));
  assert.equal(result.status, "unavailable");
  assert.equal(result.errorCode, "response_too_large");
  assert.deepEqual(result.capabilities, []);
  assert.equal(reads, 3, "the reader rejects on the first byte beyond the limit");
});

test("Local Compute privileged work and picker are wired through typed IPC", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const preload = readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8");
  const ui = readFileSync(path.join(ROOT, "src", "ui", "LocalComputeBlock.tsx"), "utf8");
  assert.match(main, /localCompute:probe/);
  assert.match(main, /localCompute:pickTokenFile/);
  assert.match(preload, /probeLocalCompute/);
  assert.match(preload, /pickLocalComputeTokenFile/);
  assert.doesNotMatch(preload, /readFileSync|Authorization: `Bearer/);
  assert.match(ui, /Advertised capabilities/);
  assert.match(ui, /Continuation capabilities/);
  assert.match(ui, /Allowed callers/);
  assert.match(ui, /LOCAL_COMPUTE_CALLER_ROLES/);
});
