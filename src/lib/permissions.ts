import { modeLabel, sandboxLabel } from "./commands";
import { uid } from "./id";
import { applySessionElevation } from "./session";
import { toolNameKey } from "./tool-labels";
import type { BotAccessDefaults, DeskAccess, PermissionGrant, PermissionMode, PermissionRequest, SandboxProfile, Session } from "./types";

export type PermissionAnswer = "once" | "session" | "deny";

export function looksLikeWriteTool(tool: string, detail: string, filePath?: string): boolean {
  const hay = `${tool} ${detail} ${filePath ?? ""}`.toLowerCase();
  if (
    /\b(read_file|list_dir|grep|search|web_search|web_fetch|todo_write|ripgrep|rg(?:\.exe)?)\b/.test(hay) &&
    !/\b(write|edit|replace|delete)\b/.test(hay)
  ) {
    return false;
  }
  return /\b(write|write_file|edit|search_replace|str_replace|create|delete|unlink|rm |remove|move|rename|bash|shell|powershell|cmd\.exe|run command|run_command)\b/.test(hay);
}

export function looksLikeShellTool(tool: string, detail: string): boolean {
  return /\b(bash|shell|powershell|cmd\.exe|run command|run_command)\b/i.test(`${tool} ${detail}`);
}

export function looksLikeNetworkTool(tool: string, detail: string): boolean {
  const hay = `${tool} ${detail}`.toLowerCase();
  return /\b(web_search|web_fetch|browser|http|https|curl|wget|invoke-webrequest|npm\s+(?:install|view|info)|pnpm\s+(?:install|add)|yarn\s+add|pip\s+install|git\s+(?:clone|fetch|pull|push)|ssh|scp)\b/.test(hay);
}

function comparable(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function absolutePath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|\/)/i.test(value.trim());
}

function inside(root: string, candidate: string): boolean {
  const base = comparable(root);
  const file = comparable(candidate);
  return file === base || file.startsWith(`${base}/`);
}

/** Provider-independent boundary applied before vendor-specific approval rules. */
export function securityPolicyAnswer(input: {
  policy?: import("./types").SessionSecurityPolicy;
  tool: string;
  detail: string;
  path?: string;
  roots?: string[];
}): { answer: PermissionAnswer | null; boundary?: "network" | "outside-workspace" } {
  const policy = input.policy ?? { network: "allowed", root: "allowed" };
  if (policy.network === "blocked" && looksLikeNetworkTool(input.tool, input.detail)) {
    return { answer: "deny", boundary: "network" };
  }
  const candidate = input.path?.trim();
  const roots = (input.roots ?? []).filter((root) => root.trim());
  if (candidate && absolutePath(candidate) && roots.length > 0 && !roots.some((root) => inside(root, candidate))) {
    if (policy.root === "blocked") return { answer: "deny", boundary: "outside-workspace" };
    if (policy.root === "ask") return { answer: null, boundary: "outside-workspace" };
  }
  return { answer: null };
}

