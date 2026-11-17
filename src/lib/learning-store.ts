import { uid } from "./id";
import { learningSidecarPaths } from "./learning-paths";
import {
  ABANDONED_INPUT,
  AGENT_INTELLIGENCE_LANE,
  boundedCompilerMemories,
  capRetrieved,
  DEFAULT_ITEM_CAP,
  DEFAULT_TOKEN_CAP,
  HUMAN_INTELLIGENCE_LANE,
  matchesForgetTarget,
  MISMATCH_INTELLIGENCE_LANE,
  rankMemories,
} from "./learning-policy";
import { boundStatement } from "./learning-redact";
import type {
  CompilerRun,
  EventFilter,
  IntelligenceLane,
  ForgetTarget,
  LearningEvent,
  LearningExportPayload,
  LearningIndexStats,
  LearningProbeResult,
  MemoryFilter,
  MemoryItem,
  PurgeResult,
  RankedMemory,
  RetrievalAudit,
  RetrievalQuery,
} from "./learning-types";
import { LEARNING_SCHEMA_VERSION } from "./learning-types";

export type FileOps = {
  existsSync: (file: string) => boolean;
  mkdirSync: (dir: string, opts?: { recursive?: boolean }) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (file: string) => void;
  writeFileSync: (file: string, data: string | Buffer) => void;
  rmSync?: (file: string, opts?: { force?: boolean }) => void;
};

export type ReplaceHooks = {
  renameSync: (from: string, to: string) => void;
  unlinkSync?: (file: string) => void;
  existsSync?: (file: string) => boolean;
  sleep?: (ms: number) => void;
  retries?: number;
  delayMs?: number;
};

/** Close-then-retry replace so Windows file locks cannot leave a half-renamed DB. */
export function boundedReplace(from: string, to: string, hooks: ReplaceHooks): void {
  const retries = hooks.retries ?? 8;
  const delayMs = hooks.delayMs ?? 25;
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      hooks.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) hooks.sleep?.(delayMs * (attempt + 1));
    }
  }
  try {
    hooks.unlinkSync?.(from);
  } catch {
    /* temp may already be gone */
  }
  throw lastError instanceof Error ? lastError : new Error("Bounded replace failed");
}

export function removeSidecars(dbPath: string, existsSync: (file: string) => boolean, unlinkSync: (file: string) => void): boolean {
  const { wal, shm } = learningSidecarPaths(dbPath);
  let removed = false;
  for (const file of [wal, shm]) {
    if (!existsSync(file)) continue;
    unlinkSync(file);
    removed = true;
  }
  return removed;
}

export function expandDependentMemoryIds(memories: MemoryItem[], seed: Set<string>): Set<string> {
  const expanded = new Set(seed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const memory of memories) {
      if (expanded.has(memory.id) || !memory.sourceMemoryIds?.some((id) => expanded.has(id))) continue;
      expanded.add(memory.id);
      changed = true;
    }
  }
  return expanded;
}

export interface MemoryStore {
  readonly path: string;
  probe(): LearningProbeResult;
  close(): void;
  reopen(): void;
  recordEvent(event: LearningEvent): { inserted: boolean };
  getEvent(id: string): LearningEvent | undefined;
  listEvents(filter?: EventFilter): LearningEvent[];
  tombstone(target: ForgetTarget, at?: number): number;
  purge(target: ForgetTarget): PurgeResult;
  putMemory(item: MemoryItem): void;
  getMemory(id: string): MemoryItem | undefined;
  listMemories(filter?: MemoryFilter): MemoryItem[];
  searchMemories(query: RetrievalQuery): RankedMemory[];
  putCompilerRun(run: CompilerRun): void;
  getCompilerRun(id: string): CompilerRun | undefined;
  listCompilerRuns(): CompilerRun[];
  /** The newest completed run in a lane. Reads the watermark without loading every run. */
  lastCompletedRun(lane: IntelligenceLane): CompilerRun | undefined;
  /** Runs already spent on one input, so an attempt budget can bind across ticks. */
  runsForInput(lane: IntelligenceLane, inputHash: string): CompilerRun[];
  /** Completed runs in one lane, without loading every run ever recorded. */
  listCompletedRuns(lane: IntelligenceLane): CompilerRun[];
  /** The newest run that settled a batch: compiled, or abandoned after its attempts. */
  lastSettledRun(lane: IntelligenceLane): CompilerRun | undefined;
  /** Every run that settled a batch in one lane, oldest first. */
  listSettledRuns(lane: IntelligenceLane): CompilerRun[];
  /** Memories a compile embeds, stopped at the same ceiling `boundedCompilerMemories` uses. */
  compilerMemories(lane: IntelligenceLane, maxMemoryChars: number): MemoryItem[];
  /** One unsettled human/agent pair, or none. Does not delete rows. */
  unreconciledPair(): MemoryItem[];
  /** Learning pane counts. */
  paneStats(): LearningIndexStats;
  unfinishedCompilerRun(): CompilerRun | undefined;
  putRetrievalAudit(audit: RetrievalAudit): void;
  listAudits(): RetrievalAudit[];
  exportAll(): LearningExportPayload;
  integrityCheck(): { ok: boolean; fts: boolean };
}

