import { addLineupRow, emptyLineup, missionRowStatus, missionState } from "./lineup";
import { CAMPAIGN_PHASES, vendorDisplayName, workerMissionOutcome, workerTaskTitle, type MissionReportOutcome } from "./subagents";
import { normalizeCrewModes } from "./workhorse-rules";
import type {
  AgentRun,
  CampaignPhase,
  DeskLineup,
  DeskLineupRowStatus,
  MissionIteration,
  ProviderId,
  Session,
} from "./types";

export const CAMPAIGN_PHASE_LABEL: Record<CampaignPhase, string> = {
  scout: "Scout",
  review: "Review",
  approve: "Approve",
  build: "Build",
};

/** Child fields the board can show without reading transcript text. */
export type MissionBoardWorker = {
  id: string;
  parentId?: string | null;
  title: string;
  workerName?: string;
  status: Session["status"];
  provider: ProviderId;
  runStatus?: AgentRun["status"];
  missionId?: string;
  iteration?: number;
  phase?: CampaignPhase;
};

export type MissionBoardPhaseLook = {
  id: CampaignPhase;
  label: string;
  state: "done" | "current" | "upcoming";
};

export type MissionBoardSliceLook = {
  sessionId: string;
  title: string;
  slice: string;
  vendor: string;
  provider: ProviderId;
  status: DeskLineupRowStatus;
  live: boolean;
  outcome?: MissionReportOutcome;
  word: string;
};

export type MissionBoardLayerLook = {
  iteration: number;
  phase: CampaignPhase;
  current: boolean;
  slices: MissionBoardSliceLook[];
};

export type MissionBoardLook = {
  objective: string;
  iteration: number;
  maxIterations: number;
  phase: CampaignPhase;
  phases: MissionBoardPhaseLook[];
  criteria: string[];
  layers: MissionBoardLayerLook[];
  running: boolean;
  word?: string;
  tone?: "danger" | "quiet";
};

export function missionBoardWorkersFromSessions(
  parentId: string,
  sessions: Array<Pick<Session, "id" | "parentId" | "title" | "workerName" | "status" | "provider" | "agentRun">>,
): MissionBoardWorker[] {
  return sessions.flatMap((item) => {
    if (item.parentId !== parentId) return [];
    const mission = item.agentRun?.mission;
    return [
      {
        id: item.id,
        parentId: item.parentId,
        title: item.title,
        ...(item.workerName ? { workerName: item.workerName } : {}),
        status: item.status,
        provider: item.provider,
        ...(item.agentRun?.status ? { runStatus: item.agentRun.status } : {}),
        ...(mission?.id ? { missionId: mission.id } : {}),
        ...(mission?.iteration ? { iteration: mission.iteration } : {}),
        ...(mission?.phase ? { phase: mission.phase } : {}),
      },
    ];
  });
}

export function sameMissionBoardWorkers(left: MissionBoardWorker[], right: MissionBoardWorker[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((worker, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      worker.id === other.id &&
      worker.parentId === other.parentId &&
      worker.title === other.title &&
      worker.workerName === other.workerName &&
      worker.status === other.status &&
      worker.provider === other.provider &&
      worker.runStatus === other.runStatus &&
      worker.missionId === other.missionId &&
      worker.iteration === other.iteration &&
      worker.phase === other.phase
    );
  });
}

/** Lineup identity plus the fields the board paints. Streaming prose must not wake it. */
export function sameMissionBoardLineup(left: DeskLineup | undefined, right: DeskLineup | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.id !== right.id || left.rows.length !== right.rows.length) return false;
  const leftMission = left.mission;
  const rightMission = right.mission;
  if (leftMission !== rightMission) {
    if (!leftMission || !rightMission) return false;
    if (
      leftMission.id !== rightMission.id ||
      leftMission.iteration !== rightMission.iteration ||
      leftMission.phase !== rightMission.phase ||
      leftMission.maxIterations !== rightMission.maxIterations ||
      leftMission.objective !== rightMission.objective ||
      JSON.stringify(leftMission.acceptanceCriteria) !== JSON.stringify(rightMission.acceptanceCriteria)
    ) {
      return false;
    }
  }
  return left.rows.every((row, index) => {
    const other = right.rows[index];
    return (
      other !== undefined &&
      row.childId === other.childId &&
      row.status === other.status &&
      row.title === other.title &&
      row.slice === other.slice &&
      row.vendor === other.vendor &&
      row.iteration === other.iteration &&
      row.missionId === other.missionId &&
      row.report === other.report
    );
  });
}

