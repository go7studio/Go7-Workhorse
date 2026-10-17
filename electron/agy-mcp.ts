import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "../src/lib/types";
import { mergeMcpServers, type GrokMcpServer } from "./grok-launch";

// Keep hydrated server credentials in the process environment, never the
// temporary workspace config. Each shim receives only its own server's env.
export const AGY_MCP_SHIM = `
const {spawn}=require('node:child_process');
const key=process.argv[1];
const config=JSON.parse(process.env[key]);
const env={...process.env};
for(const name of Object.keys(env)) if(name.startsWith('WORKHORSE_AGY_MCP_')) delete env[name];
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(config.command,config.args,{stdio:'inherit',env:{...env,...config.env},cwd:config.cwd});
child.on('error',()=>process.exit(1));
child.on('exit',code=>process.exit(code??1));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
`;

export function createAgyMcpOverlay(input: { cwd: string; mcpServers?: McpServerConfig[] }, builtIn: GrokMcpServer | null = null) {
  const servers = mergeMcpServers(input.mcpServers, builtIn);
  if (!servers.length) return undefined;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-agy-mcp-"));
  const dispose = () => fs.rmSync(folder, { recursive: true, force: true });
  try {
    fs.chmodSync(folder, 0o700);
    const agents = path.join(folder, ".agents");
    fs.mkdirSync(agents, { mode: 0o700 });
    const env: Record<string, string> = {};
    const mcpServers = Object.fromEntries(servers.map((server) => {
      const key = `WORKHORSE_AGY_MCP_${randomUUID().replaceAll("-", "")}`;
      env[key] = JSON.stringify({ command: server.command, args: server.args, cwd: input.cwd,
        env: Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) });
      return [server.name, { command: process.execPath, args: ["-e", AGY_MCP_SHIM, key], env: { ELECTRON_RUN_AS_NODE: "1" } }];
    }));
    fs.writeFileSync(path.join(agents, "mcp_config.json"), JSON.stringify({ mcpServers }), { mode: 0o600 });
    return { folder, env, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
