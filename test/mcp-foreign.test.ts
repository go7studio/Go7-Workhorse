import assert from "node:assert/strict";
import test from "node:test";
import { buildGrokLaunchSpec } from "../electron/grok-launch";
import type { McpServerConfig } from "../src/lib/types";
import { applyCursorMcpHandoff, loadCursorMcpHandoff } from "../electron/mcp-foreign-load";
import { customTurnMcpServers } from "../electron/custom-host";
import {
  expandMcpText,
  grokMcpServerNames,
  materializeCursorMcpDocument,
  mergeDeskAndForeignMcp,
} from "../src/lib/mcp-foreign";
import { restrictMcpServersToTools } from "../src/lib/mcp-servers";

const ENV = {
  USERPROFILE: "C:\\Users\\sgovo",
  HOME: "C:\\Users\\sgovo",
  LOCALAPPDATA: "C:\\Users\\sgovo\\AppData\\Local",
};

test("Cursor ${env:USERPROFILE} becomes a real path before an agent is handed the server", () => {
  const raw = {
    mcpServers: {
      lovart: {
        command: "py",
        args: ["-3", "${env:USERPROFILE}\\.lovart\\server.py"],
        env: {
          LOVART_ENV_FILE: "${env:USERPROFILE}\\.lovart\\lovart.env",
          LOVART_SKILL_DIR: "${env:USERPROFILE}\\.lovart",
        },
      },
    },
  };
  const result = materializeCursorMcpDocument(raw, {
    env: ENV,
    home: ENV.USERPROFILE,
    cwd: "D:\\GitHub\\Go7-Workhorse",
    platform: "win32",
  });
  assert.equal(result.ownsImport, true);
  assert.equal(result.skipped.length, 0);
  const lovart = result.servers[0];
  assert.equal(lovart?.name, "lovart");
  assert.equal(lovart?.command, "py");
  assert.deepEqual(lovart?.args, ["-3", "C:\\Users\\sgovo\\.lovart\\server.py"]);
  assert.equal(lovart?.env?.LOVART_ENV_FILE, "C:\\Users\\sgovo\\.lovart\\lovart.env");
  assert.equal(JSON.stringify(lovart).includes("${"), false);
  assert.equal(lovart?.args[1]?.startsWith("D:\\GitHub\\Go7-Workhorse"), false);
});

test("a placeholder that cannot be resolved is not launched", () => {
  const result = materializeCursorMcpDocument(
    { mcpServers: { lovart: { command: "py", args: ["${env:MISSING}\\server.py"] } } },
    { env: ENV, home: ENV.USERPROFILE, cwd: "D:\\work", platform: "win32" },
  );
  assert.deepEqual(result.servers, []);
  assert.match(result.skipped[0]?.reason ?? "", /MISSING/);
  assert.equal(result.ownsImport, true);
});

test("remote Cursor rows stay with the client that already speaks HTTP", () => {
  const result = materializeCursorMcpDocument(
    {
      mcpServers: {
        lovart: { command: "py", args: ["${env:USERPROFILE}\\.lovart\\server.py"] },
        figma: { url: "https://mcp.figma.com/mcp" },
      },
    },
    { env: ENV, home: ENV.USERPROFILE, platform: "win32" },
  );
  assert.equal(result.ownsImport, false);
  assert.deepEqual(result.servers, []);
  assert.ok(result.skipped.some((row) => row.name === "figma" && row.reason === "remote"));
});

test("desk rows and Grok config.toml names are not started a second time", () => {
  const foreign = materializeCursorMcpDocument(
    {
      mcpServers: {
        lovart: { command: "py", args: ["${env:USERPROFILE}\\.lovart\\server.py"] },
        remotion: { command: "npx", args: ["@remotion/mcp@latest"] },
      },
    },
    { env: ENV, home: ENV.USERPROFILE, platform: "win32" },
  ).servers;
  const merged = mergeDeskAndForeignMcp(
    [{ name: "lovart", command: "C:\\Python\\python.exe", args: ["server.py"], enabled: false }],
    foreign,
    ["Roblox_Studio"],
  );
  assert.equal(merged.find((server) => server.name === "lovart")?.command, "C:\\Python\\python.exe");
  assert.equal(merged.find((server) => server.name === "remotion")?.command, "npx");
  assert.equal(merged.some((server) => server.name === "Roblox_Studio"), false);
  assert.deepEqual(grokMcpServerNames("[mcp_servers.lovart.env]\nLOVART_ENV_FILE = 'x'\n\n[mcp_servers.Roblox_Studio]\ncommand = 'cmd.exe'\n"), ["lovart", "Roblox_Studio"]);
});