/** rg / grep as the invoked program — allow through Ask / Plan / Always. */
export function looksLikeSearchOnly(tool: string, detail: string, filePath?: string): boolean {
  const command = `${detail} ${filePath ?? ""}`.trim();
  const hay = `${tool} ${command}`.toLowerCase();
  if (!/\b(rg(?:\.exe)?|ripgrep|grep)\b/.test(hay)) return false;
  if (/\b(write|edit|replace|delete|unlink|rm\b|remove|move|rename|mkdir|out-file|set-content|new-item)\b/.test(hay)) {
    return false;
  }
  if (!looksLikeShellTool(tool, detail)) return !looksLikeWriteTool(tool, detail, filePath);
  const stripped = command
    .replace(/^[^\n]*powershell(?:\.exe)?[^\n]*?(?:-command|-c)\s+/i, "")
    .replace(/^try\s*\{[\s\S]*?\}\s*catch\s*\{\s*\}\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return /^(rg(?:\.exe)?|ripgrep|grep)\b/im.test(stripped) || /^(rg(?:\.exe)?|ripgrep|grep)\b/i.test(command);
}

const QUIET_DESK_TOOLS = new Set([
  "list_chats",
  "list_bots",
  "query_capacity",
  "list_tools",
  "list_references",
  "read_chat",
  "ask_chat",
  "spawn_agent",
  "await_agents",
  "request_vendor",
  "detect_custom",
  "list_skills",
  "read_skill",
  "list_projects",
  "create_project",
  "move_chat",
  "rename_chat",
  "rename_project",
  "delete_chat",
  "delete_project",
]);

export function isQuietDeskTool(tool: string): boolean {
  return QUIET_DESK_TOOLS.has(toolNameKey(tool));
}

function grantText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function permissionGrantKey(tool: string, detail?: string, filePath?: string): string {
  const key = toolNameKey(tool);
  if (
    QUIET_DESK_TOOLS.has(key) ||
    /^(ask_chat|spawn_agent|await_agents|add_reference|delete_reference|setup_custom_bot|delete_bot|create_project|list_projects|move_chat|rename_chat|rename_project|delete_chat|delete_project)$/.test(
      key,
    )
  ) {
    return "workhorse";
  }
  if (/^(?:bash|shell|powershell|run_command|cd|ls|pwd|cat|sed|rg|grep|find|git|wc|head|tail|echo|mkdir|cp|mv|rm|touch|npm|npx|node|python|godot)(?:_|$)/.test(key)) {
    return `shell:${grantText(detail) || key}`;
  }
  const target = grantText(filePath) || grantText(detail);
  if (/^(?:read|read_file|list|list_dir)(?:_|$)/.test(key)) return `read:${target || key}`;
  if (/^(?:write|write_file|edit|str_replace|search_replace)(?:_|$)/.test(key)) return `write:${target || key}`;
  return `${key || grantText(tool)}:${target || key}`;
}

export function grantCovers(
  grants: PermissionGrant[] | undefined,
  tool: string,
  detail?: string,
  filePath?: string,
  now = Date.now(),
): boolean {
  if (!grants?.length) return false;
  const key = permissionGrantKey(tool, detail, filePath);
  return grants.some((grant) => grant.expiresAt > now && grant.key === key);
}

export function enqueuePermission(
  pending: PermissionRequest[],
  request: PermissionRequest,
): PermissionRequest[] {
  return [...pending.filter((item) => item.id !== request.id), request];
}

/** A late vendor permission result cannot make a finished worker look active again. */
export function permissionResumeStatus(input: {
  hasOtherPending: boolean;
  agentRun?: Session["agentRun"];
}): Session["status"] {
  if (input.hasOtherPending) return "needs-input";
  if (input.agentRun && input.agentRun.status !== "running") return "idle";
  return "running";
}

/** Software fallback when the vendor kernel sandbox is a no-op (Windows). */
export type ElevationNeed = {
  mode?: PermissionMode;
  sandbox?: SandboxProfile;
};

const MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  ask: 1,
  "accept-edits": 2,
  "always-approve": 3,
};

const SANDBOX_RANK: Record<SandboxProfile, number> = {
  strict: 0,
  "read-only": 1,
  workspace: 2,
  off: 3,
};

export function parsePermissionModeValue(raw: string | undefined): PermissionMode | undefined {
  const value = raw?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (value === "ask" || value === "default") return "ask";
  if (value === "accept-edits" || value === "accept" || value === "auto") return "accept-edits";
  if (value === "always-approve" || value === "always" || value === "yolo") return "always-approve";
  if (value === "plan") return "plan";
  return undefined;
}

export function parseSandboxValue(raw: string | undefined): SandboxProfile | undefined {
  const value = raw?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (value === "off" || value === "full" || value === "machine") return "off";
  if (value === "workspace" || value === "project") return "workspace";
  if (value === "read-only" || value === "readonly") return "read-only";
  if (value === "strict") return "strict";
  return undefined;
}

/** Only keep raises (never a downgrade). */
export function elevationStillNeeded(
  current: { mode: PermissionMode; sandbox: SandboxProfile },
  want: ElevationNeed,
): ElevationNeed | null {
  const need: ElevationNeed = {};
  if (want.mode && MODE_RANK[want.mode] > MODE_RANK[current.mode]) need.mode = want.mode;
  if (want.sandbox && SANDBOX_RANK[want.sandbox] > SANDBOX_RANK[current.sandbox]) need.sandbox = want.sandbox;
  return need.mode || need.sandbox ? need : null;
}

export type ElevationClass = "raise" | "noop" | "downgrade";

