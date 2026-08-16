const { execFileSync } = require("node:child_process");
const path = require("node:path");

/** Ad-hoc only when no release identity will stamp the same Team ID again. */
function shouldAdHocSign(env = process.env) {
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return true;
  if (String(env.CSC_LINK ?? "").trim() || String(env.CSC_NAME ?? "").trim()) return false;
  return true;
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
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
module.exports.afterPack = afterPack;
