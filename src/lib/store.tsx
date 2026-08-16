import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StoreContext, useStore } from "./store-context";
export { useStore };
import { commandContinuesToVendor, commandsForSession, matchCommand } from "./commands";
import { grokGoalAfterTurnIdle, parseGoalInput, parseGrokGoalLine } from "./goal";
import { nextGoalForSend, planHaltForward, prepareVendorSend, vendorTerminalAction } from "./vendor-send";
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
  isDraftChat,
  lastUserMessage,
  applyDeleteDeskChat,
  applyDeleteLooseDeskChats,
  isLooseDeleteScope,
  applyRenameDeskChat,
  listedChats,
  moveChat,
  resolveListedChat,
  openDraft,
  renameChat,
  rewindToUserMessage,
  shiftQueuedPrompt,
} from "./chats";
import { autoTitleForSend, isDefaultTitle, suggestedTitleForSession } from "./titles";
import {
  applyPermissionAnswer,
  autoAllowPermission,
  describeElevation,
  elevationForBlock,
  enqueuePermission,
  classifyElevationInput,
  parseElevationInput,
  permissionPolicyAnswer,
  securityPolicyAnswer,
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
  draftReady,
  EMPTY_CUSTOM_DRAFT,
} from "./custom-bots";
import {
  DEFAULT_CHOICE,
  applyVendorCatalog,
  contextWindowFor,
  defaultModel,
  findChoice,
  parseEffort,
  withEffort,
} from "./models";
import { joinChatText, mergeStreamedText } from "./markdown";
import { APP_VERSION } from "./app-info";
import type { AppUpdateOffer } from "./app-update";
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
} from "./project";
import { projectEdits } from "./project-edits";
import { providerById } from "./providers";
import { sameDeskSkills } from "./skills-catalog";
import {
  applyUpdateStockBot,
  DEFAULT_SETTINGS,
  firstAttachedChoice,
  isSettingsSection,
  normalizeSettings,
  normalizeRouting,
  vendorAttachedForSession,
} from "./settings";
import { chooseRoutingDecision, routingCandidatesForDesk, routingProfileForModel } from "./routing";
import {
  approvePlanRun,
  assignPlanStep,
  blockPlanRun,
  cancelPlanRun,
  completePlanRun,
  normalizePlanRun,
  pausePlanRun,
  readyPlanStepIds,
  recordPlanEvidence,
  recordPlanEvent,
  resumePlanRun,
  setPlanStepStatus,
  startPlanRun,
} from "./plan";
import {
  applyCompactUsage,
  applyFailedPeerAsk,
  failPeerAskMessages,
  finishOpenToolMessages,
  upsertCompactMessage,
  upsertThoughtMessage,
  upsertToolMessage,
} from "./grok-events";
import { chatPreview, formatPeerPrompt, sameSessionCrew } from "./session-bridge";
import {
  addLineupRow,
  applyChildIdleSync,
  awaitAgentsWaits,
  childReportText,
  emptyLineup,
  formatAwaitAgentsSnapshot,
  lineupSnapshot,
  applyJoinRateLimitRetry,
  isJoinAssistantTurn,
  JOIN_MAX_ATTEMPTS,
  looksLikeJoinPrompt,
  maybeEnqueueLineupJoin,
  reconcileIdleChildren,
  stampLineupUserText,
} from "./lineup";
import {
  admitSpawn,
  collectChildAgentReports,
  deskRoleOf,
  descendantSessionIds,
  formatWorkerPrompt,
  isHiddenSession,
  nestedSpawnError,
  NESTED_AGENT_MODEL,
  overlappingAgentFiles,
  parentHasRunningChildren,
  rootSpawnError,
  resolveSpawnSpec,
  shouldAutoRouteSpawn,
  spawnWaitsForReply,
  withSubagentStatus,
} from "./subagents";
import {
  applySessionModelChange,
  applySessionPolicyChange,
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
import { hasSendableAttachment } from "./images";
import { buildSessionPreface } from "./context-preface";
import {
  applyUsageContext,
  finalizeTurnUsage,
  normalizeUsage,
  occupancyFromUsage,
  rehomeCustomUsage,
  usageHasBilledTokens,
  usageProviderForSession,
} from "./usage";
import { clampPaneWidth, SIDEBAR_PANE, THREAD_PANE } from "./pane";
import { isVendorRateLimitError, vendorEmptyReply, vendorFailedMessage, vendorRateLimitNotice, vendorSendTarget } from "./vendor-bridge";
import { cursorUsageLane } from "./cursor-lane";
import {
  collectWatchNotices,
  dismissStamp,
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
  normalizeWatchDismissed,
  normalizeWatchDayMarks,
  normalizeWatchPermits,
  pruneWatchPermits,
  syncWatchDayMarks,
  watchVendorStatuses,
  type WatchHold,
  type WatchNotice,
} from "./watch";
import { applyWorkhorseToggle, isConcreteTheme, isTheme, nextTheme } from "./theme";
import type {
  AppState,
  CustomBot,
  CustomLlm,
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
  dismissedAttention: [],
  sheet: null,
  panel: null,
  settingsSection: "profile",
  settings: structuredClone(DEFAULT_SETTINGS),
  watchPermits: {},
  watchDismissed: {},
  watchDayMarks: {},
  usage: [],
  usageRange: "month",
  sidebarWidth: SIDEBAR_PANE.fallback,
  threadWidth: THREAD_PANE.fallback,
  lastModel: DEFAULT_CHOICE,
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
  setComposerDraft: (id: string, text: string, images?: import("./types").ChatImage[]) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  deleteWorkers: (parentId: string) => void;
  archiveSession: (id: string, archived?: boolean) => void;
  moveSession: (id: string, projectId: string) => void;
  dismissAttention: (id: string) => void;
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
  setSandbox: (sandbox: SandboxProfile) => void;
  setSecurityPolicy: (patch: Partial<SessionSecurityPolicy>) => void;
  setMcpServers: (servers: McpServerConfig[]) => void;
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
  pushDeskSkill: (dir: string, target: "grok" | "codex" | "claude", name?: string) => Promise<DeskExportResult>;
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
  watchNotices: WatchNotice[];
  watchHold: WatchHold | null;
  watchRestore: { text: string; images?: import("./types").ChatImage[] } | null;
  dismissWatchNotice: (notice: WatchNotice) => void;
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
  refreshCustomPlans: () => void;
  quit: () => void;
  appUpdate: AppUpdateOffer | null;
  appUpdateBusy: boolean;
  appUpdateError: string | null;
  checkAppUpdate: () => Promise<void>;
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

function hydrate(value: unknown): AppState {
  if (!value || typeof value !== "object") return EMPTY;
  const record = value as Partial<AppState> & { projects?: unknown[] };
  const projects = Array.isArray(record.projects)
    ? record.projects.map(normalizeProject).filter((item): item is Project => item !== null)
    : [];
  const panel = (record as { panel?: unknown }).panel;
  const settings = normalizeSettings(record.settings);
  const rawSessions = Array.isArray(record.sessions)
    ? record.sessions.map(normalizeSession).filter((item): item is Session => item !== null)
    : [];
  const usage = rehomeCustomUsage(normalizeUsage(record.usage), settings.customBots, rawSessions);
  const sessions = listedChats(
    applyUsageContext(rawSessions, usage).map((session) => {
      const suggested = suggestedTitleForSession(session);
      return suggested ? { ...session, title: suggested } : session;
    }),
  );
  const activeSessionId =
    typeof record.activeSessionId === "string" && sessions.some((session) => session.id === record.activeSessionId)
      ? record.activeSessionId
      : null;
  return {
    ...EMPTY,
    ...record,
    projects,
    sessions,
    activeSessionId,
    pending: Array.isArray(record.pending) ? record.pending : [],
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
    watchDismissed: normalizeWatchDismissed((record as { watchDismissed?: unknown }).watchDismissed),
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
  const provider =
    record.provider === "grok" ||
    record.provider === "claude" ||
    record.provider === "codex" ||
    record.provider === "custom"
      ? record.provider
      : DEFAULT_CHOICE.provider;
  const model = typeof record.model === "string" && record.model ? record.model : DEFAULT_CHOICE.model;
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

const EMPTY_GROK_REPLY = "Grok finished without a visible reply.";

function cancelVendorSession(session: Pick<Session, "id" | "provider">) {
  if (session.provider === "codex") void window.workhorse?.codexCancel?.(session.id);
  else if (session.provider === "claude") void window.workhorse?.claudeCancel?.(session.id);
  else if (session.provider === "cursor") void window.workhorse?.cursorCancel?.(session.id);
  else if (session.provider === "custom") void window.workhorse?.customCancel?.(session.id);
  else void window.workhorse?.grokCancel?.(session.id);
}

function occupancyForSession(
  session: { provider: ProviderId; model: string } | undefined,
  draft: UsageDraft,
  seen?: number,
): number | undefined {
  if (seen !== undefined) return seen;
  return occupancyFromUsage(draft, session ? contextWindowFor(session.provider, session.model) : 0);
}

function settlePlanAssignment(
  sessions: Session[],
  parentId: string,
  childId: string,
  outcome: "completed" | "failed",
  report: string,
): Session[] {
  const child = sessions.find((item) => item.id === childId);
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
    const settled = setPlanStepStatus(plan, stepId, outcome, {
      ...(outcome === "failed" ? { error: report.trim().slice(0, 1_000) || "Agent failed" } : {}),
      now,
    });
    if (!settled.ok) return session;
    const logged = recordPlanEvent(settled.plan, {
      type: `agent.${outcome}`,
      stepId,
      sessionId: childId,
      correlationId: child?.agentRun?.correlationId,
    }, now);
    return { ...session, planRun: logged.ok ? logged.plan : settled.plan };
  });
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
  const [editMessageId, setEditMessageId] = useState<string | null>(null);
  const [watchHold, setWatchHold] = useState<WatchHold | null>(null);
  const [watchRestore, setWatchRestore] = useState<{ text: string; images?: import("./types").ChatImage[] } | null>(null);
  const persistTimer = useRef<number | null>(null);
  const plansRef = useRef<import("./watch").WatchPlans>({});
  const forkFromRef = useRef<(messageId: string, sessionId?: string) => void>(() => undefined);
  const stateRef = useRef<AppState>(EMPTY);
  const deskSkillsRef = useRef<DeskSkill[]>([]);
  const grokAssistantId = useRef<Record<string, string>>({});
  const grokChunkQueue = useRef<Record<string, string>>({});
  const grokThoughtQueue = useRef<Record<string, string>>({});
  const grokUsagePending = useRef<Record<string, UsageDraft[]>>({});
  const grokContextSeen = useRef<Record<string, number>>({});
  const goalHaltedSessions = useRef(new Set<string>());
  const goalForwardAfterHalt = useRef<Record<string, { text: string; images: import("./types").ChatImage[]; hideUser: boolean }>>({});
  const claudePlanRetry = useRef<number | null>(null);
  stateRef.current = state;
  plansRef.current = { grok: grokPlan, codex: codexPlan, claude: claudePlan, cursor: cursorPlan, custom: customPlans };
  useEffect(() => {
    setState((current) => ({ ...current, deskPlans: plansRef.current }));
  }, [grokPlan, codexPlan, claudePlan, cursorPlan, customPlans]);

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
            : { connected: false };
          const codex = window.workhorse?.detectCodexLogin
            ? await window.workhorse.detectCodexLogin()
            : { connected: false, accessDefaults: undefined };
          const claude = window.workhorse?.detectClaudeLogin
            ? await window.workhorse.detectClaudeLogin()
            : { connected: false };
          const cursor = window.workhorse?.detectCursorLogin
            ? await window.workhorse.detectCursorLogin()
            : { connected: false };
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
                  grok: { ...current.settings.llms.grok, available: Boolean(grok.connected) },
                  codex: {
                    ...current.settings.llms.codex,
                    available: Boolean(codex.connected),
                    accessDefaults: codex.accessDefaults,
                  },
                  claude: {
                    ...current.settings.llms.claude,
                    available: Boolean(claude.connected),
                    needsAuth: Boolean((claude as { needsAuth?: boolean }).needsAuth),
                  },
                  cursor: {
                    ...current.settings.llms.cursor,
                    available: Boolean(cursor.connected),
                    needsAuth: Boolean((cursor as { needsAuth?: boolean }).needsAuth),
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
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      const saved = listedChats(state.sessions);
      void window.workhorse
        ?.saveState({
          ...state,
          sessions: saved,
          activeSessionId:
            state.activeSessionId && saved.some((session) => session.id === state.activeSessionId)
              ? state.activeSessionId
              : null,
        })
        .catch(() => undefined);
    }, 200);
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
    const folderPath = path ?? (window.workhorse ? await window.workhorse.pickFolder() : null);
    if (!folderPath) return;
    setState((current) => {
      const projectId = current.activeProjectId;
      if (!projectId) return current;
      return {
        ...current,
        projects: current.projects.map((project) => {
          if (project.id !== projectId) return project;
          if (project.folders.some((folder) => folder.path === folderPath)) return project;
          return { ...project, folders: [...project.folders, folderFromPath(folderPath)] };
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
      return {
        ...current,
        projects,
        sessions,
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
      const choice = {
        provider: picked,
        model,
        effort: withEffort(picked, model, remembered?.effort ?? null),
        sandbox: rememberedAccess?.sandbox ?? nativeAccess?.sandbox ?? "off",
        mode: rememberedAccess?.mode ?? nativeAccess?.mode ?? "ask",
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
        routingMode: current.settings.routing.enabled ? "auto" : "manual",
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
    const root = project?.folders[0]?.path ?? "";
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

  const setComposerDraft = useCallback((id: string, text: string, images?: import("./types").ChatImage[]) => {
    setState((current) => {
      const session = current.sessions.find((item) => item.id === id);
      if (!session) return current;
      const composerDraft = text.length > 0 ? text : undefined;
      const composerImages = images && images.length > 0 ? images : undefined;
      const sameText = (session.composerDraft ?? undefined) === composerDraft;
      const was = session.composerImages ?? [];
      const next = composerImages ?? [];
      const sameImages =
        was.length === next.length &&
        was.every(
          (item, index) =>
            item.id === next[index]?.id &&
            item.data === next[index]?.data &&
            item.text === next[index]?.text &&
            item.folder === next[index]?.folder,
        );
      if (sameText && sameImages) return current;
      return {
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === id ? { ...item, composerDraft, composerImages } : item,
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
      return {
        ...current,
        sessions,
        pending: current.pending.filter((item) => item.sessionId !== id),
        activeSessionId: current.activeSessionId === id ? null : current.activeSessionId,
      };
    });
  }, []);

  const deleteWorkers = useCallback((parentId: string) => {
    setState((current) => {
      const kids = current.sessions.filter((session) => session.parentId === parentId);
      for (const kid of kids) {
        if (kid.status === "running" || kid.status === "needs-input") cancelVendorSession(kid);
      }
      const sessions = deleteWorkerChats(current.sessions, parentId);
      if (!sessions) return current;
      const gone = new Set(kids.map((kid) => kid.id));
      return {
        ...current,
        sessions,
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

  const dismissAttention = useCallback((id: string) => {
    setState((current) => current.dismissedAttention?.includes(id)
      ? current
      : { ...current, dismissedAttention: [...(current.dismissedAttention ?? []), id].slice(-500) });
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

  const setMcpServers = useCallback((servers: McpServerConfig[]) => {
    setState((current) => ({
      ...current,
      settings: { ...current.settings, mcpServers: servers },
    }));
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
        : { connected: false };
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            grok: { ...current.settings.llms.grok, available: Boolean(detected.connected) },
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
                accessDefaults: detected.accessDefaults,
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
        : { connected: false };
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          llms: {
            ...current.settings.llms,
            cursor: {
              ...current.settings.llms.cursor,
              available: Boolean(detected.connected),
              needsAuth: Boolean((detected as { needsAuth?: boolean }).needsAuth),
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
        : { connected: false };
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
        path: project ? primaryFolder(project)?.path : undefined,
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
    const goalInput = liveSession && liveSession.provider !== "grok" ? parseGoalInput(originalText) : null;
    let vendorText = prep.vendorText;
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
        liveSession.provider === "grok"
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
              return {
                ...item,
                contextCheckpoint: checkpoint,
                vendorSessionId: undefined,
                vendorProvider: undefined,
                contextUsed: Math.min(item.contextUsed, Math.ceil(checkpoint.summary.length / 4)),
                messages: [...item.messages, {
                  id: uid("msg"), role: "system" as const, kind: "compact" as const,
                  text: `Workhorse compacted ${checkpoint.omittedMessages} earlier messages into a portable checkpoint${note ? ` · kept: ${note}` : ""}.`,
                  createdAt: Date.now(),
                }],
              };
            }),
          }));
          return;
        }
        const project = snapshot.projects.find((item) => item.id === session.projectId);
        const cwd = sessionExecutionCwd(session.environment, project?.folders[0]?.path ?? "");
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
            mcpServers: stateRef.current.settings.mcpServers,
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
          return {
            ...current,
            sessions,
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
    if (current.settings.routing.enabled && session.routingMode !== "manual" && !originalText.startsWith("/")) {
      const statuses = watchVendorStatuses({
        settings: current.settings,
        usage: current.usage,
        plans: plansRef.current,
        permits: current.watchPermits,
        dayMarks: current.watchDayMarks,
      });
      const decision = chooseRoutingDecision(
        routingCandidatesForDesk(current.settings, statuses, plansRef.current),
        {
          prompt: originalText,
          attachments: images,
          current: {
            provider: session.provider,
            model: session.model,
            customBotId: session.customBotId,
          },
        },
        current.settings.routing,
      );
      if (decision) {
        const routed = applySessionModelChange(session, {
          provider: decision.provider,
          model: decision.model,
          customBotId: decision.customBotId,
          effort: withEffort(decision.provider, decision.model, session.effort),
        });
        session = { ...routed, routingMode: "auto", routingDecision: decision };
        const routedSession = session;
        setState((latest) => ({
          ...latest,
          lastModel: presetFrom(routedSession),
          sessions: latest.sessions.map((item) => (item.id === routedSession.id ? routedSession : item)),
        }));
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
      const assistantId = uid("msg");
      grokAssistantId.current[session.id] = assistantId;
      const leftover = grokUsagePending.current[session.id];
      if (leftover?.length) {
        const folded = finalizeTurnUsage(leftover);
        if (usageHasBilledTokens(folded)) {
          recordUsage({
            ...folded,
            contextUsed: occupancyForSession(session, folded, grokContextSeen.current[session.id]),
          });
        }
      }
      delete grokUsagePending.current[session.id];
      delete grokContextSeen.current[session.id];
      const cwd = sessionExecutionCwd(session.environment, project?.folders[0]?.path ?? "");
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
                  messages: upsertThoughtMessage(
                    [
                      ...base,
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
                      {
                        id: assistantId,
                        role: "assistant",
                        text: queued,
                        createdAt: Date.now(),
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
          mcpServers: stateRef.current.settings.mcpServers,
          preface: withPortableHistory(buildSessionPreface({
            sessionId: session.id,
            cwd,
            folders: project?.folders.map((folder) => folder.path) ?? [],
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
          const custom =
            customBotForSession(stateRef.current.settings.customBots, session) ?? stateRef.current.settings.llms.custom;
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
            model: custom.model || session.model,
            effort: session.effort,
            cwd,
            mode: session.mode,
            sandbox: session.sandbox,
            preface: promptInput.preface,
            history,
            mcpServers: stateRef.current.settings.mcpServers,
            securityPolicy: session.securityPolicy,
            folders: project?.folders.map((folder) => folder.path) ?? [],
            parentId: session.parentId,
            hidden: session.hidden,
            role: deskRoleOf(session),
            config: {
              baseUrl: custom.baseUrl,
              apiKey: custom.apiKey,
              model: custom.model,
              api: "api" in custom ? custom.api : undefined,
              inputs: routingProfileForModel("custom", custom.model, "routingProfile" in custom ? custom.routingProfile : undefined).inputs,
            },
          });
          const reply = typeof result?.text === "string" ? result.text.trim() : "";
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === session.id
                ? {
                    ...item,
                    status: "idle",
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !(entry.text ?? "").trim()
                        ? { ...entry, text: reply || vendorEmptyReply("custom") }
                        : entry,
                    ),
                  }
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
                ? {
                    ...item,
                    status: "idle",
                    vendorSessionId,
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !(entry.text ?? "").trim()
                        ? { ...entry, text: reply || vendorEmptyReply("claude") }
                        : entry,
                    ),
                  }
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
                ? {
                    ...item,
                    status: "idle",
                    vendorSessionId,
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !(entry.text ?? "").trim()
                        ? { ...entry, text: reply || vendorEmptyReply("cursor") }
                        : entry,
                    ),
                  }
                : item,
            ),
          }));
          return;
        }
        if (live === "codex") {
          if (!window.workhorse?.codexPrompt) {
            throw new Error("Codex agent runs in the Workhorse desktop window.");
          }
          if (options?.replaceUserId) vendorSessionId = undefined;
          const result = await window.workhorse.codexPrompt({ ...promptInput, vendorSessionId });
          const reply = typeof result?.text === "string" ? result.text.trim() : "";
          vendorSessionId =
            typeof result?.vendorSessionId === "string" && result.vendorSessionId
              ? result.vendorSessionId
              : vendorSessionId;
          setState((latest) => ({
            ...latest,
            sessions: latest.sessions.map((item) =>
              item.id === session.id
                ? {
                    ...item,
                    status: "idle",
                    vendorSessionId,
                    messages: item.messages.map((entry) =>
                      entry.id === assistantId && !(entry.text ?? "").trim()
                        ? { ...entry, text: reply || vendorEmptyReply("codex") }
                        : entry,
                    ),
                  }
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
              ? {
                  ...item,
                  status: "idle",
                  vendorSessionId,
                  goal: grokGoalAfterTurnIdle(item.provider, item.goal),
                  messages: item.messages.map((entry) =>
                    entry.id === assistantId && !(entry.text ?? "").trim()
                      ? { ...entry, text: reply || EMPTY_GROK_REPLY }
                      : entry,
                  ),
                }
              : item,
          ),
        }));
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const joinTurn = looksLikeJoinPrompt(text) || isJoinAssistantTurn(
          stateRef.current.sessions.find((item) => item.id === session.id)?.messages ?? [],
          assistantId,
        );
        const attempt = options?.joinAttempt ?? 1;
        if (joinTurn && isVendorRateLimitError(message) && attempt < JOIN_MAX_ATTEMPTS) {
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
        setState((latest) => ({
          ...latest,
          sessions: latest.sessions.map((item) =>
            item.id === session.id
              ? {
                  ...item,
                  status: "idle",
                  goal: grokGoalAfterTurnIdle(item.provider, item.goal),
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
                }
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
  const joinWake = useRef<Record<string, number>>({});

  useEffect(() => {
    if (watchHold) return;
    for (const session of state.sessions) {
      if (session.status !== "idle" || !session.queue?.length || flushing.current.has(session.id)) continue;
      if (session.goal?.status === "paused") continue;
      const item = session.queue[0];
      if (item.notBefore && Date.now() < item.notBefore) {
        if (!joinWake.current[session.id]) {
          joinWake.current[session.id] = window.setTimeout(() => {
            delete joinWake.current[session.id];
            setState((current) => ({ ...current }));
          }, item.notBefore - Date.now());
        }
        continue;
      }
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
          hideUser: item.hideUser === true || Boolean(item.userMessageId),
          scheduledRunId: item.scheduledRunId,
        });
      });
    }
  }, [state.sessions, watchHold]);

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
    if (source.provider !== "grok" || !window.workhorse?.grokFork) return;
    const project = current.projects.find((item) => item.id === source.projectId);
    void window.workhorse
      .grokFork({
        sessionId: source.id,
        projectId: source.projectId ?? undefined,
        text: "",
        model: source.model,
        effort: source.effort,
        mode: source.mode,
        cwd: sessionExecutionCwd(source.environment, project?.folders[0]?.path ?? ""),
        vendorSessionId: source.vendorSessionId,
        sandbox: source.sandbox,
        mcpServers: current.settings.mcpServers,
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
    setState((current) => {
      const sessionId = draft.sessionId ?? current.activeSessionId ?? undefined;
      const inputTokens = Math.max(0, Math.round(draft.inputTokens));
      const cacheReadTokens = Math.max(0, Math.round(draft.cacheReadTokens ?? 0));
      const contextUsed =
        draft.contextUsed === undefined ? undefined : Math.max(0, Math.round(draft.contextUsed));
      return {
        ...current,
        usage: [
          {
            id: uid("use"),
            at: Date.now(),
            provider: draft.provider,
            model: draft.model,
            projectId: draft.projectId ?? current.activeProjectId ?? undefined,
            sessionId,
            customBotId: draft.customBotId,
            lane: draft.lane ?? (draft.provider === "cursor" ? cursorUsageLane(draft.model) : undefined),
            inputTokens,
            outputTokens: Math.max(0, Math.round(draft.outputTokens)),
            cacheReadTokens,
            cacheWriteTokens: Math.max(0, Math.round(draft.cacheWriteTokens ?? 0)),
            costUsd: draft.costUsd,
            contextUsed,
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
        const promptVendor = async (session: Session, text: string, mcpServers: McpServerConfig[]) => {
          const snapshot = stateRef.current;
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
          const cwd = sessionExecutionCwd(session.environment, project?.folders[0]?.path ?? "");
          const live = vendorSendTarget(session.provider);
          const role = deskRoleOf(session);
          const preface = buildSessionPreface({
            sessionId: session.id,
            cwd,
            folders: project?.folders.map((folder) => folder.path) ?? [],
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
            model: session.model,
            effort: session.effort,
            mode: session.mode,
            cwd,
            vendorSessionId: vendorSessionForSend(session),
            sandbox: session.sandbox,
            mcpServers,
            preface,
            parentId: session.parentId,
            hidden: session.hidden,
            role,
          };
          if (live === "preview") throw new Error(`${providerById(session.provider).name} is not connected yet`);
          if (live === "custom") {
            if (!window.workhorse?.customPrompt) throw new Error("Custom model runs in the Workhorse desktop window.");
            const custom =
              customBotForSession(snapshot.settings.customBots, session) ?? snapshot.settings.llms.custom;
            if (!custom.apiKey?.trim() || !custom.baseUrl?.trim()) {
              throw new Error("Custom model is not connected yet");
            }
            const result = await window.workhorse.customPrompt({
              sessionId: session.id,
              projectId: session.projectId ?? undefined,
              text,
              model: custom.model || session.model,
              effort: session.effort,
              cwd,
              mode: session.mode,
              sandbox: session.sandbox,
              preface,
              history: [],
              mcpServers,
              securityPolicy: session.securityPolicy,
              folders: project?.folders.map((folder) => folder.path) ?? [],
              parentId: session.parentId,
              hidden: session.hidden,
              role,
              config: {
                baseUrl: custom.baseUrl,
                apiKey: custom.apiKey,
                model: custom.model,
                api: custom.api,
                inputs: routingProfileForModel(
                  "custom",
                  custom.model,
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
                    assignedSessionId: step.assignedSessionId,
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
                folders: item.folders.map((folder) => folder.path),
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
                folders: item.folders.map((folder) => folder.path),
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
                      folders: item.folders.map((folder) => folder.path),
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
                const gone = new Set(
                  latest.sessions.filter((item) => !sessions.some((row) => row.id === item.id)).map((item) => item.id),
                );
                setState((current) => ({
                  ...current,
                  sessions,
                  pending: current.pending.filter((item) => !gone.has(item.sessionId)),
                }));
                void window.workhorse
                  ?.saveState({
                    ...latest,
                    sessions: listedChats(sessions),
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
              const gone = new Set(
                latest.sessions.filter((item) => !sessions.some((row) => row.id === item.id)).map((item) => item.id),
              );
              setState((current) => ({
                ...current,
                sessions,
                pending: current.pending.filter((item) => !gone.has(item.sessionId)),
                activeSessionId: current.activeSessionId && gone.has(current.activeSessionId) ? null : current.activeSessionId,
              }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  sessions: listedChats(sessions),
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
                pending: current.pending.filter((item) => !gone.has(item.sessionId)),
                activeProjectId: current.activeProjectId === project.id ? null : current.activeProjectId,
                activeSessionId: current.activeSessionId && gone.has(current.activeSessionId) ? null : current.activeSessionId,
              }));
              void window.workhorse
                ?.saveState({
                  ...latest,
                  projects,
                  sessions: listedChats(sessions),
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
              if (!path || !sessionId) {
                await replyAsk({ error: "Need a file path and a project chat to record a write." });
                return;
              }
              setState((current) => ({
                ...current,
                sessions: current.sessions.map((session) =>
                  session.id === sessionId
                    ? {
                        ...session,
                        messages: upsertToolMessage(session.messages, {
                          toolCallId: `write:${path}`,
                          title: "Write",
                          status: "completed",
                          detail: path,
                        }),
                      }
                    : session,
                ),
              }));
              await replyAsk({ text: JSON.stringify({ ok: true, sessionId, path }, null, 2) });
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
            if (action === "await-agents") {
              const parentId = payload.fromSessionId?.trim() || "";
              if (!parentId) {
                await replyAsk({ error: "no parent chat to wait on" });
                return;
              }
              const parentLive = stateRef.current.sessions.find((item) => item.id === parentId);
              const shouldWait = awaitAgentsWaits({ wait: payload.wait, parentStatus: parentLive?.status });
              if (shouldWait) {
                const timeoutMs =
                  typeof payload.timeoutSeconds === "number"
                    ? Math.max(30, Math.min(3_600, payload.timeoutSeconds)) * 1_000
                    : 10 * 60 * 1_000;
                const deadline = Date.now() + timeoutMs;
                while (parentHasRunningChildren(stateRef.current.sessions, parentId) && Date.now() < deadline) {
                  await new Promise((resolve) => setTimeout(resolve, 400));
                }
              }
              setState((current) => {
                let sessions = reconcileIdleChildren(current.sessions, parentId);
                sessions = maybeEnqueueLineupJoin(sessions, parentId);
                return sessions === current.sessions ? current : { ...current, sessions };
              });
              const parentNow = stateRef.current.sessions.find((item) => item.id === parentId);
              const reports = collectChildAgentReports(stateRef.current.sessions, parentId);
              await replyAsk({
                text: formatAwaitAgentsSnapshot({
                  lineup: parentNow?.lineup,
                  reports,
                  wait: shouldWait,
                }),
              });
              return;
            }
            await replyAsk({ error: `Unknown bots action ${action}` });
            return;
          }
          const caller =
            latest.sessions.find((item) => item.id === payload.fromSessionId) ??
            latest.sessions.find((item) => item.status === "running" && !isHiddenSession(item));
          const parent = caller;
          if (payload.mode === "spawn") {
            if (!caller) {
              await replyAsk({ error: "no parent chat to attach this subagent to" });
              return;
            }
            const boundProject = latest.projects.find((item) => item.id === caller.projectId);
            const isNested = deskRoleOf(caller) === "worker";
            if (isNested) {
              const blocked = nestedSpawnError(latest.sessions, caller.id);
              if (blocked) {
                await replyAsk({ error: blocked });
                return;
              }
            } else {
              const blocked = rootSpawnError(latest.sessions, caller.id);
              if (blocked) {
                await replyAsk({ error: blocked });
                return;
              }
            }
            const routeTier = payload.route === "quick" || payload.route === "balanced" || payload.route === "deep"
              ? payload.route
              : undefined;
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
            const routeDecision = routeSpawn
              ? chooseRoutingDecision(
                  routingCandidatesForDesk(latest.settings, routeStatuses, latest.deskPlans ?? plansRef.current),
                  { prompt: payload.message, tier: routeTier ?? (isNested ? "quick" : undefined) },
                  latest.settings.routing,
                )
              : null;
            const spawnProvider = routeDecision?.provider ?? (isNested ? "custom" : payload.provider);
            const spawnModel = routeDecision?.model ?? (isNested ? NESTED_AGENT_MODEL : payload.model);
            const spawnEffort = routeDecision
              ? withEffort(
                  routeDecision.provider,
                  routeDecision.model,
                  isNested ? "low" : ((payload.effort as EffortLevel | undefined) ?? null),
                )
              : isNested ? "low" : payload.effort;
            const spawnTimeoutSeconds = isNested
              ? Math.min(120, Math.max(30, payload.timeoutSeconds ?? 120))
              : payload.timeoutSeconds;
            const spawnTokenBudget = isNested
              ? Math.min(5_000, Math.max(1, payload.tokenBudget ?? 5_000))
              : payload.tokenBudget;
            const spawnIsolation = isNested ? "shared" : payload.isolation;
            const admitted = admitSpawn({
              parent: caller,
              projectFolder: boundProject?.folders[0]?.path ?? "",
              folder: typeof payload.folder === "string" ? payload.folder : undefined,
              prompt: payload.message,
              allowNested: isNested,
            });
            if (!admitted.ok) {
              await replyAsk({ error: admitted.error });
              return;
            }
            if (!parent) {
              await replyAsk({ error: "no parent chat to attach this subagent to" });
              return;
            }
            const spec = resolveSpawnSpec(
              {
                fromSessionId: parent.id,
                prompt: payload.message,
                description: payload.description,
                provider: spawnProvider,
                model: spawnModel,
                customBotId: routeDecision?.customBotId,
                chat: payload.chat,
                effort: spawnEffort ?? undefined,
              },
              latest.sessions.filter((item) => !isHiddenSession(item) && !item.archivedAt),
              parent,
              latest.settings.customBots,
            );
            if (vendorSendTarget(spec.provider) === "preview") {
              await replyAsk({ error: `${providerById(spec.provider).name} is not connected yet` });
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
              const custom =
                customBotForSession(latest.settings.customBots, {
                  customBotId: spec.customBotId,
                  model: spec.model,
                }) ?? latest.settings.llms.custom;
              if (!custom.baseUrl?.trim() || !custom.apiKey?.trim() || !custom.model?.trim()) {
                await replyAsk({ error: "Custom model is not connected yet" });
                return;
              }
            }
            const childId = payload.childSessionId?.trim() || uid("sess");
            const assistantId = uid("msg");
            const startedAt = Date.now();
            let assignedPlan = parent.planRun;
            const planStepId = payload.planStepId?.trim() || "";
            const rationale = payload.rationale?.trim() || "";
            const assignedSkills = Array.isArray(payload.skills) ? payload.skills.filter(Boolean) : [];
            const assignedTools = Array.isArray(payload.tools) ? payload.tools.filter(Boolean) : [];
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
                ...(spec.customBotId ? { customBotId: spec.customBotId } : {}),
                rationale,
                skills: assignedSkills,
                tools: assignedTools,
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
            const project = boundProject ?? latest.projects.find((item) => item.id === parent.projectId);
            const root = admitted.cwd;
            let environment: SessionEnvironment = { kind: "local" };
            let isolation: "worktree" | "shared" = spawnIsolation === "worktree" ? "worktree" : "shared";
            if (isolation === "worktree" && root && window.workhorse?.ensureWorktree) {
              const isolated = await window.workhorse.ensureWorktree({ sessionId: childId, root });
              if (isolated.ok && isolated.path && isolated.gitRoot && isolated.head) {
                environment = { kind: "worktree", path: isolated.path, gitRoot: isolated.gitRoot, head: isolated.head };
              } else {
                isolation = "shared";
              }
            } else {
              isolation = "shared";
            }
            grokAssistantId.current[childId] = assistantId;
            const child: Session = {
              id: childId,
              projectId: parent.projectId,
              parentId: parent.id,
              hidden: true,
              provider: spec.provider,
              model: spec.model,
              customBotId: spec.customBotId,
              effort: spec.effort,
              title: spec.title,
              titleLocked: true,
              mode: parent.mode,
              sandbox: parent.sandbox,
              securityPolicy: parent.securityPolicy,
              environment,
              status: "running",
              contextUsed: 0,
              agentRun: {
                status: "running",
                startedAt,
                timeoutMs,
                ...(tokenBudget ? { tokenBudget } : {}),
                isolation,
                ...(planStepId ? { planStepId } : {}),
                ...(rationale ? { rationale } : {}),
                ...(assignedSkills.length > 0 ? { skills: assignedSkills } : {}),
                ...(assignedTools.length > 0 ? { tools: assignedTools } : {}),
                ...(payload.id ? { correlationId: payload.id } : {}),
              },
              routingMode: routeDecision ? "auto" : "manual",
              routingDecision: routeDecision ?? undefined,
              messages: [
                {
                  id: uid("msg"),
                  role: "user",
                  kind: "peer",
                  fromTitle: parent.title?.trim() || "another agent",
                  text: payload.message.trim(),
                  createdAt: startedAt,
                  ...brainStamp(spec),
                },
                { id: assistantId, role: "assistant", text: "", createdAt: startedAt, ...brainStamp(spec) },
              ],
            };
            const waveText = lastUserMessage(parent)?.text ?? "";
            setState((current) => ({
              ...current,
              sessions: [
                ...current.sessions.map((item) =>
                  item.id === parent.id
                    ? {
                        ...item,
                        lineup: addLineupRow(
                          stampLineupUserText(item.lineup ?? emptyLineup(admitted.cwd, startedAt, waveText), waveText),
                          {
                          childId,
                          title: spec.title,
                          slice: payload.description?.trim() || spec.title,
                          folder: admitted.cwd,
                          vendor: spec.title,
                          status: "running",
                          startedAt,
                          ...(planStepId ? { planStepId } : {}),
                          ...(rationale ? { rationale } : {}),
                        }),
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
                          },
                        ],
                      }
                    : item,
                ),
                child,
              ],
            }));
            const childCwd = sessionExecutionCwd(environment, root);
            const waitForReply = spawnWaitsForReply(payload);
            const markChildFailure = (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              setState((current) => {
                let sessions = applyChildIdleSync(current.sessions, childId, "failed", { report: message, error: message });
                sessions = settlePlanAssignment(sessions, parent.id, childId, "failed", message);
                sessions = maybeEnqueueLineupJoin(sessions, parent.id);
                return { ...current, sessions };
              });
            };
            const runChild = async () => {
              const beforeChanges = new Set(
                window.workhorse?.listGitChanges && childCwd
                  ? (await window.workhorse.listGitChanges(childCwd)).map((change) => `${change.status}:${change.path}`)
                  : [],
              );
              const reply = await promptVendor(
                child,
                formatWorkerPrompt({
                  fromTitle: parent.title?.trim() || "another agent",
                  text: payload.message,
                  folder: admitted.cwd,
                  project: project?.name,
                  slice: payload.description,
                  vendor: spec.title,
                }),
                latest.settings.mcpServers,
              );
              const terminalStatus = stateRef.current.sessions.find((item) => item.id === childId)?.agentRun?.status;
              if (terminalStatus === "timed-out" || terminalStatus === "cancelled" || terminalStatus === "budget-exceeded") {
                setState((current) => {
                  const rowStatus = terminalStatus === "timed-out" ? "timed-out" as const : "failed" as const;
                  let sessions = applyChildIdleSync(current.sessions, childId, rowStatus, {
                    report: childReportText(current.sessions.find((item) => item.id === childId)),
                    error: terminalStatus,
                  });
                  sessions = settlePlanAssignment(sessions, parent.id, childId, "failed", terminalStatus);
                  sessions = maybeEnqueueLineupJoin(sessions, parent.id);
                  return { ...current, sessions };
                });
                return "";
              }
              const fallback = reply || vendorEmptyReply(spec.provider);
              const afterChanges = window.workhorse?.listGitChanges && childCwd
                ? await window.workhorse.listGitChanges(childCwd)
                : [];
              const changedFiles = afterChanges
                .filter((change) => !beforeChanges.has(`${change.status}:${change.path}`))
                .map((change) => change.path);
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
                          entry.id === assistantId && !entry.text.trim() ? { ...entry, text: fallback } : entry,
                        ),
                      }
                    : item,
                );
                let sessions = applyChildIdleSync(withReply, childId, "completed", { report: fallback });
                sessions = settlePlanAssignment(sessions, parent.id, childId, "completed", fallback);
                sessions = maybeEnqueueLineupJoin(sessions, parent.id);
                return { ...current, sessions };
              });
              return fallback;
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
                        vendor: spec.title,
                        status: "running",
                        startedAt,
                        ...(planStepId ? { planStepId } : {}),
                        ...(rationale ? { rationale } : {}),
                      }),
                    ),
                    howToUse:
                      "Worker is running in its own chat. Spawn the rest with wait=false, then stop. The desk joins reports later. Do not sit on workhorse_await_agents or ask the user to pick.",
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
            if (!fallback) return;
            await replyAsk({ text: fallback });
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
                messages: [
                  ...item.messages,
                  {
                    id: uid("msg"),
                    role: "user" as const,
                    kind: "peer" as const,
                    fromTitle,
                    peerFromSessionId: from?.id,
                    correlationId: payload.id,
                    text: payload.message.trim(),
                    createdAt: startedAt,
                    ...brainStamp(target),
                  },
                  { id: assistantId, role: "assistant", text: "", createdAt: startedAt, ...brainStamp(target) },
                ],
              };
            }),
          }));
          const reply = await promptVendor(target, prompt, stateRef.current.settings.mcpServers);
          const fallback = reply || vendorEmptyReply(target.provider);
          setState((current) => ({
            ...current,
            sessions: withSubagentStatus(
              current.sessions.map((item) =>
                item.id === target.id
                  ? {
                      ...item,
                      status: "idle",
                      messages: item.messages.map((entry) =>
                        entry.id === assistantId && !entry.text.trim() ? { ...entry, text: fallback } : entry,
                      ),
                    }
                  : item,
              ),
              target.id,
              "completed",
            ),
          }));
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
            return {
              ...current,
              sessions: parentId ? maybeEnqueueLineupJoin(failed, parentId) : failed,
            };
          });
          await replyAsk({ error: message });
        }
      })();
    });
  }, []);

  useEffect(() => {
    if (!window.workhorse?.onPeerCancel) return;
    return window.workhorse.onPeerCancel(({ childSessionId, reason }) => {
      const child = stateRef.current.sessions.find((session) => session.id === childSessionId);
      if (child?.status === "running") cancelVendorSession(child);
      setState((current) => {
        const rowStatus = reason === "timed-out" ? "timed-out" as const : "failed" as const;
        let sessions = applyChildIdleSync(current.sessions, childSessionId, rowStatus, {
          error: reason === "timed-out" ? "Subagent exceeded its runtime limit." : "Subagent was cancelled.",
        });
        const parentId = child?.parentId;
        if (parentId) sessions = settlePlanAssignment(sessions, parentId, childSessionId, "failed", reason);
        if (parentId) sessions = maybeEnqueueLineupJoin(sessions, parentId);
        return { ...current, sessions };
      });
    });
  }, []);

  useEffect(() => {
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
      if (event.type === "chunk") {
        setState((current) => {
          const session = current.sessions.find((item) => item.id === event.sessionId);
          const assistantId =
            grokAssistantId.current[event.sessionId] ??
            [...(session?.messages ?? [])].reverse().find((message) => message.role === "assistant")?.id;
          const hasMessage = Boolean(assistantId && session?.messages.some((message) => message.id === assistantId));
          if (!session || !assistantId || !hasMessage) {
            grokChunkQueue.current[event.sessionId] = mergeStreamedText(
              grokChunkQueue.current[event.sessionId] ?? "",
              event.text,
            );
            return current;
          }
          const queued = grokChunkQueue.current[event.sessionId] ?? "";
          delete grokChunkQueue.current[event.sessionId];
          const add = joinChatText(queued, event.text);
          if (!add) return current;
          return {
            ...current,
            sessions: current.sessions.map((item) =>
              item.id === event.sessionId
                ? {
                    ...item,
                    messages: item.messages.map((message) =>
                      message.id === assistantId ? { ...message, text: mergeStreamedText(message.text, add) } : message,
                    ),
                  }
                : item,
            ),
          };
        });
        return;
      }
      if (event.type === "thought") {
        setState((current) => {
          const session = current.sessions.find((item) => item.id === event.sessionId);
          const assistantId =
            grokAssistantId.current[event.sessionId] ??
            [...(session?.messages ?? [])].reverse().find((message) => message.role === "assistant")?.id;
          const hasMessage = Boolean(assistantId && session?.messages.some((message) => message.id === assistantId));
          if (!session || !assistantId || !hasMessage) {
            grokThoughtQueue.current[event.sessionId] =
              (grokThoughtQueue.current[event.sessionId] ?? "") + event.text;
            return current;
          }
          const queued = grokThoughtQueue.current[event.sessionId] ?? "";
          delete grokThoughtQueue.current[event.sessionId];
          const add = queued + event.text;
          if (!add) return current;
          return {
            ...current,
            sessions: current.sessions.map((item) =>
              item.id === event.sessionId
                ? {
                    ...item,
                    messages: upsertThoughtMessage(item.messages, add),
                  }
                : item,
            ),
          };
        });
        return;
      }
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
        setState((current) => {
          const owner = current.sessions.find((item) => item.id === event.sessionId);
          if (owner && !isDefaultTitle(owner.title)) return current;
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
                }
              : session,
          ),
        }));
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
        const allowed = forced ?? autoAllowPermission({ tool: event.tool, grants: owner?.permissionGrants });
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
                    status: current.pending.some((item) => item.sessionId === event.sessionId && item.id !== event.requestId)
                      ? "needs-input"
                      : "running",
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
        const incoming: UsageDraft = {
          provider: usageProviderForSession(owner),
          model: event.model,
          projectId: event.projectId,
          sessionId: event.sessionId,
          customBotId: owner?.customBotId,
          lane: usageProviderForSession(owner) === "cursor" ? cursorUsageLane(event.model) : undefined,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          costUsd: event.costUsd,
          contextUsed: event.contextUsed,
        };
        if (usageHasBilledTokens(incoming)) {
          const pending = grokUsagePending.current[event.sessionId] ?? [];
          grokUsagePending.current[event.sessionId] = [...pending, incoming];
        }
        const liveSession = stateRef.current.sessions.find((item) => item.id === event.sessionId);
        if (liveSession?.agentRun?.status === "running") {
          const usedTokens = Math.max(
            liveSession.agentRun.usedTokens ?? 0,
            Math.max(0, event.inputTokens) + Math.max(0, event.outputTokens),
          );
          const exceeded = Boolean(liveSession.agentRun.tokenBudget && usedTokens > liveSession.agentRun.tokenBudget);
          if (exceeded) cancelVendorSession(liveSession);
          setState((current) => ({
            ...current,
            sessions: withSubagentStatus(
              current.sessions.map((session) =>
                session.id === event.sessionId && session.agentRun
                  ? {
                      ...session,
                      status: exceeded ? "idle" : session.status,
                      agentRun: {
                        ...session.agentRun,
                        usedTokens,
                        ...(exceeded ? {
                          status: "budget-exceeded" as const,
                          finishedAt: Date.now(),
                          error: `Subagent exceeded its ${session.agentRun.tokenBudget} token budget.`,
                        } : {}),
                      },
                    }
                  : session,
              ),
              event.sessionId,
              exceeded ? "failed" : "running",
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
        if (pending?.length) {
          const folded = finalizeTurnUsage(pending);
          if (usageHasBilledTokens(folded)) {
            const session = stateRef.current.sessions.find((item) => item.id === event.sessionId);
            recordUsage({
              ...folded,
              contextUsed: occupancyForSession(session, folded, grokContextSeen.current[event.sessionId]),
            });
          }
        }
        setState((current) => {
          const queued = grokChunkQueue.current[event.sessionId] ?? "";
          delete grokChunkQueue.current[event.sessionId];
          const assistantId = grokAssistantId.current[event.sessionId];
          let sessions = withSubagentStatus(
            current.sessions.map((session) => {
              if (session.id !== event.sessionId) return session;
              return {
                ...session,
                status: "idle" as const,
                goal:
                  safetyPaused && session.goal
                    ? { ...session.goal, status: "paused" as const }
                    : grokGoalAfterTurnIdle(session.provider, session.goal),
                scheduledRuns: (session.scheduledRuns ?? []).map((run) =>
                  run.status === "running"
                    ? { ...run, status: safetyPaused ? ("failed" as const) : ("completed" as const) }
                    : run,
                ),
                messages: finishOpenToolMessages(
                  failPeerAskMessages(
                    assistantId
                      ? session.messages.map((message) => {
                          if (message.id !== assistantId) return message;
                          const text = (message.text ?? "").trim() || queued.trim();
                          return {
                            ...message,
                            text: text || (message.thought?.trim() ? "" : vendorEmptyReply(session.provider)),
                            workedMs: Math.max(0, Date.now() - message.createdAt),
                          };
                        })
                      : session.messages,
                    { error: "the other chat did not answer" },
                  ),
                  safetyPaused ? "failed" : "completed",
                ),
              };
            }),
            event.sessionId,
            safetyPaused ? "failed" : "completed",
          );
          const finished = sessions.find((session) => session.id === event.sessionId);
          if (finished?.parentId) {
            sessions = applyChildIdleSync(sessions, event.sessionId, safetyPaused ? "failed" : "completed", {
              report: childReportText(finished),
              ...(safetyPaused ? { error: "Agent paused before completing its goal." } : {}),
            });
            sessions = maybeEnqueueLineupJoin(sessions, finished.parentId);
          }
          return { ...current, sessions };
        });
        return;
      }
      if (event.type === "error") {
        const pending = grokUsagePending.current[event.sessionId];
        delete grokUsagePending.current[event.sessionId];
        if (pending?.length) {
          const folded = finalizeTurnUsage(pending);
          if (usageHasBilledTokens(folded)) {
            const session = stateRef.current.sessions.find((item) => item.id === event.sessionId);
            recordUsage({
              ...folded,
              contextUsed: occupancyForSession(session, folded, grokContextSeen.current[event.sessionId]),
            });
          }
        }
        const assistantId = grokAssistantId.current[event.sessionId];
        setState((current) => {
          let sessions = withSubagentStatus(
            current.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    status: "idle" as const,
                    goal: grokGoalAfterTurnIdle(session.provider, session.goal),
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
                  }
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
            sessions = maybeEnqueueLineupJoin(sessions, failed.parentId);
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
    return window.workhorse.importSkill(from);
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
    async (dir: string, target: "grok" | "codex" | "claude", name?: string): Promise<DeskExportResult> => {
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
          },
        },
      },
    }));
    return { ok: result.ok, message: result.message };
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
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        customBots: applyUpdateCustomBot(current.settings.customBots, id, patch),
      },
      lastModel:
        current.lastModel.customBotId === id && patch.model
          ? { ...current.lastModel, model: patch.model }
          : current.lastModel,
      sessions: current.sessions.map((session) =>
        session.customBotId === id && patch.model ? { ...session, model: patch.model } : session,
      ),
    }));
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
    if (result.ok) {
      updateCustomBot(id, {
        ...(result.contextWindow ? { contextWindow: result.contextWindow } : {}),
        ...(result.api ? { api: result.api } : {}),
        ...(result.model ? { model: result.model } : {}),
      });
    }
    return { ok: result.ok, message: result.message };
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
      .then((plan) => setGrokPlan(plan))
      .catch(() => setGrokPlan(undefined));
  }, []);

  const refreshCodexPlan = useCallback(() => {
    if (!window.workhorse?.codexPlanUsage) return;
    void window.workhorse
      .codexPlanUsage()
      .then((plan) => setCodexPlan(plan))
      .catch(() => setCodexPlan(undefined));
  }, []);

  const refreshCursorPlan = useCallback(() => {
    if (!window.workhorse?.cursorPlanUsage) {
      setCursorPlan(undefined);
      return;
    }
    void window.workhorse
      .cursorPlanUsage()
      .then((plan) => setCursorPlan(plan ?? undefined))
      .catch(() => setCursorPlan(undefined));
  }, []);

  const refreshClaudePlan = useCallback(() => {
    if (!window.workhorse?.claudePlanUsage) return;
    void window.workhorse
      .claudePlanUsage()
      .then((plan) => {
        setClaudePlan(plan);
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
      .catch(() => setClaudePlan(undefined));
  }, []);

  const refreshCustomPlans = useCallback(() => {
    if (!window.workhorse?.customPlanUsage) return;
    for (const bot of stateRef.current.settings.customBots) {
      void window.workhorse
        .customPlanUsage({ baseUrl: bot.baseUrl, apiKey: bot.apiKey, model: bot.model })
        .then((plan) => {
          setCustomPlans((current) => ({ ...current, [bot.id]: plan ?? undefined }));
        })
        .catch(() => {
          setCustomPlans((current) => {
            const next = { ...current };
            delete next[bot.id];
            return next;
          });
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

  const dismissWatchNotice = useCallback((notice: WatchNotice) => {
    setState((current) => ({
      ...current,
      watchDismissed: { ...current.watchDismissed, [notice.id]: dismissStamp(notice) },
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

  const watchNotices = useMemo(
    () => collectWatchNotices(watchStatuses, state.watchDismissed),
    [watchStatuses, state.watchDismissed],
  );

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
      for (const child of current.sessions) {
        if (targets.has(child.id) && child.status === "running") cancelVendorSession(child);
      }
      return {
        ...current,
        sessions: current.sessions.map((session) => {
          if (!targets.has(session.id) || session.status !== "running") return session;
          return {
            ...session,
            status: "idle",
            agentRun: session.agentRun ? {
              ...session.agentRun,
              status: "cancelled" as const,
              finishedAt: Date.now(),
              error: "Cancelled with its parent lifecycle.",
            } : undefined,
          };
        }),
      };
    });
  }, []);

  const quit = useCallback(() => {
    void window.workhorse?.quit();
  }, []);

  const checkAppUpdate = useCallback(async () => {
    if (!window.workhorse?.checkAppUpdate) return;
    const offer = await window.workhorse.checkAppUpdate();
    setAppUpdate(() => {
      const dismissed = stateRef.current.dismissedUpdateVersion;
      if (!offer || offer.version === dismissed || offer.version === APP_VERSION) return null;
      return offer;
    });
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
    void checkAppUpdate();
    const timer = window.setInterval(() => void checkAppUpdate(), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [ready, checkAppUpdate]);

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
      dismissAttention,
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
      setSandbox,
      setSecurityPolicy,
      setMcpServers,
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
      watchNotices,
      watchHold,
      watchRestore,
      dismissWatchNotice,
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
      dismissAttention,
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
      setSandbox,
      setSecurityPolicy,
      setMcpServers,
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
      watchNotices,
      watchHold,
      watchRestore,
      dismissWatchNotice,
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
      refreshCustomPlans,
      quit,
      appUpdate,
      appUpdateBusy,
      appUpdateError,
      checkAppUpdate,
      applyAppUpdate,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
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
  return store.sessions.filter((session) => {
    if (session.projectId !== projectId || isDraftChat(session)) return false;
    const isArchived = typeof session.archivedAt === "number";
    if (archived ? !isArchived : isArchived) return false;
    if (session.parentId) return true;
    return !isHiddenSession(session);
  });
}

export function useLooseSessions(archived = false) {
  const store = useStore();
  return store.sessions.filter((session) => {
    if (isHiddenSession(session) || session.projectId || isDraftChat(session)) return false;
    return archived ? typeof session.archivedAt === "number" : !session.archivedAt;
  });
}