function campaignPhases(current: CampaignPhase): MissionBoardPhaseLook[] {
  const here = CAMPAIGN_PHASES.indexOf(current);
  return CAMPAIGN_PHASES.map((id, index) => ({
    id,
    label: CAMPAIGN_PHASE_LABEL[id],
    state: index < here ? "done" : index === here ? "current" : "upcoming",
  }));
}

function runToRowStatus(worker: MissionBoardWorker): DeskLineupRowStatus {
  if (worker.status === "running" || worker.status === "needs-input" || worker.runStatus === "running") return "running";
  if (worker.runStatus === "failed" || worker.runStatus === "budget-exceeded") return "failed";
  if (worker.runStatus === "timed-out") return "timed-out";
  if (worker.runStatus === "cancelled") return "cancelled";
  if (worker.runStatus === "interrupted") return "interrupted";
  if (worker.runStatus === "completed") return "completed";
  return "unknown";
}

function sliceWord(
  status: DeskLineupRowStatus,
  sessionStatus: Session["status"] | undefined,
  outcome: MissionReportOutcome | undefined,
): string {
  if (sessionStatus === "needs-input") return "Needs you";
  if (status === "queued") return "Queued";
  if (status === "running") return "Working…";
  if (outcome === "blocked") return "Blocked";
  if (outcome === "continue") return "Continue";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "timed-out") return "Timed out";
  if (status === "cancelled") return "Cancelled";
  if (status === "interrupted") return "Interrupted";
  return "Unknown";
}

function asChildRef(worker: MissionBoardWorker | undefined): Pick<Session, "id" | "status" | "agentRun"> | undefined {
  if (!worker) return undefined;
  return {
    id: worker.id,
    status: worker.status,
    agentRun: worker.runStatus ? ({ status: worker.runStatus } as Session["agentRun"]) : undefined,
  };
}

type SliceSource = {
  sessionId: string;
  title: string;
  slice: string;
  vendor: string;
  provider: ProviderId;
  status: DeskLineupRowStatus;
  sessionStatus?: Session["status"];
  iteration: number;
  phase: CampaignPhase;
  report?: string;
};

function collectSlices(
  lineup: DeskLineup,
  workers: MissionBoardWorker[],
): SliceSource[] {
  const mission = lineup.mission;
  if (!mission) return [];
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  const seen = new Set<string>();
  const slices: SliceSource[] = [];

  for (const row of lineup.rows) {
    const child = byId.get(row.childId);
    const status = missionRowStatus(row, asChildRef(child));
    seen.add(row.childId);
    slices.push({
      sessionId: row.childId,
      title: row.title.trim() || child?.title || "Worker",
      slice: row.slice.trim(),
      vendor: row.vendor.trim(),
      provider: child?.provider ?? "custom",
      status,
      ...(child?.status ? { sessionStatus: child.status } : {}),
      iteration: row.iteration ?? child?.iteration ?? mission.iteration,
      phase: child?.phase ?? (row.iteration && row.iteration !== mission.iteration ? "scout" : mission.phase),
      ...(row.report?.trim() ? { report: row.report } : {}),
    });
  }

  for (const worker of workers) {
    if (seen.has(worker.id)) continue;
    if (worker.missionId !== mission.id || !worker.iteration) continue;
    slices.push({
      sessionId: worker.id,
      title: worker.title.trim() || worker.workerName || "Worker",
      slice: "",
      vendor: "",
      provider: worker.provider,
      status: runToRowStatus(worker),
      sessionStatus: worker.status,
      iteration: worker.iteration,
      phase: worker.phase ?? "scout",
    });
  }

  return slices;
}

function toSliceLook(source: SliceSource): MissionBoardSliceLook {
  const outcome = workerMissionOutcome(source.report);
  const live =
    source.sessionStatus === "running" ||
    source.sessionStatus === "needs-input" ||
    source.status === "queued" ||
    source.status === "running";
  return {
    sessionId: source.sessionId,
    title: source.title,
    slice: source.slice,
    vendor: source.vendor,
    provider: source.provider,
    status: source.status,
    live,
    ...(outcome ? { outcome } : {}),
    word: sliceWord(source.status, source.sessionStatus, outcome),
  };
}

