import { stubCompile, stubCompileAgent, stubReconcile } from "../src/lib/learning-compiler";
import { exportJsonl, exportMarkdown } from "../src/lib/learning-export";
import {
  boundedCompilerBatch,
  AGENT_INTELLIGENCE_LANE,
  agentCompilerPrompt,
  compilerInputHash,
  compilerPrompt,
  DEFAULT_COMPILER_POLICY,
  effectiveCompilerAssignment,
  effectiveLearningMode,
  eventsRequireMemory,
  eventsRequireAgentMemory,
  frameRetrievedMemories,
  HUMAN_INTELLIGENCE_LANE,
  learningCaptures,
  learningCompiles,
  learningAutoPromotes,
  outcomeIsVerified,
  MISMATCH_INTELLIGENCE_LANE,
  mismatchCompilerPrompt,
  parseBriefText,
  promoteProposal,
  selectAdaptiveRoute,
  type AdaptiveCandidate,
} from "../src/lib/learning-policy";
import { prepareEvent } from "../src/lib/learning-redact";
import { newAuditId, newMemoryId, newRunId, type MemoryStore } from "../src/lib/learning-store";
import type {
  AuxiliaryCaller,
  CompileResult,
  CompilerRun,
  CompilerPolicy,
  ForgetTarget,
  LearningEvent,
  LearningIndexStats,
  LearningMode,
  LearningSettings,
  MemoryItem,
  OutcomeMetric,
  RetrievalQuery,
} from "../src/lib/learning-types";

type EventIntelligenceLane = typeof HUMAN_INTELLIGENCE_LANE | typeof AGENT_INTELLIGENCE_LANE;

export type LearningServiceOptions = {
  store: MemoryStore;
  settings: () => LearningSettings;
  candidates?: () => AdaptiveCandidate[];
  outcomes?: () => OutcomeMetric[];
  caller?: AuxiliaryCaller;
  allowStub?: boolean;
  policy?: Partial<CompilerPolicy>;
  now?: () => number;
  idle?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
};

export class LearningService {
  private paused = false;
  private compiling = false;
  private idleTimer: unknown = null;
  private sleeping = false;
  readonly createdChats: string[] = [];

  constructor(private readonly options: LearningServiceOptions) {}

  private policy(): CompilerPolicy {
    return { ...DEFAULT_COMPILER_POLICY, ...this.options.policy };
  }

  private mode(projectId?: string | null): LearningMode {
    return effectiveLearningMode(this.options.settings(), projectId);
  }

  pause(): void {
    this.paused = true;
    this.clearIdle();
  }

  resume(): void {
    this.paused = false;
    this.schedule();
  }

  /** macOS sleep/App Nap: freeze idle work without duplicating a run. */
  sleep(): void {
    this.sleeping = true;
    this.clearIdle();
  }

  wake(): void {
    if (!this.sleeping) return;
    this.sleeping = false;
    this.schedule();
  }

  close(): void {
    this.pause();
    this.options.store.close();
  }

  reopen(): void {
    this.options.store.reopen();
    this.paused = false;
  }

  probe() {
    return this.options.store.probe();
  }

  record(draft: Parameters<typeof prepareEvent>[0]): { inserted: boolean; event?: LearningEvent } {
    const mode = this.mode(draft.projectId);
    if (!learningCaptures(mode)) return { inserted: false };
    const event = prepareEvent(draft);
    const result = this.options.store.recordEvent(event);
    if (result.inserted) {
      this.schedule();
    }
    return { ...result, event };
  }

  retrieve(query: RetrievalQuery) {
    const mode = this.mode(query.projectId);
    if (mode === "off") {
      return { items: [], frame: "", auditId: undefined as string | undefined };
    }
    const items = this.options.store.searchMemories(query);
    const excluded = this.options.store
      .listMemories({ includeDeleted: true })
      .filter((item) => !items.some((hit) => hit.id === item.id))
      .map((item) => item.id);
    const audit = {
      id: newAuditId(),
      createdAt: this.now(),
      sessionId: query.sessionId,
      projectId: query.projectId,
      provider: query.provider,
      queryScope: [query.projectId ?? "none", query.provider ?? "none", query.taskClass ?? "none"].join(":"),
      candidateIds: items.map((item) => item.id),
      selectedIds: items.map((item) => item.id),
      excludedIds: excluded.slice(0, 40),
      scores: Object.fromEntries(items.map((item) => [item.id, item.score])),
      tokenBudget: query.tokenCap ?? 900,
    };
    this.options.store.putRetrievalAudit(audit);
    return { items, frame: frameRetrievedMemories(items), auditId: audit.id };
  }

