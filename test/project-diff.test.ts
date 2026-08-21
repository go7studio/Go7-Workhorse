import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applyLineDiff, countLineChanges, countLineDelta, countLines, lineDiff, splitLines } from "../src/lib/file-diff";
import { countCreatedReview, growInstanceBaseline, instancePathKey, rememberInstance, reviewCreatedDiff } from "../src/lib/file-instances";
import { countMotion } from "../src/lib/count";
import { editListKey, markStatsFetched, planEditStatsHarvest, projectWritesKey, startEditStatsHarvest, takeEditStatsChunk } from "../src/lib/project-edits";
import { countFileLines, dottedConfigAlt, findSourceFile, readEditStats, readFileDiff, readSourceText, recordFileInstance, resolveExistingFile, resolveStatFile } from "../electron/project-diff";
import type { Session } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "workhorse@test"]);
  git(repo, ["config", "user.name", "Workhorse"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

function commitFile(repo: string, rel: string, text: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  git(repo, ["add", "--", rel]);
  git(repo, ["commit", "-m", `add ${rel}`]);
}

function reconstructs(before: string, after: string, lines: { kind: string; text: string }[]): void {
  assert.deepEqual(splitLines(applyLineDiff(lines as never)), splitLines(after));
  const deleted = lines.filter((line) => line.kind === "del").map((line) => line.text);
  const fromBefore = splitLines(before);
  for (const text of deleted) assert.ok(fromBefore.includes(text), `deleted ${text} was in before`);
}

test("project diffs use the linked-root file, not a whole-file or sibling steal", () => {
  const treeA = makeRepo("wh-diff-a-");
  const treeB = makeRepo("wh-diff-b-");
  commitFile(treeA, "src/foo.ts", "keep\nold\n");
  writeFileSync(path.join(treeA, "src", "foo.ts"), "keep\nnew\n");
  commitFile(treeB, "src/foo.ts", "WRONG TREE\n".repeat(40));
  writeFileSync(path.join(treeB, "foo.ts"), "cwd-root steal\n".repeat(20));

  const previous = process.cwd();
  try {
    process.chdir(treeB);
    const resolved = findSourceFile("src/foo.ts", [treeA]);
    assert.equal(path.normalize(resolved ?? ""), path.normalize(path.join(treeA, "src", "foo.ts")));
    const byBase = findSourceFile("foo.ts", [treeA]);
    assert.equal(path.normalize(byBase ?? ""), path.normalize(path.join(treeA, "src", "foo.ts")));
    const diff = readFileDiff("src/foo.ts", [treeA]);
    assert.equal(diff.added, 1);
    assert.equal(diff.deleted, 1);
    assert.equal(diff.lines.some((line) => line.kind === "same" && line.text === "keep"), true);
    assert.equal(diff.lines.some((line) => line.kind === "del" && line.text === "old"), true);
    assert.equal(diff.lines.some((line) => line.kind === "add" && line.text === "new"), true);
    assert.doesNotMatch(diff.after, /WRONG TREE/);
    assert.doesNotMatch(diff.after, /cwd-root steal/);
    reconstructs(diff.before, diff.after, diff.lines);
    const stats = readEditStats(["src/foo.ts", "foo.ts"], [treeA]);
    assert.deepEqual(stats["src/foo.ts"], { added: 1, deleted: 1 });
    assert.deepEqual(stats["foo.ts"], { added: 1, deleted: 1 });
  } finally {
    process.chdir(previous);
    rmSync(treeA, { recursive: true, force: true });
    rmSync(treeB, { recursive: true, force: true });
  }
});

test("an unbound chat never reads a same-named file from the app cwd", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "wh-diff-unbound-"));
  writeFileSync(path.join(temp, "secret.txt"), "must not leak\n");
  const previous = process.cwd();
  try {
    process.chdir(temp);
    assert.equal(findSourceFile("secret.txt", []), null);
    assert.deepEqual(readFileDiff("secret.txt", []), {
      path: "secret.txt",
      name: "secret.txt",
      before: "",
      after: "",
      added: 0,
      deleted: 0,
      lines: [],
    });
  } finally {
    process.chdir(previous);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("new file is all adds of the real after; delete is all deletes of the real before", () => {
  const repo = makeRepo("wh-diff-newdel-");
  commitFile(repo, "kept.md", "stay\n");
  writeFileSync(path.join(repo, "fresh.md"), "brand new\nline\n");
  const created = readFileDiff("fresh.md", [repo]);
  assert.equal(created.deleted, 0);
  assert.equal(created.added, 2);
  assert.equal(created.before, "");
  assert.equal(created.lines.every((line) => line.kind === "add"), true);
  assert.deepEqual(
    created.lines.map((line) => line.text),
    ["brand new", "line"],
  );
  reconstructs(created.before, created.after, created.lines);

  commitFile(repo, "gone.md", "was here\nstill\n");
  rmSync(path.join(repo, "gone.md"));
  const removed = readFileDiff("gone.md", [repo]);
  assert.equal(removed.after, "");
  assert.equal(removed.added, 0);
  assert.equal(removed.deleted, 2);
  assert.equal(removed.lines.every((line) => line.kind === "del"), true);
  assert.deepEqual(
    removed.lines.map((line) => line.text),
    ["was here", "still"],
  );
  reconstructs(removed.before, removed.after, removed.lines);
  rmSync(repo, { recursive: true, force: true });
});

test("Project Home lists +/- stats and FileViewer colors add/del lines", () => {
  const home = readFileSync(path.join(ROOT, "src", "ui", "ProjectHome.tsx"), "utf8");
  assert.match(home, /projectFileChanges/);
  assert.match(home, /editsIdle/);
  assert.match(home, /requestAnimationFrame/);
  assert.match(home, /label="Changes"/);
  assert.match(home, /FileViewer/);
  assert.match(home, /editStats/);
  assert.match(home, /holdEditStats/);
  assert.match(home, /startEditStatsHarvest/);
  assert.match(home, /projectWritesKey/);
  assert.match(home, /\[editKey, rootKey, project\?\.id\]/);
  assert.doesNotMatch(home, /showLineStats=\{false\}/);
  assert.doesNotMatch(home, /FileReview/);
  const viewer = readFileSync(path.join(ROOT, "src", "ui", "FileViewer.tsx"), "utf8");
  assert.match(viewer, /fileDiff/);
  assert.match(viewer, /diff-line/);
  assert.match(viewer, /sameEditPath/);
  assert.match(viewer, /pathChanged/);
  assert.match(viewer, /file-close-x/);
  assert.match(viewer, /viewOnly/);
  assert.match(viewer, /showDiffStat/);
  assert.match(viewer, /diff\.added > 0 \|\| diff\.deleted > 0/);
  assert.match(viewer, /editSearchRoots/);
  assert.match(viewer, /Folder\./);
  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  assert.match(pane, /editListKey\(edits\)/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "project-edits.ts"), "utf8"), /item\.edits/);
  assert.match(readFileSync(path.join(ROOT, "src", "lib", "project-edits.ts"), "utf8"), /item\.at/);
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /readSourceText/);
  assert.match(main, /findSourceFile/);
  assert.match(main, /created === true/);
  assert.match(main, /recordFileInstance/);
  assert.match(main, /fileInstances/);
  assert.match(viewer, /file\.edits/);
  assert.match(viewer, /file\.at/);
});

