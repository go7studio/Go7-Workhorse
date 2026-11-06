/**
 * Words Inspect shows for a stored caller, a stored tool, and a worker's bill.
 * The stored caller string stays the ownership key. This file only names it.
 * Token totals come from the desk ledger. A missing bill stays missing.
 */

import { isProviderId, providerById } from "./providers";
import type { UsageEvent } from "./types";
import { collapseInflatedUsage, formatIoLine, rollup } from "./usage";

const RELIABLE: Array<[RegExp, string]> = [
  [/^(?:grok bot)$/, "Grok Bot"],
  [/^(?:grok|grok cli|grok build)(?: \d[\d.]*)?$/, "Grok"],
  [/^(?:codex|codex cli|openai codex)(?: \d[\d.]*)?$/, "Codex"],
  [/^(?:claude|claude code|claude desktop)(?: \d[\d.]*)?$/, "Claude"],
  [/^(?:cursor|cursor ide|cursor vscode|cursor app)(?: \d[\d.]*)?$/, "Cursor"],
  [/^(?:openclaw)(?: \d[\d.]*)?$/, "OpenClaw"],
  [/^(?:hermes)(?: \d[\d.]*)?$/, "Hermes"],
];

const ACTIVITY: Record<string, string> = {
  workhorse_delegate: "Started work",
  workhorse_ask_chat: "Asked a chat",
  workhorse_spawn_agent: "Started a worker",
  workhorse_continue_mission: "Continued the work",
  workhorse_agent_status: "Checked progress",
  workhorse_read_chat: "Read a chat",
  workhorse_list_chats: "Looked through chats",
  workhorse_capabilities: "Asked what Workhorse can do",
  workhorse_list_bots: "Looked at who is available",
  workhorse_find_bots: "Looked for a worker",
  workhorse_query_capacity: "Checked capacity",
  workhorse_mcp_inventory: "Looked at connected tools",
  workhorse_list_projects: "Looked through projects",
  workhorse_list_agents: "Looked at who is available",
  workhorse_list_external_agents: "Looked at outside agents",
  workhorse_await_agents: "Waited on workers",
  workhorse_cancel_agent: "Cancelled a worker",
  workhorse_delete_chat: "Tried to delete a chat",
  workhorse_delete_project: "Tried to delete a project",
  workhorse_rename_chat: "Tried to rename a chat",
  workhorse_rename_project: "Tried to rename a project",
  workhorse_create_project: "Tried to create a project",
  workhorse_move_chat: "Tried to move a chat",
  workhorse_add_reference: "Tried to add a reference",
  workhorse_delete_reference: "Tried to remove a reference",
  workhorse_list_references: "Looked through references",
  workhorse_probe_runtime: "Checked the local setup",
  workhorse_plan: "Updated a plan",
  workhorse_viewer_annotations: "Read viewer notes",
  workhorse_viewer_snapshot: "Captured the viewer",
  workhorse_local_hosts: "Checked local computers",
  workhorse_local_capabilities: "Checked a local computer",
  workhorse_local_upload: "Sent a file to a local computer",
  workhorse_local_invoke: "Ran a local tool",
  workhorse_local_chat: "Asked a local model",
  workhorse_local_generate_3d: "Asked for a 3D model",
  workhorse_local_job: "Checked a local job",
  workhorse_local_cancel: "Cancelled a local job",
  workhorse_local_artifact: "Fetched a local file",
  workhorse_local_materialize: "Saved a local file",
  workhorse_local_continue: "Continued a local job",
};

export type CallerPresentation = {
  title: string;
  reliable: boolean;
  /** The name the client sent, when the title is a clearer label. */
  reportedName?: string;
};

export function reliableCallerTitle(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (!key || key === "unknown caller") return null;
  for (const [pattern, title] of RELIABLE) {
    if (pattern.test(key)) return title;
  }
  return null;
}

