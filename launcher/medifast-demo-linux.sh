#!/bin/bash
# Run from a file manager ("Run as program") or a terminal.
cd "$(dirname "$0")/.." || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  xdg-open "https://nodejs.org/en/download" >/dev/null 2>&1
  read -r -p "Press Enter to close." _
  exit 1
fi
exec node launcher/launch.mjs "$@"
