import path from "node:path";

export const WORKHORSE_APP_ID = "com.go7studio.workhorse";
export const WORKHORSE_DEV_APP_ID = "com.go7studio.workhorse.dev";
export const WORKHORSE_APP_NAME = "Go7 Workhorse";
export const WORKHORSE_DEV_APP_NAME = "Go7 Workhorse Dev";
export const WORKHORSE_USER_DATA_DIR = "Go7 Workhorse";
export const WORKHORSE_DEV_USER_DATA_DIR = "Go7 Workhorse Dev";
export const WORKHORSE_BUILD_MARKER = "workhorse-build.json";

export type WorkhorseBuildChannel = "release" | "development";

export function parseWorkhorseBuildChannel(value: string | undefined): WorkhorseBuildChannel {
  if (!value) return "release";
  try {
    return JSON.parse(value)?.channel === "development" ? "development" : "release";
  } catch {
    return "release";
  }
}

/** A development marker is authoritative only inside the development install. */
export function installedWorkhorseBuildChannel(
  markerChannel: WorkhorseBuildChannel,
  execPath: string,
  platform: NodeJS.Platform = process.platform,
): WorkhorseBuildChannel {
  if (markerChannel !== "development") return "release";
  if (platform === "win32") {
    return path.win32.basename(path.win32.dirname(execPath)) === WORKHORSE_DEV_APP_NAME ? "development" : "release";
  }
  if (platform === "darwin") {
    return execPath.split(/[\\/]/).includes(`${WORKHORSE_DEV_APP_NAME}.app`) ? "development" : "release";
  }
  return markerChannel;
}

export function workhorseRuntimeIdentity(
  isPackaged: boolean,
  packagedChannel: WorkhorseBuildChannel = "release",
) {
  const development = !isPackaged || packagedChannel === "development";
  return development
    ? {
        name: WORKHORSE_DEV_APP_NAME,
        userDataDirectory: WORKHORSE_DEV_USER_DATA_DIR,
        volatileCredentials: true,
      }
    : {
        name: WORKHORSE_APP_NAME,
        userDataDirectory: WORKHORSE_USER_DATA_DIR,
        volatileCredentials: false,
      };
}

/**
 * Whether this desk may rewrite the machine-wide Grok Bot keepalive. The launch
 * agent is keyed by home and one fixed label, so only the installed release
 * desk owns it. A desk on an isolated profile is a test, and a development
 * desk (`npm run dev`, or the Dev app `npm run try` installs) is a second desk
 * on this machine: either one pointed the agent at its own binary and profile,
 * and the installed desk's Grok Bot calls failed until it started again.
 */
export function ownsShimKeepalive(
  identity: { userDataDirectory: string },
  isolatedProfile: string | undefined,
): boolean {
  return !isolatedProfile && identity.userDataDirectory !== WORKHORSE_DEV_USER_DATA_DIR;
}

export type WorkhorseInstallTarget = {
  channel: WorkhorseBuildChannel;
  appName: string;
  dest: string;
  userDataDirectory: string;
  productionApp: string;
};

export function appBundleName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? `${name}.app` : name;
}

/** Install dest for a packaged desk. Callers inject the Applications folder. */
export function productionAppPath(applicationsDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(applicationsDir, appBundleName(WORKHORSE_APP_NAME, platform));
}

export function workhorseInstallTarget(input: {
  channel: WorkhorseBuildChannel;
  applicationsDir: string;
  platform?: NodeJS.Platform;
}): WorkhorseInstallTarget {
  const platform = input.platform ?? process.platform;
  const identity = workhorseRuntimeIdentity(true, input.channel);
  const appName = appBundleName(identity.name, platform);
  return {
    channel: input.channel,
    appName,
    dest: path.join(input.applicationsDir, appName),
    userDataDirectory: identity.userDataDirectory,
    productionApp: productionAppPath(input.applicationsDir, platform),
  };
}

export function tryInstallWouldReplaceProduction(
  dest: string,
  applicationsDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return path.normalize(dest) === path.normalize(productionAppPath(applicationsDir, platform));
}
