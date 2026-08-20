import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORKER_BOUND_ELSEWHERE_ERROR,
  WORKER_NAMES,
  findReusableWorker,
  nextWorkerName,
  reserveWorkerName,
  resolveNamedWorker,
  workerTaskTitle,
  workerIsFree,
  workerEndedWell,
  workerNameFromTitle,
  type WorkerRecord,
} from "../src/lib/subagents";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A worker used to be anonymous and disposable. An orchestrator finished a
 * Grok 4.6 medium slice, then started a SECOND Grok 4.6 medium from cold for
 * the next slice on the same project — the first idle beside it, still
 * holding the tree and the task. Same again for two Sol mediums.
 */

const worker = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({
  id: "w1",
  workerName: "Wren",
  provider: "grok",
  model: "grok-4.6",
  effort: "medium",
  projectId: "p1",
  parentId: "boss",
  hidden: true,
  status: "idle",
  ...over,
});

// An unnamed pick only continues the parent's current wave, so the scope has
// to say which workers are in it. These are the ids the fixtures below use.
const scope = { parentId: "boss", projectId: "p1", waveChildIds: ["w1", "old", "recent"] };
const want = { provider: "grok" as const, model: "grok-4.6", effort: "medium" as const };

test("a name is given once and kept", () => {
  assert.equal(nextWorkerName([]), WORKER_NAMES[0]);
  assert.equal(nextWorkerName([WORKER_NAMES[0]]), WORKER_NAMES[1]);
  // Case and padding are how a duplicate sneaks in.
  assert.equal(nextWorkerName([" wren ", "DEXTER"]), WORKER_NAMES[2]);
});

test("a reused worker shows its current slice", () => {
  assert.equal(workerTaskTitle("Dexter", "Add Software JSON-LD"), "Dexter · Add Software JSON-LD");
  assert.equal(workerNameFromTitle("Dexter · Add Software JSON-LD"), "Dexter");
  assert.equal(workerNameFromTitle("Wren 2 · Audit"), "Wren 2");
  assert.equal(workerNameFromTitle("Production chat"), undefined);
});

test("names never run out and never collide", () => {
  const all = [...WORKER_NAMES];
  assert.equal(nextWorkerName(all), `${WORKER_NAMES[0]} 2`);
  assert.equal(nextWorkerName([...all, `${WORKER_NAMES[0]} 2`]), `${WORKER_NAMES[1]} 2`);
});

test("concurrent bot launches reserve distinct names before sessions commit", () => {
  const committed = [worker({ id: "w1", workerName: "Wren", status: "running" })];
  let reservations: ReturnType<typeof reserveWorkerName>["reservations"] = [];

  const codex = reserveWorkerName(reservations, committed, { workerId: "w2", parentId: "boss" });
  reservations = codex.reservations;
  const claude = reserveWorkerName(reservations, committed, { workerId: "w3", parentId: "boss" });
  reservations = claude.reservations;
  const cursor = reserveWorkerName(reservations, committed, { workerId: "w4", parentId: "boss" });

  assert.deepEqual([codex.name, claude.name, cursor.name], ["Dexter", "Marlow", "Piper"]);
});

test("committed workers replace temporary name reservations", () => {
  const first = reserveWorkerName([], [worker()], { workerId: "w2", parentId: "boss" });
  assert.equal(first.name, "Dexter");

  const committed = [worker(), worker({ id: "w2", workerName: "Dexter", provider: "codex" })];
  const second = reserveWorkerName(first.reservations, committed, { workerId: "w3", parentId: "boss" });

  assert.equal(second.name, "Marlow");
  assert.deepEqual(second.reservations, [{ workerId: "w3", parentId: "boss", name: "Marlow" }]);
});

test("worker names remain local to one orchestrator crew", () => {
  const first = reserveWorkerName([], [], { workerId: "w1", parentId: "boss-a" });
  const otherCrew = reserveWorkerName(first.reservations, [], { workerId: "w2", parentId: "boss-b" });

  assert.equal(first.name, "Wren");
  assert.equal(otherCrew.name, "Wren");
});

test("the idle worker on the same bot takes the next slice", () => {
  const found = findReusableWorker(want, [worker()], scope);
  assert.equal(found?.id, "w1");
});

test("a busy worker gets a colleague instead", () => {
  // Fanning slices out at once is the point of the desk. Reuse must never
  // queue new work behind a worker that is mid-slice.
  assert.equal(findReusableWorker(want, [worker({ status: "running" })], scope), null);
  assert.equal(
    findReusableWorker(want, [worker({ agentRun: { status: "running" } })], scope),
    null,
  );
});

test("a different bot, model or effort is a different worker", () => {
  assert.equal(findReusableWorker(want, [worker({ provider: "codex" })], scope), null);
  assert.equal(findReusableWorker(want, [worker({ model: "grok-4.1" })], scope), null);
  assert.equal(findReusableWorker(want, [worker({ effort: "high" })], scope), null);
  // Two custom bots can share a model and still be different connections.
  assert.equal(
    findReusableWorker({ ...want, customBotId: "a" }, [worker({ customBotId: "b" })], scope),
    null,
  );
});

test("a worker is never borrowed from another chat or project", () => {
  // Reaching across would hand a worker context from a business it was
  // never shown.
  assert.equal(findReusableWorker(want, [worker({ parentId: "someone-else" })], scope), null);
  assert.equal(findReusableWorker(want, [worker({ projectId: "p2" })], scope), null);
});

test("archived and visible chats are not workers", () => {
  assert.equal(findReusableWorker(want, [worker({ archivedAt: 1 })], scope), null);
  // A person's own chat is not a worker to be handed slices.
  assert.equal(findReusableWorker(want, [worker({ hidden: false })], scope), null);
});

