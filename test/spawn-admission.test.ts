import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_ROOT_WORKERS,
  SAME_SLICE_SPAWN_ERROR,
  maxRootWorkers,
  reserveSpawnAdmission,
  type SpawnAdmitSession,
  type SpawnReservation,
} from "../src/lib/subagents";

const limit = maxRootWorkers(1);

function running(id: string, extra: Partial<SpawnAdmitSession> = {}): SpawnAdmitSession {
  return {
    id,
    parentId: "orch",
    projectId: "proj",
    hidden: true,
    status: "running",
    title: `Wanda · ${id}`,
    workerName: "Wanda",
    agentRun: { status: "running" },
    ...extra,
  };
}

function candidate(id: string, slice: string, extra: Partial<SpawnReservation> = {}): SpawnReservation & { limit: number } {
  return {
    childId: id,
    parentId: "orch",
    projectId: "proj",
    slice,
    nested: false,
    limit,
    ...extra,
  };
}

test("two different slices under the cap both succeed, in either order", () => {
  assert.equal(limit, MIN_ROOT_WORKERS);
  const first = reserveSpawnAdmission([], [], candidate("a", "alpha"));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = reserveSpawnAdmission(first.reservations, [], candidate("b", "beta"));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    second.reservations.map((row) => row.childId),
    ["a", "b"],
  );
  const wave = ["a", "b", "c", "d"].reduce<{ ok: boolean; reservations: readonly SpawnReservation[] }>(
    (state, id, index) => {
      const next = reserveSpawnAdmission(state.reservations, [], candidate(id, `slice-${index}`));
      assert.equal(next.ok, true, `slice ${index} fits under ${limit}`);
      return next.ok ? next : state;
    },
    { ok: true, reservations: [] },
  );
  assert.equal(wave.reservations.length, MIN_ROOT_WORKERS);
});

test("a fifth worker, or a second admit of the same slice, is refused", () => {
  const four = [0, 1, 2, 3].map((index) => running(`run-${index}`, { title: `Wanda · slice-${index}`, workerName: "Wanda" }));
  const fifth = reserveSpawnAdmission([], four, candidate("e", "slice-new"));
  assert.equal(fifth.ok, false);
  if (fifth.ok) return;
  assert.match(fifth.error, new RegExp(`${MIN_ROOT_WORKERS} workers`));

  const reserved = [0, 1, 2, 3].reduce<SpawnReservation[]>((rows, index) => {
    const next = reserveSpawnAdmission(rows, [], candidate(`pend-${index}`, `pend-${index}`));
    assert.equal(next.ok, true);
    return next.ok ? [...next.reservations] : rows;
  }, []);
  const pastReservations = reserveSpawnAdmission(reserved, [], candidate("e", "another"));
  assert.equal(pastReservations.ok, false);

  const held = reserveSpawnAdmission([], [], candidate("a", "Fix the tier row"));
  assert.equal(held.ok, true);
  if (!held.ok) return;
  const duplicate = reserveSpawnAdmission(held.reservations, [], candidate("b", "fix the tier row"));
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.equal(duplicate.error, SAME_SLICE_SPAWN_ERROR);

  const visible = reserveSpawnAdmission(
    [],
    [running("w3", { title: "Wanda · Fix the tier row", workerName: "Wanda" })],
    candidate("b", "Fix the tier row"),
  );
  assert.equal(visible.ok, false);

  const otherProject = reserveSpawnAdmission(
    held.reservations,
    [],
    candidate("c", "Fix the tier row", { projectId: "other" }),
  );
  assert.equal(otherProject.ok, true, "the same label on another project is not this slice");
});

test("a reservation already running in the session list counts once", () => {
  const session = running("a", { title: "Wanda · alpha", workerName: "Wanda" });
  const reserved: SpawnReservation[] = [
    { childId: "a", parentId: "orch", projectId: "proj", slice: "alpha", nested: false },
  ];
  const room = [1, 2].map((index) => running(`run-${index}`));
  const next = reserveSpawnAdmission(reserved, [session, ...room], candidate("b", "beta"));
  assert.equal(next.ok, true, "three running workers leave room for a fourth");
  const full = reserveSpawnAdmission(reserved, [session, ...room, running("run-3")], candidate("c", "gamma"));
  assert.equal(full.ok, false);
});