type MemoryState = {
  events: Map<string, LearningEvent>;
  memories: Map<string, MemoryItem>;
  runs: Map<string, CompilerRun>;
  audits: Map<string, RetrievalAudit>;
  closed: boolean;
};

function cloneEvent(event: LearningEvent): LearningEvent {
  return { ...event, payload: { ...event.payload }, skillIds: event.skillIds ? [...event.skillIds] : undefined, toolIds: event.toolIds ? [...event.toolIds] : undefined };
}

export class InMemoryStore implements MemoryStore {
  readonly path: string;
  private state: MemoryState = {
    events: new Map(),
    memories: new Map(),
    runs: new Map(),
    audits: new Map(),
    closed: false,
  };

  constructor(userDataPath = ":memory:") {
    this.path = userDataPath;
  }

  probe(): LearningProbeResult {
    return {
      nodeSqlite: false,
      fts5: false,
      writable: !this.state.closed,
      schemaVersion: LEARNING_SCHEMA_VERSION,
      integrity: true,
      path: this.path,
      fallback: "lexical",
    };
  }

  close(): void {
    this.state.closed = true;
  }

  reopen(): void {
    this.state.closed = false;
  }

  private assertOpen() {
    if (this.state.closed) throw new Error("Learning store is closed");
  }

  recordEvent(event: LearningEvent): { inserted: boolean } {
    this.assertOpen();
    if (this.state.events.has(event.id)) return { inserted: false };
    this.state.events.set(event.id, cloneEvent(event));
    return { inserted: true };
  }

  getEvent(id: string): LearningEvent | undefined {
    const event = this.state.events.get(id);
    return event ? cloneEvent(event) : undefined;
  }

  listEvents(filter: EventFilter = {}): LearningEvent[] {
    const watermark = filter.afterWatermark ? this.state.events.get(filter.afterWatermark) : undefined;
    const rows = [...this.state.events.values()]
      .filter((event) => {
        if (!filter.includeTombstones && (event.tombstone || event.purged)) return false;
        if (filter.projectId && event.projectId !== filter.projectId) return false;
        if (filter.provider && event.provider !== filter.provider) return false;
        if (filter.actorClass && event.actorClass !== filter.actorClass) return false;
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        if (
          watermark &&
          (event.createdAt < watermark.createdAt ||
            (event.createdAt === watermark.createdAt && event.id <= watermark.id))
        ) return false;
        return true;
      })
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return (filter.limit ? rows.slice(0, filter.limit) : rows).map(cloneEvent);
  }

  tombstone(target: ForgetTarget, at = Date.now()): number {
    this.assertOpen();
    let count = 0;
    for (const event of this.state.events.values()) {
      if (!matchesForgetTarget(event, target)) continue;
      event.tombstone = true;
      count += 1;
    }
    const memories = [...this.state.memories.values()];
    const direct = new Set(memories.filter((memory) =>
      matchesForgetTarget({ id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope }, target) ||
      memory.sourceEventIds.some((id) => this.state.events.get(id)?.tombstone),
    ).map((memory) => memory.id));
    const dropMemories = expandDependentMemoryIds(memories, direct);
    for (const memory of memories) {
      if (!dropMemories.has(memory.id)) continue;
      memory.status = "deleted";
      memory.deletedAt = at;
      count += 1;
    }
    return count;
  }

