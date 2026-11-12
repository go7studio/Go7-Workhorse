const { signDictationAndReseal } = require("./after-sign.cjs");

/**
 * electron-builder calls this instead of its own sign, then notarizes.
 * The dictation helper is a loose binary, so the app sign does not give it
 * the microphone entitlement. Sign it, reseal the app without --deep, and
 * return. Notarization then staples that seal.
 *
 * The second argument is the packager when electron-builder calls this.
 * Tests pass { signAsync, io } instead.
 */
async function signMacApp(configuration, deps) {
  const injected = deps && typeof deps.signAsync === "function" ? deps : null;
  const signAsync = injected?.signAsync ?? (await import("@electron/osx-sign")).signAsync;
  await signAsync(configuration);
  const appPath = configuration?.app;
  const authority = configuration?.identity;
  if (!appPath || !authority) return false;
  return signDictationAndReseal(appPath, authority, {
    keychain: configuration.keychain,
    ...(injected?.io ?? {}),
  });
}

module.exports = signMacApp;
module.exports.sign = signMacApp;