  memories() {
    return this.options.store.listMemories({ includeDeleted: false, intelligenceLane: HUMAN_INTELLIGENCE_LANE });
  }

  events(limit = 200): LearningEvent[] {
    const rows = this.options.store.listEvents();
    return rows.slice(-Math.max(0, limit));
  }

  indexStats(): LearningIndexStats {
    const events = this.options.store.listEvents();
    const humanEvents = events.filter((event) => event.actorClass === "human");
    const agentEvents = events.filter((event) => event.actorClass === "agent");
    const memories = this.options.store.listMemories({ includeDeleted: false, intelligenceLane: HUMAN_INTELLIGENCE_LANE });
    const agentMemories = this.options.store.listMemories({ includeDeleted: false, intelligenceLane: AGENT_INTELLIGENCE_LANE });
    const mismatchMemories = this.options.store.listMemories({ includeDeleted: false, intelligenceLane: MISMATCH_INTELLIGENCE_LANE });
    const completedRuns = this.options.store
      .listCompilerRuns()
      .filter((run) => run.status === "completed" && run.intelligenceLane !== "legacy-unclassified");
    const humanCompleted = completedRuns.filter((run) => run.intelligenceLane === HUMAN_INTELLIGENCE_LANE);
    const agentCompleted = completedRuns.filter((run) => run.intelligenceLane === AGENT_INTELLIGENCE_LANE);
    const lastHuman = humanCompleted.at(-1);
    const lastAgent = agentCompleted.at(-1);
    const humanWatermarkIndex = lastHuman?.eventWatermark
      ? humanEvents.findIndex((event) => event.id === lastHuman.eventWatermark)
      : -1;
    const agentWatermarkIndex = lastAgent?.eventWatermark
      ? agentEvents.findIndex((event) => event.id === lastAgent.eventWatermark)
      : -1;
    return {
      indexedEvents: events.length,
      indexedHumanEvents: humanEvents.length,
      indexedAgentEvents: agentEvents.length,
      compiledEvents: humanWatermarkIndex + 1,
      compiledAgentEvents: agentWatermarkIndex + 1,
      memories: memories.length,
      agentMemories: agentMemories.length,
      mismatchMemories: mismatchMemories.length,
      completedRuns: completedRuns.length,
      latestEventAt: events.at(-1)?.createdAt,
      latestCompileAt: completedRuns.map((run) => run.endedAt ?? 0).reduce((latest, at) => Math.max(latest, at), 0) || undefined,
    };
  }

  approve(id: string): MemoryItem | undefined {
    const item = this.options.store.getMemory(id);
    if (!item) return undefined;
    const next = { ...item, status: "active" as const, lastConfirmedAt: this.now() };
    this.options.store.putMemory(next);
    return next;
  }

  forget(target: ForgetTarget) {
    return { tombstoned: this.options.store.tombstone(target, this.now()) };
  }

  purge(target: ForgetTarget) {
    this.pause();
    try {
      return this.options.store.purge(target);
    } finally {
      this.resume();
    }
  }

  exportBundle() {
    const payload = this.options.store.exportAll();
    return { jsonl: exportJsonl(payload), markdown: exportMarkdown(payload), payload };
  }

  schedule(): void {
    if (this.paused || this.sleeping || this.compiling) return;
    const idle = this.options.idle;
    if (!idle) return;
    this.clearIdle();
    this.idleTimer = idle.setTimeout(() => {
      void this.compileIfDue();
    }, this.policy().quietMs);
  }