test("home edit stats count a large created batch once and do not grow instances", () => {
  const root = path.join("C:", "game");
  const paths = Array.from({ length: 14 }, (_, index) => path.join(root, `file-${index}.gd`));
  const body = `${Array.from({ length: 1678 }, (_, index) => `line ${index}`).join("\n")}\n`;
  const files = new Map(paths.map((item) => [item, body]));
  const instances = new Map<string, string>();
  let reads = 0;
  const input = {
    instances,
    existsSync: (item: string) => files.has(item),
    readFile: (item: string) => {
      reads += 1;
      return files.get(item) ?? "";
    },
    isDir: () => false,
    gitShow: () => null,
  };
  const first = readEditStats(paths, [root], input, paths);
  assert.equal(first[paths[0]!]?.added, 1678);
  assert.equal(first[paths[0]!]?.deleted, 0);
  assert.equal(first[paths[13]!]?.added, 1678);
  assert.equal(instances.size, 0);
  assert.equal(reads, 14);
  const painted = rememberInstance(instances, paths[0]!, body);
  assert.equal(instancePathKey(paths[0]!), instancePathKey(path.join("C:", "game", "file-0.gd")));
  const afterRemember = readEditStats([paths[0]!], [root], input, [paths[0]!]);
  assert.deepEqual(afterRemember[paths[0]!], { added: 1678, deleted: 0 });
  assert.equal(instances.get(instancePathKey(paths[0]!)), painted);
  assert.deepEqual(countCreatedReview(body, body), { added: 1678, deleted: 0 });
  files.set(paths[0]!, `${body}extra\n`);
  const later = readEditStats([paths[0]!], [root], input, [paths[0]!]);
  assert.deepEqual(later[paths[0]!], { added: 1679, deleted: 0 });
  assert.equal(instances.get(instancePathKey(paths[0]!)), painted);
});

