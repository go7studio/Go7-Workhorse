#!/bin/bash
# Install the latest Go7 Workhorse release on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/go7studio/Go7-Workhorse/main/scripts/install-mac.sh | bash
#
# Downloads the dmg from GitHub Releases, mounts it, copies the app to
# /Applications, and unmounts. Nothing is installed system-wide and no
# password is needed.
set -euo pipefail

REPO="go7studio/Go7-Workhorse"
APP="Go7 Workhorse.app"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows, run the .exe from the releases page."

say "Finding the latest release..."
urls=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*-mac\.dmg"' | cut -d'"' -f4)
# Older releases also carry a pre-rename dmg, so pick the current name first.
asset=$(printf '%s\n' "$urls" | grep 'Go7-Workhorse-' | head -1)
[ -n "$asset" ] || asset=$(printf '%s\n' "$urls" | head -1)
[ -n "$asset" ] || die "No macOS dmg on the latest release. Check https://github.com/${REPO}/releases"

version=$(printf '%s' "$asset" | sed -E 's/.*-([0-9]+\.[0-9]+\.[0-9]+)-mac\.dmg/\1/')
say "Downloading Go7 Workhorse ${version}..."

tmp=$(mktemp -d)
mount=""
cleanup() {
  [ -n "$mount" ] && hdiutil detach "$mount" -quiet 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

dmg="${tmp}/workhorse.dmg"
curl -fsSL --progress-bar "$asset" -o "$dmg" || die "Download failed."

say "Mounting..."
mount=$(hdiutil attach "$dmg" -nobrowse -quiet -mountrandom "$tmp" | grep -o '/.*' | tail -1)
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

say ""
say "Go7 Workhorse ${version} is in /Applications."
say "Open it from Launchpad, or run: open -a \"Go7 Workhorse\""