test("user and project Cursor files merge, and only Grok is told to skip the raw import", () => {
  const home = "C:\\Users\\ci";
  const cwd = "D:\\work";
  const files: Record<string, string> = {
    "C:\\Users\\ci\\.cursor\\mcp.json": JSON.stringify({
      mcpServers: {
        lovart: { command: "py", args: ["${env:USERPROFILE}\\.lovart\\server.py"] },
        shared: { command: "user-copy", args: [] },
      },
    }),
    "D:\\work\\.cursor\\mcp.json": JSON.stringify({
      mcpServers: { shared: { command: "project-copy", args: ["${workspaceFolder}\\tool.py"] } },
    }),
    "C:\\Users\\ci\\.grok\\config.toml": "[mcp_servers.lovart]\ncommand = 'python.exe'\n",
  };
  const io = {
    home,
    platform: "win32" as const,
    env: ENV,
    readFile: (file: string) => {
      const text = files[file];
      if (text === undefined) throw new Error(`missing ${file}`);
      return text;
    },
  };
  const loaded = loadCursorMcpHandoff(cwd, io);
  assert.equal(loaded.suppressCursorMcpImport, true);
  assert.equal(loaded.servers.find((server) => server.name === "shared")?.command, "project-copy");
  assert.equal(loaded.servers.find((server) => server.name === "shared")?.args[0], "D:\\work\\tool.py");
  const grok = applyCursorMcpHandoff("grok", { cwd, mcpServers: [] as McpServerConfig[] }, [], io);
  assert.equal(grok.suppressCursorMcpImport, true);
  assert.deepEqual(grok.mcpServers?.map((server) => server.name), ["shared"]);
  const cursor = applyCursorMcpHandoff("cursor", { cwd, mcpServers: [{ name: "kept", command: "kept", args: [] }] satisfies McpServerConfig[] }, [], io);
  assert.equal(cursor.suppressCursorMcpImport, false);
  assert.deepEqual(cursor.mcpServers?.map((server) => server.name), ["kept"]);
  const spec = buildGrokLaunchSpec({
    model: "grok-4.7",
    effort: "high",
    cwd,
    mode: "always-approve",
    mcpServers: grok.mcpServers,
    suppressCursorMcpImport: grok.suppressCursorMcpImport,
  });
  assert.equal(spec.suppressCursorMcpImport, true);
  assert.equal(spec.sessionParams.mcpServers.some((server) => server.name === "shared"), true);
  assert.equal(spec.sessionParams.mcpServers.some((server) => server.name === "lovart"), false);
});

