import { LearningService } from "./learning-service";
import { SqliteMemoryStore } from "./learning-sqlite";
import type { LearningSettings } from "../src/lib/learning-types";

export type LearningSmokeResult = {
  ok: boolean;
  probe: ReturnType<SqliteMemoryStore["probe"]>;
  inserted: boolean;
  survivedRestart: boolean;
  compiled: boolean;
  retrieved: boolean;
  exported: boolean;
  purged: boolean;
  createdWorkhorseChat: false;
  leftoverVendorThread: false;
  path: string;
  error?: string;
};

export async function runLearningSmoke(userData: string): Promise<LearningSmokeResult> {
  const settings: LearningSettings = { mode: "automatic", autoRetrieve: false };
  const store = new SqliteMemoryStore(userData);
  const service = new LearningService({
    store,
    settings: () => settings,
    allowStub: true,
    policy: { quietMs: 0, minEligibleEvents: 1 },
  });
  const base = (patch: Partial<LearningSmokeResult> = {}): LearningSmokeResult => ({
    ok: false,
    probe: store.probe(),
    inserted: false,
    survivedRestart: false,
    compiled: false,
    retrieved: false,
    exported: false,
    purged: false,
    createdWorkhorseChat: false,
    leftoverVendorThread: false,
    path: store.path,
    ...patch,
  });
  try {
    const probe = service.probe();
    if (!probe.nodeSqlite || !probe.writable || !probe.integrity) {
      return base({ probe, error: "probe" });
    }
    const recorded = service.record({
      id: "lev_smoke",
      createdAt: Date.now(),
      kind: "human-prompt",
      actorClass: "human",
      projectId: "proj_smoke",
      payload: { summary: "Prefer conventional commits" },
    });
    service.close();
    service.reopen();
    const survivedRestart = Boolean(store.getEvent("lev_smoke"));
    const compiled = await service.recover();
    const retrieved = service.retrieve({ projectId: "proj_smoke", text: "commits", allowGlobal: false });
    const exported = service.exportBundle();
    const hadExport = exported.jsonl.includes("lev_smoke");
    const purged = service.purge({ projectId: "proj_smoke" });
    const gone = !store.getEvent("lev_smoke") && store.listMemories({ includeDeleted: true }).every((item) => item.projectId !== "proj_smoke");
    const ok = Boolean(
      recorded.inserted && survivedRestart && compiled.ran && retrieved.items.length > 0 && hadExport && purged.verifiedAbsent && gone,
    );
    return base({
      ok,
      probe,
      inserted: recorded.inserted,
      survivedRestart,
      compiled: Boolean(compiled.ran),
      retrieved: retrieved.items.length > 0,
      exported: hadExport,
      purged: purged.verifiedAbsent && gone,
    });
  } catch (error) {
    return base({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    try {
      store.close();
    } catch {
      /* smoke exit */
    }
  }
}