/**
 * What the session notices board paints for an adaptive mission.
 * Ordinary one-wave lineups without mission metadata stay off this surface.
 */
export function missionBoardView(
  session: Pick<Session, "id" | "lineup"> | null | undefined,
  workers: MissionBoardWorker[] = [],
): MissionBoardLook | undefined {
  const lineup = session?.lineup;
  const mission = lineup?.mission;
  if (!session || !lineup || !mission) return undefined;

  const sources = collectSlices(lineup, workers);
  const byPass = new Map<number, SliceSource[]>();
  for (const source of sources) {
    const rows = byPass.get(source.iteration) ?? [];
    rows.push(source);
    byPass.set(source.iteration, rows);
  }

  const layers: MissionBoardLayerLook[] = [...byPass.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([iteration, rows]) => {
      const current = iteration === mission.iteration;
      return {
        iteration,
        phase: current ? mission.phase : (rows[0]?.phase ?? "scout"),
        current,
        slices: rows.map(toSliceLook),
      };
    });
  if (!layers.some((layer) => layer.current)) {
    layers.unshift({
      iteration: mission.iteration,
      phase: mission.phase,
      current: true,
      slices: [],
    });
  }

  const children = workers.map((worker) => ({
    id: worker.id,
    status: worker.status,
    agentRun: worker.runStatus ? ({ status: worker.runStatus } as Session["agentRun"]) : undefined,
  }));
  const state = missionState(lineup, children);

  return {
    objective: mission.objective,
    iteration: mission.iteration,
    maxIterations: mission.maxIterations,
    phase: mission.phase,
    phases: campaignPhases(mission.phase),
    criteria: mission.acceptanceCriteria,
    layers,
    running: Boolean(state?.running),
    ...(state?.word ? { word: state.word } : {}),
    ...(state?.tone ? { tone: state.tone } : {}),
  };
}

export function missionBoardKicker(view: Pick<MissionBoardLook, "iteration" | "maxIterations" | "phase">): string {
  return `Mission · Pass ${view.iteration} of ${view.maxIterations} · ${CAMPAIGN_PHASE_LABEL[view.phase]}`;
}

export function missionBoardChip(view: Pick<MissionBoardLook, "phase">): string {
  return `Mission · ${CAMPAIGN_PHASE_LABEL[view.phase]}`;
}

export const DEMO_MISSION_ID = "mission_demo";
export const DEMO_MISSION_NOTICE =
  "Demo mission. Sample board data — no vendor is running. Type /demo-mission again to reset it.";

export function demoMissionIds(parentId: string): { scoutId: string; reviewId: string; auditorId: string } {
  return {
    scoutId: `${parentId}__demo_scout`,
    reviewId: `${parentId}__demo_review`,
    auditorId: `${parentId}__demo_audit`,
  };
}

function isDemoWorkerId(parentId: string, sessionId: string): boolean {
  return sessionId.startsWith(`${parentId}__demo_`);
}

function demoContract(): MissionIteration {
  return {
    id: DEMO_MISSION_ID,
    mode: "adaptive",
    objective: "Ship leftover rings without touching production",
    acceptanceCriteria: ["Tests pass on the worktree", "No writes outside assigned paths"],
    iteration: 2,
    maxIterations: 4,
    previousWorkerIds: [],
    phase: "review",
  };
}

function demoChild(
  parent: Session,
  id: string,
  input: {
    name: string;
    slice: string;
    status: Session["status"];
    run: AgentRun;
    messages: Session["messages"];
  },
): Session {
  return {
    ...parent,
    id,
    parentId: parent.id,
    hidden: true,
    title: workerTaskTitle(input.name, input.slice),
    titleLocked: true,
    workerName: input.name,
    status: input.status,
    contextUsed: 0,
    messages: input.messages,
    agentRun: input.run,
    lineup: undefined,
    crewModes: undefined,
    composerDraft: undefined,
    composerImages: undefined,
    queue: undefined,
    goal: undefined,
    planRun: undefined,
  };
}

/**
 * Pin a sample adaptive mission on this chat so the compact board can be judged
 * without a live vendor wave. Re-running replaces the previous demo workers.
 */
