import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";

export type LinkDeskState = {
  sessions?: unknown[];
  projects?: unknown[];
  settings?: unknown;
  activeSessionId?: unknown;
  usage?: unknown;
  deskPlans?: unknown;
  watchPermits?: unknown;
  watchDayMarks?: unknown;
  agentCatalog?: unknown;
  agentRuntimes?: unknown;
  externalTasks?: unknown;
};

const rpcState = new AsyncLocalStorage<LinkDeskState>();

let cached: { path: string; mtimeMs: number; size: number; state: LinkDeskState } | null = null;

/** Drop inlined attachment bytes as they parse so a helper never retains them. */
export function stripInlineAttachmentData(key: string, value: unknown): unknown {
  if (key === "data" && typeof value === "string" && value.length > 128) return "";
  return value;
}

function readFileState(statePath: string): LinkDeskState {
  const text = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(text, stripInlineAttachmentData) as LinkDeskState;
  return parsed && typeof parsed === "object" ? parsed : {};
}

/** One parsed desk snapshot, reused until the file's mtime/size change. */
export function loadLinkState(statePath: string): LinkDeskState {
  const dest = statePath.trim();
  if (!dest) return {};
  try {
    const stat = fs.statSync(dest);
    if (cached && cached.path === dest && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.state;
    }
    const state = readFileState(dest);
    cached = { path: dest, mtimeMs: stat.mtimeMs, size: stat.size, state };
    return state;
  } catch {
    return {};
  }
}

export function resetLinkStateCache(): void {
  cached = null;
}

export function runWithLinkState<T>(state: LinkDeskState, work: () => T): T {
  return rpcState.run(state, work);
}

/** Link helpers: prefer the RPC snapshot, then the file cache. Never re-parse mid-request. */
export function readLinkState(statePath = process.env.WORKHORSE_STATE_PATH ?? ""): LinkDeskState {
  return rpcState.getStore() ?? loadLinkState(statePath);
}