export function classifyElevation(
  current: { mode: PermissionMode; sandbox: SandboxProfile },
  want: ElevationNeed,
): { kind: ElevationClass; need?: ElevationNeed } {
  const raise = elevationStillNeeded(current, want);
  if (raise) return { kind: "raise", need: raise };
  const askedLower =
    (want.mode != null && MODE_RANK[want.mode] < MODE_RANK[current.mode]) ||
    (want.sandbox != null && SANDBOX_RANK[want.sandbox] < SANDBOX_RANK[current.sandbox]);
  return { kind: askedLower ? "downgrade" : "noop" };
}

export function elevationForBlock(input: {
  mode: PermissionMode;
  sandbox: SandboxProfile;
  tool: string;
  detail: string;
  path?: string;
}): ElevationNeed | null {
  const write = looksLikeWriteTool(input.tool, input.detail, input.path);
  const planFile = /plan\.md/i.test(`${input.path ?? ""} ${input.detail}`);
  const want: ElevationNeed = {};
  if ((input.sandbox === "read-only" || input.sandbox === "strict") && write) want.sandbox = "off";
  if (input.mode === "plan" && write && !planFile) want.mode = "ask";
  return elevationStillNeeded({ mode: input.mode, sandbox: input.sandbox }, want);
}

export function parseElevationInput(
  input: Record<string, unknown> | undefined,
  current: { mode: PermissionMode; sandbox: SandboxProfile },
): ElevationNeed | null {
  const record = input ?? {};
  const modeRaw =
    (typeof record.permission === "string" && record.permission) ||
    (typeof record.mode === "string" && record.mode) ||
    "";
  const sandboxRaw = typeof record.sandbox === "string" ? record.sandbox : "";
  const mode = parsePermissionModeValue(modeRaw);
  const sandbox = parseSandboxValue(sandboxRaw);
  const want: ElevationNeed = {};
  if (mode && mode !== "plan") want.mode = mode;
  if (sandbox === "off" || sandbox === "workspace") want.sandbox = sandbox;
  if (!want.mode && !want.sandbox) {
    if (current.mode === "plan") want.mode = "ask";
    if (current.sandbox === "read-only" || current.sandbox === "strict") want.sandbox = "off";
  }
  return classifyElevation(current, want).need ?? null;
}

export function classifyElevationInput(
  input: Record<string, unknown> | undefined,
  current: { mode: PermissionMode; sandbox: SandboxProfile },
): { kind: ElevationClass; need?: ElevationNeed } {
  const record = input ?? {};
  const modeRaw =
    (typeof record.permission === "string" && record.permission) ||
    (typeof record.mode === "string" && record.mode) ||
    "";
  const sandboxRaw = typeof record.sandbox === "string" ? record.sandbox : "";
  const mode = parsePermissionModeValue(modeRaw);
  const sandbox = parseSandboxValue(sandboxRaw);
  const want: ElevationNeed = {};
  if (mode && mode !== "plan") want.mode = mode;
  if (sandbox === "off" || sandbox === "workspace") want.sandbox = sandbox;
  if (!want.mode && !want.sandbox) {
    if (current.mode === "plan") want.mode = "ask";
    if (current.sandbox === "read-only" || current.sandbox === "strict") want.sandbox = "off";
    if (!want.mode && !want.sandbox) return { kind: "noop" };
  }
  return classifyElevation(current, want);
}

export function describeElevation(
  from: { mode: PermissionMode; sandbox: SandboxProfile },
  to: ElevationNeed,
): string {
  const bits: string[] = [];
  if (to.mode) bits.push(`Permission ${modeLabel(from.mode)} → ${modeLabel(to.mode)}`);
  if (to.sandbox) bits.push(`Sandbox ${sandboxLabel(from.sandbox)} → ${sandboxLabel(to.sandbox)}`);
  return bits.join(" and ");
}

/** The narrower of a desk answer and a vendor app's own recorded defaults. */
export function tighterAccess(left: DeskAccess, right: BotAccessDefaults | undefined): DeskAccess {
  if (!right) return left;
  return {
    mode: right.mode && MODE_RANK[right.mode] < MODE_RANK[left.mode] ? right.mode : left.mode,
    sandbox: right.sandbox && SANDBOX_RANK[right.sandbox] < SANDBOX_RANK[left.sandbox] ? right.sandbox : left.sandbox,
  };
}

export const DESK_ACCESS_FALLBACK: DeskAccess = { mode: "always-approve", sandbox: "off" };

