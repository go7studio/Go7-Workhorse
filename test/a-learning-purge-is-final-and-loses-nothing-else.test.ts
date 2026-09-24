/*
 * Purge and forget in the learning store: what they take is gone for good,
 * and nothing they keep is put at risk on the way.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SqliteMemoryStore } from "../electron/learning-sqlite";
import { LearningService } from "../electron/learning-service";

/** A compile whose model call waits until the test lets it answer. */
function compileHeldAtTheModel(store: SqliteMemoryStore, cites: string) {
  let answer = () => {};
  const asked = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const service = new LearningService({
    store,
    settings: () => ({ mode: "automatic", autoRetrieve: false, compilerProvider: "custom", compilerModel: "m" }),
    allowStub: false,
    candidates: () => [{ provider: "custom" as const, model: "m", customBotId: "bot_a", connected: true, ephemeral: true, intelligence: 5, speed: 5, cost: 5 }],
    caller: async () => {
      await asked;
      return {
        text: JSON.stringify({
          intent: [{ memoryClass: "intent", statement: "The person wants tabs in the secret project", sourceEventIds: [cites], scope: "project" }],
          operations: [],
        }),
        createdWorkhorseChat: false,
        leftoverVendorThread: false,
      };
    },
  });
  return { service, answer: () => answer() };
}

test("a purge made while a compile waits on its model leaves no memory of what it purged", async () => {
  const store = new SqliteMemoryStore(":memory:");
  const { service, answer } = compileHeldAtTheModel(store, "lev_secret");
  service.record({ id: "lev_secret", createdAt: Date.now(), kind: "human-prompt", actorClass: "human", projectId: "proj_secret", payload: { summary: "use tabs" } });

  const compiling = service.compile();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.purge({ all: true }).verifiedAbsent, true);
  answer();
  const result = await compiling;

  assert.equal(result.ran, false);
  assert.deepEqual(store.listMemories({ includeDeleted: true }), [], "the compile wrote back what the purge took");
  store.close();
});

test("a forget made while a compile waits on its model leaves no memory drawn from what it forgot", async () => {
  const store = new SqliteMemoryStore(":memory:");
  const { service, answer } = compileHeldAtTheModel(store, "lev_secret");
  service.record({ id: "lev_secret", createdAt: Date.now(), kind: "human-prompt", actorClass: "human", projectId: "proj_secret", payload: { summary: "use tabs" } });

  const compiling = service.compile();
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.forget({ projectId: "proj_secret" });
  answer();
  await compiling;

  assert.deepEqual(
    store.listMemories({ includeDeleted: false }).map((memory) => memory.statement),
    [],
    "a live memory cites an event the person told the desk to forget",
  );
  store.close();
});
