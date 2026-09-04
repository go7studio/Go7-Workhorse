import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  checkPackUpdate,
  checkRelativePath,
  findCaseCollision,
  installFromFolder,
  installFromRepo,
  parseGitHubRepoUrl,
  readInstallRecord,
  readTar,
  removePack,
  updatePack,
} from "../electron/workshop-install";
import { PACK_LIMITS } from "../src/lib/workshop-pack";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "workshop");
const REPO = "https://github.com/go7studio/workshop-pack-sample";

function fixturePack(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "sample-box", "pack.json"), "utf8"));
}

function tempRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-install-"));
  return path.join(base, "packs");
}

// ---------------------------------------------------------------------------------------------
// A tiny ustar writer, enough to build every archive these tests need.

type TarSpec = { name: string; data?: string | Buffer; type?: string; linkname?: string };

function tarHeader(name: string, size: number, type: string, linkname = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function tar(specs: TarSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    const data = spec.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data, "utf8");
    const type = spec.type ?? (spec.name.endsWith("/") ? "5" : "0");
    parts.push(tarHeader(spec.name, type === "5" ? 0 : data.length, type, spec.linkname));
    if (type !== "5" && data.length) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** A GitHub-shaped archive: `repo-tag/` prefix, pax global header first. */
function githubTarball(prefix: string, files: Record<string, string | Buffer>, extra: TarSpec[] = []): Buffer {
  const specs: TarSpec[] = [
    { name: "pax_global_header", type: "g", data: "52 comment=0123456789abcdef0123456789abcdef01234567\n" },
    { name: `${prefix}/` },
  ];
  const dirs = new Set<string>();
  for (const [rel, data] of Object.entries(files)) {
    const segs = rel.split("/");
    for (let i = 1; i < segs.length; i++) {
      const dir = `${prefix}/${segs.slice(0, i).join("/")}/`;
      if (!dirs.has(dir)) {
        dirs.add(dir);
        specs.push({ name: dir });
      }
    }
    specs.push({ name: `${prefix}/${rel}`, data });
  }
  return gzipSync(tar([...specs, ...extra]));
}

function samplePackFiles(prefix = "packs/sample-box", pack: Record<string, unknown> = fixturePack()): Record<string, string> {
  return {
    "README.md": "# sample\n",
    [`${prefix}/pack.json`]: JSON.stringify(pack, null, 2),
    [`${prefix}/collector/README.md`]: "install notes\n",
    [`${prefix}/collector/feed.py`]: "print('never run on the desk')\n",
  };
}

function repoFetch(tags: string[], tarball: Buffer | null, seen: string[] = []): typeof fetch {
  return (async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("https://api.github.com/repos/go7studio/workshop-pack-sample/tags")) {
      return new Response(JSON.stringify(tags.map((name) => ({ name, commit: { sha: "x" } }))), { status: 200 });
    }
    if (url.startsWith("https://codeload.github.com/go7studio/workshop-pack-sample/tar.gz/refs/tags/") && tarball) {
      return new Response(new Uint8Array(tarball), { status: 200, headers: { "content-type": "application/x-gzip" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// URL and path rules

test("only https://github.com/<owner>/<repo> is accepted, and nothing is fetched before that check", async () => {
  assert.deepEqual(parseGitHubRepoUrl("https://github.com/go7studio/workshop-pack-sample"), {
    owner: "go7studio", repo: "workshop-pack-sample", canonical: REPO,
  });
  assert.equal(parseGitHubRepoUrl("https://github.com/go7studio/workshop-pack-sample.git/")?.canonical, REPO);
  for (const bad of [
    "http://github.com/go7studio/workshop-pack-sample",
    "https://gitlab.com/go7studio/workshop-pack-sample",
    "https://github.com/go7studio",
    "https://github.com/go7studio/repo/tree/main",
    "https://github.com/../etc/passwd",
    "https://github.com/a b/c",
    "https://github.com/go7studio/repo?x=1",
    "git@github.com:go7studio/repo.git",
    "",
  ]) {
    assert.equal(parseGitHubRepoUrl(bad), null, bad);
  }
  const seen: string[] = [];
  const root = tempRoot();
  for (const bad of ["http://github.com/go7studio/workshop-pack-sample", "https://example.test/x/y"]) {
    const result = await installFromRepo(bad, root, repoFetch(["v1.0.0"], null, seen));
    assert.equal(result.ok, false);
  }
  assert.equal(seen.length, 0);
  assert.equal(fs.existsSync(root), false);
});

test("checkRelativePath refuses escapes, absolutes, and Windows-unsafe names", () => {
  assert.equal(checkRelativePath("packs/sample-box/pack.json"), null);
  assert.equal(checkRelativePath("a/./b"), null);
  assert.notEqual(checkRelativePath("../x"), null);
  assert.notEqual(checkRelativePath("a/../../x"), null);
  assert.notEqual(checkRelativePath("/etc/passwd"), null);
  assert.notEqual(checkRelativePath("C:/x"), null);
  assert.notEqual(checkRelativePath("a\\b"), null);
  assert.notEqual(checkRelativePath("a\0b"), null);
  assert.notEqual(checkRelativePath("packs/CON/pack.json"), null);
  assert.notEqual(checkRelativePath("packs/x./pack.json"), null);
});

test("case collision is caught by the folder list, not the disk", () => {
  assert.equal(findCaseCollision(["SAMPLE-BOX", "other"], "sample-box"), "SAMPLE-BOX");
  assert.equal(findCaseCollision(["Sample-Box"], "sample-box"), "Sample-Box");
  assert.equal(findCaseCollision(["sample-box"], "sample-box"), null);
  assert.equal(findCaseCollision([], "sample-box"), null);
});

// ---------------------------------------------------------------------------------------------
// Archive install

test("happy path: highest semver tag downloads, stages, validates, and installs with provenance", async () => {
  const root = tempRoot();
  const seen: string[] = [];
  const tarball = githubTarball("workshop-pack-sample-1.2.0", samplePackFiles());
  const result = await installFromRepo(REPO + ".git", root, repoFetch(["v1.0.0", "v1.2.0", "v2.0.0-rc.1", "nightly"], tarball, seen));
  assert.deepEqual(result, { ok: true, ids: ["sample-box"] });
  assert.ok(seen[1].endsWith("/tar.gz/refs/tags/v1.2.0"), seen[1]);

  const dir = path.join(root, "sample-box");
  assert.ok(fs.existsSync(path.join(dir, "pack.json")));
  assert.ok(fs.existsSync(path.join(dir, "collector", "feed.py")));
  assert.equal(fs.existsSync(path.join(root, "README.md")), false, "files outside the pack folder never reach the root");
  const record = readInstallRecord(dir);
  assert.equal(record?.kind, "repo");
  assert.equal(record?.from, REPO);
  assert.equal(record?.tag, "v1.2.0");
  assert.match(record?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(record?.at ?? "")));
  assert.equal(fs.readdirSync(path.join(root, "..", "staging")).length, 0, "staging is cleaned");
});

test("a pack at the archive root installs under its validated id", async () => {
  const root = tempRoot();
  const files = { "pack.json": JSON.stringify(fixturePack()), "collector/README.md": "notes\n" };
  const result = await installFromRepo(REPO, root, repoFetch(["1.0.0"], githubTarball("workshop-pack-sample-1.0.0", files)));
  assert.deepEqual(result, { ok: true, ids: ["sample-box"] });
  assert.ok(fs.existsSync(path.join(root, "sample-box", "collector", "README.md")));
});

test("no semver tag refuses before any download", async () => {
  const root = tempRoot();
  const seen: string[] = [];
  const result = await installFromRepo(REPO, root, repoFetch(["nightly", "latest"], null, seen));
  assert.deepEqual(result, { ok: false, reason: "no semver tag" });
  assert.equal(seen.length, 1);
});

test("zip-slip entries, absolute paths, and links are refused and leave nothing behind", async () => {
  const cases: Array<[string, TarSpec[]]> = [
    ["dot-dot", [{ name: "workshop-pack-sample-1.0.0/../x", data: "x" }]],
    ["deep dot-dot", [{ name: "workshop-pack-sample-1.0.0/packs/../../x", data: "x" }]],
    ["absolute", [{ name: "/etc/cron.d/x", data: "x" }]],
    ["backslash", [{ name: "workshop-pack-sample-1.0.0/packs\\x", data: "x" }]],
    ["symlink", [{ name: "workshop-pack-sample-1.0.0/packs/sample-box/link", type: "2", linkname: "../../../../etc/passwd" }]],
    ["hardlink", [{ name: "workshop-pack-sample-1.0.0/packs/sample-box/hard", type: "1", linkname: "pack.json" }]],
    ["device", [{ name: "workshop-pack-sample-1.0.0/packs/sample-box/dev", type: "3" }]],
  ];
  for (const [label, extra] of cases) {
    const root = tempRoot();
    const tarball = githubTarball("workshop-pack-sample-1.0.0", samplePackFiles(), extra);
    const result = await installFromRepo(REPO, root, repoFetch(["v1.0.0"], tarball));
    assert.equal(result.ok, false, label);
    assert.equal(fs.existsSync(path.join(root, "sample-box")), false, label);
    assert.equal(fs.existsSync(path.join(root, "..", "x")), false, label);
    const staging = path.join(root, "..", "staging");
    assert.ok(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0, `${label}: staging cleaned`);
  }
});

test("readTar honours GNU long names and pax paths, strips the first component", () => {
  const long = "workshop-pack-sample-1.0.0/" + "d".repeat(120) + "/file.txt";
  const buf = tar([
    { name: "././@LongLink", type: "L", data: long + "\0" },
    { name: long.slice(0, 99), data: "hello" },
    { name: "workshop-pack-sample-1.0.0/PaxHeader/x", type: "x", data: (() => {
      const record = " path=workshop-pack-sample-1.0.0/pax/target.txt\n";
      const len = String(record.length + 2).length + record.length;
      return `${len}${record}`;
    })() },
    { name: "ignored", data: "pax" },
  ]);
  const entries = readTar(buf);
  assert.deepEqual(entries.map((e) => [e.path, e.type, e.data.toString()]), [
    [`${"d".repeat(120)}/file.txt`, "file", "hello"],
    ["pax/target.txt", "file", "pax"],
  ]);
  assert.throws(() => readTar(Buffer.from("not a tar at all".repeat(64))), /checksum/);
});

test("more files than the cap is refused", async () => {
  const root = tempRoot();
  const files = samplePackFiles();
  for (let i = 0; i <= PACK_LIMITS.maxFiles; i++) files[`packs/sample-box/pad/${i}.txt`] = "x";
  const result = await installFromRepo(REPO, root, repoFetch(["v1.0.0"], githubTarball("workshop-pack-sample-1.0.0", files)));
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /files/);
});

test("an archive over the byte cap is refused before extraction", async () => {
  const root = tempRoot();
  const big = Buffer.alloc(PACK_LIMITS.maxInstallBytes + 1, 0x41);
  const result = await installFromRepo(REPO, root, (async (input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify([{ name: "v1.0.0" }]), { status: 200 });
    return new Response(new Uint8Array(big), { status: 200 });
  }) as typeof fetch);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /8 MiB/);
});

test("pack.json whose id does not match its folder is refused", async () => {
  const root = tempRoot();
  const files = samplePackFiles("packs/other-name");
  const result = await installFromRepo(REPO, root, repoFetch(["v1.0.0"], githubTarball("workshop-pack-sample-1.0.0", files)));
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /does not match folder/);
  assert.equal(fs.existsSync(path.join(root, "sample-box")), false);
  assert.equal(fs.existsSync(path.join(root, "other-name")), false);
});

test("an unknown widget refuses the whole install and says it needs a newer Workhorse", async () => {
  const root = tempRoot();
  const pack = fixturePack();
  (pack.strip as unknown[]).push({ w: "dial", of: "feed:/watts" });
  const files = samplePackFiles("packs/sample-box", pack);
  const result = await installFromRepo(REPO, root, repoFetch(["v1.0.0"], githubTarball("workshop-pack-sample-1.0.0", files)));
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /needs a newer Workhorse/);
  assert.equal(fs.existsSync(path.join(root, "sample-box")), false);
});

