import assert from "node:assert/strict";
import test from "node:test";
import { invokeMediaCreate, mediaCreateGate } from "../electron/local-media-create";
import type { LocalComputeHostSettings } from "../src/lib/local-compute";

function host(partial: Partial<LocalComputeHostSettings> = {}): LocalComputeHostSettings {
  return {
    id: "box",
    label: "Box",
    enabled: true,
    baseUrl: "http://127.0.0.1:8787",
    tokenFile: "/tmp/token",
    allowedCapabilities: ["comfy.flux"],
    allowedCallerRoles: ["desk"],
    allowedContinuations: [],
    ...partial,
  } as LocalComputeHostSettings;
}

test("mediaCreateGate refuses empty capabilities with the strip wording", () => {
  const gate = mediaCreateGate([host({ allowedCapabilities: [] })], {
    hostId: "box",
    capability: "comfy.flux",
    templateId: "flux-still",
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /Local Compute host has no allowed capabilities/);
});

test("mediaCreateGate refuses a capability that is not allowed", () => {
  const gate = mediaCreateGate([host()], {
    hostId: "box",
    capability: "comfy.video",
    templateId: "clip",
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /not allowed/);
});

test("invokeMediaCreate returns the empty-caps message when the client is forced null", async () => {
  const result = await invokeMediaCreate(
    { hosts: [host()], stateDir: "/tmp/local-media-create-test", client: null },
    { hostId: "box", capability: "comfy.flux", templateId: "flux-still", fields: { prompt: "hi" } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Local Compute host has no allowed capabilities/);
});

/**
 * The gate checks the template id, but the constraints were built as
 * `{ templateId, ...fields }`, and templateId is a legal field name. A field of
 * that name replaced the checked id with one that never passed the gate.
 */
test("invokeMediaCreate sends the template id the gate checked, whatever the fields say", async () => {
  const sent: Array<{ hostId: string; constraints: Record<string, unknown> }> = [];
  const client = {
    submit: async (hostId: string, request: { constraints: Record<string, unknown> }) => {
      sent.push({ hostId, constraints: request.constraints });
      return { id: "job_0123456789abcdef0123456789abcdef" };
    },
  } as unknown as NonNullable<Parameters<typeof invokeMediaCreate>[0]["client"]>;
  const result = await invokeMediaCreate(
    { hosts: [host()], stateDir: "/unused", client },
    { hostId: "box", capability: "comfy.flux", templateId: "flux-still", fields: { prompt: "hi", templateId: "../../unchecked" } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [{ hostId: "box", constraints: { prompt: "hi", templateId: "flux-still" } }]);
});