export function presentCallers(
  callers: readonly { caller: string; firstAt?: number }[],
): Map<string, CallerPresentation> {
  const drafts = callers.map((caller) => {
    const known = reliableCallerTitle(caller.caller);
    return {
      caller: caller.caller,
      firstAt: typeof caller.firstAt === "number" && Number.isFinite(caller.firstAt) ? caller.firstAt : 0,
      title: known ?? "Unknown caller",
      reliable: known !== null,
    };
  });
  const groups = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const list = groups.get(draft.title) ?? [];
    list.push(draft);
    groups.set(draft.title, list);
  }
  const faces = new Map<string, CallerPresentation>();
  for (const [base, list] of groups) {
    const ordered = [...list].sort((left, right) => left.firstAt - right.firstAt || left.caller.localeCompare(right.caller));
    ordered.forEach((draft, index) => {
      const title = ordered.length > 1 && index > 0 ? `${base} ${index + 1}` : base;
      const reported = draft.caller.toLowerCase() === "unknown caller" || draft.caller.toLowerCase() === title.toLowerCase()
        ? undefined
        : draft.caller;
      faces.set(draft.caller, {
        title,
        reliable: draft.reliable,
        ...(reported ? { reportedName: reported } : {}),
      });
    });
  }
  return faces;
}

/** A short activity name. The stored tool name stays available from activityTool. */
export function activityLabel(tool: string): string {
  return ACTIVITY[tool] ?? "Workhorse call";
}

export function activityTool(tool: string): string {
  return tool;
}

export function trafficStatus(input: { status?: string; workerStatus?: string }): string {
  const worker = input.workerStatus;
  if (worker === "running" || worker === "queued") return "Working";
  if (worker === "completed" || worker === "ok") return "Finished";
  if (worker === "failed") return "Failed";
  if (worker === "cancelled") return "Cancelled";
  if (input.status === "forbidden") return "Refused";
  if (input.status === "error") return "Failed";
  if (input.status === "ok") return "Done";
  return "No status yet";
}

export function callerTrafficStatus(caller: {
  workers: readonly { lastStatus?: string }[];
  calls: readonly { status?: string; workerStatus?: string }[];
}): string {
  if (caller.workers.some((worker) => worker.lastStatus === "running" || worker.lastStatus === "queued")) return "Working";
  const latest = caller.calls[0];
  if (latest) return trafficStatus(latest);
  const worker = caller.workers[0];
  if (worker?.lastStatus) return trafficStatus({ workerStatus: worker.lastStatus });
  return "No status yet";
}

