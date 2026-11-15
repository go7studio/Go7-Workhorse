import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") process.exit(0);

const source = path.join(root, "electron", "mac-dictation.swift");
const disclaim = path.join(root, "electron", "mac-dictation-disclaim.c");
const plist = path.join(root, "electron", "mac-dictation-Info.plist");
const output = path.join(root, "build", "mac-dictation");
const entitlements = path.join(root, "build", "entitlements.mac.plist");

// The helper is its own signed binary. Without this plist section, and
// without disclaiming ChatGPT's responsibility, macOS aborts the process
// the moment it asks for speech recognition.
const newest = Math.max(fs.statSync(source).mtimeMs, fs.statSync(disclaim).mtimeMs, fs.statSync(plist).mtimeMs);
if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= newest) process.exit(0);

const sdk = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
fs.mkdirSync(path.dirname(output), { recursive: true });
const parts = [];
for (const arch of ["arm64", "x86_64"]) {
  const part = path.join(root, "build", `mac-dictation-${arch}`);
  const object = path.join(root, "build", `mac-dictation-disclaim-${arch}.o`);
  execFileSync(
    "xcrun",
    ["clang", "-target", `${arch}-apple-macosx14.0`, "-isysroot", sdk, "-c", disclaim, "-o", object],
    { stdio: "inherit" },
  );
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-target",
      `${arch}-apple-macosx14.0`,
      "-sdk",
      sdk,
      "-O",
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      plist,
      "-o",
      part,
      source,
      object,
    ],
    { stdio: "inherit" },
  );
  fs.unlinkSync(object);
  parts.push(part);
}
execFileSync("lipo", ["-create", "-output", output, ...parts], { stdio: "inherit" });
for (const part of parts) fs.unlinkSync(part);
execFileSync(
  "/usr/bin/codesign",
  ["--force", "--sign", "-", "--entitlements", entitlements, output],
  { stdio: "inherit" },
);