export function applyDemoMission(input: {
  sessions: Session[];
  parent: Session;
  now?: number;
}): { sessions: Session[]; parentId: string } {
  const now = input.now ?? Date.now();
  const parent = input.parent;
  const ids = demoMissionIds(parent.id);
  const vendor = vendorDisplayName(parent.provider);
  const scoutMission: MissionIteration = { ...demoContract(), iteration: 1, phase: "scout", previousWorkerIds: [] };
  const reviewMission: MissionIteration = { ...demoContract(), previousWorkerIds: [ids.scoutId] };
  const folder = parent.lineup?.folder ?? "";
  const scout = demoChild(parent, ids.scoutId, {
    name: "Wren",
    slice: "Scout the tree",
    status: "idle",
    run: {
      status: "completed",
      startedAt: now - 120_000,
      finishedAt: now - 60_000,
      isolation: "worktree",
      mission: scoutMission,
    },
    messages: [
      { id: `${ids.scoutId}_u`, role: "user", text: "Scout leftover rings. Do not write.", createdAt: now - 120_000 },
      {
        id: `${ids.scoutId}_a`,
        role: "assistant",
        text: "The leftover rings live in Usage and the weekly leftover file. Production is untouched.\n\nMission status: continue.",
        createdAt: now - 60_000,
      },
    ],
  });
  const review = demoChild(parent, ids.reviewId, {
    name: "Dexter",
    slice: "Review leftover rings",
    status: "running",
    run: {
      status: "running",
      startedAt: now - 18_000,
      isolation: "worktree",
      mission: reviewMission,
    },
    messages: [
      { id: `${ids.reviewId}_u`, role: "user", text: "Review Wren's scout. Remaining work only.", createdAt: now - 18_000 },
    ],
  });
  const auditor = demoChild(parent, ids.auditorId, {
    name: "Marlow",
    slice: "Check the review brief",
    status: "idle",
    run: {
      status: "completed",
      startedAt: now - 40_000,
      finishedAt: now - 8_000,
      isolation: "shared",
      mission: reviewMission,
    },
    messages: [
      { id: `${ids.auditorId}_u`, role: "user", text: "Confirm the review brief still matches the criteria.", createdAt: now - 40_000 },
      {
        id: `${ids.auditorId}_a`,
        role: "assistant",
        text: "Criteria still hold. Dexter owns the remaining review.\n\nMission status: continue.",
        createdAt: now - 8_000,
      },
    ],
  });
  let lineup = emptyLineup(folder, now - 18_000, reviewMission.objective, "desk");
  lineup = addLineupRow(
    lineup,
    {
      childId: ids.reviewId,
      title: review.title,
      slice: "Review leftover rings",
      folder,
      vendor,
      status: "running",
      startedAt: now - 18_000,
      missionId: DEMO_MISSION_ID,
      iteration: 2,
    },
    "desk",
    reviewMission,
  );
  lineup = addLineupRow(
    lineup,
    {
      childId: ids.auditorId,
      title: auditor.title,
      slice: "Check the review brief",
      folder,
      vendor,
      status: "completed",
      startedAt: now - 40_000,
      finishedAt: now - 8_000,
      report: "Criteria still hold. Dexter owns the remaining review.\n\nMission status: continue.",
      missionId: DEMO_MISSION_ID,
      iteration: 2,
    },
    "desk",
    reviewMission,
  );
  const notice = { id: `${parent.id}__demo_notice`, role: "system" as const, text: DEMO_MISSION_NOTICE, createdAt: now };
  const messages = [
    ...parent.messages.filter((message) => message.id !== notice.id && message.text !== DEMO_MISSION_NOTICE),
    ...(parent.messages.some((message) => message.role === "user")
      ? []
      : [{ id: `${parent.id}__demo_user`, role: "user" as const, text: reviewMission.objective, createdAt: now - 1 }]),
    notice,
  ];
  const nextParent: Session = {
    ...parent,
    title: parent.title.trim() && parent.title.trim().toLowerCase() !== "new chat" ? parent.title : "Leftover rings",
    crewModes: normalizeCrewModes([...(parent.crewModes ?? []), "mission"]),
    lineup,
    messages,
  };
  const sessions = [
    ...input.sessions.filter((session) => session.id !== parent.id && !isDemoWorkerId(parent.id, session.id)),
    nextParent,
    scout,
    review,
    auditor,
  ];
  return { sessions, parentId: parent.id };
}