test("Project Home list stats stay cheap after they are known", () => {
  const root = path.join("C:", "game");
  const gitDir = path.join(root, ".git");
  const paths = Array.from({ length: 14 }, (_, index) => path.join(root, `file-${index}.gd`));
  const after = `${Array.from({ length: 1678 }, (_, index) => `line ${index}`).join("\n")}\n`;
  const before = `${Array.from({ length: 1600 }, (_, index) => `old ${index}`).join("\n")}\n`;
  const files = new Map(paths.map((item) => [item, after]));
  let gitShows = 0;
  let reads = 0;
  let numstats = 0;
  let walks = 0;
  const created = paths.slice(0, 10);
  const edited = paths.slice(10);
  const input = {
    existsSync: (item: string) => item === gitDir || item === root || files.has(item),
    isDir: (item: string) => item === root || item === gitDir,
    readdir: () => {
      walks += 1;
      return [];
    },
    readFile: (item: string) => {
      reads += 1;
      return files.get(item) ?? "";
    },
    gitShow: () => {
      gitShows += 1;
      return before;
    },
    gitNumstat: () => {
      numstats += 1;
      return Object.fromEntries(edited.map((item) => [item, { added: 12, deleted: 2 }]));
    },
  };

  const first = readEditStats(paths, [root], input, created);
  assert.equal(first[paths[0]!]?.added, 1678);
  assert.equal(first[paths[0]!]?.deleted, 0);
  assert.deepEqual(first[paths[10]!], { added: 12, deleted: 2 });
  assert.equal(gitShows, 0);
  assert.equal(walks, 0);
  assert.equal(numstats, 1);
  assert.equal(reads, created.length);

  const listed = paths.map((item, index) => ({
    path: item,
    edits: 1,
    at: 1_000 + index,
    kind: index < 10 ? ("created" as const) : ("edited" as const),
  }));
  let fetched = markStatsFetched({}, listed, root);
  let harvests = 0;
  const tick = () => {
    const plan = planEditStatsHarvest(
      listed.map((item) => ({ ...item })),
      fetched,
      root,
    );
    if (!plan) return;
    harvests += 1;
    readEditStats(
      plan.stale.map((item) => item.path),
      [root],
      input,
      plan.created,
    );
    fetched = markStatsFetched(fetched, plan.stale, root);
  };
  for (let index = 0; index < 20; index += 1) tick();
  assert.equal(harvests, 0);
  assert.equal(gitShows, 0);
  assert.equal(editListKey(listed), editListKey(listed.map((item) => ({ ...item }))));
  const idle: Session = {
    id: "s1",
    projectId: "p1",
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
    title: "Game",
    mode: "ask",
    sandbox: "off",
    status: "idle",
    contextUsed: 0,
    messages: [
      { id: "t1", role: "system", kind: "tool", text: "Write · completed — file-0.gd", createdAt: 10 },
    ],
  };
  // Same writes, mid-run and deeper into the window: the key must not move.
  const running: Session = { ...idle, status: "running", contextUsed: 99 };
  assert.equal(projectWritesKey([idle], "p1"), projectWritesKey([running], "p1"));

  assert.equal(countLines(after), 1678);
  assert.deepEqual(countLineDelta("", after), { added: 1678, deleted: 0 });
  assert.deepEqual(countLineDelta("keep\nold\n", "keep\nnew\n"), countLineChanges(lineDiff("keep\nold\n", "keep\nnew\n")));
  assert.equal(countMotion(0, 1678), "snap");
  assert.equal(countMotion(0, 40), "ease");
  assert.equal(countMotion(12, 12), "same");

  const statsSrc = readFileSync(path.join(ROOT, "electron", "project-diff.ts"), "utf8");
  const statsFn = statsSrc.slice(statsSrc.indexOf("export function readEditStats"), statsSrc.indexOf("export function readSourceText"));
  assert.doesNotMatch(statsFn, /\blineDiff\b/);
  assert.doesNotMatch(statsFn, /\bbuildFileDiff\b/);
  assert.doesNotMatch(statsFn, /\breadFileDiff\b/);
  assert.doesNotMatch(statsFn, /gitShow/);
  const home = readFileSync(path.join(ROOT, "src", "ui", "ProjectHome.tsx"), "utf8");
  assert.match(home, /startEditStatsHarvest/);
  assert.match(home, /projectWritesKey/);
  const diffStat = readFileSync(path.join(ROOT, "src", "ui", "DiffStat.tsx"), "utf8");
  assert.match(diffStat, /countMotion/);
  assert.doesNotMatch(diffStat, /requestAnimationFrame\(tick\).*countMotion/);
  const css = readFileSync(path.join(ROOT, "src", "styles", "app.css"), "utf8");
  assert.match(css, /\.project-overview \.edited-block\.compact,\s*\.project-overview \.edited-block\.compact\.fill\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.project-overview \.edited-block\.compact \.file-list/);
});

