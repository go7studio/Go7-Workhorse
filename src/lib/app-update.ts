export const UPDATE_REPO = {
  owner: "go7studio",
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

export type AppUpdateCheckResult = {
  offer: AppUpdateOffer | null;
  error?: string;
};

export const MAC_APP_NAME = "Go7 Workhorse.app";

export function macInstallerArch(raw: string): "arm64" | "x64" | null {
  if (raw === "arm64") return "arm64";
  if (raw === "x64" || raw === "x86_64") return "x64";
  return null;
}

export type MacDmgAsset = { url: string; name: string };

export function pickMacDmgAsset(release: unknown, arch: "arm64" | "x64"): MacDmgAsset | null {
  if (!release || typeof release !== "object") return null;
  const assets = (release as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return null;
  const named: MacDmgAsset[] = [];
  for (const item of assets) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; browser_download_url?: unknown };
    if (typeof record.name !== "string" || typeof record.browser_download_url !== "string") continue;
    if (!record.browser_download_url.startsWith("https://")) continue;
    named.push({ name: record.name, url: record.browser_download_url });
  }
  const exact = named.find((asset) => asset.name.endsWith(`-mac-${arch}.dmg`));
  if (exact) return exact;
  // Releases up to 0.1.9 shipped one unlabelled dmg, and it was arm64 only.
  if (arch === "arm64") {
    const legacy = named.find((asset) => /-mac\.dmg$/.test(asset.name) && !/-mac-(arm64|x64)\.dmg$/.test(asset.name));
    if (legacy) return legacy;
  }
  return null;
}

export function macBundleFromExecPath(execPath: string): string | null {
  const normalized = execPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  for (let i = parts.length; i > 0; i -= 1) {
    const candidate = parts.slice(0, i).join("/");
    if (candidate.endsWith(".app")) return candidate;
  }
  return null;
}

export function parseHdiutilAttach(output: string, tmpDir: string): { device: string; mount: string } | null {
  const device = output
    .split(/\r?\n/)
    .map((line) => line.match(/^(\/dev\/\S+)/)?.[1])
    .find(Boolean);
  if (!device) return null;
  const prefix = tmpDir.replace(/\\/g, "/");
  const mount = output
    .replace(/\\/g, "/")
    .split(/\s+/)
    .find((token) => token.startsWith(`${prefix}/`));
  if (!mount) return null;
  return { device, mount };
}

export type UpdateInstallKind = "mac-dmg" | "git-checkout" | "none";

export function updateInstallKind(input: {
  platform: string;
  packaged: boolean;
  hasGitCheckout: boolean;
}): UpdateInstallKind {
  if (input.platform === "darwin" && input.packaged) return "mac-dmg";
  if (input.hasGitCheckout) return "git-checkout";
  return "none";
}

export function packagedUpdateMissingMessage(platform: string): string {
  if (platform === "win32") {
    return "This Windows installer cannot replace itself. Download the new installer from the release page.";
  }
  return "This Workhorse build cannot install in place.";
}

export function macReplaceScript(input: {
  pid: number;
  srcApp: string;
  destApp: string;
  device: string;
  tmp: string;
}): string {
  const quote = (value: string) => JSON.stringify(value);
  return `#!/bin/bash
set -euo pipefail
pid=${input.pid}
src=${quote(input.srcApp)}
dest=${quote(input.destApp)}
device=${quote(input.device)}
tmp=${quote(input.tmp)}
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
sleep 0.4
rm -rf "$dest"
cp -R "$src" "$dest"
if [ -n "$device" ]; then
  hdiutil detach "$device" -quiet 2>/dev/null || hdiutil detach "$device" -force -quiet 2>/dev/null || true
fi
rm -rf "$tmp" 2>/dev/null || true
open "$dest"
`;
}

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
