export const WORKHORSE_APP_ID = "com.go7studio.workhorse";
export const WORKHORSE_APP_NAME = "Go7 Workhorse";
export const WORKHORSE_DEV_APP_NAME = "Go7 Workhorse Dev";
export const WORKHORSE_USER_DATA_DIR = "Go7 Workhorse";
export const WORKHORSE_DEV_USER_DATA_DIR = "Go7 Workhorse Dev";

export function workhorseRuntimeIdentity(isPackaged: boolean) {
  return isPackaged
    ? { name: WORKHORSE_APP_NAME, userDataDirectory: WORKHORSE_USER_DATA_DIR }
    : { name: WORKHORSE_DEV_APP_NAME, userDataDirectory: WORKHORSE_DEV_USER_DATA_DIR };
}