  purge(target: ForgetTarget): PurgeResult {
    this.close();
    const events = [...this.state.events.values()];
    const memories = [...this.state.memories.values()];
    const dropEvents = new Set(events.filter((event) => matchesForgetTarget(event, target)).map((event) => event.id));
    const directMemories = new Set(
      memories
        .filter(
          (memory) =>
            matchesForgetTarget({ id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope }, target) ||
            memory.sourceEventIds.some((id) => dropEvents.has(id)),
        )
        .map((memory) => memory.id),
    );
    const dropMemories = expandDependentMemoryIds(memories, directMemories);
    for (const id of dropEvents) this.state.events.delete(id);
    for (const id of dropMemories) this.state.memories.delete(id);
    for (const [id, audit] of [...this.state.audits.entries()]) {
      if (audit.selectedIds.some((memoryId) => dropMemories.has(memoryId))) this.state.audits.delete(id);
    }
    this.reopen();
    const verifiedAbsent = ![...this.state.events.values(), ...this.state.memories.values()].some((row) =>
      matchesForgetTarget(row, target),
    );
    return {
      ok: true,
      closed: true,
      eventsRemoved: dropEvents.size,
      memoriesRemoved: dropMemories.size,
      ftsRemoved: dropMemories.size,
      walRemoved: true,
      verifiedAbsent,
    };
  }

  putMemory(item: MemoryItem): void {
    this.assertOpen();
    this.state.memories.set(item.id, {
      ...item,
      intelligenceLane: item.intelligenceLane ?? "legacy-unclassified",
      statement: boundStatement(item.statement),
      sourceEventIds: [...item.sourceEventIds],
      sourceMemoryIds: item.sourceMemoryIds ? [...item.sourceMemoryIds] : undefined,
      correlationIds: item.correlationIds ? [...item.correlationIds] : undefined,
    });
  }

  getMemory(id: string): MemoryItem | undefined {
    const item = this.state.memories.get(id);
    return item
      ? {
          ...item,
          sourceEventIds: [...item.sourceEventIds],
          sourceMemoryIds: item.sourceMemoryIds ? [...item.sourceMemoryIds] : undefined,
          correlationIds: item.correlationIds ? [...item.correlationIds] : undefined,
        }
      : undefined;
  }

  listMemories(filter: MemoryFilter = {}): MemoryItem[] {
    return [...this.state.memories.values()]
      .filter((item) => {
        if (!filter.includeDeleted && (item.status === "deleted" || item.deletedAt)) return false;
        if (filter.intelligenceLane && item.intelligenceLane !== filter.intelligenceLane) return false;
        if (filter.memoryClass && item.memoryClass !== filter.memoryClass) return false;
        if (filter.projectId && item.projectId !== filter.projectId && item.scope !== "global-user") return false;
        if (filter.provider && item.memoryClass === "operations" && item.providerScope !== filter.provider) return false;
        if (filter.statuses && !filter.statuses.includes(item.status)) return false;
        return true;
      })
      .map((item) => ({
        ...item,
        sourceEventIds: [...item.sourceEventIds],
        sourceMemoryIds: item.sourceMemoryIds ? [...item.sourceMemoryIds] : undefined,
        correlationIds: item.correlationIds ? [...item.correlationIds] : undefined,
      }));
  }

  searchMemories(query: RetrievalQuery): RankedMemory[] {
    return capRetrieved(
      rankMemories(this.listMemories({ includeDeleted: false }), query),
      query.itemCap ?? DEFAULT_ITEM_CAP,
      query.tokenCap ?? DEFAULT_TOKEN_CAP,
    );
  }

  putCompilerRun(run: CompilerRun): void {
    this.assertOpen();
    this.state.runs.set(run.id, {
      ...run,
      intelligenceLane: run.intelligenceLane ?? "legacy-unclassified",
      outputMemoryIds: run.outputMemoryIds ? [...run.outputMemoryIds] : undefined,
      inputMemoryIds: run.inputMemoryIds ? [...run.inputMemoryIds] : undefined,
    });
  }

  getCompilerRun(id: string): CompilerRun | undefined {
    const run = this.state.runs.get(id);
    return run ? { ...run } : undefined;
  }

