import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StoreContext, StoreRuntimeContext, useStore } from "./store-context";
export { useStore, useStoreReader, useStoreSelector } from "./store-context";
import { commandContinuesToVendor, commandsForSession, matchCommand } from "./commands";
import { isWorkhorseGoalControl, isWorkhorseGoalIntent, parseGoalInput, parseGrokGoalLine } from "./goal";
import { nextGoalForSend, planHaltForward, prepareVendorSend, vendorTerminalAction } from "./vendor-send";
import { customChatHistory } from "./custom-history";
import { uid } from "./id";
import {
  archiveChat,
  autoRenameChat,
  deleteChat,
  dropDrafts,
  appendUserMessage,
  deleteWorkerChats,
  dropQueuedPrompt,
  enqueuePrompt,
  forkChat,
  lastUserMessage,
  applyDeleteDeskChat,
  applyDeleteLooseDeskChats,
  isLooseDeleteScope,
  applyRenameDeskChat,
  listedChats,
  applyComposerDrafts,
  sameComposerDraft,
  snapComposerDraft,
  type ComposerDraftSnap,
  moveChat,
  resolveListedChat,
  openDraft,
  renameChat,
  rewindToUserMessage,
  shiftQueuedPrompt,
  sidebarKeepsChat,
} from "./chats";
import { workerJustSettled } from "./worker-settled";
import { deskPersistBodyEqual } from "./desk-persist";
import { autoTitleForSend, firstUserText, suggestedTitleForSession, titleAcceptsVendor, titleFromIntent } from "./titles";
import {
  applyPermissionAnswer,
  autoAllowPermission,
  describeElevation,
  elevationForBlock,
  enqueuePermission,
  grantedPolicyAnswer,
  inboundAccess,
  classifyElevationInput,
  parseElevationInput,
  permissionPolicyAnswer,
  permissionResumeStatus,
  securityPolicyAnswer,
  workerAccess,
  workerGrant,
} from "./permissions";
import {
  applyDeleteCustomBot,
  applyInstallCustomBot,
  publicBotCard,
  type PublicBotCard,
} from "./bot-setup";
import {
  applyUpdateCustomBot,
  botFromDraft,
  customBotForSession,
  customBotServes,
  draftReady,
  EMPTY_CUSTOM_DRAFT,
  normalizeCustomModelList,
} from "./custom-bots";
import {
  DEFAULT_CHOICE,
  applyVendorCatalog,
  contextWindowFor,
  defaultModel,
  findChoice,
  normalizeModelId,
  parseEffort,
  withEffort,
} from "./models";
import { mergeStreamedText } from "./markdown";
import { applyStreamQueues, createStreamCommitScheduler } from "./stream-commit";
import { APP_VERSION } from "./app-info";
import type { AppUpdateCheckResult, AppUpdateOffer } from "./app-update";
import type { GrokBotWakeInput, GrokBotWakeStatus } from "./grok-bot-wake";
import {
  applyArchiveProject,
  applyCreateWorkhorseProject,
  applyDeleteProject,
  applyProjectChatFate,
  applyRenameDeskProject,
  renameTookOnDesk,
  visibleProjectNames,
  emptyProject,
  findProjectByQuery,
  folderFromPath,
  normalizeProject,
  primaryFolder,
  projectFolderPaths,
  projectForSpawn,
} from "./project";
import { isParentTakeoverTool, isWriteToolTitle, projectEdits, writePathFromToolEvent } from "./project-edits";
import { isProviderId, providerById } from "./providers";
import { sameDeskSkills } from "./skills-catalog";
import { withSkillDiscoveryHint } from "./skill-suggestions";
import { mcpServersForSession } from "./mcp-servers";
import {
  applyUpdateStockBot,
  DEFAULT_SETTINGS,
  firstAttachedChoice,
  isSettingsSection,
  keepVendorAccessDefaults,
  normalizeSettings,
  normalizeAgentSystems,
  normalizeRouting,
  vendorAttachedForSession,
  vendorLaunchGate,
} from "./settings";
import { acceptInboundEnvelope, allowedExternalCandidates, formatExternalAgentRef, parseExternalAgentRef } from "./agent-runtime";
import { decideDispatch } from "./dispatch";
import { projectExternalAgentCatalog } from "./external-catalog";
import { inboundDeskAction, inboundSpawnParent, mcpExposureProfile } from "../../electron/mcp-exposure";
import {
  emptyTaskStore,
  envelopeForTrace,
  launchExternalAssignment,
  normalizeTaskStore,
  reconcileLineupOnRestart,
  reconcileTaskStoreOnRestart,
} from "./external-task";
import {
  chooseRoutingDecision,
  describeRoutingMiss,
  inferRoutingTier,
  outcomesFromLearningEvents,
  routingCandidatesForDesk,
  routingDecisionEvidence,
  routingIdentityExcluded,
  routingProfileForModel,
  shouldRouteSessionTurn,
  shouldShadowRouteSessionTurn,
  spawnEffortFor,
} from "./routing";
import type { AgentRun, AgentSystemsSettings, ExternalTask, FileLease } from "./types";
import {
  approvePlanRun,
  assignPlanStep,
  blockPlanRun,
  cancelPlanRun,
  completePlanRun,
  grantExternalAgents,
  normalizePlanRun,
  pausePlanRun,
  readyPlanStepIds,
  recordPlanEvidence,
  recordPlanEvent,
  reopenPlanStep,
  revisePlanStep,
  resumePlanRun,
  revokeExternalAgents,
  setPlanStepStatus,
  startPlanRun,
} from "./plan";
import {
  applyCompactUsage,
  formatCompactLine,
  applyFailedPeerAsk,
  failPeerAskMessages,
  finishOpenToolMessages,
  toolIsFinished,
  upsertCompactMessage,
  upsertThoughtMessage,
  upsertToolMessage,
} from "./grok-events";
import { chatPreview, formatPeerPrompt, sameSessionCrew } from "./session-bridge";
import {
  addLineupRow,
  applyChildIdleSync,
  lineupStatusForTerminalRun,
  awaitAgentsWaits,
  childReportText,
  emptyLineup,
  formatAwaitAgentsSnapshot,
  lineupSnapshot,
  applyJoinRateLimitRetry,
  isJoinAssistantTurn,
  JOIN_MAX_ATTEMPTS,
  looksLikeJoinPrompt,
  handOverLineup,
  queueWakeDelayMs,
  reconcileIdleChildren,
  reconcilePersistedLineups,
  setLineupRowStatus,
  stampLineupUserText,
} from "./lineup";
import { applyPlanAuditorSpawn, joinAndAdmit } from "./plan-admission";
import {
  applyCancelWorker,
  admitSpawn,
  assertAgentPathWrite,
  campaignGateError,
  expiredWorkerIds,
  WORKER_DEADLINE_SWEEP_MS,
  claimSharedFiles,
  collectChildAgentReports,
  deskRoleOf,
  descendantSessionIds,
  vendorTextForSpawn,
  isHiddenSession,
  nestedSpawnError,
  nestedWorkerPolicy,
  normalizeMissionIteration,
  normalizeFileLeases,
  normalizePathAllowlist,
  overlappingAgentFiles,
  parentHasRunningChildren,
  maxRootWorkers,
  nextCampaignPhase,
  nextMissionIteration,
  rootSpawnError,
  resolveSpawnSpec,
  missionForDeskSpawn,
  findReusableWorker,
  fileContentsFingerprint,
  leasePathForWrite,
  refreshSharedFileFingerprint,
  resolveNamedWorker,
  parseWorkerHandoff,
  workerStartMessages,
  reserveWorkerName,
  recordParentTakeover,
  releaseCancelledSessionLeases,
  releaseDeletedSessionLeases,
  releaseSessionLeases,
  appendRunEvent,
  scopedChildAgentIds,
  type WorkerNameReservation,
  type WorkerRecord,
  shouldAutoRouteSpawn,
  routingDecisionMatchesSpawn,
  constrainRouteCandidatesForSpawn,
  spawnExclusions,
  spawnWaitsForReply,
  withSubagentStatus,
  workerStatusSnapshot,
  workerTaskTitle,
  continueWorkerRun,
  vendorDisplayName,
  workerReportedBlocked,
} from "./subagents";
import {
  applySessionModelChange,
  applySessionPolicyChange,
  applyVendorTurnIdle,
  brainStamp,
  formatChatSidebar,
  normalizeSession,
  parsePermissionMode,
  parseSandbox,
  vendorSessionForSend,
} from "./session";
import { sessionExecutionCwd } from "./session-environment";
import { parseScheduleCommand } from "./schedule";
import { withPortableHistory } from "./portable-history";
import { createPortableCheckpoint, messagesForPortableReplay } from "./portable-compaction";
import { appendLiveTool, appendOpenTurnUser, recordLiveCompact } from "./session-ledger";
import { fitModelImages, hasSendableAttachment } from "./images";
import { estimateMessageTokens } from "./context-stats";
import { buildSessionPreface } from "./context-preface";
import {
  applyCompactOutcome,
  applyUsageContext,
  backfillCursorUsage,
  estimateFromSessionTurn,
  normalizeUsage,
  occupancyFromUsage,
  rehomeCustomUsage,
  settleTurnUsage,
  usageHasBilledTokens,
  usageHomeForReport,
} from "./usage";
import {
  applyWorkerBudgetUsage,
  beginAssignmentBudget,
  BUDGET_HANDOFF_PROMPT,
  missionUsedTokens,
  needsBudgetHandoffTurn,
  nestedHelperBudget,
  nextBudgetRunState,
  parentBudgetRemaining,
} from "./worker-budget";
import { clampPaneWidth, SIDEBAR_PANE, THREAD_PANE } from "./pane";
import {
  assistantHasVisibleReply,
  isVendorRateLimitError,
  settleEmptyAssistantText,
  turnEndedWithoutProse,
  turnWorkedAfterAssistant,
  vendorFailedMessage,
  vendorRateLimitNotice,
  vendorSendTarget,
} from "./vendor-bridge";
import { cursorUsageLane } from "./cursor-lane";
import {
  collectWatchNotices,
  deskCallCatalog,
  deskCallRowFor,
  formatDeskRoster,
  evaluateWatchHold,
  vendorCallBlocked,
  vendorDeclinedForBot,
  vendorGrantedForChat,
  vendorOverrideNeeded,
  spawnIsNoGo,
  watchHoldMessage,
  leftoverByWatchKey,
  dayKey,
  watchKeyForSession,
  normalizeWatch,
  normalizeWatchDayMarks,
  normalizeWatchPermits,
  pruneWatchPermits,
  syncWatchDayMarks,
  watchVendorStatuses,
  type WatchHold,
  type WatchNotice,
} from "./watch";
import { applyWorkhorseToggle, isConcreteTheme, isTheme, nextTheme } from "./theme";
import { effectiveLearningMode, learningCaptures, normalizeLearning } from "./learning-policy";
import { normalizeLocalComputeSettings } from "./local-compute";
import { agentTurnEvidence, learningEvidenceId } from "./learning-agent-evidence";
import { settleSessionGoals } from "./learning-goal";
import { BACKFILL_SUMMARY_CHARS, backfillEventId } from "./learning-backfill";
import type {
  AppState,
  CrewMode,
  CampaignPhase,
  CustomBot,
  CustomLlm,
  DeskAccess,
  EffortLevel,
  GrokPlanUsage,
  LinkedReference,
  McpServerConfig,
  PermissionMode,
  PermissionRequest,
  Profile,
  Project,
  ProviderId,
  ReferenceKind,
  SandboxProfile,
  Session,
  SessionEnvironment,
  SessionSecurityPolicy,
  MissionIteration,
  DeskExportKind,
  DeskExportResult,
  DeskSkill,
  SettingsSection,
  Sheet,
  Theme,
  UsageDraft,
  UsageRange,
  WatchSettings,
  RoutingSettings,
} from "./types";

const EMPTY: AppState = {
  theme: "system",
  projects: [],
  sessions: [],
  activeProjectId: null,
  activeSessionId: null,
  pending: [],
  leases: [],
  dismissedAttention: [],
  sheet: null,
  panel: null,
  settingsSection: "profile",
  settings: structuredClone(DEFAULT_SETTINGS),
  watchPermits: {},
  watchDayMarks: {},
  usage: [],
  usageRange: "month",
  sidebarWidth: SIDEBAR_PANE.fallback,
  threadWidth: THREAD_PANE.fallback,
  lastModel: DEFAULT_CHOICE,
  externalTasks: emptyTaskStore(),
};

export type Store = AppState & {
  ready: boolean;
  catalogRev: number;
  createProject: (name: string, folderPaths?: string[]) => string;
  openSheet: (sheet: Sheet) => void;
  closeSheet: () => void;
  selectProject: (id: string) => void;
  linkFolder: (path?: string) => Promise<void>;
  unlinkFolder: (folderId: string) => void;
  addReference: (kind: ReferenceKind, value: string, label?: string) => void;
  removeReference: (referenceId: string) => void;
  archiveProject: (id: string, archived?: boolean) => void;
  deleteProject: (id: string, chats: "keep" | "remove") => void;
  startSession: (projectId?: string | null, provider?: ProviderId) => void;
  setSessionModel: (provider: ProviderId, model: string, customBotId?: string) => void;
  setSessionRoutingMode: (mode: "auto" | "manual") => void;
  setCrewMode: (modes: CrewMode[] | undefined) => void;
  /** Pick an interrupted worker back up. Returns why not, when it cannot. */
  resumeAgentRun: (sessionId: string) => { ok: boolean; message: string };
  createCustomBot: () => string | null;
  installCustomBot: (draft: CustomLlm) => { ok: boolean; created: boolean; bot?: PublicBotCard; error?: string };
  deleteCustomBot: (id: string) => void;
  updateCustomBot: (id: string, patch: Partial<CustomBot>) => void;
  setCustomBotEnabled: (id: string, enabled: boolean) => void;
  probeCustomDraft: () => Promise<{ ok: boolean; message: string }>;
  probeCustomBot: (id: string) => Promise<{ ok: boolean; message: string }>;
  setSessionEffort: (effort: EffortLevel) => void;
  setSessionEnvironment: (kind: "local" | "worktree") => Promise<{ ok: boolean; message: string }>;
  selectSession: (id: string) => void;
  setComposerDraft: (id: string, text: string, images?: import("./types").ChatImage[], commit?: boolean) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  deleteWorkers: (parentId: string) => void;
  archiveSession: (id: string, archived?: boolean) => void;
  moveSession: (id: string, projectId: string) => void;
  forkFrom: (messageId: string, sessionId?: string) => void;
  send: (
    text: string,
    options?: { replaceUserId?: string; images?: import("./types").ChatImage[]; steer?: boolean; permit?: boolean },
  ) => boolean | void;
  dropQueued: (id: string) => void;
  steerQueued: (id: string) => void;
  resendFrom: (messageId: string, text: string) => void;
  editMessageId: string | null;
  requestEditMessage: (messageId: string) => void;
  requestEditLastPrompt: (sessionId?: string) => void;
  clearEditMessage: () => void;
  cancelRun: () => void;
  setMode: (mode: PermissionMode) => void;
  setDeskAccess: (patch: Partial<DeskAccess>) => void;
  setSandbox: (sandbox: SandboxProfile) => void;
  setSecurityPolicy: (patch: Partial<SessionSecurityPolicy>) => void;
  setMcpServers: (servers: McpServerConfig[]) => Promise<void>;
  probeMcpServer: (serverName: string) => Promise<import("./types").McpProbeResult>;
  refreshGrokLogin: () => void;
  refreshCodexLogin: () => void;
  refreshClaudeLogin: () => void;
  refreshCursorLogin: () => void;
  refreshCustomLogin: () => void;
  cycleTheme: () => void;
  toggleWorkhorseTheme: () => void;
  answerPermission: (id: string, answer: "once" | "session" | "deny") => void;
  demoPermission: () => void;
  recordUsage: (draft: UsageDraft) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  openAddBot: () => void;
  closeAddBot: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  /** False for a linked folder that has been moved or deleted. */
  folderExists: (path: string) => boolean;
  /**
   * The same answer, as a value that changes identity when it changes — so a
   * screen showing linked folders redraws when one of them dies.
   */
  missingFolderPaths: ReadonlySet<string>;
  deskSkills: DeskSkill[];
  listDeskSkills: () => Promise<DeskSkill[]>;
  refreshDeskSkills: () => Promise<DeskSkill[]>;
  massSendVendor: (
    id: ProviderId,
    kind: DeskExportKind,
    options?: { customBotId?: string; botName?: string },
  ) => Promise<DeskExportResult>;
  exportSession: (sessionId: string) => Promise<DeskExportResult>;
  importDeskSkill: () => Promise<DeskExportResult>;
  readDeskSkill: (
    query: string,
  ) => Promise<{ ok: boolean; skill?: { name: string; origin: import("./types").SkillOrigin; dir: string; text: string }; message?: string }>;
  deleteDeskSkill: (dir: string) => Promise<DeskExportResult>;
  pushDeskSkill: (dir: string, target: "grok" | "codex" | "claude" | "cursor", name?: string) => Promise<DeskExportResult>;
  updateProfile: (patch: Partial<Profile>) => void;
  setLlmConnected: (id: Exclude<ProviderId, "custom">, connected: boolean) => void;
  setLlmEnabled: (id: Exclude<ProviderId, "custom">, enabled: boolean) => void;
  updateLlmLink: (id: Exclude<ProviderId, "custom">, patch: Partial<Pick<import("./types").LlmLink, "name" | "color">>) => void;
  updateCustomLlm: (patch: Partial<CustomLlm>) => void;
  setTheme: (theme: Theme) => void;
  openUsage: () => void;
  closeUsage: () => void;
  setUsageRange: (range: UsageRange) => void;
  setSidebarWidth: (width: number) => void;
  setThreadWidth: (width: number) => void;

  setUsageBudget: (provider: ProviderId, tokens: number | null) => void;
  updateWatch: (patch: Partial<WatchSettings>) => void;
  updateRouting: (patch: Partial<RoutingSettings>) => void;
  updateAgentSystems: (patch: Partial<AgentSystemsSettings>) => void;
  updateLocalCompute: (settings: import("./types").LocalComputeSettings) => void;
  grantPlanExternalAgents: (sessionId: string, allow: boolean) => void;
  agentRuntimes: import("./external-catalog").AgentRuntimeStatus[];
  agentCatalog: import("./external-catalog").ExternalAgent[];
  refreshAgentRuntimes: () => Promise<void>;
  installExternalMcp: (hosts?: string[]) => Promise<{ ok: boolean; message?: string }>;
  linkConfig: () => Promise<string>;
  linkGrokBotOneshot: () => Promise<string>;
  grokBotWakeStatus: GrokBotWakeStatus | null;
  refreshGrokBotWake: () => Promise<GrokBotWakeStatus>;
  saveGrokBotWake: (input: GrokBotWakeInput) => Promise<GrokBotWakeStatus>;
  installLinkCommand: () => Promise<{ ok: boolean; message?: string }>;
  updateLearning: (patch: Partial<import("./learning-types").LearningSettings>) => void;
  watchNotices: WatchNotice[];
  watchHold: WatchHold | null;
  watchRestore: { text: string; images?: import("./types").ChatImage[] } | null;
  permitWatchHold: (kind: "once" | "conversation" | "until-reset") => void;
  denyWatchHold: () => void;
  clearWatchRestore: () => void;
  grokPlan?: import("./types").GrokPlanUsage;
  refreshGrokPlan: () => void;
  codexPlan?: import("./types").GrokPlanUsage;
  refreshCodexPlan: () => void;
  claudePlan?: import("./types").GrokPlanUsage;
  refreshClaudePlan: () => void;
  cursorPlan?: import("./types").GrokPlanUsage;
  refreshCursorPlan: () => void;
  customPlans: Record<string, import("./types").GrokPlanUsage | undefined>;
  customPlanKnown: Record<string, boolean>;
  /** Built-in vendors whose meter has answered at least once, by provider id. */
  vendorPlanKnown: Record<string, boolean>;
  refreshCustomPlans: () => void;
  quit: () => void;
  appUpdate: AppUpdateOffer | null;
  appUpdateBusy: boolean;
  appUpdateError: string | null;
  checkAppUpdate: (opts?: { reveal?: boolean }) => Promise<AppUpdateCheckResult>;
  applyAppUpdate: (version?: string) => Promise<void>;
};

type SendOptions = {
  replaceUserId?: string;
  images?: import("./types").ChatImage[];
  steer?: boolean;
  permit?: boolean;
  sessionId?: string;
  scheduledRunId?: string;
  hideUser?: boolean;
  joinAttempt?: number;
  afterGoalHalt?: boolean;
};

type LearningTurnLink = {
  correlationId: string;
  agentRunId: string;
  toolIds: string[];
};

const learningOutcomeEvents: Array<{
  kind: "outcome";
  provider?: ProviderId;
  model?: string;
  customBotId?: string;
  payload: Record<string, unknown>;
}> = [];

function emitLearningEvent(draft: {
  id?: string;
  createdAt?: number;
  kind: import("./learning-types").LearningEventKind;
  projectId?: string | null;
  sessionId?: string;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel | null;
  payload: Record<string, unknown>;
  actorClass?: "human" | "agent" | "system";
  correlationId?: string;
  agentRunId?: string;
  toolIds?: string[];
  customBotId?: string;
}) {
  if (draft.kind === "outcome") {
    learningOutcomeEvents.push({
      kind: "outcome",
      provider: draft.provider,
      model: draft.model,
      customBotId: draft.customBotId,
      payload: draft.payload,
    });
    if (learningOutcomeEvents.length > 200) learningOutcomeEvents.splice(0, learningOutcomeEvents.length - 200);
  }
  void window.workhorse?.learningRecord?.({
    id: draft.id ?? uid("lev"),
    createdAt: draft.createdAt ?? Date.now(),
    kind: draft.kind,
    actorClass: draft.actorClass ?? "system",
    projectId: draft.projectId ?? undefined,
    sessionId: draft.sessionId,
    provider: draft.provider,
    model: draft.model,
    effort: draft.effort,
    correlationId: draft.correlationId,
    agentRunId: draft.agentRunId,
    toolIds: draft.toolIds,
    payload: draft.payload,
  });
}

export function hydrateInterruptedPathLeases(raw: unknown, sessions: Session[]): FileLease[] {
  return normalizeFileLeases(raw).filter((lease) =>
    sessions.some((session) => {
      if (session.id !== lease.sessionId || !session.agentRun) return false;
      if (session.agentRun.status !== "running" && session.agentRun.status !== "interrupted") return false;
      return normalizePathAllowlist(session.agentRun.paths).some(
        (owned) => owned.toLowerCase() === lease.path.toLowerCase(),
      );
    }),
  );
}

export function campaignSpawnGate(input: {
  campaignContext: boolean;
  requested: MissionIteration | undefined;
  desk: MissionIteration | undefined;
}): { mission: MissionIteration | undefined; error: string | undefined; phase: Exclude<CampaignPhase, "build"> | undefined } {
  const mission = missionForDeskSpawn(input.requested, input.desk);
  const error = input.campaignContext ? campaignGateError(mission, input.desk) : undefined;
  const phase = mission && mission.phase !== "build" ? mission.phase : undefined;
  return { mission, error, phase };
}

function sameMissionIteration(left: MissionIteration, right: MissionIteration): boolean {
  return (
    left.id === right.id &&
    left.mode === right.mode &&
    left.objective === right.objective &&
    JSON.stringify(left.acceptanceCriteria) === JSON.stringify(right.acceptanceCriteria) &&
    left.iteration === right.iteration &&
    left.maxIterations === right.maxIterations &&
    JSON.stringify(left.previousWorkerIds) === JSON.stringify(right.previousWorkerIds) &&
    left.phase === right.phase &&
    left.tokenBudget === right.tokenBudget
  );
}

/**
 * The Link continuation has already read the live worker wave before it asks the
 * store to spawn the next pass. A debounced store snapshot can still say that
 * those workers are running. Reconcile only that lifecycle lag,
 * and only when the desk's persisted lineup holds the exact prior manifest and
 * the request is the one-phase successor of it.
 */
