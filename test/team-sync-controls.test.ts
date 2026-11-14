import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crewEnabled, DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings";
import { leaveTeam, TEAM_SYNC_MS, teamSyncStillCurrent } from "../src/lib/team-desk";
import type { Project } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project: Project = {
  id: "project_fixture", name: "Fixture", createdAt: 1, openedAt: 1,
  folders: [], references: [],
  team: { journalId: "journal_fixture", folder: path.join(ROOT, "synthetic-journal"), joinedAt: 1 },
};
const active = { settings: { ...DEFAULT_SETTINGS, crew: { enabled: true } }, projects: [project] };

test("the saved Crew choice overrides the main-process staff default across restart", () => {
  assert.equal(crewEnabled(DEFAULT_SETTINGS), false);
  assert.equal(crewEnabled(DEFAULT_SETTINGS, true), true);
  const disabled = normalizeSettings({ ...DEFAULT_SETTINGS, crew: { enabled: false } });
  assert.equal(crewEnabled(disabled, true), false);
  const enabled = normalizeSettings({ ...DEFAULT_SETTINGS, crew: { enabled: true } });
  assert.equal(crewEnabled(enabled), true);
  assert.deepEqual(normalizeSettings({ ...DEFAULT_SETTINGS, crew: { enabled: "yes" } }).crew, undefined);
});

test("an in-flight journal read cannot publish or land after pause, disable, leave, or folder change", async () => {
  const link = project.team!;
  assert.equal(teamSyncStillCurrent(active, project.id, link), true);
  const variants = [
    { ...active, projects: [{ ...project, team: { ...link, off: true } }] },
    { ...active, settings: { ...active.settings, crew: { enabled: false } } },
    { ...active, projects: [{ ...project, team: undefined }] },
    { ...active, projects: [{ ...project, team: { ...link, folder: path.join(ROOT, "another-journal") } }] },
    { ...active, projects: [{ ...project, team: { ...link, journalId: "journal_other" } }] },
  ];
  for (const current of variants) {
    // The read was dispatched while enabled; the user's newer choice lands
    // before it resolves. Both the publish and state-landing checks use this.
    const beforeRead = Promise.resolve(link);
    const expected = await beforeRead;
    assert.equal(teamSyncStillCurrent(current, project.id, expected, true), false);
  }
  assert.equal(teamSyncStillCurrent({ ...active, projects: [{ ...project, team: { ...link, baseline: {} } }] }, project.id, link), true);
});

test("team polling does not restart itself after every snapshot paint", () => {
  // React's dependency list is the boundary: capturing `snapshots` here makes
  // setSnapshots change syncAll and rerun its immediate effect indefinitely.
  const source = readFileSync(path.join(ROOT, "src", "lib", "team-desk.ts"), "utf8");
  const sync = source.slice(source.indexOf("const syncProject = useCallback("), source.indexOf("const syncAll = useCallback("));
  assert.match(sync, /\[local, setState, stateRef\]/);
  assert.doesNotMatch(sync, /\[[^\]]*\bsnapshots\b[^\]]*\]/);
  assert.equal(TEAM_SYNC_MS, 4_000);
});

test("Leave unlinks locally even when the shared journal refuses or cannot be written", async () => {
  for (const outcome of ["written", "refused", "unavailable"]) {
    let link = project.team;
    let clears = 0;
    const result = await leaveTeam(async () => {
      if (outcome === "unavailable") throw Object.assign(new Error("Synthetic read-only shared folder"), { code: "EACCES" });
      return outcome === "written";
    }, () => { link = undefined; clears += 1; });
    assert.equal(link, undefined);
    assert.equal(clears, 1);
    assert.equal(result.ok, true);
    assert.equal(result.message.includes("could not be written"), outcome !== "written");
  }
});
