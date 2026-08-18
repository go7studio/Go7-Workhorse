const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BUILD_MARKER_FILE = "workhorse-build.json";

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
  // electron-builder picks the certificate type itself and rejects a CSC_NAME
  // that carries one: "Please remove prefix ... from the specified name". This
  // gate used to demand that prefix, so a signed release could never be built.
  // What the identity really is now gets checked against the signature the
  // build produced, in after-sign.cjs — the outcome, not an env string.
  const certificateName = String(env.CSC_NAME ?? "").trim();
  const typePrefix = certificateName.match(
    /^(Developer ID Application|Developer ID Installer|Apple Distribution|Apple Development|Mac Developer|3rd Party Mac Developer [A-Za-z]+):/,
  );
  if (requiresStableIdentity(env) && typePrefix) {
    throw new Error(
      `Remove "${typePrefix[1]}:" from CSC_NAME. electron-builder chooses the certificate type and rejects a name that names one; leave the common name only, such as "Moonlight Capital LLC (TEAMID1234)".`,
    );
  }
  const hasAppleIdCredentials = [env.APPLE_ID, env.APPLE_APP_SPECIFIC_PASSWORD, env.APPLE_TEAM_ID]
    .every((value) => String(value ?? "").trim());
  const hasApiCredentials = [env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER]
    .every((value) => String(value ?? "").trim());
  if (requiresStableIdentity(env) && !hasAppleIdCredentials && !hasApiCredentials) {
    throw new Error("macOS release builds require Apple notarization credentials.");
  }
}

function writeBuildMarker(appPath, env = process.env) {
  const marker = {
    channel: requiresStableIdentity(env) ? "release" : "development",
  };
  const markerPath = path.join(appPath, "Contents", "Resources", BUILD_MARKER_FILE);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o644 });
  return marker;
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  assertStableReleaseIdentity();

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  writeBuildMarker(appPath);
  if (!shouldAdHocSign()) return;

  // Complete local packages so they launch under the hardened runtime. They
  // are marked development above and therefore never open production Safe
  // Storage; a certificate-backed signing stage replaces this for releases.
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
}

module.exports = afterPack;
module.exports.shouldAdHocSign = shouldAdHocSign;
module.exports.requiresStableIdentity = requiresStableIdentity;
module.exports.assertStableReleaseIdentity = assertStableReleaseIdentity;
module.exports.BUILD_MARKER_FILE = BUILD_MARKER_FILE;
module.exports.writeBuildMarker = writeBuildMarker;
module.exports.afterPack = afterPack;