test("first harvest does not do N sync full-file reads on the first call", async () => {
  const root = path.join("C:", "game");
  const paths = Array.from({ length: 14 }, (_, index) => path.join(root, `ship-${index}.gd`));
  const body = `${Array.from({ length: 1678 }, (_, index) => `line ${index}`).join("\n")}\n`;
  const files = new Map(paths.map((item) => [item, body]));
  let reads = 0;
  let counts = 0;
  const listed = paths.map((item, index) => ({
    path: item,
    edits: 1,
    at: 1_000 + index,
    kind: "created" as const,
  }));
  const firstChunk = takeEditStatsChunk(listed, {}, root);
  assert.ok(firstChunk);
  assert.equal(firstChunk.stale.length, 1);
  assert.equal(firstChunk.created.length, 1);
  assert.notEqual(firstChunk.stale.length, paths.length);

  const input = {
    existsSync: (item: string) => item === root || files.has(item),
    isDir: (item: string) => item === root,
    readdir: () => [] as string[],
    readFile: (item: string) => {
      reads += 1;
      return files.get(item) ?? "";
    },
    countLinesAt: (item: string) => {
      counts += 1;
      return countLines(files.get(item) ?? "");
    },
    gitShow: () => null,
  };
  const first = readEditStats(
    firstChunk.stale.map((item) => item.path),
    [root],
    input,
    firstChunk.created,
  );
  assert.equal(first[paths[0]!]?.added, 1678);
  assert.ok(reads <= 1);
  assert.ok(counts <= 1);
  assert.ok(reads + counts <= 1);

  reads = 0;
  counts = 0;
  const queued: Array<() => void> = [];
  let fetched: Record<string, string> = {};
  const cancel = startEditStatsHarvest({
    items: listed,
    getFetched: () => fetched,
    rootKey: root,
    roots: [root],
    editStats: async (stale, folders, created) =>
      readEditStats(
        stale,
        folders,
        {
          ...input,
          readFile: (item: string) => {
            reads += 1;
            return files.get(item) ?? "";
          },
          countLinesAt: (item: string) => {
            counts += 1;
            return countLines(files.get(item) ?? "");
          },
        },
        created,
      ),
    onChunk: (_next, stale) => {
      fetched = markStatsFetched(fetched, stale, root);
    },
    schedule: (work) => {
      queued.push(work);
      return () => {};
    },
  });
  assert.equal(reads, 0);
  assert.equal(counts, 0);
  assert.equal(queued.length, 1);
  queued.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(reads < paths.length);
  assert.ok(counts < paths.length);
  assert.ok(reads <= 1);
  assert.equal(takeEditStatsChunk(listed, fetched, root)?.stale.length, 1);
  cancel();

  const batchedReads = { n: 0 };
  const all = readEditStats(
    paths,
    [root],
    {
      existsSync: (item: string) => files.has(item),
      isDir: () => false,
      readFile: () => {
        batchedReads.n += 1;
        return body;
      },
      countLinesAt: () => 1678,
    },
    paths,
  );
  assert.equal(all[paths[13]!]?.added, 1678);
  assert.equal(batchedReads.n, 0);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "wh-count-lines-"));
  const sample = path.join(tmp, "ship.gd");
  writeFileSync(sample, body);
  assert.equal(countFileLines(sample), 1678);
  assert.equal(countFileLines(path.join(tmp, "missing.gd")), 0);
  rmSync(tmp, { recursive: true, force: true });

  const home = readFileSync(path.join(ROOT, "src", "ui", "ProjectHome.tsx"), "utf8");
  assert.match(home, /startEditStatsHarvest/);
  assert.doesNotMatch(home, /await window\.workhorse\.editStats/);
  assert.match(home, /<EditedList[\s\S]*stats=\{stats\}/);
});

