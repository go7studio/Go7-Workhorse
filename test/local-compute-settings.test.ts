import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  advertisedLocalComputeContinuations,
  isAbsoluteTokenFile,
  localComputeHostCallable,
  normalizeLocalComputeSettings,
  staleLocalComputeContinuationGrants,
  toggleLocalComputeContinuationGrant,
} from "../src/lib/local-compute";
import { normalizeSettings } from "../src/lib/settings";
import { readVersionedState, writeVersionedState } from "../electron/state-persistence";

test("local compute settings preserve only safe host metadata and explicit grants", () => {
  const settings = normalizeLocalComputeSettings({
    version: 99,
    hosts: [{
      id: "host-a", label: "  Studio compute  ", baseUrl: "https://compute.example.test/run/",
      tokenFile: "/private/host.token", enabled: true,
      allowedCallerRoles: ["desk", "worker", "worker", "root"],
      allowedCapabilities: ["text.generate", "asset.mesh.create", "bad capability"],
      allowedContinuations: [
        { capability: "asset.review", tool: "asset.review_item" },
        { capability: "asset.review", tool: "asset.review_item" },
        { capability: "bad capability", tool: "bad tool" },
      ],
      token: "must-not-survive", apiKey: "must-not-survive",
    }],
  });
  assert.deepEqual(settings, { version: 1, legacyEnvironmentFallback: true, hosts: [{
    id: "host-a", label: "Studio compute", baseUrl: "https://compute.example.test/run",
    tokenFile: "/private/host.token", enabled: true, allowedCallerRoles: ["desk", "worker"],
    allowedCapabilities: ["text.generate", "asset.mesh.create"],
    allowedContinuations: [{ capability: "asset.review", tool: "asset.review_item" }],
  }] });
  assert.doesNotMatch(JSON.stringify(settings), /must-not-survive|apiKey|"token"/);
});

test("legacy environment fallback is migration-only and explicit edits stay authoritative", () => {
  assert.equal(normalizeLocalComputeSettings(undefined).legacyEnvironmentFallback, true);
  assert.equal(normalizeLocalComputeSettings({ version: 1, hosts: [], legacyEnvironmentFallback: false }).legacyEnvironmentFallback, false);
});

test("local compute normalization is fail closed", () => {
  const settings = normalizeLocalComputeSettings({ hosts: [
    { id: "remote-http", baseUrl: "http://compute.example.test", tokenFile: "/token" },
    { id: "creds", baseUrl: "https://user:pass@example.test", tokenFile: "/token" },
    { id: "query", baseUrl: "https://example.test?token=secret", tokenFile: "/token" },
    { id: "relative", baseUrl: "https://example.test", tokenFile: "token.txt" },
    { id: "local", label: "Local", baseUrl: "http://127.0.0.1:8900/api", tokenFile: "/token" },
    { id: "local", label: "Duplicate", baseUrl: "https://other.example", tokenFile: "/other" },
  ] });
  assert.equal(settings.hosts.length, 1);
  assert.equal(settings.hosts[0]?.id, "local");
  assert.deepEqual(settings.hosts[0]?.allowedCallerRoles, []);
  assert.deepEqual(settings.hosts[0]?.allowedCapabilities, []);
  assert.deepEqual(settings.hosts[0]?.allowedContinuations, []);
  assert.equal(localComputeHostCallable(settings.hosts[0]!, "desk", "anything"), false);
});

test("token references accept packaged Windows and POSIX absolute paths", () => {
  assert.equal(isAbsoluteTokenFile("/Users/person/.config/host-token"), true);
  assert.equal(isAbsoluteTokenFile("C:\\Users\\person\\host-token"), true);
  assert.equal(isAbsoluteTokenFile("\\\\server\\private\\host-token"), true);
  assert.equal(isAbsoluteTokenFile(".\\host-token"), false);
});

test("local compute callable check requires host, role, and capability grants", () => {
  const host = normalizeLocalComputeSettings({ hosts: [{
    id: "host-a", label: "Host", baseUrl: "https://compute.example.test", tokenFile: "/token",
    enabled: true, allowedCallerRoles: ["auditor"], allowedCapabilities: ["artifact.inspect"],
    allowedContinuations: [],
  }] }).hosts[0]!;
  assert.equal(localComputeHostCallable(host, "auditor", "artifact.inspect"), true);
  assert.equal(localComputeHostCallable(host, "worker", "artifact.inspect"), false);
  assert.equal(localComputeHostCallable(host, "auditor", "artifact.create"), false);
  assert.equal(localComputeHostCallable({ ...host, enabled: false }, "auditor", "artifact.inspect"), false);
});

test("safe local compute metadata survives the shared versioned state file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-local-compute-"));
  const file = path.join(dir, "state.json");
  try {
    writeVersionedState(file, { settings: { localCompute: { version: 1, hosts: [{
      id: "host-a", label: "Host", baseUrl: "https://compute.example.test", tokenFile: "/private/token",
      enabled: true, allowedCallerRoles: ["external-runtime"], allowedCapabilities: ["artifact.create"],
      allowedContinuations: [{ capability: "artifact.review", tool: "artifact.review_item" }],
    }] } } }, (state) => state);
    const restored = normalizeSettings((readVersionedState(file).state.settings as Record<string, unknown>)).localCompute;
    assert.equal(restored.hosts[0]?.id, "host-a");
    assert.deepEqual(restored.hosts[0]?.allowedCallerRoles, ["external-runtime"]);
    assert.deepEqual(restored.hosts[0]?.allowedCapabilities, ["artifact.create"]);
    assert.deepEqual(restored.hosts[0]?.allowedContinuations, [{ capability: "artifact.review", tool: "artifact.review_item" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("continuation families are distinct, deduplicated, and checked for stale exact tool grants", () => {
  const advertised = advertisedLocalComputeContinuations([
    {
      id: "artifact.create", profileId: "profile-a", description: "Create", inputKinds: [], outputRoles: [],
      estimatedMemoryGb: 1, asynchronous: true,
      continuations: [{ capability: "artifact.review", tool: "artifact.review_item", outputRoles: ["report"] }],
    },
    {
      id: "artifact.refine", profileId: "profile-b", description: "Refine", inputKinds: [], outputRoles: [],
      estimatedMemoryGb: 1, asynchronous: true,
      continuations: [{ capability: "artifact.review", tool: "artifact.review_item", outputRoles: ["report"] }],
    },
  ]);
  assert.deepEqual(advertised, [{
    capability: "artifact.review",
    tool: "artifact.review_item",
    outputRoles: ["report"],
    sourceCapabilityIds: ["artifact.create", "artifact.refine"],
  }]);
  assert.deepEqual(staleLocalComputeContinuationGrants([
    { capability: "artifact.review", tool: "artifact.review_item" },
    { capability: "artifact.review", tool: "artifact.other_review" },
  ], advertised), [
    { capability: "artifact.review", tool: "artifact.other_review" },
  ]);
  const granted = toggleLocalComputeContinuationGrant([], advertised[0]!);
  assert.deepEqual(granted, [{ capability: "artifact.review", tool: "artifact.review_item" }]);
  assert.deepEqual(toggleLocalComputeContinuationGrant(granted, advertised[0]!), []);
});
