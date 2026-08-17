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
const afterSign = require("../scripts/after-sign.cjs") as {
  readAuthorities: (output: string) => string[];
  developerIdProblem: (output: string) => string | null;
  assertDeveloperIdSignature: (
    appPath: string,
    run: () => { stdout?: string; stderr?: string },
  ) => string;
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
      CSC_NAME: "Go7 (TEAM123456)",
      APPLE_ID: "release@example.test",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAM123456",
    }),
  );
  // The identity may come from the .p12 alone; CSC_NAME is optional.
  assert.doesNotThrow(() =>
    afterPack.assertStableReleaseIdentity({
      WORKHORSE_RELEASE_BUILD: "1",
      CSC_LINK: "base64-p12",
      APPLE_ID: "release@example.test",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAM123456",
    }),
  );
  assert.doesNotThrow(() => afterPack.assertStableReleaseIdentity({}));
});

/**
 * The gate used to demand that CSC_NAME start with "Developer ID Application:".
 * electron-builder rejects exactly that — "Please remove prefix ... from the
 * specified name" — so no signed macOS release could ever be built. 0.1.9 died
 * on it after a full build.
 */
test("mac release packaging rejects a CSC_NAME carrying a certificate type", () => {
  for (const name of [
    "Developer ID Application: Moonlight Capital LLC (F6Y5HMGMHD)",
    "Apple Distribution: Moonlight Capital LLC",
    "Apple Development: Someone",
    "3rd Party Mac Developer Application: Someone",
  ]) {
    assert.throws(
      () =>
        afterPack.assertStableReleaseIdentity({
          WORKHORSE_RELEASE_BUILD: "1",
          CSC_NAME: name,
          APPLE_ID: "release@example.test",
          APPLE_APP_SPECIFIC_PASSWORD: "app-password",
          APPLE_TEAM_ID: "TEAM123456",
        }),
      /Remove ".*:" from CSC_NAME/,
      name,
    );
  }
});

test("a release is verified against the signature it produced, not the env", () => {
  const developerId = [
    "Executable=/tmp/Go7 Workhorse.app/Contents/MacOS/Go7 Workhorse",
    "Authority=Developer ID Application: Moonlight Capital LLC (F6Y5HMGMHD)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
  ].join("\n");
  assert.equal(afterSign.developerIdProblem(developerId), null);
  assert.equal(
    afterSign.assertDeveloperIdSignature("/tmp/app", () => ({ stderr: developerId })),
    "Developer ID Application: Moonlight Capital LLC (F6Y5HMGMHD)",
  );

  // An App Store identity signs happily and is refused outside the store.
  assert.match(
    afterSign.developerIdProblem("Authority=Apple Distribution: Moonlight Capital LLC") ?? "",
    /signed by "Apple Distribution/,
  );
  assert.match(afterSign.developerIdProblem("Signature=adhoc") ?? "", /ad-hoc/);
  assert.match(afterSign.developerIdProblem("") ?? "", /no certificate authority/);
  assert.throws(
    () => afterSign.assertDeveloperIdSignature("/tmp/app", () => ({ stderr: "Signature=adhoc" })),
    /Developer ID Application certificate/,
  );
});



test("mac release packaging requires notarization credentials", () => {
  assert.throws(
    () => afterPack.assertStableReleaseIdentity({
      WORKHORSE_RELEASE_BUILD: "1",
      CSC_NAME: "Go7 (TEAM123456)",
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
