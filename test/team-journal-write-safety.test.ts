import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { appendTeamEvents, type TeamFs } from "../electron/team-journal";
import { redactFolders, restoreFolders } from "../src/lib/team";
import type { LinkedFolder } from "../src/lib/types";

const folder = "synthetic-shared-folder";
const journal = "crew_fixture";
const device = "dev_fixture";
const target = path.join(folder, journal, "journal", `${device}.jsonl`);
const staging = `${target}.part`;
const event = (id: string) => ({ id, journal, device, at: 1, seat: "fixture", type: "chat.titled", chatId: "sess_fixture", title: id });
const original = `${JSON.stringify(event("tev_original"))}\n`;

/** In-memory filesystem: no shared folder, home directory, or live journal is read. */
function journalFs(options: { readCode?: string; readFailures?: number; renameCode?: string; exists?: boolean } = {}) {
  const files = new Map<string, string>(options.exists === false ? [] : [[target, original]]);
  let reads = 0;
  let writes = 0;
  const failure = (code: string) => Object.assign(new Error(`Synthetic ${code}`), { code });
  const fsx = {
    mkdirSync: () => undefined,
    readFileSync: (file: string) => {
      reads += 1;
      if (options.readCode && reads <= (options.readFailures ?? Infinity)) throw failure(options.readCode);
      if (!files.has(file)) throw failure("ENOENT");
      return files.get(file)!;
    },
    writeFileSync: (file: string, text: string) => { writes += 1; files.set(file, text); },
    renameSync: (from: string, to: string) => {
      if (options.renameCode) throw failure(options.renameCode);
      if (!files.has(from)) throw failure("ENOENT");
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    unlinkSync: (file: string) => { files.delete(file); },
    appendFileSync: () => { throw new Error("Unexpected append in the atomic writer."); },
    readdirSync: () => [],
    existsSync: (file: string) => files.has(file),
  } as unknown as TeamFs;
  return { fsx, files, reads: () => reads, writes: () => writes };
}

for (const code of ["EACCES", "EBUSY", "EPERM"]) {
  test(`an unreadable ${code} journal is never replaced by an empty history`, () => {
    const fixture = journalFs({ readCode: code });
    fixture.files.set(staging, "interrupted earlier staging data");
    assert.throws(() => appendTeamEvents(folder, journal, device, [event("tev_new")], fixture.fsx), { code });
    assert.equal(fixture.files.get(target), original);
    assert.equal(fixture.files.has(staging), false);
    assert.equal(fixture.writes(), 0, "failed reads must not reach the replacement write");
    assert.equal(fixture.reads(), code === "EACCES" ? 1 : 3);
  });
}

test("a transient busy read retries from the complete existing journal", () => {
  const fixture = journalFs({ readCode: "EBUSY", readFailures: 1 });
  assert.deepEqual(appendTeamEvents(folder, journal, device, [event("tev_new")], fixture.fsx), { written: 1, refused: 0 });
  assert.equal(fixture.reads(), 2);
  const stored = fixture.files.get(target)!;
  assert.ok(stored.startsWith(original));
  assert.deepEqual(stored.trim().split("\n").map(line => JSON.parse(line).id), ["tev_original", "tev_new"]);
  assert.equal(fixture.files.has(staging), false);
});

test("a missing journal may start empty, while failed replacement preserves its target", () => {
  const empty = journalFs({ exists: false });
  assert.equal(appendTeamEvents(folder, journal, device, [event("tev_first")], empty.fsx).written, 1);
  assert.equal(JSON.parse(empty.files.get(target)!).id, "tev_first");
  const blocked = journalFs({ renameCode: "EBUSY" });
  assert.throws(() => appendTeamEvents(folder, journal, device, [event("tev_new")], blocked.fsx), { code: "EBUSY" });
  assert.equal(blocked.files.get(target), original);
  assert.equal(blocked.files.has(staging), false);
});

test("differently-cased macOS-style roots stay private in shared message text", () => {
  const root = path.posix.join("/", "synthetic-fixtures", "Users", "Ana", "Atlas");
  const folders: LinkedFolder[] = [{ id: "fold_fixture", path: root, label: "atlas" }];
  const text = `Edited ${root.toUpperCase()}/src/main.ts`;
  assert.equal(redactFolders(text, folders), "Edited ‹folder:atlas›/src/main.ts");
});

test("folder restoration prefers exact labels and leaves ambiguous case matches unresolved", () => {
  const folders: LinkedFolder[] = [
    { id: "fold_lower", path: path.join("synthetic-folders", "lower"), label: "src" },
    { id: "fold_upper", path: path.join("synthetic-folders", "upper"), label: "SRC" },
    { id: "fold_atlas", path: path.join("synthetic-folders", "atlas"), label: "atlas" },
  ];
  assert.equal(restoreFolders("‹folder:SRC›", folders), folders[1]!.path);
  assert.equal(restoreFolders("‹folder:Src›", folders), "‹folder:Src›");
  assert.equal(restoreFolders("‹folder:ATLAS›", folders), folders[2]!.path);
});