  listCompilerRuns(): CompilerRun[] {
    return [...this.state.runs.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  lastCompletedRun(lane: IntelligenceLane): CompilerRun | undefined {
    return this.listCompilerRuns()
      .filter((run) => run.intelligenceLane === lane && run.status === "completed")
      .at(-1);
  }

  runsForInput(lane: IntelligenceLane, inputHash: string): CompilerRun[] {
    return this.listCompilerRuns().filter((run) => run.intelligenceLane === lane && run.inputHash === inputHash);
  }

  listCompletedRuns(lane: IntelligenceLane): CompilerRun[] {
    return this.listCompilerRuns().filter((run) => run.intelligenceLane === lane && run.status === "completed");
  }

  listSettledRuns(lane: IntelligenceLane): CompilerRun[] {
    return this.listCompilerRuns().filter(
      (run) =>
        run.intelligenceLane === lane &&
        (run.status === "completed" || (run.status === "failed" && run.errorClass === ABANDONED_INPUT)),
    );
  }

  lastSettledRun(lane: IntelligenceLane): CompilerRun | undefined {
    return this.listSettledRuns(lane).at(-1);
  }

  unfinishedCompilerRun(): CompilerRun | undefined {
    return this.listCompilerRuns().find((run) => run.status === "running" || run.status === "interrupted" || run.status === "pending");
  }

  compilerMemories(lane: IntelligenceLane, maxMemoryChars: number): MemoryItem[] {
    return boundedCompilerMemories(
      this.listMemories({
        intelligenceLane: lane,
        statuses: ["active", "approved", "proposed"],
      }),
      maxMemoryChars,
    );
  }

  unreconciledPair(): MemoryItem[] {
    const statuses = ["active", "approved", "proposed"] as const;
    const rows = [...this.state.memories.values()];
    const laneStatus = (lane: IntelligenceLane, status: (typeof statuses)[number]) =>
      rows.filter((item) => item.intelligenceLane === lane && item.status === status && !item.deletedAt);
    const reconciled = new Set<string>();
    for (const run of this.state.runs.values()) {
      if (run.intelligenceLane !== MISMATCH_INTELLIGENCE_LANE) continue;
      const settled = run.status === "completed" || (run.status === "failed" && run.errorClass === ABANDONED_INPUT);
      if (!settled) continue;
      for (const id of run.inputMemoryIds ?? []) reconciled.add(id);
    }
    for (const status of statuses) {
      for (const human of laneStatus(HUMAN_INTELLIGENCE_LANE, status)) {
        if (!human.projectId) continue;
        for (const agentStatus of statuses) {
          for (const agent of laneStatus(AGENT_INTELLIGENCE_LANE, agentStatus)) {
            if (human.projectId !== agent.projectId) continue;
            if (!(human.correlationIds ?? []).some((id) => agent.correlationIds?.includes(id))) continue;
            if (reconciled.has(human.id) && reconciled.has(agent.id)) continue;
            return [this.copyMemory(human), this.copyMemory(agent)];
          }
        }
      }
    }
    return [];
  }

  private copyMemory(item: MemoryItem): MemoryItem {
    return {
      ...item,
      sourceEventIds: [...item.sourceEventIds],
      sourceMemoryIds: item.sourceMemoryIds ? [...item.sourceMemoryIds] : undefined,
      correlationIds: item.correlationIds ? [...item.correlationIds] : undefined,
    };
  }

  paneStats(): LearningIndexStats {
    const events = this.listEvents();
    const humanEvents = events.filter((event) => event.actorClass === "human");
    const agentEvents = events.filter((event) => event.actorClass === "agent");
    const memories = this.listMemories({ includeDeleted: false, intelligenceLane: HUMAN_INTELLIGENCE_LANE });
    const agentMemories = this.listMemories({ includeDeleted: false, intelligenceLane: AGENT_INTELLIGENCE_LANE });
    const mismatchMemories = this.listMemories({ includeDeleted: false, intelligenceLane: MISMATCH_INTELLIGENCE_LANE });
    const completedRuns = this.listCompilerRuns().filter(
      (run) => run.status === "completed" && run.intelligenceLane !== "legacy-unclassified",
    );
    const lastHuman = completedRuns.filter((run) => run.intelligenceLane === HUMAN_INTELLIGENCE_LANE).at(-1);
    const lastAgent = completedRuns.filter((run) => run.intelligenceLane === AGENT_INTELLIGENCE_LANE).at(-1);
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

  putRetrievalAudit(audit: RetrievalAudit): void {
    this.assertOpen();
    this.state.audits.set(audit.id, { ...audit, candidateIds: [...audit.candidateIds], selectedIds: [...audit.selectedIds], excludedIds: [...audit.excludedIds], scores: { ...audit.scores } });
  }

  listAudits(): RetrievalAudit[] {
    return [...this.state.audits.values()];
  }

  exportAll(): LearningExportPayload {
    return {
      exportedAt: Date.now(),
      schemaVersion: LEARNING_SCHEMA_VERSION,
      events: this.listEvents({ includeTombstones: true }),
      memories: this.listMemories({ includeDeleted: true }),
      compilerRuns: this.listCompilerRuns(),
      audits: this.listAudits(),
    };
  }

  integrityCheck(): { ok: boolean; fts: boolean } {
    return { ok: !this.state.closed, fts: false };
  }
}

export function newMemoryId(): string {
  return uid("mem");
}

export function newRunId(): string {
  return uid("lcr");
}

export function newAuditId(): string {
  return uid("lra");
}
