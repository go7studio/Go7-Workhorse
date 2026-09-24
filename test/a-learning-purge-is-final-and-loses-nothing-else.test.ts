/*
 * Purge and forget in the learning store: what they take is gone for good,
 * and nothing they keep is put at risk on the way.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteMemoryStore } from "../electron/learning-sqlite";
import { LearningService } from "../electron/learning-service";
import { prepareEvent } from "../src/lib/learning-redact";
import type { LearningEvent } from "../src/lib/learning-types";

function tempUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "workhorse-purge-"));
}

function said(id: string, projectId: string, createdAt: number): LearningEvent {
  return prepareEvent({ id, createdAt, kind: "human-prompt", actorClass: "human", projectId, payload: { summary: `said in ${projectId}` } });
}

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

test("a purge the swap fails on leaves every row where it was, and the store open", (t) => {
  const userData = tempUserData();
  const store = new SqliteMemoryStore(userData);
  for (let index = 0; index < 20; index += 1) store.recordEvent(said(`lev_${index}`, index % 2 ? "proj_keep" : "proj_drop", 1_000 + index));
  // The moment a crash or a locked file would stop the purge: the new file
  // is ready and has not yet taken the live one's place.
  t.mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  });

  assert.throws(() => store.purge({ projectId: "proj_drop" }));
  t.mock.restoreAll();

  assert.equal(store.listEvents({ includeTombstones: true }).length, 20, "the store is open and holds everything");
  store.close();
  const reread = new SqliteMemoryStore(userData);
  assert.equal(reread.listEvents({ includeTombstones: true }).length, 20, "and so does the file on disk");
  reread.close();
  fs.rmSync(userData, { recursive: true, force: true });
});

test("a rebuild file a crash left behind does not stop the next purge", () => {
  const userData = tempUserData();
  const store = new SqliteMemoryStore(userData);
  store.recordEvent(said("lev_keep", "proj_keep", 1));
  store.recordEvent(said("lev_drop", "proj_drop", 2));
  const leftover = new DatabaseSync(`${store.path}.rebuild`);
  leftover.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('schema_version', '1');");
  leftover.close();

  const purged = store.purge({ projectId: "proj_drop" });

  assert.equal(purged.verifiedAbsent, true);
  assert.deepEqual(store.listEvents().map((event) => event.id), ["lev_keep"]);
  assert.ok(!fs.existsSync(`${store.path}.rebuild`));
  store.close();
  fs.rmSync(userData, { recursive: true, force: true });
});
