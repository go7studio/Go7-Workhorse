import { uid } from "./id";
import { learningSidecarPaths } from "./learning-paths";
import {
  capRetrieved,
  DEFAULT_ITEM_CAP,
  DEFAULT_TOKEN_CAP,
  matchesForgetTarget,
  rankMemories,
} from "./learning-policy";
import { boundStatement} from "./learning-redact";
import type {
  CompilerRun,
  EventFilter,
  ForgetTarget,
  LearningEvent,
  LearningExportPayload,
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
    const rows = [...this.state.events.values()]
      .filter((event) => {
        if (!filter.includeTombstones && (event.tombstone || event.purged)) return false;
        if (filter.projectId && event.projectId !== filter.projectId) return false;
        if (filter.provider && event.provider !== filter.provider) return false;
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        if (filter.afterWatermark && event.id <= filter.afterWatermark) return false;
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
    for (const memory of this.state.memories.values()) {
      if (
        !matchesForgetTarget(
          { id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope },
          target,
        ) &&
        !memory.sourceEventIds.some((id) => this.state.events.get(id)?.tombstone)
      ) {
        continue;
      }
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
    const dropMemories = new Set(
      memories
        .filter(
          (memory) =>
            matchesForgetTarget({ id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope }, target) ||
            memory.sourceEventIds.some((id) => dropEvents.has(id)),
        )
        .map((memory) => memory.id),
    );
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
    this.state.memories.set(item.id, { ...item, statement: boundStatement(item.statement), sourceEventIds: [...item.sourceEventIds] });
  }

  getMemory(id: string): MemoryItem | undefined {
    const item = this.state.memories.get(id);
    return item ? { ...item, sourceEventIds: [...item.sourceEventIds] } : undefined;
  }

  listMemories(filter: MemoryFilter = {}): MemoryItem[] {
    return [...this.state.memories.values()]
      .filter((item) => {
        if (!filter.includeDeleted && (item.status === "deleted" || item.deletedAt)) return false;
        if (filter.memoryClass && item.memoryClass !== filter.memoryClass) return false;
        if (filter.projectId && item.projectId !== filter.projectId && item.scope !== "global-user") return false;
        if (filter.provider && item.memoryClass === "operations" && item.providerScope !== filter.provider) return false;
        if (filter.statuses && !filter.statuses.includes(item.status)) return false;
        return true;
      })
      .map((item) => ({ ...item, sourceEventIds: [...item.sourceEventIds] }));
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
    this.state.runs.set(run.id, { ...run, outputMemoryIds: run.outputMemoryIds ? [...run.outputMemoryIds] : undefined });
  }

  getCompilerRun(id: string): CompilerRun | undefined {
    const run = this.state.runs.get(id);
    return run ? { ...run } : undefined;
  }

  listCompilerRuns(): CompilerRun[] {
    return [...this.state.runs.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  unfinishedCompilerRun(): CompilerRun | undefined {
    return this.listCompilerRuns().find((run) => run.status === "running" || run.status === "interrupted" || run.status === "pending");
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