test("edit stats never walk the tree to score a 23-file list", () => {
  const root = path.join("C:", "godot-game");
  const gitDir = path.join(root, ".git");
  const deep = path.join(root, "scripts", "ai", "minimax.gd");
  const listed = Array.from({ length: 23 }, (_, index) => path.join(root, "scripts", `piece-${index}.gd`));
  listed[0] = deep;
  const files = new Map(listed.map((item, index) => [item, `line ${index}\n`]));
  const scriptsDir = path.join(root, "scripts");
  const aiDir = path.dirname(deep);
  let walks = 0;
  const input = {
    existsSync: (item: string) =>
      item === root || item === gitDir || item === scriptsDir || item === aiDir || files.has(item),
    isDir: (item: string) => item === root || item === gitDir || item === scriptsDir || item === aiDir,
    readdir: (dir: string) => {
      walks += 1;
      if (dir === root) return ["scripts", "decoy-0"];
      if (dir === scriptsDir) return ["ai", "piece-1.gd"];
      if (dir === aiDir) return ["minimax.gd"];
      return ["decoy-1", "decoy-2"];
    },
    gitNumstat: (_repo: string, rels: string[]) =>
      Object.fromEntries(rels.map((rel) => [rel, { added: 3, deleted: 1 }])),
  };

  const joined = resolveStatFile("scripts/ai/minimax.gd", [root], input.existsSync, input);
  assert.equal(path.normalize(joined), path.normalize(deep));
  assert.equal(walks, 0);

  const stats = readEditStats(listed, [root], input, []);
  assert.equal(walks, 0);
  assert.deepEqual(stats[deep], { added: 3, deleted: 1 });
  assert.deepEqual(stats[listed[22]!], { added: 3, deleted: 1 });

  const viewer = findSourceFile("minimax.gd", [root], input);
  assert.ok(walks > 0);
  assert.equal(path.normalize(viewer ?? ""), path.normalize(deep));

  const pane = readFileSync(path.join(ROOT, "src", "ui", "SessionPane.tsx"), "utf8");
  const editsMemo = pane.slice(pane.indexOf("const edits = useMemo"), pane.indexOf("const hiddenPaths"));
  assert.match(editsMemo, /projectEdits\(\[session\]/);
  assert.doesNotMatch(editsMemo, /store\.sessions/);
  const host = readFileSync(path.join(ROOT, "electron", "project-diff.ts"), "utf8");
  const score = host.slice(host.indexOf("function addEditStatPath"), host.indexOf("function applyNumstat"));
  assert.match(score, /resolveStatFile/);
  assert.doesNotMatch(score, /resolveExistingFile|findSourceFile/);
});

test("non-git existing file is not a fake whole-file add; created is all adds", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-nongit-diff-"));
  writeFileSync(path.join(dir, "generic.inc"), "keep\nthis file\n");
  const existing = readFileDiff("generic.inc", [dir]);
  assert.equal(existing.added, 0);
  assert.equal(existing.deleted, 0);
  assert.equal(existing.lines.every((line) => line.kind === "same"), true);

  const created = readFileDiff("generic.inc", [dir], { created: true });
  assert.equal(created.added, 2);
  assert.equal(created.deleted, 0);
  assert.equal(created.lines.every((line) => line.kind === "add"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("source read is the file on disk, not a git whole-file add", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-src-read-"));
  writeFileSync(path.join(dir, "generic.inc"), "keep\nthis file\n");
  const got = readSourceText("generic.inc", [dir]);
  assert.equal(got.missing, false);
  assert.equal(got.unreadable, false);
  assert.equal(got.text, "keep\nthis file\n");
  assert.equal(got.name, "generic.inc");

  const missing = readSourceText("gone.inc", [dir]);
  assert.equal(missing.missing, true);
  assert.equal(missing.text, "");

  writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0]));
  const binary = readSourceText("blob.bin", [dir]);
  assert.equal(binary.unreadable, true);
  assert.equal(binary.text, "");

  const huge = readSourceText("generic.inc", [dir], {
    existsSync: () => true,
    isDir: () => false,
    readFile: () => "x".repeat(1_500_001),
  });
  assert.equal(huge.unreadable, true);
  rmSync(dir, { recursive: true, force: true });
});

