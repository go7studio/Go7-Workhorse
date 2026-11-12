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

function codesignArgs(target, authority, keychain) {
  const args = ["--force", "--sign", authority, "--options", "runtime", "--timestamp", "--entitlements", entitlementsPath()];
  if (keychain) args.push("--keychain", keychain);
  args.push(target);
  return args;
}

/** Sign one nested binary. No --deep: that would walk the rest of the app. */
function helperSignArgs(helper, authority, keychain) {
  return codesignArgs(helper, authority, keychain);
}

/**
 * The outer app is signed again, without --deep, so the seal includes the
 * helper and the helper's own signature stays. This has to happen in the
 * sign hook, before notarization. afterSign runs after the ticket is stapled,
 * and signing anything there removes it.
 */
function appResealArgs(appPath, authority, keychain) {
  return codesignArgs(appPath, authority, keychain);
}

function signOutput(result) {
  return `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
}

function signDictationAndReseal(appPath, authority, io = {}) {
  const existsSync = io.existsSync ?? fs.existsSync;
  const run = io.run ?? spawnSync;
  const helper = path.join(appPath, "Contents", "Resources", "mac-dictation");
  if (!existsSync(helper)) return false;
  const signed = run("/usr/bin/codesign", helperSignArgs(helper, authority, io.keychain), { encoding: "utf8" });
  if (signed.status !== 0) {
    throw new Error(`Could not sign the dictation helper.\n${signOutput(signed)}`);
  }
  const resealed = run("/usr/bin/codesign", appResealArgs(appPath, authority, io.keychain), { encoding: "utf8" });
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
  // The dictation helper is signed in scripts/mac-sign.cjs, before notarization.
  // Signing here would replace a stapled ticket. 0.7.11 failed that way.
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
