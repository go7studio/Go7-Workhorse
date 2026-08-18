import { isAgentRuntimeId, type AgentRuntimeId } from "./agent-runtime";
import type { ExternalAgentRef } from "./types";

export type DetectIo = {
  existsSync: (path: string) => boolean;
  execFile?: (file: string, args: string[]) => { status: number; stdout: string; stderr: string };
};

export type AgentRuntimeStatus = {
  runtimeId: AgentRuntimeId;
  binaryPresent: boolean;
  configPresent: boolean;
  version?: string;
  authenticated: boolean;
  reachable: boolean;
  binaryPath?: string;
  configPath?: string;
};

export type ExternalAgent = ExternalAgentRef & {
  name: string;
  workspace?: string;
};

export type CatalogPaths = {
  home: string;
  pathEnv?: string;
  platform: "darwin" | "win32" | "linux";
  env?: Record<string, string | undefined>;
};

function joinHome(home: string, ...parts: string[]): string {
  const slash = home.includes("\\") || /^[A-Za-z]:/.test(home) ? "\\" : "/";
  const trimmed = home.replace(/[\\/]+$/, "");
  return [trimmed, ...parts].join(slash);
}

export function openClawConfigPath(input: Pick<CatalogPaths, "home" | "platform">): string {
  return joinHome(input.home, ".openclaw", "openclaw.json");
}

export function hermesConfigPath(input: Pick<CatalogPaths, "home" | "platform">): string {
  return joinHome(input.home, ".hermes", "config.yaml");
}

export function hermesProfilesPath(input: Pick<CatalogPaths, "home" | "platform">): string {
  return joinHome(input.home, ".hermes", "profiles.json");
}

function pathEntries(pathEnv: string | undefined, platform: CatalogPaths["platform"]): string[] {
  if (!pathEnv) return [];
  return pathEnv.split(platform === "win32" ? ";" : ":").filter(Boolean);
}

function binaryCandidates(runtimeId: AgentRuntimeId, input: CatalogPaths): string[] {
  const names = runtimeId === "openclaw" ? ["openclaw", "openclaw.exe"] : ["hermes", "hermes.exe"];
  const dirs = pathEntries(input.pathEnv, input.platform);
  const extra =
    input.platform === "win32"
      ? [joinHome(input.home, "AppData", "Local", runtimeId), joinHome(input.home, runtimeId)]
      : [joinHome(input.home, ".local", "bin"), "/usr/local/bin"];
  const hits: string[] = [];
  for (const dir of [...dirs, ...extra]) {
    for (const name of names) {
      hits.push(dir.endsWith("\\") || dir.endsWith("/") ? `${dir}${name}` : `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`);
    }
  }
  return hits;
}

function readFlag(io: DetectIo, file: string, args: string[]): { ok: boolean; text: string } {
  if (!io.execFile) return { ok: false, text: "" };
  try {
    const result = io.execFile(file, args);
    return { ok: result.status === 0, text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
  } catch {
    return { ok: false, text: "" };
  }
}

export function detectAgentRuntime(runtimeId: AgentRuntimeId, paths: CatalogPaths, io: DetectIo): AgentRuntimeStatus {
  const configPath = runtimeId === "openclaw" ? openClawConfigPath(paths) : hermesConfigPath(paths);
  const configPresent = io.existsSync(configPath);
  let binaryPath: string | undefined;
  for (const candidate of binaryCandidates(runtimeId, paths)) {
    if (io.existsSync(candidate)) {
      binaryPath = candidate;
      break;
    }
  }
  const binaryPresent = Boolean(binaryPath);
  let version: string | undefined;
  let authenticated = false;
  let reachable = false;
  if (binaryPath) {
    const versionHit = readFlag(io, binaryPath, ["--version"]);
    const match = versionHit.text.match(/\d+\.\d+(?:\.\d+)?/);
    if (match) version = match[0];
    if (runtimeId === "openclaw") {
      const status = readFlag(io, binaryPath, ["status", "--json"]);
      reachable = status.ok;
      authenticated = status.ok && !/unauth|login required|not logged/i.test(status.text);
    } else {
      const status = readFlag(io, binaryPath, ["status"]);
      reachable = status.ok;
      authenticated = status.ok && !/unauth|login required|not logged/i.test(status.text);
    }
  }
  return {
    runtimeId,
    binaryPresent,
    configPresent,
    authenticated,
    reachable,
    ...(version ? { version } : {}),
    ...(binaryPath ? { binaryPath } : {}),
    ...(configPresent ? { configPath } : {}),
  };
}

export function detectAllRuntimes(paths: CatalogPaths, io: DetectIo): AgentRuntimeStatus[] {
  return (["openclaw", "hermes"] as const).map((id) => detectAgentRuntime(id, paths, io));
}

export function defaultCatalogAgents(status: AgentRuntimeStatus): ExternalAgent[] {
  if (!status.binaryPresent && !status.configPresent) return [];
  if (status.runtimeId === "openclaw") {
    return [{ runtimeId: "openclaw", agentId: "main", name: "openclaw/main" }];
  }
  return [{ runtimeId: "hermes", agentId: "default", name: "hermes/default" }];
}

export function catalogFromStatuses(statuses: AgentRuntimeStatus[]): ExternalAgent[] {
  return statuses.flatMap(defaultCatalogAgents);
}

export function parseCatalogAgents(runtimeId: AgentRuntimeId, raw: unknown): ExternalAgent[] {
  if (!isAgentRuntimeId(runtimeId)) return [];
  if (!Array.isArray(raw)) return [];
  const agents: ExternalAgent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; name?: unknown; agent?: unknown; profile?: unknown; workspace?: unknown };
    const agentId = [record.id, record.agent, record.profile, record.name].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (!agentId) continue;
    const id = agentId.includes("/") ? agentId.slice(agentId.indexOf("/") + 1) : agentId;
    agents.push({
      runtimeId,
      agentId: id.trim(),
      name: `${runtimeId}/${id.trim()}`,
      ...(typeof record.workspace === "string" && record.workspace.trim() ? { workspace: record.workspace.trim() } : {}),
    });
  }
  return agents;
}
