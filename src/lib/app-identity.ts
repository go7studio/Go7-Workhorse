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