test("Claude and project mcp.json expand, and a remote row does not drop Cursor stdio", () => {
  const home = "C:\\Users\\ci";
  const cwd = "D:\\work";
  const files: Record<string, string> = {
    "C:\\Users\\ci\\.cursor\\mcp.json": JSON.stringify({
      mcpServers: {
        shared: { command: "user-copy", args: ["${env:USERPROFILE}\\.cursor\\tool.py"] },
      },
    }),
    "C:\\Users\\ci\\.claude.json": JSON.stringify({
      numStartups: 3,
      mcpServers: {
        papers: { command: "py", args: ["${env:USERPROFILE}\\.papers\\server.py"] },
      },
    }),
    "D:\\work\\.mcp.json": JSON.stringify({
      mcpServers: {
        local: { command: "node", args: ["${workspaceFolder}\\mcp.js"] },
      },
    }),
    "D:\\work\\.claude\\mcp.json": JSON.stringify({
      mcpServers: {
        figma: { url: "https://mcp.figma.com/mcp" },
        dropped: { command: "node", args: ["same-file.js"] },
      },
    }),
  };
  const io = {
    home,
    platform: "win32" as const,
    env: { ...ENV, USERPROFILE: home, HOME: home },
    readFile: (file: string) => {
      const text = files[file];
      if (text === undefined) throw new Error(`missing ${file}`);
      return text;
    },
  };
  const loaded = loadCursorMcpHandoff(cwd, io);
  assert.equal(loaded.suppressCursorMcpImport, true);
  assert.equal(loaded.servers.find((server) => server.name === "papers")?.args[0], "C:\\Users\\ci\\.papers\\server.py");
  assert.equal(loaded.servers.find((server) => server.name === "local")?.args[0], "D:\\work\\mcp.js");
  assert.equal(loaded.servers.some((server) => server.name === "figma" || server.name === "dropped"), false);
  assert.equal(loaded.origins.papers, "claude");
  assert.equal(loaded.origins.local, "mcp");
  const grok = applyCursorMcpHandoff("grok", { cwd, mcpServers: [] as McpServerConfig[] }, [], io);
  assert.ok(grok.mcpServers?.some((server) => server.name === "papers"));
  assert.ok(grok.mcpServers?.some((server) => server.name === "local"));
  const claude = applyCursorMcpHandoff("claude", { cwd, mcpServers: [] as McpServerConfig[] }, [], io);
  assert.deepEqual(claude.mcpServers?.map((server) => server.name), ["shared"]);
  assert.equal(claude.suppressCursorMcpImport, false);
});

test("a custom turn restricts foreign MCP servers again, and an ACP list does not", () => {
  const desk = [
    { name: "lovart", command: "py", args: [], includeTools: ["lovart_query_mode", "lovart_generate"] },
    { name: "memory", command: "mem", args: [] },
  ] satisfies McpServerConfig[];
  const foreign = [{ name: "github", command: "gh", args: [] }] satisfies McpServerConfig[];
  const namedTool = restrictMcpServersToTools(desk, ["lovart_query_mode"], "custom");
  const mergedTool = mergeDeskAndForeignMcp(namedTool, foreign);
  assert.deepEqual(mergedTool.map((server) => server.name), ["lovart", "github"]);
  const customTool = customTurnMcpServers(mergedTool);
  assert.deepEqual(customTool.map((server) => server.name), ["lovart"]);
  assert.deepEqual(customTool[0]?.includeTools, ["lovart_query_mode"]);
  assert.equal(customTool[0]?.sliceTools, undefined);

  // The slice named a server that arrives only with the foreign merge. The
  // first filter matches nothing and keeps the desk list. The second keeps
  // the named foreign server, not every schema.
  const namedForeign = restrictMcpServersToTools(desk, ["github"], "custom");
  assert.equal(namedForeign.length, desk.length);
  const customForeign = customTurnMcpServers(mergeDeskAndForeignMcp(namedForeign, foreign));
  assert.deepEqual(customForeign.map((server) => server.name), ["github"]);

  const acp = restrictMcpServersToTools(mergeDeskAndForeignMcp(desk, foreign), ["lovart_query_mode"], "grok");
  assert.deepEqual(acp.map((server) => server.name), ["lovart", "memory", "github"]);
  assert.equal(acp.some((server) => server.sliceTools), false);
});

test("home and Windows percent placeholders expand", () => {
  const home = expandMcpText("~/.lovart/server.py", { env: ENV, home: ENV.USERPROFILE, platform: "win32" });
  assert.equal(home.text, "C:\\Users\\sgovo\\.lovart/server.py");
  assert.deepEqual(home.unresolved, []);
  const percent = expandMcpText("%LOCALAPPDATA%\\Go7\\server.py", { env: ENV, home: ENV.USERPROFILE, platform: "win32" });
  assert.equal(percent.text, "C:\\Users\\sgovo\\AppData\\Local\\Go7\\server.py");
});
