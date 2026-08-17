const { spawnSync } = require("node:child_process");
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

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (!requiresStableIdentity()) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const authority = assertDeveloperIdSignature(appPath);
  console.log(`  • signed by ${authority}`);
}

module.exports = afterSign;
module.exports.afterSign = afterSign;
module.exports.readAuthorities = readAuthorities;
module.exports.developerIdProblem = developerIdProblem;
module.exports.assertDeveloperIdSignature = assertDeveloperIdSignature;
