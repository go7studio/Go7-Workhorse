import fs from "node:fs";
import { parseLocalCapabilities } from "../src/lib/local-capability-contract";
import {
  normalizeLocalComputeHost,
  type LocalComputeHostProbe,
  type LocalComputeHostSettings,
} from "../src/lib/local-compute";

const MAX_CAPABILITIES_BYTES = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

type TokenStat = { mode: number; isFile(): boolean };

export type LocalComputeProbeDependencies = {
  readFileSync: (file: string) => Buffer | string;
  statSync: (file: string) => TokenStat;
  fetchImpl: typeof fetch;
  platform: NodeJS.Platform;
  now: () => number;
  timeoutMs?: number;
};

const DEFAULT_DEPENDENCIES: LocalComputeProbeDependencies = {
  readFileSync: (file) => fs.readFileSync(file),
  statSync: (file) => fs.statSync(file),
  fetchImpl: fetch,
  platform: process.platform,
  now: () => Date.now(),
};

function endpoint(baseUrl: string): URL {
  return new URL("v1/capabilities", `${baseUrl.replace(/\/$/, "")}/`);
}

function safeToken(host: LocalComputeHostSettings, dependencies: LocalComputeProbeDependencies): string {
  const stat = dependencies.statSync(host.tokenFile);
  if (!stat.isFile()) throw new Error("token_not_file");
  if (dependencies.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("token_permissions");
  }
  const token = Buffer.from(dependencies.readFileSync(host.tokenFile)).toString("utf8").trim();
  if (!token || token.length > 16_384 || /[\r\n]/.test(token)) throw new Error("token_invalid");
  return token;
}

async function readJson(response: Response): Promise<unknown> {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader && /^\d+$/.test(declaredHeader) && Number(declaredHeader) > MAX_CAPABILITIES_BYTES) {
    throw new Error("response_too_large");
  }
  const reader = response.body?.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        length += chunk.byteLength;
        if (length > MAX_CAPABILITIES_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("response_too_large");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    if (chunk.byteLength > MAX_CAPABILITIES_BYTES) throw new Error("response_too_large");
    chunks.push(chunk);
    length = chunk.byteLength;
  }
  const bytes = Buffer.concat(chunks, length);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid_response");
  }
}

function failure(
  hostId: string,
  checkedAt: number,
  errorCode: string,
  message: string,
  status: LocalComputeHostProbe["status"] = "unavailable",
): LocalComputeHostProbe {
  return { hostId, status, checkedAt, capabilities: [], errorCode, message };
}

export async function probeLocalComputeHost(
  rawHost: LocalComputeHostSettings,
  dependencies: LocalComputeProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<LocalComputeHostProbe> {
  const checkedAt = dependencies.now();
  const host = normalizeLocalComputeHost(rawHost);
  if (!host) return failure(String(rawHost?.id ?? ""), checkedAt, "invalid_host", "Host settings are invalid.", "misconfigured");
  if (!host.enabled) return { hostId: host.id, status: "disabled", checkedAt, capabilities: [] };

  let token: string;
  try {
    token = safeToken(host, dependencies);
  } catch (error) {
    const code = error instanceof Error ? error.message : "token_unavailable";
    const message = code === "token_permissions"
      ? "Token file must not be readable by group or other users."
      : "Token file is unavailable or invalid.";
    return failure(host.id, checkedAt, code, message, "misconfigured");
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), dependencies.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const response = await dependencies.fetchImpl(endpoint(host.baseUrl), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    if (!response.ok) {
      const unauthorized = response.status === 401 || response.status === 403;
      return failure(
        host.id,
        checkedAt,
        unauthorized ? "unauthorized" : "host_error",
        unauthorized ? "Host authorization failed." : `Host returned HTTP ${response.status}.`,
      );
    }
    const discovered = parseLocalCapabilities(await readJson(response));
    return {
      hostId: host.id,
      status: "healthy",
      checkedAt,
      protocolVersion: discovered.protocolVersion,
      runtimeId: discovered.brokerId,
      runtimeVersion: discovered.brokerVersion,
      capabilities: discovered.capabilities.map((capability) => ({
        id: capability.id,
        profileId: capability.profileId,
        description: capability.description,
        inputKinds: capability.inputKinds,
        outputRoles: capability.outputRoles,
        estimatedMemoryGb: capability.estimatedMemoryGb,
        asynchronous: capability.asynchronous,
        ...(capability.continuations ? {
          continuations: capability.continuations.map((continuation) => ({
            capability: continuation.capability,
            tool: continuation.tool,
            outputRoles: continuation.outputs.map((output) => output.role),
          })),
        } : {}),
      })),
    };
  } catch (error) {
    const code = error instanceof Error && error.name === "AbortError"
      ? "timeout"
      : error instanceof Error && /^[a-z_]+$/.test(error.message)
        ? error.message
        : "unreachable";
    return failure(host.id, checkedAt, code, code === "timeout" ? "Host probe timed out." : "Host is unavailable.");
  } finally {
    clearTimeout(timer);
  }
}

export async function probeLocalComputeHosts(
  hosts: LocalComputeHostSettings[],
  dependencies: LocalComputeProbeDependencies = DEFAULT_DEPENDENCIES,
): Promise<LocalComputeHostProbe[]> {
  if (!Array.isArray(hosts)) return [];
  return Promise.all(hosts.slice(0, 32).map((host) => probeLocalComputeHost(host, dependencies)));
}
