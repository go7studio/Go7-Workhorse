#!/bin/bash
set -euo pipefail
ROOT="/Users/venomspike/workspace/Go7-Workhorse-github"
REPORT="$ROOT/mac-verify-report.txt"
exec > >(tee "$REPORT") 2>&1
echo "HOST=$(uname -s) HOME=$HOME PWD=$(pwd)"
cd "$ROOT"
echo "===== npm test ====="
npm test
echo "===== dist:mac ====="
npm run dist:mac
echo "===== artifacts ====="
find release -maxdepth 4 \( -name "*.app" -o -name "*.dmg" -o -name "*.zip" \) -print
APP=$(find release -name "Workhorse.app" -type d | head -1)
echo "APP=$APP"
if [[ -z "${APP:-}" ]]; then
  echo "NO_APP"
  exit 2
fi
echo "===== leftover AppData before cleanup ====="
ls -la "$HOME/AppData" 2>/dev/null || echo "no ~/AppData"
ls -laR "$HOME/AppData" 2>/dev/null || true
# only remove the leftover we created
if [[ -d "$HOME/AppData/Local/Go7 Workhorse" ]]; then
  rm -rf "$HOME/AppData/Local/Go7 Workhorse"
  echo "removed ~/AppData/Local/Go7 Workhorse"
fi
if [[ -d "$HOME/AppData" ]]; then
  # remove empty parents only
  rmdir "$HOME/AppData/Local" 2>/dev/null || true
  rmdir "$HOME/AppData" 2>/dev/null || true
fi
echo "===== AppData after ====="
ls -la "$HOME/AppData" 2>/dev/null || echo "no ~/AppData (cleaned)"
echo "===== launch ====="
open "$APP"
sleep 4
osascript -e 'tell application "System Events" to get name of every process whose background only is false' || true
BOUNDS=$(osascript -e 'tell application "System Events" to tell process "Workhorse" to get {position, size} of window 1' || true)
echo "BOUNDS=$BOUNDS"
# Quartz / CGWindow
python3 - <<'PY2'
import subprocess, json
try:
    out = subprocess.check_output(["python3", "-c", ""], text=True)
except Exception:
    pass
PY2
# try quartz via swift/python
/usr/bin/osascript <<'OSA' || true
tell application "System Events"
  if exists process "Workhorse" then
    set procs to name of every process whose name is "Workhorse"
    log procs
    try
      set w to window 1 of process "Workhorse"
      set p to position of w
      set s to size of w
      return "window pos=" & (item 1 of p as text) & "," & (item 2 of p as text) & " size=" & (item 1 of s as text) & "x" & (item 2 of s as text)
    on error err
      return "no window: " & err
    end try
  else
    return "Workhorse process not found"
  end if
end tell
OSA
sleep 2
osascript -e 'tell application "Workhorse" to quit' || killall Workhorse || true
sleep 1
echo "===== done ====="
echo "APP=$APP"
ls -la release | head