test("a name addresses that worker, or nobody", () => {
  const crew = [worker({ id: "w1", workerName: "Wren" }), worker({ id: "w2", workerName: "Dexter" })];
  assert.equal(findReusableWorker({ ...want, name: "Dexter" }, crew, scope)?.id, "w2");
  assert.equal(findReusableWorker({ ...want, name: "dexter " }, crew, scope)?.id, "w2");
  // Asking for a worker who is busy starts a new one rather than silently
  // handing the work to a stranger wearing the name.
  assert.equal(
    findReusableWorker({ ...want, name: "Dexter" }, [worker({ id: "w2", workerName: "Dexter", status: "running" })], scope),
    null,
  );
  assert.equal(findReusableWorker({ ...want, name: "Nobody" }, crew, scope), null);
});

test("the most recent worker on that bot is preferred", () => {
  // It knows the most about where this work got to.
  const crew = [worker({ id: "old" }), worker({ id: "recent", workerName: "Dexter" })];
  assert.equal(findReusableWorker(want, crew, scope)?.id, "recent");
});

test("a worker whose run ended badly is not handed new work", () => {
  // workerIsFree only asks "busy?", so a run that died still read as
  // available and inherit would carry that broken turn into the next slice.
  for (const status of ["failed", "cancelled", "timed-out", "budget-exceeded", "interrupted"] as const) {
    assert.equal(workerEndedWell({ agentRun: { status } }), false, status);
    assert.equal(
      findReusableWorker(want, [worker({ agentRun: { status } })], scope),
      null,
      `a ${status} worker must not take a new slice`,
    );
  }
  // Clean, or never ran at all, is fine.
  assert.equal(workerEndedWell({ agentRun: { status: "completed" } }), true);
  assert.equal(workerEndedWell({}), true);
  assert.equal(findReusableWorker(want, [worker({ agentRun: { status: "completed" } })], scope)?.id, "w1");
});

test("an unnamed pick stays inside the wave it is continuing", () => {
  // The Wren that took an IP review, a Godot audit and a design review was
  // idle, on the same bot, and from none of those waves.
  const stranger = worker({ id: "elsewhere" });
  assert.equal(findReusableWorker(want, [stranger], scope), null, "not in this wave");
  assert.equal(
    findReusableWorker(want, [worker()], { parentId: "boss", projectId: "p1" }),
    null,
    "no wave at all means start fresh",
  );
  assert.equal(
    findReusableWorker(want, [worker()], { ...scope, waveChildIds: [] }),
    null,
    "an empty wave picks nobody",
  );
});

test("naming a worker still reaches it, wave or no wave", () => {
  // A name is a durable address; the caller already decided.
  const named = { ...want, name: "Wren" };
  assert.equal(findReusableWorker(named, [worker()], { parentId: "boss", projectId: "p1" })?.id, "w1");
  assert.equal(findReusableWorker(named, [worker()], { ...scope, waveChildIds: [] })?.id, "w1");
});

test("free means not running, by either signal", () => {
  assert.equal(workerIsFree({ status: "idle" }), true);
  assert.equal(workerIsFree({ status: "running" }), false);
  assert.equal(workerIsFree({ status: "idle", agentRun: { status: "running" } }), false);
  assert.equal(workerIsFree({ status: "idle", agentRun: { status: "completed" } }), true);
});

test("a named worker missing a project folder is still that address, not Wren 2", () => {
  // Reproduced against main: Wren exists on this parent with projectId null
  // (legacy save). findReusableWorker required an exact project match, missed
  // Wren, and nextWorkerName then invented "Wren 2".
  const legacy = worker({ projectId: null });
  const found = findReusableWorker({ ...want, name: "Wren" }, [legacy], scope);
  assert.equal(found?.id, "w1");
  const named = resolveNamedWorker({ name: "Wren" }, [legacy], scope);
  assert.equal(named.ok, true);
  if (named.ok) assert.equal(named.worker?.id, "w1");
});

test("a named worker bound to another project is worker_bound_elsewhere, not Wren 2", () => {
  const elsewhere = worker({ projectId: "p2" });
  assert.equal(findReusableWorker({ ...want, name: "Wren" }, [elsewhere], scope), null);
  const named = resolveNamedWorker({ name: "Wren" }, [elsewhere], scope);
  assert.equal(named.ok, false);
  if (!named.ok) assert.equal(named.error, WORKER_BOUND_ELSEWHERE_ERROR);
  assert.notEqual(nextWorkerName(["Wren"]), "Wren", "the suffix path is what we refuse");
});

test("an explicit new name is kept; the desk does not swap it for Wren", () => {
  const named = resolveNamedWorker({ name: "Dexter" }, [], scope);
  assert.equal(named.ok, true);
  if (named.ok && !named.worker) assert.equal(named.createName, "Dexter");
});

test("spawn refuses a named worker bound elsewhere instead of suffixing the name", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /resolveNamedWorker/);
  assert.match(store, /namedResolution && !namedResolution\.ok/);
});

test("a reused worker’s new run starts a new budget window", () => {
  const store = readFileSync(path.join(ROOT, "src", "lib", "store.tsx"), "utf8");
  assert.match(store, /beginAssignmentBudget\(priorWorker\?\.agentRun/);
  assert.match(store, /executionOwner: "workhorse"/);
  assert.match(store, /beginAssignmentBudget\(item\.agentRun, \{\}\)/);
  assert.match(store, /tokenBudget: undefined/);
  assert.match(store, /usedTokens: undefined/);
  assert.match(store, /budgetBaseline: undefined/);
});