function sessionsForDeskMissionDerivation(input: {
  sessions: Session[];
  requested: MissionIteration;
  lineup: MissionIteration | undefined;
  liveContinuation: { previousWorkerIds: string[]; completedWorkerIds: string[]; previousPass: number } | undefined;
}): Session[] {
  const prior = input.lineup;
  if (!prior || prior.iteration >= prior.maxIterations) return input.sessions;
  const ids = [...new Set(input.requested.previousWorkerIds.map((id) => id.trim()).filter(Boolean))];
  const liveIds = [...new Set((input.liveContinuation?.previousWorkerIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const completedIds = [...new Set((input.liveContinuation?.completedWorkerIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (
    input.liveContinuation?.previousPass !== prior.iteration ||
    JSON.stringify(liveIds) !== JSON.stringify(ids) ||
    JSON.stringify(completedIds) !== JSON.stringify(ids)
  ) {
    return input.sessions;
  }
  const coordinator = ids
    .map((id) => input.sessions.find((session) => session.id === id))
    .find((session) => session?.agentRun?.mission?.mode === "adaptive");
  if (!coordinator?.agentRun?.mission || !sameMissionIteration(coordinator.agentRun.mission, prior)) {
    return input.sessions;
  }
  const phase = nextCampaignPhase(prior.phase);
  if (!phase) return input.sessions;
  const expected: MissionIteration = {
    ...prior,
    iteration: prior.iteration + 1,
    previousWorkerIds: ids,
    phase,
    clearance: undefined,
  };
  if (!sameMissionIteration(expected, input.requested)) return input.sessions;
  const workerIds = new Set(ids);
  return input.sessions.map((session) => {
    if (!workerIds.has(session.id) || !session.agentRun) return session;
    if (session.agentRun.status !== "running") return session;
    return { ...session, agentRun: { ...session.agentRun, status: "completed" } };
  });
}

/**
 * A build claim is never trusted. The desk may hold the requested pass because
 * it already persisted that exact lineup mission, or because it independently
 * derives the next pass from workers that carry its exact prior manifest.
 */
export function deskMissionForStoreSpawn(input: {
  sessions: Session[];
  parentId: string;
  requested: MissionIteration | undefined;
  lineup: MissionIteration | undefined;
  agentRun: MissionIteration | undefined;
  liveContinuation?: { previousWorkerIds: string[]; completedWorkerIds: string[]; previousPass: number };
}): MissionIteration | undefined {
  const requested = input.requested;
  if (requested && input.lineup?.id === requested.id && input.lineup.iteration === requested.iteration) {
    return input.lineup;
  }
  if (requested && requested.previousWorkerIds.length > 0) {
    const sessions = sessionsForDeskMissionDerivation({
      sessions: input.sessions,
      requested,
      lineup: input.lineup,
      liveContinuation: input.liveContinuation,
    });
    const derived = nextMissionIteration(
      sessions,
      input.parentId,
      requested.previousWorkerIds,
      requested.iteration - 1,
    );
    if (derived.ok && sameMissionIteration(derived.mission, requested)) return derived.mission;
  }
  return input.agentRun;
}

function hydrate(value: unknown): AppState {
  if (!value || typeof value !== "object") return EMPTY;
  const { watchDismissed: _droppedWatchDismissed, ...record } = value as Partial<AppState> & {
    watchDismissed?: unknown;
    projects?: unknown[];
  };
  const projects = Array.isArray(record.projects)
    ? record.projects.map(normalizeProject).filter((item): item is Project => item !== null)
    : [];
  const panel = (record as { panel?: unknown }).panel;
  const settings = normalizeSettings(record.settings);
  const normalizedSessions = Array.isArray(record.sessions)
    ? record.sessions.map(normalizeSession).filter((item): item is Session => item !== null)
    : [];
  const rawSessions = reconcilePersistedLineups(normalizedSessions);
  const restored = rehomeCustomUsage(normalizeUsage(record.usage), settings.customBots, rawSessions);
  const usage = [...backfillCursorUsage(rawSessions, restored), ...restored];
  const sessions = listedChats(
    applyUsageContext(rawSessions, usage).map((session) => {
      // Local intent titles only for defaults / old prompt slices. Do not rewrite
      // unlocked vendor, manual, or already-reduced titles on launch.
      const suggested = suggestedTitleForSession(session);
      const titled = suggested ? { ...session, title: suggested } : session;
      const lineup = reconcileLineupOnRestart(titled.lineup);
      return lineup ? { ...titled, lineup } : titled;
    }),
  );
  const activeSessionId =
    typeof record.activeSessionId === "string" && sessions.some((session) => session.id === record.activeSessionId)
      ? record.activeSessionId
      : null;
  const rawPending = Array.isArray(record.pending) ? record.pending : [];
  const keptPending = rawPending.filter(
    (item) => !(item && typeof item === "object" && (item as { kind?: unknown }).kind === "campaign"),
  );
  const gatedParents = new Set(
    rawPending
      .filter((item) => item && typeof item === "object" && (item as { kind?: unknown }).kind === "campaign")
      .map((item) => String((item as { sessionId?: unknown }).sessionId ?? ""))
      .filter(Boolean),
  );
  for (const parent of gatedParents) {
    if (keptPending.some((item) => item && typeof item === "object" && (item as { sessionId?: unknown }).sessionId === parent)) continue;
    const index = sessions.findIndex((session) => session.id === parent);
    if (index >= 0 && sessions[index]?.status === "needs-input") {
      sessions[index] = { ...sessions[index]!, status: "idle" };
    }
  }
  const leases = hydrateInterruptedPathLeases(record.leases, sessions);
  return {
    ...EMPTY,
    ...record,
    projects,
    sessions,
    activeSessionId,
    // A campaign row persisted from the gated era has no approver any more; it
    // would render as an ordinary ask and hold its parent at needs-input for a
    // click that must never be asked for. Drop it, and let the parent run.
    pending: keptPending,
    leases,
    dismissedAttention: Array.isArray(record.dismissedAttention)
      ? record.dismissedAttention.filter((item): item is string => typeof item === "string")
      : [],
    sheet: null,
    panel: panel === "usage" || panel === "settings" ? "settings" : null,
    settingsSection:
      panel === "usage"
        ? "usage"
        : isSettingsSection(record.settingsSection)
          ? record.settingsSection
          : "profile",
    settings,
    watchPermits: normalizeWatchPermits((record as { watchPermits?: unknown }).watchPermits),
    watchDayMarks: normalizeWatchDayMarks((record as { watchDayMarks?: unknown }).watchDayMarks),
    deskPlans: (record as { deskPlans?: AppState["deskPlans"] }).deskPlans,
    usage,
    usageRange:
      record.usageRange === "today" || record.usageRange === "week" || record.usageRange === "all"
        ? record.usageRange
        : "month",
    sidebarWidth: clampPaneWidth((record as { sidebarWidth?: unknown }).sidebarWidth, SIDEBAR_PANE),
    threadWidth: clampPaneWidth((record as { threadWidth?: unknown }).threadWidth, THREAD_PANE),
    lastModel: normalizeChoice(record.lastModel),
    externalTasks: reconcileTaskStoreOnRestart(normalizeTaskStore((record as { externalTasks?: unknown }).externalTasks)),
    theme: isTheme(record.theme) ? record.theme : "system",
    themeReturn: isConcreteTheme(record.themeReturn) ? record.themeReturn : undefined,
    dismissedUpdateVersion:
      typeof (record as { dismissedUpdateVersion?: unknown }).dismissedUpdateVersion === "string"
        ? (record as { dismissedUpdateVersion: string }).dismissedUpdateVersion
        : undefined,
  };
}

function normalizeChoice(raw: unknown): AppState["lastModel"] {
  if (!raw || typeof raw !== "object") return DEFAULT_CHOICE;
  const record = raw as Partial<AppState["lastModel"]>;
  const provider = isProviderId(record.provider) ? record.provider : DEFAULT_CHOICE.provider;
  const model = normalizeModelId(
    provider,
    typeof record.model === "string" && record.model ? record.model : defaultModel(provider).id,
  );
  return {
    provider,
    model,
    effort: withEffort(provider, model, record.effort ?? DEFAULT_CHOICE.effort),
    sandbox: parseSandbox(String((record as { sandbox?: string }).sandbox ?? "")) ?? DEFAULT_CHOICE.sandbox ?? "off",
    mode: parsePermissionMode(String((record as { mode?: string }).mode ?? "")) ?? DEFAULT_CHOICE.mode ?? "ask",
    customBotId:
      typeof (record as { customBotId?: string }).customBotId === "string"
        ? (record as { customBotId?: string }).customBotId
        : undefined,
  };
}

function presetFrom(
  session: Pick<Session, "provider" | "model" | "effort" | "sandbox" | "mode" | "customBotId">,
  patch: Partial<AppState["lastModel"]> = {},
): AppState["lastModel"] {
  return {
    provider: patch.provider ?? session.provider,
    model: patch.model ?? session.model,
    effort: patch.effort !== undefined ? patch.effort : session.effort,
    sandbox: patch.sandbox ?? session.sandbox,
    mode: patch.mode ?? session.mode,
    customBotId:
      (patch.provider ?? session.provider) === "custom" ? patch.customBotId ?? session.customBotId : undefined,
  };
}

function cancelVendorSession(session: Pick<Session, "id" | "provider">) {
  if (session.provider === "codex") void window.workhorse?.codexCancel?.(session.id);
  else if (session.provider === "claude") void window.workhorse?.claudeCancel?.(session.id);
  else if (session.provider === "cursor") void window.workhorse?.cursorCancel?.(session.id);
  else if (session.provider === "custom") void window.workhorse?.customCancel?.(session.id);
  else void window.workhorse?.grokCancel?.(session.id);
}

function stopDeletedWorkerSessions(before: Session[], after: Session[]) {
  const kept = new Set(after.map((session) => session.id));
  for (const session of before) {
    if (kept.has(session.id) || !session.parentId) continue;
    if (
      session.agentRun?.status === "running" ||
      session.agentRun?.status === "interrupted" ||
      session.status === "running" ||
      session.status === "needs-input"
    ) {
      cancelVendorSession(session);
    }
  }
}

function occupancyForSession(
  session: { provider: ProviderId; model: string; messages?: Parameters<typeof estimateMessageTokens>[0] } | undefined,
  draft: UsageDraft,
  seen?: number,
): number | undefined {
  if (typeof seen === "number" && seen > 0) return seen;
  const window = session ? contextWindowFor(session.provider, session.model) : 0;
  if (draft.source === "estimate") {
    const occupying = session?.messages ? estimateMessageTokens(session.messages).tokens : 0;
    return occupancyFromUsage(
      { contextUsed: typeof draft.contextUsed === "number" && draft.contextUsed > 0 ? draft.contextUsed : undefined },
      window,
      occupying,
    );
  }
  return occupancyFromUsage(draft, window);
}

function settlePlanAssignment(
  sessions: Session[],
  parentId: string,
  childId: string,
  outcome: "completed" | "failed",
  report: string,
): Session[] {
  const child = sessions.find((item) => item.id === childId);
  if (child?.agentRun?.role === "auditor") {
    return applyPlanAuditorSpawn(sessions, parentId, [], { childId: uid("sess") }).sessions;
  }
  const stepId = child?.agentRun?.planStepId;
  if (!stepId) return sessions;
  return sessions.map((session) => {
    if (session.id !== parentId || !session.planRun || session.planRun.status !== "running") return session;
    let plan = session.planRun;
    const now = Date.now();
    if (outcome === "completed") {
      const evidence = recordPlanEvidence(plan, stepId, {
        id: uid("evidence"),
        kind: "runtime",
        label: child?.title || "Agent report",
        value: report.trim().slice(0, 4_000) || "Completed",
        recordedAt: now,
        sessionId: childId,
      }, now);
      if (evidence.ok) plan = evidence.plan;
    }
    if (outcome === "failed") {
      const settled = setPlanStepStatus(plan, stepId, "failed", {
        error: report.trim().slice(0, 1_000) || "Agent failed",
        now,
      });
      if (!settled.ok) return session;
      const logged = recordPlanEvent(settled.plan, {
        type: "agent.failed",
        stepId,
        sessionId: childId,
        correlationId: child?.agentRun?.correlationId,
      }, now);
      return { ...session, planRun: logged.ok ? logged.plan : settled.plan };
    }
    const logged = recordPlanEvent(plan, {
      type: "agent.completed",
      stepId,
      sessionId: childId,
      correlationId: child?.agentRun?.correlationId,
    }, now);
    return { ...session, planRun: logged.ok ? logged.plan : plan };
  });
}

function joinAdmit(
  sessions: Session[],
  parentId: string,
  state: Pick<AppState, "settings" | "usage" | "watchPermits" | "watchDayMarks">,
  plans: import("./watch").WatchPlans,
) {
  return joinAndAdmit(sessions, parentId, deskCallCatalog({
    settings: state.settings,
    usage: state.usage,
    plans,
    permits: state.watchPermits,
    dayMarks: state.watchDayMarks,
  }), { childId: uid("sess") });
}

function snapshotWriteInstance(
  state: AppState,
  sessionId: string,
  title: string,
  detail: string,
  toolCallId = "",
): void {
  if (!window.workhorse?.recordFileWrite || !isWriteToolTitle(title)) return;
  const filePath = writePathFromToolEvent(title, detail, toolCallId);
  if (!filePath) return;
  const session = state.sessions.find((item) => item.id === sessionId);
  const project =
    state.projects.find((item) => item.id === session?.projectId) ??
    state.projects.find((item) => item.id === state.activeProjectId);
  const roots = projectFolderPaths(project);
  void window.workhorse.recordFileWrite(filePath, roots);
}

/** Stable identity for "nothing is missing", so a redraw needs a real change. */
const NO_MISSING_FOLDERS: ReadonlySet<string> = new Set<string>();

/**
 * Folders the operating system empties on its own. `/private/tmp` is swept on a
 * schedule and `/var/folders` is per-boot scratch, so a project linked to either
 * is a project whose files are on a timer nobody set. `/tmp` is the same place
 * as `/private/tmp` under a symlink and has to be named separately, because the
 * picker hands back whichever one the person walked through.
 */
const VOLATILE_FOLDER_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

export function volatileFolderPath(folder: string): boolean {
  const normalized = folder.trim().replace(/\/+$/, "");
  if (!normalized) return false;
  return VOLATILE_FOLDER_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY);
  const [ready, setReady] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateOffer | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const [catalogRev, setCatalogRev] = useState(0);
  const [deskSkills, setDeskSkills] = useState<DeskSkill[]>([]);
  const [grokPlan, setGrokPlan] = useState<GrokPlanUsage | undefined>();
  const [codexPlan, setCodexPlan] = useState<GrokPlanUsage | undefined>();
  const [claudePlan, setClaudePlan] = useState<GrokPlanUsage | undefined>();
  const [cursorPlan, setCursorPlan] = useState<GrokPlanUsage | undefined>();
  const [customPlans, setCustomPlans] = useState<Record<string, GrokPlanUsage | undefined>>({});
  const [customPlanKnown, setCustomPlanKnown] = useState<Record<string, boolean>>({});
  const [vendorPlanKnown, setVendorPlanKnown] = useState<Record<string, boolean>>({});
  const [editMessageId, setEditMessageId] = useState<string | null>(null);
  const [watchHold, setWatchHold] = useState<WatchHold | null>(null);
  const [watchRestore, setWatchRestore] = useState<{ text: string; images?: import("./types").ChatImage[] } | null>(null);
  const persistTimer = useRef<number | null>(null);
  /** A worker finished and its write has not gone out yet. */
  const settledPending = useRef(false);
  const lateAckPending = useRef<Map<string, string>>(new Map());
  const persistBody = useRef<AppState | null>(null);
  const draftPersistTimer = useRef<number | null>(null);
  const composerDraftsRef = useRef<Record<string, ComposerDraftSnap>>({});
  const plansRef = useRef<import("./watch").WatchPlans>({});
  const pathLeasesRef = useRef<FileLease[]>([]);
  const pathPermissionPreflight = useRef(new Set<string>());
  const approvedPathWrites = useRef(new Map<string, Array<{ path: string; root: string }>>());
  const pathFingerprintRefreshes = useRef(new Map<string, Promise<void>>());
  const forkFromRef = useRef<(messageId: string, sessionId?: string) => void>(() => undefined);
  const stateRef = useRef<AppState>(EMPTY);
  const workerNameReservations = useRef<WorkerNameReservation[]>([]);
  const deskSkillsRef = useRef<DeskSkill[]>([]);
  const grokAssistantId = useRef<Record<string, string>>({});
  const grokChunkQueue = useRef<Record<string, string>>({});
  const grokThoughtQueue = useRef<Record<string, string>>({});
  const grokUsagePending = useRef<Record<string, UsageDraft[]>>({});
  const grokContextSeen = useRef<Record<string, number>>({});
  const learningTurns = useRef<Record<string, LearningTurnLink>>({});
  const agentCatalogRef = useRef<import("./external-catalog").ExternalAgent[]>([]);
  const agentRuntimesRef = useRef<import("./external-catalog").AgentRuntimeStatus[]>([]);
  /**
   * Linked folders that are no longer on disk. The renderer decides which folder
   * a chat runs in but cannot stat, so a project that kept a link to a moved
   * repo went on choosing it and every agent died on a cwd that was not there.
   * Refreshed from the main process; empty until the first answer, which only
   * costs the old behaviour for a moment.
   */
  const missingFolders = useRef<ReadonlySet<string>>(NO_MISSING_FOLDERS);
  /*
   * The answer also has to be drawable. It stays in a ref because every caller
   * of folderExists needs the current one — a stale closure there sends an agent
   * to a folder that is gone — and it is mirrored into state because a ref
   * mutated inside a promise tells React nothing: Project Home went on drawing a
   * deleted folder as a live one until something unrelated forced a redraw.
   */
  const [missingFolderPaths, setMissingFolderPaths] = useState<ReadonlySet<string>>(NO_MISSING_FOLDERS);
  const folderExists = useCallback((path: string) => !missingFolders.current.has(path), []);
  const applyMissingFolders = useCallback((next: ReadonlySet<string>) => {
    const current = missingFolders.current;
    if (current.size === next.size && [...next].every((path) => current.has(path))) return;
    missingFolders.current = next;
    setMissingFolderPaths(next);
  }, []);

  const goalHaltedSessions = useRef(new Set<string>());
  const goalForwardAfterHalt = useRef<Record<string, { text: string; images: import("./types").ChatImage[]; hideUser: boolean }>>({});
  const claudePlanRetry = useRef<number | null>(null);
  const selectorStore = useRef<Store | null>(null);
  const selectorListeners = useRef(new Set<() => void>());
  const selectorRuntime = useMemo(
    () => ({
      getSnapshot: () => {
        if (!selectorStore.current) throw new Error("Workhorse store is not ready");
        return selectorStore.current;
      },
      subscribe: (listener: () => void) => {
        selectorListeners.current.add(listener);
        return () => selectorListeners.current.delete(listener);
      },
    }),
    [],
  );
  stateRef.current = state;
  pathLeasesRef.current = state.leases ?? [];
  plansRef.current = { grok: grokPlan, codex: codexPlan, claude: claudePlan, cursor: cursorPlan, custom: customPlans };
  useEffect(() => {
    setState((current) => ({ ...current, deskPlans: plansRef.current }));
  }, [grokPlan, codexPlan, claudePlan, cursorPlan, customPlans]);

  // A built-in meter that has answered once is known, whatever it answered. A
  // 404, an auth failure, or a dead socket must read unknown, not "Loading…"
  // forever. Declared beside the plan state so every later fetch can reach it.
  const markVendorPlanKnown = useCallback((provider: ProviderId) => {
    setVendorPlanKnown((current) => (current[provider] ? current : { ...current, [provider]: true }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const saved = window.workhorse ? await window.workhorse.loadState() : null;
      if (!cancelled) {
        const next = hydrate(saved);
        setState(next);
        setReady(true);
        void (async () => {
          const grok = window.workhorse?.detectGrokLogin
            ? await window.workhorse.detectGrokLogin()
            : { connected: false, accessDefaults: undefined };
          const codex = window.workhorse?.detectCodexLogin
            ? await window.workhorse.detectCodexLogin()
            : { connected: false, accessDefaults: undefined };
          const claude = window.workhorse?.detectClaudeLogin
            ? await window.workhorse.detectClaudeLogin()
            : { connected: false, accessDefaults: undefined };
          const cursor = window.workhorse?.detectCursorLogin
            ? await window.workhorse.detectCursorLogin()
            : { connected: false, binary: null, accessDefaults: undefined };
          const catalog = window.workhorse?.listVendorModels
            ? await window.workhorse.listVendorModels()
            : null;
          if (catalog) {
            applyVendorCatalog(catalog);
            setCatalogRev((value) => value + 1);
          }
          setState((current) => {
            const firstNativeCodexDefaults = !current.settings.llms.codex.accessDefaults && codex.accessDefaults;
            return {
              ...current,
              settings: {
                ...current.settings,
                llms: {
                  ...current.settings.llms,
                  // Each vendor's own recorded defaults, read off this machine.
                  // A detect that came back empty keeps what is already stored:
                  // a logged-out or mid-upgrade CLI is not the person tightening
                  // the desk, and writing its silence here used to do exactly
                  // that to every chat opened afterwards.
                  //
                  // vendorLaunchGate carries the other half of each detect: a
                  // vendor whose CLI is missing from the desk's PATH is
                  // connected and cannot start, and routing refuses it only if
                  // that reaches the link from here.
                  grok: {
                    ...current.settings.llms.grok,
                    available: Boolean(grok.connected),
                    accessDefaults: keepVendorAccessDefaults(
                      current.settings.llms.grok.accessDefaults,
                      grok.accessDefaults,
                    ),
                    ...vendorLaunchGate(grok),
                  },
                  codex: {
                    ...current.settings.llms.codex,
                    available: Boolean(codex.connected),
                    accessDefaults: keepVendorAccessDefaults(
                      current.settings.llms.codex.accessDefaults,
                      codex.accessDefaults,
                    ),
                    ...vendorLaunchGate(codex),
                  },
                  claude: {
                    ...current.settings.llms.claude,
                    available: Boolean(claude.connected),
                    needsAuth: Boolean((claude as { needsAuth?: boolean }).needsAuth),
                    accessDefaults: keepVendorAccessDefaults(
                      current.settings.llms.claude.accessDefaults,
                      claude.accessDefaults,
                    ),
                    ...vendorLaunchGate(claude),
                  },
                  cursor: {
                    ...current.settings.llms.cursor,
                    available: Boolean(cursor.binary || cursor.connected),
                    needsAuth: Boolean((cursor as { needsAuth?: boolean }).needsAuth) && !cursor.connected,
                    accessDefaults: keepVendorAccessDefaults(
                      current.settings.llms.cursor.accessDefaults,
                      cursor.accessDefaults,
                    ),
                    ...vendorLaunchGate(cursor),
                  },
                  custom: { ...current.settings.llms.custom, connected: false },
                },
              },
              lastModel:
                firstNativeCodexDefaults && current.lastModel.provider === "codex"
                  ? { ...current.lastModel, ...firstNativeCodexDefaults }
                  : current.lastModel,
            };
          });
        })();
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !window.workhorse) return;
    const previous = persistBody.current;
    persistBody.current = state;
    // A chat click only changes the selection. Cloning the whole desk here
    // freezes the renderer so other chats cannot be selected.
    if (previous && deskPersistBodyEqual(previous, state)) return;
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    const busy = state.sessions.some((session) => session.status === "running" || session.status === "needs-input");
    // A worker reaching a terminal state is the one write an outside caller is
    // waiting on. The Link helper learns a slice finished by reading this file,
    // so holding a settled worker behind the 2s busy debounce — which applies
    // exactly when other workers are still running — leaves a harness blind for
    // the whole window. Everything else can wait its turn.
    // Latched, not recomputed. Every state change clears the pending timer and
    // re-enters here; if a worker settled and then anything else moved before
    // that 0ms write ran — another worker streaming, which is the normal case
    // mid-wave — the recomputed `settled` would be false against the newer
    // previous and the finish would fall back to the 2s debounce. The latch
    // holds until a write actually happens.
    if (workerJustSettled(previous?.sessions, state.sessions)) settledPending.current = true;
    persistTimer.current = window.setTimeout(() => {
      settledPending.current = false;
      const saved = listedChats(applyComposerDrafts(state.sessions, composerDraftsRef.current));
      void window.workhorse
        ?.saveState({
          ...state,
          sessions: saved,
          activeSessionId:
            state.activeSessionId && saved.some((session) => session.id === state.activeSessionId)
              ? state.activeSessionId
              : null,
        })
        .then(() => {
          if (!lateAckPending.current.size) return;
          // Spent when this save carried the message — or when the chat that
          // asked is gone from the state this save was made from, so nothing
          // can ever carry it. A chat cannot reappear; an append cannot be
          // mistaken for one, because the asking chat existed to ask.
          for (const [reqId, sessionId] of [...lateAckPending.current]) {
            const landed = saved.some((session) => session.messages.some((message) => message.id === `msg_late_${reqId}`));
            const chatGone = !state.sessions.some((session) => session.id === sessionId);
            if (landed || chatGone) {
              lateAckPending.current.delete(reqId);
              void window.workhorse?.ackGrokBotLateAnswer?.(reqId);
            }
          }
        })
        .catch(() => undefined);
    }, settledPending.current ? 0 : busy ? 2_000 : 400);
  }, [ready, state]);

  const createProject = useCallback((name: string, folderPaths: string[] = []) => {
    const project = emptyProject(name, folderPaths);
    setState((current) => ({
      ...current,
      projects: [project, ...current.projects],
      sessions: dropDrafts(current.sessions),
      activeProjectId: project.id,
      activeSessionId: null,
      panel: null,
    }));
    return project.id;
  }, []);

  const openSheet = useCallback((sheet: Sheet) => {
    setState((current) => ({ ...current, sheet }));
  }, []);

  const closeSheet = useCallback(() => {
    setState((current) => ({ ...current, sheet: null }));
  }, []);

  const selectProject = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      panel: null,
      activeProjectId: id,
      activeSessionId: null,
      sessions: dropDrafts(current.sessions),
      projects: current.projects.map((project) =>
        project.id === id ? { ...project, openedAt: Date.now() } : project,
      ),
    }));
  }, []);

  const linkFolder = useCallback(async (path?: string) => {
    const picked = path
      ? { path }
      : window.workhorse
        ? await window.workhorse.pickFolder()
        : null;
    const folderPath = picked?.path;
    if (!folderPath) return;
    /*
     * Not a refusal. A project is a name and its folders are optional links, and
     * someone pointing a throwaway project at a scratch folder means it. But the
     * folder is emptied by the operating system, not by them, and a person who
     * links one without knowing that loses the work rather than the link. So:
     * said out loud once, at the moment of choosing, and marked on Project Home
     * for as long as the link is there.
     */
    if (volatileFolderPath(folderPath)) {
      void window.workhorse?.notifyDesktop?.({
        title: "That folder is temporary",
        body: `${folderPath} is cleared by the system, so work saved there can be gone after a restart. Link a folder you keep if the work matters.`,
      });
    }
    setState((current) => {
      const projectId = current.activeProjectId;
      if (!projectId) return current;
      return {
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          if (project.folders.some((folder) => folder.path === folderPath)) return project;
          return { ...project, folders: [...project.folders, folderFromPath(folderPath, picked.bookmark)] };
        }),
      };
    });
  }, []);

  const unlinkFolder = useCallback((folderId: string) => {
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId
          ? { ...project, folders: project.folders.filter((folder) => folder.id !== folderId) }
          : project,
      ),
    }));
  }, []);

  const addReference = useCallback((kind: ReferenceKind, value: string, label?: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const reference: LinkedReference = {
      id: uid("ref"),
      kind,
      value: trimmed,
      label: (label ?? trimmed).trim(),
    };
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId
          ? { ...project, references: [...project.references, reference] }
          : project,
      ),
    }));
  }, []);

  const removeReference = useCallback((referenceId: string) => {
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === current.activeProjectId
          ? { ...project, references: project.references.filter((item) => item.id !== referenceId) }
          : project,
      ),
    }));
  }, []);

  const archiveProject = useCallback((id: string, archived = true) => {
    setState((current) => {
      const projects = applyArchiveProject(current.projects, id, archived);
      if (!projects) return current;
      return { ...current, projects };
    });
  }, []);

  const deleteProject = useCallback((id: string, chats: "keep" | "remove") => {
    setState((current) => {
      const projects = applyDeleteProject(current.projects, id);
      if (!projects) return current;
      const sessions = applyProjectChatFate(current.sessions, id, chats);
      const gone = new Set(
        current.sessions.filter((session) => !sessions.some((item) => item.id === session.id)).map((session) => session.id),
      );
      stopDeletedWorkerSessions(current.sessions, sessions);
      const leases = releaseDeletedSessionLeases(current.leases ?? [], current.sessions, sessions);
      pathLeasesRef.current = leases;
      return {
        ...current,
        projects,
        sessions,
        leases,
        pending: current.pending.filter((item) => !gone.has(item.sessionId)),
        activeProjectId: current.activeProjectId === id ? null : current.activeProjectId,
        activeSessionId: current.activeSessionId && gone.has(current.activeSessionId) ? null : current.activeSessionId,
      };
    });
  }, []);

  const startSession = useCallback((projectId?: string | null, provider?: ProviderId) => {
    setState((current) => {
      const targetId = projectId === undefined ? null : projectId;
      const project = targetId ? current.projects.find((item) => item.id === targetId) ?? null : null;
      if (targetId && !project) return current;
      const remembered = firstAttachedChoice(current.settings, current.lastModel);
      if (!remembered && !provider) {
        return { ...current, panel: "settings", settingsSection: "llms" };
      }
      const picked = provider ?? remembered!.provider;
      const model = provider ? defaultModel(provider).id : remembered!.model;
      const customBotId = picked === "custom" ? remembered?.customBotId : undefined;
      const rememberedAccess = remembered?.provider === picked ? remembered : undefined;
      const nativeAccess = picked === "custom" ? undefined : current.settings.llms[picked].accessDefaults;
      // A new chat seeds from the last chat's access when the vendor matches,
      // and otherwise from the desk default narrowed by that vendor's own
      // config. Switching vendor is not a restriction, so it no longer lands
      // on Ask just because the new vendor has nothing recorded.
      const seat = inboundAccess({
        parent: rememberedAccess ? { mode: rememberedAccess.mode, sandbox: rememberedAccess.sandbox } : undefined,
        desk: current.settings.access,
        vendor: nativeAccess,
      });
      const choice = {
        provider: picked,
        model,
        effort: withEffort(picked, model, remembered?.effort ?? null),
        sandbox: seat.sandbox,
        mode: seat.mode,
        customBotId,
      };
      const opened = openDraft(current.sessions, {
        id: uid("sess"),
        projectId: project?.id ?? null,
        provider: choice.provider,
        model: choice.model,
        customBotId,
        effort: withEffort(choice.provider, choice.model, choice.effort),
        title: "New chat",
        mode: choice.mode,
        sandbox: choice.sandbox,
        environment: { kind: "local" },
        securityPolicy: { network: "allowed", root: "allowed" },
        status: "idle",
        contextUsed: 0,
        messages: [],
        // A new chat keeps the model the person picked. Auto is a pick they
        // make on the chat afterwards; no setting puts a chat on Auto for them.
        routingMode: "manual",
      });
      return {
        ...current,
        lastModel: choice,
        sessions: opened.sessions,
        activeProjectId: project?.id ?? null,
        activeSessionId: opened.session.id,
        panel: null,
      };
    });
  }, []);

  const setSessionModel = useCallback((provider: ProviderId, model: string, customBotId?: string) => {
    const current = stateRef.current;
    const session = current.sessions.find((item) => item.id === current.activeSessionId);
    if (!session) return;
    const botId = provider === "custom" ? customBotId : undefined;
    if (provider === "custom" && botId) {
      const bot = current.settings.customBots.find((item) => item.id === botId);
      if (!bot || !customBotServes(bot, model)) return;
    }
    if (session.provider !== provider || session.customBotId !== botId) {
      if (session.provider === "codex") void window.workhorse?.codexCancel?.(session.id);
      else if (session.provider === "claude") void window.workhorse?.claudeCancel?.(session.id);
      else if (session.provider === "custom") void window.workhorse?.customCancel?.(session.id);
      else void window.workhorse?.grokCancel?.(session.id);
    }
    setState((latest) => {
      const live = latest.sessions.find((item) => item.id === latest.activeSessionId);
      if (!live) return latest;
      const effort = withEffort(provider, model, live.effort);
      const next = applySessionModelChange(live, { provider, model, effort, customBotId: botId });
      return {
        ...latest,
        lastModel: presetFrom(next),
        sessions: latest.sessions.map((item) =>
          item.id === live.id ? { ...next, routingMode: "manual", routingDecision: undefined } : item,
        ),
      };
    });
  }, []);

  const setSessionRoutingMode = useCallback((mode: "auto" | "manual") => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === current.activeSessionId
          ? { ...item, routingMode: mode, ...(mode === "manual" ? { routingDecision: undefined } : {}) }
          : item,
      ),
    }));
  }, []);

  const setCrewMode = useCallback((modes: CrewMode[] | undefined) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === current.activeSessionId ? { ...item, crewModes: modes } : item,
      ),
    }));
  }, []);

  const setSessionEffort = useCallback((effort: EffortLevel) => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!session || !withEffort(session.provider, session.model, effort)) return current;
      return {
        ...current,
        lastModel: presetFrom(session, { effort }),
        sessions: current.sessions.map((item) =>
          item.id === session.id ? { ...item, effort } : item,
        ),
      };
    });
  }, []);

  const setSessionEnvironment = useCallback(async (kind: "local" | "worktree") => {
    const snapshot = stateRef.current;
    const session = snapshot.sessions.find((item) => item.id === snapshot.activeSessionId);
    if (!session) return { ok: false, message: "No chat is selected." };
    if (session.status === "running") {
      return { ok: false, message: "Wait for this turn to finish before changing its environment." };
    }
    if (kind === "local") {
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === session.id
            ? { ...item, environment: { kind: "local" } as SessionEnvironment, vendorSessionId: undefined, vendorProvider: undefined }
            : item,
        ),
      }));
      return { ok: true, message: "This chat now works in the linked project folder." };
    }

    const project = snapshot.projects.find((item) => item.id === session.projectId);
    const root = primaryFolder(project, folderExists)?.path ?? "";
    if (!root) return { ok: false, message: "Link a project folder before creating a worktree." };
    if (!window.workhorse?.ensureWorktree) {
      return { ok: false, message: "Restart Workhorse before creating a managed worktree." };
    }
    const result = await window.workhorse.ensureWorktree({ sessionId: session.id, root });
    if (!result.ok) return result;
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === session.id
          ? {
              ...item,
              environment: { kind: "worktree", path: result.path, gitRoot: result.gitRoot, head: result.head },
              vendorSessionId: undefined,
              vendorProvider: undefined,
            }
          : item,
      ),
    }));
    return {
      ok: true,
      message: result.reused ? "Reopened this chat's managed worktree." : "Created an isolated worktree for this chat.",
    };
  }, []);

  const selectSession = useCallback((id: string) => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === id);
      return {
        ...current,
        panel: null,
        activeSessionId: id,
        activeProjectId: session?.projectId ?? null,
        sessions: dropDrafts(current.sessions, id),
      };
    });
  }, []);

  const setComposerDraft = useCallback((id: string, text: string, images?: import("./types").ChatImage[], commit = false) => {
    const snap = snapComposerDraft(text, images);
    if (sameComposerDraft(composerDraftsRef.current[id], snap)) {
      if (!commit) return;
    } else {
      composerDraftsRef.current[id] = snap;
      if (draftPersistTimer.current) window.clearTimeout(draftPersistTimer.current);
      draftPersistTimer.current = window.setTimeout(() => {
        void window.workhorse?.saveComposerDrafts?.(composerDraftsRef.current);
      }, 800);
    }
    if (!commit) return;
    setState((current) => {
      const session = current.sessions.find((item) => item.id === id);
      if (!session) return current;
      if (sameComposerDraft({ text: session.composerDraft, images: session.composerImages }, snap)) return current;
      return {
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === id ? { ...item, composerDraft: snap.text, composerImages: snap.images } : item,
        ),
      };
    });
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    setState((current) => {
      const sessions = renameChat(current.sessions, id, title);
      return sessions ? { ...current, sessions } : current;
    });
  }, []);

  const deleteSession = useCallback((id: string) => {
    setState((current) => {
      const sessions = deleteChat(current.sessions, id);
      if (!sessions) return current;
      stopDeletedWorkerSessions(current.sessions, sessions);
      const leases = releaseDeletedSessionLeases(current.leases ?? [], current.sessions, sessions);
      pathLeasesRef.current = leases;
      return {
        ...current,
        sessions,
        leases,
        pending: current.pending.filter((item) => item.sessionId !== id),
        activeSessionId: current.activeSessionId === id ? null : current.activeSessionId,
      };
    });
  }, []);

  const deleteWorkers = useCallback((parentId: string) => {
    setState((current) => {
      const kids = current.sessions.filter((session) => session.parentId === parentId);
      const sessions = deleteWorkerChats(current.sessions, parentId);
      if (!sessions) return current;
      stopDeletedWorkerSessions(current.sessions, sessions);
      const gone = new Set(kids.map((kid) => kid.id));
      const leases = releaseDeletedSessionLeases(current.leases ?? [], current.sessions, sessions);
      pathLeasesRef.current = leases;
      return {
        ...current,
        sessions,
        leases,
        pending: current.pending.filter((item) => !gone.has(item.sessionId)),
        activeSessionId: gone.has(current.activeSessionId ?? "") ? parentId : current.activeSessionId,
      };
    });
  }, []);

  const archiveSession = useCallback((id: string, archived = true) => {
    setState((current) => {
      const sessions = archiveChat(current.sessions, id, archived);
      if (!sessions) return current;
      return {
        ...current,
        sessions,
        activeSessionId: archived && current.activeSessionId === id ? null : current.activeSessionId,
      };
    });
  }, []);

  const moveSession = useCallback((id: string, projectId: string) => {
    setState((current) => {
      if (!current.projects.some((project) => project.id === projectId)) return current;
      const sessions = moveChat(current.sessions, id, projectId);
      if (!sessions) return current;
      return {
        ...current,
        sessions,
        activeProjectId: projectId,
        activeSessionId: id,
        panel: null,
      };
    });
  }, []);

  const setMode = useCallback((mode: PermissionMode) => {
    const session = stateRef.current.sessions.find((item) => item.id === stateRef.current.activeSessionId);
    if (session && session.mode !== mode) {
      if (session.provider === "codex") void window.workhorse?.codexCancel?.(session.id);
      else if (session.provider === "claude") void window.workhorse?.claudeCancel?.(session.id);
      else if (session.provider === "custom") void window.workhorse?.customCancel?.(session.id);
      else void window.workhorse?.grokCancel?.(session.id);
    }
    setState((current) => {
      const live = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!live) return { ...current, lastModel: { ...current.lastModel, mode } };
      const next = applySessionPolicyChange(live, { mode });
      return {
        ...current,
        lastModel: presetFrom(next),
        sessions: current.sessions.map((item) => (item.id === live.id ? next : item)),
      };
    });
  }, []);

  // The desk default only ever moves because the person moved it here. No
  // detect, disconnect, or vendor switch writes this.
  const setDeskAccess = useCallback((patch: Partial<DeskAccess>) => {
    setState((current) => ({
      ...current,
      settings: { ...current.settings, access: { ...current.settings.access, ...patch } },
    }));
  }, []);

  const setSandbox = useCallback((sandbox: SandboxProfile) => {
    const session = stateRef.current.sessions.find((item) => item.id === stateRef.current.activeSessionId);
    if (session && session.sandbox !== sandbox) {
      if (session.provider === "codex") void window.workhorse?.codexCancel?.(session.id);
      else if (session.provider === "claude") void window.workhorse?.claudeCancel?.(session.id);
      else if (session.provider === "custom") void window.workhorse?.customCancel?.(session.id);
      else void window.workhorse?.grokCancel?.(session.id);
    }
    setState((current) => {
      const live = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!live) return { ...current, lastModel: { ...current.lastModel, sandbox } };
      const next = applySessionPolicyChange(live, { sandbox });
      return {
        ...current,
        lastModel: presetFrom(next),
        sessions: current.sessions.map((item) => (item.id === live.id ? next : item)),
      };
    });
  }, []);

  const setSecurityPolicy = useCallback((patch: Partial<SessionSecurityPolicy>) => {
    const session = stateRef.current.sessions.find((item) => item.id === stateRef.current.activeSessionId);
    if (!session) return;
    const current = session.securityPolicy ?? { network: "allowed", root: "allowed" };
    const securityPolicy: SessionSecurityPolicy = { ...current, ...patch };
    if (securityPolicy.network === current.network && securityPolicy.root === current.root) return;
    if (session.provider === "codex") void window.workhorse?.codexCancel?.(session.id);
    else if (session.provider === "claude") void window.workhorse?.claudeCancel?.(session.id);
    else if (session.provider === "custom") void window.workhorse?.customCancel?.(session.id);
    else void window.workhorse?.grokCancel?.(session.id);
    setState((state) => ({
      ...state,
      sessions: state.sessions.map((item) =>
        item.id === session.id ? applySessionPolicyChange(item, { securityPolicy }) : item,
      ),
    }));
  }, []);

  const setMcpServers = useCallback(async (servers: McpServerConfig[]) => {
    const current = stateRef.current;
    const next = {
      ...current,
      settings: { ...current.settings, mcpServers: servers },
    };
    stateRef.current = next;
    setState(next);
    if (persistTimer.current) {
      window.clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    if (!window.workhorse?.saveState) return;
    const saved = listedChats(applyComposerDrafts(next.sessions, composerDraftsRef.current));
    await window.workhorse.saveState({
      ...next,
      sessions: saved,
      activeSessionId:
        next.activeSessionId && saved.some((session) => session.id === next.activeSessionId)
          ? next.activeSessionId
          : null,
    });
  }, []);

  const probeMcpServer = useCallback(async (serverName: string) => {
    if (!window.workhorse?.probeMcpServer) {
      return { ok: false, message: "MCP testing runs in the Workhorse desktop window.", tools: [] };
    }
    return window.workhorse.probeMcpServer(serverName);
  }, []);

  const refreshVendorModels = useCallback(() => {
    void (async () => {
      const catalog = window.workhorse?.listVendorModels
        ? await window.workhorse.listVendorModels()
        : null;
      if (!catalog) return;
      applyVendorCatalog(catalog);
      setCatalogRev((value) => value + 1);
    })();
  }, []);

  const refreshGrokLogin = useCallback(() => {
    void (async () => {
      const detected = window.workhorse?.detectGrokLogin
        ? await window.workhorse.detectGrokLogin()
        : { connected: false, accessDefaults: undefined };
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            grok: {
              ...current.settings.llms.grok,
              available: Boolean(detected.connected),
              accessDefaults: keepVendorAccessDefaults(
                current.settings.llms.grok.accessDefaults,
                detected.accessDefaults,
              ),
              // Recheck is the button the blocker tells the person to press, so
              // it has to be able to clear the blocker.
              ...vendorLaunchGate(detected),
            },
          },
        },
      }));
      refreshVendorModels();
    })();
  }, [refreshVendorModels]);

  const refreshCodexLogin = useCallback(() => {
    void (async () => {
      const detected = window.workhorse?.detectCodexLogin
        ? await window.workhorse.detectCodexLogin()
        : { connected: false, accessDefaults: undefined };
      setState((current) => {
        const firstNativeCodexDefaults = !current.settings.llms.codex.accessDefaults && detected.accessDefaults;
        return {
          ...current,
          settings: {
            ...current.settings,
            llms: {
              ...current.settings.llms,
              codex: {
                ...current.settings.llms.codex,
                available: Boolean(detected.connected),
                accessDefaults: keepVendorAccessDefaults(
                  current.settings.llms.codex.accessDefaults,
                  detected.accessDefaults,
                ),
                ...vendorLaunchGate(detected),
              },
            },
          },
          lastModel:
            firstNativeCodexDefaults && current.lastModel.provider === "codex"
              ? { ...current.lastModel, ...firstNativeCodexDefaults }
              : current.lastModel,
        };
      });
      refreshVendorModels();
    })();
  }, [refreshVendorModels]);

  const refreshCursorLogin = useCallback(() => {
    void (async () => {
      const detected = window.workhorse?.detectCursorLogin
        ? await window.workhorse.detectCursorLogin()
        : { connected: false, binary: null, accessDefaults: undefined };
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            cursor: {
              ...current.settings.llms.cursor,
              available: Boolean(detected.binary || detected.connected),
              needsAuth: Boolean((detected as { needsAuth?: boolean }).needsAuth) && !detected.connected,
              accessDefaults: keepVendorAccessDefaults(
                current.settings.llms.cursor.accessDefaults,
                detected.accessDefaults,
              ),
              ...vendorLaunchGate(detected),
            },
          },
        },
      }));
      refreshVendorModels();
    })();
  }, [refreshVendorModels]);

  const refreshClaudeLogin = useCallback(() => {
    void (async () => {
      const detected = window.workhorse?.detectClaudeLogin
        ? await window.workhorse.detectClaudeLogin()
        : { connected: false, accessDefaults: undefined };
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            claude: {
              ...current.settings.llms.claude,
              available: Boolean(detected.connected),
              needsAuth: Boolean((detected as { needsAuth?: boolean }).needsAuth),
              accessDefaults: keepVendorAccessDefaults(
                current.settings.llms.claude.accessDefaults,
                detected.accessDefaults,
              ),
              ...vendorLaunchGate(detected),
            },
          },
        },
      }));
      refreshVendorModels();
    })();
  }, [refreshVendorModels]);

  const cycleTheme = useCallback(() => {
    setState((current) => ({ ...current, theme: nextTheme(current.theme) }));
  }, []);

  const toggleWorkhorseTheme = useCallback(() => {
    setState((current) => ({ ...current, ...applyWorkhorseToggle(current.theme, current.themeReturn) }));
  }, []);

  const elevatePeerReply = useRef<Map<string, (result: { text?: string; error?: string }) => void>>(new Map());

  const answerPermission = useCallback((id: string, answer: "once" | "session" | "deny") => {
    const pending = stateRef.current.pending.find((item) => item.id === id);
    const session = stateRef.current.sessions.find((item) => item.id === pending?.sessionId);
    const vendorAsk = pending?.kind === "vendor" ? pending.vendor : undefined;
    const vendorAnswer = pending?.kind === "elevate" && answer !== "deny" ? "once" : answer;
    if (session?.provider === "codex") void window.workhorse?.codexAnswerPermission?.(id, vendorAnswer);
    else if (session?.provider === "claude") void window.workhorse?.claudeAnswerPermission?.(id, vendorAnswer);
    else if (session?.provider === "cursor") void window.workhorse?.cursorAnswerPermission?.(id, vendorAnswer);
    else if (session?.provider === "custom") void window.workhorse?.customAnswerPermission?.(id, vendorAnswer);
    else if (!vendorAsk) void window.workhorse?.grokAnswerPermission?.(id, vendorAnswer);
    const peer = elevatePeerReply.current.get(id);
    elevatePeerReply.current.delete(id);
    const allowVendor = Boolean(vendorAsk && answer !== "deny" && session);
    const vendorKey = vendorAsk ? (vendorAsk.provider === "custom" ? `bot:${session?.customBotId ?? ""}` : vendorAsk.provider) : "";
    if (allowVendor && vendorAsk?.status !== "disabled" && vendorKey && session) {
      const today = dayKey();
      const nextPermits = {
        ...stateRef.current.watchPermits,
        [vendorKey]: {
          ...stateRef.current.watchPermits[vendorKey],
          sessions: { ...stateRef.current.watchPermits[vendorKey]?.sessions, [session.id]: today },
        },
      };
      stateRef.current = { ...stateRef.current, watchPermits: nextPermits };
    }
    if (allowVendor && vendorAsk?.status === "disabled" && vendorAsk.provider !== "custom") {
      const id = vendorAsk.provider;
      const nextSettings = {
        ...stateRef.current.settings,
        llms: {
          ...stateRef.current.settings.llms,
          [id]: { ...stateRef.current.settings.llms[id], enabled: true },
        },
      };
      stateRef.current = { ...stateRef.current, settings: nextSettings };
    }
    setState((current) => {
      const next = applyPermissionAnswer(current, id, answer);
      if (!next) return current;
      const live = next.sessions.find((item) => item.id === pending?.sessionId);
      let watchPermits = current.watchPermits;
      let settings = current.settings;
      if (allowVendor && vendorAsk && live) {
        if (vendorAsk.status === "disabled" && vendorAsk.provider !== "custom") {
          settings = {
            ...settings,
            llms: {
              ...settings.llms,
              [vendorAsk.provider]: { ...settings.llms[vendorAsk.provider], enabled: true },
            },
          };
        } else if (vendorKey) {
          const today = dayKey();
          watchPermits = {
            ...watchPermits,
            [vendorKey]: {
              ...watchPermits[vendorKey],
              sessions: { ...watchPermits[vendorKey]?.sessions, [live.id]: today },
            },
          };
        }
      }
      if (peer) {
        if (answer === "deny") {
          void peer({
            text: vendorAsk
              ? vendorDeclinedForBot(vendorAsk.name)
              : "The user kept the current desk limits. Do not retry the blocked action.",
          });
        } else if (vendorAsk) {
          void peer({
            text: JSON.stringify({
              ok: true,
              allowed: true,
              retrySpawn: true,
              vendor: vendorAsk.name,
              howToUse: `${vendorAsk.name} is allowed for this chat. Continue — spawn or ask it now.`,
            }),
          });
        } else {
          void peer({
            text: JSON.stringify({
              ok: true,
              elevated: true,
              mode: live?.mode,
              sandbox: live?.sandbox,
              howToUse: live
                ? `Elevated ${describeElevation(session ?? live, pending?.elevate ?? {})}. Continue the work.`
                : "Elevated. Continue the work.",
            }),
          });
        }
      }
      return {
        ...current,
        ...next,
        watchPermits,
        settings,
        lastModel:
          pending?.kind === "elevate" && answer !== "deny" && live ? presetFrom(live) : current.lastModel,
      };
    });
  }, []);

  const demoPermission = useCallback(() => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === current.activeSessionId);
      if (!session) return current;
      const project = current.projects.find((item) => item.id === session.projectId);
      const request: PermissionRequest = {
        id: uid("perm"),
        sessionId: session.id,
        provider: session.provider,
        tool: "run command",
        detail: "git status",
        path: project ? primaryFolder(project, folderExists)?.path : undefined,
      };
      return {
        ...current,
        pending: [request, ...current.pending.filter((item) => item.sessionId !== session.id)],
        sessions: current.sessions.map((item) =>
          item.id === session.id ? { ...item, status: "needs-input" } : item,
        ),
      };
    });
  }, []);

  const send = useCallback((raw: string, options?: SendOptions) => {
    let text = raw.trim();
    const originalText = text;
    let hideUser = options?.hideUser === true;
    const images = (options?.images ?? []).filter(hasSendableAttachment);
    if (!text && images.length === 0) return;

    const targetSessionId = options?.sessionId ?? stateRef.current.activeSessionId;
    const liveSession = stateRef.current.sessions.find((item) => item.id === targetSessionId);
    const palette = liveSession ? commandsForSession(liveSession, deskSkillsRef.current) : [];
    const match = originalText.startsWith("/") ? matchCommand(originalText, palette) : undefined;
    const prep = prepareVendorSend({
      provider: liveSession?.provider,
      text: originalText,
      goal: liveSession?.goal,
      match,
    });
    const goalInput = liveSession && (
      liveSession.provider !== "grok" ||
      isWorkhorseGoalIntent(originalText) ||
      isWorkhorseGoalControl(originalText, liveSession.goal)
    ) ? parseGoalInput(originalText) : null;
    let vendorText = prep.vendorText;
    // Vendor slash commands must remain the first bytes of the prompt. The
    // radar is for natural language; explicit commands already chose a route.
    if (!originalText.startsWith("/")) {
      vendorText = withSkillDiscoveryHint(vendorText, originalText, deskSkillsRef.current);
    }
    const haltPlan = options?.afterGoalHalt
      ? "send-now"
      : planHaltForward({
          haltVendor: prep.haltVendor,
          skipVendor: prep.skipVendor,
          sessionStatus: liveSession?.status,
        });
    if (liveSession && prep.haltVendor && !options?.afterGoalHalt) {
      if (liveSession.status === "running" || liveSession.status === "needs-input") {
        cancelVendorSession(liveSession);
        goalHaltedSessions.current.add(liveSession.id);
      }
      const cleared =
        liveSession.provider === "grok" && !isWorkhorseGoalIntent(originalText) && !isWorkhorseGoalControl(originalText, liveSession.goal)
          ? parseGrokGoalLine(originalText)?.action === "clear"
          : parseGoalInput(originalText)?.action === "clear";
      const halt = cleared ? "goal cleared" : "goal paused";
      if (haltPlan === "desk-halt-only") {
        setState((current) => ({
          ...current,
          sessions: appendUserMessage(
            current.sessions.map((item) =>
              item.id === liveSession.id
                ? {
                    ...item,
                    status: "idle" as const,
                    goal: nextGoalForSend(item.provider, item.goal, originalText, prep.applyDeskGoal),
                    messages: [
                      ...finishOpenToolMessages(item.messages, "failed", halt).filter((message) =>
                        message.id !== grokAssistantId.current[item.id] || Boolean(message.text.trim() || message.thought?.trim()),
                      ),
                      ...(cleared
                        ? [
                            {
                              id: uid("msg"),
                              role: "system" as const,
                              text: "Goal cleared.",
                              createdAt: Date.now(),
                            },
                          ]
                        : []),
                    ],
                  }
                : item,
            ),
            liveSession.id,
            originalText,
          ),
        }));
        return;
      }
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === liveSession.id
            ? {
                ...item,
                goal: nextGoalForSend(item.provider, item.goal, originalText, prep.applyDeskGoal),
                messages: finishOpenToolMessages(item.messages, "failed", halt).filter((message) =>
                  message.id !== grokAssistantId.current[item.id] || Boolean(message.text.trim() || message.thought?.trim()),
                ),
              }
            : item,
        ),
      }));
      if (haltPlan === "defer-until-cancelled-done") {
        goalForwardAfterHalt.current[liveSession.id] = {
          text: originalText,
          images,
          hideUser,
        };
        return;
      }
    } else if (liveSession && prep.applyDeskGoal) {
      if (!options?.afterGoalHalt) goalHaltedSessions.current.delete(liveSession.id);
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === liveSession.id
            ? { ...item, goal: nextGoalForSend(item.provider, item.goal, originalText, true) }
            : item,
        ),
      }));
    } else if (liveSession && !options?.afterGoalHalt) {
      goalHaltedSessions.current.delete(liveSession.id);
    }
    const skipQueue = haltPlan === "defer-until-cancelled-done";
    if (liveSession?.status === "running" && !skipQueue && !options?.afterGoalHalt && !options?.steer && !options?.replaceUserId) {
      setState((current) => {
        const sessions = enqueuePrompt(current.sessions, liveSession.id, {
          text: originalText,
          images,
          hideUser,
          ...(vendorText !== originalText ? { vendorText } : {}),
        });
        return sessions ? { ...current, sessions } : current;
      });
      return;
    }
    if (liveSession?.status === "running" && options?.steer) {
      if (liveSession.provider === "codex") void window.workhorse?.codexCancel?.(liveSession.id);
      else if (liveSession.provider === "claude") void window.workhorse?.claudeCancel?.(liveSession.id);
      else if (liveSession.provider === "custom") void window.workhorse?.customCancel?.(liveSession.id);
      else void window.workhorse?.grokCancel(liveSession.id);
    }

    if (!goalInput && originalText.startsWith("/")) {
      const live = stateRef.current.sessions.find((item) => item.id === stateRef.current.activeSessionId);
      if (match?.run === "new") {
        setState((current) => ({
          ...current,
          sessions: dropDrafts(current.sessions),
          activeSessionId: null,
        }));
        return;
      }
      if (match?.run === "project") {
        setState((current) => ({ ...current, sheet: "project" }));
        return;
      }
      if (match?.run === "link") {
        void linkFolder();
        return;
      }
      if (match?.run === "providers") {
        setState((current) => ({ ...current, activeSessionId: null }));
        return;
      }
      if (match?.run.startsWith("mode:")) {
        setMode(match.run.slice(5) as PermissionMode);
        return;
      }
      if (match?.run === "sandbox") {
        const profile = parseSandbox(text.replace(/^\/sandbox\s*/i, ""));
        if (profile) setSandbox(profile);
        return;
      }
      if (match?.run === "demo-permission") {
        demoPermission();
        return;
      }
      if (match?.run === "theme") {
        cycleTheme();
        return;
      }
      if (match?.run === "usage") {
        setState((current) => ({ ...current, panel: "settings", settingsSection: "usage" }));
        return;
      }
      if (match?.run === "watch") {
        setState((current) => ({ ...current, panel: "settings", settingsSection: "watch" }));
        return;
      }
      if (match?.run === "schedule") {
        const scheduled = parseScheduleCommand(text);
        if (!live) return;
        if (!scheduled) {
          setState((current) => ({
            ...current,
            sessions: current.sessions.map((item) =>
              item.id === live.id
                ? {
                    ...item,
                    messages: [...item.messages, { id: uid("msg"), role: "system", text: "Use /schedule 30m prompt, or /schedule every 30m prompt.", createdAt: Date.now() }],
                  }
                : item,
            ),
          }));
          return;
        }
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((item) =>
            item.id === live.id
              ? {
                  ...item,
                  scheduledRuns: [
                    ...(item.scheduledRuns ?? []),
                    { ...scheduled, id: uid("run"), createdAt: Date.now() },
                  ],
                }
              : item,
          ),
        }));
        return;
      }
      if (match?.run === "settings") {
        setState((current) => ({ ...current, panel: "settings" }));
        return;
      }
      if (match?.run === "model") {
        const query = text.replace(/^\/m(odel)?\s*/i, "");
        const choice = findChoice(query);
        if (choice) setSessionModel(choice.provider, choice.model);
        return;
      }
      if (match?.run === "effort") {
        const level = parseEffort(text.replace(/^\/effort\s*/i, ""));
        if (level) setSessionEffort(level);
        return;
      }
      if (match?.run === "compact") {
        const note = text.replace(/^\/compact\s*/i, "").trim();
        const snapshot = stateRef.current;
        const session = snapshot.sessions.find((item) => item.id === snapshot.activeSessionId);
        if (!session) return;
        if (session.provider !== "grok") {
          const checkpoint = createPortableCheckpoint(session.messages, note);
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) => {
              if (item.id !== session.id) return item;
              if (!checkpoint) {
                return {
                  ...item,
                  messages: [...item.messages, {
                    id: uid("msg"), role: "system" as const, kind: "compact" as const,
                    text: "This chat is already short enough to carry without compaction.", createdAt: Date.now(),
                  }],
                };
              }
              const visible = item.messages.filter((message) =>
                !message.kind && (message.role === "user" || message.role === "assistant") &&
                (message.text.trim() || (message.images?.length ?? 0) > 0));
              const outcome = applyCompactOutcome({
                leftoverPercent: 0,
                contextUsed: item.contextUsed,
                windowSize: contextWindowFor(item.provider, item.model),
                omittedMessages: checkpoint.omittedMessages,
                keptMessages: Math.max(0, visible.length - checkpoint.omittedMessages),
                summaryChars: checkpoint.summary.length,
                usage: latest.usage,
              });
              const compactId = uid("msg");
              return {
                ...item,
                contextCheckpoint: checkpoint,
                vendorSessionId: undefined,
                vendorProvider: undefined,
                contextUsed: outcome.contextUsed,
                ledger: recordLiveCompact(item.ledger, {
                  id: compactId,
                  text: checkpoint.summary,
                  throughMessageId: checkpoint.throughMessageId,
                }),
                messages: [...item.messages, {
                  id: compactId, role: "system" as const, kind: "compact" as const,
                  text: `Workhorse compacted ${checkpoint.omittedMessages} earlier messages into a portable checkpoint${note ? ` · kept: ${note}` : ""}.`,
                  createdAt: Date.now(),
                }],
              };
            }),
          }));
          return;
        }
        const project = snapshot.projects.find((item) => item.id === session.projectId);
        const cwd = sessionExecutionCwd(session.environment, primaryFolder(project, folderExists)?.path ?? "");
        setState((latest) => ({
          ...latest,
          sessions: latest.sessions.map((item) =>
            item.id === session.id ? { ...item, status: "running" } : item,
          ),
        }));
        void (async () => {
          if (!window.workhorse?.grokCompact) {
            throw new Error("Grok compact runs in the Workhorse desktop window.");
          }
          const result = await window.workhorse.grokCompact({
            sessionId: session.id,
            projectId: session.projectId ?? undefined,
            text: note,
            model: session.model,
            effort: session.effort,
            mode: session.mode,
            cwd,
            note,
            vendorSessionId: vendorSessionForSend(session),
            sandbox: session.sandbox,
            mcpServers: mcpServersForSession(stateRef.current.settings.mcpServers, session),
          });
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) => {
              if (item.id !== session.id) return item;
              const contextUsed = applyCompactUsage(item.contextUsed, result);
              return {
                ...item,
                status: "idle",
                contextUsed,
                ledger: recordLiveCompact(item.ledger, {
                  id: uid("msg"),
                  text: formatCompactLine({ ...result, contextUsed, note: note || result.note }),
                }),
                messages: upsertCompactMessage(item.messages, { ...result, contextUsed, note: note || result.note }),
              };
            }),
          }));
        })().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === session.id
                ? {
                    ...item,
                    status: "idle",
                    messages: [
                      ...item.messages,
                      {
                        id: uid("msg"),
                        role: "system",
                        kind: "compact",
                        text: `Compact failed: ${message}`,
                        createdAt: Date.now(),
                      },
                    ],
                  }
                : item,
            ),
          }));
        });
        return;
      }
      if (match?.run === "rename") {
        const title = text.replace(/^\/rename\s*/i, "");
        setState((current) => {
          if (!current.activeSessionId) return current;
          const sessions = renameChat(current.sessions, current.activeSessionId, title);
          return sessions ? { ...current, sessions } : current;
        });
        return;
      }
      if (match?.run === "delete") {
        setState((current) => {
          if (!current.activeSessionId) return current;
          const sessions = deleteChat(current.sessions, current.activeSessionId);
          if (!sessions) return current;
          stopDeletedWorkerSessions(current.sessions, sessions);
          const leases = releaseDeletedSessionLeases(current.leases ?? [], current.sessions, sessions);
          pathLeasesRef.current = leases;
          return {
            ...current,
            sessions,
            leases,
            pending: current.pending.filter((item) => item.sessionId !== current.activeSessionId),
            activeSessionId: null,
          };
        });
        return;
      }
      if (match?.run === "archive") {
        setState((current) => {
          if (!current.activeSessionId) return current;
          const sessions = archiveChat(current.sessions, current.activeSessionId, true);
          if (!sessions) return current;
          return { ...current, sessions, activeSessionId: null };
        });
        return;
      }
      if (match?.run === "quit") {
        void window.workhorse?.quit();
        return;
      }
      if (match?.run === "copy") {
        const session = stateRef.current.sessions.find((item) => item.id === stateRef.current.activeSessionId);
        const last = [...(session?.messages ?? [])]
          .reverse()
          .find((message) => message.role === "assistant" && message.text.trim());
        if (last?.text) void navigator.clipboard?.writeText(last.text);
        return;
      }
      if (match?.run === "fork") {
        const session = stateRef.current.sessions.find((item) => item.id === stateRef.current.activeSessionId);
        const last = [...(session?.messages ?? [])]
          .reverse()
          .find(
            (message) =>
              message.role === "user" || (message.role === "assistant" && Boolean(message.text.trim())),
          );
        if (last) forkFromRef.current(last.id);
        return;
      }
      if (match?.run === "skill") {
        text = prep.vendorText;
      } else if (match && !commandContinuesToVendor(match.run)) {
        return;
      }
    }

    const current = stateRef.current;
    let session = current.sessions.find((item) => item.id === targetSessionId);
    if (!session) return;
    const turnCorrelationId = hideUser && learningTurns.current[session.id]
      ? learningTurns.current[session.id]!.correlationId
      : uid("corr");
    // A person's chat routes only when that chat is set to Auto. The Settings
    // switch decides how a new chat starts; it does not reach into a chat the
    // person has already set one way or the other.
    if (shouldRouteSessionTurn({ routingMode: session.routingMode, text: originalText, hideUser })) {
      const statuses = watchVendorStatuses({
        settings: current.settings,
        usage: current.usage,
        plans: plansRef.current,
        permits: current.watchPermits,
        dayMarks: current.watchDayMarks,
      });
      const routeCandidates = routingCandidatesForDesk(current.settings, statuses, plansRef.current);
      const routeRequest = {
        prompt: originalText,
        attachments: images,
        parentTier: hideUser ? session.routingDecision?.taskTier : undefined,
        role: session.parentId ? ("worker" as const) : undefined,
        outcomes: outcomesFromLearningEvents(learningOutcomeEvents),
        current: {
          provider: session.provider,
          model: session.model,
          customBotId: session.customBotId,
        },
        // The conversation must fit the picked model. Spawn routing skips
        // this on purpose: a worker starts a fresh session.
        contextNeed: session.contextUsed || undefined,
      };
      const decision = chooseRoutingDecision(routeCandidates, routeRequest, current.settings.routing);
      if (decision) {
        // Auto picks the effort with the model: a quick task at low, a deep
        // one at high. Keeping the person's old effort here left Auto choosing
        // half of what it was asked to choose.
        const routed = applySessionModelChange(session, {
          provider: decision.provider,
          model: decision.model,
          customBotId: decision.customBotId,
          effort: decision.effort ?? withEffort(decision.provider, decision.model, session.effort),
        });
        session = { ...routed, routingMode: "auto", routingDecision: decision };
        const routedSession = session;
        const evidence = routingDecisionEvidence({
          candidates: routeCandidates,
          request: routeRequest,
          settings: current.settings.routing,
          selected: decision,
          mode: "live-auto",
          source: "chat",
        });
        emitLearningEvent({
          kind: "routing",
          correlationId: turnCorrelationId,
          projectId: routedSession.projectId,
          sessionId: routedSession.id,
          provider: decision.provider,
          model: decision.model,
          effort: decision.effort,
          payload: {
            summary: decision.reason,
            ...(evidence ?? {}),
          },
        });
        // lastModel is what the user last chose, and seeds the next new chat.
        // A routed pick is not a choice: writing it here made one routed turn
        // to Kimi the default for every chat opened after it.
        setState((latest) => ({
          ...latest,
          sessions: latest.sessions.map((item) => (item.id === routedSession.id ? routedSession : item)),
        }));
      }
    }
    if (shouldShadowRouteSessionTurn({
      learningEnabled: learningCaptures(effectiveLearningMode(current.settings.learning, session.projectId)),
      routingMode: session.routingMode,
      text: originalText,
      hideUser,
    })) {
      const statuses = watchVendorStatuses({
        settings: current.settings,
        usage: current.usage,
        plans: plansRef.current,
        permits: current.watchPermits,
        dayMarks: current.watchDayMarks,
      });
      const routeCandidates = routingCandidatesForDesk(current.settings, statuses, plansRef.current);
      const routeRequest = {
        prompt: originalText,
        attachments: images,
        outcomes: outcomesFromLearningEvents(learningOutcomeEvents),
        current: {
          provider: session.provider,
          model: session.model,
          customBotId: session.customBotId,
        },
        contextNeed: session.contextUsed || undefined,
      };
      const evidence = routingDecisionEvidence({
        candidates: routeCandidates,
        request: routeRequest,
        settings: current.settings.routing,
        selected: session,
        mode: "shadow",
        source: "chat",
      });
      if (evidence) {
        emitLearningEvent({
          kind: "routing",
          correlationId: turnCorrelationId,
          projectId: session.projectId,
          sessionId: session.id,
          provider: session.provider,
          model: session.model,
          effort: session.effort,
          payload: {
            summary: "Shadow routing recommendation recorded",
            ...evidence,
          },
        });
      }
    }
    if (!vendorAttachedForSession(session, current.settings)) {
      setState((latest) => ({ ...latest, panel: "settings", settingsSection: "llms" }));
      return;
    }
    const hold = evaluateWatchHold({
      session,
      settings: current.settings,
      plans: plansRef.current,
      permits: current.watchPermits,
      permitted: options?.permit === true,
      usage: current.usage,
      dayMarks: current.watchDayMarks,
    });
    if (hold) {
      setWatchHold({
        ...hold,
        sessionId: session.id,
        text,
        images: images.length > 0 ? images : undefined,
        replaceUserId: options?.replaceUserId,
        steer: options?.steer,
        hideUser,
        restoreText: originalText,
      });
      return false;
    }
    const userMessageId = !hideUser && !options?.replaceUserId ? uid("msg") : undefined;
    const ledgerUserId = userMessageId ?? uid("msg");
    const userMessageCreatedAt = Date.now();
    if (!hideUser) {
      emitLearningEvent({
        id: userMessageId ? backfillEventId(userMessageId) : undefined,
        createdAt: userMessageCreatedAt,
        kind: originalText !== text || options?.replaceUserId ? "human-edit" : "human-prompt",
        actorClass: "human",
        projectId: session.projectId,
        sessionId: session.id,
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        correlationId: turnCorrelationId,
        payload: { summary: originalText.slice(0, BACKFILL_SUMMARY_CHARS) },
      });
    }
    const project = current.projects.find((item) => item.id === session.projectId);
    let working = session.messages;
    let vendorSessionId = vendorSessionForSend(session);
    let keepBefore = -1;
    if (options?.replaceUserId) {
      const next = rewindToUserMessage(session.messages, options.replaceUserId, text);
      if (!next) return;
      working = next;
      keepBefore = next.filter((message) => message.role === "user").length - 2;
      if (session.status === "running") {
        if (session.provider === "codex") void window.workhorse?.codexCancel?.(session.id);
        else if (session.provider === "claude") void window.workhorse?.claudeCancel?.(session.id);
        else if (session.provider === "cursor") void window.workhorse?.cursorCancel?.(session.id);
        else if (session.provider === "custom") void window.workhorse?.customCancel?.(session.id);
        else void window.workhorse?.grokCancel(session.id);
      }
      setEditMessageId(null);
    }
    const live = vendorSendTarget(session.provider);
    if (live !== "preview") {
      const previousAssistantId = grokAssistantId.current[session.id];
      const assistantId = uid("msg");
      grokAssistantId.current[session.id] = assistantId;
      const leftover = grokUsagePending.current[session.id];
      if (leftover?.length) {
        const leftoverSettled = settleTurnUsage({
          pending: leftover,
          provider: session.provider,
          model: session.model,
          projectId: session.projectId ?? undefined,
          sessionId: session.id,
          customBotId: session.provider === "custom" ? session.customBotId : undefined,
          estimate: estimateFromSessionTurn({
            messages: session.messages,
            assistantId: previousAssistantId,
            queuedText: grokChunkQueue.current[session.id] ?? "",
          }),
        });
        if (leftoverSettled && usageHasBilledTokens(leftoverSettled)) {
          recordUsage({
            ...leftoverSettled,
            contextUsed: occupancyForSession(session, leftoverSettled, grokContextSeen.current[session.id]),
          });
        }
      }
      delete grokUsagePending.current[session.id];
      delete grokContextSeen.current[session.id];
      learningTurns.current[session.id] = {
        correlationId: turnCorrelationId,
        agentRunId: assistantId,
        toolIds: [],
      };
      emitLearningEvent({
        id: learningEvidenceId("execution", assistantId),
        kind: "execution",
        actorClass: "agent",
        projectId: session.projectId,
        sessionId: session.id,
        provider: session.provider,
        model: session.model,
        effort: session.effort,
        correlationId: turnCorrelationId,
        agentRunId: assistantId,
        payload: {
          summary: `${session.provider} ${session.model} model call started`,
          status: "started",
          mode: session.mode,
          sandbox: session.sandbox,
          hiddenWorker: Boolean(session.hidden),
        },
      });
      const cwd = sessionExecutionCwd(session.environment, primaryFolder(project, folderExists)?.path ?? "");
      setState((latest) => {
        const queued = grokChunkQueue.current[session.id] ?? "";
        delete grokChunkQueue.current[session.id];
        const thoughtQueued = grokThoughtQueue.current[session.id] ?? "";
        delete grokThoughtQueue.current[session.id];
        const live = latest.sessions.find((item) => item.id === session.id);
        const base = live?.messages ?? working;
        return {
          ...latest,
          sessions: latest.sessions.map((item) =>
            item.id === session.id
              ? {
                  ...item,
                  status: "running",
                  goal: nextGoalForSend(item.provider, item.goal, originalText, prep.applyDeskGoal),
                  title: hideUser
                    ? item.title
                    : autoTitleForSend(item, originalText || images[0]?.name || "Image") ?? item.title,
                  ledger: appendOpenTurnUser(item.ledger, {
                    id: ledgerUserId,
                    text: hideUser ? vendorText : originalText,
                    source: hideUser ? "goal" : "human",
                    at: userMessageCreatedAt,
                  }),
                  messages: upsertThoughtMessage(
                    [
                      ...base,
                      ...(options?.replaceUserId || hideUser
                        ? []
                        : [
                            {
                              id: userMessageId!,
                              role: "user" as const,
                              text: originalText,
                              ...(images.length > 0 ? { images } : {}),
                              createdAt: userMessageCreatedAt,
                              correlationId: turnCorrelationId,
                              ...brainStamp(session),
                            },
                          ]),
                      {
                        id: assistantId,
                        role: "assistant",
                        text: queued,
                        createdAt: Date.now(),
                        correlationId: turnCorrelationId,
                        ...brainStamp(session),
                      },
                    ],
                    thoughtQueued,
                  ),
                }
              : item,
          ),
        };
      });
      void (async () => {
        const promptInput = {
          sessionId: session.id,
          projectId: session.projectId ?? undefined,
          text: vendorText,
          visibleText: firstUserText({ messages: working }) || originalText || images[0]?.name || "Image",
          images,
          model: session.model,
          effort: session.effort,
          mode: session.mode,
          cwd,
          vendorSessionId,
          sandbox: session.sandbox,
          securityPolicy: session.securityPolicy,
          parentId: session.parentId,
          hidden: session.hidden,
          role: deskRoleOf(session),
          crewModes: session.crewModes,
          mcpServers: mcpServersForSession(stateRef.current.settings.mcpServers, session),
          preface: withPortableHistory(buildSessionPreface({
            sessionId: session.id,
            cwd,
            folders: projectFolderPaths(project, folderExists),
            references: project?.references ?? [],
            mode: session.mode,
            sandbox: session.sandbox,
            surface: session.provider === "custom" ? "http" : session.provider === "cursor" ? "cursor" : "mcp",
            role: deskRoleOf(session),
            desk: {
              title: session.title,
              projectName: project?.name,
              sidebar: formatChatSidebar({
                provider: session.provider,
                model: session.model,
                effort: session.effort,
                mode: session.mode,
                botName: customBotForSession(stateRef.current.settings.customBots, session)?.name,
              }),
              preview: chatPreview(working),
            },
          }), session.provider === "custom" ? [] : messagesForPortableReplay(working, session.contextCheckpoint)),
        };
        if (live === "custom") {
          if (!window.workhorse?.customPrompt) {
            throw new Error("Custom model runs in the Workhorse desktop window.");
          }
          const bot = customBotForSession(stateRef.current.settings.customBots, session);
          if (session.customBotId && !bot) throw new Error("This model is not approved on this key.");
          const custom = bot ?? stateRef.current.settings.llms.custom;
          if (!custom.apiKey?.trim() || !custom.baseUrl?.trim()) {
            throw new Error("Create this bot in Settings first.");
          }
          const prior = messagesForPortableReplay(working, session.contextCheckpoint).filter(
            (message) => (message.role === "user" || message.role === "assistant") && !message.kind,
          );
          const history = (options?.replaceUserId ? prior.slice(0, -1) : prior).map((message) => ({
            role: message.role as "user" | "assistant",
            text: message.text,
            images: message.images,
          }));
          const result = await window.workhorse.customPrompt({
            sessionId: session.id,
            projectId: session.projectId ?? undefined,
            text: vendorText,
            images,
            model: session.model || custom.model,
            effort: session.effort,
            cwd,
            mode: session.mode,
            sandbox: session.sandbox,
            preface: promptInput.preface,
            history,
            mcpServers: mcpServersForSession(stateRef.current.settings.mcpServers, session),
            securityPolicy: session.securityPolicy,
            permissionGrants: session.permissionGrants,
            folders: projectFolderPaths(project, folderExists),
            parentId: session.parentId,
            hidden: session.hidden,
            role: deskRoleOf(session),
            crewModes: session.crewModes,
            customBotId: session.customBotId ?? ("id" in custom ? custom.id : undefined),
            config: {
              baseUrl: custom.baseUrl,
              apiKey: custom.apiKey,
              model: session.model || custom.model,
              api: "api" in custom ? custom.api : undefined,
              inputs: routingProfileForModel("custom", session.model || custom.model, "routingProfile" in custom ? custom.routingProfile : undefined).inputs,
            },
          });
          const reply = typeof result?.text === "string" ? result.text.trim() : "";
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === session.id
                ? applyVendorTurnIdle({
                    ...item,
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !assistantHasVisibleReply(entry.text)
                        ? {
                            ...entry,
                            text: settleEmptyAssistantText({
                              provider: "custom",
                              reply,
                              existingText: entry.text,
                              worked: turnWorkedAfterAssistant(item.messages, assistantId),
                            }),
                          }
                        : entry,
                    ),
                  }, { assistantId })
                : item,
            ),
          }));
          return;
        }
        if (live === "claude") {
          if (!window.workhorse?.claudePrompt) {
            throw new Error("Claude agent runs in the Workhorse desktop window.");
          }
          if (options?.replaceUserId) vendorSessionId = undefined;
          const result = await window.workhorse.claudePrompt({ ...promptInput, vendorSessionId });
          const reply = typeof result?.text === "string" ? result.text.trim() : "";
          vendorSessionId =
            typeof result?.vendorSessionId === "string" && result.vendorSessionId
              ? result.vendorSessionId
              : vendorSessionId;
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === session.id
                ? applyVendorTurnIdle({
                    ...item,
                    vendorSessionId,
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !assistantHasVisibleReply(entry.text)
                        ? {
                            ...entry,
                            text: settleEmptyAssistantText({
                              provider: "claude",
                              reply,
                              existingText: entry.text,
                              worked: turnWorkedAfterAssistant(item.messages, assistantId),
                            }),
                          }
                        : entry,
                    ),
                  }, { assistantId })
                : item,
            ),
          }));
          return;
        }
        if (live === "cursor") {
          if (!window.workhorse?.cursorPrompt) {
            throw new Error("Cursor agent runs in the Workhorse desktop window.");
          }
          if (options?.replaceUserId) vendorSessionId = undefined;
          const result = await window.workhorse.cursorPrompt({ ...promptInput, vendorSessionId });
          const reply = typeof result?.text === "string" ? result.text.trim() : "";
          vendorSessionId =
            typeof result?.vendorSessionId === "string" && result.vendorSessionId
              ? result.vendorSessionId
              : vendorSessionId;
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === session.id
                ? applyVendorTurnIdle({
                    ...item,
                    vendorSessionId,
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !assistantHasVisibleReply(entry.text)
                        ? {
                            ...entry,
                            text: settleEmptyAssistantText({
                              provider: "cursor",
                              reply,
                              existingText: entry.text,
                              worked: turnWorkedAfterAssistant(item.messages, assistantId),
                            }),
                          }
                        : entry,
                    ),
                  }, { assistantId })
                : item,
            ),
          }));
          void window.workhorse?.cursorPlanUsage?.()
            .then((plan) => {
              setCursorPlan(plan ?? undefined);
              markVendorPlanKnown("cursor");
            })
            .catch(() => markVendorPlanKnown("cursor"));
          return;
        }
        if (live === "codex") {
          if (!window.workhorse?.codexPrompt) {
            throw new Error("Codex agent runs in the Workhorse desktop window.");
          }
          if (options?.replaceUserId) vendorSessionId = undefined;
          const result = await window.workhorse.codexPrompt({ ...promptInput, vendorSessionId });
          const reply = typeof result?.text === "string" ? result.text.trim() : "";
          vendorSessionId = result?.nativeSessionArchived
            ? undefined
            : typeof result?.vendorSessionId === "string" && result.vendorSessionId
              ? result.vendorSessionId
              : vendorSessionId;
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === session.id
                ? applyVendorTurnIdle({
                    ...item,
                    vendorSessionId,
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !assistantHasVisibleReply(entry.text)
                        ? {
                            ...entry,
                            text: settleEmptyAssistantText({
                              provider: "codex",
                              reply,
                              existingText: entry.text,
                              worked: turnWorkedAfterAssistant(item.messages, assistantId),
                            }),
                          }
                        : entry,
                    ),
                  }, { assistantId })
                : item,
            ),
          }));
          return;
        }
        if (!window.workhorse?.grokPrompt) {
          throw new Error("Grok agent runs in the Workhorse desktop window.");
        }
        if (options?.replaceUserId && window.workhorse.grokRewind) {
          const rewound = await window.workhorse.grokRewind({
            ...promptInput,
            keepUserIndex: keepBefore,
          });
          if (rewound?.reset) vendorSessionId = undefined;
        }
        const result = await window.workhorse.grokPrompt({ ...promptInput, vendorSessionId });
        const reply = typeof result?.text === "string" ? result.text.trim() : "";
        vendorSessionId =
          typeof result?.vendorSessionId === "string" && result.vendorSessionId
            ? result.vendorSessionId
            : vendorSessionId;
        setState((latest) => ({
          ...latest,
          sessions: latest.sessions.map((item) =>
            item.id === session.id
              ? applyVendorTurnIdle({
                  ...item,
                  vendorSessionId,
                  messages: item.messages.map((entry) =>
                    entry.id === assistantId && !assistantHasVisibleReply(entry.text)
                      ? {
                          ...entry,
                          text: settleEmptyAssistantText({
                            provider: "grok",
                            reply,
                            existingText: entry.text,
                            worked: turnWorkedAfterAssistant(item.messages, assistantId),
                          }),
                        }
                      : entry,
                  ),
                }, { assistantId })
              : item,
          ),
        }));
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const failedSession = stateRef.current.sessions.find((item) => item.id === session.id);
        const turn = learningTurns.current[session.id];
        const joinTurn = looksLikeJoinPrompt(text) || isJoinAssistantTurn(
          stateRef.current.sessions.find((item) => item.id === session.id)?.messages ?? [],
          assistantId,
        );
        const attempt = options?.joinAttempt ?? 1;
        if (joinTurn && isVendorRateLimitError(message) && attempt < JOIN_MAX_ATTEMPTS) {
          if (turn) {
            emitLearningEvent({
              id: learningEvidenceId("retry", assistantId, String(attempt)),
              kind: "execution",
              actorClass: "agent",
              projectId: failedSession?.projectId,
              sessionId: session.id,
              provider: failedSession?.provider ?? session.provider,
              model: failedSession?.model ?? session.model,
              effort: failedSession?.effort ?? session.effort,
              correlationId: turn.correlationId,
              agentRunId: assistantId,
              payload: { summary: "Model call rate-limited; retry queued", status: "retry", attempt, error: message },
            });
          }
          setState((latest) => ({
            ...latest,
            sessions: applyJoinRateLimitRetry(latest.sessions, session.id, {
              prompt: text,
              attempt,
              assistantId,
            }),
          }));
          return;
        }
        if (turn && failedSession) {
          const evidence = agentTurnEvidence({
            messages: finishOpenToolMessages(failedSession.messages, "failed", message),
            assistantId,
            outcome: "failed",
            queuedText: grokChunkQueue.current[session.id],
            error: message,
            workedMs: Math.max(0, Date.now() - (failedSession.messages.find((entry) => entry.id === assistantId)?.createdAt ?? Date.now())),
          });
          emitLearningEvent({
            id: learningEvidenceId("outcome", assistantId),
            kind: "outcome",
            actorClass: "agent",
            projectId: failedSession.projectId,
            sessionId: failedSession.id,
            provider: failedSession.provider,
            model: failedSession.model,
            customBotId: failedSession.customBotId,
            effort: failedSession.effort,
            correlationId: turn.correlationId,
            agentRunId: assistantId,
            toolIds: evidence.toolIds,
            payload: evidence.payload,
          });
          delete learningTurns.current[session.id];
        }
        setState((latest) => ({
          ...latest,
          sessions: latest.sessions.map((item) =>
            item.id === session.id
              ? applyVendorTurnIdle({
                  ...item,
                  messages: finishOpenToolMessages(
                    item.messages.map((entry) =>
                      entry.id === assistantId
                        ? {
                            ...entry,
                            text:
                              entry.text ||
                              (joinTurn
                                ? vendorRateLimitNotice(session.provider)
                                : vendorFailedMessage(session.provider, message)),
                          }
                        : entry,
                    ),
                    "failed",
                    message,
                  ),
                }, { assistantId, failed: true })
              : item,
          ),
        }));
      });
      return;
    }
    const where = project && project.folders.length > 0
      ? project.folders.map((folder) => folder.path).join("\n")
      : "(no folder linked — basic chat)";
    const reply = [
      `Preview only. ${providerById(session.provider).name} would answer in “${project?.name ?? "this project"}”.`,
      where,
      "",
      `You said: ${text || "(image)"}`,
      ...(images.length > 0 ? [`Attached: ${images.map((image) => image.name).join(", ")}`] : []),
    ].join("\n");
    setState((latest) => ({
      ...latest,
      sessions: latest.sessions.map((item) =>
        item.id === session.id
          ? {
              ...item,
              goal: nextGoalForSend(item.provider, item.goal, originalText, prep.applyDeskGoal),
              title: hideUser
                ? item.title
                : autoTitleForSend(item, originalText || images[0]?.name || "Image") ?? item.title,
              messages: [
                ...working,
                ...(options?.replaceUserId || hideUser
                  ? []
                  : [
                      {
                        id: uid("msg"),
                        role: "user" as const,
                        text: originalText,
                        ...(images.length > 0 ? { images } : {}),
                        createdAt: Date.now(),
                        ...brainStamp(session),
                      },
                    ]),
                { id: uid("msg"), role: "assistant", text: reply, createdAt: Date.now(), ...brainStamp(session) },
              ],
            }
          : item,
      ),
    }));
  }, [cycleTheme, demoPermission, linkFolder, setMode, setSandbox, setSessionEffort, setSessionModel]);

  /**
   * Pick up a worker the desk interrupted.
   *
   * Closing Workhorse mid-wave used to mark every running worker "failed" and
   * leave it there — four of them, sixty-odd messages of finished work each,
   * with no way back. Nothing was actually lost: the brief, the transcript,
   * the folder and the model are all on disk. This puts the worker back to
   * running and re-sends its brief; the vendor sees the chat it already has,
   * so it continues rather than starting over.
   */
  const resumeAgentRun = useCallback((sessionId: string) => {
    const snapshot = stateRef.current;
    const child = snapshot.sessions.find((item) => item.id === sessionId);
    if (!child) return { ok: false, message: "That chat is gone." };
    if (!child.agentRun) return { ok: false, message: "This chat is not a worker." };
    if (child.agentRun.status === "running" || child.status === "running") {
      return { ok: false, message: "It is already running." };
    }
    if (child.agentRun.status !== "interrupted") {
      return { ok: false, message: "Only an interrupted worker can be resumed." };
    }
    const brief = lastUserMessage(child)?.text?.trim();
    if (!brief) return { ok: false, message: "This worker has no brief to resume from." };

    const startedAt = Date.now();
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) => {
        if (item.id === child.id) {
          return {
            ...item,
            agentRun: { ...item.agentRun!, status: "running" as const, startedAt, finishedAt: undefined, error: undefined },
          };
        }
        if (item.id === child.parentId && item.lineup) {
          return {
            ...item,
            lineup: {
              ...item.lineup,
              rows: item.lineup.rows.map((row) =>
                row.childId === child.id ? { ...row, status: "running" as const, startedAt, finishedAt: undefined } : row,
              ),
            },
          };
        }
        return item;
      }),
    }));
    // hideUser: the brief is already the first thing in this chat. Showing it
    // again would read as the user asking twice.
    send(brief, { sessionId: child.id, hideUser: true });
    return { ok: true, message: "Resumed." };
  }, [send]);

  const resendFrom = useCallback(
    (messageId: string, text: string) => {
      const session = stateRef.current.sessions.find((item) => item.id === stateRef.current.activeSessionId);
      const current = session?.messages.find((item) => item.id === messageId);
      send(text, { replaceUserId: messageId, images: current?.images });
    },
    [send],
  );

  const sendRef = useRef(send);
  sendRef.current = send;
  const flushing = useRef(new Set<string>());
  // Bumped when a queued prompt's notBefore passes. It has to be a dependency
  // of the drainer: re-setting state with the same sessions array re-ran
  // nothing, and a join queued behind an 8s cool-down sat there until a click.
  const [queueWake, setQueueWake] = useState(0);

  useEffect(() => {
    if (watchHold) return;
    for (const session of state.sessions) {
      if (session.status !== "idle" || !session.queue?.length || flushing.current.has(session.id)) continue;
      if (session.goal?.status === "paused") continue;
      const item = session.queue[0];
      if (item.notBefore && Date.now() < item.notBefore) continue;
      flushing.current.add(session.id);
      setState((current) => {
        const shifted = shiftQueuedPrompt(current.sessions, session.id);
        return shifted ? { ...current, sessions: shifted.sessions } : current;
      });
      queueMicrotask(() => {
        flushing.current.delete(session.id);
        if (item.scheduledRunId) {
          setState((current) => ({
            ...current,
            sessions: current.sessions.map((row) =>
              row.id === session.id
                ? {
                    ...row,
                    scheduledRuns: (row.scheduledRuns ?? []).map((run) =>
                      run.id === item.scheduledRunId ? { ...run, status: "running" as const } : run,
                    ),
                  }
                : row,
            ),
          }));
        }
        sendRef.current(item.text, {
          images: item.images,
          sessionId: session.id,
          joinAttempt: item.joinAttempt,
          hideUser: item.hideUser === true,
          scheduledRunId: item.scheduledRunId,
        });
      });
    }
    const wait = queueWakeDelayMs(state.sessions);
    if (wait === null) return;
    const timer = window.setTimeout(() => setQueueWake((n) => n + 1), wait);
    return () => window.clearTimeout(timer);
  }, [state.sessions, watchHold, queueWake]);

  useEffect(() => {
    if (!ready || !window.workhorse?.onGrokBotLateAnswer) return;
    const accept = (answers: import("../../electron/grok-bot-late").GrokBotLateAnswer[]) => {
      if (!answers.length) return;
      setState((current) => {
        let changed = false;
        const sessions = current.sessions.map((session) => {
          const mine = answers.filter((answer) => answer.sessionId === session.id);
          if (!mine.length) return session;
          const fresh = mine.filter((answer) => !session.messages.some((message) => message.id === `msg_late_${answer.reqId}`));
          if (!fresh.length) return session;
          changed = true;
          return {
            ...session,
            messages: [
              ...session.messages,
              ...fresh.map((answer) => ({
                id: `msg_late_${answer.reqId}`,
                role: "assistant" as const,
                text: answer.text,
                createdAt: Date.now(),
                correlationId: answer.reqId,
                // The answering brain, not whatever the chat is set to by now.
                provider: "custom" as const,
                model: "grok-bot",
              })),
            ],
          };
        });
        return changed ? { ...current, sessions } : current;
      });
      // Every answer is spent through the persist pass below: an appended one
      // once its save lands, and one whose chat is gone once a saved state
      // shows that chat absent. Deciding here would race the updater on a
      // stale snapshot.
      for (const answer of answers) lateAckPending.current.set(answer.reqId, answer.sessionId);
    };
    const off = window.workhorse.onGrokBotLateAnswer(accept);
    void window.workhorse.lateGrokBotAnswers?.().then((answers) => answers?.length && accept(answers)).catch(() => undefined);
    return off;
  }, [ready]);

  useEffect(() => {
    if (!ready || !window.workhorse?.syncJobs || !window.workhorse.onJobDue) return;
    const accept = (events: import("../../electron/job-engine").DurableJobEvent[]) => {
      if (!events.length) return;
      const now = Date.now();
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((session) => {
          const due = events.filter((event) => event.sessionId === session.id);
          if (!due.length) return session;
          const runIds = new Set(due.map((event) => event.run.id));
          const queuedIds = new Set((session.queue ?? []).flatMap((item) => item.scheduledRunId ? [item.scheduledRunId] : []));
          const additions = due.filter((event) => !queuedIds.has(event.run.id));
          const nextRuns = due.flatMap((event) => event.nextRun ? [event.nextRun] : []);
          const existingRuns = new Set((session.scheduledRuns ?? []).map((run) => run.id));
          return {
            ...session,
            queue: [
              ...(session.queue ?? []),
              ...additions.map((event) => ({ id: uid("queue"), text: event.run.prompt, createdAt: now, scheduledRunId: event.run.id })),
            ],
            scheduledRuns: [
              ...(session.scheduledRuns ?? []).map((run) => runIds.has(run.id) ? { ...run, status: "queued" as const } : run),
              ...nextRuns.filter((run) => !existingRuns.has(run.id)),
            ],
          };
        }),
      }));
    };
    const off = window.workhorse.onJobDue(accept);
    void window.workhorse.syncJobs(stateRef.current.sessions).then(accept).catch(() => undefined);
    return off;
  }, [ready]);

  const dropQueued = useCallback((id: string) => {
    const sessionId = stateRef.current.activeSessionId;
    if (!sessionId) return;
    setState((current) => {
      const sessions = dropQueuedPrompt(current.sessions, sessionId, id);
      return sessions ? { ...current, sessions } : current;
    });
  }, []);

  const steerQueued = useCallback(
    (id: string) => {
      const sessionId = stateRef.current.activeSessionId;
      const session = stateRef.current.sessions.find((item) => item.id === sessionId);
      const item = session?.queue?.find((row) => row.id === id);
      if (!sessionId || !item) return;
      setState((current) => {
        const sessions = dropQueuedPrompt(current.sessions, sessionId, id);
        return sessions ? { ...current, sessions } : current;
      });
      send(item.text, { images: item.images, steer: true });
    },
    [send],
  );

  const requestEditMessage = useCallback((messageId: string) => {
    setEditMessageId(messageId);
  }, []);

  const clearEditMessage = useCallback(() => {
    setEditMessageId(null);
  }, []);

  const forkFrom = useCallback((messageId: string, sessionId?: string) => {
    const current = stateRef.current;
    const sourceId = sessionId ?? current.activeSessionId;
    if (!sourceId) return;
    const source = current.sessions.find((item) => item.id === sourceId);
    if (!source) return;
    const nextId = uid("sess");
    const forked = forkChat(current.sessions, sourceId, messageId, nextId);
    if (!forked) return;
    setState({
      ...current,
      sessions: forked.sessions,
      activeSessionId: forked.session.id,
      activeProjectId: forked.session.projectId,
      panel: null,
    });
    const project = current.projects.find((item) => item.id === source.projectId);
    const root = primaryFolder(project, folderExists)?.path ?? "";
    const attachGrokFork = (cwd: string) => {
      if (source.provider !== "grok" || !window.workhorse?.grokFork) return;
      void window.workhorse
        .grokFork({
          sessionId: source.id,
          projectId: source.projectId ?? undefined,
          text: "",
          model: source.model,
          effort: source.effort,
          mode: source.mode,
          cwd,
          vendorSessionId: source.vendorSessionId,
          sandbox: source.sandbox,
          mcpServers: mcpServersForSession(current.settings.mcpServers, source),
        })
        .then((result) => {
          if (!result?.vendorSessionId) return;
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === nextId ? { ...item, vendorSessionId: result.vendorSessionId } : item,
            ),
          }));
        })
        .catch(() => undefined);
    };
    if (root && window.workhorse?.ensureWorktree) {
      void window.workhorse
        .ensureWorktree({ sessionId: nextId, root })
        .then((isolated) => {
          const cwd = isolated.ok && isolated.path ? isolated.path : root;
          if (isolated.ok && isolated.path && isolated.gitRoot) {
            setState((latest) => ({
              ...latest,
              sessions: latest.sessions.map((item) =>
                item.id === nextId
                  ? {
                      ...item,
                      environment: {
                        kind: "worktree" as const,
                        path: isolated.path,
                        gitRoot: isolated.gitRoot,
                        ...(isolated.head ? { head: isolated.head } : {}),
                      },
                    }
                  : item,
              ),
            }));
          }
          attachGrokFork(cwd);
        })
        .catch(() => attachGrokFork(root));
      return;
    }
    attachGrokFork(sessionExecutionCwd(source.environment, root));
  }, []);
  forkFromRef.current = forkFrom;

  const requestEditLastPrompt = useCallback((sessionId?: string) => {
    const id = sessionId ?? stateRef.current.activeSessionId;
    if (!id) return;
    const session = stateRef.current.sessions.find((item) => item.id === id);
    const last = session ? lastUserMessage(session) : undefined;
    setState((current) => ({
      ...current,
      activeSessionId: id,
      activeProjectId: session?.projectId ?? current.activeProjectId,
      panel: null,
    }));
    setEditMessageId(last?.id ?? null);
  }, []);

  const recordUsage = useCallback((draft: UsageDraft) => {
    // Cursor estimates when ACP omits a bill. Grok/Claude/Codex stay unknown.
    if (draft.source === "estimate" && draft.provider !== "cursor") return;
    const model = normalizeModelId(draft.provider, draft.model);
    const tokenCount = (value: unknown) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
    };
    const inputTokens = tokenCount(draft.inputTokens);
    const outputTokens = tokenCount(draft.outputTokens);
    const cacheReadTokens = tokenCount(draft.cacheReadTokens);
    const cacheWriteTokens = tokenCount(draft.cacheWriteTokens);
    const contextUsed = draft.contextUsed === undefined ? undefined : tokenCount(draft.contextUsed);
    const costUsd = typeof draft.costUsd === "number" && Number.isFinite(draft.costUsd) && draft.costUsd >= 0
      ? draft.costUsd
      : undefined;
    const turn = draft.sessionId ? learningTurns.current[draft.sessionId] : undefined;
    emitLearningEvent({
      kind: "usage",
      actorClass: "agent",
      projectId: draft.projectId,
      sessionId: draft.sessionId,
      provider: draft.provider,
      model,
      correlationId: turn?.correlationId,
      agentRunId: turn?.agentRunId,
      toolIds: turn?.toolIds,
      payload: {
        summary: `${draft.provider} usage`,
        inputTokens,
        outputTokens,
        costUsd,
        signals: { adapterTerminal: true },
      },
    });
    setState((current) => {
      const sessionId = draft.sessionId ?? current.activeSessionId ?? undefined;
      return {
        ...current,
        usage: [
          {
            id: uid("use"),
            at: Date.now(),
            provider: draft.provider,
            model,
            projectId: draft.projectId ?? current.activeProjectId ?? undefined,
            sessionId,
            customBotId: draft.customBotId,
            lane: draft.lane ?? (draft.provider === "cursor" ? cursorUsageLane(model) : undefined),
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            costUsd,
            contextUsed,
            ...(draft.source ? { source: draft.source } : {}),
          },
          ...current.usage,
        ],
        sessions:
          contextUsed === undefined
            ? current.sessions
            : current.sessions.map((item) =>
                item.id === sessionId ? { ...item, contextUsed } : item,
              ),
      };
    });
  }, []);

  useEffect(() => {
    if (!window.workhorse?.onPeerAsk) return;
    return window.workhorse.onPeerAsk((payload) => {
      void (async () => {
        const replyAsk = async (result: { text?: string; error?: string }) => {
          try {
            await window.workhorse?.replyPeerAsk({ id: payload.id, ...result });
          } catch {
            /* host waiter may already have settled */
          }
        };
        const promptVendor = async (
          session: Session,
          text: string,
          mcpServers: McpServerConfig[],
          images: import("./types").ChatImage[] = [],
          restartRuntime = false,
        ) => {
          const snapshot = stateRef.current;
          const runtimeMcpServers = mcpServersForSession(mcpServers, session);
          const hold = evaluateWatchHold({
            session,
            settings: snapshot.settings,
            plans: plansRef.current,
            permits: snapshot.watchPermits,
            usage: snapshot.usage,
            dayMarks: snapshot.watchDayMarks,
          });
          if (hold) throw new Error(watchHoldMessage(hold));
          const project = snapshot.projects.find((item) => item.id === session.projectId);
          const cwd = sessionExecutionCwd(session.environment, primaryFolder(project, folderExists)?.path ?? "");
          const live = vendorSendTarget(session.provider);
          const role = deskRoleOf(session);
          const preface = buildSessionPreface({
            sessionId: session.id,
            cwd,
            folders: projectFolderPaths(project, folderExists),
            references: project?.references ?? [],
            mode: session.mode,
            sandbox: session.sandbox,
            surface: session.provider === "custom" ? "http" : session.provider === "cursor" ? "cursor" : "mcp",
            role,
          });
          const promptInput = {
            sessionId: session.id,
            projectId: session.projectId ?? undefined,
            text,
            images,
            model: session.model,
            effort: session.effort,
            mode: session.mode,
            cwd,
            vendorSessionId: vendorSessionForSend(session),
            sandbox: session.sandbox,
            mcpServers: runtimeMcpServers,
            preface,
            parentId: session.parentId,
            hidden: session.hidden,
            role,
            crewModes: session.crewModes,
            restartRuntime,
          };
          if (live === "preview") throw new Error(`${providerById(session.provider).name} is not connected yet`);
          if (live === "custom") {
            if (!window.workhorse?.customPrompt) throw new Error("Custom model runs in the Workhorse desktop window.");
            const bot = customBotForSession(snapshot.settings.customBots, session);
            if (session.customBotId && !bot) throw new Error("This model is not approved on this key.");
            const custom = bot ?? snapshot.settings.llms.custom;
            if (!custom.apiKey?.trim() || !custom.baseUrl?.trim()) {
              throw new Error("Custom model is not connected yet");
            }
            const result = await window.workhorse.customPrompt({
              sessionId: session.id,
              projectId: session.projectId ?? undefined,
              text,
              images,
              model: session.model || custom.model,
              effort: session.effort,
              cwd,
              mode: session.mode,
              sandbox: session.sandbox,
              preface,
              // A custom bot has no session of its own, so the conversation
              // has to travel with every request. This used to be [] — which
              // is why Kimi and MiniMax answered each message as if it were
              // the first. Text only; see custom-history for why.
              history: customChatHistory(session.messages),
              mcpServers: runtimeMcpServers,
              securityPolicy: session.securityPolicy,
              permissionGrants: session.permissionGrants,
              folders: projectFolderPaths(project, folderExists),
              parentId: session.parentId,
              hidden: session.hidden,
              role,
              crewModes: session.crewModes,
              customBotId: session.customBotId ?? ("id" in custom ? custom.id : undefined),
              config: {
                baseUrl: custom.baseUrl,
                apiKey: custom.apiKey,
                model: session.model || custom.model,
                api: custom.api,
                inputs: routingProfileForModel(
                  "custom",
                  session.model || custom.model,
                  "routingProfile" in custom ? custom.routingProfile : undefined,
                ).inputs,
              },
            });
            return typeof result?.text === "string" ? result.text.trim() : "";
          }
          if (live === "claude") {
            if (!window.workhorse?.claudePrompt) throw new Error("Claude agent runs in the Workhorse desktop window.");
            const result = await window.workhorse.claudePrompt(promptInput);
            return typeof result?.text === "string" ? result.text.trim() : "";
          }
          if (live === "codex") {
            if (!window.workhorse?.codexPrompt) throw new Error("Codex agent runs in the Workhorse desktop window.");
            const result = await window.workhorse.codexPrompt(promptInput);
            return typeof result?.text === "string" ? result.text.trim() : "";
          }
          if (live === "cursor") {
            if (!window.workhorse?.cursorPrompt) throw new Error("Cursor agent runs in the Workhorse desktop window.");
            const result = await window.workhorse.cursorPrompt(promptInput);
            return typeof result?.text === "string" ? result.text.trim() : "";
          }
          if (!window.workhorse?.grokPrompt) throw new Error("Grok agent runs in the Workhorse desktop window.");
          const result = await window.workhorse.grokPrompt(promptInput);
          return typeof result?.text === "string" ? result.text.trim() : "";
        };

        try {
          const latest = stateRef.current;
          if (payload.mode === "bots") {
            const action = payload.action ?? (payload.message === "create" || payload.message === "delete" ? payload.message : "list");
            if (action === "list") {
              const catalog = deskCallCatalog({
                settings: latest.settings,
                usage: latest.usage,
                plans: plansRef.current,
                permits: latest.watchPermits,
                dayMarks: latest.watchDayMarks,
              });
              await replyAsk({ text: formatDeskRoster(catalog) });
              return;
            }
            if (action === "plan") {
              const fromId = payload.fromSessionId?.trim() || "";
              const session = latest.sessions.find((item) => item.id === fromId);
              if (!session) {
                await replyAsk({ error: "no chat to attach this plan to" });
                return;
              }
              const operation = payload.planOperation ?? "view";
              let nextPlan = session.planRun;
              let error = "";
              if (operation === "import") {
                nextPlan = normalizePlanRun(payload.planRun);
                if (!nextPlan) error = "invalid plan";
              } else if (!nextPlan) {
                error = "this chat has no executable plan";
              } else {
                const now = Date.now();
                const transition = operation === "approve"
                  ? approvePlanRun(nextPlan, now)
                  : operation === "start"
                    ? startPlanRun(nextPlan, now)
                    : operation === "pause"
                      ? pausePlanRun(nextPlan, now)
                    : operation === "resume"
                        ? resumePlanRun(nextPlan, now)
                        : operation === "revise"
                          ? revisePlanStep(nextPlan, payload.planStepId ?? "", {
                              ...(payload.planTitle !== undefined ? { title: payload.planTitle } : {}),
                              ...(payload.planDetails !== undefined ? { details: payload.planDetails } : {}),
                              ...(payload.planDependsOn !== undefined ? { dependsOn: payload.planDependsOn } : {}),
                              ...(payload.planEvidenceRequired !== undefined ? { evidenceRequired: payload.planEvidenceRequired } : {}),
                            }, now)
                        : operation === "reopen"
                          ? reopenPlanStep(nextPlan, payload.planStepId ?? "", payload.evidenceValue ?? "", now)
                        : operation === "complete"
                          ? completePlanRun(nextPlan, now)
                          : operation === "block"
                            ? blockPlanRun(nextPlan, payload.evidenceValue ?? "", now)
                            : operation === "cancel"
                              ? cancelPlanRun(nextPlan, now)
                              : operation === "status"
                                ? setPlanStepStatus(
                                    nextPlan,
                                    payload.planStepId ?? "",
                                    payload.stepStatus as import("./types").PlanStepStatus,
                                    { error: payload.evidenceValue, now },
                                  )
                                : operation === "evidence"
                                  ? recordPlanEvidence(
                                      nextPlan,
                                      payload.planStepId ?? "",
                                      {
                                        id: uid("evidence"),
                                        kind: (payload.evidenceKind ?? "note") as import("./types").PlanEvidenceKind,
                                        label: payload.evidenceLabel ?? "Evidence",
                                        value: payload.evidenceValue ?? "",
                                        recordedAt: now,
                                        sessionId: fromId,
                                      },
                                      now,
                                    )
                                  : { ok: true as const, plan: nextPlan };
                if (transition.ok) {
                  const logged = operation === "view"
                    ? transition
                    : recordPlanEvent(transition.plan, {
                        type: `plan.${operation}`,
                        ...(payload.planStepId ? { stepId: payload.planStepId } : {}),
                        sessionId: fromId,
                      }, now);
                  nextPlan = logged.ok ? logged.plan : transition.plan;
                } else {
                  error = transition.error;
                }
              }
              if (error || !nextPlan) {
                await replyAsk({ error: error || "plan failed" });
                return;
              }
              if (operation !== "view") {
                setState((current) => ({
                  ...current,
                  sessions: current.sessions.map((item) => item.id === fromId ? { ...item, planRun: nextPlan } : item),
                }));
              }
              await replyAsk({
                text: JSON.stringify({
                  id: nextPlan.id,
                  objective: nextPlan.objective,
                  status: nextPlan.status,
                  revision: nextPlan.revision,
                  source: nextPlan.source,
                  constraints: nextPlan.constraints,
                  ready: readyPlanStepIds(nextPlan),
                  steps: nextPlan.steps.map((step) => ({
                    id: step.id,
                    title: step.title,
                    status: step.status,
                    dependsOn: step.dependsOn,
                    evidenceRequired: step.evidenceRequired,
                    assignedSessionId: step.assignedSessionId,
                    assignment: step.assignment,
                    evidence: step.evidence.length,
                  })),
                }, null, 2),
              });
              return;
            }
            if (action === "list-projects") {
              const projects = latest.projects.map((item) => ({
                id: item.id,
                name: item.name,
                folders: projectFolderPaths(item, folderExists),
                chats: latest.sessions.filter((session) => session.projectId === item.id && !session.archivedAt).length,
              }));
              await replyAsk({
                text: JSON.stringify(
                  {
                    source: "live",
                    projects,
                    summary:
                      projects.length === 0
                        ? "No Workhorse projects on this desk yet."
                        : `Visible sidebar names: ${projects.map((row) => row.name).join(", ")}.\n${projects.map((row) => `- ${row.name}${row.folders[0] ? ` · ${row.folders[0]}` : ""} · ${row.chats} chats`).join("\n")}`,
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "create-project") {
              const name = (payload.name || payload.message || "").trim() || "Untitled";
              const folder = (payload.folder || payload.chat || "").trim();
              const fromId = payload.fromSessionId?.trim() || "";
              const applied = applyCreateWorkhorseProject(latest.projects, latest.sessions, {
                name,
                folder: folder || undefined,
                fromSessionId: fromId,
              });
              const result = applied.result;
              const nextActive = applied.activeSessionId ?? latest.activeSessionId;
              setState((current) => ({
                ...current,
                projects: applied.projects,
                sessions: applied.sessions,
                activeProjectId: applied.activeProjectId,
                activeSessionId: nextActive,
                panel: null,
                sheet: null,
              }));
              const projects = applied.projects.map((item) => ({
                id: item.id,
                name: item.name,
                folders: projectFolderPaths(item, folderExists),
                chats: applied.sessions.filter((session) => session.projectId === item.id && !("archivedAt" in session && session.archivedAt)).length,
              }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  projects: applied.projects,
                  sessions: listedChats(applied.sessions),
                  activeProjectId: applied.activeProjectId,
                  activeSessionId: nextActive,
                })
                .catch(() => undefined);
              await replyAsk({
                text: JSON.stringify(
                  {
                    ok: true,
                    source: "live",
                    alreadyExists: result?.alreadyExists,
                    projectId: result?.projectId,
                    name: result?.name ?? name,
                    folder: result?.folder ?? (folder || null),
                    folders: result?.folders ?? [],
                    movedThisChat: Boolean(result?.movedThisChat),
                    projects,
                    howToUse: `Project “${result?.name ?? name}” is under Projects.${
                      result?.folder ? ` Linked folder: ${result.folder}.` : ""
                    }${result?.movedThisChat ? " This chat is in that project." : ""} Live desk now has: ${projects.map((row) => row.name).join(", ") || "(none)"}.`,
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "move-chat") {
              const projectQuery = (payload.name || payload.message || "").trim();
              const project = findProjectByQuery(latest.projects, projectQuery);
              if (!project) {
                await replyAsk({ error: projectQuery ? `No project matches “${projectQuery}”` : "project is required" });
                return;
              }
              const chatQuery = (payload.chat || "").trim();
              const fromId = payload.fromSessionId?.trim() || "";
              let session = fromId ? latest.sessions.find((item) => item.id === fromId) : undefined;
              if (chatQuery) {
                const hit = resolveListedChat(latest.sessions, chatQuery);
                if (!hit.ok) {
                  await replyAsk({ error: hit.error });
                  return;
                }
                session = hit.session;
              }
              if (!session || session.archivedAt) {
                await replyAsk({
                  error: chatQuery ? `No chat matches “${chatQuery}”` : "No chat is selected to move.",
                });
                return;
              }
              if (session.projectId === project.id) {
                await replyAsk({
                  text: JSON.stringify(
                    {
                      ok: true,
                      already: true,
                      chat: session.title,
                      project: project.name,
                      projectId: project.id,
                      howToUse: `Chat “${session.title}” is already in project “${project.name}”.`,
                    },
                    null,
                    2,
                  ),
                });
                return;
              }
              const sessions = moveChat(latest.sessions, session.id, project.id);
              if (!sessions) {
                await replyAsk({ error: "Could not move that chat." });
                return;
              }
              setState((current) => ({
                ...current,
                sessions,
                activeProjectId: project.id,
                activeSessionId: session.id,
                panel: null,
              }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  sessions: listedChats(sessions),
                  activeProjectId: project.id,
                  activeSessionId: session.id,
                })
                .catch(() => undefined);
              await replyAsk({
                text: JSON.stringify(
                  {
                    ok: true,
                    moved: session.title,
                    project: project.name,
                    projectId: project.id,
                    howToUse: `Chat “${session.title}” is now in project “${project.name}”.`,
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "rename-chat") {
              const applied = applyRenameDeskChat(latest.sessions, {
                name: (payload.name || payload.message || "").trim(),
                chat: (payload.chat || "").trim(),
                fromSessionId: payload.fromSessionId,
              });
              if (!applied.ok) {
                await replyAsk({ error: applied.error });
                return;
              }
              setState((current) => ({ ...current, sessions: applied.sessions }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  sessions: listedChats(applied.sessions),
                })
                .catch(() => undefined);
              const chatTitles = applied.sessions
                .filter((item) => typeof item.archivedAt !== "number")
                .map((item) => item.title);
              const chatVisible = chatTitles.some(
                (title) => title.trim().toLowerCase() === applied.renamed.title.trim().toLowerCase(),
              );
              await replyAsk({
                text: JSON.stringify(
                  {
                    ok: chatVisible,
                    source: "live",
                    previous: applied.previous,
                    name: applied.renamed.title,
                    visibleOnDesk: chatVisible,
                    chats: chatTitles,
                    howToUse: chatVisible
                      ? `Live desk chat titles now include “${applied.renamed.title}”. Quote those titles only.`
                      : `Rename did not take. Live desk chats: ${chatTitles.join(", ") || "(none)"}. Do not tell the user it is named “${(payload.name || payload.message || "").trim()}”.`,
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "rename-project") {
              const from = latest.sessions.find((item) => item.id === payload.fromSessionId);
              const requested = (payload.name || payload.message || "").trim();
              const applied = applyRenameDeskProject(latest.projects, {
                name: requested,
                project: (payload.folder || payload.bot || "").trim(),
                fromProjectId: from?.projectId ?? latest.activeProjectId ?? undefined,
              });
              if (!applied.ok) {
                await replyAsk({ error: applied.error });
                return;
              }
              setState((current) => ({ ...current, projects: applied.projects }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  projects: applied.projects,
                })
                .catch(() => undefined);
              const names = visibleProjectNames(applied.projects);
              const visibleOnDesk = renameTookOnDesk(applied.projects, requested);
              await replyAsk({
                text: JSON.stringify(
                  {
                    ok: visibleOnDesk,
                    source: "live",
                    previous: applied.previous,
                    name: applied.renamed.name,
                    requested,
                    projectId: applied.renamed.id,
                    visibleOnDesk,
                    projects: applied.projects.map((item) => ({
                      id: item.id,
                      name: item.name,
                      folders: projectFolderPaths(item, folderExists),
                    })),
                    howToUse: visibleOnDesk
                      ? `Visible sidebar names: ${names.join(", ")}. The project is named “${applied.renamed.name}”. Call workhorse_list_projects and only repeat that if the list still shows it.`
                      : `Rename did not take. Visible sidebar names: ${names.join(", ") || "(none)"}. Do not tell the user it is named “${requested}”.`,
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "delete-chat") {
              if (
                isLooseDeleteScope({
                  scope: payload.scope,
                  chat: payload.chat || payload.name,
                  chats: payload.chats,
                })
              ) {
                const applied = applyDeleteLooseDeskChats(latest.sessions, {
                  fromSessionId: payload.fromSessionId,
                });
                if (!applied.ok) {
                  await replyAsk({ error: applied.error });
                  return;
                }
                const sessions = applied.sessions;
                stopDeletedWorkerSessions(latest.sessions, sessions);
                const leases = releaseDeletedSessionLeases(latest.leases ?? [], latest.sessions, sessions);
                pathLeasesRef.current = leases;
                const gone = new Set(
                  latest.sessions.filter((item) => !sessions.some((row) => row.id === item.id)).map((item) => item.id),
                );
                setState((current) => ({
                  ...current,
                  sessions,
                  leases,
                  pending: current.pending.filter((item) => !gone.has(item.sessionId)),
                }));
                void window.workhorse
                  ?.saveState({
                    ...latest,
                    sessions: listedChats(sessions),
                    leases,
                    activeSessionId: latest.activeSessionId,
                  })
                  .catch(() => undefined);
                await replyAsk({
                  text: JSON.stringify(
                    {
                      ok: true,
                      scope: "loose",
                      deleted: applied.deleted.map((item) => item.title),
                      kept: applied.kept?.title ?? null,
                      howToUse:
                        applied.deleted.length > 0
                          ? `Deleted ${applied.deleted.length} loose chat(s). This chat was kept. Chats in a project were not touched.`
                          : "No other loose chats to delete. This chat was kept.",
                    },
                    null,
                    2,
                  ),
                });
                return;
              }
              const applied = applyDeleteDeskChat(latest.sessions, {
                chat: (payload.chat || payload.name || "").trim(),
                fromSessionId: payload.fromSessionId,
                onlyThis: payload.onlyThis === true,
              });
              if (!applied.ok) {
                await replyAsk({ error: applied.error });
                return;
              }
              const sessions = applied.sessions;
              const session = applied.deleted;
              stopDeletedWorkerSessions(latest.sessions, sessions);
              const leases = releaseDeletedSessionLeases(latest.leases ?? [], latest.sessions, sessions);
              pathLeasesRef.current = leases;
              const gone = new Set(
                latest.sessions.filter((item) => !sessions.some((row) => row.id === item.id)).map((item) => item.id),
              );
              setState((current) => ({
                ...current,
                sessions,
                leases,
                pending: current.pending.filter((item) => !gone.has(item.sessionId)),
                activeSessionId: current.activeSessionId && gone.has(current.activeSessionId) ? null : current.activeSessionId,
              }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  sessions: listedChats(sessions),
                  leases,
                  activeSessionId:
                    latest.activeSessionId && gone.has(latest.activeSessionId) ? null : latest.activeSessionId,
                })
                .catch(() => undefined);
              await replyAsk({
                text: JSON.stringify(
                  {
                    ok: true,
                    deleted: session.title,
                    howToUse: `Chat “${session.title}” was deleted.`,
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "delete-project") {
              const projectQuery = (payload.name || payload.message || "").trim();
              const project = findProjectByQuery(latest.projects, projectQuery);
              if (!project) {
                await replyAsk({ error: projectQuery ? `No project matches “${projectQuery}”` : "project is required" });
                return;
              }
              const fate: "keep" | "remove" = payload.chats === "remove" ? "remove" : "keep";
              const projects = applyDeleteProject(latest.projects, project.id);
              if (!projects) {
                await replyAsk({ error: "Could not delete that project." });
                return;
              }
              const sessions = applyProjectChatFate(latest.sessions, project.id, fate);
              stopDeletedWorkerSessions(latest.sessions, sessions);
              const leases = releaseDeletedSessionLeases(latest.leases ?? [], latest.sessions, sessions);
              pathLeasesRef.current = leases;
              const gone = new Set(
                latest.sessions.filter((item) => !sessions.some((row) => row.id === item.id)).map((item) => item.id),
              );
              const nextActiveProject = latest.activeProjectId === project.id ? null : latest.activeProjectId;
              const nextActiveSession =
                latest.activeSessionId && gone.has(latest.activeSessionId) ? null : latest.activeSessionId;
              setState((current) => ({
                ...current,
                projects,
                sessions,
                leases,
                pending: current.pending.filter((item) => !gone.has(item.sessionId)),
                activeProjectId: current.activeProjectId === project.id ? null : current.activeProjectId,
                activeSessionId: current.activeSessionId && gone.has(current.activeSessionId) ? null : current.activeSessionId,
              }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  projects,
                  sessions: listedChats(sessions),
                  leases,
                  activeProjectId: nextActiveProject,
                  activeSessionId: nextActiveSession,
                })
                .catch(() => undefined);
              await replyAsk({
                text: JSON.stringify(
                  {
                    ok: true,
                    deleted: project.name,
                    chats: fate,
                    howToUse:
                      fate === "remove"
                        ? `Project “${project.name}” and its chats were deleted.`
                        : `Project “${project.name}” was deleted. Its chats are now loose.`,
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "request-permission") {
              const from =
                latest.sessions.find((item) => item.id === payload.fromSessionId) ??
                latest.sessions.find((item) => item.id === latest.activeSessionId);
              if (!from) {
                await replyAsk({ error: "No chat is selected to elevate." });
                return;
              }
              const classified = classifyElevationInput(
                {
                  permission: payload.name,
                  mode: payload.name,
                  sandbox: payload.folder,
                  reason: payload.message,
                },
                from,
              );
              if (classified.kind !== "raise" || !classified.need) {
                const downgrade = classified.kind === "downgrade";
                await replyAsk({
                  text: JSON.stringify({
                    ok: true,
                    alreadyElevated: !downgrade,
                    refusedDowngrade: downgrade,
                    mode: from.mode,
                    sandbox: from.sandbox,
                    howToUse: downgrade
                      ? "This tool only raises access. You cannot lower Permission or Sandbox from here. The user does that in This chat. Do not offer to dial limits back."
                      : "This chat already has that access. Do not offer to lower Permission or Sandbox.",
                  }),
                });
                return;
              }
              const need = classified.need;
              const requestId = uid("perm");
              elevatePeerReply.current.set(requestId, replyAsk);
              setState((current) => ({
                ...current,
                pending: enqueuePermission(current.pending, {
                  id: requestId,
                  sessionId: from.id,
                  provider: from.provider,
                  tool: "workhorse_request_permission",
                  detail: (payload.message || payload.description || "needs more access to finish the work").trim(),
                  kind: "elevate",
                  elevate: need,
                }),
                sessions: current.sessions.map((item) =>
                  item.id === from.id ? { ...item, status: "needs-input" } : item,
                ),
              }));
              return;
            }
            if (action === "request-vendor") {
              const from =
                latest.sessions.find((item) => item.id === payload.fromSessionId) ??
                latest.sessions.find((item) => item.id === latest.activeSessionId);
              if (!from) {
                await replyAsk({ error: "No chat is selected to allow a vendor." });
                return;
              }
              const catalog = deskCallCatalog({
                settings: latest.settings,
                usage: latest.usage,
                plans: latest.deskPlans ?? plansRef.current,
                permits: latest.watchPermits,
                dayMarks: latest.watchDayMarks,
              });
              const row = deskCallRowFor(catalog, {
                provider: payload.provider || payload.name,
                name: payload.chat || payload.name || payload.message,
              });
              if (!row || row.status === "not_connected") {
                await replyAsk({ error: `${row?.reason || "That vendor is not attached."} Do not wait.` });
                return;
              }
              const vendorKey = row.id.startsWith("bot:") ? row.id : row.provider;
              const sameVendor =
                from.provider === row.provider &&
                (row.provider !== "custom" || row.id === `bot:${from.customBotId ?? ""}`);
              if (
                sameVendor ||
                vendorGrantedForChat(latest.watchPermits, vendorKey, from.id) ||
                !vendorOverrideNeeded(row)
              ) {
                await replyAsk({
                  text: JSON.stringify({
                    ok: true,
                    allowed: true,
                    alreadyAllowed: true,
                    vendor: row.name,
                    howToUse: `${row.name} is already allowed for this chat. Spawn or ask it now.`,
                  }),
                });
                return;
              }
              const vendorStatus =
                row.status === "day_bank" || row.status === "spent" || row.status === "disabled" ? row.status : "ok";
              const requestId = uid("perm");
              elevatePeerReply.current.set(requestId, replyAsk);
              setState((current) => ({
                ...current,
                pending: enqueuePermission(current.pending, {
                  id: requestId,
                  sessionId: from.id,
                  provider: from.provider,
                  tool: "workhorse_request_vendor",
                  detail:
                    vendorStatus === "ok"
                      ? `${row.name} will run inside this conversation.`
                      : row.reason || `${row.name} is not callable right now.`,
                  kind: "vendor",
                  vendor: { provider: row.provider, name: row.name, status: vendorStatus },
                }),
                sessions: current.sessions.map((item) =>
                  item.id === from.id ? { ...item, status: "needs-input" } : item,
                ),
              }));
              return;
            }
            if (action === "list-references") {
              const from = latest.sessions.find((item) => item.id === payload.fromSessionId);
              const query = (payload.name || payload.chat || "").trim().toLowerCase();
              const project =
                (query
                  ? latest.projects.find(
                      (item) => item.id.toLowerCase() === query || item.name.toLowerCase() === query,
                    )
                  : undefined) ??
                latest.projects.find((item) => item.id === from?.projectId) ??
                latest.projects.find((item) => item.id === latest.activeProjectId);
              if (!project) {
                await replyAsk({ error: "No project is selected." });
                return;
              }
              await replyAsk({
                text: JSON.stringify({ projectId: project.id, name: project.name, references: project.references }, null, 2),
              });
              return;
            }
            if (action === "add-reference") {
              const value = (payload.chat || payload.message || "").trim();
              if (!value) {
                await replyAsk({ error: "Need a reference value (URL, note, or file path)." });
                return;
              }
              const kindRaw = (payload.name || "").trim().toLowerCase();
              const kind: ReferenceKind =
                kindRaw === "file" || kindRaw === "note" || kindRaw === "url"
                  ? kindRaw
                  : /^https?:\/\//i.test(value)
                    ? "url"
                    : /^[A-Za-z]:[\\/]/.test(value) || value.includes("/") || value.includes("\\")
                      ? "file"
                      : "note";
              const from = latest.sessions.find((item) => item.id === payload.fromSessionId);
              const projectQuery = (payload.bot || "").trim().toLowerCase();
              const project =
                (projectQuery
                  ? latest.projects.find(
                      (item) => item.id.toLowerCase() === projectQuery || item.name.toLowerCase() === projectQuery,
                    )
                  : undefined) ??
                latest.projects.find((item) => item.id === from?.projectId) ??
                latest.projects.find((item) => item.id === latest.activeProjectId);
              if (!project) {
                await replyAsk({ error: "No project is selected." });
                return;
              }
              const already = project.references.some(
                (item) => item.value.trim().toLowerCase() === value.toLowerCase(),
              );
              if (already) {
                await replyAsk({
                  text: JSON.stringify({ ok: true, already: true, projectId: project.id, value }, null, 2),
                });
                return;
              }
              const reference = {
                id: uid("ref"),
                kind,
                value,
                label: (payload.description || value).trim(),
              };
              setState((current) => ({
                ...current,
                projects: current.projects.map((item) =>
                  item.id === project.id ? { ...item, references: [...item.references, reference] } : item,
                ),
              }));
              await replyAsk({ text: JSON.stringify({ ok: true, projectId: project.id, reference }, null, 2) });
              return;
            }
            if (action === "delete-reference") {
              const query = (payload.bot || payload.message || "").trim().toLowerCase();
              const from = latest.sessions.find((item) => item.id === payload.fromSessionId);
              const projectQuery = (payload.name || "").trim().toLowerCase();
              const project =
                (projectQuery
                  ? latest.projects.find(
                      (item) => item.id.toLowerCase() === projectQuery || item.name.toLowerCase() === projectQuery,
                    )
                  : undefined) ??
                latest.projects.find((item) => item.id === from?.projectId) ??
                latest.projects.find((item) => item.id === latest.activeProjectId);
              if (!project) {
                await replyAsk({ error: "No project is selected." });
                return;
              }
              const removed = project.references.find(
                (item) =>
                  item.id.toLowerCase() === query ||
                  item.label.toLowerCase() === query ||
                  item.value.toLowerCase() === query,
              );
              if (!removed) {
                await replyAsk({ error: `No reference matches “${query}”` });
                return;
              }
              setState((current) => ({
                ...current,
                projects: current.projects.map((item) =>
                  item.id === project.id
                    ? { ...item, references: item.references.filter((ref) => ref.id !== removed.id) }
                    : item,
                ),
              }));
              await replyAsk({ text: JSON.stringify({ ok: true, removed }, null, 2) });
              return;
            }
            if (action === "record-write") {
              const path = (payload.chat || payload.message || "").trim();
              const sessionId =
                (payload.bot || "").trim() ||
                latest.activeSessionId ||
                latest.sessions.find((item) => item.projectId === latest.activeProjectId)?.id ||
                "";
              const hint = `${payload.name ?? ""} ${payload.scope ?? ""}`.toLowerCase();
              const title = /\bedit/.test(hint) ? "Edit" : "Write";
              if (!path || !sessionId) {
                await replyAsk({ error: "Need a file path and a project chat to record a write." });
                return;
              }
              const sessions = latest.sessions.map((session) =>
                session.id === sessionId
                  ? {
                      ...session,
                      messages: upsertToolMessage(session.messages, {
                        toolCallId: `${title.toLowerCase()}:${path}`,
                        title,
                        status: "completed",
                        detail: path,
                      }),
                    }
                  : session,
              );
              const withTakeover = recordParentTakeover(
                sessions,
                sessionId,
                `Parent applied ${title} after handing the work to Workhorse.`,
              );
              setState((current) => ({ ...current, sessions: withTakeover }));
              snapshotWriteInstance({ ...latest, sessions: withTakeover }, sessionId, title, path, `${title.toLowerCase()}:${path}`);
              void window.workhorse
                ?.saveState({
                  ...latest,
                  sessions: listedChats(withTakeover),
                })
                .catch(() => undefined);
              await replyAsk({ text: JSON.stringify({ ok: true, sessionId, path, title }, null, 2) });
              return;
            }
            if (action === "select-project") {
              const query = (payload.chat || payload.name || payload.message || "").trim().toLowerCase();
              const project =
                latest.projects.find((item) => item.id.toLowerCase() === query || item.name.toLowerCase() === query) ??
                latest.projects.find((item) => /walk test/i.test(item.name));
              if (!project) {
                await replyAsk({ error: `No project matches “${query}”` });
                return;
              }
              setState((current) => ({
                ...current,
                activeProjectId: project.id,
                activeSessionId: null,
                panel: null,
                sheet: null,
                sessions: dropDrafts(current.sessions),
                projects: current.projects.map((item) =>
                  item.id === project.id ? { ...item, openedAt: Date.now() } : item,
                ),
              }));
              const sessions = latest.sessions.filter((item) => item.projectId === project.id);
              const edits = projectEdits(
                sessions,
                project.folders.map((folder) => folder.path),
              );
              await replyAsk({
                text: JSON.stringify(
                  {
                    ok: true,
                    projectId: project.id,
                    name: project.name,
                    references: project.references,
                    edits: edits.map((item) => ({ name: item.name, path: item.path, edits: item.edits })),
                  },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "create") {
              const api: CustomLlm["api"] =
                payload.api === "openai-completions" || payload.api === "anthropic-messages"
                  ? payload.api
                  : undefined;
              const draft: CustomLlm = {
                ...EMPTY_CUSTOM_DRAFT,
                name: payload.name ?? "",
                color: payload.color,
                baseUrl: payload.baseUrl ?? "",
                model: payload.model ?? "",
                apiKey: payload.apiKey ?? "",
                api,
                contextWindow:
                  typeof payload.contextWindow === "number" && payload.contextWindow > 0
                    ? payload.contextWindow
                    : 128_000,
                tested: true,
              };
              if (!draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
                await replyAsk({ error: "Need a base URL, model, and API key to create a desk slot." });
                return;
              }
              const installed = applyInstallCustomBot(latest.settings.customBots, draft);
              setState((current) => ({
                ...current,
                settings: { ...current.settings, customBots: installed.bots },
              }));
              await replyAsk({
                text: JSON.stringify(
                  { ok: true, created: installed.created, bot: publicBotCard(installed.bot) },
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "delete") {
              const query = payload.bot ?? payload.name ?? "";
              const removed = applyDeleteCustomBot(latest.settings.customBots, query);
              if (!removed.removed) {
                await replyAsk({ error: `No custom bot matches “${query}”` });
                return;
              }
              setState((current) => ({
                ...current,
                settings: { ...current.settings, customBots: removed.bots },
                sessions: current.sessions.map((session) =>
                  session.customBotId === removed.removed?.id ? { ...session, customBotId: undefined } : session,
                ),
              }));
              await replyAsk({
                text: JSON.stringify({ ok: true, removed: publicBotCard(removed.removed) }, null, 2),
              });
              return;
            }
            if (action === "list-agents") {
              const catalog = deskCallCatalog({
                settings: latest.settings,
                usage: latest.usage,
                plans: latest.deskPlans ?? plansRef.current,
                permits: latest.watchPermits,
                dayMarks: latest.watchDayMarks,
              });
              await replyAsk({
                text: JSON.stringify(
                  catalog.map((row) => ({
                    id: row.id,
                    name: row.name,
                    provider: row.provider,
                    canCall: row.canCall,
                  })),
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "list-external-agents") {
              await replyAsk({
                text: JSON.stringify(
                  projectExternalAgentCatalog({
                    agents: agentCatalogRef.current,
                    runtimes: agentRuntimesRef.current,
                  }),
                  null,
                  2,
                ),
              });
              return;
            }
            if (action === "agent-status") {
              const id = (payload.name || payload.message || "").trim();
              const worker = latest.sessions.find((session) => session.id === id && Boolean(session.parentId));
              if (worker) {
                const parentId = payload.fromSessionId?.trim() || "";
                const allowed = !parentId || descendantSessionIds(latest.sessions, parentId).includes(worker.id);
                if (!allowed) {
                  await replyAsk({ error: "unknown" });
                  return;
                }
                await replyAsk({
                  text: JSON.stringify(workerStatusSnapshot(worker), null, 2),
                });
                return;
              }
              const task = normalizeTaskStore(latest.externalTasks).byId[id];
              if (!task) {
                await replyAsk({ error: "unknown" });
                return;
              }
              await replyAsk({ text: JSON.stringify({ ...task, status: task.status }, null, 2) });
              return;
            }
            if (action === "cancel-agent") {
              const id = (payload.name || payload.message || "").trim();
              if (!id) {
                await replyAsk({ error: "unknown" });
                return;
              }
              // Workhorse worker sessions live in `state.sessions`; external
              // agent runs (OpenClaw / Hermes) live in `externalTasks`. A cancel
              // must cover BOTH, must actually stop the vendor run, must be
              // idempotent on a second call, and must preserve partial results
              // (messages, reports, changed files).
              const worker = latest.sessions.find(
                (session) => session.id === id && Boolean(session.parentId),
              );
              if (worker) {
                const parentId = payload.fromSessionId?.trim() || "";
                const allowed =
                  !parentId ||
                  worker.id === parentId ||
                  descendantSessionIds(latest.sessions, parentId).includes(worker.id);
                if (!allowed) {
                  await replyAsk({ error: "unknown" });
                  return;
                }
                // Idempotent: a worker already in a terminal state keeps its
                // finishedAt and is returned unchanged. The vendor is not
                // poked again, so a second cancel is a no-op.
                const existing = worker.agentRun;
                if (existing && existing.status !== "running") {
                  if (existing.status === "interrupted") {
                    // An interrupted row is uncertain, so restart retains its
                    // lease. Explicit cancel is the acknowledgement that this
                    // owner must not resume: make a best-effort vendor stop,
                    // then release only this worker's paths.
                    cancelVendorSession(worker);
                    setState((currentState) => {
                      const leases = releaseCancelledSessionLeases(
                        currentState.leases ?? [],
                        worker.id,
                        existing.status,
                      );
                      pathLeasesRef.current = leases;
                      return { ...currentState, leases };
                    });
                  }
                  const settled = stateRef.current.sessions.find((session) => session.id === worker.id) ?? worker;
                  await replyAsk({ text: JSON.stringify(workerStatusSnapshot(settled), null, 2) });
                  return;
                }
                if (existing && existing.status === "running") {
                  cancelVendorSession(worker);
                }
                const finishedAt = Date.now();
                // The transition itself is pure and lives in subagents so it can
                // be tested without a desk. Authorising the caller and stopping
                // the vendor stay here, because both are side effects. The
                // lineup row has to move to cancelled in the same tick, or the
                // parent keeps saying Working… / 1 failed until the vendor dies.
                setState((currentState) => {
                  const cancelled = applyCancelWorker(currentState.sessions, worker.id, finishedAt);
                  const sessions = applyChildIdleSync(cancelled.sessions, worker.id, "cancelled", {
                    now: finishedAt,
                    report: childReportText(cancelled.worker),
                    error: cancelled.worker?.agentRun?.error,
                    correlationId: cancelled.worker?.agentRun?.correlationId,
                  });
                  const leases = releaseCancelledSessionLeases(
                    currentState.leases ?? [],
                    worker.id,
                    existing?.status,
                  );
                  pathLeasesRef.current = leases;
                  return { ...currentState, sessions, leases };
                });
                const settled = stateRef.current.sessions.find((session) => session.id === worker.id);
                if (!settled) {
                  await replyAsk({ error: "unknown" });
                  return;
                }
                await replyAsk({ text: JSON.stringify(workerStatusSnapshot(settled), null, 2) });
                return;
              }
              const store = normalizeTaskStore(latest.externalTasks);
              const task = store.byId[id];
              if (!task) {
                await replyAsk({ error: "unknown" });
                return;
              }
              // Idempotent on external tasks too: a second cancel returns the
              // existing terminal state without rewriting finishedAt, and
              // without asking the runtime to stop something already stopped.
              if (
                task.status === "cancelled" ||
                task.status === "completed" ||
                task.status === "failed" ||
                task.status === "unknown"
              ) {
                await replyAsk({ text: JSON.stringify(task, null, 2) });
                return;
              }
              await window.workhorse?.cancelExternalRuntimeTask?.(id);
              const cancelledTask: ExternalTask = {
                ...task,
                status: "cancelled",
                finishedAt: task.finishedAt ?? Date.now(),
              };
              const next = {
                ...store,
                byId: { ...store.byId, [id]: cancelledTask },
              };
              setState((current) => ({ ...current, externalTasks: next }));
              await replyAsk({ text: JSON.stringify(cancelledTask, null, 2) });
              return;
            }
            if (action === "await-agents") {
              const parentId = payload.fromSessionId?.trim() || "";
              if (!parentId) {
                await replyAsk({ error: "no parent chat to wait on" });
                return;
              }
              const parentLive = stateRef.current.sessions.find((item) => item.id === parentId);
              const requestedWorkerIds = Array.isArray(payload.workerIds)
                ? [...new Set(payload.workerIds.map((id) => id.trim()).filter(Boolean))]
                : [];
              const waveIds = scopedChildAgentIds(stateRef.current.sessions, parentId, {
                workerIds: requestedWorkerIds,
                traceId: payload.traceId,
                lineupChildIds: parentLive?.lineup?.rows.map((row) => row.childId),
              });
              if (requestedWorkerIds.length > 0 && waveIds.length !== requestedWorkerIds.length) {
                await replyAsk({ error: "unknown worker in this parent chat" });
                return;
              }
              if (requestedWorkerIds.length === 0 && payload.traceId?.trim() && waveIds.length === 0) {
                await replyAsk({ error: "unknown worker trace in this parent chat" });
                return;
              }
              const waveIdSet = new Set(waveIds);
              const shouldWait = awaitAgentsWaits({ wait: payload.wait, parentStatus: parentLive?.status });
              if (shouldWait) {
                // Cursor-based long poll. The desk owns joining, so the
                // server-side wait is short even when the parent asked us to
                // sit. Anything longer belongs on a desk-driven wake-up.
                const cursorSeconds =
                  typeof payload.timeoutSeconds === "number"
                    ? Math.max(5, Math.min(30, payload.timeoutSeconds))
                    : 15;
                const timeoutMs = cursorSeconds * 1_000;
                const deadline = Date.now() + timeoutMs;
                while (parentHasRunningChildren(stateRef.current.sessions, parentId, waveIdSet) && Date.now() < deadline) {
                  await new Promise((resolve) => setTimeout(resolve, 400));
                }
              }
              setState((current) => {
                let sessions = reconcileIdleChildren(current.sessions, parentId);
                // The reports go back to the orchestrator in this result, so it
                // joins them itself. Queueing the desk's join as well produced
                // the same combined review twice, a minute apart.
                sessions = handOverLineup(sessions, parentId);
                return sessions === current.sessions ? current : { ...current, sessions };
              });
              const parentNow = stateRef.current.sessions.find((item) => item.id === parentId);
              const reports = collectChildAgentReports(stateRef.current.sessions, parentId, waveIdSet);
              const scopedLineup = parentNow?.lineup
                ? { ...parentNow.lineup, rows: parentNow.lineup.rows.filter((row) => waveIdSet.has(row.childId)) }
                : undefined;
              await replyAsk({
                text: formatAwaitAgentsSnapshot({
                  lineup: scopedLineup,
                  reports,
                  wait: shouldWait,
                }),
              });
              return;
            }
            await replyAsk({ error: `Unknown bots action ${action}` });
            return;
          }
          const exposure = mcpExposureProfile(payload.exposureProfile);
          const runningVisible = latest.sessions.find((item) => item.status === "running" && !isHiddenSession(item));
          const openChat =
            latest.sessions.find((item) => item.id === latest.activeSessionId && !isHiddenSession(item)) ??
            runningVisible;
          const inboundSessionId = latest.settings.agentSystems?.inboundSessionId;
          const inboundProjectId = latest.settings.agentSystems?.inboundProjectId;
          if (payload.mode === "spawn" && (payload.fromSessionId || inboundSessionId)) {
            const parentHit = inboundSpawnParent({
              profile: exposure,
              fromSessionId: payload.fromSessionId,
              defaultSessionId: inboundSessionId,
              runningVisibleSessionId: exposure === "external-runtime" ? undefined : openChat?.id,
            });
            if ("code" in parentHit) {
              await replyAsk({ error: "context_required" });
              return;
            }
          }
          // A chat the call named, or the one Settings pins as the inbound
          // parent. Only these lend their Permission and Sandbox onward.
          const namedCaller =
            latest.sessions.find((item) => item.id === payload.fromSessionId) ??
            latest.sessions.find((item) => item.id === inboundSessionId);
          // The visible chat still receives the work, so one inbox stays. It is
          // not where the access comes from: a call that named no parent must
          // not inherit whatever the person happens to have open, which is how
          // an unrelated tightened chat used to decide an inbound worker.
          let caller =
            namedCaller ?? (exposure === "external-runtime" ? undefined : openChat);
          const deskSeat = inboundAccess({
            desk: latest.settings.access,
            vendor:
              caller && caller.provider !== "custom"
                ? latest.settings.llms[caller.provider].accessDefaults
                : undefined,
          });
          const inboundSeat: DeskAccess = namedCaller
            ? { mode: namedCaller.mode, sandbox: namedCaller.sandbox }
            : deskSeat;
          let inboundHost: Session | undefined;
          if (payload.mode === "spawn" && !caller && exposure === "external-runtime") {
            const remembered = firstAttachedChoice(latest.settings, latest.lastModel);
            if (!remembered) {
              await replyAsk({ error: "context_required" });
              return;
            }
            const project = inboundProjectId
              ? latest.projects.find((item) => item.id === inboundProjectId) ?? null
              : null;
            const title = titleFromIntent(payload.description?.trim() || payload.message.trim());
            const opened = openDraft(latest.sessions, {
              id: uid("sess"),
              projectId: project?.id ?? null,
              provider: remembered.provider,
              model: remembered.model,
              customBotId: remembered.customBotId,
              effort: withEffort(remembered.provider, remembered.model, remembered.effort),
              title,
              titleLocked: false,
              // No chat was named, so this host stands in for the desk and
              // takes the desk's stored default, narrowed by the vendor app's
              // own recorded config. Never the visible chat's setting.
              ...inboundAccess({
                desk: latest.settings.access,
                vendor:
                  remembered.provider === "custom"
                    ? undefined
                    : latest.settings.llms[remembered.provider].accessDefaults,
              }),
              environment: { kind: "local" },
              securityPolicy: { network: "allowed", root: "allowed" },
              status: "idle",
              contextUsed: 0,
              messages: [],
              routingMode: "manual",
            });
            inboundHost = { ...opened.session, title, titleLocked: false };
            caller = inboundHost;
          }
          const parent = caller;
          // A chat the call named, and the desk's own inbound host, both lend
          // their access down. A chat that merely happens to be open does not:
          // the desk default answers for a call that named no parent.
          const inheritedAccess: DeskAccess =
            (namedCaller ?? inboundHost) && parent
              ? { mode: parent.mode, sandbox: parent.sandbox }
              : inboundSeat;
          if (payload.mode === "spawn") {
            if (!caller) {
              await replyAsk({ error: exposure === "external-runtime" ? "context_required" : "no parent chat to attach this subagent to" });
              return;
            }
            const suppliedMission = normalizeMissionIteration(payload.missionIteration ?? caller.agentRun?.mission);
            const requestedMission = suppliedMission;
            const lineupMission = caller.lineup?.mission;
            const deskMission = deskMissionForStoreSpawn({
              sessions: latest.sessions,
              parentId: caller.id,
              requested: requestedMission,
              lineup: lineupMission,
              agentRun: caller.agentRun?.mission,
              liveContinuation: payload.missionContinuation,
            });
            const gate = campaignSpawnGate({
              campaignContext: Boolean(payload.missionIteration || lineupMission || caller.agentRun?.mission),
              requested: requestedMission,
              desk: deskMission,
            });
            const spawnMission = gate.mission;
            if (gate.error) {
              await replyAsk({ error: gate.error });
              return;
            }
            if (spawnMission) {
              const mission = spawnMission;
              const existingPass = latest.sessions.find(
                (session) =>
                  session.parentId === caller.id &&
                  session.agentRun?.mission?.id === mission.id &&
                  session.agentRun?.mission?.iteration === mission.iteration,
              );
              if (existingPass) {
                await replyAsk({ text: JSON.stringify(workerStatusSnapshot(existingPass), null, 2) });
                return;
              }
            }
            if (exposure === "external-runtime") {
              const inboundHop = acceptInboundEnvelope({
                stored: envelopeForTrace(normalizeTaskStore(latest.externalTasks), payload.traceId),
                claimed: {
                  hopCount: payload.hopCount,
                  visitedSystems: payload.visitedSystems,
                  traceId: payload.traceId,
                  idempotencyKey: payload.idempotencyKey,
                },
                caller: payload.origin === "hermes" ? "hermes" : "openclaw",
              });
              if (!inboundHop.ok) {
                await replyAsk({ error: inboundHop.code });
                return;
              }
              const gate = inboundDeskAction({
                profile: exposure,
                tool: "workhorse_spawn_agent",
                spawnProvider: typeof payload.provider === "string" ? payload.provider : payload.chat,
                fromSessionId: caller.id,
              });
              if (!gate.ok) {
                await replyAsk({ error: gate.code });
                return;
              }
            }
            const dispatch = decideDispatch({
              namedProvider: payload.provider,
              namedModel: payload.model,
              namedChat: payload.chat,
              namedExternal: parseExternalAgentRef(payload.provider) ?? parseExternalAgentRef(payload.chat),
              routing: latest.settings.routing,
              grant: caller.planRun?.externalGrant,
              externalCandidates: allowedExternalCandidates(
                latest.settings.agentSystems?.allowedAgents,
                agentCatalogRef.current,
              ),
            });
            if (exposure !== "external-runtime" && dispatch.kind === "external-agent") {
              const taskStore = normalizeTaskStore(latest.externalTasks) || emptyTaskStore();
              const storedEnvelope = envelopeForTrace(taskStore, payload.traceId);
              const started = await launchExternalAssignment({
                profile: exposure,
                explicitTarget: formatExternalAgentRef({ runtimeId: dispatch.runtimeId, agentId: dispatch.agentId }),
                grant: caller.planRun?.externalGrant,
                routing: latest.settings.routing,
                prompt: payload.message,
                fromSessionId: caller.id,
                workspace: sessionExecutionCwd(
                  caller.environment,
                  (() => {
                    const project = latest.projects.find((item) => item.id === caller.projectId);
                    return project ? primaryFolder(project, folderExists)?.path ?? "" : "";
                  })(),
                ),
                store: taskStore,
                envelope: storedEnvelope ?? {
                  origin: "workhorse",
                  visitedSystems: ["workhorse"],
                  hopCount: 0,
                  traceId: payload.traceId,
                  idempotencyKey: payload.idempotencyKey,
                },
                startRuntime: (request) =>
                  window.workhorse?.startExternalRuntimeTask?.(request) ?? Promise.resolve(null),
                onStarted: (running) => {
                  setState((current) => ({
                    ...current,
                    externalTasks: running.store,
                    sessions: current.sessions.map((session) =>
                      session.id === caller.id
                        ? {
                            ...session,
                            lineup: addLineupRow(session.lineup, running.row, undefined, spawnMission),
                            ...(running.grant ? { planRun: session.planRun ? { ...session.planRun, externalGrant: running.grant } : session.planRun } : {}),
                          }
                        : session,
                    ),
                  }));
                },
              });
              if (!started.ok) {
                await replyAsk({ error: started.code });
                return;
              }
              setState((current) => ({
                ...current,
                externalTasks: started.store,
                sessions: current.sessions.map((session) =>
                  session.id === caller.id
                    ? {
                        ...session,
                        lineup: setLineupRowStatus(session.lineup, started.task.id, started.row.status, {
                          report: started.task.result,
                          finishedAt: started.task.finishedAt,
                          correlationId: started.task.envelope.traceId,
                        }) ?? addLineupRow(session.lineup, started.row, undefined, spawnMission),
                        ...(started.grant ? { planRun: session.planRun ? { ...session.planRun, externalGrant: started.grant } : session.planRun } : {}),
                      }
                    : session,
                ),
              }));
              await replyAsk({ text: JSON.stringify(started.run, null, 2) });
              return;
            }
            const boundProject = projectForSpawn(latest.projects, caller.projectId, payload.folder);
            const spawnProjectId = boundProject?.id ?? null;
            const isNested = deskRoleOf(caller) === "worker";
            const catalog = deskCallCatalog({
              settings: latest.settings,
              usage: latest.usage,
              plans: latest.deskPlans ?? plansRef.current,
              permits: latest.watchPermits,
              dayMarks: latest.watchDayMarks,
            });
            if (isNested) {
              const blocked = nestedSpawnError(latest.sessions, caller.id);
              if (blocked) {
                await replyAsk({ error: blocked });
                return;
              }
            } else {
              // One worker per bot on the desk: the lineup the skill asks for.
              const blocked = rootSpawnError(latest.sessions, caller.id, maxRootWorkers(catalog.length));
              if (blocked) {
                await replyAsk({ error: blocked });
                return;
              }
            }
            const routeTier = payload.route === "quick" || payload.route === "balanced" || payload.route === "deep"
              ? payload.route
              : undefined;
            const effectiveExclusions = spawnExclusions(caller, payload.exclude, isNested);
            const routeSpawn = shouldAutoRouteSpawn({
              routingEnabled: latest.settings.routing.enabled,
              provider: payload.provider,
              model: payload.model,
              chat: payload.chat,
            });
            const routeStatuses = routeSpawn
              ? watchVendorStatuses({
                  settings: latest.settings,
                  usage: latest.usage,
                  plans: latest.deskPlans ?? plansRef.current,
                  permits: latest.watchPermits,
                  dayMarks: latest.watchDayMarks,
                })
              : [];
            const projectFolder = primaryFolder(boundProject, folderExists)?.path ?? "";
            const nestedPolicy = nestedWorkerPolicy({
              nested: isNested,
              parentEnvironment: caller.environment,
              projectFolder,
            });
            const spawnRole = nestedPolicy.role ??
              (payload.role === "auditor" ? "auditor" as const : routeSpawn ? "worker" as const : undefined);
            const routingRole = spawnRole === "helper" ? "worker" as const : spawnRole;
            const routeRequest = {
              prompt: payload.message,
              attachments: payload.attachments,
              tier: routeTier ?? (isNested ? "quick" as const : undefined),
              role: routingRole,
              outcomes: outcomesFromLearningEvents(learningOutcomeEvents),
              exclude: effectiveExclusions,
            };
            const routeCandidates = routeSpawn
              ? constrainRouteCandidatesForSpawn(
                  routingCandidatesForDesk(latest.settings, routeStatuses, latest.deskPlans ?? plansRef.current),
                  { provider: payload.provider },
                )
              : [];
            const routeDecision = routeSpawn
              ? chooseRoutingDecision(routeCandidates, routeRequest, latest.settings.routing)
              : null;
            if (routeSpawn && !routeDecision) {
              await replyAsk({
                error: `no capable route: ${describeRoutingMiss(routeCandidates, routeRequest, latest.settings.routing)}`,
              });
              return;
            }
            const spawnProvider = routeDecision?.provider ?? payload.provider;
            const spawnModel = routeDecision?.model ?? payload.model;
            const selectedTier =
              routeDecision?.taskTier ??
              routeTier ??
              inferRoutingTier(payload.message, payload.attachments, {
                role: routingRole,
              });
            const requestedEffort = parseEffort(String(payload.effort ?? ""));
            const spawnTimeoutSeconds = isNested
              ? Math.min(120, Math.max(30, payload.timeoutSeconds ?? 120))
              : payload.timeoutSeconds;
            const spawnTokenBudget = isNested
              ? nestedHelperBudget({
                  requested: payload.tokenBudget,
                  parentRemaining: parentBudgetRemaining(caller.agentRun),
                })
              : payload.tokenBudget;
            const spawnIsolation = nestedPolicy.isolation ?? payload.isolation ?? "worktree";
            const admitted = admitSpawn({
              parent: caller,
              projectFolder: nestedPolicy.projectFolder,
              folder: typeof payload.folder === "string" ? payload.folder : undefined,
              prompt: payload.message,
              allowNested: isNested,
              // The MCP door has always checked this. Without it here, the store
              // admitted a spawn onto a folder that is no longer on disk and the
              // worker died on its cwd instead of being turned away.
              folderExists,
            });
            if (!admitted.ok) {
              await replyAsk({ error: admitted.error });
              return;
            }
            if (!parent) {
              await replyAsk({ error: "no parent chat to attach this subagent to" });
              return;
            }
            const resolvedSpec = resolveSpawnSpec(
              {
                fromSessionId: parent.id,
                prompt: payload.message,
                description: payload.description,
                provider: spawnProvider,
                model: spawnModel,
                customBotId: routeDecision?.customBotId,
                chat: payload.chat,
                effort: requestedEffort ?? routeDecision?.effort ?? undefined,
              },
              latest.sessions.filter((item) => !isHiddenSession(item) && !item.archivedAt),
              parent,
              latest.settings.customBots,
            );
            /*
             * Hand the slice back to the worker that already did the last one.
             *
             * Without this, an orchestrator finishing a Grok 4.6 medium job
             * started a SECOND Grok 4.6 medium from cold for the next slice on
             * the same project — the first one idle beside it, still holding
             * the tree and the task. Only an IDLE worker of this chat, in this
             * project, is reused; a busy one still gets a colleague, because
             * running several at once is the point of the desk.
             *
             * Resolve reuse before thinking level. A named or inherited worker
             * keeps its effort unless the user asked to change it. Deriving
             * effort first from the slice ("review" → high) then writing it
             * onto Wren was how medium became high on the next orchestrate.
             */
            const spawnSeed =
              payload.seed === "fresh" ? ("fresh" as const)
              : payload.seed === "inherit" ? ("inherit" as const)
              : undefined;
            const spawnHandoff = parseWorkerHandoff(payload.handoff);
            const askedWorkerName = typeof payload.worker === "string" ? payload.worker.trim() : "";
            const namedResolution = askedWorkerName
              ? resolveNamedWorker(
                  { name: askedWorkerName, seed: spawnSeed },
                  latest.sessions as unknown as WorkerRecord[],
                  { parentId: parent.id, projectId: spawnProjectId },
                )
              : null;
            if (namedResolution && !namedResolution.ok) {
              await replyAsk({ error: namedResolution.error });
              return;
            }
            // Reuse is a continuation protocol, not an idle pool. It used to
            // hand the next unnamed slice to any free worker on this parent
            // and project with the same bot. Inherit concatenates the whole
            // prior transcript (workerStartMessages), so unrelated slices
            // paid for the last one.
            //
            // Now it takes a decision: name the worker, or ask for inherit. A
            // bare spawn gets somebody with a clear head.
            const wantsIdleReuse = !askedWorkerName && payload.seed === "inherit";
            const reusedWorker = nestedPolicy.mayReuse ? namedResolution?.worker
              ?? (wantsIdleReuse
                ? findReusableWorker(
                    {
                      provider: resolvedSpec.provider,
                      model: resolvedSpec.model,
                      // No explicit effort: match that bot at whatever thinking
                      // level it already has, then keep it.
                      ...(requestedEffort ? { effort: requestedEffort } : {}),
                      customBotId: resolvedSpec.customBotId,
                      seed: spawnSeed,
                    },
                    latest.sessions as unknown as WorkerRecord[],
                    {
                      parentId: parent.id,
                      projectId: spawnProjectId,
                      // An unnamed inherit continues this parent's current
                      // wave. Anyone outside it is a different subject.
                      waveChildIds: parent.lineup?.rows.map((row) => row.childId),
                    },
                  )
                : null) : null;
            const spec = {
              ...resolvedSpec,
              effort: spawnEffortFor({
                provider: resolvedSpec.provider,
                model: resolvedSpec.model,
                tier: selectedTier,
                requested: requestedEffort,
                routed: routeDecision?.effort,
                reused: reusedWorker?.effort,
                inherited: resolvedSpec.effort,
              }),
            };
            const routedWorkerIsRouted = routingDecisionMatchesSpawn(routeDecision, spec);
            if (routingIdentityExcluded({
              provider: spec.provider,
              model: spec.model,
              customBotId: spec.customBotId,
            }, effectiveExclusions)) {
              await replyAsk({
                error: `no capable route: ${describeRoutingMiss(routeCandidates, routeRequest, latest.settings.routing)}`,
              });
              return;
            }
            if (vendorSendTarget(spec.provider) === "preview") {
              await replyAsk({ error: `${providerById(spec.provider).name} is not connected yet` });
              return;
            }
            const row = deskCallRowFor(catalog, {
              provider: spec.provider,
              customBotId: spec.customBotId,
              name: spec.title,
            });
            const vendorKey = spec.customBotId ? `bot:${spec.customBotId}` : spec.provider;
            const sameVendor =
              spec.provider === parent.provider && spec.customBotId === parent.customBotId;
            const granted = vendorGrantedForChat(latest.watchPermits, vendorKey, parent.id);
            const noGo = !sameVendor && !granted ? spawnIsNoGo(row) : null;
            if (noGo) {
              await replyAsk({ error: noGo });
              return;
            }
            const spawnHold = vendorCallBlocked({
              session: { ...spec, id: parent.id, parentId: parent.id },
              settings: latest.settings,
              plans: latest.deskPlans ?? plansRef.current,
              permits: latest.watchPermits,
              usage: latest.usage,
              dayMarks: latest.watchDayMarks,
            });
            if (spawnHold) {
              const blocked = spawnHold;
              setState((current) => ({
                ...current,
                sessions: applyFailedPeerAsk(current.sessions, {
                  parentId: parent.id,
                  targetTitle: spec.title || providerById(spec.provider).name,
                  error: blocked,
                }),
              }));
              await replyAsk({ error: blocked });
              return;
            }
            if (spec.provider === "custom") {
              const custom = customBotForSession(latest.settings.customBots, {
                  customBotId: spec.customBotId,
                  model: spec.model,
                });
              if (spec.customBotId && !custom) {
                await replyAsk({ error: "That model is not approved on this key" });
                return;
              }
              const config = custom ?? latest.settings.llms.custom;
              if (!config.baseUrl?.trim() || !config.apiKey?.trim() || !spec.model?.trim()) {
                await replyAsk({ error: "Custom model is not connected yet" });
                return;
              }
            }
            const childId = reusedWorker?.id || payload.childSessionId?.trim() || uid("sess");
            const assistantId = uid("msg");
            const startedAt = Date.now();
            let spawnImages: import("./types").ChatImage[] = [];
            try {
              spawnImages = await fitModelImages(payload.attachments ?? []);
            } catch (error) {
              await replyAsk({ error: error instanceof Error ? error.message : String(error) });
              return;
            }
            let assignedPlan = parent.planRun;
            const planStepId = payload.planStepId?.trim() || "";
            const rationale = payload.rationale?.trim() || "";
            const assignedSkills = Array.isArray(payload.skills) ? payload.skills.filter(Boolean) : [];
            const assignedSkillFiles = Array.isArray(payload.skillFiles) ? payload.skillFiles.filter(Boolean) : [];
            const assignedCapabilities = Array.isArray(payload.capabilities) ? payload.capabilities.filter(Boolean) : [];
            const assignedTools = Array.isArray(payload.tools) ? payload.tools.filter(Boolean) : [];
            const assignedConstraints = Array.isArray(payload.constraints) ? payload.constraints.filter(Boolean) : [];
            const assignedPaths = nestedPolicy.mayOwnPaths
              ? normalizePathAllowlist((payload as unknown as { paths?: unknown }).paths)
              : [];
            if (planStepId) {
              if (!assignedPlan) {
                await replyAsk({ error: "this chat has no executable plan" });
                return;
              }
              if (!rationale) {
                await replyAsk({ error: "plan assignments need a routing rationale" });
                return;
              }
              const assigned = assignPlanStep(assignedPlan, planStepId, {
                sessionId: childId,
                provider: spec.provider,
                model: spec.model,
                ...(spec.effort ? { effort: spec.effort } : {}),
                ...(spec.customBotId ? { customBotId: spec.customBotId } : {}),
                rationale,
                skills: assignedSkills,
                tools: assignedTools,
                constraints: assignedConstraints,
                requested: [payload.provider, payload.model, payload.chat].filter(Boolean).join(":"),
              }, startedAt);
              if (!assigned.ok) {
                await replyAsk({ error: assigned.error });
                return;
              }
              const running = setPlanStepStatus(assigned.plan, planStepId, "running", { now: startedAt });
              if (!running.ok) {
                await replyAsk({ error: running.error });
                return;
              }
              assignedPlan = running.plan;
            }
            const timeoutMs = typeof spawnTimeoutSeconds === "number"
              ? Math.max(30, Math.min(3_600, spawnTimeoutSeconds)) * 1_000
              : 10 * 60 * 1_000;
            const tokenBudget = typeof spawnTokenBudget === "number" && spawnTokenBudget > 0
              ? Math.floor(spawnTokenBudget)
              : undefined;
            const project = boundProject;
            const root = admitted.cwd;
            let environment: SessionEnvironment = { kind: "local" };
            let isolation: "worktree" | "shared" = spawnIsolation === "worktree" ? "worktree" : "shared";
            const priorWorker = reusedWorker
              ? latest.sessions.find((item) => item.id === reusedWorker.id)
              : undefined;
            if (priorWorker) {
              // A reused worker stays where it already worked. Legacy saves
              // may lack environment; treat that as the project folder, do
              // not cut a new worktree under the same name.
              environment = priorWorker.environment ?? { kind: "local" };
              isolation = environment.kind === "worktree" ? "worktree" : "shared";
            } else if (isolation === "worktree") {
              if (!root || !window.workhorse?.ensureWorktree) {
                await replyAsk({ error: "Worktree isolation is unavailable for this folder." });
                return;
              }
              const isolated = await window.workhorse.ensureWorktree({ sessionId: childId, root });
              if (!isolated.ok) {
                await replyAsk({ error: isolated.message });
                return;
              }
              if (!isolated.path || !isolated.gitRoot || !isolated.head) {
                await replyAsk({ error: "Could not create the worker worktree." });
                return;
              }
              environment = { kind: "worktree", path: isolated.path, gitRoot: isolated.gitRoot, head: isolated.head };
            } else {
              isolation = "shared";
            }
            const childCwd = sessionExecutionCwd(environment, root);
            let claimedLeases = releaseSessionLeases(pathLeasesRef.current, childId);
            if (assignedPaths.length > 0) {
              if (!childCwd || !window.workhorse?.readSourceFile) {
                await replyAsk({ error: "Path ownership is unavailable for this worker folder." });
                return;
              }
              const files: Array<{ path: string; fingerprint: string }> = [];
              for (const ownedPath of assignedPaths) {
                const source = await window.workhorse.readSourceFile(ownedPath, [childCwd]);
                if (!source || source.directory || source.unreadable) {
                  await replyAsk({ error: `Cannot lease path: ${ownedPath}.` });
                  return;
                }
                files.push({ path: ownedPath, fingerprint: fileContentsFingerprint(source.text) });
              }
              const claim = claimSharedFiles({
                leases: claimedLeases,
                sessionId: childId,
                isolation,
                role: spawnRole,
                files,
              });
              if (!claim.ok) {
                await replyAsk({ error: claim.error });
                return;
              }
              claimedLeases = claim.leases;
            }
            // Reserve synchronously. Concurrent HTTP spawn handlers can run
            // before React commits state; the ref closes that admission race.
            pathLeasesRef.current = claimedLeases;
            grokAssistantId.current[childId] = assistantId;
            const childCorrelationId = payload.traceId || learningTurns.current[parent.id]?.correlationId || payload.id || uid("corr");
            learningTurns.current[childId] = { correlationId: childCorrelationId, agentRunId: assistantId, toolIds: [] };
            if (routeDecision) {
              const evidence = routingDecisionEvidence({
                candidates: routeCandidates,
                request: routeRequest,
                settings: latest.settings.routing,
                selected: spec,
                mode: "live-auto",
                source: "spawn",
              });
              emitLearningEvent({
                kind: "routing",
                actorClass: "agent",
                projectId: spawnProjectId,
                sessionId: childId,
                provider: spec.provider,
                model: spec.model,
                effort: spec.effort,
                correlationId: childCorrelationId,
                agentRunId: assistantId,
                payload: {
                  summary: routeDecision.reason,
                  ...(evidence ?? {}),
                },
              });
            }
            emitLearningEvent({
              id: learningEvidenceId("execution", assistantId),
              kind: "execution",
              actorClass: "agent",
              projectId: spawnProjectId,
              sessionId: childId,
              provider: spec.provider,
              model: spec.model,
              effort: spec.effort,
              correlationId: childCorrelationId,
              agentRunId: assistantId,
              payload: { summary: `${spec.provider} ${spec.model} worker call started`, status: "started", hiddenWorker: true },
            });
            let workerName = priorWorker?.workerName ?? (namedResolution && namedResolution.ok && !namedResolution.worker ? namedResolution.createName : undefined);
            if (!workerName) {
              const reserved = reserveWorkerName(
                workerNameReservations.current,
                stateRef.current.sessions,
                { workerId: childId, parentId: parent.id },
              );
              workerNameReservations.current = reserved.reservations;
              workerName = reserved.name;
            }
            const assignmentBudget = beginAssignmentBudget(priorWorker?.agentRun, {
              tokenBudget,
              mission: spawnMission
                ? {
                    tokenBudget: spawnMission.tokenBudget,
                    usedTokens: missionUsedTokens(latest.sessions, spawnMission.id),
                    iteration: spawnMission.iteration,
                    maxIterations: spawnMission.maxIterations,
                  }
                : undefined,
            });
            const childMission = spawnMission
              ? {
                  ...spawnMission,
                  ...(assignmentBudget.missionTokenBudget
                    ? { tokenBudget: assignmentBudget.missionTokenBudget }
                    : {}),
                }
              : undefined;
            const child: Session = {
              // A reused worker keeps everything it already is — most of all
              // vendorSessionId, which IS its memory of the last slice. Only
              // the run and the new message are fresh. Budget and usedTokens
              // come from THIS assignment, never the previous slice.
              ...(priorWorker ?? {}),
              id: childId,
              workerName,
              projectId: spawnProjectId,
              parentId: parent.id,
              hidden: true,
              provider: spec.provider,
              model: spec.model,
              customBotId: spec.customBotId,
              effort: spec.effort,
              title: workerTaskTitle(workerName, spec.title),
              titleLocked: true,
              // Two dials. The vendor session is the first: a path-owned worker
              // launches at Ask so its write events still reach the ownership
              // preflight, because Always would map to approval_policy="never"
              // and those events would never arrive. The grant below is the
              // second — it silences the modal without loosening the launch.
              // A tightening the person put on this worker chat outranks both.
              ...workerAccess({
                inherited: inheritedAccess,
                owned: assignedPaths.length > 0,
                readOnly: nestedPolicy.readOnly,
                prior: priorWorker,
              }),
              securityPolicy: parent.securityPolicy,
              environment,
              status: "running",
              contextUsed: 0,
              agentRun: {
                status: "running",
                startedAt,
                timeoutMs,
                isolation,
                executionOwner: "workhorse",
                ...assignmentBudget,
                ...(spawnSeed === "fresh" ? { seed: "fresh" as const } : {}),
                ...(planStepId ? { planStepId } : {}),
                ...(rationale ? { rationale } : {}),
                ...(assignedSkills.length > 0 ? { skills: assignedSkills } : {}),
                ...(assignedSkillFiles.length > 0 ? { skillFiles: assignedSkillFiles } : {}),
                ...(assignedCapabilities.length > 0 ? { capabilities: assignedCapabilities } : {}),
                ...(assignedTools.length > 0 ? { tools: assignedTools } : {}),
                ...(assignedConstraints.length > 0 ? { constraints: assignedConstraints } : {}),
                ...(assignedPaths.length > 0 ? { paths: assignedPaths } : {}),
                ...(effectiveExclusions.length > 0 ? { exclusions: effectiveExclusions } : {}),
                grantedAccess: workerGrant({ inherited: inheritedAccess, prior: priorWorker }),
                correlationId: childCorrelationId,
                ...(childMission ? { mission: childMission } : {}),
              },
              ...(routedWorkerIsRouted
                ? { routingMode: "auto" as const, routingDecision: routeDecision ?? undefined }
                : { routingMode: "manual" as const }),
              ...(spawnSeed === "fresh" ? { vendorSessionId: undefined, vendorProvider: undefined } : {}),
              messages: workerStartMessages({
                seed: spawnSeed,
                priorMessages: priorWorker?.messages,
                userId: uid("msg"),
                assistantId,
                fromTitle: parent.title?.trim() || "another agent",
                text: payload.message.trim(),
                createdAt: startedAt,
                handoff: spawnHandoff,
                images: spawnImages.length ? spawnImages : undefined,
                correlationId: childCorrelationId,
                ...brainStamp(spec),
              }),
            };
            const waveText = lastUserMessage(parent)?.text ?? "";
            setState((current) => {
              const base =
                inboundHost && !current.sessions.some((item) => item.id === inboundHost.id)
                  ? [inboundHost, ...current.sessions]
                  : current.sessions;
              return {
                ...current,
                leases: claimedLeases,
                activeProjectId: current.activeSessionId === parent.id ? spawnProjectId : current.activeProjectId,
                sessions: [
                  ...base.map((item) =>
                    item.id === parent.id
                      ? {
                          ...item,
                          title: parent.title,
                          titleLocked: parent.titleLocked,
                          projectId: spawnProjectId,
                          lineup: stampLineupUserText(
                            addLineupRow(
                              item.lineup ?? emptyLineup(childCwd, startedAt),
                              {
                                childId,
                                title: spec.title,
                                slice: payload.description?.trim() || spec.title,
                                folder: childCwd,
                                vendor: vendorDisplayName(spec.provider),
                                status: "running",
                                startedAt,
                                correlationId: childCorrelationId,
                                // The caller is known here and was being dropped, so a
                                // Link wave could not say who drove it. Only for an
                                // inbound harness: a desk wave has no caller to name.
                                ...(exposure === "external-runtime" && payload.origin && payload.origin !== "workhorse"
                                  ? { caller: payload.origin }
                                  : {}),
                                ...(spawnMission ? {
                                  missionId: spawnMission.id,
                                  iteration: spawnMission.iteration,
                                } : {}),
                                ...(planStepId ? { planStepId } : {}),
                                ...(rationale ? { rationale } : {}),
                                ...(assignedPaths.length > 0 ? { paths: assignedPaths } : {}),
                              },
                              exposure === "external-runtime" ? "external-runtime" : "desk",
                              spawnMission,
                            ),
                            waveText,
                          ),
                          ...(assignedPlan ? { planRun: assignedPlan } : {}),
                          messages: [
                            ...item.messages,
                            {
                              id: uid("msg"),
                              role: "system" as const,
                              kind: "subagent" as const,
                              fromTitle: spec.title,
                              subagentSessionId: childId,
                              toolCallId: payload.id,
                              toolStatus: "running",
                              text: spec.title,
                              createdAt: startedAt,
                              correlationId: childCorrelationId,
                            },
                          ],
                        }
                      : item,
                  ).map((item) => (item.id === childId ? child : item)),
                  ...(priorWorker ? [] : [child]),
                ],
              };
            });
            const waitForReply = spawnWaitsForReply(payload);
            let terminalFailure: "timed-out" | "cancelled" | "budget-exceeded" | undefined;
            const markChildFailure = (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              setState((current) => {
                let sessions = applyChildIdleSync(current.sessions, childId, "failed", {
                  report: message,
                  error: message,
                  correlationId: childCorrelationId,
                });
                sessions = settlePlanAssignment(sessions, parent.id, childId, "failed", message);
                const admitted = joinAdmit(sessions, parent.id, current, plansRef.current);
                queueMicrotask(() => {
                  if (admitted.auditor) sendRef.current(admitted.auditor.brief, { sessionId: admitted.auditor.id, hideUser: true });
                });
                const leases = releaseSessionLeases(current.leases ?? [], childId);
                pathLeasesRef.current = leases;
                return { ...current, sessions: admitted.sessions, leases };
              });
            };
            const runChild = async () => {
              const spawnHead = window.workhorse?.gitHead && childCwd
                ? await window.workhorse.gitHead(childCwd)
                : "";
              let reply = "";
              try {
                reply = await promptVendor(
                  child,
                  vendorTextForSpawn({
                    seed: spawnSeed,
                    handoff: spawnHandoff,
                    fromTitle: parent.title?.trim() || "another agent",
                    text: payload.message,
                    folder: childCwd,
                    project: project?.name,
                    slice: payload.description,
                    vendor: vendorDisplayName(spec.provider),
                    constraints: assignedConstraints,
                    skills: assignedSkills.map((name, index) => ({ name, file: assignedSkillFiles[index] ?? "" })).filter((skill) => skill.file),
                    capabilities: assignedCapabilities,
                    paths: assignedPaths,
                    mission: payload.mission === true,
                    missionIteration: spawnMission,
                  }),
                  latest.settings.mcpServers,
                  spawnImages,
                  Boolean(priorWorker && payload.mission),
                );
              } catch (error) {
                const liveRun = stateRef.current.sessions.find((item) => item.id === childId)?.agentRun;
                if (liveRun?.status === "budget-exceeded") {
                  terminalFailure = "budget-exceeded";
                  throw error;
                }
                if (!needsBudgetHandoffTurn({ ...liveRun, status: liveRun?.status })) throw error;
              }
              const liveAfter = stateRef.current.sessions.find((item) => item.id === childId);
              if (needsBudgetHandoffTurn(liveAfter?.agentRun) && liveAfter?.agentRun?.status === "running") {
                const handoffAt = Date.now();
                setState((current) => ({
                  ...current,
                  sessions: current.sessions.map((item) =>
                    item.id === childId && item.agentRun
                      ? {
                          ...item,
                          status: "running" as const,
                          agentRun: appendRunEvent(
                            {
                              ...item.agentRun,
                              budgetPhase: "handoff",
                              budgetHandoffAt: handoffAt,
                            },
                            { at: handoffAt, type: "budget-handoff", detail: BUDGET_HANDOFF_PROMPT },
                          ),
                        }
                      : item,
                  ),
                }));
                try {
                  reply = (await promptVendor(
                    { ...liveAfter, status: "running" },
                    BUDGET_HANDOFF_PROMPT,
                    latest.settings.mcpServers,
                  )) || reply;
                } catch (error) {
                  const liveRun = stateRef.current.sessions.find((item) => item.id === childId)?.agentRun;
                  if (liveRun?.status === "budget-exceeded") {
                    terminalFailure = "budget-exceeded";
                    throw error;
                  }
                  throw error;
                }
              }
              const terminalStatus = stateRef.current.sessions.find((item) => item.id === childId)?.agentRun?.status;
              if (terminalStatus === "timed-out" || terminalStatus === "cancelled" || terminalStatus === "budget-exceeded") {
                terminalFailure = terminalStatus;
                setState((current) => {
                  const rowStatus = lineupStatusForTerminalRun(terminalStatus);
                  let sessions = applyChildIdleSync(current.sessions, childId, rowStatus, {
                    report: childReportText(current.sessions.find((item) => item.id === childId)),
                    error: terminalStatus,
                    correlationId: childCorrelationId,
                  });
                  sessions = settlePlanAssignment(sessions, parent.id, childId, "failed", terminalStatus);
                  const admitted = joinAdmit(sessions, parent.id, current, plansRef.current);
                  queueMicrotask(() => {
                    if (admitted.auditor) sendRef.current(admitted.auditor.brief, { sessionId: admitted.auditor.id, hideUser: true });
                  });
                  const leases = releaseSessionLeases(current.leases ?? [], childId);
                  pathLeasesRef.current = leases;
                  return { ...current, sessions: admitted.sessions, leases };
                });
                return "";
              }
              const liveChild = stateRef.current.sessions.find((item) => item.id === childId);
              const worked = liveChild
                ? turnWorkedAfterAssistant(liveChild.messages, assistantId)
                : false;
              const fallback = settleEmptyAssistantText({
                provider: spec.provider,
                reply,
                existingText: liveChild?.messages.find((entry) => entry.id === assistantId)?.text,
                worked,
              });
              const afterChanges = window.workhorse?.listGitChanges && childCwd
                ? await window.workhorse.listGitChanges(childCwd, spawnHead || undefined)
                : [];
              const changedFiles = afterChanges.map((change) => change.path);
              const unauthorizedFiles = assignedPaths.length > 0
                ? changedFiles.filter((file) => !assignedPaths.some((owned) => owned.toLowerCase() === file.replaceAll("\\", "/").toLowerCase()))
                : [];
              const ownershipError = unauthorizedFiles.length > 0
                ? `Path ownership blocked completion: worker changed ${unauthorizedFiles.join(", ")}.`
                : "";
              const finalReport = ownershipError ? `${fallback}\n\n${ownershipError}`.trim() : fallback;
              const reportedBlocked = workerReportedBlocked(fallback) || Boolean(ownershipError);
              setState((current) => {
                const withReply = current.sessions.map((item) =>
                  item.id === childId
                    ? {
                        ...item,
                        agentRun: item.agentRun
                          ? {
                              ...item.agentRun,
                              changedFiles,
                              conflictFiles: overlappingAgentFiles(current.sessions, childId, changedFiles),
                            }
                          : undefined,
                        messages: item.messages.map((entry) =>
                          entry.id === assistantId && !assistantHasVisibleReply(entry.text)
                            ? {
                                ...entry,
                                text: settleEmptyAssistantText({
                                  provider: spec.provider,
                                  reply,
                                  existingText: entry.text,
                                  worked: turnWorkedAfterAssistant(item.messages, assistantId),
                                }),
                              }
                            : entry,
                        ),
                      }
                    : item,
                );
                const outcome = reportedBlocked ? "failed" as const : "completed" as const;
                let sessions = applyChildIdleSync(withReply, childId, outcome, {
                  report: finalReport,
                  ...(reportedBlocked ? { error: ownershipError || "Worker reported blocked." } : {}),
                  correlationId: childCorrelationId,
                });
                sessions = settlePlanAssignment(sessions, parent.id, childId, outcome, finalReport);
                const admitted = joinAdmit(sessions, parent.id, current, plansRef.current);
                queueMicrotask(() => {
                  if (admitted.auditor) sendRef.current(admitted.auditor.brief, { sessionId: admitted.auditor.id, hideUser: true });
                });
                const leases = releaseSessionLeases(current.leases ?? [], childId);
                pathLeasesRef.current = leases;
                return { ...current, sessions: admitted.sessions, leases };
              });
              return finalReport;
            };
            if (!waitForReply) {
              await replyAsk({
                text: JSON.stringify(
                  {
                    started: true,
                    title: spec.title,
                    childSessionId: childId,
                    folder: admitted.cwd,
                    lineup: lineupSnapshot(
                      addLineupRow(parent.lineup ?? emptyLineup(admitted.cwd, startedAt), {
                        childId,
                        title: spec.title,
                        slice: payload.description?.trim() || spec.title,
                        folder: admitted.cwd,
                        vendor: vendorDisplayName(spec.provider),
                        status: "running",
                        startedAt,
                        ...(planStepId ? { planStepId } : {}),
                        ...(rationale ? { rationale } : {}),
                        ...(assignedPaths.length > 0 ? { paths: assignedPaths } : {}),
                      }, undefined, spawnMission),
                    ),
                    worker: workerName,
                    reused: Boolean(priorWorker),
                    routingMode: routedWorkerIsRouted ? "auto" : "manual",
                    ...(routedWorkerIsRouted && routeDecision ? { routingDecision: routeDecision } : {}),
                    howToUse:
                      `Worker is running in its own chat. ${priorWorker ? `${workerName} picked this up with what it already knew.` : `${workerName} is new to this work.`} For the next slice of the same kind pass worker="${workerName}" and it goes back to the same worker. Spawn the rest with wait=false, then stop. The desk joins reports later. Do not sit on workhorse_await_agents or ask the user to pick.`,
                  },
                  null,
                  2,
                ),
              });
              void runChild().catch(markChildFailure);
              return;
            }
            let fallback = "";
            try {
              fallback = await runChild();
            } catch (error) {
              markChildFailure(error);
              throw error;
            }
            if (terminalFailure) {
              const failed = stateRef.current.sessions.find((item) => item.id === childId);
              await replyAsk({
                error: failed?.agentRun?.error || `Worker ended ${terminalFailure}.`,
              });
              return;
            }
            const finished = stateRef.current.sessions.find((item) => item.id === childId);
            await replyAsk({
              text: JSON.stringify(
                {
                  completed: true,
                  childSessionId: childId,
                  worker: finished?.workerName ?? workerName,
                  title: finished?.title ?? spec.title,
                  provider: finished?.provider ?? spec.provider,
                  model: finished?.model ?? spec.model,
                  effort: finished?.effort ?? null,
                  exclusions: finished?.agentRun?.exclusions ?? effectiveExclusions,
                  routingMode: finished?.routingMode ?? (routeDecision ? "auto" : "manual"),
                  ...(finished?.routingDecision ?? routeDecision
                    ? { routingDecision: finished?.routingDecision ?? routeDecision }
                    : {}),
                  report: fallback,
                },
                null,
                2,
              ),
            });
            return;
          }

          const target = latest.sessions.find((item) => item.id === payload.toSessionId);
          const from = parent ?? latest.sessions.find((item) => item.id === payload.fromSessionId);
          const canReachHiddenTarget = Boolean(
            target && from && sameSessionCrew(latest.sessions, from.id, target.id),
          );
          if (!target || (isHiddenSession(target) && !canReachHiddenTarget) || target.archivedAt) {
            await replyAsk({ error: "that chat is not available" });
            return;
          }
          if (vendorSendTarget(target.provider) === "preview") {
            await replyAsk({ error: `${providerById(target.provider).name} is not connected yet` });
            return;
          }
          const askHold = vendorCallBlocked({
            session: { ...target, parentId: from?.id },
            settings: latest.settings,
            plans: latest.deskPlans ?? plansRef.current,
            permits: latest.watchPermits,
            usage: latest.usage,
            dayMarks: latest.watchDayMarks,
          });
          if (askHold && from) {
            const catalog = deskCallCatalog({
              settings: latest.settings,
              usage: latest.usage,
              plans: latest.deskPlans ?? plansRef.current,
              permits: latest.watchPermits,
              dayMarks: latest.watchDayMarks,
            });
            const row = deskCallRowFor(catalog, {
              provider: target.provider,
              customBotId: target.customBotId,
              name: target.title,
            });
            if (row && vendorOverrideNeeded(row)) {
              const requestId = uid("perm");
              elevatePeerReply.current.set(requestId, replyAsk);
              setState((current) => ({
                ...current,
                pending: enqueuePermission(current.pending, {
                  id: requestId,
                  sessionId: from.id,
                  provider: from.provider,
                  tool: "workhorse_request_vendor",
                  detail: row.reason || `${row.name} will answer from another sidebar chat.`,
                  kind: "vendor",
                  vendor: { provider: row.provider, name: row.name, status: "day_bank" },
                }),
                sessions: current.sessions.map((item) =>
                  item.id === from.id ? { ...item, status: "needs-input" } : item,
                ),
              }));
              return;
            }
            setState((current) => ({
              ...current,
              sessions: applyFailedPeerAsk(current.sessions, {
                parentId: from.id,
                childId: target.id,
                targetTitle: target.title,
                error: askHold,
              }),
            }));
            await replyAsk({ error: askHold });
            return;
          }
          if (askHold) {
            await replyAsk({ error: askHold });
            return;
          }
          const fromTitle = from?.title?.trim() || "another chat";
          const prompt = formatPeerPrompt(fromTitle, payload.message);
          const assistantId = uid("msg");
          grokAssistantId.current[target.id] = assistantId;
          const startedAt = Date.now();
          const peerCorrelationId = payload.traceId || (from ? learningTurns.current[from.id]?.correlationId : undefined) || payload.id || uid("corr");
          learningTurns.current[target.id] = { correlationId: peerCorrelationId, agentRunId: assistantId, toolIds: [] };
          emitLearningEvent({
            id: learningEvidenceId("execution", assistantId),
            kind: "execution",
            actorClass: "agent",
            projectId: target.projectId,
            sessionId: target.id,
            provider: target.provider,
            model: target.model,
            effort: target.effort,
            correlationId: peerCorrelationId,
            agentRunId: assistantId,
            payload: { summary: `${target.provider} ${target.model} peer call started`, status: "started", peerCall: true },
          });
          setState((current) => ({
            ...current,
            sessions: current.sessions.map((item) => {
              if (from && item.id === from.id && item.id !== target.id) {
                return {
                  ...item,
                  messages: [
                    ...item.messages,
                    {
                      id: uid("msg"),
                      role: "system" as const,
                      kind: "subagent" as const,
                      fromTitle: target.title,
                      subagentSessionId: target.id,
                      toolCallId: payload.id,
                      toolStatus: "running",
                      text: target.title,
                      createdAt: startedAt,
                    },
                  ],
                };
              }
              if (item.id !== target.id) return item;
              return {
                ...item,
                status: "running",
                agentRun: item.agentRun
                  ? continueWorkerRun(item.agentRun, { now: startedAt, correlationId: peerCorrelationId })
                  : undefined,
                messages: [
                  ...item.messages,
                  {
                    id: uid("msg"),
                    role: "user" as const,
                    kind: "peer" as const,
                    fromTitle,
                    peerFromSessionId: from?.id,
                    correlationId: peerCorrelationId,
                    text: payload.message.trim(),
                    createdAt: startedAt,
                    ...brainStamp(target),
                  },
                  { id: assistantId, role: "assistant", text: "", createdAt: startedAt, correlationId: peerCorrelationId, ...brainStamp(target) },
                ],
              };
            }),
          }));
          const runPeer = async () => {
            const reply = await promptVendor(target, prompt, stateRef.current.settings.mcpServers);
            const liveTarget = stateRef.current.sessions.find((item) => item.id === target.id);
            const fallback = settleEmptyAssistantText({
              provider: target.provider,
              reply,
              existingText: liveTarget?.messages.find((entry) => entry.id === assistantId)?.text,
              worked: liveTarget ? turnWorkedAfterAssistant(liveTarget.messages, assistantId) : false,
            });
            const finishedAt = Date.now();
            setState((current) => ({
              ...current,
              sessions: withSubagentStatus(
                current.sessions.map((item) =>
                  item.id === target.id
                    ? {
                        ...item,
                        status: "idle",
                        agentRun: item.agentRun
                          ? { ...item.agentRun, status: "completed" as const, finishedAt, error: undefined }
                          : undefined,
                        messages: item.messages.map((entry) =>
                          entry.id === assistantId && !assistantHasVisibleReply(entry.text)
                            ? {
                                ...entry,
                                text: settleEmptyAssistantText({
                                  provider: target.provider,
                                  reply,
                                  existingText: entry.text,
                                  worked: turnWorkedAfterAssistant(item.messages, assistantId),
                                }),
                              }
                            : entry,
                        ),
                      }
                    : item,
                ),
                target.id,
                "completed",
              ),
            }));
            return fallback;
          };
          if (payload.wait === false) {
            await replyAsk({
              text: JSON.stringify(
                {
                  accepted: true,
                  childSessionId: target.id,
                  worker: target.workerName,
                  provider: target.provider,
                  model: target.model,
                  effort: target.effort,
                  routingMode: target.routingMode ?? "manual",
                  ...(target.routingDecision ? { routingDecision: target.routingDecision } : {}),
                  status: "running",
                  howToUse: "Accepted. Stop this turn. The desk journals the reply and wakes the parent chat. Later, workhorse_agent_status on this chat.",
                },
                null,
                2,
              ),
            });
            void runPeer().catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              setState((current) => ({
                ...current,
                sessions: applyFailedPeerAsk(
                  current.sessions.map((item) =>
                    item.id === target.id && item.agentRun
                      ? {
                          ...item,
                          status: "idle" as const,
                          agentRun: { ...item.agentRun, status: "failed" as const, finishedAt: Date.now(), error: message },
                        }
                      : item,
                  ),
                  { parentId: from?.id, childId: target.id, targetTitle: target.title, error: message },
                ),
              }));
            });
            return;
          }
          const fallback = await runPeer();
          await replyAsk({ text: fallback });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const childId = payload.childSessionId || payload.toSessionId;
          const latest = stateRef.current;
          const target = latest.sessions.find((item) => item.id === childId);
          setState((current) => {
            let failed = applyFailedPeerAsk(
              applyChildIdleSync(
                current.sessions.map((item) =>
                  item.id === payload.toSessionId || item.id === payload.childSessionId
                    ? {
                        ...item,
                        status: "idle" as const,
                        agentRun: item.agentRun
                          ? {
                              ...item.agentRun,
                              status: "failed" as const,
                              finishedAt: Date.now(),
                              error: message,
                            }
                          : undefined,
                      }
                    : item,
                ),
                childId,
                "failed",
                { error: message },
              ),
              {
                parentId: payload.fromSessionId,
                childId,
                targetTitle: target?.title,
                error: message,
              },
            );
            const parentId = payload.fromSessionId || target?.parentId;
            if (parentId && childId) failed = settlePlanAssignment(failed, parentId, childId, "failed", message);
            const admitted = parentId ? joinAdmit(failed, parentId, current, plansRef.current) : { sessions: failed };
            queueMicrotask(() => {
              if (admitted.auditor) sendRef.current(admitted.auditor.brief, { sessionId: admitted.auditor.id, hideUser: true });
            });
            return {
              ...current,
              sessions: admitted.sessions,
            };
          });
          await replyAsk({ error: message });
        }
      })();
    });
  }, []);

  /** One terminal path, whether the caller cancelled or the desk's own deadline fired. */
  const stopWorker = useCallback((childSessionId: string, reason: "timed-out" | "cancelled") => {
    const child = stateRef.current.sessions.find((session) => session.id === childSessionId);
    if (child?.status === "running") cancelVendorSession(child);
    setState((current) => {
      const rowStatus = reason === "timed-out" ? "timed-out" as const : "cancelled" as const;
      let sessions = applyChildIdleSync(current.sessions, childSessionId, rowStatus, {
        error: reason === "timed-out" ? "Subagent exceeded its runtime limit." : "Subagent was cancelled.",
      });
      const parentId = child?.parentId;
      if (parentId) sessions = settlePlanAssignment(sessions, parentId, childSessionId, "failed", reason);
      const admitted = parentId ? joinAdmit(sessions, parentId, current, plansRef.current) : { sessions };
      queueMicrotask(() => {
        if (admitted.auditor) sendRef.current(admitted.auditor.brief, { sessionId: admitted.auditor.id, hideUser: true });
      });
      return { ...current, sessions: admitted.sessions };
    });
  }, []);

  useEffect(() => {
    if (!window.workhorse?.onPeerCancel) return;
    return window.workhorse.onPeerCancel(({ childSessionId, reason }) => stopWorker(childSessionId, reason));
  }, [stopWorker]);

  /**
   * The desk enforces the runtime limit, because the caller's timer cannot: on Link a
   * delegation is answered immediately with the worker id, and that reply clears it
   * while the worker runs on. Measured before this: a 30s limit let a pass run 251s.
   */
  useEffect(() => {
    if (!ready) return;
    const sweep = () => {
      for (const id of expiredWorkerIds(stateRef.current.sessions, Date.now())) {
        stopWorker(id, "timed-out");
      }
    };
    sweep();
    const timer = window.setInterval(sweep, WORKER_DEADLINE_SWEEP_MS);
    return () => window.clearInterval(timer);
  }, [ready, stopWorker]);

  useEffect(() => {
    const flushStreams = () => {
      if (
        Object.keys(grokChunkQueue.current).length === 0 &&
        Object.keys(grokThoughtQueue.current).length === 0
      ) {
        return;
      }
      setState((current) => {
        const drained = applyStreamQueues({
          sessions: current.sessions,
          chunkQueue: grokChunkQueue.current,
          thoughtQueue: grokThoughtQueue.current,
          assistantIdFor: (sessionId, session) =>
            grokAssistantId.current[sessionId] ??
            [...session.messages].reverse().find((message) => message.role === "assistant")?.id,
        });
        grokChunkQueue.current = drained.chunkQueue;
        grokThoughtQueue.current = drained.thoughtQueue;
        return drained.changed ? { ...current, sessions: drained.sessions } : current;
      });
    };
    const streamCommits = createStreamCommitScheduler(flushStreams, {
      frame: (run) => requestAnimationFrame(run),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    });
    const apply = (event: GrokBridgeEvent) => {
      try {
      const goalHalted = goalHaltedSessions.current.has(event.sessionId);
      const terminal = vendorTerminalAction({
        halted: goalHalted,
        eventType: event.type,
        liveAssistantId: grokAssistantId.current[event.sessionId],
      });
      if (terminal === "ignore") return;
      if (terminal === "consume-halt-then-forward") {
        streamCommits.flushNow();
        goalHaltedSessions.current.delete(event.sessionId);
        const haltedAssistantId = grokAssistantId.current[event.sessionId];
        const pending = goalForwardAfterHalt.current[event.sessionId];
        delete goalForwardAfterHalt.current[event.sessionId];
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === event.sessionId
              ? {
                  ...session,
                  status: "idle" as const,
                  messages: session.messages.filter((message) =>
                    message.id !== haltedAssistantId || Boolean(message.text.trim() || message.thought?.trim()),
                  ),
                }
              : session,
          ),
        }));
        if (pending) {
          queueMicrotask(() => {
            sendRef.current(pending.text, {
              images: pending.images,
              hideUser: pending.hideUser,
              sessionId: event.sessionId,
              afterGoalHalt: true,
            });
          });
        }
        return;
      }
      // Tokens buffer into the existing per-session queues and flush once a
      // frame. Everything else forces a drain first so permission, tools, and
      // turn-end never race a pending rAF.
      if (event.type === "chunk") {
        if (!event.text) return;
        grokChunkQueue.current[event.sessionId] = mergeStreamedText(
          grokChunkQueue.current[event.sessionId] ?? "",
          event.text,
        );
        streamCommits.request();
        return;
      }
      if (event.type === "thought") {
        if (!event.text) return;
        grokThoughtQueue.current[event.sessionId] =
          (grokThoughtQueue.current[event.sessionId] ?? "") + event.text;
        streamCommits.request();
        return;
      }
      streamCommits.flushNow();
      if (event.type === "commands") {
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === event.sessionId ? { ...session, grokCommands: event.commands } : session,
          ),
        }));
        return;
      }
      if (event.type === "title") {
        // Free vendor metadata (generated_title / session_info_update / summary.json /
        // session/new display names). Never bill a model. It may replace the initial
        // placeholder once; later metadata cannot retitle a task in progress.
        setState((current) => {
          const owner = current.sessions.find((item) => item.id === event.sessionId);
          if (!owner || !titleAcceptsVendor(owner, event.title)) return current;
          const sessions = autoRenameChat(current.sessions, event.sessionId, event.title);
          return sessions ? { ...current, sessions } : current;
        });
        return;
      }
      if (event.type === "vendor-session") {
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === event.sessionId
              ? { ...session, vendorSessionId: event.vendorSessionId, vendorProvider: session.provider }
              : session,
          ),
        }));
        return;
      }
      if (event.type === "tool") {
        const owner = stateRef.current.sessions.find((item) => item.id === event.sessionId);
        const turn = learningTurns.current[event.sessionId];
        if (turn && event.toolCallId && !turn.toolIds.includes(event.toolCallId)) turn.toolIds.push(event.toolCallId);
        if (turn && toolIsFinished(event.status)) {
          const category = /\b(test|verify|check|lint|build)\b/i.test(`${event.title} ${event.detail}`)
            ? "verification"
            : /\b(write|edit|create|patch|render|export|save|screenshot)\b/i.test(event.title)
              ? "artifact"
              : "tool";
          emitLearningEvent({
            id: learningEvidenceId("tool", turn.agentRunId, event.toolCallId),
            kind: "tool",
            actorClass: "agent",
            projectId: owner?.projectId,
            sessionId: event.sessionId,
            provider: owner?.provider,
            model: owner?.model,
            effort: owner?.effort,
            correlationId: turn.correlationId,
            agentRunId: turn.agentRunId,
            toolIds: [event.toolCallId],
            payload: {
              summary: `${event.title} ${event.status}`,
              title: event.title,
              status: event.status,
              detail: event.detail,
              category,
            },
          });
        }
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((session) =>
            session.id === event.sessionId
              ? {
                  ...session,
                  messages: upsertToolMessage(session.messages, {
                    toolCallId: event.toolCallId,
                    title: event.title,
                    status: event.status,
                    detail: event.detail,
                  }),
                  ledger:
                    toolIsFinished(event.status) && event.toolCallId
                      ? appendLiveTool(session.ledger, {
                          callId: event.toolCallId,
                          name: event.title,
                          arguments: event.detail,
                          result: event.detail,
                        })
                      : session.ledger,
                }
              : session,
          ),
        }));
        const status = (event.status ?? "").toLowerCase().replaceAll("_", " ");
        if (toolIsFinished(event.status) && status !== "completed" && status !== "complete" && isWriteToolTitle(event.title)) {
          const pending = approvedPathWrites.current.get(event.sessionId) ?? [];
          const reportedPath = writePathFromToolEvent(event.title, event.detail, event.toolCallId);
          const pendingIndex = reportedPath
            ? pending.findIndex((item) =>
                leasePathForWrite(item.path, item.root).toLowerCase() ===
                leasePathForWrite(reportedPath, item.root).toLowerCase())
            : pending.length === 1 ? 0 : -1;
          if (pendingIndex >= 0) {
            const remaining = pending.filter((_, index) => index !== pendingIndex);
            if (remaining.length > 0) approvedPathWrites.current.set(event.sessionId, remaining);
            else approvedPathWrites.current.delete(event.sessionId);
          }
        }
        if ((status === "completed" || status === "complete") && toolIsFinished(event.status)) {
          snapshotWriteInstance(stateRef.current, event.sessionId, event.title, event.detail, event.toolCallId);
          const owner = stateRef.current.sessions.find((item) => item.id === event.sessionId);
          const pending = approvedPathWrites.current.get(event.sessionId) ?? [];
          if (owner && pending.length > 0 && isWriteToolTitle(event.title)) {
            const reportedPath = writePathFromToolEvent(event.title, event.detail, event.toolCallId);
            const pendingIndex = reportedPath
              ? pending.findIndex((item) =>
                  leasePathForWrite(item.path, item.root).toLowerCase() ===
                  leasePathForWrite(reportedPath, item.root).toLowerCase())
              : pending.length === 1 ? 0 : -1;
            if (pendingIndex >= 0) {
              const approved = pending[pendingIndex]!;
              const remaining = pending.filter((_, index) => index !== pendingIndex);
              if (remaining.length > 0) approvedPathWrites.current.set(event.sessionId, remaining);
              else approvedPathWrites.current.delete(event.sessionId);
              if (window.workhorse?.readSourceFile) {
                const refreshKey = `${event.sessionId}:${leasePathForWrite(approved.path, approved.root).toLowerCase()}`;
                const priorRefresh = pathFingerprintRefreshes.current.get(refreshKey) ?? Promise.resolve();
                const refresh = priorRefresh.catch(() => undefined).then(async () => {
                  const source = await window.workhorse!.readSourceFile!(approved.path, approved.root ? [approved.root] : []);
                  if (!source || source.directory || source.unreadable) return;
                  const leases = refreshSharedFileFingerprint({
                    leases: pathLeasesRef.current,
                    sessionId: event.sessionId,
                    path: approved.path,
                    root: approved.root,
                    fingerprint: fileContentsFingerprint(source.text),
                  });
                  if (leases === pathLeasesRef.current) return;
                  pathLeasesRef.current = leases;
                  setState((current) => ({ ...current, leases }));
                }).catch(() => undefined);
                pathFingerprintRefreshes.current.set(refreshKey, refresh);
                void refresh.finally(() => {
                  if (pathFingerprintRefreshes.current.get(refreshKey) === refresh) {
                    pathFingerprintRefreshes.current.delete(refreshKey);
                  }
                });
              }
            }
          }
          if (isParentTakeoverTool(event.title)) {
            setState((current) => {
              const sessions = recordParentTakeover(
                current.sessions,
                event.sessionId,
                `Parent applied ${event.title} after handing the work to Workhorse.`,
              );
              return sessions === current.sessions ? current : { ...current, sessions };
            });
          }
        }
        return;
      }
      if (event.type === "compact") {
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((session) => {
            if (session.id !== event.sessionId) return session;
            const contextUsed = applyCompactUsage(session.contextUsed, event);
            return {
              ...session,
              contextUsed,
              ledger: recordLiveCompact(session.ledger, {
                id: uid("msg"),
                text: formatCompactLine({ ...event, contextUsed }),
              }),
              messages: upsertCompactMessage(session.messages, { ...event, contextUsed }),
            };
          }),
        }));
        return;
      }
      if (event.type === "permission") {
        const owner = stateRef.current.sessions.find((item) => item.id === event.sessionId);
        const provider =
          owner?.provider === "codex" ||
          owner?.provider === "claude" ||
          owner?.provider === "cursor" ||
          owner?.provider === "custom"
            ? owner.provider
            : "grok";
        const ownedPaths = owner?.agentRun?.paths ?? [];
        // ACP write/edit requests are the only pre-write path chokepoint the
        // renderer receives. Path-owned workers run in Ask mode so these are
        // checked against the desk lease before normal permission policy.
        // An opaque shell command has no reliable target path; changed-file
        // review remains the backstop for vendors that report only the shell.
        if (owner && ownedPaths.length > 0 && isWriteToolTitle(event.tool)) {
          if (!pathPermissionPreflight.current.has(event.requestId)) {
            const writePath = event.path || writePathFromToolEvent(event.tool, event.detail, event.requestId);
            const deny = (reason: string) => {
              if (provider === "codex") void window.workhorse?.codexAnswerPermission?.(event.requestId, "deny");
              else if (provider === "claude") void window.workhorse?.claudeAnswerPermission?.(event.requestId, "deny");
              else if (provider === "cursor") void window.workhorse?.cursorAnswerPermission?.(event.requestId, "deny");
              else if (provider === "custom") void window.workhorse?.customAnswerPermission?.(event.requestId, "deny");
              else void window.workhorse?.grokAnswerPermission?.(event.requestId, "deny");
              setState((current) => ({
                ...current,
                sessions: current.sessions.map((session) =>
                  session.id === owner.id
                    ? {
                        ...session,
                        status: permissionResumeStatus({ hasOtherPending: false, agentRun: session.agentRun }),
                        messages: [
                          ...session.messages,
                          { id: uid("msg"), role: "system" as const, text: reason, createdAt: Date.now() },
                        ],
                      }
                    : session,
                ),
              }));
            };
            if (!writePath || !window.workhorse?.readSourceFile) {
              deny("Path ownership blocked a write whose target path could not be verified.");
              return;
            }
            const project = stateRef.current.projects.find((item) => item.id === owner.projectId);
            const root = sessionExecutionCwd(
              owner.environment,
              project ? primaryFolder(project, folderExists)?.path ?? "" : "",
            );
            const refreshKey = `${owner.id}:${leasePathForWrite(writePath, root).toLowerCase()}`;
            const pendingRefresh = pathFingerprintRefreshes.current.get(refreshKey) ?? Promise.resolve();
            void pendingRefresh.then(() => window.workhorse!.readSourceFile!(writePath, root ? [root] : [])).then((source) => {
              const decision = assertAgentPathWrite({
                leases: pathLeasesRef.current,
                sessionId: owner.id,
                paths: ownedPaths,
                path: writePath,
                root,
                currentFingerprint: fileContentsFingerprint(source?.text ?? ""),
                role: owner.agentRun?.role,
              });
              if (!decision.ok) {
                deny(decision.error);
                return;
              }
              const pending = approvedPathWrites.current.get(owner.id) ?? [];
              approvedPathWrites.current.set(owner.id, [...pending, { path: writePath, root }]);
              pathPermissionPreflight.current.add(event.requestId);
              apply(event);
            }).catch(() => deny(`Path ownership could not verify ${writePath}.`));
            return;
          }
          pathPermissionPreflight.current.delete(event.requestId);
        }
        const eventVendor =
          "vendor" in event && event.vendor && typeof event.vendor === "object"
            ? (event.vendor as { provider?: string; name?: string; status?: string })
            : undefined;
        if (eventVendor && owner) {
          const catalog = deskCallCatalog({
            settings: stateRef.current.settings,
            usage: stateRef.current.usage,
            plans: plansRef.current,
            permits: stateRef.current.watchPermits,
            dayMarks: stateRef.current.watchDayMarks,
          });
          const row = deskCallRowFor(catalog, {
            provider: eventVendor.provider,
            name: eventVendor.name,
          });
          const vendorStatus =
            row?.status === "day_bank" || row?.status === "spent" || row?.status === "disabled"
              ? row.status
              : "ok";
          const vendorName = row?.name || eventVendor.name || "that vendor";
          const vendorProvider =
            row?.provider ||
            (eventVendor.provider === "codex" || eventVendor.provider === "claude" || eventVendor.provider === "custom"
              ? eventVendor.provider
              : "grok");
          const vendorKey = row?.id.startsWith("bot:") ? row.id : vendorProvider;
          if (vendorGrantedForChat(stateRef.current.watchPermits, vendorKey, owner.id) || !vendorOverrideNeeded(row)) {
            if (provider === "custom") void window.workhorse?.customAnswerPermission?.(event.requestId, "once");
            return;
          }
          setState((current) => ({
            ...current,
            pending: enqueuePermission(current.pending, {
              id: event.requestId,
              sessionId: event.sessionId,
              provider,
              tool: event.tool,
              detail:
                vendorStatus === "ok"
                  ? `${vendorName} will run inside this conversation.`
                  : row?.reason || `${vendorName} is not callable right now.`,
              kind: "vendor",
              vendor: { provider: vendorProvider, name: vendorName, status: vendorStatus },
            }),
            sessions: current.sessions.map((session) =>
              session.id === event.sessionId ? { ...session, status: "needs-input" } : session,
            ),
          }));
          return;
        }
        const eventElevate =
          "elevate" in event && event.elevate && typeof event.elevate === "object"
            ? event.elevate
            : undefined;
        const ownerProject = owner ? stateRef.current.projects.find((item) => item.id === owner.projectId) : undefined;
        const security = owner
          ? securityPolicyAnswer({
              policy: owner.securityPolicy,
              tool: event.tool,
              detail: event.detail,
              path: event.path,
              roots: ownerProject?.folders.map((folder) => folder.path) ?? [],
            })
          : { answer: null };
        const forced = security.answer ?? (owner
          ? permissionPolicyAnswer({
              mode: owner.mode,
              sandbox: owner.sandbox,
              tool: event.tool,
              detail: event.detail,
              path: event.path,
            })
          : null);
        const need =
          eventElevate && owner
            ? parseElevationInput(eventElevate as Record<string, unknown>, owner)
            : owner && forced === "deny" && !security.boundary
              ? elevationForBlock({
                  mode: owner.mode,
                  sandbox: owner.sandbox,
                  tool: event.tool,
                  detail: event.detail,
                  path: event.path,
                })
              : null;
        if (need && owner) {
          setState((current) => ({
            ...current,
            pending: enqueuePermission(current.pending, {
              id: event.requestId,
              sessionId: event.sessionId,
              provider,
              tool: event.tool,
              detail: event.detail,
              path: event.path,
              kind: "elevate",
              elevate: need,
            }),
            sessions: current.sessions.map((session) =>
              session.id === event.sessionId ? { ...session, status: "needs-input" } : session,
            ),
          }));
          return;
        }
        // The desk answers from the grant it handed this worker. A path-owned
        // worker launched at Ask so the preflight above could read its writes;
        // by here that check has passed, so an in-path write the desk already
        // decided to allow must not surface as a modal. Out-of-path writes
        // never reach this line — the preflight denied and returned.
        const granted = owner
          ? grantedPolicyAnswer({
              granted: owner.agentRun?.grantedAccess?.mode,
              sandbox: owner.sandbox,
              tool: event.tool,
              detail: event.detail,
              path: event.path,
            })
          : null;
        const allowed = forced ?? granted ?? autoAllowPermission({
          tool: event.tool,
          detail: event.detail,
          path: event.path,
          grants: owner?.permissionGrants,
        });
        if (allowed) {
          if (provider === "codex") void window.workhorse?.codexAnswerPermission?.(event.requestId, allowed);
          else if (provider === "claude") void window.workhorse?.claudeAnswerPermission?.(event.requestId, allowed);
          else if (provider === "cursor") void window.workhorse?.cursorAnswerPermission?.(event.requestId, allowed);
          else if (provider === "custom") void window.workhorse?.customAnswerPermission?.(event.requestId, allowed);
          else void window.workhorse?.grokAnswerPermission?.(event.requestId, allowed);
          setState((current) => ({
            ...current,
            pending: current.pending.filter((item) => item.id !== event.requestId),
            sessions: current.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    status: permissionResumeStatus({
                      hasOtherPending: current.pending.some(
                        (item) => item.sessionId === event.sessionId && item.id !== event.requestId,
                      ),
                      agentRun: session.agentRun,
                    }),
                    messages:
                      allowed === "deny"
                        ? [
                            ...session.messages,
                            {
                              id: uid("msg"),
                              role: "system" as const,
                              text: `Denied by ${security.boundary ?? (owner?.sandbox === "read-only" || owner?.sandbox === "strict" ? "sandbox" : "plan")}: ${event.tool} — ${event.detail}`,
                              createdAt: Date.now(),
                            },
                          ]
                        : session.messages,
                  }
                : session,
            ),
          }));
          return;
        }
        setState((current) => ({
          ...current,
          pending: enqueuePermission(current.pending, {
            id: event.requestId,
            sessionId: event.sessionId,
            provider,
            tool: event.tool,
            detail: event.detail,
            path: event.path,
          }),
          sessions: current.sessions.map((session) =>
            session.id === event.sessionId ? { ...session, status: "needs-input" } : session,
          ),
        }));
        return;
      }
      if (event.type === "usage") {
        const owner = stateRef.current.sessions.find((item) => item.id === event.sessionId);
        // A worker's report can arrive under its orchestrator's session, so the
        // session's provider is not enough on its own: a Kimi worker under a
        // Cursor chat filed as cursor/Kimi-K3 that way. The model names the bot.
        const home = usageHomeForReport(event, owner, stateRef.current.settings.customBots);
        const incoming: UsageDraft = {
          provider: home.provider,
          model: event.model,
          projectId: event.projectId,
          sessionId: event.sessionId,
          customBotId: home.customBotId,
          lane: home.provider === "cursor" ? cursorUsageLane(event.model) : undefined,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          costUsd: event.costUsd,
          contextUsed: event.contextUsed,
          source: event.source,
        };
        // A vendor's own subagent reports once, when it is already done, and
        // several can land inside a single parent turn. Book it now: queueing
        // would hand it to a fold that keeps one draft and drops the rest.
        // It carries this chat's session id, so it rolls up on this chat.
        if (incoming.source === "subagent") {
          if (usageHasBilledTokens(incoming)) recordUsage(incoming);
          return;
        }
        // A gauge has no tokens but carries the context and cost the turn
        // should end with, so it queues too; the fold books zero from it.
        if (usageHasBilledTokens(incoming) || (incoming.source === "gauge" && (incoming.contextUsed !== undefined || incoming.costUsd !== undefined))) {
          const pending = grokUsagePending.current[event.sessionId] ?? [];
          grokUsagePending.current[event.sessionId] = [...pending, incoming];
        }
        const liveSession = stateRef.current.sessions.find((item) => item.id === event.sessionId);
        if (liveSession?.agentRun?.status === "running") {
          const spend = applyWorkerBudgetUsage(liveSession.agentRun, event);
          const now = Date.now();
          const next = nextBudgetRunState(liveSession.agentRun, spend, now);
          if (next.action === "handoff" || next.action === "terminate") cancelVendorSession(liveSession);
          setState((current) => ({
            ...current,
            sessions: withSubagentStatus(
              current.sessions.map((session) => {
                if (session.id !== event.sessionId || !session.agentRun) return session;
                let agentRun: AgentRun = {
                  ...session.agentRun,
                  usedTokens: next.usedTokens,
                  budgetBaseline: next.budgetBaseline,
                  outputTokensTotal: next.outputTokensTotal,
                  cacheTokensTotal: next.cacheTokensTotal,
                  ...(next.budgetPhase ? { budgetPhase: next.budgetPhase } : {}),
                  ...(next.budgetWarnedAt ? { budgetWarnedAt: next.budgetWarnedAt } : {}),
                  ...(next.budgetHandoffAt ? { budgetHandoffAt: next.budgetHandoffAt } : {}),
                  ...(next.status === "budget-exceeded"
                    ? {
                        status: "budget-exceeded" as const,
                        finishedAt: next.finishedAt ?? now,
                        error: next.error,
                      }
                    : {}),
                };
                if (next.action !== "none" && next.notice) {
                  const type =
                    next.action === "terminate"
                      ? "budget-exceeded" as const
                      : next.action === "handoff"
                        ? "budget-verify" as const
                        : "budget-warn" as const;
                  agentRun = appendRunEvent(agentRun, { at: now, type, detail: next.notice });
                }
                const alreadyNoted =
                  !next.notice ||
                  session.messages.some((message) => message.role === "system" && message.text === next.notice);
                return {
                  ...session,
                  status: next.action === "terminate" ? "idle" : session.status,
                  agentRun,
                  messages:
                    next.notice && !alreadyNoted
                      ? [
                          ...session.messages,
                          {
                            id: uid("msg"),
                            role: "system" as const,
                            text: next.notice,
                            createdAt: now,
                          },
                        ]
                      : session.messages,
                };
              }),
              event.sessionId,
              next.action === "terminate" ? "failed" : "running",
            ),
          }));
        }
        const occupancy = occupancyFromUsage(
          incoming,
          liveSession ? contextWindowFor(liveSession.provider, liveSession.model) : 0,
        );
        if (occupancy !== undefined) {
          grokContextSeen.current[event.sessionId] = occupancy;
          setState((current) => ({
            ...current,
            sessions: current.sessions.map((session) =>
              session.id === event.sessionId ? { ...session, contextUsed: occupancy } : session,
            ),
          }));
        }
        return;
      }
      if (event.type === "done") {
        const safetyPaused = event.stopReason === "safety_pause";
        const pending = grokUsagePending.current[event.sessionId];
        delete grokUsagePending.current[event.sessionId];
        const session = stateRef.current.sessions.find((item) => item.id === event.sessionId);
        const settled = settleTurnUsage({
          pending: pending ?? [],
          provider: session?.provider ?? "grok",
          model: session?.model ?? "",
          projectId: session?.projectId ?? undefined,
          sessionId: event.sessionId,
          customBotId: session?.provider === "custom" ? session.customBotId : undefined,
          estimate: session
            ? estimateFromSessionTurn({
                messages: session.messages,
                assistantId: grokAssistantId.current[event.sessionId],
                queuedText: grokChunkQueue.current[event.sessionId] ?? "",
              })
            : undefined,
        });
        if (settled && usageHasBilledTokens(settled)) {
          recordUsage({
            ...settled,
            contextUsed: occupancyForSession(session, settled, grokContextSeen.current[event.sessionId]),
          });
        }
        const turn = learningTurns.current[event.sessionId];
        const assistantId = grokAssistantId.current[event.sessionId];
        if (turn && session && assistantId) {
          const evidence = agentTurnEvidence({
            messages: finishOpenToolMessages(session.messages, safetyPaused ? "failed" : "completed"),
            assistantId,
            outcome: safetyPaused ? "safety-paused" : "completed",
            queuedText: grokChunkQueue.current[event.sessionId],
            stopReason: event.stopReason,
            workedMs: Math.max(0, Date.now() - (session.messages.find((message) => message.id === assistantId)?.createdAt ?? Date.now())),
          });
          emitLearningEvent({
            id: learningEvidenceId("outcome", assistantId),
            kind: "outcome",
            actorClass: "agent",
            projectId: session.projectId,
            sessionId: session.id,
            provider: session.provider,
            model: session.model,
            customBotId: session.customBotId,
            effort: session.effort,
            correlationId: turn.correlationId,
            agentRunId: assistantId,
            toolIds: evidence.toolIds,
            payload: evidence.payload,
          });
          delete learningTurns.current[event.sessionId];
        }
        if (session?.provider === "cursor") {
          void window.workhorse?.cursorPlanUsage?.()
            .then((plan) => {
              setCursorPlan(plan ?? undefined);
              markVendorPlanKnown("cursor");
            })
            .catch(() => markVendorPlanKnown("cursor"));
        }
        setState((current) => {
          const queued = grokChunkQueue.current[event.sessionId] ?? "";
          delete grokChunkQueue.current[event.sessionId];
          const assistantId = grokAssistantId.current[event.sessionId];
          const liveRun = current.sessions.find((session) => session.id === event.sessionId)?.agentRun;
          const holdForHandoff =
            liveRun?.status === "running" &&
            (liveRun.budgetPhase === "verify" || liveRun.budgetPhase === "handoff");
          let sessions = current.sessions.map((session) => {
            if (session.id !== event.sessionId) return session;
            const messages = finishOpenToolMessages(
              failPeerAskMessages(
                assistantId
                  ? (() => {
                      // Did this turn leave anything behind? Thinking and tool
                      // calls land as their own messages after the assistant
                      // one, so ask the transcript rather than the message.
                      const worked = turnWorkedAfterAssistant(session.messages, assistantId);
                      return session.messages.map((message) => {
                        if (message.id !== assistantId) return message;
                        const text = (message.text ?? "").trim() || queued.trim();
                        return {
                          ...message,
                          text: assistantHasVisibleReply(text)
                            ? text
                            : turnEndedWithoutProse({
                                provider: session.provider,
                                stopReason: event.stopReason,
                                worked,
                              }),
                          workedMs: Math.max(0, Date.now() - message.createdAt),
                        };
                      });
                    })()
                  : session.messages,
                { error: "the other chat did not answer" },
              ),
              safetyPaused ? "failed" : "completed",
            );
            const reportedBlocked = Boolean(session.parentId) && workerReportedBlocked(childReportText({ messages }));
            const failed = safetyPaused || reportedBlocked;
            return applyVendorTurnIdle({
              ...session,
              scheduledRuns: (session.scheduledRuns ?? []).map((run) =>
                run.status === "running"
                  ? { ...run, status: failed ? ("failed" as const) : ("completed" as const) }
                  : run,
              ),
              messages,
            }, { assistantId, safetyPaused, failed, compacted: event.stopReason === "compacted" });
          });
          const finishedTurn = sessions.find((session) => session.id === event.sessionId);
          const reportedBlocked = Boolean(finishedTurn?.parentId) && workerReportedBlocked(childReportText(finishedTurn));
          const failed = safetyPaused || reportedBlocked;
          sessions = withSubagentStatus(
            sessions,
            event.sessionId,
            holdForHandoff ? "running" : failed ? "failed" : "completed",
          );
          const finished = sessions.find((session) => session.id === event.sessionId);
          if (finished?.parentId && !holdForHandoff) {
            sessions = applyChildIdleSync(sessions, event.sessionId, failed ? "failed" : "completed", {
              report: childReportText(finished),
              ...(safetyPaused
                ? { error: "Agent paused before completing its goal." }
                : reportedBlocked
                  ? { error: "Worker reported blocked." }
                  : {}),
            });
            const admitted = joinAdmit(sessions, finished.parentId, current, plansRef.current);
            queueMicrotask(() => {
              if (admitted.auditor) sendRef.current(admitted.auditor.brief, { sessionId: admitted.auditor.id, hideUser: true });
            });
            sessions = admitted.sessions;
          }
          return { ...current, sessions };
        });
        return;
      }
      if (event.type === "error") {
        const pending = grokUsagePending.current[event.sessionId];
        delete grokUsagePending.current[event.sessionId];
        const failedSession = stateRef.current.sessions.find((item) => item.id === event.sessionId);
        const settled = settleTurnUsage({
          pending: pending ?? [],
          provider: failedSession?.provider ?? "grok",
          model: failedSession?.model ?? "",
          projectId: failedSession?.projectId ?? undefined,
          sessionId: event.sessionId,
          customBotId: failedSession?.provider === "custom" ? failedSession.customBotId : undefined,
          estimate: failedSession
            ? estimateFromSessionTurn({
                messages: failedSession.messages,
                assistantId: grokAssistantId.current[event.sessionId],
                queuedText: grokChunkQueue.current[event.sessionId] ?? "",
              })
            : undefined,
        });
        if (settled && usageHasBilledTokens(settled)) {
          recordUsage({
            ...settled,
            contextUsed: occupancyForSession(failedSession, settled, grokContextSeen.current[event.sessionId]),
          });
        }
        const assistantId = grokAssistantId.current[event.sessionId];
        const turn = learningTurns.current[event.sessionId];
        if (turn && failedSession && assistantId) {
          const evidence = agentTurnEvidence({
            messages: finishOpenToolMessages(failedSession.messages, "failed", event.message),
            assistantId,
            outcome: "failed",
            queuedText: grokChunkQueue.current[event.sessionId],
            error: event.message,
            workedMs: Math.max(0, Date.now() - (failedSession.messages.find((message) => message.id === assistantId)?.createdAt ?? Date.now())),
          });
          emitLearningEvent({
            id: learningEvidenceId("outcome", assistantId),
            kind: "outcome",
            actorClass: "agent",
            projectId: failedSession.projectId,
            sessionId: failedSession.id,
            provider: failedSession.provider,
            model: failedSession.model,
            customBotId: failedSession.customBotId,
            effort: failedSession.effort,
            correlationId: turn.correlationId,
            agentRunId: assistantId,
            toolIds: evidence.toolIds,
            payload: evidence.payload,
          });
          delete learningTurns.current[event.sessionId];
        }
        setState((current) => {
          let sessions = withSubagentStatus(
            current.sessions.map((session) =>
              session.id === event.sessionId
                ? applyVendorTurnIdle({
                    ...session,
                    scheduledRuns: (session.scheduledRuns ?? []).map((run) =>
                      run.status === "running" ? { ...run, status: "failed" as const } : run,
                    ),
                    messages: finishOpenToolMessages(
                      session.messages.map((message) =>
                        message.id === assistantId && !message.text
                          ? isJoinAssistantTurn(session.messages, assistantId ?? "")
                            ? message
                            : {
                                ...message,
                                text: vendorFailedMessage(session.provider, event.message),
                              }
                          : message,
                      ),
                      "failed",
                      event.message,
                    ),
                  }, { assistantId, failed: true })
                : session,
            ),
            event.sessionId,
            "failed",
          );
          const failed = sessions.find((session) => session.id === event.sessionId);
          if (failed?.parentId) {
            sessions = applyChildIdleSync(sessions, event.sessionId, "failed", {
              report: childReportText(failed),
              error: event.message,
            });
            const admitted = joinAdmit(sessions, failed.parentId, current, plansRef.current);
            queueMicrotask(() => {
              if (admitted.auditor) sendRef.current(admitted.auditor.brief, { sessionId: admitted.auditor.id, hideUser: true });
            });
            sessions = admitted.sessions;
          }
          return { ...current, sessions };
        });
      }
      } catch (error) {
        console.error("workhorse vendor event failed", error);
      }
    };
    const offGrok = window.workhorse?.onGrokEvent?.(apply);
    const offCodex = window.workhorse?.onCodexEvent?.(apply);
    const offClaude = window.workhorse?.onClaudeEvent?.(apply);
    const offCursor = window.workhorse?.onCursorEvent?.(apply);
    const offCustom = window.workhorse?.onCustomEvent?.(apply);
    return () => {
      streamCommits.stop();
      offGrok?.();
      offCodex?.();
      offClaude?.();
      offCursor?.();
      offCustom?.();
    };
  }, [recordUsage]);

  const openSettings = useCallback((section?: SettingsSection) => {
    setState((current) => ({
      ...current,
      panel: "settings",
      settingsSection: section ?? current.settingsSection,
    }));
  }, []);

  const closeSettings = useCallback(() => {
    setState((current) => ({ ...current, panel: null }));
  }, []);

  const openAddBot = useCallback(() => {
    setState((current) => ({
      ...current,
      panel: "add-bot",
      settings: {
        ...current.settings,
        llms: { ...current.settings.llms, custom: structuredClone(EMPTY_CUSTOM_DRAFT) },
      },
    }));
  }, []);

  const closeAddBot = useCallback(() => {
    setState((current) => ({ ...current, panel: "settings", settingsSection: "llms" }));
  }, []);

  const setSettingsSection = useCallback((section: SettingsSection) => {
    setState((current) => ({ ...current, settingsSection: section }));
  }, []);

  const projectFolders = useCallback(() => {
    return stateRef.current.projects.flatMap((project) => project.folders.map((folder) => folder.path).filter(Boolean));
  }, []);

  /*
   * Keep the missing-folder set current. A folder can be moved or deleted while
   * the desk is open, and the answer decides where every agent runs, so this
   * re-checks whenever the linked folders change and again when the window is
   * focused — coming back from Finder after moving a repo is exactly when it
   * has gone stale.
   */
  const linkedFolderKey = state.projects.flatMap((project) => project.folders.map((folder) => folder.path)).join("\n");
  useEffect(() => {
    if (!window.workhorse?.missingFolders) return;
    let live = true;
    const refresh = async () => {
      const paths = projectFolders();
      if (paths.length === 0) {
        applyMissingFolders(NO_MISSING_FOLDERS);
        return;
      }
      try {
        const gone = await window.workhorse!.missingFolders!(paths);
        if (live) applyMissingFolders(new Set(gone));
      } catch {
        // A probe that cannot answer must not strand every chat: leaving the
        // set as it was keeps the previous, working choice.
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [linkedFolderKey, projectFolders, applyMissingFolders]);

  const listDeskSkills = useCallback(async () => {
    if (!window.workhorse?.listDeskSkills) return deskSkillsRef.current;
    const rows = await window.workhorse.listDeskSkills(projectFolders());
    if (sameDeskSkills(deskSkillsRef.current, rows)) return deskSkillsRef.current;
    deskSkillsRef.current = rows;
    setDeskSkills(rows);
    return rows;
  }, [projectFolders]);

  const refreshDeskSkills = useCallback(async () => {
    return listDeskSkills();
  }, [listDeskSkills]);

  useEffect(() => {
    if (!ready) return;
    void listDeskSkills();
  }, [ready, listDeskSkills]);

  const massSendVendor = useCallback(
    async (
      id: ProviderId,
      kind: DeskExportKind,
      options?: { customBotId?: string; botName?: string },
    ): Promise<DeskExportResult> => {
      if (!window.workhorse?.exportVendor) {
        return { ok: false, message: "Mass send runs in the Workhorse desktop window." };
      }
      const snapshot = stateRef.current;
      const result = await window.workhorse.exportVendor({
        provider: id,
        kind,
        sessions: snapshot.sessions,
        projects: snapshot.projects,
        projectFolders: projectFolders(),
        customBotId: options?.customBotId,
        botName: options?.botName,
      });
      if (result.ok && result.dest) void window.workhorse.revealProject?.(result.dest);
      return result;
    },
    [projectFolders],
  );

  const exportSession = useCallback(async (sessionId: string): Promise<DeskExportResult> => {
    if (!window.workhorse?.exportChat) {
      return { ok: false, message: "Export runs in the Workhorse desktop window." };
    }
    const snapshot = stateRef.current;
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    if (!session) return { ok: false, message: "That chat is gone." };
    const project = session.projectId ? snapshot.projects.find((item) => item.id === session.projectId) : undefined;
    const result = await window.workhorse.exportChat({ session, projectName: project?.name });
    if (result.ok && result.dest) void window.workhorse.revealProject?.(result.dest);
    return result;
  }, []);

  const importDeskSkill = useCallback(async (): Promise<DeskExportResult> => {
    if (!window.workhorse?.pickFolder || !window.workhorse.importSkill) {
      return { ok: false, message: "Import runs in the Workhorse desktop window." };
    }
    const from = await window.workhorse.pickFolder();
    if (!from) return { ok: false, canceled: true };
    return window.workhorse.importSkill(from.path);
  }, []);

  const readDeskSkill = useCallback(async (query: string) => {
    if (!window.workhorse?.readDeskSkill) return { ok: false, message: "Skill read runs in the Workhorse desktop window." };
    return window.workhorse.readDeskSkill(query, projectFolders());
  }, [projectFolders]);

  const deleteDeskSkill = useCallback(async (dir: string): Promise<DeskExportResult> => {
    if (!window.workhorse?.deleteSkill) return { ok: false, message: "Delete runs in the Workhorse desktop window." };
    return window.workhorse.deleteSkill(dir);
  }, []);

  const pushDeskSkill = useCallback(
    async (dir: string, target: "grok" | "codex" | "claude" | "cursor", name?: string): Promise<DeskExportResult> => {
      if (!window.workhorse?.pushSkill) return { ok: false, message: "Push runs in the Workhorse desktop window." };
      return window.workhorse.pushSkill({ dir, target, name });
    },
    [],
  );

  const updateProfile = useCallback((patch: Partial<Profile>) => {
    setState((current) => {
      const settings = current.settings ?? structuredClone(DEFAULT_SETTINGS);
      return {
        ...current,
        settings: {
          ...settings,
          profile: { ...settings.profile, ...patch },
        },
      };
    });
  }, []);

  const setLlmConnected = useCallback((id: Exclude<ProviderId, "custom">, connected: boolean) => {
    setState((current) => {
      const currentLink = current.settings.llms[id];
      return {
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            [id]: { ...currentLink, connected, ...(connected ? { enabled: true } : {}) },
          },
        },
        lastModel:
          !connected && current.lastModel.provider === id ? { ...DEFAULT_CHOICE } : current.lastModel,
      };
    });
  }, []);

  const setLlmEnabled = useCallback((id: Exclude<ProviderId, "custom">, enabled: boolean) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        llms: {
          ...current.settings.llms,
          [id]: { ...current.settings.llms[id], enabled },
        },
      },
    }));
  }, []);

  const updateLlmLink = useCallback(
    (id: Exclude<ProviderId, "custom">, patch: Partial<Pick<import("./types").LlmLink, "name" | "color">>) => {
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            [id]: applyUpdateStockBot(current.settings.llms[id], patch),
          },
        },
      }));
    },
    [],
  );

  const updateCustomLlm = useCallback((patch: Partial<CustomLlm>) => {
    setState((current) => {
      const custom = { ...current.settings.llms.custom, ...patch, connected: false };
      if (patch.baseUrl !== undefined || patch.model !== undefined || patch.apiKey !== undefined) {
        custom.tested = patch.tested ?? false;
      }
      return {
        ...current,
        settings: {
          ...current.settings,
          llms: { ...current.settings.llms, custom },
        },
      };
    });
  }, []);

  const probeCustomDraft = useCallback(async () => {
    const draft = stateRef.current.settings.llms.custom;
    if (!window.workhorse?.probeCustom) return { ok: false, message: "Restart Workhorse to test this API." };
    const result = await window.workhorse.probeCustom({
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      model: draft.model,
      api: draft.api,
    });
    // Ask the provider what it serves. Synthetic sells many models behind one
    // key and one quota, and typing one id by hand made each its own bot —
    // which draws one leftover ring per bot from a single shared pool.
    //
    // This is the offer, not the choice. The owner ticks what they want; a
    // chat should never reach a model nobody approved. A provider that
    // publishes no /models simply keeps the id that was typed.
    const listed = result.ok && window.workhorse?.customModels
      ? await window.workhorse.customModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey }).catch(() => [])
      : [];
    const discovered = normalizeCustomModelList(listed);
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        llms: {
          ...current.settings.llms,
          custom: {
            ...current.settings.llms.custom,
            tested: result.ok,
            contextWindow: result.contextWindow ?? current.settings.llms.custom.contextWindow,
            api: result.api ?? current.settings.llms.custom.api,
            model: result.model ?? current.settings.llms.custom.model,
            ...(discovered ? { discovered } : {}),
          },
        },
      },
    }));
    const offered = discovered ? discovered.filter((id) => id !== (result.model ?? draft.model)).length : 0;
    return {
      ok: result.ok,
      message:
        offered > 0
          ? `${result.message} This key also serves ${offered} other model${offered === 1 ? "" : "s"} — tick the ones you want.`
          : result.message,
    };
  }, []);

  const createCustomBot = useCallback(() => {
    const draft = stateRef.current.settings.llms.custom;
    if (!draftReady(draft)) return null;
    const bot = botFromDraft(draft);
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        customBots: [...current.settings.customBots, bot],
        llms: { ...current.settings.llms, custom: structuredClone(EMPTY_CUSTOM_DRAFT) },
      },
    }));
    return bot.id;
  }, []);

  const installCustomBot = useCallback((draft: CustomLlm) => {
    if (!draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
      return { ok: false, created: false, error: "Need a base URL, model, and API key to create a desk slot." };
    }
    const installed = applyInstallCustomBot(stateRef.current.settings.customBots, draft);
    setState((current) => ({
      ...current,
      settings: { ...current.settings, customBots: installed.bots },
    }));
    return { ok: true, created: installed.created, bot: publicBotCard(installed.bot) };
  }, []);

  const deleteCustomBot = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        customBots: current.settings.customBots.filter((bot) => bot.id !== id),
      },
      lastModel:
        current.lastModel.customBotId === id
          ? { ...DEFAULT_CHOICE }
          : current.lastModel,
      sessions: current.sessions.map((session) =>
        session.customBotId === id ? { ...session, customBotId: undefined } : session,
      ),
    }));
  }, []);

  const updateCustomBot = useCallback((id: string, patch: Partial<CustomBot>) => {
    setState((current) => {
      const customBots = applyUpdateCustomBot(current.settings.customBots, id, patch);
      const bot = customBots.find((item) => item.id === id);
      const repairModel = (model: string) => bot && customBotServes(bot, model) ? model : bot?.model ?? model;
      return {
        ...current,
        settings: { ...current.settings, customBots },
        lastModel:
          current.lastModel.customBotId === id
            ? { ...current.lastModel, model: repairModel(current.lastModel.model) }
            : current.lastModel,
        sessions: current.sessions.map((session) =>
          session.customBotId === id ? { ...session, model: repairModel(session.model) } : session,
        ),
      };
    });
  }, []);

  const probeCustomBot = useCallback(async (id: string) => {
    const bot = stateRef.current.settings.customBots.find((item) => item.id === id);
    if (!bot) return { ok: false, message: "That bot is gone." };
    if (!window.workhorse?.probeCustom) return { ok: false, message: "Restart Workhorse to test this API." };
    const result = await window.workhorse.probeCustom({
      baseUrl: bot.baseUrl,
      apiKey: bot.apiKey,
      model: bot.model,
      api: bot.api,
    });
    // Same as a new connection: ask what else this key serves, and cache the
    // offer so more models can be approved later without testing again.
    const listed = result.ok && window.workhorse?.customModels
      ? await window.workhorse.customModels({ baseUrl: bot.baseUrl, apiKey: bot.apiKey }).catch(() => [])
      : [];
    const discovered = normalizeCustomModelList(listed);
    if (result.ok) {
      updateCustomBot(id, {
        ...(result.contextWindow ? { contextWindow: result.contextWindow } : {}),
        ...(result.api ? { api: result.api } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(discovered ? { discovered } : {}),
      });
    }
    const offered = discovered ? discovered.filter((item) => item !== (result.model ?? bot.model)).length : 0;
    return {
      ok: result.ok,
      message:
        offered > 0
          ? `${result.message} This key also serves ${offered} other model${offered === 1 ? "" : "s"} — tick the ones you want.`
          : result.message,
    };
  }, [updateCustomBot]);

  const setCustomBotEnabled = useCallback((id: string, enabled: boolean) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        customBots: current.settings.customBots.map((bot) => (bot.id === id ? { ...bot, enabled } : bot)),
      },
    }));
  }, []);

  const refreshCustomLogin = useCallback(() => {
    void (async () => {
      const detected = window.workhorse?.detectCustomLogin
        ? await window.workhorse.detectCustomLogin()
        : { connected: false, source: "none" as const, config: stateRef.current.settings.llms.custom, models: [] };
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            custom: detected.config.apiKey
              ? { ...EMPTY_CUSTOM_DRAFT, ...detected.config, connected: false, tested: false }
              : { ...current.settings.llms.custom, connected: false },
          },
        },
      }));
    })();
  }, []);

  const setTheme = useCallback((theme: Theme) => {
    setState((current) => {
      if (theme === "workhorse") {
        return {
          ...current,
          theme,
          themeReturn:
            current.theme === "workhorse"
              ? current.themeReturn
              : isConcreteTheme(current.theme)
                ? current.theme
                : "system",
        };
      }
      return { ...current, theme, themeReturn: undefined };
    });
  }, []);

  const openUsage = useCallback(() => {
    setState((current) => ({ ...current, panel: "settings", settingsSection: "usage" }));
  }, []);

  const closeUsage = useCallback(() => {
    setState((current) => ({ ...current, panel: null }));
  }, []);

  const setUsageRange = useCallback((range: UsageRange) => {
    setState((current) => ({ ...current, usageRange: range }));
  }, []);

  const setSidebarWidth = useCallback((width: number) => {
    setState((current) => ({ ...current, sidebarWidth: clampPaneWidth(width, SIDEBAR_PANE) }));
  }, []);

  const setThreadWidth = useCallback((width: number) => {
    setState((current) => ({ ...current, threadWidth: clampPaneWidth(width, THREAD_PANE) }));
  }, []);

  const refreshGrokPlan = useCallback(() => {
    if (!window.workhorse?.grokPlanUsage) return;
    void window.workhorse
      .grokPlanUsage()
      .then((plan) => {
        setGrokPlan(plan);
        markVendorPlanKnown("grok");
      })
      .catch(() => {
        setGrokPlan(undefined);
        markVendorPlanKnown("grok");
      });
  }, [markVendorPlanKnown]);

  const refreshCodexPlan = useCallback(() => {
    if (!window.workhorse?.codexPlanUsage) return;
    void window.workhorse
      .codexPlanUsage()
      .then((plan) => {
        setCodexPlan(plan);
        markVendorPlanKnown("codex");
      })
      .catch(() => {
        setCodexPlan(undefined);
        markVendorPlanKnown("codex");
      });
  }, [markVendorPlanKnown]);

  const refreshCursorPlan = useCallback(() => {
    if (!window.workhorse?.cursorPlanUsage) {
      setCursorPlan(undefined);
      return;
    }
    void window.workhorse
      .cursorPlanUsage()
      .then((plan) => {
        setCursorPlan(plan ?? undefined);
        markVendorPlanKnown("cursor");
      })
      .catch(() => {
        setCursorPlan(undefined);
        markVendorPlanKnown("cursor");
      });
  }, [markVendorPlanKnown]);

  const refreshClaudePlan = useCallback(() => {
    if (!window.workhorse?.claudePlanUsage) return;
    void window.workhorse
      .claudePlanUsage()
      .then((plan) => {
        setClaudePlan(plan);
        markVendorPlanKnown("claude");
        if (plan) {
          if (claudePlanRetry.current) window.clearTimeout(claudePlanRetry.current);
          claudePlanRetry.current = null;
          return;
        }
        if (claudePlanRetry.current) return;
        claudePlanRetry.current = window.setTimeout(() => {
          claudePlanRetry.current = null;
          void window.workhorse?.claudePlanUsage?.().then((again) => {
            if (again) setClaudePlan(again);
          });
        }, 90_000);
      })
      .catch(() => {
        setClaudePlan(undefined);
        markVendorPlanKnown("claude");
      });
  }, [markVendorPlanKnown]);

  const refreshCustomPlans = useCallback(() => {
    if (!window.workhorse?.customPlanUsage) return;
    for (const bot of stateRef.current.settings.customBots) {
      void window.workhorse
        .customPlanUsage({
          baseUrl: bot.baseUrl,
          apiKey: bot.apiKey,
          model: bot.model,
          credentialId: bot.credentialId || `custom-bot-${bot.id}`,
        })
        .then((plan) => {
          setCustomPlans((current) => ({ ...current, [bot.id]: plan ?? undefined }));
          setCustomPlanKnown((current) => ({ ...current, [bot.id]: true }));
        })
        .catch(() => {
          setCustomPlans((current) => {
            const next = { ...current };
            delete next[bot.id];
            return next;
          });
          setCustomPlanKnown((current) => ({ ...current, [bot.id]: true }));
        });
    }
  }, []);

  useEffect(() => {
    if (ready) {
      refreshGrokPlan();
      refreshCodexPlan();
      refreshClaudePlan();
      refreshCursorPlan();
      refreshCustomPlans();
    }
  }, [ready, refreshGrokPlan, refreshCodexPlan, refreshClaudePlan, refreshCursorPlan, refreshCustomPlans]);

  const setUsageBudget = useCallback((provider: ProviderId, tokens: number | null) => {
    setState((current) => {
      const usageBudgets = { ...current.settings.usageBudgets };
      if (tokens && tokens > 0) usageBudgets[provider] = Math.round(tokens);
      else delete usageBudgets[provider];
      return { ...current, settings: { ...current.settings, usageBudgets } };
    });
  }, []);

  const updateWatch = useCallback((patch: Partial<WatchSettings>) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        watch: normalizeWatch({ ...current.settings.watch, ...patch }),
      },
    }));
  }, []);

  const updateRouting = useCallback((patch: Partial<RoutingSettings>) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        routing: normalizeRouting({ ...current.settings.routing, ...patch }),
      },
    }));
  }, []);

  const updateAgentSystems = useCallback((patch: Partial<AgentSystemsSettings>) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        agentSystems: normalizeAgentSystems({
          inboundSessionId: patch.inboundSessionId ?? "",
          inboundProjectId: patch.inboundProjectId ?? "",
        }),
      },
    }));
  }, []);

  const updateLocalCompute = useCallback((settings: import("./types").LocalComputeSettings) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        localCompute: { ...normalizeLocalComputeSettings(settings), legacyEnvironmentFallback: false },
      },
    }));
  }, []);

  const grantPlanExternalAgents = useCallback((sessionId: string, allow: boolean) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((session) => {
        if (session.id !== sessionId || !session.planRun) return session;
        return {
          ...session,
          planRun: allow ? grantExternalAgents(session.planRun) : revokeExternalAgents(session.planRun),
        };
      }),
    }));
  }, []);

  const [agentRuntimes, setAgentRuntimes] = useState<import("./external-catalog").AgentRuntimeStatus[]>([]);
  const [agentCatalog, setAgentCatalog] = useState<import("./external-catalog").ExternalAgent[]>([]);

  const refreshAgentRuntimes = useCallback(async () => {
    const result = await window.workhorse?.detectAgentRuntimes?.();
    if (!result) return;
    setAgentRuntimes(result.statuses ?? []);
    agentRuntimesRef.current = result.statuses ?? [];
    agentCatalogRef.current = result.agents ?? [];
    setAgentCatalog(agentCatalogRef.current);
  }, []);

  useEffect(() => {
    if (ready) void refreshAgentRuntimes();
  }, [ready, refreshAgentRuntimes]);

  const installExternalMcp = useCallback(async (hosts?: string[]) => {
    const result = await window.workhorse?.installExternalMcp?.(hosts);
    return result ?? { ok: false, message: "Workhorse desktop only." };
  }, []);

  const linkConfig = useCallback(async () => {
    return (await window.workhorse?.linkConfig?.()) ?? "";
  }, []);

  const linkGrokBotOneshot = useCallback(async () => {
    return (await window.workhorse?.linkGrokBotOneshot?.()) ?? "";
  }, []);

  const [grokBotWakeStatus, setGrokBotWakeStatus] = useState<GrokBotWakeStatus | null>(null);
  const refreshGrokBotWake = useCallback(async () => {
    const status = await window.workhorse?.grokBotWakeStatus?.() ?? {
      configured: false,
      shimReachable: false,
      ready: false,
      message: "Workhorse desktop only.",
    };
    setGrokBotWakeStatus(status);
    return status;
  }, []);
  const saveGrokBotWake = useCallback(async (input: GrokBotWakeInput) => {
    const status = await window.workhorse?.saveGrokBotWake?.(input) ?? {
      configured: false,
      shimReachable: false,
      ready: false,
      message: "Workhorse desktop only.",
    };
    setGrokBotWakeStatus(status);
    return status;
  }, []);

  useEffect(() => {
    if (ready) void refreshGrokBotWake();
  }, [ready, refreshGrokBotWake]);

  const installLinkCommand = useCallback(async () => {
    const result = await window.workhorse?.installLinkCommand?.();
    return result ?? { ok: false, message: "Workhorse desktop only." };
  }, []);

  const updateLearning = useCallback((patch: Partial<import("./learning-types").LearningSettings>) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        learning: normalizeLearning({ ...current.settings.learning, ...patch }),
      },
    }));
  }, []);

  const denyWatchHold = useCallback(() => {
    setWatchHold((current) => {
      if (current) setWatchRestore({ text: current.restoreText ?? current.text, images: current.images });
      return null;
    });
  }, []);

  const clearWatchRestore = useCallback(() => {
    setWatchRestore(null);
  }, []);

  const permitWatchHold = useCallback(
    (kind: "once" | "conversation" | "until-reset") => {
      const hold = watchHold;
      const sessionId = hold?.sessionId ?? stateRef.current.activeSessionId;
      const key = hold?.key ?? (sessionId
        ? watchKeyForSession(stateRef.current.sessions.find((item) => item.id === sessionId) ?? { provider: "grok", model: "" })
        : null);
      if (kind === "until-reset" && key) {
        setState((current) => ({
          ...current,
          watchPermits: {
            ...current.watchPermits,
            [key]: { ...current.watchPermits[key], day: dayKey() },
          },
        }));
      }
      if (kind === "conversation" && key && sessionId) {
        const today = dayKey();
        setState((current) => ({
          ...current,
          watchPermits: {
            ...current.watchPermits,
            [key]: {
              ...current.watchPermits[key],
              sessions: { ...current.watchPermits[key]?.sessions, [sessionId]: today },
            },
          },
        }));
      }
      setWatchHold(null);
      if (!hold?.text.trim() && !(hold?.images && hold.images.length > 0)) return;
      send(hold.text, {
        images: hold.images,
        replaceUserId: hold.replaceUserId,
        steer: hold.steer,
        permit: true,
        hideUser: hold.hideUser,
      });
    },
    [send, watchHold],
  );

  const watchStatuses = useMemo(
    () =>
      watchVendorStatuses({
        settings: state.settings,
        usage: state.usage,
        plans: { grok: grokPlan, codex: codexPlan, claude: claudePlan, cursor: cursorPlan, custom: customPlans },
        permits: state.watchPermits,
        dayMarks: state.watchDayMarks,
      }),
    [state.settings, state.usage, state.watchPermits, state.watchDayMarks, grokPlan, codexPlan, claudePlan, customPlans],
  );

  const watchNotices = useMemo(() => collectWatchNotices(watchStatuses), [watchStatuses]);

  useEffect(() => {
    const leftovers = leftoverByWatchKey(watchStatuses);
    const marks = syncWatchDayMarks(state.watchDayMarks ?? {}, leftovers);
    const permits = pruneWatchPermits(state.watchPermits);
    if (marks === state.watchDayMarks && permits === state.watchPermits) return;
    setState((current) => ({
      ...current,
      watchDayMarks: marks,
      watchPermits: permits,
    }));
  }, [state.watchPermits, state.watchDayMarks, watchStatuses]);

  const cancelRun = useCallback(() => {
    setState((current) => {
      const id = current.activeSessionId;
      const targets = id ? new Set([id, ...descendantSessionIds(current.sessions, id)]) : new Set<string>();
      const now = Date.now();
      for (const child of current.sessions) {
        if (targets.has(child.id) && child.status === "running") cancelVendorSession(child);
      }
      let sessions = current.sessions.map((session) => {
        if (!targets.has(session.id) || session.status !== "running") return session;
        return {
          ...session,
          status: "idle" as const,
          agentRun: session.agentRun ? {
            ...session.agentRun,
            status: "cancelled" as const,
            finishedAt: now,
            error: "Cancelled with its parent lifecycle.",
          } : undefined,
        };
      });
      for (const session of current.sessions) {
        if (!targets.has(session.id) || !session.parentId) continue;
        if (session.status !== "running" && session.agentRun?.status !== "running") continue;
        sessions = applyChildIdleSync(sessions, session.id, "cancelled", { now });
      }
      return { ...current, sessions };
    });
  }, []);

  const quit = useCallback(() => {
    void window.workhorse?.quit();
  }, []);

  const checkAppUpdate = useCallback(async (opts?: { reveal?: boolean }): Promise<AppUpdateCheckResult> => {
    if (!window.workhorse?.checkAppUpdate) {
      return { offer: null, error: "Restart Workhorse once so it can check for updates." };
    }
    const result = await window.workhorse.checkAppUpdate();
    if (result.error) {
      setAppUpdate(null);
      return result;
    }
    const offer = result.offer && result.offer.version !== APP_VERSION ? result.offer : null;
    setAppUpdate(() => {
      if (!offer) return null;
      if (!opts?.reveal && offer.version === stateRef.current.dismissedUpdateVersion) return null;
      return offer;
    });
    return { offer };
  }, []);

  const applyAppUpdate = useCallback(async (version?: string) => {
    const wanted = version ?? appUpdate?.version;
    if (!wanted || appUpdateBusy) return;
    if (!window.workhorse?.applyAppUpdate) {
      setAppUpdateError("Restart Workhorse once so it can install updates in place.");
      return;
    }
    setAppUpdateBusy(true);
    setAppUpdateError(null);
    const result = await window.workhorse.applyAppUpdate(wanted);
    if (result.ok) return;
    setAppUpdateBusy(false);
    setAppUpdateError(result.message);
  }, [appUpdate, appUpdateBusy]);

  useEffect(() => {
    if (!ready) return;
    void checkAppUpdate().catch(() => {});
    const timer = window.setInterval(() => void checkAppUpdate().catch(() => {}), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [ready, checkAppUpdate]);

  useEffect(() => {
    void window.workhorse?.learningConfigure?.(state.settings);
  }, [state.settings.learning, state.settings.customBots]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const due = stateRef.current.sessions.filter(
        (session) => session.goal && !session.goal.terminal && session.goal.deadlineAt && Date.now() >= session.goal.deadlineAt,
      );
      if (due.length === 0) return;
      for (const session of due) {
        if (session.status === "running" || session.status === "needs-input") cancelVendorSession(session);
      }
      setState((current) => {
        const settled = settleSessionGoals(current.sessions);
        if (!settled.changed) return current;
        return { ...current, sessions: settled.sessions };
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const value = useMemo<Store>(
    () => ({
      ...state,
      ready,
      catalogRev,
      deskSkills,
      createProject,
      openSheet,
      closeSheet,
      selectProject,
      linkFolder,
      unlinkFolder,
      addReference,
      removeReference,
      archiveProject,
      deleteProject,
      startSession,
      setSessionModel,
      setSessionRoutingMode,
      setCrewMode,
      resumeAgentRun,
      createCustomBot,
      installCustomBot,
      deleteCustomBot,
      updateCustomBot,
      setCustomBotEnabled,
      probeCustomDraft,
      probeCustomBot,
      setSessionEffort,
      setSessionEnvironment,
      selectSession,
      setComposerDraft,
      renameSession,
      deleteSession,
      deleteWorkers,
      archiveSession,
      moveSession,

      forkFrom,
      send,
      dropQueued,
      steerQueued,
      resendFrom,
      editMessageId,
      requestEditMessage,
      requestEditLastPrompt,
      clearEditMessage,
      cancelRun,
      setMode,
      setDeskAccess,
      setSandbox,
      setSecurityPolicy,
      setMcpServers,
      probeMcpServer,
      refreshGrokLogin,
      refreshCodexLogin,
      refreshClaudeLogin,
      refreshCursorLogin,
      refreshCustomLogin,
      cycleTheme,
      toggleWorkhorseTheme,
      answerPermission,
      demoPermission,
      recordUsage,
      openSettings,
      closeSettings,
      openAddBot,
      closeAddBot,
      setSettingsSection,
      folderExists,
      missingFolderPaths,
      listDeskSkills,
      refreshDeskSkills,
      massSendVendor,
      exportSession,
      importDeskSkill,
      readDeskSkill,
      deleteDeskSkill,
      pushDeskSkill,
      updateProfile,
      setLlmConnected,
      setLlmEnabled,
      updateLlmLink,
      updateCustomLlm,
      setTheme,
      openUsage,
      closeUsage,
      setUsageRange,
      setSidebarWidth,
      setThreadWidth,
      setUsageBudget,
      updateWatch,
      updateRouting,
      updateAgentSystems,
      updateLocalCompute,
      grantPlanExternalAgents,
      agentRuntimes,
      agentCatalog,
      refreshAgentRuntimes,
      installExternalMcp,
      linkConfig,
      linkGrokBotOneshot,
      grokBotWakeStatus,
      refreshGrokBotWake,
      saveGrokBotWake,
      installLinkCommand,
      updateLearning,
      watchNotices,
      watchHold,
      watchRestore,
      permitWatchHold,
      denyWatchHold,
      clearWatchRestore,
      grokPlan,
      refreshGrokPlan,
      codexPlan,
      refreshCodexPlan,
      claudePlan,
      refreshClaudePlan,
      cursorPlan,
      refreshCursorPlan,
      customPlans,
      customPlanKnown,
      vendorPlanKnown,
      refreshCustomPlans,
      quit,
      appUpdate,
      appUpdateBusy,
      appUpdateError,
      checkAppUpdate,
      applyAppUpdate,
    }),
    [
      state,
      ready,
      catalogRev,
      deskSkills,
      // A folder dying is a redraw: without this the memo holds the old set and
      // Project Home never hears about it.
      missingFolderPaths,
      createProject,
      openSheet,
      closeSheet,
      selectProject,
      linkFolder,
      unlinkFolder,
      addReference,
      removeReference,
      archiveProject,
      deleteProject,
      startSession,
      setSessionModel,
      setSessionRoutingMode,
      setCrewMode,
      resumeAgentRun,
      createCustomBot,
      installCustomBot,
      deleteCustomBot,
      updateCustomBot,
      setCustomBotEnabled,
      probeCustomDraft,
      probeCustomBot,
      setSessionEffort,
      setSessionEnvironment,
      selectSession,
      setComposerDraft,
      renameSession,
      deleteSession,
      deleteWorkers,
      archiveSession,
      moveSession,

      forkFrom,
      send,
      dropQueued,
      steerQueued,
      resendFrom,
      editMessageId,
      requestEditMessage,
      requestEditLastPrompt,
      clearEditMessage,
      cancelRun,
      setMode,
      setDeskAccess,
      setSandbox,
      setSecurityPolicy,
      setMcpServers,
      probeMcpServer,
      refreshGrokLogin,
      refreshCodexLogin,
      refreshClaudeLogin,
      refreshCursorLogin,
      refreshCustomLogin,
      cycleTheme,
      toggleWorkhorseTheme,
      answerPermission,
      demoPermission,
      recordUsage,
      openSettings,
      closeSettings,
      openAddBot,
      closeAddBot,
      setSettingsSection,
      listDeskSkills,
      refreshDeskSkills,
      massSendVendor,
      exportSession,
      importDeskSkill,
      readDeskSkill,
      deleteDeskSkill,
      pushDeskSkill,
      updateProfile,
      setLlmConnected,
      setLlmEnabled,
      updateLlmLink,
      updateCustomLlm,
      setTheme,
      openUsage,
      closeUsage,
      setUsageRange,
      setSidebarWidth,
      setThreadWidth,
      setUsageBudget,
      updateWatch,
      updateRouting,
      updateAgentSystems,
      updateLocalCompute,
      grantPlanExternalAgents,
      agentRuntimes,
      agentCatalog,
      refreshAgentRuntimes,
      installExternalMcp,
      linkConfig,
      linkGrokBotOneshot,
      grokBotWakeStatus,
      refreshGrokBotWake,
      saveGrokBotWake,
      installLinkCommand,
      updateLearning,
      watchNotices,
      watchHold,
      watchRestore,
      permitWatchHold,
      denyWatchHold,
      clearWatchRestore,
      grokPlan,
      refreshGrokPlan,
      codexPlan,
      refreshCodexPlan,
      claudePlan,
      refreshClaudePlan,
      cursorPlan,
      refreshCursorPlan,
      customPlans,
      customPlanKnown,
      vendorPlanKnown,
      refreshCustomPlans,
      quit,
      appUpdate,
      appUpdateBusy,
      appUpdateError,
      checkAppUpdate,
      applyAppUpdate,
    ],
  );

  selectorStore.current = value;
  useLayoutEffect(() => {
    for (const listener of selectorListeners.current) listener();
  }, [value]);

  return (
    <StoreRuntimeContext.Provider value={selectorRuntime}>
      <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
    </StoreRuntimeContext.Provider>
  );
}

export function useActiveProject() {
  const store = useStore();
  return store.projects.find((project) => project.id === store.activeProjectId) ?? null;
}

export function useActiveSession() {
  const store = useStore();
  return store.sessions.find((session) => session.id === store.activeSessionId) ?? null;
}

export function useProjectSessions(projectId: string | null, archived = false) {
  const store = useStore();
  if (!projectId) return [];
  return store.sessions.filter((session) => sidebarKeepsChat(session, { projectId, archived }));
}

/** Chats with no project. Same rule as the project list — see sidebarKeepsChat. */
export function useLooseSessions(archived = false) {
  const store = useStore();
  return store.sessions.filter((session) => sidebarKeepsChat(session, { projectId: null, archived }));
}