  private clearIdle() {
    if (this.idleTimer !== null) this.options.idle?.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async recover(): Promise<CompileResult> {
    const unfinished = this.options.store
      .listCompilerRuns()
      .find(
        (run) =>
          run.intelligenceLane !== "legacy-unclassified" &&
          (run.status === "running" || run.status === "interrupted" || run.status === "pending"),
      );
    if (unfinished) return this.compile({ resume: unfinished.id });
    return this.compileIfDue();
  }

  async compileIfDue(): Promise<CompileResult> {
    if (this.paused || this.sleeping) return { ran: false, skipped: "paused" };
    const mode = this.mode();
    if (!learningCompiles(mode)) return { ran: false, skipped: "mode" };
    const humanEvents = this.eligibleEvents(HUMAN_INTELLIGENCE_LANE);
    const agentEvents = this.eligibleEvents(AGENT_INTELLIGENCE_LANE);
    if (
      humanEvents.length < this.policy().minEligibleEvents &&
      agentEvents.length < this.policy().minEligibleEvents &&
      this.mismatchInputs().length === 0
    ) return { ran: false, skipped: "threshold" };
    return this.compile();
  }

  private eligibleEvents(lane: EventIntelligenceLane): LearningEvent[] {
    const last = this.options.store
      .listCompilerRuns()
      .filter((run) => run.intelligenceLane === lane && run.status === "completed")
      .at(-1);
    return this.options.store.listEvents({
      afterWatermark: last?.eventWatermark,
      actorClass: lane === HUMAN_INTELLIGENCE_LANE ? "human" : "agent",
      limit: this.policy().maxEventsPerRun,
    });
  }

  private mismatchInputs(): MemoryItem[] {
    const statuses: MemoryItem["status"][] = ["active", "approved", "proposed"];
    const humans = this.options.store.listMemories({ intelligenceLane: HUMAN_INTELLIGENCE_LANE, statuses });
    const agents = this.options.store.listMemories({ intelligenceLane: AGENT_INTELLIGENCE_LANE, statuses });
    const reconciled = new Set(
      this.options.store
        .listCompilerRuns()
        .filter((run) => run.intelligenceLane === MISMATCH_INTELLIGENCE_LANE && run.status === "completed")
        .flatMap((run) => run.inputMemoryIds ?? []),
    );
    const humanIds = new Set<string>();
    const agentIds = new Set<string>();
    for (const human of humans) {
      for (const agent of agents) {
        if (!human.projectId || human.projectId !== agent.projectId) continue;
        if (!(human.correlationIds ?? []).some((id) => agent.correlationIds?.includes(id))) continue;
        if (reconciled.has(human.id) && reconciled.has(agent.id)) continue;
        humanIds.add(human.id);
        agentIds.add(agent.id);
      }
    }
    const byTime = (a: MemoryItem, b: MemoryItem) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    return [
      ...humans.filter((item) => humanIds.has(item.id)).sort(byTime),
      ...agents.filter((item) => agentIds.has(item.id)).sort(byTime),
    ];
  }

  async compile(input: { resume?: string } = {}): Promise<CompileResult> {
    if (this.compiling) return { ran: false, skipped: "busy" };
    const mode = this.mode();
    if (!learningCompiles(mode)) return { ran: false, skipped: "mode" };
    const resumable = input.resume ? this.options.store.getCompilerRun(input.resume) : undefined;
    if (resumable?.intelligenceLane === MISMATCH_INTELLIGENCE_LANE) return this.compileMismatch(input, resumable);
    const humanEvents = this.eligibleEvents(HUMAN_INTELLIGENCE_LANE);
    const agentEvents = this.eligibleEvents(AGENT_INTELLIGENCE_LANE);
    const lane: EventIntelligenceLane = resumable?.intelligenceLane === AGENT_INTELLIGENCE_LANE
      ? AGENT_INTELLIGENCE_LANE
      : resumable?.intelligenceLane === HUMAN_INTELLIGENCE_LANE
        ? HUMAN_INTELLIGENCE_LANE
        : humanEvents.length > 0
          ? HUMAN_INTELLIGENCE_LANE
          : AGENT_INTELLIGENCE_LANE;
    const pendingEvents = lane === HUMAN_INTELLIGENCE_LANE ? humanEvents : agentEvents;
    if (pendingEvents.length === 0) return this.compileMismatch(input);
    const memories = this.options.store.listMemories({
      intelligenceLane: lane,
      statuses: ["active", "approved", "proposed"],
    });
    const events = boundedCompilerBatch(pendingEvents, memories, this.policy().maxPayloadChars, lane);
    const inputHash = compilerInputHash(events, memories, lane);
    const existing = this.options.store
      .listCompilerRuns()
      .find(
        (run) =>
          run.intelligenceLane === lane && run.inputHash === inputHash && run.status === "completed",
      );
    if (existing && !input.resume) return { ran: false, skipped: "duplicate", runId: existing.id };

    const resumed = resumable?.intelligenceLane === lane ? resumable : undefined;
    if (resumed && resumed.attempt >= this.policy().maxAttempts) {
      this.options.store.putCompilerRun({ ...resumed, status: "failed", errorClass: "max-attempts", endedAt: this.now() });
      return { ran: false, skipped: "max-attempts", runId: resumed.id };
    }
    const settings = this.options.settings();
    const selection = selectAdaptiveRoute({
      candidates: this.options.candidates?.() ?? [],
      explicit: effectiveCompilerAssignment(settings),
      outcomes: this.options.outcomes?.(),
      taskClass: lane === HUMAN_INTELLIGENCE_LANE ? "learning-compile-human" : "learning-compile-agent",
      capacityAware: true,
    });
    const route = {
      provider: selection.provider,
      model: selection.model,
      customBotId: selection.customBotId,
      intelligenceLane: lane,
    };
    const runId = resumed?.id ?? newRunId();
    const attempt = (resumed?.attempt ?? 0) + 1;
    this.compiling = true;
    this.options.store.putCompilerRun({
      id: runId,
      intelligenceLane: lane,
      status: "running",
      attempt,
      startedAt: this.now(),
      inputHash,
      eventWatermark: events.at(-1)?.id,
      inputFrom: events[0]?.createdAt,
      inputTo: events.at(-1)?.createdAt,
      provider: selection.provider,
      model: selection.model,
      effort: selection.effort,
      rationale: selection.reason,
    });
    try {
      let brief = this.options.allowStub
        ? lane === HUMAN_INTELLIGENCE_LANE
          ? stubCompile(events, memories)
          : stubCompileAgent(events, memories)
        : null;
      const caller = this.options.caller;
      if (caller && selection.provider && selection.model) {
        const result = await caller({
          provider: selection.provider,
          model: selection.model,
          effort: selection.effort,
          customBotId: selection.customBotId,
          prompt: lane === HUMAN_INTELLIGENCE_LANE
            ? compilerPrompt(events, memories)
            : agentCompilerPrompt(events, memories),
        });
        if (result.createdWorkhorseChat !== false || result.leftoverVendorThread !== false) {
          throw new Error("auxiliary-pollution");
        }
        const parsed = parseBriefText(result.text);
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        });
        if (!parsed) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
            status: "failed",
            errorClass: "invalid-brief",
            endedAt: this.now(),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
          });
          return { ran: false, skipped: "invalid-brief", runId, ...route };
        }
        if (
          parsed.intent.length + parsed.operations.length === 0 &&
          (lane === HUMAN_INTELLIGENCE_LANE ? eventsRequireMemory(events) : eventsRequireAgentMemory(events))
        ) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
            status: "failed",
            errorClass: "empty-explicit-brief",
            endedAt: this.now(),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
          });
          return { ran: false, skipped: "empty-explicit-brief", runId, ...route };
        }
        if (lane === AGENT_INTELLIGENCE_LANE && parsed.intent.length > 0) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
            status: "failed",
            errorClass: "cross-lane-output",
            endedAt: this.now(),
          });
          return { ran: false, skipped: "cross-lane-output", runId, ...route };
        }
        const inputEventIds = new Set(events.map((event) => event.id));
        const hasInvalidEvidence = [...parsed.intent, ...parsed.operations].some(
          (proposal) =>
            proposal.sourceEventIds.length === 0 || proposal.sourceEventIds.some((eventId) => !inputEventIds.has(eventId)),
        );
        if (hasInvalidEvidence) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
            status: "failed",
            errorClass: "invalid-source-evidence",
            endedAt: this.now(),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
          });
          return { ran: false, skipped: "invalid-source-evidence", runId, ...route };
        }
        brief = parsed;
      } else if (!this.options.allowStub && selection.provider) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "no-ephemeral-provider",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "no-ephemeral-provider", runId, ...route };
      } else if (!this.options.allowStub && !selection.provider) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "no-ephemeral-provider",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "no-ephemeral-provider", runId, ...route };
      }
      if (!brief) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "invalid-brief",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "invalid-brief", runId, ...route };
      }
      const outputIds: string[] = [];
      const apply = (proposal: (typeof brief.intent)[number]) => {
        const sourceEvents = events.filter((event) => proposal.sourceEventIds.includes(event.id));
        const verified = sourceEvents
          .some((event) => outcomeIsVerified((event.payload.signals as Parameters<typeof outcomeIsVerified>[0]) ?? {}));
        const correlationIds = [...new Set(sourceEvents.map((event) => event.correlationId).filter((id): id is string => Boolean(id)))];
        const status = promoteProposal(proposal, mode, verified || learningAutoPromotes(mode) && proposal.memoryClass === "intent");
        if (proposal.supersedesId) {
          const previous = this.options.store.getMemory(proposal.supersedesId);
          if (previous?.intelligenceLane === lane) {
            this.options.store.putMemory({ ...previous, status: "superseded", supersededAt: this.now() });
          }
        }
        if (proposal.contradictsId) {
          const previous = this.options.store.getMemory(proposal.contradictsId);
          if (previous?.intelligenceLane === lane) {
            this.options.store.putMemory({ ...previous, status: "superseded", supersededAt: this.now() });
          }
        }
        const id = newMemoryId();
        this.options.store.putMemory({
          id,
          intelligenceLane: lane,
          memoryClass: proposal.memoryClass,
          scope: proposal.scope,
          projectId: proposal.projectId ?? sourceEvents.find((event) => event.projectId)?.projectId,
          providerScope: proposal.providerScope ?? (lane === AGENT_INTELLIGENCE_LANE ? sourceEvents.find((event) => event.provider)?.provider : undefined),
          statement: proposal.statement,
          tags: proposal.tags,
          sourceEventIds: proposal.sourceEventIds,
          correlationIds: correlationIds.length > 0 ? correlationIds : undefined,
          compilerRunId: runId,
          confidence: proposal.confidence,
          verification: verified ? "accepted" : "unverified",
          createdAt: this.now(),
          supersedesId: proposal.supersedesId,
          contradictsId: proposal.contradictsId,
          status,
        });
        outputIds.push(id);
      };
      for (const proposal of brief.intent) apply(proposal);
      for (const proposal of brief.operations) apply(proposal);
      this.options.store.putCompilerRun({
        ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
        status: "completed",
        endedAt: this.now(),
        outputMemoryIds: outputIds,
        eventWatermark: events.at(-1)?.id,
      });
      return { ran: true, runId, memories: outputIds.length, ...route };
    } catch (error) {
      const current = this.options.store.getCompilerRun(runId);
      this.options.store.putCompilerRun({
        ...(current ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
        status: attempt >= this.policy().maxAttempts ? "failed" : "interrupted",
        errorClass: error instanceof Error ? error.message : "compile-failed",
        endedAt: this.now(),
      });
      throw error;
    } finally {
      this.compiling = false;
      this.schedule();
    }
  }

  private async compileMismatch(input: { resume?: string }, resumeRun?: CompilerRun): Promise<CompileResult> {
    const mode = this.mode();
    const lane = MISMATCH_INTELLIGENCE_LANE;
    const memories = this.mismatchInputs();
    if (memories.length === 0) return { ran: false, skipped: "empty", intelligenceLane: lane };
    const inputHash = compilerInputHash([], memories, lane);
    const existing = this.options.store
      .listCompilerRuns()
      .find((run) => run.intelligenceLane === lane && run.inputHash === inputHash && run.status === "completed");
    if (existing && !input.resume) {
      return { ran: false, skipped: "duplicate", runId: existing.id, intelligenceLane: lane };
    }
    const resumed = resumeRun?.intelligenceLane === lane ? resumeRun : undefined;
    if (resumed && resumed.attempt >= this.policy().maxAttempts) {
      this.options.store.putCompilerRun({ ...resumed, status: "failed", errorClass: "max-attempts", endedAt: this.now() });
      return { ran: false, skipped: "max-attempts", runId: resumed.id, intelligenceLane: lane };
    }
    const settings = this.options.settings();
    const selection = selectAdaptiveRoute({
      candidates: this.options.candidates?.() ?? [],
      explicit: effectiveCompilerAssignment(settings),
      outcomes: this.options.outcomes?.(),
      taskClass: "learning-reconcile-mismatch",
      capacityAware: true,
      preferQuality: true,
    });
    const route = {
      provider: selection.provider,
      model: selection.model,
      customBotId: selection.customBotId,
      intelligenceLane: lane,
    };
    const runId = resumed?.id ?? newRunId();
    const attempt = (resumed?.attempt ?? 0) + 1;
    this.compiling = true;
    this.options.store.putCompilerRun({
      id: runId,
      intelligenceLane: lane,
      status: "running",
      attempt,
      startedAt: this.now(),
      inputHash,
      inputMemoryIds: memories.map((item) => item.id),
      memoryWatermark: memories.at(-1)?.id,
      inputFrom: memories[0]?.createdAt,
      inputTo: memories.at(-1)?.createdAt,
      provider: selection.provider,
      model: selection.model,
      effort: selection.effort,
      rationale: selection.reason,
    });
    try {
      let brief = this.options.allowStub ? stubReconcile(memories) : null;
      const caller = this.options.caller;
      if (caller && selection.provider && selection.model) {
        const result = await caller({
          provider: selection.provider,
          model: selection.model,
          effort: selection.effort,
          customBotId: selection.customBotId,
          prompt: mismatchCompilerPrompt(memories),
        });
        if (result.createdWorkhorseChat !== false || result.leftoverVendorThread !== false) {
          throw new Error("auxiliary-pollution");
        }
        brief = parseBriefText(result.text);
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        });
        if (!brief) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
            status: "failed",
            errorClass: "invalid-brief",
            endedAt: this.now(),
          });
          return { ran: false, skipped: "invalid-brief", runId, ...route };
        }
      } else if (!this.options.allowStub) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "no-ephemeral-provider",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "no-ephemeral-provider", runId, ...route };
      }
      if (!brief || brief.intent.length > 0) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: brief ? "cross-lane-output" : "invalid-brief",
          endedAt: this.now(),
        });
        return { ran: false, skipped: brief ? "cross-lane-output" : "invalid-brief", runId, ...route };
      }
      const byId = new Map(memories.map((item) => [item.id, item]));
      const validProposal = (proposal: (typeof brief.operations)[number]) => {
        const sources = (proposal.sourceMemoryIds ?? []).map((id) => byId.get(id)).filter((item): item is MemoryItem => Boolean(item));
        const humans = sources.filter((item) => item.intelligenceLane === HUMAN_INTELLIGENCE_LANE);
        const agents = sources.filter((item) => item.intelligenceLane === AGENT_INTELLIGENCE_LANE);
        return (
          sources.length === proposal.sourceMemoryIds?.length &&
          humans.length > 0 &&
          agents.length > 0 &&
          humans.some((human) =>
            agents.some(
              (agent) =>
                human.projectId === agent.projectId &&
                (human.correlationIds ?? []).some((id) => agent.correlationIds?.includes(id)),
            ),
          )
        );
      };
      if (brief.operations.some((proposal) => !validProposal(proposal))) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "invalid-source-evidence",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "invalid-source-evidence", runId, ...route };
      }
      const outputIds: string[] = [];
      for (const proposal of brief.operations) {
        const sources = (proposal.sourceMemoryIds ?? []).map((id) => byId.get(id)).filter((item): item is MemoryItem => Boolean(item));
        const sourceEventIds = [...new Set(sources.flatMap((item) => item.sourceEventIds))];
        const correlationIds = [...new Set(sources.flatMap((item) => item.correlationIds ?? []))];
        const human = sources.find((item) => item.intelligenceLane === HUMAN_INTELLIGENCE_LANE);
        const agent = sources.find((item) => item.intelligenceLane === AGENT_INTELLIGENCE_LANE);
        const id = newMemoryId();
        this.options.store.putMemory({
          id,
          intelligenceLane: lane,
          memoryClass: "operations",
          scope: "project",
          projectId: human?.projectId ?? agent?.projectId,
          providerScope: agent?.providerScope,
          statement: proposal.statement,
          tags: proposal.tags,
          sourceEventIds,
          sourceMemoryIds: proposal.sourceMemoryIds,
          correlationIds,
          compilerRunId: runId,
          confidence: proposal.confidence,
          verification: "unverified",
          createdAt: this.now(),
          status: mode === "review" ? "proposed" : "active",
        });
        outputIds.push(id);
      }
      this.options.store.putCompilerRun({
        ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
        status: "completed",
        endedAt: this.now(),
        outputMemoryIds: outputIds,
        inputMemoryIds: memories.map((item) => item.id),
        memoryWatermark: memories.at(-1)?.id,
      });
      return { ran: true, runId, memories: outputIds.length, ...route };
    } catch (error) {
      const current = this.options.store.getCompilerRun(runId);
      this.options.store.putCompilerRun({
        ...(current ?? { id: runId, intelligenceLane: lane, status: "running", attempt, inputHash }),
        status: attempt >= this.policy().maxAttempts ? "failed" : "interrupted",
        errorClass: error instanceof Error ? error.message : "compile-failed",
        endedAt: this.now(),
      });
      throw error;
    } finally {
      this.compiling = false;
      this.schedule();
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}

export { learningCaptures };