export function trafficWhen(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "Unknown time";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const key = (value: Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  if (key(date) === key(today)) return `Today, ${time}`;
  if (key(date) === key(yesterday)) return `Yesterday, ${time}`;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

export function statusTone(label: string): "working" | "done" | "bad" | "quiet" {
  if (label === "Working") return "working";
  if (label === "Finished" || label === "Done") return "done";
  if (label === "Failed" || label === "Refused") return "bad";
  return "quiet";
}

export type InspectAccount = {
  callerTitle: string;
  /** Link stores the client name. It does not store the caller's model. */
  callerModel: "Not available";
  /** Link stores no bill for the outside app. */
  callerTokens: "Not available";
  /** Vendor and model recorded for this worker, or Not available. */
  worker: string;
  /** Recorded tokens, the string 0 when a bill exists and is zero, or Not available. */
  tokens: string;
  tokensRecorded: boolean;
};

/**
 * Who called, which worker model ran, and what the desk recorded.
 * The caller's model and tokens are not on the call, so they stay Not available.
 * A worker's vendor comes from the session or from a usage row for that session.
 * A model name never picks the vendor. Gauge rows are not token bills.
 * Duplicate rows for one moment are collapsed once. A budget meter is not added.
 */
export function inspectAccount(input: {
  callerTitle: string;
  sessionId?: string;
  session?: { provider?: string; model?: string; customBotId?: string; archivedAt?: number | null } | null;
  usage?: readonly UsageEvent[];
  botName?: string;
}): InspectAccount {
  const bills = workerBills(input.sessionId, input.usage);
  const vendor = workerVendor(input.session, bills, input.botName);
  const model = workerModel(input.session, bills);
  const tokens = tokenLine(bills);
  return {
    callerTitle: input.callerTitle.trim() || "Unknown caller",
    callerModel: "Not available",
    callerTokens: "Not available",
    worker: joinWorker(vendor, model),
    tokens: tokens.text,
    tokensRecorded: tokens.recorded,
  };
}

function workerBills(sessionId: string | undefined, usage: readonly UsageEvent[] | undefined): UsageEvent[] {
  if (!sessionId || !usage?.length) return [];
  const mine = usage.filter((event) => event.sessionId === sessionId && event.source !== "gauge");
  return collapseInflatedUsage(mine);
}

function workerVendor(
  session: { provider?: string; customBotId?: string } | null | undefined,
  bills: readonly UsageEvent[],
  botName: string | undefined,
): string | null {
  const provider = knownProvider(session?.provider) ?? knownProvider(latestBill(bills)?.provider);
  if (!provider) return null;
  if (provider === "custom") {
    const name = botName?.trim();
    if (name && session?.customBotId) return name;
    return "Custom";
  }
  return providerById(provider).name;
}

function workerModel(
  session: { model?: string } | null | undefined,
  bills: readonly UsageEvent[],
): string | null {
  const fromSession = session?.model?.trim();
  if (fromSession) return fromSession;
  const fromBill = latestBill(bills)?.model.trim();
  return fromBill || null;
}

function latestBill(bills: readonly UsageEvent[]): UsageEvent | undefined {
  return [...bills].sort((left, right) => right.at - left.at)[0];
}

function knownProvider(value: string | undefined) {
  return value && isProviderId(value) ? value : null;
}

function joinWorker(vendor: string | null, model: string | null): string {
  if (!vendor && !model) return "Not available";
  if (!vendor) return model ?? "Not available";
  if (!model) return vendor;
  return `${vendor} · ${model}`;
}

/** How far a focused Inspect scroller moves. Null means this key does not scroll. */
export function inspectScrollTop(input: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  key: string;
  shift: boolean;
}): number | null {
  const page = Math.max(80, input.clientHeight - 48);
  let next = input.scrollTop;
  if (input.key === "ArrowDown") next += 48;
  else if (input.key === "ArrowUp") next -= 48;
  else if (input.key === "PageDown" || (input.key === " " && !input.shift)) next += page;
  else if (input.key === "PageUp" || (input.key === " " && input.shift)) next -= page;
  else if (input.key === "Home") next = 0;
  else if (input.key === "End") next = input.scrollHeight;
  else return null;
  const limit = Math.max(0, input.scrollHeight - input.clientHeight);
  return Math.max(0, Math.min(next, limit));
}

/** Next caller button for arrow keys. Null means this key does not move. */
export function inspectCallerStep(index: number, count: number, key: string): number | null {
  if (count <= 0 || index < 0) return null;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export const DESK_PLACES = ["desk", "inspect"] as const;
export type DeskPlace = (typeof DESK_PLACES)[number];

export function deskPlaceTitle(place: DeskPlace): string {
  return place === "inspect" ? "Inspect" : "Workhorse";
}

/** Next place in the shared menu. Arrow keys wrap. Null means this key does not move. */
export function placeMenuStep(index: number, key: string): number | null {
  const count = DESK_PLACES.length;
  if (!Number.isInteger(index) || index < 0 || index >= count) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function tokenLine(bills: readonly UsageEvent[]): { text: string; recorded: boolean } {
  if (bills.length === 0) return { text: "Not available", recorded: false };
  const totals = rollup([...bills]);
  if (
    totals.inputTokens === 0 &&
    totals.outputTokens === 0 &&
    totals.cacheReadTokens === 0 &&
    totals.cacheWriteTokens === 0
  ) {
    return { text: "0", recorded: true };
  }
  return {
    text: formatIoLine({
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      events: totals.events,
    }),
    recorded: true,
  };
}
