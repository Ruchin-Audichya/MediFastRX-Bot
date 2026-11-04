#!/bin/bash
# Double-click in Finder. First time: right-click → Open (macOS asks once for files from the internet).
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo; echo "  Node.js is not installed. Opening the download page..."
  echo "  Install the LTS version, then double-click this file again."; echo
  open "https://nodejs.org/en/download"
  read -r -p "  Press Enter to close." _
  exit 1
fi
exec node launcher/launch.mjs "$@"