test("a declared collector folder must exist", async () => {
  const root = tempRoot();
  const files = { "packs/sample-box/pack.json": JSON.stringify(fixturePack()) };
  const result = await installFromRepo(REPO, root, repoFetch(["v1.0.0"], githubTarball("workshop-pack-sample-1.0.0", files)));
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /collector/);
});

// ---------------------------------------------------------------------------------------------
// Folder install

function sourceFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workshop-src-"));
  const pack = path.join(dir, "sample-box");
  fs.mkdirSync(path.join(pack, "collector"), { recursive: true });
  fs.writeFileSync(path.join(pack, "pack.json"), JSON.stringify(fixturePack(), null, 2));
  fs.writeFileSync(path.join(pack, "collector", "README.md"), "notes\n");
  return dir;
}

test("folder install copies (never links) and records the source", async () => {
  const src = sourceFolder();
  const root = tempRoot();
  const result = await installFromFolder(src, root);
  assert.deepEqual(result, { ok: true, ids: ["sample-box"] });
  const installed = path.join(root, "sample-box", "pack.json");
  const stat = fs.lstatSync(installed);
  assert.ok(stat.isFile());
  assert.equal(stat.nlink, 1);
  assert.notEqual(stat.ino, fs.statSync(path.join(src, "sample-box", "pack.json")).ino);
  fs.writeFileSync(path.join(src, "sample-box", "pack.json"), "{}");
  assert.equal(JSON.parse(fs.readFileSync(installed, "utf8")).id, "sample-box", "installed copy is independent of the source");
  const record = readInstallRecord(path.join(root, "sample-box"));
  assert.equal(record?.kind, "folder");
  assert.equal(record?.from, path.resolve(src));
  assert.equal(record?.tag, undefined);
  assert.match(record?.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("a symlink inside the source folder refuses the install", async (t) => {
  const src = sourceFolder();
  try {
    fs.symlinkSync(path.join(src, "sample-box", "pack.json"), path.join(src, "sample-box", "collector", "alias.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlinks need elevated rights on this Windows account");
      return;
    }
    throw error;
  }
  const root = tempRoot();
  const result = await installFromFolder(src, root);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /symlink/);
  assert.equal(fs.existsSync(path.join(root, "sample-box")), false);
});

test("a source folder that is itself a symlink, or missing, is refused", async (t) => {
  const root = tempRoot();
  assert.equal((await installFromFolder(path.join(os.tmpdir(), "workshop-does-not-exist-" + Date.now()), root)).ok, false);
  const real = sourceFolder();
  const link = path.join(os.tmpdir(), `workshop-link-${Date.now()}`);
  try {
    fs.symlinkSync(real, link, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlinks need elevated rights on this Windows account");
      return;
    }
    throw error;
  }
  const result = await installFromFolder(link, root);
  assert.equal(result.ok, false);
  fs.rmSync(link);
});

test("installing the same id again replaces it; remove deletes the folder", async () => {
  const src = sourceFolder();
  const root = tempRoot();
  assert.equal((await installFromFolder(src, root)).ok, true);
  fs.writeFileSync(path.join(root, "sample-box", "leftover.txt"), "old");
  const pack = fixturePack();
  pack.version = "1.1.0";
  fs.writeFileSync(path.join(src, "sample-box", "pack.json"), JSON.stringify(pack));
  assert.equal((await installFromFolder(src, root)).ok, true);
  assert.equal(fs.existsSync(path.join(root, "sample-box", "leftover.txt")), false, "replaced, not merged");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "sample-box", "pack.json"), "utf8")).version, "1.1.0");
  assert.equal(fs.readdirSync(root).length, 1);

  assert.deepEqual(removePack("../sample-box", root), { ok: false, reason: "bad id" });
  assert.deepEqual(removePack("ghost", root), { ok: false, reason: "not installed" });
  assert.deepEqual(removePack("sample-box", root), { ok: true });
  assert.equal(fs.existsSync(path.join(root, "sample-box")), false);
});