test("created file keeps deleted green lines as red instances", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wh-instance-"));
  const abs = path.join(dir, "hundred-lines.md");
  const lines = Array.from({ length: 100 }, (_, index) => `Line ${index + 1}`);
  writeFileSync(abs, `${lines.join("\n")}\n`);
  const instances = new Map<string, string>();
  const created = readFileDiff(abs, [dir], { created: true, instances });
  assert.equal(created.added, 100);
  assert.equal(created.deleted, 0);
  assert.equal(created.lines.every((line) => line.kind === "add"), true);

  const kept = lines.filter((_, index) => index !== 49 && index !== 50);
  writeFileSync(abs, `${kept.join("\n")}\n`);
  const afterDelete = readFileDiff(abs, [dir], { created: true, instances });
  assert.equal(afterDelete.added, 98);
  assert.equal(afterDelete.deleted, 2);
  assert.equal(
    afterDelete.lines.some((line) => line.kind === "del" && line.text === "Line 50"),
    true,
  );
  assert.equal(
    afterDelete.lines.some((line) => line.kind === "del" && line.text === "Line 51"),
    true,
  );
  assert.equal(afterDelete.lines.filter((line) => line.kind === "add").length, 98);

  writeFileSync(abs, `${[...kept, "Line 101"].join("\n")}\n`);
  const afterAdd = readFileDiff(abs, [dir], { created: true, instances });
  assert.equal(afterAdd.added, 99);
  assert.equal(afterAdd.deleted, 2);
  assert.equal(
    afterAdd.lines.some((line) => line.kind === "add" && line.text === "Line 101"),
    true,
  );
  const stats = readEditStats([abs], [dir], { instances }, [abs]);
  assert.deepEqual(stats[abs], { added: 99, deleted: 2 });
  rmSync(dir, { recursive: true, force: true });
});

test("untracked file uses the write snapshot, not empty-before, after a later delete", () => {
  const repo = makeRepo("wh-instance-git-");
  const abs = path.join(repo, "hundred-lines.md");
  writeFileSync(abs, "a\nb\nc\n");
  const instances = new Map<string, string>();
  recordFileInstance(abs, [repo], { instances });
  writeFileSync(abs, "a\nc\n");
  const diff = readFileDiff(abs, [repo], { instances });
  assert.equal(diff.added, 2);
  assert.equal(diff.deleted, 1);
  assert.equal(diff.lines.some((line) => line.kind === "del" && line.text === "b"), true);
  assert.equal(diff.lines.filter((line) => line.kind === "add").map((line) => line.text).join("\n"), "a\nc");
  rmSync(repo, { recursive: true, force: true });
});