/**
 * Access an inbound CLI / MCP / tool call runs under.
 *
 * An explicit parent chat is the path: the call takes that chat's Permission
 * and Sandbox, so a chat the person tightened stays tight and a chat they set
 * to Always stays Always. With no parent the desk's own stored default answers
 * — Always / Off as shipped, and only the person may narrow it. The vendor
 * app's recorded defaults are folded in as a second thing the person set, so
 * the narrower of the two wins: a Codex on approval_policy="never" keeps the
 * desk's Always, and a Codex on "on-request" pulls it back to Ask.
 *
 * Nothing here reads the caller's live permission state, and nothing asks for
 * it. A desk cannot see what another vendor's app is allowing right now, so
 * that handshake is not attempted. Every input is the desk's own record.
 */
export function inboundAccess(input: {
  parent?: BotAccessDefaults;
  desk?: DeskAccess;
  vendor?: BotAccessDefaults;
}): DeskAccess {
  const seat = tighterAccess(input.desk ?? DESK_ACCESS_FALLBACK, input.vendor);
  return {
    mode: input.parent?.mode ?? seat.mode,
    sandbox: input.parent?.sandbox ?? seat.sandbox,
  };
}

/**
 * The vendor session a path-owned worker launches under, never looser than
 * Ask. Always maps to approval_policy="never" / bypassPermissions at the
 * vendor launch (electron/codex-launch.ts:86, electron/claude-launch.ts:120),
 * and those stop the write events the path preflight reads — a worker that
 * cannot be preflighted cannot be held to its allowlist. The person still sees
 * no modal for in-path work: the desk answers those events itself from the
 * grant the worker carries. The prompt is suppressed at the desk, not at the
 * vendor. Plan and Ask are already tight enough and pass through unchanged.
 */
export function pathOwnerMode(mode: PermissionMode): PermissionMode {
  return MODE_RANK[mode] > MODE_RANK.ask ? "ask" : mode;
}

export type WorkerAccessPrior = {
  mode: PermissionMode;
  sandbox: SandboxProfile;
  agentRun?: { paths?: string[]; grantedAccess?: DeskAccess };
};

/**
 * A narrowing the person put on a worker chat themselves, told apart from the
 * desk's own path clamp. The desk records what it granted, so anything tighter
 * than what it last set is the person's doing and survives the next slice.
 * Without the record every reuse would read last slice's clamp as a wish.
 */
export function workerTightening(prior: WorkerAccessPrior | undefined): BotAccessDefaults | undefined {
  if (!prior) return undefined;
  const granted = prior.agentRun?.grantedAccess;
  if (!granted) return { mode: prior.mode, sandbox: prior.sandbox };
  const owned = (prior.agentRun?.paths?.length ?? 0) > 0;
  const deskSet: DeskAccess = { mode: owned ? pathOwnerMode(granted.mode) : granted.mode, sandbox: granted.sandbox };
  const mode = MODE_RANK[prior.mode] < MODE_RANK[deskSet.mode] ? prior.mode : undefined;
  const sandbox = SANDBOX_RANK[prior.sandbox] < SANDBOX_RANK[deskSet.sandbox] ? prior.sandbox : undefined;
  if (!mode && !sandbox) return undefined;
  return { ...(mode ? { mode } : {}), ...(sandbox ? { sandbox } : {}) };
}

/**
 * The seat a spawned worker launches under. It inherits the parent path; a
 * path allowlist clamps the vendor session to Ask so ownership can still be
 * checked before each write; and a narrowing the person set on this worker
 * chat outranks both, because reuse must not hand back access they took away.
 */
export function workerAccess(input: {
  inherited: DeskAccess;
  owned: boolean;
  readOnly?: boolean;
  prior?: WorkerAccessPrior;
}): DeskAccess {
  const seat: DeskAccess = {
    mode: input.owned ? pathOwnerMode(input.inherited.mode) : input.inherited.mode,
    sandbox: input.readOnly ? "read-only" : input.inherited.sandbox,
  };
  return tighterAccess(seat, workerTightening(input.prior));
}

/** What the desk records as granted, so the next reuse can read the clamp apart from a tightening. */
export function workerGrant(input: { inherited: DeskAccess; prior?: WorkerAccessPrior }): DeskAccess {
  return tighterAccess(input.inherited, workerTightening(input.prior));
}

