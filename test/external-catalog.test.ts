import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogFromStatuses,
  detectAgentRuntime,
  detectAllRuntimes,
  hermesConfigPath,
  openClawConfigPath,
  parseCatalogAgents,
  projectExternalAgentCatalog,
} from "../src/lib/external-catalog";

test("detect uses injected home and never os.homedir", () => {
  const source = detectAgentRuntime.toString();
  assert.doesNotMatch(source, /os\.homedir|os\.homedir\(/);
  const mac = openClawConfigPath({ home: "/Users/ci", platform: "darwin" });
  assert.equal(mac, "/Users/ci/.openclaw/openclaw.json");
  const win = openClawConfigPath({ home: "C:\\Users\\ci", platform: "win32" });
  assert.equal(win, "C:\\Users\\ci\\.openclaw\\openclaw.json");
  assert.equal(hermesConfigPath({ home: "/Users/ci", platform: "darwin" }), "/Users/ci/.hermes/config.yaml");
});

test("macOS and Windows fixtures report four independent flags", () => {
  const exists = new Set([
    "/Users/ci/.openclaw/openclaw.json",
    "/Users/ci/.local/bin/openclaw",
    "C:\\Users\\ci\\.hermes\\config.yaml",
    "C:\\Users\\ci\\AppData\\Local\\hermes\\hermes.exe",
  ]);
  const mac = detectAgentRuntime(
    "openclaw",
    { home: "/Users/ci", platform: "darwin", pathEnv: "/Users/ci/.local/bin" },
    {
      existsSync: (file) => exists.has(file),
      execFile: (file) =>
        file.endsWith("openclaw")
          ? { status: 0, stdout: "openclaw 2026.4.0\n", stderr: "" }
          : { status: 1, stdout: "", stderr: "" },
    },
  );
  assert.equal(mac.binaryPresent, true);
  assert.equal(mac.configPresent, true);
  assert.equal(mac.version, "2026.4.0");
  assert.equal(mac.authenticated, true);
  assert.equal(mac.reachable, true);

  const win = detectAgentRuntime(
    "hermes",
    { home: "C:\\Users\\ci", platform: "win32", pathEnv: "" },
    {
      existsSync: (file) => exists.has(file),
      execFile: () => ({ status: 1, stdout: "login required", stderr: "" }),
    },
  );
  assert.equal(win.binaryPresent, true);
  assert.equal(win.configPresent, true);
  assert.equal(win.authenticated, false);
  assert.equal(win.reachable, false);
});

test("missing runtime is an empty catalog, not a failed task", () => {
  const statuses = detectAllRuntimes(
    { home: "/empty", platform: "darwin", pathEnv: "" },
    { existsSync: () => false },
  );
  assert.equal(catalogFromStatuses(statuses).length, 0);
  assert.ok(statuses.every((item) => !item.binaryPresent && !item.configPresent));
});

test("default catalog entries are openclaw/main and hermes/default", () => {
  const agents = catalogFromStatuses([
    { runtimeId: "openclaw", binaryPresent: true, configPresent: true, authenticated: true, reachable: true },
    { runtimeId: "hermes", binaryPresent: true, configPresent: false, authenticated: false, reachable: false },
  ]);
  assert.deepEqual(
    agents.map((item) => item.name),
    ["openclaw/main", "hermes/default"],
  );
  const parsed = parseCatalogAgents("openclaw", [{ id: "research" }, { name: "main" }]);
  assert.ok(parsed.some((item) => item.agentId === "research"));
});

test("external agent discovery lists the catalog, not past tasks or workspace paths", () => {
  const snapshot = projectExternalAgentCatalog({
    agents: [
      { runtimeId: "openclaw", agentId: "main", name: "openclaw/main", workspace: "/Users/foo/.openclaw" },
      { runtimeId: "hermes", agentId: "research", name: "hermes/research", workspace: "/tmp/hermes" },
    ],
    runtimes: [
      { runtimeId: "openclaw", binaryPresent: true, configPresent: true, authenticated: true, reachable: true },
      { runtimeId: "hermes", binaryPresent: true, configPresent: true, authenticated: true, reachable: true },
    ],
    now: Date.parse("2026-08-19T12:00:00.000Z"),
  });
  assert.deepEqual(
    snapshot.agents.map((item) => item.id),
    ["openclaw/main", "hermes/research"],
  );
  assert.equal(snapshot.agents[0]?.reachable, true);
  const encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /ext_|status|completed|\/Users\/foo|\.openclaw|\/tmp\/hermes/);
});
