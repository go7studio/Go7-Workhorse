import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GrokAgent } from "../electron/grok-agent";
import { launchKey } from "../electron/grok-host";
import { buildGrokLaunchSpec, matchContextWindowValue, parseWindowLabel, type GrokLaunchSpec } from "../electron/grok-launch";
import { listVendorModels, parseGrokModelsCache, readDeskCatalog, rememberDeskCatalog } from "../electron/vendor-models";
import { applyVendorCatalog, contextWindowFor, contextWindowsFor, resetVendorCatalog } from "../src/lib/models";
import { normalizeSession } from "../src/lib/session";
import { fakeAcpVendor, type FakeAcpMessage } from "./fake-acp-vendor";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const GROK_CACHE = JSON.stringify({
  models: {
    "grok-4.7": {
      info: {
        id: "grok-4.7",
        name: "Grok 4.7",
        context_window: 256000,
        context_windows: [500000, 256000, 256000],
        supports_reasoning_effort: true,
      },
    },
    "grok-4.7-build-fast": {
      info: {
        id: "grok-4.7-build-fast",
        name: "Grok 4.7 Fast",
        context_window: 256000,
        context_windows: [256000, 500000],
      },
    },
    "grok-4.5": {
      info: { id: "grok-4.5", name: "Grok 4.5", context_window: 256000 },
    },
  },
});

test("a Grok cache row keeps both windows and the smaller one as the default", () => {
  const models = parseGrokModelsCache(GROK_CACHE);
  const full = models.find((model) => model.id === "grok-4.7");
  const fast = models.find((model) => model.id === "grok-4.7-build-fast");
  const single = models.find((model) => model.id === "grok-4.5");
  assert.equal(full?.contextWindow, 256_000);
  assert.deepEqual(full?.contextWindows, [256_000, 500_000]);
  assert.deepEqual(fast?.contextWindows, [256_000, 500_000]);
  assert.equal(single?.contextWindow, 256_000);
  assert.equal(single?.contextWindows, undefined);
});

test("a chat's pick is the window only when the model offers it", () => {
  const home = path.join(ROOT, "does-not-exist");
  const cache = path.join(home, ".grok", "models_cache.json");
  const listed = listVendorModels({
    env: {},
    homedir: home,
    existsSync: (file) => file === cache,
    readFile: (file) => (file === cache ? GROK_CACHE : ""),
    cursorModelsOutput: null,
  });
  try {
    applyVendorCatalog(listed);
    assert.deepEqual(contextWindowsFor("grok", "grok-4.7"), [256_000, 500_000]);
    assert.equal(contextWindowFor("grok", "grok-4.7"), 256_000);
    assert.equal(contextWindowFor("grok", "grok-4.7", undefined, undefined, 500_000), 500_000);
    assert.equal(contextWindowFor("grok", "grok-4.7", undefined, undefined, 128_000), 256_000);
    assert.deepEqual(contextWindowsFor("grok", "grok-4.5"), []);
    assert.equal(contextWindowFor("claude", "claude-sonnet-5", undefined, undefined, 500_000), 1_000_000);
  } finally {
    resetVendorCatalog();
  }
});

