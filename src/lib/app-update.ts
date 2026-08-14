export const UPDATE_REPO = {
  owner: "Spikey222",
  repo: "Go7-Workhorse",
} as const;

export type AppUpdateOffer = {
  version: string;
  name?: string;
  notes?: string;
  url: string;
};

export function versionFromRef(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

export function parseVersion(raw: string): [number, number, number] | null {
  const match = versionFromRef(raw).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

export function releaseTag(version: string): string {
  return `v${versionFromRef(version)}`;
}

export function releaseUrl(version: string): string {
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tag/${releaseTag(version)}`;
}

export type AppUpdateApplyResult = { ok: true } | { ok: false; message: string };

export function offerFromRelease(raw: unknown, current: string): AppUpdateOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (record.draft === true || record.prerelease === true) return null;
  const version = typeof record.tag_name === "string" ? versionFromRef(record.tag_name) : "";
  if (!version || !isNewerVersion(version, current)) return null;
  const url = typeof record.html_url === "string" && record.html_url.startsWith("https://") ? record.html_url : releaseUrl(version);
  const notes = typeof record.body === "string" ? record.body.trim() : "";
  return {
    version,
    name: typeof record.name === "string" ? record.name : undefined,
    notes: notes ? notes.slice(0, 400) : undefined,
    url,
  };
}

export function offerFromTag(raw: unknown, current: string): AppUpdateOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { name?: unknown };
  const version = typeof record.name === "string" ? versionFromRef(record.name) : "";
  if (!version || !isNewerVersion(version, current)) return null;
  return { version, url: releaseUrl(version) };
}

export function pickLatestTagOffer(tags: unknown, current: string): AppUpdateOffer | null {
  if (!Array.isArray(tags)) return null;
  let best: AppUpdateOffer | null = null;
  for (const tag of tags) {
    const offer = offerFromTag(tag, current);
    if (!offer) continue;
    if (!best || compareVersions(offer.version, best.version) > 0) best = offer;
  }
  return best;
}
