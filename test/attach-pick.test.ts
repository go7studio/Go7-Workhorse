import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  attachDialogProperties,
  attachDialogTitle,
  windowsNeedsAttachChoice,
} from "../electron/attach-pick";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows cannot mix files and folders in one picker", () => {
  // The common dialog takes openFile or openDirectory, not both. Passing both
  // opened a files-only picker with no warning, so a folder could not be
  // attached on Windows. The desk asks which first, then opens one kind.
  assert.equal(windowsNeedsAttachChoice("win32"), true);
  assert.equal(windowsNeedsAttachChoice("darwin"), false);
  assert.equal(windowsNeedsAttachChoice("linux"), false);

  assert.deepEqual(attachDialogProperties("win32", "files"), ["openFile", "multiSelections"]);
  assert.deepEqual(attachDialogProperties("win32", "folder"), ["openDirectory"]);
  // mixed on Windows still must not combine the two, in case the ask is skipped.
  assert.deepEqual(attachDialogProperties("win32", "mixed"), ["openFile", "multiSelections"]);
  assert.equal(attachDialogProperties("win32", "files").includes("openDirectory"), false);
  assert.equal(attachDialogProperties("win32", "folder").includes("openFile"), false);
  assert.equal(attachDialogProperties("win32", "mixed").includes("openDirectory"), false);

  assert.deepEqual(attachDialogProperties("darwin", "mixed"), ["openFile", "openDirectory", "multiSelections"]);
  assert.deepEqual(attachDialogProperties("darwin", "files"), ["openFile", "multiSelections"]);
  assert.deepEqual(attachDialogProperties("darwin", "folder"), ["openDirectory"]);
  assert.deepEqual(attachDialogProperties("linux", "mixed"), ["openFile", "openDirectory", "multiSelections"]);

  assert.equal(attachDialogTitle("files"), "Attach files");
  assert.equal(attachDialogTitle("folder"), "Attach folder");
  assert.equal(attachDialogTitle("mixed"), "Attach files or folders");

  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const pick = main.slice(
    main.indexOf('ipcMain.handle("attach:pick"'),
    main.indexOf('ipcMain.handle("localCompute:pickTokenFile"'),
  );
  assert.match(pick, /windowsNeedsAttachChoice\(process\.platform\)/);
  assert.match(pick, /buttons: \["Files", "Folder", "Cancel"\]/);
  assert.match(pick, /choice\.response === 2\) return \[\]/);
  assert.match(pick, /choice\.response === 1 \? "folder" : "files"/);
  assert.match(pick, /attachDialogProperties\(process\.platform, kind\)/);
  assert.match(pick, /attachDialogTitle\(kind\)/);
  assert.doesNotMatch(pick, /"openFile", "openDirectory"/);
});