test("instance store is injected and does not read the home directory", () => {
  const root = path.join("C:", "proj");
  const abs = path.join(root, "hundred-lines.md");
  const files = new Map<string, string>([[abs, "one\ntwo\nthree\n"]]);
  const instances = new Map<string, string>();
  const input = {
    created: true as const,
    instances,
    existsSync: (item: string) => files.has(item),
    readFile: (item: string) => files.get(item) ?? "",
    isDir: () => false,
    gitShow: () => null,
  };
  const first = readFileDiff(abs, [root], input);
  assert.equal(first.added, 3);
  assert.equal(first.deleted, 0);
  files.set(abs, "one\nthree\n");
  const second = readFileDiff(abs, [root], input);
  assert.equal(second.added, 2);
  assert.equal(second.deleted, 1);
  assert.equal(second.lines.some((line) => line.kind === "del" && line.text === "two"), true);
  rememberInstance(instances, abs, "one\nthree\nfour\n");
  assert.equal(growInstanceBaseline("one\ntwo\nthree\n", "one\nthree\n").includes("two"), true);
  const painted = reviewCreatedDiff(abs, "one\ntwo\nthree\n", "one\nthree\n");
  assert.equal(painted.added, 2);
  assert.equal(painted.deleted, 1);
});

test("findSourceFile walks .walk and skips .git; created stats do not walk", () => {
  const root = path.join(os.tmpdir(), "wh-walk-dot-dirs");
  const walkDir = path.join(root, ".walk");
  const gitDir = path.join(root, ".git");
  const githubDir = path.join(root, ".github");
  const walkFile = path.join(walkDir, "audit.mjs");
  const gitDecoy = path.join(gitDir, "audit.mjs");
  const dirs = new Set([root, walkDir, gitDir, githubDir].map((item) => path.normalize(item)));
  const files = new Map<string, string>([
    [path.normalize(walkFile), "export const n = 1;\nexport const m = 2;\n"],
    [path.normalize(gitDecoy), "stolen from git\n"],
  ]);
  let walks = 0;
  const input = {
    existsSync: (item: string) => dirs.has(path.normalize(item)) || files.has(path.normalize(item)),
    isDir: (item: string) => dirs.has(path.normalize(item)),
    readdir: (dir: string) => {
      walks += 1;
      const norm = path.normalize(dir);
      if (norm === path.normalize(root)) return [".git", ".github", ".walk", "src"];
      if (norm === path.normalize(walkDir)) return ["audit.mjs"];
      if (norm === path.normalize(gitDir)) return ["audit.mjs", "objects"];
      if (norm === path.normalize(githubDir)) return ["workflows"];
      return [];
    },
    readFile: (item: string) => files.get(path.normalize(item)) ?? "",
    gitShow: () => null,
  };
  const found = findSourceFile("audit.mjs", [root], input);
  assert.equal(path.normalize(found ?? ""), path.normalize(walkFile));
  assert.ok(walks > 0);

  const gitOnlyRoot = path.join(os.tmpdir(), "wh-walk-git-only");
  const gitOnlyDir = path.join(gitOnlyRoot, ".git");
  const gitOnlyFile = path.join(gitOnlyDir, "audit.mjs");
  const gitOnlyDirs = new Set([gitOnlyRoot, gitOnlyDir].map((item) => path.normalize(item)));
  const gitOnly = findSourceFile("audit.mjs", [gitOnlyRoot], {
    existsSync: (item: string) => gitOnlyDirs.has(path.normalize(item)) || path.normalize(item) === path.normalize(gitOnlyFile),
    isDir: (item: string) => gitOnlyDirs.has(path.normalize(item)),
    readdir: (dir: string) => {
      const norm = path.normalize(dir);
      if (norm === path.normalize(gitOnlyRoot)) return [".git"];
      if (norm === path.normalize(gitOnlyDir)) return ["audit.mjs"];
      return [];
    },
  });
  assert.equal(gitOnly, null);

  walks = 0;
  const bare = readEditStats(["audit.mjs"], [root], input, ["audit.mjs"]);
  assert.equal(walks, 0);
  assert.equal(bare["audit.mjs"]?.added ?? 0, 0);
  const cited = readEditStats([".walk/audit.mjs"], [root], input, [".walk/audit.mjs"]);
  assert.equal(walks, 0);
  assert.ok(cited[".walk/audit.mjs"].added > 0);
  assert.equal(cited[".walk/audit.mjs"].deleted, 0);
});

