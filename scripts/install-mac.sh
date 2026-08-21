#!/bin/bash
# Install the latest Go7 Workhorse release on macOS. This is ship only.
#
#   curl -fsSL https://raw.githubusercontent.com/go7studio/Go7-Workhorse/main/scripts/install-mac.sh | bash
#
# Downloads the dmg from GitHub Releases, mounts it, copies the app to
# /Applications/Go7 Workhorse.app, and unmounts. It never writes the Dev app.
# To judge this tree in a live window, use `npm run try` (see AGENTS.md).
# Nothing is installed system-wide and no password is needed.
set -euo pipefail

REPO="go7studio/Go7-Workhorse"
APP="Go7 Workhorse.app"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Keep in sync with macRefreshRegistrationScript in src/lib/app-update.ts.
refresh_mac_app_icon() {
  local dest="$1"
  # WORKHORSE_MAC_DOCK_REFRESH
  # Replacing the .app changes its inode. Dock keeps a bookmark to the old one
  # and shows a blank tile. Re-register the live bundle and drop that bookmark.
  local LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [ -x "$LSREGISTER" ] && [ -d "$dest" ]; then
    "$LSREGISTER" -f "$dest" >/dev/null 2>&1 || true
    for stale in /private/tmp/go7-workhorse-install.*/*backup.app /tmp/go7-workhorse-install.*/*backup.app; do
      [ -e "$stale" ] || continue
      "$LSREGISTER" -u "$stale" >/dev/null 2>&1 || true
    done
  fi
  /usr/bin/touch "$dest" 2>/dev/null || true
  if [ -x /usr/bin/python3 ] && [ -d "$dest" ]; then
    /usr/bin/python3 - "$dest" <<'PY'
import plistlib, subprocess, sys, time
from pathlib import Path
dest = Path(sys.argv[1]).resolve()
plist_path = Path.home() / "Library/Preferences/com.apple.dock.plist"
if not dest.is_dir() or not plist_path.is_file():
    raise SystemExit(0)
try:
    info = plistlib.loads((dest / "Contents/Info.plist").read_bytes())
except Exception:
    info = {}
bundle_id = info.get("CFBundleIdentifier") or "com.go7studio.workhorse"
label = info.get("CFBundleDisplayName") or info.get("CFBundleName") or dest.stem
url = dest.as_uri()
if not url.endswith("/"):
    url += "/"
data = plistlib.loads(plist_path.read_bytes())
changed = False
for item in data.get("persistent-apps") or []:
    tile = item.get("tile-data")
    if not isinstance(tile, dict):
        continue
    file_url = str((tile.get("file-data") or {}).get("_CFURLString") or "")
    bid = str(tile.get("bundle-identifier") or "")
    if bid != bundle_id and file_url.rstrip("/") != url.rstrip("/"):
        continue
    tile.pop("book", None)
    tile["file-data"] = {"_CFURLString": url, "_CFURLStringType": 15}
    tile["bundle-identifier"] = bundle_id
    tile["file-label"] = label
    item["tile-data"] = tile
    changed = True
if not changed:
    raise SystemExit(0)
subprocess.run(["killall", "-STOP", "Dock"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.2)
plist_path.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))
subprocess.run(["killall", "-9", "Dock"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PY
  fi
}

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows, run the .exe from the releases page."

# Apple silicon takes the arm64 dmg, Intel the x64 one. Running the arm64
# build on an Intel Mac does not start at all, so guessing is not an option.
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) die "Unknown Mac architecture $(uname -m). Download a dmg by hand from https://github.com/${REPO}/releases" ;;
esac

say "Finding the latest release for ${arch}..."
urls=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*-mac[^"]*\.dmg"' | cut -d'"' -f4)
asset=$(printf '%s\n' "$urls" | grep -- "-mac-${arch}\.dmg$" | head -1)
# Releases up to 0.1.9 shipped one unlabelled dmg, and it was arm64 only.
if [ -z "$asset" ] && [ "$arch" = "arm64" ]; then
  asset=$(printf '%s\n' "$urls" | grep -- '-mac\.dmg$' | head -1)
fi
if [ -z "$asset" ]; then
  die "No ${arch} macOS dmg on the latest release. Check https://github.com/${REPO}/releases"
fi

version=$(printf '%s' "$asset" | sed -E 's/.*-([0-9]+\.[0-9]+\.[0-9]+)-mac.*\.dmg/\1/')
say "Downloading Go7 Workhorse ${version}..."

tmp=$(mktemp -d)
device=""
cleanup() {
  # Detach by device and confirm it, because the image is mounted inside $tmp.
  # Removing $tmp while it is still mounted walks the read-only image and
  # prints a screenful of "Read-only file system" instead of tidying up.
  if [ -n "$device" ]; then
    hdiutil detach "$device" -quiet 2>/dev/null ||
      hdiutil detach "$device" -force -quiet 2>/dev/null || true
  fi
  rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup EXIT

dmg="${tmp}/workhorse.dmg"
curl -fsSL --progress-bar "$asset" -o "$dmg" || die "Download failed."

say "Mounting..."
# Not -quiet: it silences the very table the mount point is read from, which
# left this script certain that every disk image was empty.
attached=$(hdiutil attach "$dmg" -nobrowse -readonly -mountrandom "$tmp") ||
  die "Could not mount the disk image."
device=$(printf '%s\n' "$attached" | awk '/^\/dev\// {print $1}' | head -1)
mount=$(printf '%s\n' "$attached" | grep -o "${tmp}/[^[:space:]]*" | tail -1)
[ -n "$mount" ] && [ -d "${mount}/${APP}" ] || die "The disk image did not contain ${APP}."

# Replacing a running app leaves a broken bundle, so stop it first.
# The pre-rename bundle was Workhorse.app; quit that too.
if pgrep -f "/Applications/${APP}/Contents/MacOS/|/Applications/Workhorse.app/Contents/MacOS/" >/dev/null 2>&1; then
  say "Quitting the running copy..."
  osascript -e 'tell application "Go7 Workhorse" to quit' 2>/dev/null || true
  osascript -e 'tell application "Workhorse" to quit' 2>/dev/null || true
  sleep 2
fi

say "Installing to /Applications..."
rm -rf "/Applications/${APP}"
cp -R "${mount}/${APP}" /Applications/
# One live app. The old short name must not stay beside the current one.
if [ -d /Applications/Workhorse.app ]; then
  say "Removing the pre-rename Workhorse.app..."
  rm -rf /Applications/Workhorse.app
fi

# Keep Gatekeeper intact for signed releases. Legacy development artifacts need
# their bundle-scoped quarantine flag removed to launch.
if xattr -p com.apple.quarantine "/Applications/${APP}" >/dev/null 2>&1; then
  signature=$(codesign -dvv "/Applications/${APP}" 2>&1 || true)
  if printf '%s' "$signature" | grep -q 'Authority=Developer ID Application:'; then
    say "Verifying the signed app with Gatekeeper..."
  else
    say "Clearing quarantine for this legacy development build..."
    xattr -dr com.apple.quarantine "/Applications/${APP}"
  fi
fi

refresh_mac_app_icon "/Applications/${APP}"

say ""
say "Go7 Workhorse ${version} is in /Applications."
say "Open it from Launchpad, or run: open -a \"Go7 Workhorse\""
