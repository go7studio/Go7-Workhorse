const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { requiresStableIdentity } = require("./after-pack.cjs");

/**
 * `codesign -dvv` prints the chain to stderr, leaf first. A release has to be
 * stamped by a Developer ID Application authority: an App Store identity is
 * refused by Gatekeeper outside the store, and an ad-hoc signature changes on
 * every build, so macOS treats each update as a new app and asks for every
 * vendor login again.
 */
function readAuthorities(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^Authority=(.*)$/)?.[1]?.trim())
    .filter(Boolean);
}

function developerIdProblem(output) {
  const authorities = readAuthorities(output);
  if (authorities.length === 0) {
    return /Signature=adhoc/.test(String(output ?? ""))
      ? "the app is ad-hoc signed"
      : "the app carries no certificate authority";
  }
  const leaf = authorities[0];
  return leaf.startsWith("Developer ID Application:")
    ? null
    : `the app is signed by "${leaf}"`;
}

function assertDeveloperIdSignature(appPath, run = spawnSync) {
  const result = run("/usr/bin/codesign", ["-dvv", appPath], { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const problem = developerIdProblem(output);
  if (problem) {
    throw new Error(
      `macOS release builds must be signed with a Developer ID Application certificate, but ${problem}. Check MAC_CSC_LINK holds the right identity — a name being set is not proof the certificate behind it is right.`,
    );
  }
  return readAuthorities(output)[0];
}

function entitlementsPath() {
  return path.join(__dirname, "..", "build", "entitlements.mac.plist");
}

/** Sign one nested binary. No --deep: that would walk the rest of the app. */
function helperSignArgs(helper, authority) {
  return ["--force", "--sign", authority, "--options", "runtime", "--timestamp", "--entitlements", entitlementsPath(), helper];
}

/**
 * electron-builder seals the app, then this hook signs mac-dictation.
 * That second signature changes a sealed resource, and `codesign --verify
 * --deep --strict` then reports the resource missing or invalid. Signing the
 * outer app again, without --deep, writes a new seal around the helper
 * signature. Notarization runs after this hook, so it staples that seal.
 */
function appResealArgs(appPath, authority) {
  return ["--force", "--sign", authority, "--options", "runtime", "--timestamp", "--entitlements", entitlementsPath(), appPath];
}

function signOutput(result) {
  return `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
}

function signDictationAndReseal(appPath, authority, io = { existsSync: fs.existsSync, run: spawnSync }) {
  const helper = path.join(appPath, "Contents", "Resources", "mac-dictation");
  if (!io.existsSync(helper)) return false;
  const signed = io.run("/usr/bin/codesign", helperSignArgs(helper, authority), { encoding: "utf8" });
  if (signed.status !== 0) {
    throw new Error(`Could not sign the dictation helper.\n${signOutput(signed)}`);
  }
  const resealed = io.run("/usr/bin/codesign", appResealArgs(appPath, authority), { encoding: "utf8" });
  if (resealed.status !== 0) {
    throw new Error(`Could not reseal the app after signing the dictation helper.\n${signOutput(resealed)}`);
  }
  return true;
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (!requiresStableIdentity()) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const authority = assertDeveloperIdSignature(appPath);
  signDictationAndReseal(appPath, authority);
  console.log(`  • signed by ${authority}`);
}

module.exports = afterSign;
module.exports.afterSign = afterSign;
module.exports.readAuthorities = readAuthorities;
module.exports.developerIdProblem = developerIdProblem;
module.exports.assertDeveloperIdSignature = assertDeveloperIdSignature;
module.exports.helperSignArgs = helperSignArgs;
module.exports.appResealArgs = appResealArgs;
module.exports.signDictationAndReseal = signDictationAndReseal;