test("absolute cite outside the project is not joined onto the project folder", () => {
  const project = path.join("C:", "Users", "someone", "Projects", "talk-in-talk-in");
  const real = path.join("C:", "Users", "someone", "openclaw", "openclaw.json");
  const decoy = path.join(project, "openclaw.json");
  const files = new Set([real]);
  const dirs = new Set([project, path.dirname(real), path.dirname(project)]);
  const input = {
    existsSync: (item: string) => files.has(item) || dirs.has(item),
    isDir: (item: string) => dirs.has(item),
    readdir: () => [] as string[],
    readFile: (item: string) => (item === real ? '{"gateway":true}\n' : ""),
  };
  assert.equal(findSourceFile(real, [project], input), real);
  assert.equal(findSourceFile("openclaw.json", [project], input), null);
  assert.equal(resolveExistingFile(real, [project], input.existsSync, input), real);
  assert.notEqual(path.normalize(real), path.normalize(decoy));
  const read = readSourceText(real, [project], input);
  assert.equal(read.missing, false);
  assert.equal(read.path, real);
  assert.match(read.text, /gateway/);
  const missing = readSourceText(real, [project], {
    ...input,
    existsSync: (item: string) => dirs.has(item),
  });
  assert.equal(missing.missing, true);
  assert.equal(missing.path, real);

  const dotted = path.join("C:", "Users", "someone", ".openclaw", "openclaw.json");
  const citedMissing = path.join("C:", "Users", "someone", "openclaw", "openclaw.json");
  const key = (item: string) => item.replaceAll("\\", "/").toLowerCase();
  assert.equal(key(dottedConfigAlt(citedMissing)), key(dotted));
  const hidden = {
    existsSync: (item: string) => key(item) === key(dotted),
    isDir: () => false,
    readdir: () => [] as string[],
    readFile: (item: string) => (key(item) === key(dotted) ? '{"gateway":true}\n' : ""),
  };
  assert.equal(key(findSourceFile(citedMissing, [project], hidden) ?? ""), key(dotted));
  const hiddenRead = readSourceText(citedMissing, [project], hidden);
  assert.equal(hiddenRead.missing, false);
  assert.equal(key(hiddenRead.path), key(dotted));
});

test("findSourceFile strips char suffixes and prefers an existing folder-tag file", () => {
  const root = path.join("C:", "game");
  const audioDir = path.join(root, "audio");
  const real = path.join(audioDir, "foo.md");
  const catalog = path.join(audioDir, "audio_catalog.gd");
  const bogus = path.join(root, "foo.md (34441 chars)");
  const dirs = new Set([root, audioDir].map((item) => path.normalize(item)));
  const files = new Set([real, catalog].map((item) => path.normalize(item)));
  const input = {
    existsSync: (item: string) => dirs.has(path.normalize(item)) || files.has(path.normalize(item)),
    isDir: (item: string) => dirs.has(path.normalize(item)),
    readdir: (dir: string) => {
      const norm = path.normalize(dir);
      if (norm === path.normalize(root)) return ["audio"];
      if (norm === path.normalize(audioDir)) return ["foo.md", "audio_catalog.gd"];
      return [];
    },
    readFile: (item: string) => (files.has(path.normalize(item)) ? "ok\n" : ""),
  };
  assert.equal(path.normalize(findSourceFile("foo.md (34441 chars)", [root], input) ?? ""), path.normalize(real));
  assert.equal(path.normalize(findSourceFile(bogus, [root], input) ?? ""), path.normalize(real));
  assert.equal(path.normalize(findSourceFile(path.join(root, "foo.md"), [root], input) ?? ""), path.normalize(real));
  assert.equal(
    path.normalize(findSourceFile(path.join(root, "audio_catalog.gd"), [root], input) ?? ""),
    path.normalize(catalog),
  );
  assert.equal(findSourceFile(root, [root], input), null);
  const folder = readSourceText(root, [root], input);
  assert.equal(folder.directory, true);
  assert.equal(folder.missing, false);
  const painted = readFileDiff(root, [root], input);
  assert.equal(painted.directory, true);
  const text = readSourceText("foo.md (34441 chars)", [root], input);
  assert.equal(text.missing, false);
  assert.equal(path.normalize(text.path), path.normalize(real));
});
