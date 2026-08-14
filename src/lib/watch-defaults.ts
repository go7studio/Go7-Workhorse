import type { WatchSettings } from "./types";

/** A seventh of the weekly leftover. 100 / 7 ≈ 14.2857. */
export const DAY_SHARE_PERCENT = 100 / 7;

export const DEFAULT_WATCH: WatchSettings = {
  dailyLimitPercent: DAY_SHARE_PERCENT,
  lockDaily: false,
  desktopNotify: true,
};
