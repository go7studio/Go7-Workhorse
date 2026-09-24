import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openableMediaPath } from "../electron/media-src";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A gallery row's path is whatever a pack's feed wrote. The row says image or
// video; the desk used to open any path that existed, and opening an .exe, an
// .app or a .command runs it.
const win = path.win32;
const plainFile = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
const folder = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
const link = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true };

function io(entries: Record<string, typeof plainFile>) {
  const stats: string[] = [];
  const lookup = (file: string) => {
    stats.push(file);
    const hit = entries[file];
    if (!hit) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return hit;
  };
  return { stats, io: { path: win, statSync: lookup, lstatSync: lookup } };
}

test("Open opens a picture or a video of the kind the row claims", () => {
  const { io: fs } = io({
    "C:\\out\\render.png": plainFile,
    "C:\\out\\RENDER.JPG": plainFile,
    "C:\\out\\clip.mp4": plainFile,
    "C:\\out\\clip.webm": plainFile,
  });
  assert.equal(openableMediaPath("C:\\out\\render.png", "image", fs), "C:\\out\\render.png");
  assert.equal(openableMediaPath("C:\\out\\RENDER.JPG", "image", fs), "C:\\out\\RENDER.JPG");
  assert.equal(openableMediaPath("C:\\out\\clip.mp4", "video", fs), "C:\\out\\clip.mp4");
  assert.equal(openableMediaPath("C:\\out\\clip.webm", "video", fs), "C:\\out\\clip.webm");
});

test("Open refuses anything that is not what the row says it is", () => {
  const { io: fs } = io({
    "C:\\out\\render.exe": plainFile,
    "C:\\out\\render.png.lnk": plainFile,
    "C:\\out\\clip.mp4": plainFile,
    "C:\\out\\render.png": plainFile,
    "C:\\out\\folder.png": folder,
    "C:\\out\\linked.png": link,
  });
  assert.equal(openableMediaPath("C:\\out\\render.exe", "image", fs), null, "an executable");
  assert.equal(openableMediaPath("C:\\out\\render.png.lnk", "image", fs), null, "a shortcut");
  assert.equal(openableMediaPath("C:\\out\\clip.mp4", "image", fs), null, "a video called an image");
  assert.equal(openableMediaPath("C:\\out\\render.png", "video", fs), null, "an image called a video");
  assert.equal(openableMediaPath("C:\\out\\folder.png", "image", fs), null, "a folder, or a bundle");
  assert.equal(openableMediaPath("C:\\out\\linked.png", "image", fs), null, "a link to something else");
  assert.equal(openableMediaPath("C:\\out\\render.png", undefined, fs), null, "no kind");
  assert.equal(openableMediaPath("C:\\out\\missing.png", "image", fs), null, "not there");
});

test("Open never stats a path on another machine", () => {
  const { io: fs, stats } = io({});
  for (const share of ["\\\\evil.example\\share\\render.png", "//evil.example/share/render.png", "\\\\?\\UNC\\evil.example\\share\\render.png"]) {
    assert.equal(openableMediaPath(share, "image", fs), null, share);
  }
  assert.deepEqual(stats, []);
});

test("the desk opens by kind and reveals anything else local", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.ts"), "utf8");
  const handler = main.slice(main.indexOf('ipcMain.handle("desk:open-local-path"'), main.indexOf('ipcMain.handle("desk:reveal-local-path"'));
  assert.match(handler, /openableMediaPath\(input, kind\)/);
  assert.match(handler, /shell\.showItemInFolder\(local\)/);
  assert.doesNotMatch(handler, /shell\.openPath\(local\)/);
  assert.match(readFileSync(path.join(ROOT, "electron", "preload.ts"), "utf8"), /invoke\("desk:open-local-path", path, kind\)/);
  assert.match(readFileSync(path.join(ROOT, "src", "ui", "workshop-paint.tsx"), "utf8"), /openPath\(item\.path, item\.kind\)/);
});
