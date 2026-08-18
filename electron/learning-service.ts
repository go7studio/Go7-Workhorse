import { stubCompile } from "../src/lib/learning-compiler";
import { exportJsonl, exportMarkdown } from "../src/lib/learning-export";
import {
  boundedCompilerBatch,
  compilerInputHash,
  compilerPrompt,
  DEFAULT_COMPILER_POLICY,
  effectiveCompilerAssignment,
  effectiveLearningMode,
  eventsRequireMemory,
  frameRetrievedMemories,
  HUMAN_INTELLIGENCE_LANE,
  learningCaptures,
  learningCompiles,
  learningAutoPromotes,
  outcomeIsVerified,
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
    const memories = this.options.store.listMemories({ includeDeleted: false, intelligenceLane: HUMAN_INTELLIGENCE_LANE });
    const completed = this.options.store
      .listCompilerRuns()
      .filter((run) => run.intelligenceLane === HUMAN_INTELLIGENCE_LANE && run.status === "completed");
    const last = completed.at(-1);
    const watermarkIndex = last?.eventWatermark
      ? humanEvents.findIndex((event) => event.id === last.eventWatermark)
      : -1;
    return {
      indexedEvents: events.length,
      indexedHumanEvents: humanEvents.length,
      compiledEvents: watermarkIndex + 1,
      memories: memories.length,
      completedRuns: completed.length,
      latestEventAt: events.at(-1)?.createdAt,
      latestCompileAt: last?.endedAt,
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
          run.intelligenceLane === HUMAN_INTELLIGENCE_LANE &&
          (run.status === "running" || run.status === "interrupted" || run.status === "pending"),
      );
    if (unfinished) return this.compile({ resume: unfinished.id });
    return this.compileIfDue();
  }

  async compileIfDue(): Promise<CompileResult> {
    if (this.paused || this.sleeping) return { ran: false, skipped: "paused" };
    const mode = this.mode();
    if (!learningCompiles(mode)) return { ran: false, skipped: "mode" };
    const events = this.eligibleEvents();
    if (events.length < this.policy().minEligibleEvents) return { ran: false, skipped: "threshold" };
    return this.compile();
  }

  private eligibleEvents(): LearningEvent[] {
    const last = this.options.store
      .listCompilerRuns()
      .filter((run) => run.intelligenceLane === HUMAN_INTELLIGENCE_LANE && run.status === "completed")
      .at(-1);
    return this.options.store.listEvents({
      afterWatermark: last?.eventWatermark,
      actorClass: "human",
      limit: this.policy().maxEventsPerRun,
    });
  }

  async compile(input: { resume?: string } = {}): Promise<CompileResult> {
    if (this.compiling) return { ran: false, skipped: "busy" };
    const mode = this.mode();
    if (!learningCompiles(mode)) return { ran: false, skipped: "mode" };
    const pendingEvents = this.eligibleEvents();
    if (pendingEvents.length === 0) return { ran: false, skipped: "empty" };
    const memories = this.options.store.listMemories({
      intelligenceLane: HUMAN_INTELLIGENCE_LANE,
      statuses: ["active", "approved", "proposed"],
    });
    const events = boundedCompilerBatch(pendingEvents, memories, this.policy().maxPayloadChars);
    const inputHash = compilerInputHash(events, memories, HUMAN_INTELLIGENCE_LANE);
    const existing = this.options.store
      .listCompilerRuns()
      .find(
        (run) =>
          run.intelligenceLane === HUMAN_INTELLIGENCE_LANE && run.inputHash === inputHash && run.status === "completed",
      );
    if (existing && !input.resume) return { ran: false, skipped: "duplicate", runId: existing.id };

    const resumable = input.resume ? this.options.store.getCompilerRun(input.resume) : undefined;
    const resumed = resumable?.intelligenceLane === HUMAN_INTELLIGENCE_LANE ? resumable : undefined;
    if (resumed && resumed.attempt >= this.policy().maxAttempts) {
      this.options.store.putCompilerRun({ ...resumed, status: "failed", errorClass: "max-attempts", endedAt: this.now() });
      return { ran: false, skipped: "max-attempts", runId: resumed.id };
    }
    const settings = this.options.settings();
    const selection = selectAdaptiveRoute({
      candidates: this.options.candidates?.() ?? [],
      explicit: effectiveCompilerAssignment(settings),
      outcomes: this.options.outcomes?.(),
      taskClass: "learning-compile",
      capacityAware: true,
    });
    const route = {
      provider: selection.provider,
      model: selection.model,
      customBotId: selection.customBotId,
    };
    const runId = resumed?.id ?? newRunId();
    const attempt = (resumed?.attempt ?? 0) + 1;
    this.compiling = true;
    this.options.store.putCompilerRun({
      id: runId,
      intelligenceLane: HUMAN_INTELLIGENCE_LANE,
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
      let brief = this.options.allowStub ? stubCompile(events, memories) : null;
      const caller = this.options.caller;
      if (caller && selection.provider && selection.model) {
        const result = await caller({
          provider: selection.provider,
          model: selection.model,
          effort: selection.effort,
          customBotId: selection.customBotId,
          prompt: compilerPrompt(events, memories),
        });
        if (result.createdWorkhorseChat !== false || result.leftoverVendorThread !== false) {
          throw new Error("auxiliary-pollution");
        }
        const parsed = parseBriefText(result.text);
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        });
        if (!parsed) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
            status: "failed",
            errorClass: "invalid-brief",
            endedAt: this.now(),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
          });
          return { ran: false, skipped: "invalid-brief", runId, ...route };
        }
        if (parsed.intent.length + parsed.operations.length === 0 && eventsRequireMemory(events)) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
            status: "failed",
            errorClass: "empty-explicit-brief",
            endedAt: this.now(),
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
          });
          return { ran: false, skipped: "empty-explicit-brief", runId, ...route };
        }
        const inputEventIds = new Set(events.map((event) => event.id));
        const hasInvalidEvidence = [...parsed.intent, ...parsed.operations].some(
          (proposal) =>
            proposal.sourceEventIds.length === 0 || proposal.sourceEventIds.some((eventId) => !inputEventIds.has(eventId)),
        );
        if (hasInvalidEvidence) {
          this.options.store.putCompilerRun({
            ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
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
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "no-ephemeral-provider",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "no-ephemeral-provider", runId, ...route };
      } else if (!this.options.allowStub && !selection.provider) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "no-ephemeral-provider",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "no-ephemeral-provider", runId, ...route };
      }
      if (!brief) {
        this.options.store.putCompilerRun({
          ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
          status: "failed",
          errorClass: "invalid-brief",
          endedAt: this.now(),
        });
        return { ran: false, skipped: "invalid-brief", runId, ...route };
      }
      const outputIds: string[] = [];
      const apply = (proposal: (typeof brief.intent)[number]) => {
        const verified = events
          .filter((event) => proposal.sourceEventIds.includes(event.id))
          .some((event) => outcomeIsVerified((event.payload.signals as Parameters<typeof outcomeIsVerified>[0]) ?? {}));
        const status = promoteProposal(proposal, mode, verified || learningAutoPromotes(mode) && proposal.memoryClass === "intent");
        if (proposal.supersedesId) {
          const previous = this.options.store.getMemory(proposal.supersedesId);
          if (previous?.intelligenceLane === HUMAN_INTELLIGENCE_LANE) {
            this.options.store.putMemory({ ...previous, status: "superseded", supersededAt: this.now() });
          }
        }
        if (proposal.contradictsId) {
          const previous = this.options.store.getMemory(proposal.contradictsId);
          if (previous?.intelligenceLane === HUMAN_INTELLIGENCE_LANE) {
            this.options.store.putMemory({ ...previous, status: "superseded", supersededAt: this.now() });
          }
        }
        const id = newMemoryId();
        this.options.store.putMemory({
          id,
          intelligenceLane: HUMAN_INTELLIGENCE_LANE,
          memoryClass: proposal.memoryClass,
          scope: proposal.scope,
          projectId: proposal.projectId,
          providerScope: proposal.providerScope,
          statement: proposal.statement,
          tags: proposal.tags,
          sourceEventIds: proposal.sourceEventIds,
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
        ...(this.options.store.getCompilerRun(runId) ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
        status: "completed",
        endedAt: this.now(),
        outputMemoryIds: outputIds,
        eventWatermark: events.at(-1)?.id,
      });
      return { ran: true, runId, memories: outputIds.length, ...route };
    } catch (error) {
      const current = this.options.store.getCompilerRun(runId);
      this.options.store.putCompilerRun({
        ...(current ?? { id: runId, intelligenceLane: HUMAN_INTELLIGENCE_LANE, status: "running", attempt, inputHash }),
        status: attempt >= this.policy().maxAttempts ? "failed" : "interrupted",
        errorClass: error instanceof Error ? error.message : "compile-failed",
        endedAt: this.now(),
      });
      throw error;
    } finally {
      this.compiling = false;
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}

export { learningCaptures };