// ---------------------------------------------------------------------------------------------
// Update

test("checkUpdate reads the record; update re-installs and flags changed sources", async () => {
  const root = tempRoot();
  const v1 = githubTarball("workshop-pack-sample-1.0.0", samplePackFiles());
  assert.equal((await installFromRepo(REPO, root, repoFetch(["v1.0.0"], v1))).ok, true);

  const check = await checkPackUpdate("sample-box", root, repoFetch(["v1.0.0", "v1.1.0"], null));
  assert.deepEqual(check, { ok: true, current: "1.0.0", latest: "v1.1.0" });

  // Cards-only change: same sources, no reconfirm.
  const cardsOnly = fixturePack();
  cardsOnly.version = "1.1.0";
  (cardsOnly.cards as Array<{ title: string }>)[0].title = "Box (renamed)";
  const v11 = githubTarball("workshop-pack-sample-1.1.0", samplePackFiles("packs/sample-box", cardsOnly));
  const first = await updatePack("sample-box", root, repoFetch(["v1.0.0", "v1.1.0"], v11));
  assert.equal(first.ok, true);
  assert.equal(first.sourcesChanged, false);
  assert.equal(readInstallRecord(path.join(root, "sample-box"))?.tag, "v1.1.0");

  // Sources change: the desk must re-confirm.
  const widened = fixturePack();
  widened.version = "1.2.0";
  (widened.sources as Array<Record<string, unknown>>)[0].path = "feed/extended";
  const v12 = githubTarball("workshop-pack-sample-1.2.0", samplePackFiles("packs/sample-box", widened));
  const second = await updatePack("sample-box", root, repoFetch(["v1.2.0"], v12));
  assert.equal(second.ok, true);
  assert.equal(second.sourcesChanged, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "sample-box", "pack.json"), "utf8")).version, "1.2.0");
});

test("folder-installed packs have no update path", async () => {
  const root = tempRoot();
  assert.equal((await installFromFolder(sourceFolder(), root)).ok, true);
  const seen: string[] = [];
  const check = await checkPackUpdate("sample-box", root, repoFetch(["v9.0.0"], null, seen));
  assert.equal(check.ok, false);
  assert.equal(check.current, "1.0.0");
  assert.match(check.reason ?? "", /folder/);
  const update = await updatePack("sample-box", root, repoFetch(["v9.0.0"], null, seen));
  assert.equal(update.ok, false);
  assert.equal(seen.length, 0);
});