test("the saved desk catalog keeps both windows", () => {
  const home = path.join(ROOT, "does-not-exist");
  const cache = path.join(home, ".grok", "models_cache.json");
  const served = listVendorModels({
    env: {},
    homedir: home,
    existsSync: (file) => file === cache,
    readFile: (file) => (file === cache ? GROK_CACHE : ""),
    cursorModelsOutput: null,
  });
  const userData = mkdtempSync(path.join(os.tmpdir(), "wh-context-windows-"));
  try {
    assert.equal(rememberDeskCatalog(userData, served), true);
    const lists = readDeskCatalog(userData);
    const row = lists?.grok?.find((model) => model.id === "grok-4.7");
    assert.equal(row?.contextWindow, 256_000);
    assert.deepEqual(row?.contextWindows, [256_000, 500_000]);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a saved chat keeps the window it picked", () => {
  const kept = normalizeSession({
    id: "chat",
    provider: "grok",
    model: "grok-4.7",
    contextWindow: 500_000,
  });
  assert.equal(kept?.contextWindow, 500_000);
  const dropped = normalizeSession({ id: "chat", provider: "grok", model: "grok-4.7", contextWindow: 0 });
  assert.equal(dropped?.contextWindow, undefined);
});

test("changing the window does not change the launch key", () => {
  const base = {
    model: "grok-4.7",
    effort: "high" as const,
    mode: "ask" as const,
    cwd: "C:\\repo",
    sandbox: "off" as const,
  };
  const withWindow = { ...base, contextWindow: 500_000 };
  assert.equal(launchKey(base), launchKey(withWindow));
  const spec = buildGrokLaunchSpec(withWindow);
  assert.equal(spec.contextWindow, 500_000);
  assert.equal(spec.argv.some((arg) => /context/i.test(arg)), false);
  assert.equal(JSON.stringify(spec.sessionParams._meta ?? {}).includes("500000"), false);
  assert.equal(parseWindowLabel("500k"), 500_000);
  assert.equal(parseWindowLabel("0.5m"), 500_000);
  assert.equal(matchContextWindowValue(500_000, { options: [{ value: "256k" }, { value: "500k" }] }), "500k");
  assert.equal(matchContextWindowValue(128_000, { options: [{ value: "256k" }, { value: "500k" }] }), undefined);
});

const configCalls = (seen: FakeAcpMessage[]) =>
  seen.filter((message) => message.method === "session/set_config_option").map((message) => message.params);

function grokSpec(patch: Partial<GrokLaunchSpec> = {}): GrokLaunchSpec {
  return {
    command: "grok",
    argv: [],
    cwd: "",
    model: "grok-4.7",
    effort: "medium",
    alwaysApprove: false,
    sandbox: "off",
    initializeParams: {
      protocolVersion: 1,
      clientInfo: { name: "test", title: "test", version: "0" },
      clientCapabilities: { sessionLoad: true, permissionPrompts: true },
    },
    sessionParams: { cwd: "", mcpServers: [] },
    ...patch,
  };
}

function vendorWith(options: unknown[]) {
  return fakeAcpVendor((message, vendor) => {
    if (message.method === "session/new" || message.method === "session/load") {
      vendor.send({ id: message.id, result: { sessionId: "saved", configOptions: options } });
      return true;
    }
    return false;
  });
}

const WINDOWS = [
  { id: "effort", currentValue: "medium", options: [{ value: "medium" }, { value: "high" }] },
  { id: "context_window", currentValue: "256000", options: [{ value: "256000" }, { value: "500k" }] },
];

test("a warm Grok session is asked for the window this chat picked", async () => {
  const vendor = vendorWith(WINDOWS);
  const agent = new GrokAgent(grokSpec({ contextWindow: 256_000 }), () => vendor.child);
  try {
    await agent.start();
    assert.deepEqual(configCalls(vendor.seen), []);
    await agent.preferContextWindow(500_000);
    assert.deepEqual(configCalls(vendor.seen), [{ sessionId: "saved", configId: "context_window", value: "500k" }]);
    await agent.preferContextWindow(500_000);
    assert.equal(configCalls(vendor.seen).length, 1);
  } finally {
    agent.dispose();
  }
});

test("a session that does not advertise a window is not asked", async () => {
  const vendor = vendorWith([{ id: "effort", currentValue: "medium", options: [{ value: "medium" }] }]);
  const agent = new GrokAgent(grokSpec({ contextWindow: 500_000 }), () => vendor.child);
  try {
    await agent.start();
    assert.deepEqual(configCalls(vendor.seen), []);
  } finally {
    agent.dispose();
  }
});

test("Claude is not sent a Grok window", async () => {
  const vendor = vendorWith(WINDOWS);
  const agent = new GrokAgent(grokSpec({ agentLabel: "Claude", contextWindow: 500_000 }), () => vendor.child);
  try {
    await agent.start();
    assert.deepEqual(configCalls(vendor.seen), []);
  } finally {
    agent.dispose();
  }
});

test("chat settings puts Context next to Reasoning", () => {
  const setup = read("src/ui/SessionSetup.tsx");
  const stack = setup.slice(setup.indexOf("setup-compact-stack"), setup.indexOf("setup-access-card"));
  assert.ok(stack.indexOf("Reasoning level") < stack.indexOf(">Context<"));
  assert.match(stack, /aria-label="Context window"/);
  assert.match(stack, /setSessionContextWindow\(size\)/);
  assert.match(stack, /How much this chat can hold\./);
  const store = read("src/lib/store.tsx");
  const setter = store.slice(store.indexOf("const setSessionContextWindow"), store.indexOf("const setSessionEnvironment"));
  assert.match(setter, /contextWindowsFor\(session\.provider, session\.model\)/);
  assert.doesNotMatch(setter, /vendorSessionId/);
});
