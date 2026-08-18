export const WORKHORSE_APP_ID = "com.go7studio.workhorse";
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
        volatileCredentials: isPackaged,
      }
    : {
        name: WORKHORSE_APP_NAME,
        userDataDirectory: WORKHORSE_USER_DATA_DIR,
        volatileCredentials: false,
      };
}
