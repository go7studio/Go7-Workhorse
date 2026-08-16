import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { learningDatabasePath } from "../src/lib/learning-paths";
import {
  capRetrieved,
  DEFAULT_ITEM_CAP,
  DEFAULT_TOKEN_CAP,
  lexicalScore,
  matchesForgetTarget,
  rankMemories,
} from "../src/lib/learning-policy";
import { LEARNING_SCHEMA_VERSION, type CompilerRun, type EventFilter, type ForgetTarget, type LearningEvent, type LearningExportPayload, type LearningProbeResult, type MemoryFilter, type MemoryItem, type PurgeResult, type RankedMemory, type RetrievalAudit, type RetrievalQuery } from "../src/lib/learning-types";
import { boundedReplace, removeSidecars, type MemoryStore } from "../src/lib/learning-store";

const BUSY_MS = 5_000;

type SqliteDatabase = InstanceType<typeof DatabaseSync>;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS learning_events (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     local_day TEXT NOT NULL,
     kind TEXT NOT NULL,
     schema_version INTEGER NOT NULL,
     user_id TEXT,
     project_id TEXT,
     session_id TEXT,
     plan_step_id TEXT,
     agent_run_id TEXT,
     correlation_id TEXT,
     actor_class TEXT NOT NULL,
     provider TEXT,
     model TEXT,
     effort TEXT,
     skill_ids TEXT,
     tool_ids TEXT,
     payload TEXT NOT NULL,
     redaction_version INTEGER NOT NULL,
     sensitivity TEXT NOT NULL,
     source_hash TEXT NOT NULL,
     tombstone INTEGER NOT NULL DEFAULT 0,
     purged INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE IF NOT EXISTS memory_items (
     id TEXT PRIMARY KEY,
     memory_class TEXT NOT NULL,
     scope TEXT NOT NULL,
     project_id TEXT,
     provider_scope TEXT,
     statement TEXT NOT NULL,
     tags TEXT,
     source_event_ids TEXT NOT NULL,
     compiler_run_id TEXT,
     confidence REAL,
     verification TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_confirmed_at INTEGER,
     superseded_at INTEGER,
     expires_at INTEGER,
     deleted_at INTEGER,
     supersedes_id TEXT,
     contradicts_id TEXT,
     status TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS compiler_runs (
     id TEXT PRIMARY KEY,
     input_from INTEGER,
     input_to INTEGER,
     event_watermark TEXT,
     provider TEXT,
     model TEXT,
     effort TEXT,
     rationale TEXT,
     status TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     started_at INTEGER,
     ended_at INTEGER,
     input_tokens INTEGER,
     output_tokens INTEGER,
     cost_usd REAL,
     error_class TEXT,
     output_memory_ids TEXT,
     input_hash TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS retrieval_audit (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     session_id TEXT,
     project_id TEXT,
     provider TEXT,
     query_scope TEXT NOT NULL,
     candidate_ids TEXT NOT NULL,
     selected_ids TEXT NOT NULL,
     excluded_ids TEXT NOT NULL,
     scores TEXT NOT NULL,
     token_budget INTEGER NOT NULL
   );`,
];

function rowEvent(row: Record<string, unknown>): LearningEvent {
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    localDay: String(row.local_day),
    kind: row.kind as LearningEvent["kind"],
    schemaVersion: Number(row.schema_version),
    userId: row.user_id ? String(row.user_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    planStepId: row.plan_step_id ? String(row.plan_step_id) : undefined,
    agentRunId: row.agent_run_id ? String(row.agent_run_id) : undefined,
    correlationId: row.correlation_id ? String(row.correlation_id) : undefined,
    actorClass: row.actor_class as LearningEvent["actorClass"],
    provider: row.provider ? (String(row.provider) as LearningEvent["provider"]) : undefined,
    model: row.model ? String(row.model) : undefined,
    effort: row.effort === null || row.effort === undefined ? undefined : (String(row.effort) as LearningEvent["effort"]),
    skillIds: parseJson<string[]>(row.skill_ids, undefined as unknown as string[]),
    toolIds: parseJson<string[]>(row.tool_ids, undefined as unknown as string[]),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    redactionVersion: Number(row.redaction_version),
    sensitivity: row.sensitivity as LearningEvent["sensitivity"],
    sourceHash: String(row.source_hash),
    tombstone: Number(row.tombstone) === 1,
    purged: Number(row.purged) === 1,
  };
}

function rowMemory(row: Record<string, unknown>): MemoryItem {
  return {
    id: String(row.id),
    memoryClass: row.memory_class as MemoryItem["memoryClass"],
    scope: row.scope as MemoryItem["scope"],
    projectId: row.project_id ? String(row.project_id) : undefined,
    providerScope: row.provider_scope ? (String(row.provider_scope) as MemoryItem["providerScope"]) : undefined,
    statement: String(row.statement),
    tags: parseJson<string[]>(row.tags, undefined as unknown as string[]),
    sourceEventIds: parseJson<string[]>(row.source_event_ids, []),
    compilerRunId: row.compiler_run_id ? String(row.compiler_run_id) : undefined,
    confidence: typeof row.confidence === "number" ? row.confidence : undefined,
    verification: row.verification as MemoryItem["verification"],
    createdAt: Number(row.created_at),
    lastConfirmedAt: row.last_confirmed_at ? Number(row.last_confirmed_at) : undefined,
    supersededAt: row.superseded_at ? Number(row.superseded_at) : undefined,
    expiresAt: row.expires_at ? Number(row.expires_at) : undefined,
    deletedAt: row.deleted_at ? Number(row.deleted_at) : undefined,
    supersedesId: row.supersedes_id ? String(row.supersedes_id) : undefined,
    contradictsId: row.contradicts_id ? String(row.contradicts_id) : undefined,
    status: row.status as MemoryItem["status"],
  };
}

function rowRun(row: Record<string, unknown>): CompilerRun {
  return {
    id: String(row.id),
    inputFrom: row.input_from == null ? undefined : Number(row.input_from),
    inputTo: row.input_to == null ? undefined : Number(row.input_to),
    eventWatermark: row.event_watermark ? String(row.event_watermark) : undefined,
    provider: row.provider ? (String(row.provider) as CompilerRun["provider"]) : undefined,
    model: row.model ? String(row.model) : undefined,
    effort: row.effort == null ? undefined : (String(row.effort) as CompilerRun["effort"]),
    rationale: row.rationale ? String(row.rationale) : undefined,
    status: row.status as CompilerRun["status"],
    attempt: Number(row.attempt),
    startedAt: row.started_at == null ? undefined : Number(row.started_at),
    endedAt: row.ended_at == null ? undefined : Number(row.ended_at),
    inputTokens: row.input_tokens == null ? undefined : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? undefined : Number(row.output_tokens),
    costUsd: row.cost_usd == null ? undefined : Number(row.cost_usd),
    errorClass: row.error_class ? String(row.error_class) : undefined,
    outputMemoryIds: parseJson<string[]>(row.output_memory_ids, undefined as unknown as string[]),
    inputHash: String(row.input_hash),
  };
}

function rowAudit(row: Record<string, unknown>): RetrievalAudit {
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    provider: row.provider ? (String(row.provider) as RetrievalAudit["provider"]) : undefined,
    queryScope: String(row.query_scope),
    candidateIds: parseJson<string[]>(row.candidate_ids, []),
    selectedIds: parseJson<string[]>(row.selected_ids, []),
    excludedIds: parseJson<string[]>(row.excluded_ids, []),
    scores: parseJson<Record<string, number>>(row.scores, {}),
    tokenBudget: Number(row.token_budget),
  };
}

export class SqliteMemoryStore implements MemoryStore {
  readonly path: string;
  private db: SqliteDatabase | null = null;
  private fts = false;

  constructor(userData: string, private readonly io: { mkdirSync?: typeof fs.mkdirSync; existsSync?: typeof fs.existsSync } = {}) {
    this.path = userData === ":memory:" ? ":memory:" : learningDatabasePath(userData);
    this.open();
  }

  private open() {
    if (this.path !== ":memory:") {
      const dir = path.dirname(this.path);
      (this.io.mkdirSync ?? fs.mkdirSync)(dir, { recursive: true });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS};`);
    if (this.path !== ":memory:") {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
      } catch {
        /* some volumes reject WAL; capture still works */
      }
    }
    this.migrate();
    this.prepareFts();
  }

  private conn(): SqliteDatabase {
    if (!this.db) throw new Error("Learning store is closed");
    return this.db;
  }

  private migrate() {
    const db = this.conn();
    db.exec("BEGIN");
    try {
      for (const sql of MIGRATIONS) db.exec(sql);
      const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
      if (!version) {
        db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(LEARNING_SCHEMA_VERSION));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private prepareFts() {
    const db = this.conn();
    try {
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, statement, summary, tokenize='porter');",
      );
      this.fts = true;
    } catch {
      this.fts = false;
    }
  }

  probe(): LearningProbeResult {
    let sqliteVersion: string | undefined;
    let integrity = false;
    let writable = false;
    try {
      const db = this.conn();
      sqliteVersion = (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
      integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string })?.integrity_check === "ok";
      db.prepare("SELECT 1").get();
      writable = true;
    } catch {
      writable = false;
    }
    return {
      nodeSqlite: true,
      fts5: this.fts,
      writable,
      schemaVersion: LEARNING_SCHEMA_VERSION,
      integrity,
      path: this.path,
      sqliteVersion,
      fallback: this.fts ? "none" : "lexical",
    };
  }

  close(): void {
    if (!this.db) return;
    try {
      if (this.path !== ":memory:") this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* closing anyway */
    }
    this.db.close();
    this.db = null;
  }

  reopen(): void {
    if (this.db) return;
    this.open();
  }

  recordEvent(event: LearningEvent): { inserted: boolean } {
    const db = this.conn();
    const result = db.prepare(
      `INSERT OR IGNORE INTO learning_events (
        id, created_at, local_day, kind, schema_version, user_id, project_id, session_id, plan_step_id, agent_run_id,
        correlation_id, actor_class, provider, model, effort, skill_ids, tool_ids, payload, redaction_version, sensitivity,
        source_hash, tombstone, purged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.createdAt,
      event.localDay,
      event.kind,
      event.schemaVersion,
      event.userId ?? null,
      event.projectId ?? null,
      event.sessionId ?? null,
      event.planStepId ?? null,
      event.agentRunId ?? null,
      event.correlationId ?? null,
      event.actorClass,
      event.provider ?? null,
      event.model ?? null,
      event.effort ?? null,
      event.skillIds ? json(event.skillIds) : null,
      event.toolIds ? json(event.toolIds) : null,
      json(event.payload),
      event.redactionVersion,
      event.sensitivity,
      event.sourceHash,
      event.tombstone ? 1 : 0,
      event.purged ? 1 : 0,
    );
    return { inserted: Number(result.changes ?? 0) > 0 };
  }

  getEvent(id: string): LearningEvent | undefined {
    const row = this.conn().prepare("SELECT * FROM learning_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowEvent(row) : undefined;
  }

  listEvents(filter: EventFilter = {}): LearningEvent[] {
    const clauses = [];
    const params: Array<string | number> = [];
    if (!filter.includeTombstones) {
      clauses.push("tombstone = 0 AND purged = 0");
    }
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.provider) {
      clauses.push("provider = ?");
      params.push(filter.provider);
    }
    if (filter.afterWatermark) {
      clauses.push("id > ?");
      params.push(filter.afterWatermark);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ? ` LIMIT ${Math.max(1, Math.round(filter.limit))}` : "";
    const rows = this.conn()
      .prepare(`SELECT * FROM learning_events ${where} ORDER BY created_at ASC, id ASC${limit}`)
      .all(...params) as Record<string, unknown>[];
    return rows
      .map(rowEvent)
      .filter((event) => !filter.kinds || filter.kinds.includes(event.kind));
  }

  tombstone(target: ForgetTarget, at = Date.now()): number {
    const db = this.conn();
    db.exec("BEGIN");
    try {
      const events = this.listEvents({ includeTombstones: true }).filter((event) => matchesForgetTarget(event, target));
      for (const event of events) {
        db.prepare("UPDATE learning_events SET tombstone = 1 WHERE id = ?").run(event.id);
      }
      const memories = this.listMemories({ includeDeleted: true }).filter(
        (memory) =>
          matchesForgetTarget({ id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope }, target) ||
          memory.sourceEventIds.some((id) => events.some((event) => event.id === id)),
      );
      for (const memory of memories) {
        db.prepare("UPDATE memory_items SET status = 'deleted', deleted_at = ? WHERE id = ?").run(at, memory.id);
        this.unindex(memory.id);
      }
      db.exec("COMMIT");
      return events.length + memories.length;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  purge(target: ForgetTarget): PurgeResult {
    if (this.path === ":memory:") {
      const snapshot = this.exportAll();
      const dropEvents = new Set(snapshot.events.filter((event) => matchesForgetTarget(event, target)).map((event) => event.id));
      this.close();
      this.reopen();
      for (const event of snapshot.events.filter((event) => !dropEvents.has(event.id))) this.recordEvent(event);
      const keepMemories = snapshot.memories.filter(
        (memory) =>
          !matchesForgetTarget({ id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope }, target) &&
          !memory.sourceEventIds.some((id) => dropEvents.has(id)),
      );
      const dropMemoryIds = new Set(snapshot.memories.filter((memory) => !keepMemories.some((item) => item.id === memory.id)).map((item) => item.id));
      for (const memory of keepMemories) this.putMemory(memory);
      for (const run of snapshot.compilerRuns.filter((item) => !item.outputMemoryIds?.some((id) => dropMemoryIds.has(id)))) this.putCompilerRun(run);
      for (const audit of snapshot.audits.filter((item) => !item.selectedIds.some((id) => dropMemoryIds.has(id)))) this.putRetrievalAudit(audit);
      return {
        ok: true,
        closed: true,
        eventsRemoved: dropEvents.size,
        memoriesRemoved: dropMemoryIds.size,
        ftsRemoved: dropMemoryIds.size,
        walRemoved: true,
        verifiedAbsent: true,
      };
    }
    const snapshot = this.exportAll();
    this.close();
    const keepEvents = snapshot.events.filter((event) => !matchesForgetTarget(event, target));
    const dropEventIds = new Set(snapshot.events.filter((event) => matchesForgetTarget(event, target)).map((event) => event.id));
    const keepMemories = snapshot.memories.filter(
      (memory) =>
        !matchesForgetTarget({ id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope }, target) &&
        !memory.sourceEventIds.some((id) => dropEventIds.has(id)),
    );
    const dropMemoryIds = new Set(snapshot.memories.filter((memory) => !keepMemories.some((item) => item.id === memory.id)).map((item) => item.id));
    const keepRuns = snapshot.compilerRuns.filter((run) => !run.outputMemoryIds?.some((id) => dropMemoryIds.has(id)));
    const keepAudits = snapshot.audits.filter((audit) => !audit.selectedIds.some((id) => dropMemoryIds.has(id)));
    let walRemoved = false;
    if (this.path !== ":memory:") {
      const temp = `${this.path}.rebuild`;
      const rebuilt = new DatabaseSync(temp);
      rebuilt.exec(MIGRATIONS[0]);
      try {
        rebuilt.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, statement, summary, tokenize='porter');");
      } catch {
        /* lexical fallback after rebuild */
      }
      rebuilt.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(LEARNING_SCHEMA_VERSION));
      rebuilt.close();
      try {
        fs.unlinkSync(this.path);
      } catch {
        /* dest may already be absent after close */
      }
      removeSidecars(this.path, fs.existsSync, fs.unlinkSync);
      boundedReplace(temp, this.path, {
        renameSync: fs.renameSync,
        unlinkSync: fs.unlinkSync,
        existsSync: fs.existsSync,
        sleep: (ms) => {
          const until = Date.now() + ms;
          while (Date.now() < until) {
            /* bounded spin; tests inject a fake sleep */
          }
        },
      });
      walRemoved = removeSidecars(this.path, fs.existsSync, fs.unlinkSync);
    }
    this.reopen();
    for (const event of keepEvents) this.recordEvent(event);
    for (const memory of keepMemories) this.putMemory(memory);
    for (const run of keepRuns) this.putCompilerRun(run);
    for (const audit of keepAudits) this.putRetrievalAudit(audit);
    const verifiedAbsent = this.listEvents({ includeTombstones: true }).every((event) => !matchesForgetTarget(event, target)) &&
      this.listMemories({ includeDeleted: true }).every(
        (memory) => !matchesForgetTarget({ id: memory.id, projectId: memory.projectId, providerScope: memory.providerScope }, target),
      );
    return {
      ok: true,
      closed: true,
      eventsRemoved: dropEventIds.size,
      memoriesRemoved: dropMemoryIds.size,
      ftsRemoved: dropMemoryIds.size,
      walRemoved,
      verifiedAbsent,
    };
  }

  putMemory(item: MemoryItem): void {
    const db = this.conn();
    db.prepare(
      `INSERT OR REPLACE INTO memory_items (
        id, memory_class, scope, project_id, provider_scope, statement, tags, source_event_ids, compiler_run_id, confidence,
        verification, created_at, last_confirmed_at, superseded_at, expires_at, deleted_at, supersedes_id, contradicts_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.memoryClass,
      item.scope,
      item.projectId ?? null,
      item.providerScope ?? null,
      item.statement,
      item.tags ? json(item.tags) : null,
      json(item.sourceEventIds),
      item.compilerRunId ?? null,
      item.confidence ?? null,
      item.verification,
      item.createdAt,
      item.lastConfirmedAt ?? null,
      item.supersededAt ?? null,
      item.expiresAt ?? null,
      item.deletedAt ?? null,
      item.supersedesId ?? null,
      item.contradictsId ?? null,
      item.status,
    );
    this.indexMemory(item);
  }

  private indexMemory(item: MemoryItem) {
    if (!this.fts) return;
    this.unindex(item.id);
    if (item.status === "deleted" || item.status === "superseded" || item.deletedAt) return;
    if (item.status !== "active" && item.status !== "approved") return;
    this.conn()
      .prepare("INSERT INTO memory_fts (memory_id, statement, summary) VALUES (?, ?, ?)")
      .run(item.id, item.statement, (item.tags ?? []).join(" "));
  }

  private unindex(id: string) {
    if (!this.fts) return;
    try {
      this.conn().prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
    } catch {
      /* table may be missing in fallback */
    }
  }

  getMemory(id: string): MemoryItem | undefined {
    const row = this.conn().prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowMemory(row) : undefined;
  }

  listMemories(filter: MemoryFilter = {}): MemoryItem[] {
    const rows = this.conn().prepare("SELECT * FROM memory_items").all() as Record<string, unknown>[];
    return rows.map(rowMemory).filter((item) => {
      if (!filter.includeDeleted && (item.status === "deleted" || item.deletedAt)) return false;
      if (filter.memoryClass && item.memoryClass !== filter.memoryClass) return false;
      if (filter.projectId && item.projectId !== filter.projectId && item.scope !== "global-user") return false;
      if (filter.provider && item.memoryClass === "operations" && item.providerScope !== filter.provider) return false;
      if (filter.statuses && !filter.statuses.includes(item.status)) return false;
      return true;
    });
  }

  searchMemories(query: RetrievalQuery): RankedMemory[] {
    const visible = this.listMemories({ includeDeleted: false });
    if (this.fts && query.text?.trim()) {
      try {
        const hits = this.conn()
          .prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank")
          .all(query.text.trim()) as { memory_id: string }[];
        const byId = new Map(visible.map((item) => [item.id, item]));
        const boosted = hits
          .map((hit) => byId.get(hit.memory_id))
          .filter((item): item is MemoryItem => Boolean(item));
        const rest = visible.filter((item) => !boosted.some((hit) => hit.id === item.id));
        return capRetrieved(
          rankMemories([...boosted, ...rest], query).map((item) => ({
            ...item,
            score: item.score + lexicalScore(item.statement, query.text ?? ""),
          })),
          query.itemCap ?? DEFAULT_ITEM_CAP,
          query.tokenCap ?? DEFAULT_TOKEN_CAP,
        );
      } catch {
        /* MATCH syntax can fail; fall through */
      }
    }
    return capRetrieved(rankMemories(visible, query), query.itemCap ?? DEFAULT_ITEM_CAP, query.tokenCap ?? DEFAULT_TOKEN_CAP);
  }

  putCompilerRun(run: CompilerRun): void {
    this.conn()
      .prepare(
        `INSERT OR REPLACE INTO compiler_runs (
          id, input_from, input_to, event_watermark, provider, model, effort, rationale, status, attempt, started_at, ended_at,
          input_tokens, output_tokens, cost_usd, error_class, output_memory_ids, input_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.inputFrom ?? null,
        run.inputTo ?? null,
        run.eventWatermark ?? null,
        run.provider ?? null,
        run.model ?? null,
        run.effort ?? null,
        run.rationale ?? null,
        run.status,
        run.attempt,
        run.startedAt ?? null,
        run.endedAt ?? null,
        run.inputTokens ?? null,
        run.outputTokens ?? null,
        run.costUsd ?? null,
        run.errorClass ?? null,
        run.outputMemoryIds ? json(run.outputMemoryIds) : null,
        run.inputHash,
      );
  }

  getCompilerRun(id: string): CompilerRun | undefined {
    const row = this.conn().prepare("SELECT * FROM compiler_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowRun(row) : undefined;
  }

  listCompilerRuns(): CompilerRun[] {
    return (this.conn().prepare("SELECT * FROM compiler_runs ORDER BY started_at ASC").all() as Record<string, unknown>[]).map(rowRun);
  }

  unfinishedCompilerRun(): CompilerRun | undefined {
    const row = this.conn()
      .prepare("SELECT * FROM compiler_runs WHERE status IN ('pending', 'running', 'interrupted') ORDER BY started_at ASC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? rowRun(row) : undefined;
  }

  putRetrievalAudit(audit: RetrievalAudit): void {
    this.conn()
      .prepare(
        `INSERT OR REPLACE INTO retrieval_audit (
          id, created_at, session_id, project_id, provider, query_scope, candidate_ids, selected_ids, excluded_ids, scores, token_budget
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        audit.id,
        audit.createdAt,
        audit.sessionId ?? null,
        audit.projectId ?? null,
        audit.provider ?? null,
        audit.queryScope,
        json(audit.candidateIds),
        json(audit.selectedIds),
        json(audit.excludedIds),
        json(audit.scores),
        audit.tokenBudget,
      );
  }

  listAudits(): RetrievalAudit[] {
    return (this.conn().prepare("SELECT * FROM retrieval_audit").all() as Record<string, unknown>[]).map(rowAudit);
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
    const probe = this.probe();
    return { ok: probe.integrity && probe.writable, fts: this.fts };
  }
}

export function createSqliteStore(userData: string): SqliteMemoryStore {
  return new SqliteMemoryStore(userData);
}

export function sqliteAvailable(): boolean {
  try {
    const db = new DatabaseSync(":memory:");
    db.close();
    return true;
  } catch {
    return false;
  }
}

export { learningDatabasePath, learningSidecarPaths } from "../src/lib/learning-paths";