/**
 * What the desk answers on a worker's behalf from the grant it inherited.
 * A grant only ever allows: it can silence a prompt the desk already decided
 * to allow, and it never turns into a fresh denial, so every real block still
 * comes from the chat's own Permission and Sandbox.
 */
export function grantedPolicyAnswer(input: {
  granted?: PermissionMode;
  sandbox: SandboxProfile;
  tool: string;
  detail: string;
  path?: string;
}): PermissionAnswer | null {
  if (!input.granted) return null;
  const answer = permissionPolicyAnswer({
    mode: input.granted,
    sandbox: input.sandbox,
    tool: input.tool,
    detail: input.detail,
    path: input.path,
  });
  return answer === "deny" ? null : answer;
}

export function permissionPolicyAnswer(input: {
  mode: PermissionMode;
  sandbox: SandboxProfile;
  tool: string;
  detail: string;
  path?: string;
}): PermissionAnswer | null {
  const write = looksLikeWriteTool(input.tool, input.detail, input.path);
  const planFile = /plan\.md/i.test(`${input.path ?? ""} ${input.detail}`);
  if ((input.sandbox === "read-only" || input.sandbox === "strict") && write) return "deny";
  if (input.mode === "plan" && write && !planFile) return "deny";
  if (input.mode === "always-approve") return "session";
  if (looksLikeSearchOnly(input.tool, input.detail, input.path)) return "once";
  if (input.mode === "accept-edits" && write && !looksLikeShellTool(input.tool, input.detail)) return "once";
  return null;
}

export function autoAllowPermission(input: {
  tool: string;
  detail?: string;
  path?: string;
  grants?: PermissionGrant[];
  now?: number;
}): PermissionAnswer | null {
  if (isQuietDeskTool(input.tool)) return "once";
  if (grantCovers(input.grants, input.tool, input.detail, input.path, input.now)) return "session";
  return null;
}

export function permissionAnswerLabel(answer: PermissionAnswer): string {
  if (answer === "deny") return "Denied";
  if (answer === "session") return "Allowed for this session";
  return "Allowed once";
}

export function applyPermissionAnswer(
  state: { pending: PermissionRequest[]; sessions: Session[] },
  id: string,
  answer: PermissionAnswer,
): { pending: PermissionRequest[]; sessions: Session[] } | null {
  const request = state.pending.find((item) => item.id === id);
  if (!request) return null;
  const remaining = state.pending.filter((item) => item.id !== id);
  const stillWaiting = remaining.some((item) => item.sessionId === request.sessionId);
  const elevate = request.kind === "elevate" && request.elevate && answer !== "deny";
  const vendor = request.kind === "vendor" && request.vendor && answer !== "deny";
  const label = elevate
    ? `Elevated ${describeElevation(
        state.sessions.find((item) => item.id === request.sessionId) ?? {
          mode: request.elevate?.mode ?? "ask",
          sandbox: request.elevate?.sandbox ?? "off",
        },
        request.elevate ?? {},
      )}`
    : vendor
      ? `Allowed ${request.vendor?.name ?? "that vendor"} for this chat`
      : `${permissionAnswerLabel(answer)}: ${request.tool} — ${request.detail}`;
  return {
    pending: remaining,
    sessions: state.sessions.map((session) => {
      if (session.id !== request.sessionId) return session;
      const next = elevate ? applySessionElevation(session, request.elevate ?? {}) : session;
      const now = Date.now();
      const grant = answer === "session" && request.kind !== "elevate" && request.kind !== "vendor"
        ? {
            id: uid("grant"),
            key: permissionGrantKey(request.tool, request.detail, request.path),
            tool: request.tool,
            detail: request.detail,
            ...(request.path ? { path: request.path } : {}),
            createdAt: now,
            expiresAt: now + 24 * 60 * 60 * 1_000,
          } satisfies PermissionGrant
        : undefined;
      const grants = grant
        ? [...(next.permissionGrants ?? []).filter((item) => item.key !== grant.key), grant]
        : next.permissionGrants;
      return {
        ...next,
        status: answer === "deny" ? "idle" : stillWaiting ? "needs-input" : "running",
        permissionGrants: grants,
        messages: [
          ...next.messages,
          {
            id: uid("msg"),
            role: "system",
            kind: "tool",
            toolStatus: answer === "deny" ? "failed" : "completed",
            text: `${label} · ${answer === "deny" ? "denied" : "completed"}`,
            createdAt: Date.now(),
          },
        ],
      };
    }),
  };
}
