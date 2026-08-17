const { execFileSync } = require("node:child_process");
const path = require("node:path");

/** Ad-hoc only when no release identity will stamp the same Team ID again. */
function shouldAdHocSign(env = process.env) {
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return true;
  if (String(env.CSC_LINK ?? "").trim() || String(env.CSC_NAME ?? "").trim()) return false;
  return true;
}

function requiresStableIdentity(env = process.env) {
  return String(env.WORKHORSE_RELEASE_BUILD ?? "").trim() === "1";
}

function assertStableReleaseIdentity(env = process.env) {
  if (requiresStableIdentity(env) && shouldAdHocSign(env)) {
    throw new Error(
      "macOS release builds require CSC_LINK or CSC_NAME so Keychain approval survives app updates.",
    );
  }
  if (requiresStableIdentity(env) && !/^Developer ID Application:/.test(String(env.CSC_NAME ?? "").trim())) {
    throw new Error("macOS release builds require CSC_NAME to select a Developer ID Application identity.");
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  assertStableReleaseIdentity();
  if (!shouldAdHocSign()) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // Complete local packages so they launch and use secure storage. A
  // certificate-backed signing stage replaces this when CSC_* is set.
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
}

module.exports = afterPack;
module.exports.shouldAdHocSign = shouldAdHocSign;
module.exports.requiresStableIdentity = requiresStableIdentity;
module.exports.assertStableReleaseIdentity = assertStableReleaseIdentity;
module.exports.afterPack = afterPack;
