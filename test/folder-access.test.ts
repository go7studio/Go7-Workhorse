import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  bookmarksFromProjects,
  claimFolderBookmarks,
  loadFolderBookmarks,
  mergeFolderBookmarks,
  rememberFolderBookmark,
} from "../electron/folder-access";
import { asPickedFolder, folderFromPath, normalizeProject } from "../src/lib/project";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const afterPack = require("../scripts/after-pack.cjs") as {
  shouldAdHocSign: (env?: NodeJS.Dict<string>) => boolean;
  assertStableReleaseIdentity: (env?: NodeJS.Dict<string>) => void;
};

test("ad-hoc mac signature is skipped when a release identity will stamp the app", () => {
  assert.equal(afterPack.shouldAdHocSign({}), true);
  assert.equal(afterPack.shouldAdHocSign({ CSC_IDENTITY_AUTO_DISCOVERY: "false" }), true);
  assert.equal(afterPack.shouldAdHocSign({ CSC_NAME: "Developer ID Application: Moonlight" }), false);
  assert.equal(afterPack.shouldAdHocSign({ CSC_LINK: "/secrets/cert.p12" }), false);
});

test("mac release packaging refuses an identity that would retrigger Keychain approval", () => {
  assert.throws(
    () => afterPack.assertStableReleaseIdentity({ WORKHORSE_RELEASE_BUILD: "1" }),
    /require CSC_LINK or CSC_NAME/,
  );
  assert.doesNotThrow(() =>
    afterPack.assertStableReleaseIdentity({
      WORKHORSE_RELEASE_BUILD: "1",
      CSC_NAME: "Developer ID Application: Go7",
      APPLE_ID: "release@example.test",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAM123456",
    }),
  );
  assert.doesNotThrow(() => afterPack.assertStableReleaseIdentity({}));
});

test("mac release packaging rejects an App Store distribution identity", () => {
  assert.throws(
    () => afterPack.assertStableReleaseIdentity({ WORKHORSE_RELEASE_BUILD: "1", CSC_NAME: "Apple Distribution: Go7" }),
    /Developer ID Application/,
  );
});

test("mac release packaging requires notarization credentials", () => {
  assert.throws(
    () => afterPack.assertStableReleaseIdentity({
      WORKHORSE_RELEASE_BUILD: "1",
      CSC_NAME: "Developer ID Application: Go7",
    }),
    /notarization credentials/,
  );
});

test("folder bookmarks persist and are claimed on later launch", () => {
  const userData = mkdtempSync(path.join(os.tmpdir(), "wh-folder-access-"));
  const files = new Map<string, string>();
  const io = {
    userData,
    readFile: (filePath: string) => {
      const text = files.get(filePath);
      if (text === undefined) throw new Error("missing");
      return text;
    },
    writeFile: (filePath: string, text: string) => {
      files.set(filePath, text);
    },
    mkdir: () => undefined,
  };
  rememberFolderBookmark("/Users/me/Projects/Go7", "bookmark-1", io);
  const stored = loadFolderBookmarks(io);
  assert.equal(stored["/Users/me/Projects/Go7"], "bookmark-1");
  const claimed: string[] = [];
  const hit = claimFolderBookmarks(stored, (bookmark) => {
    claimed.push(bookmark);
    return true;
  });
  assert.deepEqual(claimed, ["bookmark-1"]);
  assert.deepEqual(hit, ["/Users/me/Projects/Go7"]);
});

test("project folder bookmarks hydrate and merge with the picker store", () => {
  const project = normalizeProject({
    id: "proj_1",
    name: "Game",
    folders: [{ path: "/Users/me/Game", bookmark: "bm-game" }],
  });
  assert.equal(project?.folders[0]?.bookmark, "bm-game");
  assert.equal(folderFromPath("/tmp/x", "bm-x").bookmark, "bm-x");
  const fromState = bookmarksFromProjects({ projects: [project] });
  assert.equal(fromState["/Users/me/Game"], "bm-game");
  const merged = mergeFolderBookmarks(fromState, { "/Users/me/Game": "bm-newer" });
  assert.equal(merged["/Users/me/Game"], "bm-newer");
  assert.deepEqual(asPickedFolder("/tmp/only"), { path: "/tmp/only" });
  assert.deepEqual(asPickedFolder({ path: "/tmp/pick", bookmark: "bm" }), { path: "/tmp/pick", bookmark: "bm" });
  assert.equal(asPickedFolder(null), null);
});

test("folder picker asks macOS for a scoped bookmark and claims it later", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  assert.match(main, /securityScopedBookmarks: process.platform === "darwin"/);
  assert.match(main, /startAccessingSecurityScopedResource/);
  assert.match(main, /claimLinkedFolders/);
  assert.match(main, /rememberFolderBookmark/);
  const entitlements = readFileSync(path.join(ROOT, "build", "entitlements.mac.plist"), "utf8");
  assert.match(entitlements, /files.bookmarks.app-scope/);
  assert.match(entitlements, /files.user-selected.read-write/);
});
