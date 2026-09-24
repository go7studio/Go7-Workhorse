import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  isNetworkPath,
  mediaFileCandidates,
  resolveMediaProtocolFile,
  safeLocalPath,
} from "../electron/media-src";
import { mdImageInitialSrc } from "../src/lib/media-display";

// Windows semantics on every OS: a UNC path is only absolute under path.win32,
// and Windows is where a stat of one signs in to the host it names.
const win = path.win32;

const SHARE_HREFS = [
  "\\\\evil.example\\share\\a.png",
  "//evil.example/share/a.png",
  "file:////evil.example/share/a.png",
  "\\\\?\\UNC\\evil.example\\share\\a.png",
  "\\\\.\\pipe\\a.png",
];

test("a path that names another machine is recognised in every spelling", () => {
  for (const href of SHARE_HREFS.filter((item) => !item.startsWith("file:"))) {
    assert.equal(isNetworkPath(href), true, href);
  }
  assert.equal(isNetworkPath("C:\\Users\\me\\a.png"), false);
  assert.equal(isNetworkPath("/Users/me/a.png"), false);
  assert.equal(isNetworkPath("images/a.png"), false);
});

test("a picture link to a share never becomes a stat", () => {
  for (const href of SHARE_HREFS) {
    const stats: string[] = [];
    const url = mdImageInitialSrc(href, { cwd: "C:\\proj", vendorSessionId: "s1" });
    const resolved = resolveMediaProtocolFile(url, {
      path: win,
      existsSync: (file) => {
        stats.push(file);
        return true;
      },
    });
    assert.equal(resolved, null, href);
    assert.deepEqual(stats.filter(isNetworkPath), [], `${href} reached a stat`);
    assert.deepEqual(mediaFileCandidates(href, { cwd: "C:\\proj", home: "C:\\Users\\me" }, win), [], href);
  }
});

test("a media URL written out whole cannot put the lookup on a share either", () => {
  // mdImageInitialSrc passes a workhorse-media href through untouched, so the
  // cwd a reply writes into it is as untrusted as the picture path.
  const url = "workhorse-media://local/?p=images%2Fa.png&cwd=%5C%5Cevil.example%5Cshare&sid=s1";
  const stats: string[] = [];
  resolveMediaProtocolFile(url, {
    path: win,
    existsSync: (file) => {
      stats.push(file);
      return false;
    },
  });
  assert.ok(stats.length > 0, "the local candidates are still tried");
  assert.deepEqual(stats.filter(isNetworkPath), []);
});

test("a local picture still resolves", () => {
  const file = "C:\\out\\render.png";
  const url = mdImageInitialSrc(file, { cwd: "C:\\proj" });
  assert.equal(resolveMediaProtocolFile(url, { path: win, existsSync: (candidate) => candidate === file }), file);
  const relative = mdImageInitialSrc("images/a.png", { cwd: "C:\\proj" });
  assert.equal(
    resolveMediaProtocolFile(relative, { path: win, existsSync: (candidate) => candidate === "C:\\proj\\images\\a.png" }),
    "C:\\proj\\images\\a.png",
  );
});

test("the desk's local-path check refuses a share before it stats one", () => {
  const stats: string[] = [];
  const statSync = (file: string) => {
    stats.push(file);
    return { isFile: () => true, isDirectory: () => false };
  };
  for (const href of SHARE_HREFS.filter((item) => !item.startsWith("file:"))) {
    assert.equal(safeLocalPath(href, { path: win, statSync }), null, href);
  }
  assert.deepEqual(stats, []);
  assert.equal(safeLocalPath("C:\\out\\render.png", { path: win, statSync }), "C:\\out\\render.png");
  assert.equal(safeLocalPath("relative\\render.png", { path: win, statSync }), null);
});
